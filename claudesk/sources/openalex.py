from __future__ import annotations

import math
import re
from datetime import date, datetime
from typing import Optional
from urllib.parse import quote

import httpx

from claudesk.core.config import load_config
from claudesk.core.doi import normalize_doi
from claudesk.core.models import Paper
from claudesk.sources.base import SourceProgressCallback

AUTHORS_API = "https://api.openalex.org/authors"
WORKS_API = "https://api.openalex.org/works"
SOURCES_API = "https://api.openalex.org/sources"
AUTHOR_LOOKUP_LIMIT = 5
WORK_TYPES = "article|preprint"
_HEADERS = {
    "User-Agent": "claudesk/0.1 (https://github.com/claudesk; mailto:stefanshi1988@gmail.com)"
}


def fetch(
    since: datetime,
    *,
    keywords: Optional[list[str]] = None,
    tracked_authors: Optional[list[str]] = None,
    api_key: Optional[str] = None,
    progress_cb: Optional[SourceProgressCallback] = None,
) -> list[Paper]:
    """Fetch recent works from OpenAlex using keyword queries and tracked authors."""
    cfg = load_config()
    if (
        not cfg.sources.openalex.enabled
        and keywords is None
        and tracked_authors is None
        and api_key is None
    ):
        return []

    terms = keywords if keywords is not None else cfg.keywords.include
    author_names = tracked_authors if tracked_authors is not None else cfg.tracked_authors
    key = api_key if api_key is not None else cfg.sources.openalex.api_key

    if not key:
        raise ValueError(
            "OpenAlex not configured — set the OPENALEX_API_KEY environment variable."
        )
    if not terms and not author_names:
        return []

    since_date = since.date()
    max_results = cfg.digest.max_per_source
    per_page = min(100, max_results)
    max_pages = max(1, math.ceil(max_results / per_page))
    papers_by_id: dict[str, Paper] = {}
    source_titles_by_id: dict[str, Optional[str]] = {}

    author_ids = _lookup_tracked_author_ids(author_names, api_key=key)
    if author_ids:
        for page in range(1, max_pages + 1):
            batch = _fetch_recent_author_works(
                author_ids,
                since_date=since_date,
                api_key=key,
                page=page,
                per_page=per_page,
            )
            if not batch:
                break
            _merge_work_batch(
                batch,
                papers_by_id,
                source_titles_by_id=source_titles_by_id,
                api_key=key,
            )
            if progress_cb is not None:
                progress_cb(
                    {
                        "event": "source_progress",
                        "count": len(papers_by_id),
                        "target": max_results,
                    }
                )
            if len(papers_by_id) >= max_results or len(batch) < per_page:
                break

    for term in terms:
        if len(papers_by_id) >= max_results:
            break
        normalized_term = term.strip()
        if not normalized_term:
            continue
        for page in range(1, max_pages + 1):
            batch = _search_recent_works(
                normalized_term,
                since_date=since_date,
                api_key=key,
                page=page,
                per_page=per_page,
            )
            if not batch:
                break
            _merge_work_batch(
                batch,
                papers_by_id,
                source_titles_by_id=source_titles_by_id,
                api_key=key,
            )
            if progress_cb is not None:
                progress_cb(
                    {
                        "event": "source_progress",
                        "count": len(papers_by_id),
                        "target": max_results,
                    }
                )
            if len(papers_by_id) >= max_results or len(batch) < per_page:
                break

    papers = list(papers_by_id.values())
    papers.sort(key=lambda paper: paper.published_date, reverse=True)
    return papers[:max_results]


def fetch_work_by_doi(doi_input: str) -> Paper | None:
    """Fetch a single OpenAlex work by DOI without requiring digest source config."""
    doi = normalize_doi(doi_input)
    response = httpx.get(
        f"{WORKS_API}/doi:{quote(doi, safe='')}",
        headers=_HEADERS,
        timeout=30.0,
    )
    if response.status_code == 404:
        return None
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        return None

    parsed = _parse_work(payload, source_titles_by_id={})
    if parsed is None:
        return None
    _work_id, paper = parsed
    return paper.model_copy(update={"external_id": doi})


def _lookup_tracked_author_ids(names: list[str], *, api_key: str) -> list[str]:
    author_ids: list[str] = []
    seen: set[str] = set()

    for name in names:
        query = name.strip()
        if not query:
            continue
        response = httpx.get(
            AUTHORS_API,
            params={
                "search": query,
                "per_page": AUTHOR_LOOKUP_LIMIT,
                "api_key": api_key,
            },
            headers=_HEADERS,
            timeout=30.0,
        )
        response.raise_for_status()
        for item in response.json().get("results", []):
            display_name = (item.get("display_name") or "").strip()
            if not _author_name_matches(query, display_name):
                continue
            author_id = _short_openalex_id(item.get("id") or "")
            if author_id and author_id not in seen:
                seen.add(author_id)
                author_ids.append(author_id)

    return author_ids


def _search_recent_works(
    query: str,
    *,
    since_date: date,
    api_key: str,
    page: int,
    per_page: int,
) -> list[dict]:
    response = httpx.get(
        WORKS_API,
        params={
            "search": query,
            "filter": (
                f"from_publication_date:{since_date.isoformat()},"
                f"type:{WORK_TYPES},"
                "has_abstract:true"
            ),
            "sort": "publication_date:desc",
            "page": page,
            "per_page": per_page,
            "api_key": api_key,
        },
        headers=_HEADERS,
        timeout=30.0,
    )
    response.raise_for_status()
    return response.json().get("results", [])


def _fetch_recent_author_works(
    author_ids: list[str],
    *,
    since_date: date,
    api_key: str,
    page: int,
    per_page: int,
) -> list[dict]:
    response = httpx.get(
        WORKS_API,
        params={
            "filter": (
                f"from_publication_date:{since_date.isoformat()},"
                f"authorships.author.id:{'|'.join(author_ids)},"
                f"type:{WORK_TYPES},"
                "has_abstract:true"
            ),
            "sort": "publication_date:desc",
            "page": page,
            "per_page": per_page,
            "api_key": api_key,
        },
        headers=_HEADERS,
        timeout=30.0,
    )
    response.raise_for_status()
    return response.json().get("results", [])


def _merge_work_batch(
    batch: list[dict],
    papers_by_id: dict[str, Paper],
    *,
    source_titles_by_id: dict[str, Optional[str]],
    api_key: str,
) -> None:
    _populate_source_titles(batch, source_titles_by_id=source_titles_by_id, api_key=api_key)
    for item in batch:
        parsed = _parse_work(item, source_titles_by_id=source_titles_by_id)
        if parsed is None:
            continue
        work_id, paper = parsed
        papers_by_id.setdefault(work_id, paper)


def _parse_work(
    item: dict,
    *,
    source_titles_by_id: dict[str, Optional[str]],
) -> tuple[str, Paper] | None:
    work_id = _short_openalex_id(item.get("id") or "")
    title = (item.get("display_name") or "").strip()
    published_raw = (item.get("publication_date") or "").strip()
    if not work_id or not title or not published_raw:
        return None

    try:
        published_date = date.fromisoformat(published_raw)
    except ValueError:
        return None

    authors = [
        (authorship.get("author") or {}).get("display_name", "").strip()
        for authorship in item.get("authorships") or []
        if isinstance(authorship, dict)
    ]
    authors = [author for author in authors if author]

    doi = _strip_doi_url((item.get("doi") or "").strip())
    external_id = doi or work_id
    journal_abbrev = _journal_abbrev(item, source_titles_by_id=source_titles_by_id)

    return work_id, Paper(
        source="openalex",
        external_id=external_id,
        title=title,
        abstract=_reconstruct_abstract(item.get("abstract_inverted_index")),
        authors=authors,
        published_date=published_date,
        journal_abbrev=journal_abbrev,
        url=_work_url(item),
    )


def _populate_source_titles(
    batch: list[dict],
    *,
    source_titles_by_id: dict[str, Optional[str]],
    api_key: str,
) -> None:
    source_ids = {
        source_id
        for item in batch
        if (source_id := _primary_source_id(item)) and source_id not in source_titles_by_id
    }
    for source_id in source_ids:
        source_titles_by_id[source_id] = _fetch_source_title(source_id, api_key=api_key)


def _fetch_source_title(source_id: str, *, api_key: str) -> Optional[str]:
    response = httpx.get(
        f"{SOURCES_API}/{source_id}",
        params={
            "select": "id,display_name,abbreviated_title",
            "api_key": api_key,
        },
        headers=_HEADERS,
        timeout=30.0,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        return None

    abbreviated_title = (payload.get("abbreviated_title") or "").strip()
    if abbreviated_title:
        return abbreviated_title

    display_name = (payload.get("display_name") or "").strip()
    return display_name or None


def _journal_abbrev(
    item: dict,
    *,
    source_titles_by_id: dict[str, Optional[str]],
) -> Optional[str]:
    source_id = _primary_source_id(item)
    if source_id:
        resolved = source_titles_by_id.get(source_id)
        if resolved:
            return resolved

    source = _primary_source(item)
    if source:
        display_name = (source.get("display_name") or "").strip()
        if display_name:
            return display_name

    primary_location = item.get("primary_location") or {}
    if isinstance(primary_location, dict):
        raw_source_name = (primary_location.get("raw_source_name") or "").strip()
        if raw_source_name:
            return raw_source_name

    return None


def _primary_source_id(item: dict) -> Optional[str]:
    source = _primary_source(item)
    if not source:
        return None
    source_id = _short_openalex_id((source.get("id") or "").strip())
    return source_id or None


def _primary_source(item: dict) -> Optional[dict]:
    primary_location = item.get("primary_location") or {}
    if not isinstance(primary_location, dict):
        return None
    source = primary_location.get("source") or {}
    return source if isinstance(source, dict) else None


def _reconstruct_abstract(inverted_index: object) -> str:
    if not isinstance(inverted_index, dict):
        return ""

    tokens_by_position: dict[int, str] = {}
    for token, positions in inverted_index.items():
        if not isinstance(token, str) or not isinstance(positions, list):
            continue
        for position in positions:
            if isinstance(position, int):
                tokens_by_position[position] = token

    if not tokens_by_position:
        return ""

    text = " ".join(tokens_by_position[pos] for pos in sorted(tokens_by_position))
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    text = re.sub(r"\(\s+", "(", text)
    text = re.sub(r"\s+\)", ")", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _author_name_matches(query: str, display_name: str) -> bool:
    normalized_query = _normalize_name(query)
    normalized_display = _normalize_name(display_name)
    if not normalized_query or not normalized_display:
        return False
    return (
        normalized_query in normalized_display
        or normalized_display in normalized_query
    )


def _normalize_name(name: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", name.lower())).strip()


def _short_openalex_id(openalex_id: str) -> str:
    return openalex_id.rstrip("/").rsplit("/", 1)[-1]


def _strip_doi_url(doi: str) -> str:
    if not doi:
        return ""
    return re.sub(r"^https?://(?:dx\.)?doi\.org/", "", doi, flags=re.IGNORECASE)


def _work_url(item: dict) -> str:
    primary_location = item.get("primary_location") or {}
    if isinstance(primary_location, dict):
        landing_page = (primary_location.get("landing_page_url") or "").strip()
        if landing_page:
            return landing_page

    best_oa_location = item.get("best_oa_location") or {}
    if isinstance(best_oa_location, dict):
        landing_page = (best_oa_location.get("landing_page_url") or "").strip()
        if landing_page:
            return landing_page

    doi = (item.get("doi") or "").strip()
    if doi:
        return doi

    return item.get("id") or ""
