from __future__ import annotations

import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime
from typing import Optional

import httpx

from claudesk.core.config import load_config
from claudesk.core.models import Paper
from claudesk.sources.base import SourceProgressCallback

ARXIV_API = "https://export.arxiv.org/api/query"
_ATOM = "http://www.w3.org/2005/Atom"

# arXiv asks for at least 3 seconds between requests (Terms of Use).
REQUEST_DELAY = 3.0


def fetch(
    since: datetime,
    *,
    categories: Optional[list[str]] = None,
    progress_cb: Optional[SourceProgressCallback] = None,
) -> list[Paper]:
    """Fetch arXiv papers in the configured categories submitted since `since`.

    `categories` overrides the config — useful for testing.
    """
    cfg = load_config()
    if not cfg.sources.arxiv.enabled and categories is None:
        return []

    cats = categories if categories is not None else cfg.sources.arxiv.categories
    if not cats:
        return []

    since_date = since.date()
    max_results = cfg.digest.max_per_source
    cat_query = " OR ".join(f"cat:{c}" for c in cats)

    papers: list[Paper] = []
    start = 0

    while True:
        batch = _fetch_batch(cat_query, start=start, max_results=min(200, max_results))
        if not batch:
            break

        for p in batch:
            if p.published_date >= since_date:
                papers.append(p)
        if progress_cb is not None:
            progress_cb(
                {
                    "event": "source_progress",
                    "count": min(len(papers), max_results),
                    "target": max_results,
                }
            )

        # Stop if the oldest paper in this batch predates `since`, or we have enough.
        if batch[-1].published_date < since_date or len(papers) >= max_results:
            break

        start += len(batch)
        if start >= max_results:
            break

        time.sleep(REQUEST_DELAY)

    return papers[:max_results]


def _fetch_batch(query: str, *, start: int, max_results: int) -> list[Paper]:
    params = {
        "search_query": query,
        "sortBy": "submittedDate",
        "sortOrder": "descending",
        "start": start,
        "max_results": max_results,
    }
    resp = httpx.get(ARXIV_API, params=params, timeout=30.0)
    resp.raise_for_status()
    return _parse_feed(resp.text)


def _parse_feed(xml_text: str) -> list[Paper]:
    root = ET.fromstring(xml_text)
    papers = []
    for entry in root.findall(f"{{{_ATOM}}}entry"):
        paper = _parse_entry(entry)
        if paper is not None:
            papers.append(paper)
    return papers


def _parse_entry(entry: ET.Element) -> Optional[Paper]:
    try:
        id_elem = entry.find(f"{{{_ATOM}}}id")
        if id_elem is None or not id_elem.text:
            return None
        arxiv_id = _extract_arxiv_id(id_elem.text)

        title_elem = entry.find(f"{{{_ATOM}}}title")
        title = _clean(title_elem.text) if title_elem is not None else ""

        summary_elem = entry.find(f"{{{_ATOM}}}summary")
        abstract = _clean(summary_elem.text) if summary_elem is not None else ""

        authors = [
            _clean(n.text)
            for a in entry.findall(f"{{{_ATOM}}}author")
            if (n := a.find(f"{{{_ATOM}}}name")) is not None and n.text
        ]

        published_elem = entry.find(f"{{{_ATOM}}}published")
        if published_elem is None or not published_elem.text:
            return None
        published_date = datetime.fromisoformat(
            published_elem.text.replace("Z", "+00:00")
        ).date()

        return Paper(
            source="arxiv",
            external_id=arxiv_id,
            title=title,
            abstract=abstract,
            authors=authors,
            published_date=published_date,
            url=f"https://arxiv.org/abs/{arxiv_id}",
        )
    except Exception:
        return None


def _extract_arxiv_id(url: str) -> str:
    """'https://arxiv.org/abs/2401.00001v2' -> '2401.00001'"""
    part = url.rsplit("/abs/", 1)[-1]
    return re.sub(r"v\d+$", "", part)


def _clean(text: Optional[str]) -> str:
    """Collapse whitespace and strip — arXiv abstracts often have embedded newlines."""
    if not text:
        return ""
    return re.sub(r"\s+", " ", text).strip()
