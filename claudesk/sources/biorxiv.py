from __future__ import annotations

import html
import logging
import re
import time
from datetime import date, datetime, timedelta
from typing import Optional

import httpx

from claudesk.core.config import load_config
from claudesk.core.models import Paper
from claudesk.sources.base import SourceProgressCallback

logger = logging.getLogger(__name__)

BIORXIV_API = "https://api.biorxiv.org/details"
BIORXIV_SERVER = "biorxiv"

# bioRxiv migrated DOI registration from Cold Spring Harbor Lab (10.1101)
# to openRxiv (10.64898) in late 2025. Crossref member 54368 = openRxiv.
CROSSREF_API = "https://api.crossref.org/members/54368/works"
CROSSREF_PAGE_SIZE = 100

API_REQUEST_DELAY = 0.25
CROSSREF_REQUEST_DELAY = 0.5
MAX_API_PAGES = 500

_HEADERS = {
    "User-Agent": "claudesk/0.1 (https://github.com/claudesk; mailto:stefanshi1988@gmail.com)",
    "Accept": "application/json,text/plain,*/*",
}


class BiorxivFetchError(RuntimeError):
    """Raised when a provider response is reachable but not usable."""


def fetch(
    since: datetime,
    *,
    categories: Optional[list[str]] = None,
    progress_cb: Optional[SourceProgressCallback] = None,
) -> list[Paper]:
    """Fetch bioRxiv preprints since ``since``.

    The default provider is the direct bioRxiv API. Crossref remains available
    as a configured provider and as the default fallback if the direct API
    becomes unavailable.
    """
    cfg = load_config()
    if not cfg.sources.biorxiv.enabled and categories is None:
        return []

    resolved_categories = categories if categories is not None else cfg.sources.biorxiv.categories
    source_categories = _normalise_categories(resolved_categories)
    since_date = since.date()
    today = date.today()
    max_results = cfg.digest.max_per_source

    provider = cfg.sources.biorxiv.provider
    fallback = cfg.sources.biorxiv.fallback_provider

    try:
        return _fetch_provider(
            provider,
            since_date=since_date,
            until_date=today,
            categories=source_categories,
            max_results=max_results,
            progress_cb=progress_cb,
        )
    except Exception as primary_exc:
        if fallback == "none" or fallback == provider:
            raise
        logger.warning(
            "bioRxiv %s fetch failed; trying %s fallback: %s",
            provider,
            fallback,
            primary_exc,
        )
        try:
            return _fetch_provider(
                fallback,
                since_date=since_date,
                until_date=today,
                categories=source_categories,
                max_results=max_results,
                progress_cb=progress_cb,
            )
        except Exception as fallback_exc:
            raise RuntimeError(
                f"bioRxiv {provider} provider failed ({primary_exc}); "
                f"fallback {fallback} failed ({fallback_exc})"
            ) from fallback_exc


def _fetch_provider(
    provider: str,
    *,
    since_date: date,
    until_date: date,
    categories: list[str],
    max_results: int,
    progress_cb: Optional[SourceProgressCallback] = None,
) -> list[Paper]:
    if provider == "api":
        return _fetch_api(
            since_date=since_date,
            until_date=until_date,
            categories=categories,
            max_results=max_results,
            progress_cb=progress_cb,
        )
    if provider == "crossref":
        return _fetch_crossref(
            since_date=since_date,
            until_date=until_date,
            categories=categories,
            max_results=max_results,
            progress_cb=progress_cb,
        )
    raise ValueError(f"Unknown bioRxiv provider: {provider!r}")


def _fetch_api(
    *,
    since_date: date,
    until_date: date,
    categories: list[str],
    max_results: int,
    progress_cb: Optional[SourceProgressCallback] = None,
) -> list[Paper]:
    if max_results <= 0:
        return []

    records_by_doi: dict[str, tuple[int, Paper]] = {}
    query_categories: list[str | None] = categories or [None]
    allowed_categories = {_category_key(c) for c in categories}

    current_date = until_date
    while current_date >= since_date and len(records_by_doi) < max_results:
        for category in query_categories:
            for version, paper in _iter_api_category(
                since_date=current_date,
                until_date=current_date,
                category=category,
                max_records=max_results,
            ):
                if (
                    allowed_categories
                    and category is not None
                    and _category_key(category) not in allowed_categories
                ):
                    continue
                before_count = len(records_by_doi)
                _merge_versioned_paper(records_by_doi, version=version, paper=paper)
                if progress_cb is not None and len(records_by_doi) != before_count:
                    progress_cb(
                        {
                            "event": "source_progress",
                            "count": len(records_by_doi),
                            "target": max_results,
                        }
                    )
                if len(records_by_doi) >= max_results:
                    break
            if len(records_by_doi) >= max_results:
                break
        if len(records_by_doi) >= max_results:
            break
        current_date -= timedelta(days=1)

    return [paper for _, paper in records_by_doi.values()][:max_results]


def _iter_api_category(
    *,
    since_date: date,
    until_date: date,
    category: str | None,
    max_records: int,
) -> list[tuple[int, Paper]]:
    cursor = 0
    pages = 0
    records: list[tuple[int, Paper]] = []
    finished = False

    while pages < MAX_API_PAGES:
        pages += 1
        url = (
            f"{BIORXIV_API}/{BIORXIV_SERVER}/"
            f"{since_date.isoformat()}/{until_date.isoformat()}/{cursor}"
        )
        params = {"category": _api_category_param(category)} if category else None
        response = httpx.get(url, params=params, headers=_HEADERS, timeout=30.0)
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, dict):
            raise BiorxivFetchError("bioRxiv API response was not a JSON object")

        collection = data.get("collection")
        if not isinstance(collection, list):
            raise BiorxivFetchError("bioRxiv API response missing collection list")
        if not collection:
            break

        for item in collection:
            if not isinstance(item, dict):
                continue
            if category and _category_key(str(item.get("category", ""))) != _category_key(category):
                continue
            parsed = _parse_api_item(item)
            if parsed is not None:
                records.append(parsed)
                if len(records) >= max_records:
                    finished = True
                    break

        if len(records) >= max_records:
            break

        msg = _message_stats(data)
        cursor += len(collection)
        total = _int_or_none(msg.get("total"))
        if total is not None and cursor >= total:
            finished = True
            break

        time.sleep(API_REQUEST_DELAY)

    if not finished and pages >= MAX_API_PAGES:
        raise BiorxivFetchError("bioRxiv API pagination exceeded safety limit")

    return records


def _parse_api_item(item: dict) -> Optional[tuple[int, Paper]]:
    try:
        doi = _normalise_doi(item.get("doi"))
        if not doi:
            return None

        title = _normalize_text(item.get("title") or "")
        if not title:
            return None

        published_date = date.fromisoformat(str(item.get("date", "")).strip())
        version = _int_or_none(item.get("version")) or 0
        version_suffix = f"v{version}" if version > 0 else ""

        paper = Paper(
            source="biorxiv",
            external_id=doi,
            title=title,
            abstract=_normalize_text(item.get("abstract") or ""),
            authors=_parse_semicolon_authors(item.get("authors")),
            published_date=published_date,
            journal_abbrev="bioRxiv",
            url=f"https://www.biorxiv.org/content/{doi}{version_suffix}",
        )
        return version, paper
    except Exception:
        return None


def _fetch_crossref(
    *,
    since_date: date,
    until_date: date,
    categories: list[str],
    max_results: int,
    progress_cb: Optional[SourceProgressCallback] = None,
) -> list[Paper]:
    cats_lower = {_category_key(c) for c in categories}
    all_papers: list[Paper] = []
    seen_dois: set[str] = set()
    offset = 0

    while len(all_papers) < max_results:
        params = {
            "filter": (
                f"from-posted-date:{since_date.isoformat()},"
                f"until-posted-date:{until_date.isoformat()}"
            ),
            # No select: group-title is present in full responses but is not a
            # valid Crossref select field.
            "rows": str(CROSSREF_PAGE_SIZE),
            "offset": str(offset),
        }

        resp = httpx.get(CROSSREF_API, params=params, headers=_HEADERS, timeout=30.0)
        resp.raise_for_status()
        msg = resp.json().get("message", {})

        items = msg.get("items", [])
        if not items:
            break

        for item in items:
            doi = _normalise_doi(item.get("DOI"))
            if not doi or doi in seen_dois:
                continue

            group = item.get("group-title", "")
            if cats_lower and _category_key(group) not in cats_lower:
                continue

            paper = _parse_crossref_item(item)
            if paper is not None:
                all_papers.append(paper)
                seen_dois.add(doi)
                if progress_cb is not None:
                    progress_cb(
                        {
                            "event": "source_progress",
                            "count": len(all_papers),
                            "target": max_results,
                        }
                    )

        total = _int_or_none(msg.get("total-results"))
        offset += CROSSREF_PAGE_SIZE
        if total is not None and offset >= total:
            break

        time.sleep(CROSSREF_REQUEST_DELAY)

    return all_papers[:max_results]


def _parse_crossref_item(item: dict) -> Optional[Paper]:
    try:
        doi = _normalise_doi(item.get("DOI"))
        if not doi:
            return None

        titles = item.get("title") or []
        title = _normalize_text(titles[0]) if titles else ""
        if not title:
            return None

        authors_raw = item.get("author") or []
        authors = [
            f"{a.get('given', '')} {a.get('family', '')}".strip()
            for a in authors_raw
            if a.get("family")
        ]

        posted = item.get("posted", {}).get("date-parts", [[]])[0]
        if len(posted) < 3:
            return None

        return Paper(
            source="biorxiv",
            external_id=doi,
            title=title,
            abstract=_normalize_text(item.get("abstract") or ""),
            authors=authors,
            published_date=date(posted[0], posted[1], posted[2]),
            journal_abbrev="bioRxiv",
            url=f"https://www.biorxiv.org/content/{doi}",
        )
    except Exception:
        return None


def _normalise_categories(categories: Optional[list[str]]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in categories or []:
        category = raw.strip()
        if not category:
            continue
        key = _category_key(category)
        if key == "all" or key in seen:
            continue
        seen.add(key)
        out.append(category)
    return out


def _category_key(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("_", " ").strip().lower())


def _api_category_param(value: str) -> str:
    return _category_key(value).replace(" ", "_")


def _message_stats(data: dict) -> dict:
    messages = data.get("messages") or []
    if isinstance(messages, list) and messages and isinstance(messages[0], dict):
        return messages[0]
    return {}


def _int_or_none(value: object) -> Optional[int]:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _normalise_doi(value: object) -> str:
    return str(value or "").strip().lower()


def _parse_semicolon_authors(value: object) -> list[str]:
    if not isinstance(value, str):
        return []
    return [author.strip() for author in value.split(";") if author.strip()]


def _merge_versioned_paper(
    records_by_doi: dict[str, tuple[int, Paper]],
    *,
    version: int,
    paper: Paper,
) -> None:
    existing = records_by_doi.get(paper.external_id)
    if existing is None or version > existing[0]:
        records_by_doi[paper.external_id] = (version, paper)


def _normalize_text(text: str) -> str:
    """Strip inline markup and decode HTML entities from source metadata."""
    cleaned = re.sub(r"<[^>]+>", " ", text)
    cleaned = html.unescape(cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    cleaned = re.sub(r"\s+([,.;:!?])", r"\1", cleaned)
    cleaned = re.sub(r"\s*([-–/])\s*", r"\1", cleaned)
    return cleaned
