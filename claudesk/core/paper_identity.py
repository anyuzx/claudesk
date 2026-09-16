from __future__ import annotations

import html
import re


def normalize_paper_title_key(title: str) -> str:
    """Return the stable title identity key used for exact duplicate matching."""
    title = html.unescape(title)
    title = re.sub(r"<[^>]+>", " ", title)
    title = title.lower()
    title = re.sub(r"[^\w\s]", "", title)
    return re.sub(r"\s+", " ", title).strip()


def paper_source_priority(source: str) -> int:
    """Rank sources for canonical duplicate selection; published records win."""
    return {
        "pubmed": 0,
        "openalex": 1,
        "arxiv": 2,
        "biorxiv": 3,
        "medrxiv": 3,
        "chemrxiv": 3,
    }.get(source, 4)
