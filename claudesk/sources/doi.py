from __future__ import annotations

import html
import re
from dataclasses import dataclass
from datetime import date
from urllib.parse import quote

import httpx

from claudesk.core.doi import normalize_doi
from claudesk.core.models import Paper
from claudesk.sources import openalex

CROSSREF_WORKS_API = "https://api.crossref.org/works"
WARNING_VERSION_STRIPPED = "Version suffix was removed for metadata lookup."
WARNING_ABSTRACT_FILLED_FROM_OPENALEX = "Abstract filled from OpenAlex."
WARNING_NO_ABSTRACT = "No abstract found; paste one manually in the Abstract tab."
_HEADERS = {
    "User-Agent": "claudesk/0.1 (https://github.com/claudesk; mailto:stefanshi1988@gmail.com)",
    "Accept": "application/json",
}


class DoiMetadataError(RuntimeError):
    """Raised when DOI metadata cannot be fetched or parsed."""


class DoiNotFoundError(DoiMetadataError):
    """Raised when Crossref has no work for the requested DOI."""


@dataclass(frozen=True)
class DoiResolution:
    paper: Paper
    warnings: tuple[str, ...]
    resolved_doi: str


@dataclass(frozen=True)
class DoiMetadataEnrichment:
    paper: Paper | None
    warnings: tuple[str, ...]
    resolved_doi: str | None


def resolve_doi_metadata(doi_input: str) -> Paper:
    """Fetch DOI metadata and convert it into a Paper."""
    return resolve_doi_metadata_with_warnings(doi_input).paper


def fetch_openalex_metadata_for_doi(doi_input: str) -> DoiMetadataEnrichment:
    """Fetch a DOI work from OpenAlex when it has an abstract."""
    doi = normalize_doi(doi_input)
    stripped_doi = _version_stripped_candidate(doi)

    for candidate in _unique_candidates(doi, stripped_doi):
        paper = _try_fetch_openalex_work(candidate)
        if paper is None or not _has_abstract(paper):
            continue
        warnings = [WARNING_ABSTRACT_FILLED_FROM_OPENALEX]
        if candidate == stripped_doi:
            warnings.insert(0, WARNING_VERSION_STRIPPED)
        return DoiMetadataEnrichment(
            paper=paper,
            warnings=tuple(warnings),
            resolved_doi=candidate,
        )

    return DoiMetadataEnrichment(paper=None, warnings=(), resolved_doi=None)


def resolve_doi_metadata_with_warnings(doi_input: str) -> DoiResolution:
    """Fetch DOI metadata with Crossref first and OpenAlex as a fallback."""
    doi = normalize_doi(doi_input)
    stripped_doi = _version_stripped_candidate(doi)
    warnings: list[str] = []

    crossref_paper: Paper | None = None
    crossref_doi: str | None = None
    crossref_error: DoiMetadataError | None = None

    try:
        crossref_paper = _fetch_crossref_work(doi)
        crossref_doi = doi
    except DoiMetadataError as exc:
        crossref_error = exc

    if crossref_paper is None and stripped_doi is not None:
        try:
            crossref_paper = _fetch_crossref_work(stripped_doi)
            crossref_doi = stripped_doi
        except DoiMetadataError as exc:
            crossref_error = exc

    openalex_paper: Paper | None = None
    openalex_doi: str | None = None
    if crossref_paper is None or not _has_abstract(crossref_paper):
        for candidate in _unique_candidates(doi, stripped_doi):
            candidate_paper = _try_fetch_openalex_work(candidate)
            if candidate_paper is None:
                continue
            if openalex_paper is None or (
                not _has_abstract(openalex_paper) and _has_abstract(candidate_paper)
            ):
                openalex_paper = candidate_paper
                openalex_doi = candidate
            if _has_abstract(candidate_paper):
                break

    used_stripped_lookup = False
    if crossref_paper is not None:
        resolved = crossref_paper
        resolved_doi = crossref_doi or doi
        used_stripped_lookup = resolved_doi == stripped_doi
        if not _has_abstract(resolved) and openalex_paper is not None and _has_abstract(openalex_paper):
            resolved = resolved.model_copy(update={"abstract": openalex_paper.abstract})
            warnings.append(WARNING_ABSTRACT_FILLED_FROM_OPENALEX)
            used_stripped_lookup = used_stripped_lookup or openalex_doi == stripped_doi
    elif openalex_paper is not None:
        resolved = openalex_paper
        resolved_doi = openalex_doi or doi
        used_stripped_lookup = resolved_doi == stripped_doi
    else:
        if stripped_doi is not None:
            raise DoiNotFoundError(
                f"No metadata found for DOI. Try {stripped_doi} without the version suffix."
            ) from crossref_error
        if isinstance(crossref_error, DoiNotFoundError):
            raise DoiNotFoundError("No metadata found for DOI.") from crossref_error
        if crossref_error is not None:
            raise crossref_error
        raise DoiNotFoundError("No metadata found for DOI.")

    if used_stripped_lookup:
        warnings.insert(0, WARNING_VERSION_STRIPPED)
    if not _has_abstract(resolved):
        warnings.append(WARNING_NO_ABSTRACT)

    return DoiResolution(
        paper=resolved,
        warnings=tuple(dict.fromkeys(warnings)),
        resolved_doi=resolved_doi,
    )


def _fetch_crossref_work(doi: str) -> Paper:
    url = f"{CROSSREF_WORKS_API}/{quote(doi, safe='')}"
    try:
        response = httpx.get(url, headers=_HEADERS, timeout=30.0)
    except httpx.HTTPError as exc:
        raise DoiMetadataError("Failed to fetch DOI metadata.") from exc

    if response.status_code == 404:
        raise DoiNotFoundError("No metadata found for DOI.")

    try:
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise DoiMetadataError("Failed to fetch DOI metadata.") from exc

    message = payload.get("message") if isinstance(payload, dict) else None
    if not isinstance(message, dict):
        raise DoiMetadataError("DOI metadata response was not usable.")

    paper = _parse_crossref_work(message, doi)
    if paper is None:
        raise DoiMetadataError("DOI metadata response was missing required fields.")
    return paper


def _try_fetch_openalex_work(doi: str) -> Paper | None:
    try:
        return openalex.fetch_work_by_doi(doi)
    except (httpx.HTTPError, ValueError):
        return None


def _version_stripped_candidate(doi: str) -> str | None:
    candidates = [
        re.sub(r"/v\d+$", "", doi, flags=re.IGNORECASE),
        re.sub(r"(?<=\d)v\d+$", "", doi, flags=re.IGNORECASE),
    ]
    for candidate in candidates:
        if candidate == doi:
            continue
        try:
            normalized = normalize_doi(candidate)
        except ValueError:
            continue
        if normalized != doi:
            return normalized
    return None


def _unique_candidates(*values: str | None) -> list[str]:
    candidates: list[str] = []
    for value in values:
        if value and value not in candidates:
            candidates.append(value)
    return candidates


def _has_abstract(paper: Paper) -> bool:
    return bool(paper.abstract.strip())


def _parse_crossref_work(item: dict, doi: str) -> Paper | None:
    title = _first_text(item.get("title"))
    published_date = _published_date(item)
    if not title or published_date is None:
        return None

    return Paper(
        source="crossref",
        external_id=doi,
        title=title,
        abstract=_normalize_text(item.get("abstract") or ""),
        authors=_authors(item.get("author")),
        published_date=published_date,
        journal_abbrev=(
            _first_text(item.get("short-container-title"))
            or _first_text(item.get("container-title"))
        ),
        url=_normalize_text(item.get("URL") or f"https://doi.org/{doi}"),
    )


def _authors(value: object) -> list[str]:
    if not isinstance(value, list):
        return []

    authors: list[str] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        given = _normalize_text(item.get("given") or "")
        family = _normalize_text(item.get("family") or "")
        name = _normalize_text(item.get("name") or "")
        author = " ".join(part for part in [given, family] if part).strip()
        if not author and name:
            author = name
        if author:
            authors.append(author)
    return authors


def _published_date(item: dict) -> date | None:
    for key in ("published-print", "published-online", "published", "issued", "created"):
        parsed = _date_from_parts(item.get(key))
        if parsed is not None:
            return parsed
    return None


def _date_from_parts(value: object) -> date | None:
    if not isinstance(value, dict):
        return None
    parts_rows = value.get("date-parts")
    if not isinstance(parts_rows, list) or not parts_rows:
        return None
    parts = parts_rows[0]
    if not isinstance(parts, list) or not parts:
        return None

    try:
        year = int(parts[0])
        month = int(parts[1]) if len(parts) > 1 else 1
        day = int(parts[2]) if len(parts) > 2 else 1
        return date(year, month, day)
    except (TypeError, ValueError):
        return None


def _first_text(value: object) -> str:
    if not isinstance(value, list) or not value:
        return ""
    return _normalize_text(value[0])


def _normalize_text(value: object) -> str:
    cleaned = re.sub(r"<[^>]+>", " ", str(value or ""))
    cleaned = html.unescape(cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    cleaned = re.sub(r"\s+([,.;:!?])", r"\1", cleaned)
    return cleaned
