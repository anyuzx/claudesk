from __future__ import annotations

import json
import shutil
import subprocess
import sys
import threading
from contextlib import ExitStack
from pathlib import Path
from typing import Callable, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, ValidationError

from claudesk.api.deps import get_conn
from claudesk.api.process_jobs import (
    ProcessJobHandle,
    collect_process_job,
    start_process_job,
)
from claudesk.api.settings_registry import (
    apply_patches as _apply_settings_patches,
    build_config_preview as _build_config_preview,
    build_settings_payload as _build_settings_payload,
)
from claudesk.core.config import (
    VaultConfigError,
    config_path,
    load_config,
    local_vault_path,
    paper_assets_root,
    set_local_vault_path,
    vault_location,
)
from claudesk.core.db import db_path, get_connection, init_db
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
from claudesk.sources.pubmed import build_pubmed_query_plan

router = APIRouter()
RUBRIC_JOB_KIND = "rubric_scoring"
RUBRIC_DEDUPE_KEY = "rubric_scoring"


class RubricRunRequest(BaseModel):
    scope: Literal["all", "saved"]
    refresh_existing: bool = False


class RubricRunSummary(BaseModel):
    scope: Literal["all", "saved"]
    refresh_existing: bool = False
    total_papers: int
    processed_papers: int
    changed_papers: int


class RubricRunProgress(BaseModel):
    scope: Optional[Literal["all", "saved"]] = None
    refresh_existing: bool = False
    message: Optional[str] = None
    total_papers: Optional[int] = None
    processed_papers: Optional[int] = None
    changed_papers: Optional[int] = None
    current_title: Optional[str] = None
    batch_size: Optional[int] = None


class RubricRunState(BaseModel):
    running: bool
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    last_error: Optional[str] = None
    progress: Optional[RubricRunProgress] = None
    last_result: Optional[RubricRunSummary] = None
    launch_state: Optional[str] = Field(default=None, exclude=True)


_rubric_active_lock = threading.Lock()
_active_rubric_jobs: dict[int, ProcessJobHandle] = {}


def _snapshot_state(
    conn,
    *,
    launch_state: Optional[str] = None,
    job: BackgroundJob | None = None,
) -> RubricRunState:
    if job is not None:
        job = get_job(conn, job.id) or job
    active_job = job or get_active_job_by_kind_dedupe_key(
        conn,
        RUBRIC_JOB_KIND,
        RUBRIC_DEDUPE_KEY,
    )
    latest_job = active_job or get_latest_job_by_kind(conn, RUBRIC_JOB_KIND)

    running = active_job is not None and active_job.status in ACTIVE_JOB_STATUSES
    started_at = None
    finished_at = None
    last_error = None
    progress: dict[str, object] | None = None
    last_result: dict[str, object] | None = None

    if latest_job is not None:
        started_at = latest_job.started_at or (latest_job.created_at if running else None)
        finished_at = latest_job.finished_at
        progress = dict(latest_job.latest_progress or {})
        last_result = dict(latest_job.result or {}) if latest_job.result else None
        if latest_job.status == "failed":
            failures = list_job_failures(conn, latest_job.id)
            if failures:
                last_error = failures[-1].message

    return RubricRunState(
        running=running,
        started_at=started_at,
        finished_at=finished_at,
        last_error=last_error,
        progress=RubricRunProgress(**progress) if progress else None,
        last_result=RubricRunSummary(**last_result) if last_result else None,
        launch_state=launch_state,
    )


def _initial_rubric_progress(
    scope: Literal["all", "saved"],
    refresh_existing: bool,
) -> dict[str, object]:
    return {
        "scope": scope,
        "refresh_existing": refresh_existing,
        "message": "Starting rubric scoring run…",
        "total_papers": None,
        "processed_papers": 0,
        "changed_papers": 0,
        "current_title": None,
        "batch_size": None,
    }


def _error_progress(
    message: str,
    *,
    scope: Literal["all", "saved"],
    refresh_existing: bool,
    current: dict[str, object] | None = None,
) -> dict[str, object]:
    progress = dict(current or {})
    progress.update(
        {
            "scope": scope,
            "refresh_existing": refresh_existing,
            "message": message,
            "current_title": None,
        }
    )
    return progress


def _cancelled_progress(current: dict[str, object] | None = None) -> dict[str, object]:
    progress = dict(current or {})
    progress.update({"message": "Rubric scoring stopped.", "current_title": None})
    return progress


def _record_rubric_progress(
    conn,
    job_id: int,
    progress: dict[str, object],
) -> None:
    current = progress.get("processed_papers")
    total = progress.get("total_papers")
    try:
        progress_current = float(current) if current is not None else None
    except (TypeError, ValueError):
        progress_current = None
    try:
        progress_total = float(total) if total is not None else None
    except (TypeError, ValueError):
        progress_total = None
    append_job_event(
        conn,
        job_id,
        "progress",
        message=str(progress.get("message") or "") or None,
        payload=progress,
        latest_progress=progress,
        progress_current=progress_current,
        progress_total=progress_total,
    )


def _record_and_commit_rubric_progress(
    conn,
    job_id: int,
    progress: dict[str, object],
) -> None:
    _record_rubric_progress(conn, job_id, progress)
    conn.commit()


def _rubric_result_progress(
    result: dict[str, object],
    current: dict[str, object] | None = None,
) -> dict[str, object]:
    progress = dict(current or {})
    progress.update(result)
    progress["current_title"] = None
    progress.setdefault(
        "message",
        f"Processed {result.get('processed_papers', 0)} of {result.get('total_papers', 0)} papers.",
    )
    return progress


def _open_job_conn():
    conn = get_connection()
    init_db(conn)
    return conn


def _run_rubric_job(
    job_id: int,
    scope: Literal["all", "saved"],
    refresh_existing: bool,
) -> None:
    handle: Optional[ProcessJobHandle] = None
    conn = _open_job_conn()
    try:
        job = get_job(conn, job_id)
        if job is not None and job.status == "cancelling":
            mark_job_cancelled(
                conn,
                job_id,
                progress=_cancelled_progress(job.latest_progress),
                message="Rubric scoring stopped before the child process started.",
            )
            conn.commit()
            return
        reserve_job_attempt(conn, job_id)
        conn.commit()
        handle = start_process_job(
            module_name="claudesk.jobs.run_rubric_scoring",
            function_name="run_rubric_scoring_once",
            kwargs={
                "scope": scope,
                "refresh_existing": refresh_existing,
            },
        )
        with _rubric_active_lock:
            _active_rubric_jobs[job_id] = handle

        job = get_job(conn, job_id)
        if job is not None and job.status == "cancelling":
            handle.terminate()
            raise RuntimeError("Rubric scoring stopped.")

        pid = getattr(handle.process, "pid", None)
        mark_job_running(
            conn,
            job_id,
            machine_id=default_machine_id(),
            pid=int(pid) if pid is not None else None,
            executor_kind="process",
            executor_meta={
                "module": "claudesk.jobs.run_rubric_scoring",
                "function": "run_rubric_scoring_once",
            },
            reserve_attempt=False,
        )
        conn.commit()

        result = collect_process_job(
            handle,
            on_progress=lambda progress: _record_and_commit_rubric_progress(conn, job_id, progress),
        )
        job = get_job(conn, job_id)
        progress = _rubric_result_progress(result, job.latest_progress if job else None)
        mark_job_succeeded(
            conn,
            job_id,
            result=result,
            progress=progress,
            message=str(progress.get("message") or "Rubric scoring run succeeded."),
        )
        conn.commit()
    except Exception as exc:
        job = get_job(conn, job_id)
        if handle is not None:
            handle.terminate()
        if job is not None and job.status == "cancelling":
            mark_job_cancelled(
                conn,
                job_id,
                progress=_cancelled_progress(job.latest_progress),
                message="Rubric scoring stopped.",
            )
        else:
            mark_job_failed(
                conn,
                job_id,
                error_type=type(exc).__name__,
                message=str(exc),
                retryable=True,
                progress=_error_progress(
                    str(exc),
                    scope=scope,
                    refresh_existing=refresh_existing,
                    current=job.latest_progress if job else None,
                ),
            )
        conn.commit()
    finally:
        with _rubric_active_lock:
            if handle is not None and _active_rubric_jobs.get(job_id) is handle:
                _active_rubric_jobs.pop(job_id, None)
        conn.close()


def shutdown_rubric_job() -> None:
    with _rubric_active_lock:
        active_items = list(_active_rubric_jobs.items())
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
                        progress=_cancelled_progress(job.latest_progress),
                        message="Rubric scoring stop requested during app shutdown.",
                    )
            conn.commit()
        finally:
            conn.close()


@router.post("/settings/rubric/run", response_model=RubricRunState)
def run_rubric_scoring(body: RubricRunRequest, conn=Depends(get_conn)):
    cfg = load_config()
    if not cfg.llm.api_key:
        raise HTTPException(
            status_code=400,
            detail="LLM not configured — set the OPENAI_API_KEY environment variable.",
        )

    with _rubric_active_lock:
        job = get_active_job_by_kind_dedupe_key(
            conn,
            RUBRIC_JOB_KIND,
            RUBRIC_DEDUPE_KEY,
        )
        if job is not None:
            launch_state = "already_running"
        else:
            job = create_job(
                conn,
                kind=RUBRIC_JOB_KIND,
                request={
                    "scope": body.scope,
                    "refresh_existing": body.refresh_existing,
                },
                dedupe_key=RUBRIC_DEDUPE_KEY,
                machine_id=default_machine_id(),
                executor_kind="process",
            )
            _record_rubric_progress(
                conn,
                job.id,
                _initial_rubric_progress(body.scope, body.refresh_existing),
            )
            conn.commit()
            threading.Thread(
                target=_run_rubric_job,
                args=(job.id, body.scope, body.refresh_existing),
                daemon=True,
            ).start()
            launch_state = "started"
    return _snapshot_state(conn, launch_state=launch_state, job=job)


@router.get("/settings/rubric/status", response_model=RubricRunState)
def rubric_status(conn=Depends(get_conn)):
    return _snapshot_state(conn)


class SettingsPatchEntry(BaseModel):
    key: str
    value: object | None = None


class SettingsPatchRequest(BaseModel):
    patches: list[SettingsPatchEntry] = Field(default_factory=list)


class PubmedPreviewResponse(BaseModel):
    query_mode: Literal["auto", "builder", "raw"]
    query: str
    empty: bool
    encoded_request_length: int
    length_status: Literal["empty", "ok", "too_long"]
    warning: Optional[str] = None
    chunk_count: int


class DirectoryPickResponse(BaseModel):
    path: Optional[str] = None


class DirectoryPickRequest(BaseModel):
    key: Optional[str] = None


class VaultSettingsResponse(BaseModel):
    vault_path: str
    source: Literal["env", "local_config", "default"]
    local_config_path: str
    configured_vault_path: Optional[str] = None
    pending_vault_path: Optional[str] = None
    settings_file: str
    database: str
    asset_root: str
    env_override: bool
    restart_required: bool
    configured_vault_error: Optional[str] = None


class VaultPathRequest(BaseModel):
    vault_path: str = Field(min_length=1)


class VaultSettingsPreviewResponse(BaseModel):
    target_path: str
    exists: bool
    is_directory: bool
    has_claudesk_vault: bool
    matches_current_vault: bool
    env_override: bool
    can_save: bool
    error: Optional[str] = None


class DirectoryPickerUnavailable(RuntimeError):
    """Raised when the local OS directory picker cannot be opened."""


DirectoryPicker = Callable[[], Optional[str]]


def _normalize_picked_directory(path: str | None) -> Optional[str]:
    cleaned = (path or "").strip()
    if not cleaned:
        return None
    return str(Path(cleaned).expanduser().resolve())


def _directory_config_value(path: str | None, *, key: str | None = None) -> Optional[str]:
    _ = key
    normalized = _normalize_picked_directory(path)
    if normalized is None:
        return None
    return normalized


def _build_vault_settings_payload() -> VaultSettingsResponse:
    location = vault_location()
    configured_error: Optional[str] = None
    try:
        configured = local_vault_path()
    except VaultConfigError as exc:
        if location.source != "env":
            raise
        configured = None
        configured_error = str(exc)
    pending = configured if configured is not None and configured != location.path else None
    cfg = load_config()
    return VaultSettingsResponse(
        vault_path=str(location.path),
        source=location.source,
        local_config_path=str(location.local_config_path),
        configured_vault_path=str(configured) if configured is not None else None,
        pending_vault_path=str(pending) if pending is not None else None,
        settings_file=str(config_path()),
        database=str(db_path()),
        asset_root=str(paper_assets_root(cfg, create=False)),
        env_override=location.source == "env",
        restart_required=pending is not None,
        configured_vault_error=configured_error,
    )


def _preview_vault_target(path: str) -> VaultSettingsPreviewResponse:
    cleaned = path.strip()
    if not cleaned:
        raise HTTPException(status_code=422, detail="vault_path must not be empty.")
    location = vault_location()
    try:
        target = Path(cleaned).expanduser().resolve()
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"Could not inspect vault path: {exc}") from exc

    exists = target.exists()
    is_directory = target.is_dir()
    has_claudesk_vault = (
        is_directory
        and (
            (target / "claudesk.db").is_file()
            or (target / "interests.yaml").is_file()
            or (target / "assets").is_dir()
        )
    )
    invalid_file_target = exists and not is_directory
    return VaultSettingsPreviewResponse(
        target_path=str(target),
        exists=exists,
        is_directory=is_directory,
        has_claudesk_vault=has_claudesk_vault,
        matches_current_vault=target == location.path,
        env_override=location.source == "env",
        can_save=not invalid_file_target,
        error=(
            "The selected path exists but is not a directory."
            if invalid_file_target
            else None
        ),
    )


def _run_directory_picker_command(
    command: list[str],
    *,
    cancel_markers: tuple[str, ...] = (),
) -> Optional[str]:
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError as exc:  # pragma: no cover - environment dependent
        raise DirectoryPickerUnavailable("Directory picker is unavailable on this system.") from exc

    stdout = result.stdout.strip()
    stderr = result.stderr.strip()
    if result.returncode == 0:
        return _normalize_picked_directory(stdout)

    combined = f"{stdout}\n{stderr}".casefold()
    if any(marker in combined for marker in cancel_markers):
        return None
    if result.returncode in {1, 130} and not stdout and not stderr:
        return None
    raise DirectoryPickerUnavailable("Directory picker is unavailable on this system.")


def _pick_directory_macos() -> Optional[str]:
    if shutil.which("osascript") is None:
        raise DirectoryPickerUnavailable("osascript is unavailable.")
    return _run_directory_picker_command(
        [
            "osascript",
            "-e",
            'POSIX path of (choose folder with prompt "Choose directory")',
        ],
        cancel_markers=("user canceled", "-128"),
    )


def _pick_directory_zenity() -> Optional[str]:
    if shutil.which("zenity") is None:
        raise DirectoryPickerUnavailable("zenity is unavailable.")
    return _run_directory_picker_command(
        [
            "zenity",
            "--file-selection",
            "--directory",
            "--title=Choose directory",
        ],
    )


def _pick_directory_kdialog() -> Optional[str]:
    if shutil.which("kdialog") is None:
        raise DirectoryPickerUnavailable("kdialog is unavailable.")
    return _run_directory_picker_command(
        [
            "kdialog",
            "--title",
            "Choose directory",
            "--getexistingdirectory",
            str(Path.home()),
        ],
    )


def _pick_directory_windows() -> Optional[str]:
    command = shutil.which("powershell.exe") or shutil.which("powershell") or shutil.which("pwsh")
    if command is None:
        raise DirectoryPickerUnavailable("PowerShell is unavailable.")
    script = r"""
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose directory'
$dialog.ShowNewFolderButton = $true
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $dialog.SelectedPath
}
"""
    return _run_directory_picker_command(
        [
            command,
            "-NoProfile",
            "-STA",
            "-Command",
            script,
        ],
    )


def _pick_directory_tk_subprocess() -> Optional[str]:
    script = r"""
import json
import sys
from pathlib import Path

try:
    import tkinter as tk
    from tkinter import filedialog
except Exception as exc:
    print(str(exc), file=sys.stderr)
    raise SystemExit(2)

root = None
try:
    root = tk.Tk()
    root.withdraw()
    root.update()
    selected = filedialog.askdirectory(parent=root, mustexist=True)
    path = str(Path(selected).expanduser().resolve()) if selected else None
    print(json.dumps({"path": path}))
except Exception as exc:
    print(str(exc), file=sys.stderr)
    raise SystemExit(2)
finally:
    if root is not None:
        root.destroy()
"""
    try:
        result = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError as exc:  # pragma: no cover - environment dependent
        raise DirectoryPickerUnavailable("Directory picker is unavailable on this system.") from exc

    if result.returncode != 0:
        raise DirectoryPickerUnavailable("Directory picker is unavailable on this system.")

    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise DirectoryPickerUnavailable("Directory picker returned an invalid response.") from exc
    path = payload.get("path")
    return path if isinstance(path, str) and path else None


def _directory_picker_providers(platform_name: str) -> list[DirectoryPicker]:
    if platform_name == "darwin":
        return [_pick_directory_macos, _pick_directory_tk_subprocess]
    if platform_name.startswith("linux"):
        return [_pick_directory_zenity, _pick_directory_kdialog, _pick_directory_tk_subprocess]
    if platform_name.startswith("win"):
        return [_pick_directory_windows, _pick_directory_tk_subprocess]
    return [_pick_directory_tk_subprocess]


def pick_directory_dialog(platform_name: str | None = None) -> Optional[str]:
    for provider in _directory_picker_providers(platform_name or sys.platform):
        try:
            return provider()
        except DirectoryPickerUnavailable:
            continue
    raise DirectoryPickerUnavailable("Directory picker is unavailable on this system.")


@router.get("/settings")
def get_settings():
    return _build_settings_payload()


@router.get("/settings/vault", response_model=VaultSettingsResponse)
def get_vault_settings():
    return _build_vault_settings_payload()


@router.post("/settings/vault/preview", response_model=VaultSettingsPreviewResponse)
def preview_vault_settings(body: VaultPathRequest):
    return _preview_vault_target(body.vault_path)


@router.patch("/settings/vault", response_model=VaultSettingsResponse)
def patch_vault_settings(body: VaultPathRequest):
    cleaned = body.vault_path.strip()
    if not cleaned:
        raise HTTPException(status_code=422, detail="vault_path must not be empty.")
    vault_location()
    try:
        set_local_vault_path(cleaned, clear_cache=False)
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"Could not write local vault config: {exc}") from exc
    return _build_vault_settings_payload()


@router.patch("/settings")
def patch_settings(body: SettingsPatchRequest):
    if not body.patches:
        return _build_settings_payload()
    # ValidationError must be caught BEFORE ValueError because pydantic v2's
    # ValidationError inherits from ValueError.
    try:
        return _apply_settings_patches([p.model_dump() for p in body.patches])
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/settings/pubmed/preview", response_model=PubmedPreviewResponse)
def preview_pubmed_settings(body: SettingsPatchRequest):
    try:
        cfg = _build_config_preview([p.model_dump() for p in body.patches])
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    query_plan = build_pubmed_query_plan(cfg)
    return PubmedPreviewResponse(
        query_mode=cfg.sources.pubmed.query_mode,
        query=query_plan.query,
        empty=not bool(query_plan.query),
        encoded_request_length=query_plan.encoded_request_length,
        length_status=query_plan.length_status,
        warning=query_plan.warning,
        chunk_count=len(query_plan.queries),
    )


@router.post("/settings/pick-directory", response_model=DirectoryPickResponse)
def pick_settings_directory(body: DirectoryPickRequest | None = None):
    try:
        return DirectoryPickResponse(path=_directory_config_value(pick_directory_dialog(), key=body.key if body else None))
    except DirectoryPickerUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/settings/chat/skills")
def list_chat_skills():
    cfg = load_config()
    skills: list[dict[str, str]] = []
    if not cfg.chat.skills.enabled:
        return {"enabled": False, "roots": cfg.chat.skills.roots, "skills": skills}
    for root in cfg.chat.skills.roots:
        root_path = Path(root).expanduser()
        if not root_path.is_absolute() or not root_path.is_dir():
            continue
        for skill_dir in sorted(path for path in root_path.iterdir() if path.is_dir()):
            skill_file = skill_dir / "SKILL.md"
            if skill_file.exists():
                skills.append({"name": skill_dir.name, "path": str(skill_dir)})
    return {"enabled": True, "roots": cfg.chat.skills.roots, "skills": skills}
