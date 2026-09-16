from __future__ import annotations

from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from claudesk.api.deps import get_conn
from claudesk.core.db.tasks import (
    delete_manual_log_entry as db_delete_manual_log_entry,
    list_log_entries,
)
from claudesk.core.retrieval import (
    RetrievalRequest,
    RetrievalSourceType,
    retrieve,
    retrieval_backends_from_mode,
)
from claudesk.core.task_log_workflows import (
    create_manual_log_from_text,
    update_manual_log_from_text,
)

router = APIRouter()


class CreateLogEntry(BaseModel):
    entry: str
    project_ids: list[int] = Field(default_factory=list)
    entry_date: Optional[date] = None


class UpdateLogEntry(BaseModel):
    entry: str
    project_ids: Optional[list[int]] = None
    entry_date: Optional[date] = None


def _matched_log_entries(
    conn,
    *,
    query: str | None,
    backend: str,
    project_id: int | None,
    days: int | None,
    entry_type: str | None,
) -> list | None:
    if entry_type not in (None, "manual", "task"):
        raise ValueError(f"Unsupported log entry type: {entry_type}")
    if not query or not query.strip():
        return None
    try:
        backends = retrieval_backends_from_mode(backend)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    request = RetrievalRequest.from_text(
        query,
        source_types=(RetrievalSourceType.LOG,),
        project_id=project_id,
        limit_per_source=500,
        backends=backends,
    )
    if request.query.is_empty:
        return None
    results = retrieve(conn, request)
    entries = [
        hit.payload
        for hit in results.hits_for(RetrievalSourceType.LOG)
        if hit.locator.log_entry_id is not None
    ]
    if entry_type is not None:
        entries = [entry for entry in entries if entry.entry_type == entry_type]
    if days is not None:
        since = date.today() - timedelta(days=days)
        entries = [entry for entry in entries if entry.entry_date >= since]
    return entries


@router.get("/log")
def get_log_entries(
    days: Optional[int] = 30,
    project_id: Optional[int] = None,
    entry_type: Optional[str] = None,
    q: Optional[str] = None,
    backend: str = "lexical",
    conn=Depends(get_conn),
):
    try:
        # Pane-local search sends days=0 with q to search all history while
        # browse keeps the existing date-window semantics.
        search_query_active = q is not None and bool(q.strip())
        effective_days = None if search_query_active and days is not None and days <= 0 else days
        matched_entries = _matched_log_entries(
            conn,
            query=q,
            backend=backend,
            project_id=project_id,
            days=effective_days,
            entry_type=entry_type,
        )
        entries = (
            matched_entries
            if matched_entries is not None
            else list_log_entries(
                conn,
                days=effective_days,
                project_id=project_id,
                entry_type=entry_type,
            )
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return [entry.model_dump() for entry in entries]


@router.post("/log/manual")
def create_manual_log_entry(body: CreateLogEntry, conn=Depends(get_conn)):
    result = create_manual_log_from_text(
        conn,
        entry=body.entry,
        project_ids=body.project_ids,
        entry_date=body.entry_date or date.today(),
    )
    conn.commit()
    return {"id": result.entry_id}


@router.patch("/log/manual/{entry_id}")
def update_manual_log_entry(entry_id: int, body: UpdateLogEntry, conn=Depends(get_conn)):
    try:
        update_manual_log_from_text(
            conn,
            entry_id,
            entry=body.entry,
            project_ids=body.project_ids,
            entry_date=body.entry_date,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    conn.commit()
    return {"ok": True}


@router.delete("/log/manual/{entry_id}")
def delete_manual_log_entry(entry_id: int, conn=Depends(get_conn)):
    try:
        db_delete_manual_log_entry(conn, entry_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    conn.commit()
    return {"ok": True}
