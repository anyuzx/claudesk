from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import ExitStack
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from claudesk.api.deps import get_conn
from claudesk.api.process_jobs import (
    ProcessJobHandle,
    collect_process_job,
    start_process_job,
)
from claudesk.core.db import get_connection, init_db
from claudesk.core.db.jobs import (
    ACTIVE_JOB_STATUSES,
    BackgroundJob,
    append_job_event,
    create_job,
    default_machine_id,
    get_active_job_by_kind_dedupe_key,
    get_job,
    get_latest_job_by_kind,
    list_job_failures,
    mark_job_cancelled,
    mark_job_failed,
    mark_job_running,
    mark_job_succeeded,
    request_job_cancel,
    reserve_job_attempt,
)

router = APIRouter()
DIGEST_JOB_KIND = "digest_run"
DIGEST_DEDUPE_KEY = "digest_run"


class DigestRunSummary(BaseModel):
    created_at: str
    sources: list[str]
    days_back: int
    total_fetched: int
    total_after_dedup: int
    total_in_digest: int
    total_new_papers: int
    wrote_to_db: bool


class DigestSourceProgress(BaseModel):
    name: str
    status: str
    fetched: Optional[int] = None
    target: Optional[int] = None
    error: Optional[str] = None


class DigestRunProgress(BaseModel):
    phase: Optional[str] = None
    message: Optional[str] = None
    current_source: Optional[str] = None
    sources: list[DigestSourceProgress] = Field(default_factory=list)
    source_count: Optional[int] = None
    sources_completed: Optional[int] = None
    total_fetched: Optional[int] = None
    total_fetch_target: Optional[int] = None
    total_after_dedup: Optional[int] = None
    total_in_digest: Optional[int] = None


class DigestRunState(BaseModel):
    running: bool
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    last_error: Optional[str] = None
    progress: Optional[DigestRunProgress] = None
    last_result: Optional[DigestRunSummary] = None
    launch_state: Optional[str] = Field(default=None, exclude=True)


_active_lock = threading.Lock()
_active_jobs: dict[int, ProcessJobHandle] = {}


def _latest_digest_run_summary(
    conn: sqlite3.Connection,
) -> tuple[Optional[str], Optional[dict[str, object]]]:
    row = conn.execute(
        """
        SELECT
            created_at,
            days_back,
            sources_json,
            total_fetched,
            total_after_dedup,
            total_in_digest,
            total_new_papers
        FROM digest_runs
        ORDER BY id DESC
        LIMIT 1
        """
    ).fetchone()
    if row is None:
        return None, None

    try:
        decoded_sources = json.loads(row["sources_json"] or "[]")
    except json.JSONDecodeError:
        decoded_sources = []
    sources = [
        str(source)
        for source in decoded_sources
        if isinstance(source, str) and source.strip()
    ] if isinstance(decoded_sources, list) else []

    return row["created_at"], {
        "created_at": row["created_at"],
        "sources": sources,
        "days_back": int(row["days_back"] or 0),
        "total_fetched": int(row["total_fetched"] or 0),
        "total_after_dedup": int(row["total_after_dedup"] or 0),
        "total_in_digest": int(row["total_in_digest"] or 0),
        "total_new_papers": int(row["total_new_papers"] or 0),
        "wrote_to_db": True,
    }


def _snapshot_state(
    conn: sqlite3.Connection,
    *,
    launch_state: Optional[str] = None,
    job: BackgroundJob | None = None,
) -> DigestRunState:
    if job is not None:
        job = get_job(conn, job.id) or job
    active_job = job or get_active_job_by_kind_dedupe_key(
        conn,
        DIGEST_JOB_KIND,
        DIGEST_DEDUPE_KEY,
    )
    latest_job = active_job or get_latest_job_by_kind(conn, DIGEST_JOB_KIND)

    running = active_job is not None and active_job.status in ACTIVE_JOB_STATUSES
    started_at = None
    finished_at = None
    last_error = None
    progress: dict[str, object] | None = None

    if latest_job is not None:
        started_at = latest_job.started_at or (latest_job.created_at if running else None)
        finished_at = latest_job.finished_at
        progress = dict(latest_job.latest_progress or {})
        if latest_job.status == "failed":
            failures = list_job_failures(conn, latest_job.id)
            if failures:
                last_error = failures[-1].message

    persisted_finished_at, persisted_result = _latest_digest_run_summary(conn)
    last_result = persisted_result
    if not running and finished_at is None and last_error is None:
        finished_at = persisted_finished_at

    return DigestRunState(
        running=running,
        started_at=started_at,
        finished_at=finished_at,
        last_error=last_error,
        progress=DigestRunProgress(**progress) if progress else None,
        last_result=DigestRunSummary(**last_result) if last_result else None,
        launch_state=launch_state,
    )


def _initial_digest_progress() -> dict[str, object]:
    return {
        "phase": "starting",
        "message": "Starting digest run…",
        "current_source": None,
        "sources": [],
        "source_count": None,
        "sources_completed": 0,
        "total_fetched": 0,
        "total_fetch_target": None,
        "total_after_dedup": None,
        "total_in_digest": None,
    }


def _cancelled_progress(current: dict[str, object] | None = None) -> dict[str, object]:
    progress = dict(current or {})
    progress.update(
        {
            "phase": "cancelled",
            "message": "Digest fetch stopped.",
            "current_source": None,
        }
    )
    return progress


def _success_progress(
    result: dict[str, object],
    current: dict[str, object] | None = None,
) -> dict[str, object]:
    progress = dict(current or {})
    sources = result.get("sources")
    source_count = (
        len(sources)
        if isinstance(sources, list)
        else progress.get("source_count")
    )
    total_in_digest = result.get("total_in_digest", 0)
    progress.update(
        {
            "phase": "done",
            "message": (
                f"Digest updated with {total_in_digest} papers."
                if result.get("wrote_to_db")
                else f"Digest run completed with {total_in_digest} papers."
            ),
            "current_source": None,
            "source_count": source_count,
            "sources_completed": source_count,
            "total_fetched": result.get("total_fetched"),
            "total_after_dedup": result.get("total_after_dedup"),
            "total_in_digest": total_in_digest,
        }
    )
    return progress


def _error_progress(
    message: str,
    current: dict[str, object] | None = None,
) -> dict[str, object]:
    progress = dict(current or {})
    progress.update(
        {
            "phase": "error",
            "message": message,
            "current_source": None,
        }
    )
    return progress


def _cancelling_progress(current: dict[str, object] | None = None) -> dict[str, object]:
    progress = dict(current or {})
    progress.update(
        {
            "phase": "cancelling",
            "message": "Stopping digest fetch...",
            "current_source": None,
        }
    )
    return progress


def _progress_numbers(progress: dict[str, object]) -> tuple[float | None, float | None]:
    current = progress.get("sources_completed")
    total = progress.get("source_count")
    if current is None:
        current = progress.get("total_fetched")
        total = progress.get("total_fetch_target")
    try:
        current_number = float(current) if current is not None else None
    except (TypeError, ValueError):
        current_number = None
    try:
        total_number = float(total) if total is not None else None
    except (TypeError, ValueError):
        total_number = None
    return current_number, total_number


def _terminate_digest_handle(handle: ProcessJobHandle) -> bool:
    process = getattr(handle, "process", None)
    is_alive = getattr(process, "is_alive", None)
    if callable(is_alive) and not is_alive():
        return False
    handle.terminate()
    return True


def _open_job_conn() -> sqlite3.Connection:
    conn = get_connection()
    init_db(conn)
    return conn


def _record_digest_progress(
    conn: sqlite3.Connection,
    job_id: int,
    progress: dict[str, object],
) -> None:
    current_number, total_number = _progress_numbers(progress)
    append_job_event(
        conn,
        job_id,
        "progress",
        message=str(progress.get("message") or "") or None,
        payload=progress,
        latest_progress=progress,
        progress_current=current_number,
        progress_total=total_number,
    )


def _record_and_commit_digest_progress(
    conn: sqlite3.Connection,
    job_id: int,
    progress: dict[str, object],
) -> None:
    _record_digest_progress(conn, job_id, progress)
    conn.commit()


def _run_digest_job(job_id: int) -> None:
    handle: Optional[ProcessJobHandle] = None
    conn = _open_job_conn()
    try:
        job = get_job(conn, job_id)
        if job is not None and job.status == "cancelling":
            mark_job_cancelled(
                conn,
                job_id,
                progress=_cancelled_progress(job.latest_progress),
                message="Digest fetch stopped before the child process started.",
            )
            conn.commit()
            return
        reserve_job_attempt(conn, job_id)
        conn.commit()
        handle = start_process_job(
            module_name="claudesk.jobs.run_digest",
            function_name="run_digest_once",
        )
        with _active_lock:
            _active_jobs[job_id] = handle

        job = get_job(conn, job_id)
        if job is not None and job.status == "cancelling":
            _terminate_digest_handle(handle)
            raise RuntimeError("Digest fetch stopped.")

        pid = getattr(handle.process, "pid", None)
        mark_job_running(
            conn,
            job_id,
            machine_id=default_machine_id(),
            pid=int(pid) if pid is not None else None,
            executor_kind="process",
            executor_meta={"module": "claudesk.jobs.run_digest", "function": "run_digest_once"},
            reserve_attempt=False,
        )
        conn.commit()

        result = collect_process_job(
            handle,
            on_progress=lambda progress: _record_and_commit_digest_progress(conn, job_id, progress),
        )
        job = get_job(conn, job_id)
        progress = _success_progress(result, job.latest_progress if job else None)
        mark_job_succeeded(
            conn,
            job_id,
            result=result,
            progress=progress,
            message=str(progress.get("message") or "Digest run succeeded."),
        )
        conn.commit()
    except Exception as exc:
        job = get_job(conn, job_id)
        if handle is not None:
            _terminate_digest_handle(handle)
        if job is not None and job.status == "cancelling":
            mark_job_cancelled(
                conn,
                job_id,
                progress=_cancelled_progress(job.latest_progress),
                message="Digest fetch stopped.",
            )
        else:
            mark_job_failed(
                conn,
                job_id,
                error_type=type(exc).__name__,
                message=str(exc),
                retryable=True,
                progress=_error_progress(str(exc), job.latest_progress if job else None),
            )
        conn.commit()
    finally:
        with _active_lock:
            if handle is not None and _active_jobs.get(job_id) is handle:
                _active_jobs.pop(job_id, None)
        conn.close()


def shutdown_digest_job() -> None:
    with _active_lock:
        active_items = list(_active_jobs.items())
    if not active_items:
        return
    with ExitStack() as shutdown:
        for _job_id, handle in reversed(active_items):
            shutdown.callback(handle.terminate)
        conn = _open_job_conn()
        try:
            for job_id, _handle in active_items:
                job = get_job(conn, job_id)
                if job is not None and job.status in ACTIVE_JOB_STATUSES:
                    request_job_cancel(
                        conn,
                        job_id,
                        progress=_cancelling_progress(job.latest_progress),
                        message="Digest fetch stop requested during app shutdown.",
                    )
            conn.commit()
        finally:
            conn.close()


@router.post("/digest/run", response_model=DigestRunState)
def run_digest(conn=Depends(get_conn)):
    with _active_lock:
        job = get_active_job_by_kind_dedupe_key(
            conn,
            DIGEST_JOB_KIND,
            DIGEST_DEDUPE_KEY,
        )
        if job is not None:
            launch_state = "already_running"
        else:
            job = create_job(
                conn,
                kind=DIGEST_JOB_KIND,
                request={},
                dedupe_key=DIGEST_DEDUPE_KEY,
                machine_id=default_machine_id(),
                executor_kind="process",
            )
            _record_digest_progress(conn, job.id, _initial_digest_progress())
            conn.commit()
            threading.Thread(target=_run_digest_job, args=(job.id,), daemon=True).start()
            launch_state = "started"
    return _snapshot_state(conn, launch_state=launch_state, job=job)


@router.post("/digest/cancel", response_model=DigestRunState)
def cancel_digest(conn=Depends(get_conn)):
    handle: Optional[ProcessJobHandle] = None
    job: BackgroundJob | None = None
    with _active_lock:
        job = get_active_job_by_kind_dedupe_key(
            conn,
            DIGEST_JOB_KIND,
            DIGEST_DEDUPE_KEY,
        )
        if job is not None:
            job = request_job_cancel(
                conn,
                job.id,
                progress=_cancelling_progress(job.latest_progress),
                message="Digest fetch stop requested.",
            )
            conn.commit()
            handle = _active_jobs.get(job.id)

    if handle is not None:
        _terminate_digest_handle(handle)

    return _snapshot_state(conn, job=job)


@router.get("/digest/status", response_model=DigestRunState)
def digest_status(conn=Depends(get_conn)):
    return _snapshot_state(conn)
