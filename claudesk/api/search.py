from __future__ import annotations

import logging
import threading
import importlib
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from claudesk.api.deps import get_conn
from claudesk.core.db import get_connection
from claudesk.core.db.assets import get_paper_asset
from claudesk.core.db.papers import get_paper
from claudesk.core.retrieval import (
    RetrievalHit,
    RetrievalRequest,
    RetrievalSourceType,
    retrieve,
    retrieval_backends_from_mode,
)

if TYPE_CHECKING:
    from claudesk.core.retrieval.vector import SemanticIndexStatus

router = APIRouter()
logger = logging.getLogger(__name__)
SEMANTIC_INDEX_JOB_ERROR = "Semantic index rebuild failed. Check server logs for details."


def _utcnow() -> str:
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat()


class SemanticIndexState(BaseModel):
    state: Literal["missing", "stale", "incompatible", "rebuilding", "ready", "failed"]
    running: bool
    started_at: str | None = None
    finished_at: str | None = None
    last_error: str | None = None
    source_count: int
    indexed_count: int
    missing_count: int
    stale_count: int
    incompatible_count: int
    launch_state: str | None = Field(default=None, exclude=True)


@dataclass
class _SemanticIndexJobState:
    running: bool = False
    started_at: str | None = None
    finished_at: str | None = None
    last_error: str | None = None
    cached_status: SemanticIndexStatus | None = None


_semantic_index_state = _SemanticIndexJobState()
_semantic_index_state_lock = threading.Lock()
_semantic_index_thread: threading.Thread | None = None

SEARCH_TYPE_SOURCES = {
    "all": (
        RetrievalSourceType.PAPER,
        RetrievalSourceType.NOTE,
        RetrievalSourceType.PROJECT,
        RetrievalSourceType.TASK,
        RetrievalSourceType.LOG,
    ),
    "papers": (RetrievalSourceType.PAPER,),
    "notes": (RetrievalSourceType.NOTE,),
    "projects": (RetrievalSourceType.PROJECT,),
    "tasks": (RetrievalSourceType.TASK,),
    "log": (RetrievalSourceType.LOG,),
    "pdfs": (RetrievalSourceType.PDF_CHUNK,),
}


def _semantic_index_product_state(
    status: SemanticIndexStatus,
    *,
    running: bool,
    last_error: str | None,
) -> Literal["missing", "stale", "incompatible", "rebuilding", "ready", "failed"]:
    if running:
        return "rebuilding"
    if last_error:
        return "failed"
    if status.incompatible_count > 0:
        return "incompatible"
    if status.missing_count > 0:
        return "missing"
    if status.stale_count > 0:
        return "stale"
    return "ready"


def _empty_semantic_index_status() -> SemanticIndexStatus:
    vector = _semantic_vector()
    return vector.SemanticIndexStatus(
        index_path=vector.semantic_index_path(),
        table_name=vector.TABLE_NAME,
        source_count=0,
        indexed_count=0,
        missing_count=0,
        stale_count=0,
        incompatible_count=0,
    )


def _semantic_vector():
    return importlib.import_module("claudesk.core.retrieval.vector")


def _semantic_index_snapshot(
    conn,
    *,
    launch_state: str | None = None,
    use_cached: bool = False,
) -> SemanticIndexState:
    with _semantic_index_state_lock:
        running = _semantic_index_state.running
        started_at = _semantic_index_state.started_at
        finished_at = _semantic_index_state.finished_at
        last_error = _semantic_index_state.last_error
        cached_status = _semantic_index_state.cached_status

    if running or use_cached:
        status = cached_status or _empty_semantic_index_status()
    else:
        status = _semantic_vector().semantic_index_status(conn)
        with _semantic_index_state_lock:
            _semantic_index_state.cached_status = status
    return SemanticIndexState(
        state=_semantic_index_product_state(status, running=running, last_error=last_error),
        running=running,
        started_at=started_at,
        finished_at=finished_at,
        last_error=last_error,
        source_count=status.source_count,
        indexed_count=status.indexed_count,
        missing_count=status.missing_count,
        stale_count=status.stale_count,
        incompatible_count=status.incompatible_count,
        launch_state=launch_state,
    )


def _run_semantic_index_job(action: str) -> None:
    global _semantic_index_thread
    conn = None
    try:
        conn = get_connection()
        vector = _semantic_vector()
        if action == "update":
            status = vector.update_semantic_index(conn)
        else:
            status = vector.rebuild_semantic_index(conn)
        with _semantic_index_state_lock:
            _semantic_index_state.running = False
            _semantic_index_state.finished_at = _utcnow()
            _semantic_index_state.last_error = None
            _semantic_index_state.cached_status = status
    except Exception:
        logger.exception("Semantic index %s job failed", action)
        with _semantic_index_state_lock:
            _semantic_index_state.running = False
            _semantic_index_state.finished_at = _utcnow()
            _semantic_index_state.last_error = SEMANTIC_INDEX_JOB_ERROR
    finally:
        if conn is not None:
            conn.close()
        with _semantic_index_state_lock:
            _semantic_index_thread = None


def _start_semantic_index_job(action: str) -> None:
    global _semantic_index_thread
    thread = threading.Thread(target=_run_semantic_index_job, args=(action,), daemon=True)
    with _semantic_index_state_lock:
        _semantic_index_thread = thread
    thread.start()


def _launch_semantic_index_job(action: Literal["rebuild", "update"], conn) -> SemanticIndexState:
    with _semantic_index_state_lock:
        needs_cached_status = _semantic_index_state.cached_status is None and not _semantic_index_state.running
    cached_status = _semantic_vector().semantic_index_status(conn) if needs_cached_status else None
    with _semantic_index_state_lock:
        if _semantic_index_state.running:
            launch_state = "already_running"
        else:
            if cached_status is not None:
                _semantic_index_state.cached_status = cached_status
            _semantic_index_state.running = True
            _semantic_index_state.started_at = _utcnow()
            _semantic_index_state.finished_at = None
            _semantic_index_state.last_error = None
            launch_state = "started"
    if launch_state == "started":
        try:
            _start_semantic_index_job(action)
        except Exception:
            logger.exception("Failed to start semantic index %s job", action)
            with _semantic_index_state_lock:
                _semantic_index_state.running = False
                _semantic_index_state.finished_at = _utcnow()
                _semantic_index_state.last_error = SEMANTIC_INDEX_JOB_ERROR
    return _semantic_index_snapshot(conn, launch_state=launch_state, use_cached=launch_state == "started")


def shutdown_semantic_index_job() -> None:
    with _semantic_index_state_lock:
        thread = _semantic_index_thread
    if thread is not None and thread.is_alive():
        thread.join(timeout=1)


def _source_types_for_search_type(
    search_type: str | list[str] | tuple[str, ...] | None,
) -> tuple[RetrievalSourceType, ...]:
    raw_types: list[str]
    if search_type is None:
        raw_types = ["all"]
    elif isinstance(search_type, str):
        raw_types = [search_type]
    else:
        raw_types = list(search_type) or ["all"]

    source_types: list[RetrievalSourceType] = []
    for raw_type in raw_types:
        normalized = (raw_type or "all").strip().casefold()
        try:
            source_types.extend(SEARCH_TYPE_SOURCES[normalized])
        except KeyError as exc:
            raise ValueError(
                "Search type must be 'all', 'papers', 'notes', 'projects', 'tasks', 'log', or 'pdfs'."
            ) from exc
    return tuple(dict.fromkeys(source_types))


def _empty_search_payload(*, include_pdfs: bool = False) -> dict:
    payload = {"papers": [], "notes": [], "projects": [], "tasks": [], "log": []}
    if include_pdfs:
        payload["pdfs"] = []
    return payload


def _pdf_result_payload(conn, hit: RetrievalHit) -> dict:
    locator = hit.locator
    asset = (
        get_paper_asset(conn, locator.paper_id, locator.asset_id)
        if locator.paper_id is not None and locator.asset_id is not None
        else None
    )
    paper = get_paper(conn, locator.paper_id) if locator.paper_id is not None else None
    return {
        "paper_id": locator.paper_id,
        "paper_title": paper.title if paper is not None else "",
        "asset_id": locator.asset_id,
        "asset_display_name": asset.display_name if asset is not None else None,
        "chunk_id": locator.chunk_id,
        "chunk_index": locator.chunk_index,
        "page_number": locator.page_number,
        "section_path": list(locator.section_path),
        "bbox": list(locator.bbox) if locator.bbox is not None else None,
        "block_ids": list(locator.block_ids),
        "snippet": hit.snippet.text,
        "snippet_field": hit.snippet.field,
        "snippet_start_char": hit.snippet.start_char,
        "snippet_end_char": hit.snippet.end_char,
        "snippet_truncated": hit.snippet.truncated,
    }


@router.get("/search")
def search(
    q: str = "",
    include_dismissed: bool = False,
    backend: str = "lexical",
    result_type: Annotated[list[str] | None, Query(alias="type")] = None,
    limit: int = 50,
    conn=Depends(get_conn),
):
    try:
        backends = retrieval_backends_from_mode(backend)
        source_types = _source_types_for_search_type(result_type)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    include_pdfs = RetrievalSourceType.PDF_CHUNK in source_types
    request = RetrievalRequest.from_text(
        q,
        source_types=source_types,
        include_dismissed=include_dismissed,
        limit_per_source=min(max(1, limit), 500),
        backends=backends,
    )
    if request.query.is_empty:
        return _empty_search_payload(include_pdfs=include_pdfs)
    results = retrieve(conn, request)
    papers = [
        hit.payload.model_dump(exclude={"embedding"})
        for hit in results.hits_for(RetrievalSourceType.PAPER)
    ]
    notes = [hit.payload.model_dump() for hit in results.hits_for(RetrievalSourceType.NOTE)]
    projects = [hit.payload.model_dump() for hit in results.hits_for(RetrievalSourceType.PROJECT)]
    tasks = [hit.payload.model_dump() for hit in results.hits_for(RetrievalSourceType.TASK)]
    entries = [hit.payload.model_dump() for hit in results.hits_for(RetrievalSourceType.LOG)]
    payload = {"papers": papers, "notes": notes, "projects": projects, "tasks": tasks, "log": entries}
    if include_pdfs:
        payload["pdfs"] = [
            _pdf_result_payload(conn, hit)
            for hit in results.hits_for(RetrievalSourceType.PDF_CHUNK)
        ]
    return payload


@router.get("/search/semantic-index/status", response_model=SemanticIndexState)
def semantic_index_status(conn=Depends(get_conn)):
    return _semantic_index_snapshot(conn)


@router.post("/search/semantic-index/rebuild", response_model=SemanticIndexState)
def rebuild_semantic_index_api(conn=Depends(get_conn)):
    return _launch_semantic_index_job("rebuild", conn)


@router.post("/search/semantic-index/update", response_model=SemanticIndexState)
def update_semantic_index_api(conn=Depends(get_conn)):
    return _launch_semantic_index_job("update", conn)
