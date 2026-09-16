from __future__ import annotations

import logging

from claudesk.core.doi import doi_identity_key
from claudesk.core.models import Paper
from claudesk.core.paper_identity import normalize_paper_title_key, paper_source_priority

logger = logging.getLogger(__name__)


def dedupe(papers: list[Paper]) -> list[Paper]:
    """Remove cross-source duplicates.

    Two passes in order of reliability:
    1. DOI match — catches the same published paper from multiple sources.
    2. Normalised-title match — catches preprint vs published with the same
       title, or the same paper indexed in two sources under different IDs.

    Published-source records are preferred over preprints when a duplicate is
    found; otherwise source priority and input order determine the kept copy.
    """
    result: list[Paper] = []
    dropped = 0

    for paper in papers:
        doi_key = _normalise_doi_key(paper.external_id)
        title_key = normalize_paper_title_key(paper.title)
        duplicate_index = _find_duplicate_index(result, doi_key, title_key)
        if duplicate_index is not None:
            existing = result[duplicate_index]
            if paper_source_priority(paper.source) < paper_source_priority(existing.source):
                result[duplicate_index] = paper
            dropped += 1
            continue

        result.append(paper)

    if dropped:
        logger.info("dedupe: dropped %d duplicate(s), %d remain", dropped, len(result))

    return result


def _is_doi(external_id: str) -> bool:
    """DOIs always start with '10.' followed by a registrant code."""
    return _normalise_doi_key(external_id) is not None


def _normalise_doi_key(external_id: str) -> str | None:
    return doi_identity_key(external_id)


def _find_duplicate_index(
    papers: list[Paper],
    doi_key: str | None,
    title_key: str,
) -> int | None:
    for index, paper in enumerate(papers):
        existing_doi_key = _normalise_doi_key(paper.external_id)
        if doi_key is not None and existing_doi_key == doi_key:
            return index
        if title_key and normalize_paper_title_key(paper.title) == title_key:
            return index
    return None


def _normalise_title(title: str) -> str:
    return normalize_paper_title_key(title)
