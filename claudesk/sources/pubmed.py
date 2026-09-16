from __future__ import annotations

import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import date, datetime
from typing import Optional
from urllib.parse import urlencode

import httpx

from claudesk.core.config import Config, load_config
from claudesk.core.models import Paper
from claudesk.sources.base import SourceProgressCallback

ESEARCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
EFETCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"
EFETCH_BATCH = 100
ESEARCH_SAFE_URL_LENGTH = 1800
REQUEST_DELAY = 0.4   # safe for NCBI's 3 req/s limit without an API key
_LENGTH_CHECK_DATE = date(2000, 1, 1)

_MONTH = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}


@dataclass(frozen=True)
class PubmedQueryPlan:
    query_mode: str
    query: str
    queries: tuple[str, ...]
    encoded_request_length: int
    length_status: str
    warning: Optional[str] = None


class PubmedQueryTooLongError(RuntimeError):
    """Raised when PubMed rejects an ESearch request for URL/body length."""


def fetch(
    since: datetime,
    *,
    search_terms: Optional[list[str]] = None,
    api_key: Optional[str] = None,
    progress_cb: Optional[SourceProgressCallback] = None,
) -> list[Paper]:
    """Fetch PubMed papers matching the configured search terms since `since`.

    `search_terms` / `api_key` override the config — useful for testing.
    external_id is the paper's DOI when available (enables cross-source dedup
    with bioRxiv/arXiv), otherwise falls back to 'pmid:{pmid}'.
    """
    cfg = load_config()
    if not cfg.sources.pubmed.enabled and search_terms is None:
        return []

    query_plan = build_pubmed_query_plan(cfg, search_terms=search_terms)
    key = api_key if api_key is not None else cfg.sources.pubmed.api_key

    if not query_plan.query:
        return []

    since_date = since.date()
    today = date.today()
    max_results = cfg.digest.max_per_source

    pmids = _esearch_all(query_plan.queries, since_date, today, max_results, key)
    if progress_cb is not None:
        progress_cb(
            {
                "event": "source_progress",
                "count": 0,
                "target": max_results,
            }
        )
    if not pmids:
        return []

    papers = _efetch_all(pmids, key, progress_cb=progress_cb, target=max_results)
    return [p for p in papers if p.published_date >= since_date]


# ---------------------------------------------------------------------------
# ESearch
# ---------------------------------------------------------------------------

def build_pubmed_query(
    cfg: Config,
    *,
    search_terms: Optional[list[str]] = None,
) -> str:
    """Return the exact PubMed ESearch query for the active strategy.

    ``search_terms`` is a compatibility override for tests/direct callers and
    is always treated as advanced raw PubMed syntax.
    """
    return build_pubmed_query_plan(cfg, search_terms=search_terms).query


def build_pubmed_query_plan(
    cfg: Config,
    *,
    search_terms: Optional[list[str]] = None,
) -> PubmedQueryPlan:
    """Return generated PubMed query text plus request-length metadata.

    The full ``query`` is the preview/canonical term. ``queries`` is the
    concrete ESearch plan. For generated auto/builder searches it may contain
    smaller equivalent OR-clause chunks; for raw searches it stays one term so
    advanced PubMed syntax remains caller-controlled.
    """
    if search_terms is not None:
        query = build_raw_pubmed_query(search_terms)
        return _query_plan("raw", query, (query,) if query else (), cfg=cfg)

    pubmed_cfg = cfg.sources.pubmed
    if pubmed_cfg.query_mode == "raw":
        query = build_raw_pubmed_query(pubmed_cfg.search_terms)
        return _query_plan("raw", query, (query,) if query else (), cfg=cfg)

    if pubmed_cfg.query_mode == "builder":
        return _literal_query_plan(
            "builder",
            concepts=pubmed_cfg.concepts,
            exclude_terms=pubmed_cfg.exclude_terms,
            scope=pubmed_cfg.concept_scope,
            cfg=cfg,
        )

    return _literal_query_plan(
        "auto",
        concepts=_auto_pubmed_concepts(cfg),
        exclude_terms=cfg.keywords.exclude,
        scope="title_abstract_or_mesh",
        cfg=cfg,
    )


def build_raw_pubmed_query(search_terms: list[str]) -> str:
    terms = _normalize_terms(search_terms)
    return " OR ".join(f"({term})" for term in terms)


def build_literal_pubmed_query(
    *,
    concepts: list[str],
    exclude_terms: list[str],
    scope: str,
) -> str:
    concept_clauses = [_scope_clause(term, scope) for term in _normalize_terms(concepts)]
    if not concept_clauses:
        return ""

    query = _or_group(concept_clauses)
    exclude_clauses = [_scope_clause(term, scope) for term in _normalize_terms(exclude_terms)]
    if exclude_clauses:
        query = f"{query} AND NOT {_or_group(exclude_clauses)}"
    return query


def _auto_pubmed_concepts(cfg: Config) -> list[str]:
    return _normalize_terms([*cfg.topics, *cfg.keywords.include, *cfg.profile.field])


def _normalize_terms(terms: list[str]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in terms:
        term = raw.strip()
        key = term.casefold()
        if not term or key in seen:
            continue
        normalized.append(term)
        seen.add(key)
    return normalized


def _literal(term: str) -> str:
    escaped = term.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _scope_clause(term: str, scope: str) -> str:
    literal = _literal(term)
    if scope == "title_abstract":
        return f"{literal}[Title/Abstract]"
    if scope == "mesh":
        return f"{literal}[MeSH Terms]"
    if scope == "title_abstract_or_mesh":
        return f"({literal}[Title/Abstract] OR {literal}[MeSH Terms])"
    raise ValueError(f"Unknown PubMed concept scope: {scope!r}")


def _or_group(clauses: list[str]) -> str:
    if len(clauses) == 1:
        return clauses[0]
    return f"({' OR '.join(clauses)})"


def _literal_query_plan(
    query_mode: str,
    *,
    concepts: list[str],
    exclude_terms: list[str],
    scope: str,
    cfg: Config,
) -> PubmedQueryPlan:
    query = build_literal_pubmed_query(
        concepts=concepts,
        exclude_terms=exclude_terms,
        scope=scope,
    )
    if not query:
        return _query_plan(query_mode, query, (), cfg=cfg)

    queries = _split_literal_pubmed_queries(
        concepts=concepts,
        exclude_terms=exclude_terms,
        scope=scope,
        max_results=cfg.digest.max_per_source,
        api_key=cfg.sources.pubmed.api_key,
    )
    return _query_plan(query_mode, query, queries, cfg=cfg)


def _query_plan(
    query_mode: str,
    query: str,
    queries: tuple[str, ...],
    *,
    cfg: Optional[Config] = None,
) -> PubmedQueryPlan:
    max_results = cfg.digest.max_per_source if cfg is not None else Config().digest.max_per_source
    api_key = cfg.sources.pubmed.api_key if cfg is not None else None
    encoded_length = (
        _encoded_esearch_request_length(
            query,
            _LENGTH_CHECK_DATE,
            _LENGTH_CHECK_DATE,
            max_results,
            api_key,
        )
        if query
        else 0
    )
    length_status = "empty" if not query else (
        "too_long" if encoded_length > ESEARCH_SAFE_URL_LENGTH else "ok"
    )
    warning: Optional[str] = None
    if length_status == "too_long":
        if query_mode == "raw":
            warning = (
                "Raw PubMed ESearch request is long; Claudesk will send it "
                "with the PubMed request-body fallback and report request-length "
                "failures as PubMed query length errors."
            )
        else:
            if len(queries) > 1:
                warning = (
                    "Generated PubMed ESearch request is long; Claudesk will split "
                    f"it into {len(queries)} PubMed searches while preserving exclusions."
                )
            else:
                warning = (
                    "Generated PubMed ESearch request is long; Claudesk will use "
                    "the PubMed request-body fallback and preserve the generated query."
                )
    return PubmedQueryPlan(
        query_mode=query_mode,
        query=query,
        queries=queries,
        encoded_request_length=encoded_length,
        length_status=length_status,
        warning=warning,
    )


def _split_literal_pubmed_queries(
    *,
    concepts: list[str],
    exclude_terms: list[str],
    scope: str,
    max_results: int,
    api_key: Optional[str],
) -> tuple[str, ...]:
    normalized_concepts = _normalize_terms(concepts)
    normalized_exclusions = _normalize_terms(exclude_terms)
    if not normalized_concepts:
        return ()

    full_query = build_literal_pubmed_query(
        concepts=normalized_concepts,
        exclude_terms=normalized_exclusions,
        scope=scope,
    )
    if _encoded_esearch_request_length(
        full_query,
        _LENGTH_CHECK_DATE,
        _LENGTH_CHECK_DATE,
        max_results,
        api_key,
    ) <= ESEARCH_SAFE_URL_LENGTH:
        return (full_query,)

    chunks: list[str] = []
    current: list[str] = []
    for concept in normalized_concepts:
        candidate = [*current, concept]
        candidate_query = build_literal_pubmed_query(
            concepts=candidate,
            exclude_terms=normalized_exclusions,
            scope=scope,
        )
        if current and _encoded_esearch_request_length(
            candidate_query,
            _LENGTH_CHECK_DATE,
            _LENGTH_CHECK_DATE,
            max_results,
            api_key,
        ) > ESEARCH_SAFE_URL_LENGTH:
            chunks.append(
                build_literal_pubmed_query(
                    concepts=current,
                    exclude_terms=normalized_exclusions,
                    scope=scope,
                )
            )
            current = [concept]
        else:
            current = candidate
    if current:
        chunks.append(
            build_literal_pubmed_query(
                concepts=current,
                exclude_terms=normalized_exclusions,
                scope=scope,
            )
        )
    return tuple(chunks)


def _esearch(
    query: str,
    since_date: date,
    to_date: date,
    max_results: int,
    api_key: Optional[str],
) -> list[str]:
    params = _esearch_params(query, since_date, to_date, max_results, api_key)

    try:
        resp = _send_esearch_request(params)
        resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        if _is_request_too_long_error(exc):
            raise PubmedQueryTooLongError(_request_too_long_message(query)) from exc
        raise
    return resp.json().get("esearchresult", {}).get("idlist", [])


def _esearch_all(
    queries: tuple[str, ...],
    since_date: date,
    to_date: date,
    max_results: int,
    api_key: Optional[str],
) -> list[str]:
    # ``max_per_source`` remains a total PubMed cap: each split query asks for
    # up to the source cap, PMIDs are deduped, then chunks are interleaved
    # before applying the final EFetch/storage cap so prolific early chunks do
    # not crowd out later concept groups.
    chunk_pmids: list[list[str]] = []
    seen: set[str] = set()
    for index, query in enumerate(queries):
        query_pmids: list[str] = []
        for pmid in _esearch(query, since_date, to_date, max_results, api_key):
            if not pmid or pmid in seen:
                continue
            query_pmids.append(pmid)
            seen.add(pmid)
        chunk_pmids.append(query_pmids)
        if index + 1 < len(queries):
            time.sleep(REQUEST_DELAY)

    merged: list[str] = []
    offset = 0
    while len(merged) < max_results:
        added = False
        for query_pmids in chunk_pmids:
            if offset >= len(query_pmids):
                continue
            merged.append(query_pmids[offset])
            added = True
            if len(merged) >= max_results:
                return merged
        if not added:
            break
        offset += 1
    return merged


def _esearch_params(
    query: str,
    since_date: date,
    to_date: date,
    max_results: int,
    api_key: Optional[str],
) -> dict[str, object]:
    params: dict[str, object] = {
        "db": "pubmed",
        "term": query,
        "mindate": since_date.strftime("%Y/%m/%d"),
        "maxdate": to_date.strftime("%Y/%m/%d"),
        "datetype": "pdat",
        "retmax": max_results,
        "retmode": "json",
        "tool": "claudesk",
        "email": "claudesk@personal",
    }
    if api_key:
        params["api_key"] = api_key
    return params


def _encoded_esearch_request_length(
    query: str,
    since_date: date,
    to_date: date,
    max_results: int,
    api_key: Optional[str],
) -> int:
    return _encoded_url_length(
        _esearch_params(query, since_date, to_date, max_results, api_key)
    )


def _encoded_url_length(params: dict[str, object]) -> int:
    return len(f"{ESEARCH_URL}?{urlencode(params)}")


def _send_esearch_request(params: dict[str, object]) -> httpx.Response:
    if _encoded_url_length(params) > ESEARCH_SAFE_URL_LENGTH:
        return httpx.post(ESEARCH_URL, data=params, timeout=30.0)
    return httpx.get(ESEARCH_URL, params=params, timeout=30.0)


def _is_request_too_long_error(exc: httpx.HTTPStatusError) -> bool:
    if exc.response.status_code == 414:
        return True
    message = str(exc).casefold()
    return (
        "request-uri too long" in message
        or "uri too long" in message
        or "url too long" in message
    )


def _request_too_long_message(query: str) -> str:
    return (
        "PubMed ESearch request is too long for reliable transport. "
        "Use PubMed Settings preview to reduce the generated query or let "
        f"Claudesk split generated searches. Query length: {len(query)} characters."
    )


# ---------------------------------------------------------------------------
# EFetch
# ---------------------------------------------------------------------------

def _efetch_all(
    pmids: list[str],
    api_key: Optional[str],
    *,
    progress_cb: Optional[SourceProgressCallback] = None,
    target: Optional[int] = None,
) -> list[Paper]:
    papers: list[Paper] = []
    for i in range(0, len(pmids), EFETCH_BATCH):
        batch = pmids[i : i + EFETCH_BATCH]
        papers.extend(_efetch_batch(batch, api_key))
        if progress_cb is not None:
            progress_cb(
                {
                    "event": "source_progress",
                    "count": len(papers),
                    "target": target if target is not None else len(pmids),
                }
            )
        if i + EFETCH_BATCH < len(pmids):
            time.sleep(REQUEST_DELAY)
    return papers


def _efetch_batch(pmids: list[str], api_key: Optional[str]) -> list[Paper]:
    params: dict = {
        "db": "pubmed",
        "id": ",".join(pmids),
        "rettype": "xml",
        "retmode": "xml",
        "tool": "claudesk",
        "email": "claudesk@personal",
    }
    if api_key:
        params["api_key"] = api_key

    resp = httpx.get(EFETCH_URL, params=params, timeout=60.0)
    resp.raise_for_status()
    return _parse_pubmed_xml(resp.text)


# ---------------------------------------------------------------------------
# XML parsing
# ---------------------------------------------------------------------------

def _parse_pubmed_xml(xml_text: str) -> list[Paper]:
    root = ET.fromstring(xml_text)
    papers = []
    for article in root.findall(".//PubmedArticle"):
        paper = _parse_article(article)
        if paper is not None:
            papers.append(paper)
    return papers


def _parse_article(article: ET.Element) -> Optional[Paper]:
    try:
        citation = article.find("MedlineCitation")
        if citation is None:
            return None

        pmid_elem = citation.find("PMID")
        pmid = pmid_elem.text.strip() if pmid_elem is not None and pmid_elem.text else ""
        if not pmid:
            return None

        article_elem = citation.find("Article")
        if article_elem is None:
            return None

        title = _text_content(article_elem.find("ArticleTitle"))
        abstract = _get_abstract(article_elem)
        authors = _get_authors(article_elem)
        journal_abbrev = _get_journal_abbrev(citation, article_elem)

        published_date = _get_pubdate(article_elem)
        if published_date is None:
            return None

        # Use DOI as external_id when available — lets pipeline/dedupe.py match
        # PubMed publications against arXiv/bioRxiv preprints by DOI.
        doi = _get_doi(article)
        external_id = doi if doi else f"pmid:{pmid}"

        return Paper(
            source="pubmed",
            external_id=external_id,
            title=title,
            abstract=abstract,
            authors=authors,
            published_date=published_date,
            journal_abbrev=journal_abbrev,
            url=f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
        )
    except Exception:
        return None


def _text_content(elem: Optional[ET.Element]) -> str:
    """Concatenate all text inside an element (handles mixed-content tags like <i>)."""
    if elem is None:
        return ""
    return "".join(elem.itertext()).strip()


def _get_abstract(article_elem: ET.Element) -> str:
    abstract_elem = article_elem.find("Abstract")
    if abstract_elem is None:
        return ""
    parts = []
    for text_elem in abstract_elem.findall("AbstractText"):
        label = text_elem.get("Label")
        text = _text_content(text_elem)
        if label and text:
            parts.append(f"{label}: {text}")
        elif text:
            parts.append(text)
    return " ".join(parts)


def _get_authors(article_elem: ET.Element) -> list[str]:
    author_list = article_elem.find("AuthorList")
    if author_list is None:
        return []
    authors = []
    for author in author_list.findall("Author"):
        collective = author.find("CollectiveName")
        if collective is not None and collective.text:
            authors.append(collective.text.strip())
            continue
        last = author.find("LastName")
        fore = author.find("ForeName")
        if last is not None and last.text:
            name = last.text.strip()
            if fore is not None and fore.text:
                name = f"{fore.text.strip()} {name}"
            authors.append(name)
    return authors


def _get_journal_abbrev(citation: ET.Element, article_elem: ET.Element) -> Optional[str]:
    iso_abbrev = _text_content(article_elem.find(".//Journal/ISOAbbreviation"))
    if iso_abbrev:
        return iso_abbrev

    medline_ta = _text_content(citation.find(".//MedlineJournalInfo/MedlineTA"))
    if medline_ta:
        return medline_ta

    journal_title = _text_content(article_elem.find(".//Journal/Title"))
    return journal_title or None


def _get_pubdate(article_elem: ET.Element) -> Optional[date]:
    # Prefer JournalIssue/PubDate (print/online pub date)
    pubdate = article_elem.find(".//JournalIssue/PubDate")
    if pubdate is not None:
        d = _parse_pubdate_elem(pubdate)
        if d:
            return d
    # Fallback: ArticleDate (often the electronic publication date)
    article_date = article_elem.find(".//ArticleDate")
    if article_date is not None:
        d = _parse_pubdate_elem(article_date)
        if d:
            return d
    return None


def _parse_pubdate_elem(elem: ET.Element) -> Optional[date]:
    year_elem = elem.find("Year")
    if year_elem is None or not year_elem.text:
        # MedlineDate fallback: "2024 Jan-Feb", "Spring 2024", etc. — take first 4-digit year
        medline = elem.find("MedlineDate")
        if medline is not None and medline.text:
            for token in medline.text.split():
                if token.isdigit() and len(token) == 4:
                    try:
                        return date(int(token), 1, 1)
                    except ValueError:
                        pass
        return None

    try:
        year = int(year_elem.text.strip())
    except ValueError:
        return None

    month = 1
    month_elem = elem.find("Month")
    if month_elem is not None and month_elem.text:
        m = month_elem.text.strip().lower()[:3]
        month = _MONTH.get(m) or (int(m) if m.isdigit() else 1)

    day = 1
    day_elem = elem.find("Day")
    if day_elem is not None and day_elem.text:
        try:
            day = int(day_elem.text.strip())
        except ValueError:
            day = 1

    try:
        return date(year, month, day)
    except ValueError:
        return date(year, month, 1)


def _get_doi(article: ET.Element) -> Optional[str]:
    for aid in article.findall(".//ArticleId"):
        if aid.get("IdType") == "doi" and aid.text:
            return aid.text.strip()
    for loc in article.findall(".//ELocationID"):
        if loc.get("EIdType") == "doi" and loc.text:
            return loc.text.strip()
    return None
