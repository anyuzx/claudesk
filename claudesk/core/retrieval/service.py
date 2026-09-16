from __future__ import annotations

import math
import re
import sqlite3
from collections.abc import Iterable
from dataclasses import replace

from claudesk.core.db.assets import search_asset_text_chunks
from claudesk.core.db.notes import _hydrate_notes, get_note, search_notes
from claudesk.core.db.papers import _hydrate_papers_with_projects, get_paper, search_papers
from claudesk.core.db.projects import _load_project_link_map, get_project, search_projects
from claudesk.core.db.tasks import (
    _row_to_todo,
    format_log_entry_display_text,
    get_todo,
    list_log_entries,
    search_log_entries,
    search_todos,
)
from claudesk.core.db.utils import _lexical_term_match_score, _rank_fts_rows
from claudesk.core.models import AssetTextChunk, LogEntry, Note, Paper, Project, Todo

from .models import (
    RetrievalBackend,
    RetrievalEvidenceLocator,
    RetrievalFieldScore,
    RetrievalHit,
    RetrievalQuery,
    RetrievalRequest,
    RetrievalResults,
    RetrievalScope,
    RetrievalScoreMetadata,
    RetrievalSnippet,
    RetrievalSourceType,
)


FUSION_RANK_OFFSET = 60.0
SEMANTIC_MIN_CANDIDATE_LIMIT = 25
SEMANTIC_MAX_CANDIDATE_LIMIT = 200
SEMANTIC_OVERSAMPLE_FACTOR = 4
SEMANTIC_ABSOLUTE_SCORE_THRESHOLD = 0.62
SEMANTIC_RELATIVE_SCORE_THRESHOLD = 0.90
GLOBAL_SEARCH_SOURCE_TYPES = (
    RetrievalSourceType.PAPER,
    RetrievalSourceType.NOTE,
    RetrievalSourceType.PROJECT,
    RetrievalSourceType.TASK,
    RetrievalSourceType.LOG,
)
FUSION_SOURCE_ORDER = {
    source_type: index
    for index, source_type in enumerate((
        RetrievalSourceType.PAPER,
        RetrievalSourceType.NOTE,
        RetrievalSourceType.PROJECT,
        RetrievalSourceType.TASK,
        RetrievalSourceType.LOG,
        RetrievalSourceType.PDF_CHUNK,
    ))
}
SEMANTIC_SOURCE_TYPES = (
    RetrievalSourceType.PAPER,
    RetrievalSourceType.NOTE,
    RetrievalSourceType.PROJECT,
    RetrievalSourceType.TASK,
    RetrievalSourceType.LOG,
    RetrievalSourceType.PDF_CHUNK,
)


def retrieve(conn: sqlite3.Connection, request: RetrievalRequest) -> RetrievalResults:
    query = request.query
    scope = request.scope
    if query.is_empty:
        return RetrievalResults(query=query, scope=scope, hits=())

    source_types = scope.source_types or GLOBAL_SEARCH_SOURCE_TYPES
    limit = max(1, request.limit_per_source)
    hits: list[RetrievalHit] = []

    backends = set(request.backends)
    if RetrievalBackend.LEXICAL in backends:
        if RetrievalSourceType.PAPER in source_types:
            hits.extend(_paper_hits(conn, query, scope, limit=limit))
        if RetrievalSourceType.NOTE in source_types:
            hits.extend(_note_hits(conn, query, scope, limit=limit))
        if RetrievalSourceType.PROJECT in source_types:
            hits.extend(_project_hits(conn, query, scope, limit=limit))
        if RetrievalSourceType.TASK in source_types:
            hits.extend(_task_hits(conn, query, scope, limit=limit))
        if RetrievalSourceType.LOG in source_types:
            hits.extend(_log_hits(conn, query, scope, limit=limit))
        if RetrievalSourceType.PDF_CHUNK in source_types:
            hits.extend(_pdf_chunk_hits(conn, query, scope, limit=limit))
    if RetrievalBackend.SEMANTIC in backends:
        hits.extend(_semantic_hits(conn, query, scope, source_types=source_types, limit=limit))

    return RetrievalResults(query=query, scope=scope, hits=fuse_hits(hits))


def search(
    conn: sqlite3.Connection,
    query: str,
    *,
    source_types: tuple[RetrievalSourceType, ...] = (),
    project_id: int | None = None,
    paper_id: int | None = None,
    asset_id: int | None = None,
    include_dismissed: bool = False,
    limit_per_source: int = 50,
    backends: tuple[RetrievalBackend, ...] = (RetrievalBackend.LEXICAL,),
) -> RetrievalResults:
    return retrieve(
        conn,
        RetrievalRequest.from_text(
            query,
            source_types=source_types,
            project_id=project_id,
            paper_id=paper_id,
            asset_id=asset_id,
            include_dismissed=include_dismissed,
            limit_per_source=limit_per_source,
            backends=backends,
        ),
    )


def search_pdf_chunks(
    conn: sqlite3.Connection,
    query: str,
    *,
    paper_id: int | None,
    asset_id: int,
    limit: int = 10,
    backends: tuple[RetrievalBackend, ...] = (RetrievalBackend.LEXICAL,),
) -> RetrievalResults:
    return search(
        conn,
        query,
        source_types=(RetrievalSourceType.PDF_CHUNK,),
        paper_id=paper_id,
        asset_id=asset_id,
        limit_per_source=limit,
        backends=backends,
    )


def fuse_hits(hits: Iterable[RetrievalHit]) -> tuple[RetrievalHit, ...]:
    primary_by_key: dict[tuple[RetrievalSourceType, str], RetrievalHit] = {}
    fusion_scores: dict[tuple[RetrievalSourceType, str], float] = {}
    backends_by_key: dict[tuple[RetrievalSourceType, str], set[RetrievalBackend]] = {}

    for hit in hits:
        key = (hit.source_type, hit.source_id)
        contribution = hit.score.normalized_score or _rank_score(hit.score.rank)
        fusion_scores[key] = fusion_scores.get(key, 0.0) + contribution
        backends_by_key.setdefault(key, set()).add(hit.score.backend)
        current = primary_by_key.get(key)
        if current is None or _primary_sort_key(hit) < _primary_sort_key(current):
            primary_by_key[key] = hit

    fused: list[RetrievalHit] = []
    for key, hit in primary_by_key.items():
        backends = tuple(sorted(backends_by_key[key], key=lambda backend: backend.value))
        score = replace(
            hit.score,
            fusion_score=round(fusion_scores[key], 12),
            contributing_backends=backends,
        )
        fused.append(replace(hit, score=score))
    return tuple(sorted(fused, key=_fusion_sort_key))


def _paper_hits(
    conn: sqlite3.Connection,
    query: RetrievalQuery,
    scope: RetrievalScope,
    *,
    limit: int,
) -> list[RetrievalHit]:
    if scope.project_id is not None:
        papers = _search_project_papers(
            conn,
            query.text,
            project_id=scope.project_id,
            limit=limit,
            include_dismissed=scope.include_dismissed,
        )
    else:
        papers = search_papers(
            conn,
            query.text,
            limit=limit,
            include_dismissed=scope.include_dismissed,
        )
    return [
        _paper_hit(query, paper, rank=rank)
        for rank, paper in enumerate(papers, start=1)
        if paper.id is not None
    ]


def _note_hits(
    conn: sqlite3.Connection,
    query: RetrievalQuery,
    scope: RetrievalScope,
    *,
    limit: int,
) -> list[RetrievalHit]:
    if scope.paper_id is not None or scope.project_id is not None:
        notes = _search_scoped_notes(
            conn,
            query.text,
            paper_id=scope.paper_id,
            project_id=scope.project_id,
            limit=limit,
        )
    else:
        notes = search_notes(conn, query.text, limit=limit)
    return [
        _note_hit(query, note, rank=rank)
        for rank, note in enumerate(notes, start=1)
        if note.id is not None
    ]


def _project_hits(
    conn: sqlite3.Connection,
    query: RetrievalQuery,
    scope: RetrievalScope,
    *,
    limit: int,
) -> list[RetrievalHit]:
    if scope.paper_id is not None or scope.asset_id is not None:
        return []
    projects = search_projects(
        conn,
        query.text,
        include_done=True,
        project_id=scope.project_id,
        limit=limit,
    )
    return [
        _project_hit(query, project, rank=rank)
        for rank, project in enumerate(projects, start=1)
    ]


def _task_hits(
    conn: sqlite3.Connection,
    query: RetrievalQuery,
    scope: RetrievalScope,
    *,
    limit: int,
) -> list[RetrievalHit]:
    if scope.project_id is not None:
        todos = _search_project_todos(conn, query.text, project_id=scope.project_id, limit=limit)
    else:
        todos = search_todos(conn, query.text, limit=limit)
    return [
        _task_hit(query, todo, rank=rank)
        for rank, todo in enumerate(todos, start=1)
        if todo.id is not None
    ]


def _log_hits(
    conn: sqlite3.Connection,
    query: RetrievalQuery,
    scope: RetrievalScope,
    *,
    limit: int,
) -> list[RetrievalHit]:
    entries = search_log_entries(
        conn,
        query.text,
        days=None,
        project_id=scope.project_id,
        limit=limit,
    )
    return [
        _log_hit(query, entry, rank=rank)
        for rank, entry in enumerate(entries, start=1)
    ]


def _pdf_chunk_hits(
    conn: sqlite3.Connection,
    query: RetrievalQuery,
    scope: RetrievalScope,
    *,
    limit: int,
) -> list[RetrievalHit]:
    chunks = _search_scoped_pdf_chunks(
        conn,
        query.text,
        asset_id=scope.asset_id,
        paper_id=scope.paper_id,
        project_id=scope.project_id,
        limit=limit,
    )
    return [
        _pdf_chunk_hit(query, chunk, paper_id=paper_id, rank=rank)
        for rank, (chunk, paper_id) in enumerate(chunks, start=1)
        if chunk.id is not None
    ]


def _semantic_hits(
    conn: sqlite3.Connection,
    query: RetrievalQuery,
    scope: RetrievalScope,
    *,
    source_types: tuple[RetrievalSourceType, ...],
    limit: int,
) -> list[RetrievalHit]:
    semantic_source_types = tuple(
        source_type
        for source_type in source_types
        if source_type in SEMANTIC_SOURCE_TYPES
    )
    if not semantic_source_types:
        return []
    try:
        from .vector import SemanticIndexUnavailable, search_semantic_index

        candidate_limit = min(
            max(limit * SEMANTIC_OVERSAMPLE_FACTOR, SEMANTIC_MIN_CANDIDATE_LIMIT),
            SEMANTIC_MAX_CANDIDATE_LIMIT,
        )
        hits: list[RetrievalHit] = []
        for source_type in semantic_source_types:
            semantic_hits = search_semantic_index(
                conn,
                query.text,
                limit=candidate_limit,
                source_types=(source_type,),
            )
            source_candidates: list[RetrievalHit] = []
            for semantic_hit in semantic_hits:
                if not _semantic_hit_matches_scope(conn, semantic_hit.document, scope):
                    continue
                hit = _semantic_retrieval_hit(
                    conn,
                    query,
                    semantic_hit.document,
                    rank=len(source_candidates) + 1,
                    backend_score=semantic_hit.score,
                    include_dismissed=scope.include_dismissed,
                )
                if hit is None:
                    continue
                source_candidates.append(hit)
            hits.extend(_threshold_semantic_hits(source_candidates, limit=limit))
    except SemanticIndexUnavailable:
        return []
    return hits


def _semantic_retrieval_hit(
    conn: sqlite3.Connection,
    query: RetrievalQuery,
    document,
    *,
    rank: int,
    backend_score: float,
    include_dismissed: bool,
) -> RetrievalHit | None:
    if document.source_type == RetrievalSourceType.PAPER:
        paper_id = _locator_int(document.locator, "paper_id")
        if paper_id is None:
            return None
        paper = get_paper(conn, paper_id)
        if paper is None or paper.id is None:
            return None
        if not include_dismissed and paper.status.value == "dismissed":
            return None
        return _paper_hit(
            query,
            paper,
            rank=rank,
            backend=RetrievalBackend.SEMANTIC,
            backend_score=backend_score,
        )
    if document.source_type == RetrievalSourceType.NOTE:
        note_id = _locator_int(document.locator, "note_id")
        if note_id is None:
            return None
        note = get_note(conn, note_id)
        if note is None or note.id is None:
            return None
        return _note_hit(
            query,
            note,
            rank=rank,
            backend=RetrievalBackend.SEMANTIC,
            backend_score=backend_score,
        )
    if document.source_type == RetrievalSourceType.PROJECT:
        project_id = _locator_int(document.locator, "project_id")
        if project_id is None:
            return None
        project = get_project(conn, project_id)
        if project is None or project.id is None:
            return None
        return _project_hit(
            query,
            project,
            rank=rank,
            backend=RetrievalBackend.SEMANTIC,
            backend_score=backend_score,
        )
    if document.source_type == RetrievalSourceType.TASK:
        task_id = _locator_int(document.locator, "task_id")
        if task_id is None:
            return None
        task = get_todo(conn, task_id)
        if task is None or task.id is None:
            return None
        return _task_hit(
            query,
            task,
            rank=rank,
            backend=RetrievalBackend.SEMANTIC,
            backend_score=backend_score,
        )
    if document.source_type == RetrievalSourceType.LOG:
        log_entry_id = _locator_int(document.locator, "log_entry_id")
        if log_entry_id is None:
            return None
        entry = _get_log_entry(conn, log_entry_id)
        if entry is None:
            return None
        return _log_hit(
            query,
            entry,
            rank=rank,
            backend=RetrievalBackend.SEMANTIC,
            backend_score=backend_score,
        )
    if document.source_type == RetrievalSourceType.PDF_CHUNK:
        chunk_id = _locator_int(document.locator, "chunk_id")
        paper_id = _locator_int(document.locator, "paper_id")
        asset_id = _locator_int(document.locator, "asset_id")
        if chunk_id is None:
            return None
        chunk = _get_asset_text_chunk(conn, chunk_id)
        if chunk is None or chunk.id is None:
            return None
        if asset_id is not None and chunk.asset_id != asset_id:
            return None
        return _pdf_chunk_hit(
            query,
            chunk,
            paper_id=paper_id,
            rank=rank,
            backend=RetrievalBackend.SEMANTIC,
            backend_score=backend_score,
        )
    return None


def _paper_hit(
    query: RetrievalQuery,
    paper: Paper,
    *,
    rank: int,
    backend: RetrievalBackend = RetrievalBackend.LEXICAL,
    backend_score: float | None = None,
) -> RetrievalHit:
    assert paper.id is not None
    fields = (
        ("title", paper.title, 10.0),
        ("authors", ", ".join(paper.authors), 4.0),
        ("abstract", paper.abstract, 1.0),
    )
    return RetrievalHit(
        source_type=RetrievalSourceType.PAPER,
        source_id=str(paper.id),
        title=paper.title,
        snippet=_snippet(query, fields),
        score=_score(query, fields, rank=rank, backend=backend, backend_score=backend_score),
        locator=RetrievalEvidenceLocator(paper_id=paper.id),
        payload=paper,
    )


def _note_hit(
    query: RetrievalQuery,
    note: Note,
    *,
    rank: int,
    backend: RetrievalBackend = RetrievalBackend.LEXICAL,
    backend_score: float | None = None,
) -> RetrievalHit:
    assert note.id is not None
    fields = (("title", note.title, 8.0), ("body", note.search_body or note.body, 3.0))
    return RetrievalHit(
        source_type=RetrievalSourceType.NOTE,
        source_id=str(note.id),
        title=note.title,
        snippet=_snippet(query, fields),
        score=_score(query, fields, rank=rank, backend=backend, backend_score=backend_score),
        locator=RetrievalEvidenceLocator(note_id=note.id),
        payload=note,
    )


def _project_hit(
    query: RetrievalQuery,
    project: Project,
    *,
    rank: int,
    backend: RetrievalBackend = RetrievalBackend.LEXICAL,
    backend_score: float | None = None,
) -> RetrievalHit:
    assert project.id is not None
    fields = (
        ("name", project.name, 8.0),
        ("description", project.description or "", 3.0),
        ("tags", " ".join(project.tags), 2.0),
        ("status", project.status.value, 1.0),
    )
    return RetrievalHit(
        source_type=RetrievalSourceType.PROJECT,
        source_id=str(project.id),
        title=project.name,
        snippet=_snippet(query, fields),
        score=_score(query, fields, rank=rank, backend=backend, backend_score=backend_score),
        locator=RetrievalEvidenceLocator(project_id=project.id),
        payload=project,
    )


def _task_hit(
    query: RetrievalQuery,
    todo: Todo,
    *,
    rank: int,
    backend: RetrievalBackend = RetrievalBackend.LEXICAL,
    backend_score: float | None = None,
) -> RetrievalHit:
    assert todo.id is not None
    fields = (("title", todo.title, 8.0), ("description", todo.description, 2.0))
    return RetrievalHit(
        source_type=RetrievalSourceType.TASK,
        source_id=str(todo.id),
        title=todo.title,
        snippet=_snippet(query, fields),
        score=_score(query, fields, rank=rank, backend=backend, backend_score=backend_score),
        locator=RetrievalEvidenceLocator(task_id=todo.id),
        payload=todo,
    )


def _log_hit(
    query: RetrievalQuery,
    entry: LogEntry,
    *,
    rank: int,
    backend: RetrievalBackend = RetrievalBackend.LEXICAL,
    backend_score: float | None = None,
) -> RetrievalHit:
    display_text = format_log_entry_display_text(entry)
    fields = (
        ("title", entry.title, 5.0),
        ("body", entry.body_markdown, 2.0),
        ("entry", display_text, 1.0),
    )
    return RetrievalHit(
        source_type=RetrievalSourceType.LOG,
        source_id=str(entry.id),
        title=entry.title,
        snippet=_snippet(query, fields),
        score=_score(query, fields, rank=rank, backend=backend, backend_score=backend_score),
        locator=RetrievalEvidenceLocator(log_entry_id=entry.id),
        payload=entry,
    )


def _pdf_chunk_hit(
    query: RetrievalQuery,
    chunk: AssetTextChunk,
    *,
    paper_id: int | None,
    rank: int,
    backend: RetrievalBackend = RetrievalBackend.LEXICAL,
    backend_score: float | None = None,
) -> RetrievalHit:
    assert chunk.id is not None
    fields = (
        ("text", chunk.text, 1.0),
        ("page", f"page {chunk.page_number}", 0.5),
        ("section", " > ".join(chunk.section_path), 2.0),
    )
    return RetrievalHit(
        source_type=RetrievalSourceType.PDF_CHUNK,
        source_id=str(chunk.id) if paper_id is None else f"{paper_id}:{chunk.id}",
        title=f"PDF asset {chunk.asset_id} chunk {chunk.chunk_index}",
        snippet=_snippet(query, fields),
        score=_score(query, fields, rank=rank, backend=backend, backend_score=backend_score),
        locator=RetrievalEvidenceLocator(
            paper_id=paper_id,
            asset_id=chunk.asset_id,
            chunk_id=chunk.id,
            chunk_index=chunk.chunk_index,
            page_number=chunk.page_number,
            section_path=tuple(chunk.section_path),
            bbox=tuple(chunk.bbox) if chunk.bbox is not None else None,
            block_ids=tuple(chunk.block_ids),
        ),
        payload=chunk,
    )


def _score(
    query: RetrievalQuery,
    fields: Iterable[tuple[str, str, float]],
    *,
    rank: int,
    backend: RetrievalBackend = RetrievalBackend.LEXICAL,
    backend_score: float | None = None,
) -> RetrievalScoreMetadata:
    field_scores = _field_scores(query, fields)
    finite_backend_score = _finite_score(backend_score)
    normalized_score = _normalized_backend_score(
        finite_backend_score,
        fallback=_rank_score(rank),
    ) if backend == RetrievalBackend.SEMANTIC else _rank_score(rank)
    return RetrievalScoreMetadata(
        backend=backend,
        rank=rank,
        normalized_score=normalized_score,
        fusion_score=normalized_score,
        backend_score=finite_backend_score,
        field_scores=field_scores,
        field_matches=_matching_fields(field_scores),
        contributing_backends=(backend,),
    )


def _threshold_semantic_hits(hits: list[RetrievalHit], *, limit: int) -> list[RetrievalHit]:
    if not hits:
        return []
    top_score = max(hit.score.normalized_score for hit in hits)
    threshold = max(
        SEMANTIC_ABSOLUTE_SCORE_THRESHOLD,
        top_score * SEMANTIC_RELATIVE_SCORE_THRESHOLD,
    )
    filtered = [
        hit
        for hit in hits
        if hit.score.normalized_score >= threshold
    ][:limit]
    return [
        _replace_hit_rank(hit, rank)
        for rank, hit in enumerate(filtered, start=1)
    ]


def _replace_hit_rank(hit: RetrievalHit, rank: int) -> RetrievalHit:
    return replace(
        hit,
        score=replace(
            hit.score,
            rank=rank,
            fusion_score=hit.score.normalized_score,
        ),
    )


def _normalized_backend_score(score: float | None, *, fallback: float) -> float:
    if score is None:
        return fallback
    return round(max(0.0, min(1.0, score)), 12)


def _finite_score(score: float | None) -> float | None:
    if score is None or not math.isfinite(score):
        return None
    return score


def _field_scores(
    query: RetrievalQuery,
    fields: Iterable[tuple[str, str, float]],
) -> tuple[RetrievalFieldScore, ...]:
    scores: list[RetrievalFieldScore] = []
    term_count = max(1, len(query.terms))
    for field, text, weight in fields:
        term_scores = [
            (term, _lexical_term_match_score(term, text or ""))
            for term in query.terms
            if term
        ]
        matched_terms = tuple(term for term, score in term_scores if score > 0)
        rank_hint = (sum(score for _term, score in term_scores) / term_count) * weight
        scores.append(
            RetrievalFieldScore(
                field=field,
                matched_terms=matched_terms,
                weight=weight,
                rank_hint=round(rank_hint, 6),
            )
        )
    return tuple(scores)


def _matching_fields(field_scores: Iterable[RetrievalFieldScore]) -> tuple[str, ...]:
    matches: list[str] = []
    for field_score in field_scores:
        if field_score.matched_terms:
            matches.append(field_score.field)
    return tuple(matches)


def _snippet(
    query: RetrievalQuery,
    fields: Iterable[tuple[str, str, float]],
    *,
    max_chars: int = 240,
) -> RetrievalSnippet:
    fallback: tuple[str, str] | None = None
    for field, text, _weight in fields:
        if not text:
            continue
        if fallback is None:
            fallback = (field, text)
        match_index = _first_match_index(query, text)
        if match_index >= 0:
            return _trim_snippet(text, field=field, match_index=match_index, max_chars=max_chars)

    if fallback is None:
        return RetrievalSnippet(text="", field="", start_char=0, end_char=0, truncated=False)
    field, text = fallback
    return _trim_snippet(text, field=field, match_index=0, max_chars=max_chars)


def _first_match_index(query: RetrievalQuery, text: str) -> int:
    lowered = text.casefold()
    indexes = [lowered.find(term) for term in query.terms if term]
    matches = [index for index in indexes if index >= 0]
    if matches:
        return min(matches)
    token_matches = [
        _token_match_index(term, text)
        for term in query.terms
        if term
    ]
    matches = [index for index in token_matches if index >= 0]
    return min(matches) if matches else -1


def _token_match_index(term: str, text: str) -> int:
    for match in re.finditer(r"\w+", text, flags=re.UNICODE):
        token = match.group(0)
        if _lexical_term_match_score(term, token) > 0:
            return match.start()
    return -1


def _trim_snippet(
    text: str,
    *,
    field: str,
    match_index: int,
    max_chars: int,
) -> RetrievalSnippet:
    if len(text) <= max_chars:
        return RetrievalSnippet(
            text=text,
            field=field,
            start_char=0,
            end_char=len(text),
            truncated=False,
        )

    half_window = max_chars // 2
    start = max(0, match_index - half_window)
    end = min(len(text), start + max_chars)
    if end - start < max_chars:
        start = max(0, end - max_chars)
    snippet = text[start:end].strip()
    if start > 0:
        snippet = f"...{snippet}"
    if end < len(text):
        snippet = f"{snippet}..."
    return RetrievalSnippet(
        text=snippet,
        field=field,
        start_char=start,
        end_char=end,
        truncated=True,
    )


def _rank_score(rank: int) -> float:
    return round(1.0 / (FUSION_RANK_OFFSET + max(1, rank)), 12)


def _primary_sort_key(hit: RetrievalHit) -> tuple[float, int, int, str]:
    source_order = FUSION_SOURCE_ORDER.get(hit.source_type, len(FUSION_SOURCE_ORDER))
    return (
        -(hit.score.normalized_score or _rank_score(hit.score.rank)),
        source_order,
        hit.score.rank,
        hit.source_id,
    )


def _fusion_sort_key(hit: RetrievalHit) -> tuple[float, int, int, str]:
    source_order = FUSION_SOURCE_ORDER.get(hit.source_type, len(FUSION_SOURCE_ORDER))
    return (
        -hit.score.fusion_score,
        source_order,
        hit.score.rank,
        hit.source_id,
    )


def _search_project_papers(
    conn: sqlite3.Connection,
    query: str,
    *,
    project_id: int,
    limit: int,
    include_dismissed: bool,
) -> list[Paper]:
    visibility_filter = "" if include_dismissed else "AND p.status != 'dismissed'"
    rows = _rank_fts_rows(
        query,
        limit=limit,
        fetch_rows=lambda fts_query, pool_limit: conn.execute(
            """
            SELECT p.*
            FROM papers_fts
            JOIN papers p ON p.id = papers_fts.rowid
            JOIN project_papers pp ON pp.paper_id = p.id
            WHERE papers_fts MATCH ?
              AND pp.project_id=?
              {visibility_filter}
            ORDER BY
                bm25(papers_fts, 10.0, 1.0, 4.0),
                p.relevance_score DESC NULLS LAST,
                p.published_date DESC
            LIMIT ?
            """.format(visibility_filter=visibility_filter),
            (fts_query, project_id, pool_limit),
        ).fetchall(),
        fields=lambda row: (
            (row["title"] or "", 10.0),
            (row["abstract"] or "", 4.0),
            (row["authors"] or "", 1.0),
        ),
    )
    return _hydrate_papers_with_projects(conn, rows)


def _search_scoped_notes(
    conn: sqlite3.Connection,
    query: str,
    *,
    paper_id: int | None,
    project_id: int | None,
    limit: int,
) -> list[Note]:
    joins: list[str] = []
    where = ["notes_fts MATCH ?"]
    params: list[object] = []
    if paper_id is not None or project_id is not None:
        joins.append("JOIN note_papers np_scope ON np_scope.note_id = n.id")
    if paper_id is not None:
        where.append("np_scope.paper_id=?")
        params.append(paper_id)
    if project_id is not None:
        joins.append("JOIN project_papers pp_scope ON pp_scope.paper_id = np_scope.paper_id")
        where.append("pp_scope.project_id=?")
        params.append(project_id)
    rows = _rank_fts_rows(
        query,
        limit=limit,
        fetch_rows=lambda fts_query, pool_limit: conn.execute(
            f"""
            SELECT DISTINCT n.*
            FROM notes_fts
            JOIN notes n ON n.id = notes_fts.rowid
            {' '.join(joins)}
            WHERE {' AND '.join(where)}
            ORDER BY
                bm25(notes_fts, 8.0, 3.0),
                n.updated_at DESC,
                n.id DESC
            LIMIT ?
            """,
            [fts_query, *params, pool_limit],
        ).fetchall(),
        fields=lambda row: (
            (row["title"] or "", 8.0),
            (row["search_body"] or row["body"] or "", 3.0),
        ),
    )
    return _hydrate_notes(conn, rows)


def _search_project_todos(
    conn: sqlite3.Connection,
    query: str,
    *,
    project_id: int,
    limit: int,
) -> list[Todo]:
    rows = _rank_fts_rows(
        query,
        limit=limit,
        fetch_rows=lambda fts_query, pool_limit: conn.execute(
            """
            SELECT t.*
            FROM todos_fts
            JOIN todos t ON t.id = todos_fts.rowid
            JOIN project_todos pt ON pt.todo_id = t.id
            WHERE todos_fts MATCH ?
              AND pt.project_id=?
            ORDER BY
                bm25(todos_fts, 8.0, 2.0),
                CASE WHEN t.status = 'open' THEN 0 ELSE 1 END,
                t.created_at DESC
            LIMIT ?
            """,
            (fts_query, project_id, pool_limit),
        ).fetchall(),
        fields=lambda row: (
            (row["title"] or "", 8.0),
            (row["description"] or "", 2.0),
        ),
    )
    project_map = _load_project_link_map(
        conn,
        join_table="project_todos",
        item_column="todo_id",
        item_ids=[int(row["id"]) for row in rows],
    )
    return [_row_to_todo(row, project_map.get(int(row["id"]), [])) for row in rows]


def _get_log_entry(conn: sqlite3.Connection, log_entry_id: int) -> LogEntry | None:
    for entry in list_log_entries(conn, days=None):
        if entry.id == log_entry_id:
            return entry
    return None


def _search_scoped_pdf_chunks(
    conn: sqlite3.Connection,
    query: str,
    *,
    asset_id: int | None,
    paper_id: int | None,
    project_id: int | None,
    limit: int,
) -> list[tuple[AssetTextChunk, int | None]]:
    if asset_id is not None and paper_id is None and project_id is None:
        return [
            (chunk, None)
            for chunk in search_asset_text_chunks(conn, asset_id, query, limit=limit)
        ]

    joins: list[str] = [
        "JOIN asset_text_chunks c ON c.id = asset_text_chunks_fts.rowid",
        "JOIN paper_assets pa ON pa.asset_id = c.asset_id",
    ]
    where = ["asset_text_chunks_fts MATCH ?"]
    params: list[object] = []
    if asset_id is not None:
        where.append("c.asset_id=?")
        params.append(asset_id)
    if paper_id is not None:
        where.append("pa.paper_id=?")
        params.append(paper_id)
    if project_id is not None:
        joins.append("JOIN project_papers pp ON pp.paper_id = pa.paper_id")
        where.append("pp.project_id=?")
        params.append(project_id)
    rows = _rank_fts_rows(
        query,
        limit=limit,
        fetch_rows=lambda fts_query, pool_limit: conn.execute(
            """
            SELECT c.*, pa.paper_id AS retrieval_paper_id
            FROM asset_text_chunks_fts
            {joins}
            WHERE {where}
            ORDER BY bm25(asset_text_chunks_fts), c.asset_id ASC, c.chunk_index ASC, pa.paper_id ASC
            LIMIT ?
            """.format(
                joins="\n        ".join(joins),
                where=" AND ".join(where),
            ),
            [fts_query, *params, max(1, pool_limit)],
        ).fetchall(),
        fields=lambda row: ((row["text"] or "", 1.0),),
        key=lambda row: (row["id"], row["retrieval_paper_id"]),
    )
    return [(_row_to_asset_text_chunk(row), int(row["retrieval_paper_id"])) for row in rows]


def _semantic_hit_matches_scope(conn: sqlite3.Connection, document, scope: RetrievalScope) -> bool:
    if document.source_type == RetrievalSourceType.PAPER:
        paper_id = _locator_int(document.locator, "paper_id")
        if paper_id is None:
            return False
        if scope.paper_id is not None and paper_id != scope.paper_id:
            return False
        if scope.project_id is not None and not _paper_in_project(conn, paper_id, scope.project_id):
            return False
        return True
    if document.source_type == RetrievalSourceType.NOTE:
        note_id = _locator_int(document.locator, "note_id")
        if note_id is None:
            return False
        return _note_matches_scope(
            conn,
            note_id,
            paper_id=scope.paper_id,
            project_id=scope.project_id,
        )
    if document.source_type == RetrievalSourceType.PROJECT:
        project_id = _locator_int(document.locator, "project_id")
        if project_id is None:
            return False
        if scope.paper_id is not None or scope.asset_id is not None:
            return False
        return scope.project_id is None or project_id == scope.project_id
    if document.source_type == RetrievalSourceType.TASK:
        task_id = _locator_int(document.locator, "task_id")
        if task_id is None:
            return False
        if scope.paper_id is not None or scope.asset_id is not None:
            return False
        if scope.project_id is None:
            return True
        task = get_todo(conn, task_id)
        return task is not None and scope.project_id in task.project_ids
    if document.source_type == RetrievalSourceType.LOG:
        log_entry_id = _locator_int(document.locator, "log_entry_id")
        if log_entry_id is None:
            return False
        if scope.paper_id is not None or scope.asset_id is not None:
            return False
        if scope.project_id is None:
            return True
        entry = _get_log_entry(conn, log_entry_id)
        return entry is not None and scope.project_id in entry.project_ids
    if document.source_type == RetrievalSourceType.PDF_CHUNK:
        paper_id = _locator_int(document.locator, "paper_id")
        asset_id = _locator_int(document.locator, "asset_id")
        if paper_id is None or asset_id is None:
            return False
        if not _asset_linked_to_paper(conn, asset_id, paper_id):
            return False
        if scope.asset_id is not None and asset_id != scope.asset_id:
            return False
        if scope.paper_id is not None and paper_id != scope.paper_id:
            return False
        if scope.project_id is not None:
            if paper_id is None or not _paper_in_project(conn, paper_id, scope.project_id):
                return False
        return True
    return False


def _paper_in_project(conn: sqlite3.Connection, paper_id: int, project_id: int) -> bool:
    return conn.execute(
        """
        SELECT 1
        FROM project_papers
        WHERE paper_id=? AND project_id=?
        LIMIT 1
        """,
        (paper_id, project_id),
    ).fetchone() is not None


def _asset_linked_to_paper(conn: sqlite3.Connection, asset_id: int, paper_id: int) -> bool:
    return conn.execute(
        """
        SELECT 1
        FROM paper_assets
        WHERE asset_id=? AND paper_id=?
        LIMIT 1
        """,
        (asset_id, paper_id),
    ).fetchone() is not None


def _note_matches_scope(
    conn: sqlite3.Connection,
    note_id: int,
    *,
    paper_id: int | None,
    project_id: int | None,
) -> bool:
    if paper_id is None and project_id is None:
        return True
    joins: list[str] = ["note_papers np"]
    where = ["np.note_id=?"]
    params: list[object] = [note_id]
    if paper_id is not None:
        where.append("np.paper_id=?")
        params.append(paper_id)
    if project_id is not None:
        joins.append("JOIN project_papers pp ON pp.paper_id = np.paper_id")
        where.append("pp.project_id=?")
        params.append(project_id)
    return conn.execute(
        """
        SELECT 1
        FROM {joins}
        WHERE {where}
        LIMIT 1
        """.format(
            joins=" ".join(joins),
            where=" AND ".join(where),
        ),
        params,
    ).fetchone() is not None


def _get_asset_text_chunk(conn: sqlite3.Connection, chunk_id: int) -> AssetTextChunk | None:
    row = conn.execute(
        "SELECT * FROM asset_text_chunks WHERE id=?",
        (chunk_id,),
    ).fetchone()
    return _row_to_asset_text_chunk(row) if row is not None else None


def _locator_int(locator: dict, key: str) -> int | None:
    value = locator.get(key)
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _row_to_asset_text_chunk(row: sqlite3.Row) -> AssetTextChunk:
    from claudesk.core.db.assets import _row_to_asset_text_chunk as hydrate

    return hydrate(row)
