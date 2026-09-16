from __future__ import annotations

import json
import socket
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal, Sequence

JobStatus = Literal[
    "queued",
    "running",
    "cancelling",
    "cancelled",
    "succeeded",
    "failed",
]

ACTIVE_JOB_STATUSES: tuple[JobStatus, ...] = ("queued", "running", "cancelling")
TERMINAL_JOB_STATUSES: tuple[JobStatus, ...] = ("cancelled", "succeeded", "failed")
_MAX_JSON_CHARS = 64 * 1024


@dataclass(frozen=True)
class BackgroundJob:
    id: int
    kind: str
    status: JobStatus
    resource_kind: str | None
    resource_id: str | None
    dedupe_key: str | None
    request: dict[str, object]
    result: dict[str, object] | None
    latest_progress: dict[str, object] | None
    attempt_count: int
    max_attempts: int
    next_attempt_at: str | None
    last_failure_id: int | None
    cancel_requested_at: str | None
    machine_id: str | None
    pid: int | None
    executor_kind: str | None
    executor_meta: dict[str, object] | None
    created_at: str
    started_at: str | None
    finished_at: str | None
    updated_at: str


@dataclass(frozen=True)
class BackgroundJobEvent:
    id: int
    job_id: int
    event_type: str
    message: str | None
    progress_current: float | None
    progress_total: float | None
    payload: dict[str, object]
    created_at: str


@dataclass(frozen=True)
class BackgroundJobFailure:
    id: int
    job_id: int
    attempt: int
    error_type: str
    message: str
    details: dict[str, object]
    retryable: bool
    created_at: str


def default_machine_id() -> str:
    return socket.gethostname() or "unknown"


def utcnow_text() -> str:
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat()


def job_is_active(job: BackgroundJob) -> bool:
    return job.status in ACTIVE_JOB_STATUSES


def _decode_json_dict(value: object) -> dict[str, object]:
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return decoded if isinstance(decoded, dict) else {}


def _decode_optional_json_dict(value: object) -> dict[str, object] | None:
    if value is None:
        return None
    return _decode_json_dict(value)


def _encode_json(value: object, *, default: object) -> str:
    payload = default if value is None else value
    text = json.dumps(payload, ensure_ascii=False, default=str)
    if len(text) <= _MAX_JSON_CHARS:
        return text
    bounded = {
        "truncated": True,
        "original_char_count": len(text),
        "preview": text[: _MAX_JSON_CHARS - 256],
    }
    return json.dumps(bounded, ensure_ascii=False)


def _row_to_job(row: sqlite3.Row) -> BackgroundJob:
    return BackgroundJob(
        id=int(row["id"]),
        kind=str(row["kind"]),
        status=row["status"],
        resource_kind=row["resource_kind"],
        resource_id=row["resource_id"],
        dedupe_key=row["dedupe_key"],
        request=_decode_json_dict(row["request_json"]),
        result=_decode_optional_json_dict(row["result_json"]),
        latest_progress=_decode_optional_json_dict(row["latest_progress_json"]),
        attempt_count=int(row["attempt_count"] or 0),
        max_attempts=int(row["max_attempts"] or 1),
        next_attempt_at=row["next_attempt_at"],
        last_failure_id=(
            int(row["last_failure_id"]) if row["last_failure_id"] is not None else None
        ),
        cancel_requested_at=row["cancel_requested_at"],
        machine_id=row["machine_id"],
        pid=int(row["pid"]) if row["pid"] is not None else None,
        executor_kind=row["executor_kind"],
        executor_meta=_decode_optional_json_dict(row["executor_meta_json"]),
        created_at=row["created_at"],
        started_at=row["started_at"],
        finished_at=row["finished_at"],
        updated_at=row["updated_at"],
    )


def _row_to_event(row: sqlite3.Row) -> BackgroundJobEvent:
    return BackgroundJobEvent(
        id=int(row["id"]),
        job_id=int(row["job_id"]),
        event_type=str(row["event_type"]),
        message=row["message"],
        progress_current=(
            float(row["progress_current"]) if row["progress_current"] is not None else None
        ),
        progress_total=(
            float(row["progress_total"]) if row["progress_total"] is not None else None
        ),
        payload=_decode_json_dict(row["payload_json"]),
        created_at=row["created_at"],
    )


def _row_to_failure(row: sqlite3.Row) -> BackgroundJobFailure:
    return BackgroundJobFailure(
        id=int(row["id"]),
        job_id=int(row["job_id"]),
        attempt=int(row["attempt"] or 0),
        error_type=str(row["error_type"]),
        message=str(row["message"]),
        details=_decode_json_dict(row["details_json"]),
        retryable=bool(row["retryable"]),
        created_at=row["created_at"],
    )


def get_job(conn: sqlite3.Connection, job_id: int) -> BackgroundJob | None:
    row = conn.execute("SELECT * FROM background_jobs WHERE id=?", (job_id,)).fetchone()
    return _row_to_job(row) if row is not None else None


def get_latest_job_by_kind(
    conn: sqlite3.Connection,
    kind: str,
    *,
    statuses: Sequence[JobStatus] | None = None,
) -> BackgroundJob | None:
    params: list[object] = [kind]
    status_filter = ""
    if statuses is not None:
        placeholders = ",".join("?" for _ in statuses)
        status_filter = f"AND status IN ({placeholders})"
        params.extend(statuses)
    row = conn.execute(
        f"""
        SELECT *
        FROM background_jobs
        WHERE kind=?
        {status_filter}
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
        """,
        tuple(params),
    ).fetchone()
    return _row_to_job(row) if row is not None else None


def get_active_job_by_kind_dedupe_key(
    conn: sqlite3.Connection,
    kind: str,
    dedupe_key: str,
) -> BackgroundJob | None:
    row = conn.execute(
        """
        SELECT *
        FROM background_jobs
        WHERE kind=?
          AND dedupe_key=?
          AND status IN ('queued', 'running', 'cancelling')
        ORDER BY id ASC
        LIMIT 1
        """,
        (kind, dedupe_key),
    ).fetchone()
    return _row_to_job(row) if row is not None else None


def list_active_jobs_by_kind(
    conn: sqlite3.Connection,
    kind: str,
    *,
    machine_id: str | None = None,
) -> list[BackgroundJob]:
    params: list[object] = [kind]
    machine_filter = ""
    if machine_id is not None:
        machine_filter = "AND machine_id=?"
        params.append(machine_id)
    rows = conn.execute(
        f"""
        SELECT *
        FROM background_jobs
        WHERE kind=?
          AND status IN ('queued', 'running', 'cancelling')
          {machine_filter}
        ORDER BY id ASC
        """,
        tuple(params),
    ).fetchall()
    return [_row_to_job(row) for row in rows]


def create_job(
    conn: sqlite3.Connection,
    *,
    kind: str,
    request: dict[str, object] | None = None,
    resource_kind: str | None = None,
    resource_id: str | int | None = None,
    dedupe_key: str | None = None,
    max_attempts: int = 1,
    machine_id: str | None = None,
    executor_kind: str | None = None,
    executor_meta: dict[str, object] | None = None,
    now: str | None = None,
) -> BackgroundJob:
    timestamp = now or utcnow_text()
    cur = conn.execute(
        """
        INSERT INTO background_jobs (
            kind, status, resource_kind, resource_id, dedupe_key, request_json,
            attempt_count, max_attempts, machine_id, executor_kind, executor_meta_json,
            created_at, updated_at
        )
        VALUES (?, 'queued', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
        """,
        (
            kind,
            resource_kind,
            str(resource_id) if resource_id is not None else None,
            dedupe_key,
            _encode_json(request, default={}),
            max(1, int(max_attempts)),
            machine_id,
            executor_kind,
            _encode_json(executor_meta, default={}) if executor_meta is not None else None,
            timestamp,
            timestamp,
        ),
    )
    job_id = int(cur.lastrowid)  # type: ignore[arg-type]
    append_job_event(
        conn,
        job_id,
        "queued",
        message="Job queued.",
        payload=request,
        now=timestamp,
    )
    job = get_job(conn, job_id)
    if job is None:  # pragma: no cover - defensive guard for SQLite anomalies.
        raise RuntimeError(f"Background job {job_id} was not created.")
    return job


def append_job_event(
    conn: sqlite3.Connection,
    job_id: int,
    event_type: str,
    *,
    message: str | None = None,
    payload: dict[str, object] | None = None,
    latest_progress: dict[str, object] | None = None,
    progress_current: float | int | None = None,
    progress_total: float | int | None = None,
    now: str | None = None,
) -> BackgroundJobEvent:
    timestamp = now or utcnow_text()
    event_payload = payload or {}
    cur = conn.execute(
        """
        INSERT INTO background_job_events (
            job_id, event_type, message, progress_current, progress_total,
            payload_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            job_id,
            event_type,
            message,
            float(progress_current) if progress_current is not None else None,
            float(progress_total) if progress_total is not None else None,
            _encode_json(event_payload, default={}),
            timestamp,
        ),
    )
    progress_payload = latest_progress
    if progress_payload is None and event_type == "progress":
        progress_payload = event_payload
    update_parts = ["updated_at=?"]
    update_values: list[object] = [timestamp]
    if progress_payload is not None:
        update_parts.append("latest_progress_json=?")
        update_values.append(_encode_json(progress_payload, default={}))
    update_values.append(job_id)
    conn.execute(
        f"UPDATE background_jobs SET {', '.join(update_parts)} WHERE id=?",
        tuple(update_values),
    )
    row = conn.execute(
        "SELECT * FROM background_job_events WHERE id=?",
        (int(cur.lastrowid),),
    ).fetchone()
    return _row_to_event(row)


def mark_job_running(
    conn: sqlite3.Connection,
    job_id: int,
    *,
    machine_id: str,
    pid: int | None = None,
    executor_kind: str | None = None,
    executor_meta: dict[str, object] | None = None,
    reserve_attempt: bool = True,
    now: str | None = None,
) -> BackgroundJob:
    job = _require_job(conn, job_id)
    if job.status == "cancelling":
        raise ValueError(f"Job {job_id} is cancelling and cannot be marked running.")
    if job.status in TERMINAL_JOB_STATUSES:
        raise ValueError(f"Job {job_id} is terminal and cannot be marked running.")
    timestamp = now or utcnow_text()
    if job.status == "running":
        attempt_count = max(1, job.attempt_count)
    elif reserve_attempt:
        attempt_count = job.attempt_count + 1
    else:
        attempt_count = max(1, job.attempt_count)
    executor_meta_json = (
        _encode_json(executor_meta, default={})
        if executor_meta is not None
        else (_encode_json(job.executor_meta, default={}) if job.executor_meta is not None else None)
    )
    conn.execute(
        """
        UPDATE background_jobs
        SET status='running',
            started_at=COALESCE(started_at, ?),
            finished_at=NULL,
            cancel_requested_at=NULL,
            machine_id=?,
            pid=?,
            executor_kind=COALESCE(?, executor_kind),
            executor_meta_json=?,
            attempt_count=?,
            updated_at=?
        WHERE id=?
        """,
        (
            timestamp,
            machine_id,
            pid,
            executor_kind,
            executor_meta_json,
            attempt_count,
            timestamp,
            job_id,
        ),
    )
    append_job_event(
        conn,
        job_id,
        "running",
        message="Job started.",
        payload={"attempt": attempt_count, "pid": pid, "executor_kind": executor_kind},
        now=timestamp,
    )
    return _require_job(conn, job_id)


def reserve_job_attempt(
    conn: sqlite3.Connection,
    job_id: int,
    *,
    now: str | None = None,
) -> BackgroundJob:
    job = _require_job(conn, job_id)
    if job.status == "cancelling":
        raise ValueError(f"Job {job_id} is cancelling and cannot reserve an attempt.")
    if job.status in TERMINAL_JOB_STATUSES:
        raise ValueError(f"Job {job_id} is terminal and cannot reserve an attempt.")
    if job.status == "running":
        return job
    timestamp = now or utcnow_text()
    attempt_count = job.attempt_count + 1
    conn.execute(
        """
        UPDATE background_jobs
        SET attempt_count=?,
            updated_at=?
        WHERE id=?
        """,
        (attempt_count, timestamp, job_id),
    )
    append_job_event(
        conn,
        job_id,
        "attempt_reserved",
        message="Job attempt reserved.",
        payload={"attempt": attempt_count},
        now=timestamp,
    )
    return _require_job(conn, job_id)


def mark_job_succeeded(
    conn: sqlite3.Connection,
    job_id: int,
    *,
    result: dict[str, object] | None = None,
    progress: dict[str, object] | None = None,
    message: str | None = None,
    now: str | None = None,
) -> BackgroundJob:
    timestamp = now or utcnow_text()
    conn.execute(
        """
        UPDATE background_jobs
        SET status='succeeded',
            result_json=?,
            latest_progress_json=COALESCE(?, latest_progress_json),
            finished_at=?,
            cancel_requested_at=NULL,
            pid=NULL,
            updated_at=?
        WHERE id=?
        """,
        (
            _encode_json(result, default={}),
            _encode_json(progress, default={}) if progress is not None else None,
            timestamp,
            timestamp,
            job_id,
        ),
    )
    append_job_event(
        conn,
        job_id,
        "succeeded",
        message=message or "Job succeeded.",
        payload=result,
        latest_progress=progress,
        now=timestamp,
    )
    return _require_job(conn, job_id)


def request_job_cancel(
    conn: sqlite3.Connection,
    job_id: int,
    *,
    progress: dict[str, object] | None = None,
    message: str | None = None,
    now: str | None = None,
) -> BackgroundJob:
    job = _require_job(conn, job_id)
    if job.status in TERMINAL_JOB_STATUSES:
        return job
    timestamp = now or utcnow_text()
    conn.execute(
        """
        UPDATE background_jobs
        SET status='cancelling',
            cancel_requested_at=COALESCE(cancel_requested_at, ?),
            latest_progress_json=COALESCE(?, latest_progress_json),
            updated_at=?
        WHERE id=?
        """,
        (
            timestamp,
            _encode_json(progress, default={}) if progress is not None else None,
            timestamp,
            job_id,
        ),
    )
    append_job_event(
        conn,
        job_id,
        "cancellation_requested",
        message=message or "Job cancellation requested.",
        payload=progress,
        latest_progress=progress,
        now=timestamp,
    )
    return _require_job(conn, job_id)


def mark_job_cancelled(
    conn: sqlite3.Connection,
    job_id: int,
    *,
    progress: dict[str, object] | None = None,
    message: str | None = None,
    now: str | None = None,
) -> BackgroundJob:
    timestamp = now or utcnow_text()
    conn.execute(
        """
        UPDATE background_jobs
        SET status='cancelled',
            latest_progress_json=COALESCE(?, latest_progress_json),
            finished_at=?,
            cancel_requested_at=NULL,
            pid=NULL,
            updated_at=?
        WHERE id=?
        """,
        (
            _encode_json(progress, default={}) if progress is not None else None,
            timestamp,
            timestamp,
            job_id,
        ),
    )
    append_job_event(
        conn,
        job_id,
        "cancelled",
        message=message or "Job cancelled.",
        payload=progress,
        latest_progress=progress,
        now=timestamp,
    )
    return _require_job(conn, job_id)


def mark_job_failed(
    conn: sqlite3.Connection,
    job_id: int,
    *,
    error_type: str,
    message: str,
    details: dict[str, object] | None = None,
    retryable: bool = False,
    progress: dict[str, object] | None = None,
    now: str | None = None,
) -> BackgroundJob:
    job = _require_job(conn, job_id)
    attempt_count = max(1, job.attempt_count)
    timestamp = now or utcnow_text()
    failure = record_job_failure(
        conn,
        job_id,
        error_type=error_type,
        message=message,
        details=details,
        retryable=retryable,
        now=timestamp,
    )
    conn.execute(
        """
        UPDATE background_jobs
        SET status='failed',
            latest_progress_json=COALESCE(?, latest_progress_json),
            attempt_count=?,
            last_failure_id=?,
            finished_at=?,
            cancel_requested_at=NULL,
            pid=NULL,
            updated_at=?
        WHERE id=?
        """,
        (
            _encode_json(progress, default={}) if progress is not None else None,
            attempt_count,
            failure.id,
            timestamp,
            timestamp,
            job_id,
        ),
    )
    append_job_event(
        conn,
        job_id,
        "failed",
        message=message,
        payload={"failure_id": failure.id, "error_type": error_type, "retryable": retryable},
        latest_progress=progress,
        now=timestamp,
    )
    return _require_job(conn, job_id)


def record_job_failure(
    conn: sqlite3.Connection,
    job_id: int,
    *,
    error_type: str,
    message: str,
    details: dict[str, object] | None = None,
    retryable: bool = False,
    now: str | None = None,
) -> BackgroundJobFailure:
    job = _require_job(conn, job_id)
    timestamp = now or utcnow_text()
    cur = conn.execute(
        """
        INSERT INTO background_job_failures (
            job_id, attempt, error_type, message, details_json, retryable, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            job_id,
            max(1, job.attempt_count),
            error_type,
            message,
            _encode_json(details, default={}),
            1 if retryable else 0,
            timestamp,
        ),
    )
    row = conn.execute(
        "SELECT * FROM background_job_failures WHERE id=?",
        (int(cur.lastrowid),),
    ).fetchone()
    return _row_to_failure(row)


def retry_job(
    conn: sqlite3.Connection,
    job_id: int,
    *,
    next_attempt_at: str | None = None,
    now: str | None = None,
) -> BackgroundJob:
    job = _require_job(conn, job_id)
    if job.status not in TERMINAL_JOB_STATUSES:
        raise ValueError(f"Job {job_id} is not terminal and cannot be retried.")
    timestamp = now or utcnow_text()
    conn.execute(
        """
        UPDATE background_jobs
        SET status='queued',
            result_json=NULL,
            latest_progress_json=NULL,
            next_attempt_at=?,
            cancel_requested_at=NULL,
            started_at=NULL,
            finished_at=NULL,
            pid=NULL,
            updated_at=?
        WHERE id=?
        """,
        (next_attempt_at, timestamp, job_id),
    )
    append_job_event(
        conn,
        job_id,
        "retry_queued",
        message="Job retry queued.",
        payload={"attempt_count": job.attempt_count, "next_attempt_at": next_attempt_at},
        now=timestamp,
    )
    return _require_job(conn, job_id)


def list_job_events(conn: sqlite3.Connection, job_id: int) -> list[BackgroundJobEvent]:
    rows = conn.execute(
        """
        SELECT *
        FROM background_job_events
        WHERE job_id=?
        ORDER BY created_at ASC, id ASC
        """,
        (job_id,),
    ).fetchall()
    return [_row_to_event(row) for row in rows]


def list_job_failures(conn: sqlite3.Connection, job_id: int) -> list[BackgroundJobFailure]:
    rows = conn.execute(
        """
        SELECT *
        FROM background_job_failures
        WHERE job_id=?
        ORDER BY created_at ASC, id ASC
        """,
        (job_id,),
    ).fetchall()
    return [_row_to_failure(row) for row in rows]


def reconcile_stale_jobs(
    conn: sqlite3.Connection,
    *,
    machine_id: str,
    now: str | None = None,
) -> list[BackgroundJob]:
    timestamp = now or utcnow_text()
    rows = conn.execute(
        """
        SELECT *
        FROM background_jobs
        WHERE machine_id=?
          AND status IN ('queued', 'running', 'cancelling')
        ORDER BY id ASC
        """,
        (machine_id,),
    ).fetchall()
    reconciled: list[BackgroundJob] = []
    for row in rows:
        job = _row_to_job(row)
        if job.status == "cancelling":
            reconciled.append(
                mark_job_cancelled(
                    conn,
                    job.id,
                    progress={
                        "phase": "cancelled",
                        "message": "Job cancelled after app restart.",
                    },
                    message="Stale cancelling job reconciled after app restart.",
                    now=timestamp,
                )
            )
        elif job.status == "queued":
            reconciled.append(
                mark_job_failed(
                    conn,
                    job.id,
                    error_type="StaleBackgroundJob",
                    message="Job was queued when the app stopped before its worker could start.",
                    retryable=True,
                    progress={
                        "phase": "error",
                        "message": "Job stopped before it could start.",
                    },
                    now=timestamp,
                )
            )
        else:
            reconciled.append(
                mark_job_failed(
                    conn,
                    job.id,
                    error_type="StaleBackgroundJob",
                    message="Job was running when the app stopped before its handle could finish.",
                    retryable=True,
                    progress={
                        "phase": "error",
                        "message": "Job stopped before completion when the app exited.",
                    },
                    now=timestamp,
                )
            )
    return reconciled


def _require_job(conn: sqlite3.Connection, job_id: int) -> BackgroundJob:
    job = get_job(conn, job_id)
    if job is None:
        raise ValueError(f"Background job {job_id} not found.")
    return job
