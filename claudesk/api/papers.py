from __future__ import annotations

import sqlite3
import threading
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from claudesk.api.deps import get_conn
from claudesk.api.paper_asset_payloads import build_paper_asset_payload
from claudesk.core.config import load_config
from claudesk.core.doi import InvalidDoiError
from claudesk.core.db.papers import (
    count_papers,
    delete_paper,
    get_paper,
    list_papers,
    list_to_read_papers,
    suggest_papers,
    update_paper_abstract,
)
from claudesk.core.db.assets import (
    count_asset_document_blocks,
    count_asset_pdf_pages,
    count_asset_text_chunks,
    count_asset_owners,
    delete_paper_asset,
    get_asset,
    get_paper_asset,
    list_paper_assets,
    update_asset_parse_state,
    update_paper_asset_display_name,
)
from claudesk.core.db import (
    db_path,
    init_db,
)
from claudesk.core.db.jobs import (
    BackgroundJob,
    append_job_event,
    create_job,
    default_machine_id,
    get_active_job_by_kind_dedupe_key,
    get_job,
    job_is_active,
    list_active_jobs_by_kind,
    mark_job_failed,
    mark_job_running,
    mark_job_succeeded,
)
from claudesk.core.models import AssetKind, AssetParseStatus, PaperSignal, PaperStatus
from claudesk.core.paper_assets import (
    AssetFileStatus,
    InvalidPaperAssetFile,
    asset_file_health,
    delete_managed_asset_file,
)
from claudesk.core.paper_asset_ops import attach_pdf_to_paper
from claudesk.core.paper_status import apply_paper_signal
from claudesk.core.paper_ingest import add_paper_by_doi as add_paper_by_doi_core
from claudesk.core.pdf_ingest import (
    clear_pdf_ingest_cache,
    ensure_pdf_ingested,
    selected_pdf_parser_metadata,
)
from claudesk.sources.doi import DoiMetadataError, DoiNotFoundError

router = APIRouter()
_parse_job_lock = threading.Lock()
_parse_threads: dict[int, threading.Thread] = {}
PDF_PARSE_JOB_KIND = "pdf_parse"


class StatusUpdate(BaseModel):
    status: PaperSignal


class AbstractUpdate(BaseModel):
    abstract: str


class DoiAddRequest(BaseModel):
    doi: str
    save: bool = False


class PaperAssetRenameRequest(BaseModel):
    display_name: str


class PaperCountResponse(BaseModel):
    total_papers: int


def _cleanup_asset_files_if_orphaned(conn: sqlite3.Connection, asset, *, cfg) -> None:
    asset_id = asset.id or 0
    if asset_id <= 0:
        return
    link_count = int(conn.execute(
        "SELECT COUNT(*) FROM paper_assets WHERE asset_id=?",
        (asset_id,),
    ).fetchone()[0])
    if link_count != 1:
        return
    if count_asset_owners(conn, asset_id) != 1:
        return
    if asset.kind == AssetKind.PDF:
        clear_pdf_ingest_cache(conn, asset_id, cfg=cfg)
    try:
        delete_managed_asset_file(asset.managed_path, cfg=cfg)
    except InvalidPaperAssetFile:
        return


def _open_parse_worker_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path()), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=3000")
    init_db(conn)
    return conn


def _pdf_parse_dedupe_key(asset_id: int) -> str:
    return f"pdf_parse:{asset_id}"


def _pdf_parse_progress(
    phase: str,
    message: str,
    *,
    paper_id: int,
    asset_id: int,
) -> dict[str, object]:
    return {
        "phase": phase,
        "message": message,
        "paper_id": paper_id,
        "asset_id": asset_id,
    }


def _record_pdf_parse_progress(
    conn: sqlite3.Connection,
    job_id: int,
    progress: dict[str, object],
) -> None:
    append_job_event(
        conn,
        job_id,
        "progress",
        message=str(progress.get("message") or "") or None,
        payload=progress,
        latest_progress=progress,
    )


def _pdf_parse_result_metadata(
    conn: sqlite3.Connection,
    *,
    paper_id: int,
    asset_id: int,
    cache_hit: bool = False,
) -> dict[str, object]:
    asset = get_asset(conn, asset_id)
    result: dict[str, object] = {
        "paper_id": paper_id,
        "asset_id": asset_id,
        "cache_hit": cache_hit,
        "page_count": count_asset_pdf_pages(conn, asset_id),
        "block_count": count_asset_document_blocks(conn, asset_id),
        "chunk_count": count_asset_text_chunks(conn, asset_id),
    }
    if asset is not None:
        result.update(
            {
                "parse_status": asset.parse_status.value,
                "parser_name": asset.parser_name,
                "parser_version": asset.parser_version,
            }
        )
    return result


def _pdf_parse_asset_id(job: BackgroundJob) -> int | None:
    if job.resource_kind == "asset" and job.resource_id is not None:
        try:
            return int(job.resource_id)
        except ValueError:
            return None
    if job.dedupe_key and job.dedupe_key.startswith("pdf_parse:"):
        try:
            return int(job.dedupe_key.split(":", 1)[1])
        except ValueError:
            return None
    return None


def _fail_pdf_parse_job(
    conn: sqlite3.Connection,
    job_id: int,
    *,
    paper_id: int,
    asset_id: int,
    error_type: str,
    message: str,
    retryable: bool,
    cfg=None,
) -> None:
    job = get_job(conn, job_id)
    if job is None or not job_is_active(job):
        return
    asset = get_asset(conn, asset_id)
    if asset is not None and asset.parse_status in {
        AssetParseStatus.NOT_PARSED,
        AssetParseStatus.QUEUED,
    }:
        clear_pdf_ingest_cache(conn, asset_id, cfg=cfg or load_config())
        update_asset_parse_state(
            conn,
            asset_id,
            parse_status=AssetParseStatus.FAILED,
            parser_name=asset.parser_name,
            parser_version=asset.parser_version,
            parse_error=message,
        )
    mark_job_failed(
        conn,
        job_id,
        error_type=error_type,
        message=message,
        details={"paper_id": paper_id, "asset_id": asset_id},
        retryable=retryable,
        progress=_pdf_parse_progress(
            "error",
            message,
            paper_id=paper_id,
            asset_id=asset_id,
        ),
    )


def _run_parse_job(job_id: int, paper_id: int, asset_id: int) -> None:
    conn = _open_parse_worker_conn()
    try:
        cfg = load_config()
        try:
            mark_job_running(
                conn,
                job_id,
                machine_id=default_machine_id(),
                executor_kind="thread",
                executor_meta={"worker": "claudesk.api.papers._run_parse_job"},
            )
            _record_pdf_parse_progress(
                conn,
                job_id,
                _pdf_parse_progress(
                    "parsing",
                    "Parsing PDF...",
                    paper_id=paper_id,
                    asset_id=asset_id,
                ),
            )
            conn.commit()
            result = ensure_pdf_ingested(
                conn,
                paper_id=paper_id,
                asset_id=asset_id,
                cfg=cfg,
            )
            success = _pdf_parse_result_metadata(
                conn,
                paper_id=paper_id,
                asset_id=asset_id,
                cache_hit=bool(getattr(result, "cache_hit", False)),
            )
            progress = _pdf_parse_progress(
                "done",
                "PDF parsed.",
                paper_id=paper_id,
                asset_id=asset_id,
            )
            progress.update(success)
            mark_job_succeeded(
                conn,
                job_id,
                result=success,
                progress=progress,
                message="PDF parse succeeded.",
            )
            conn.commit()
        except Exception as exc:
            _fail_pdf_parse_job(
                conn,
                job_id,
                paper_id=paper_id,
                asset_id=asset_id,
                error_type=type(exc).__name__,
                message=str(exc),
                retryable=True,
                cfg=cfg,
            )
            conn.commit()
    finally:
        conn.close()
        with _parse_job_lock:
            _parse_threads.pop(job_id, None)


def reconcile_stale_pdf_parse_jobs(
    conn: sqlite3.Connection,
    *,
    machine_id: str | None = None,
    cfg=None,
) -> list[BackgroundJob]:
    resolved_machine_id = machine_id or default_machine_id()
    resolved_cfg = cfg or load_config()
    reconciled: list[BackgroundJob] = []
    for job in list_active_jobs_by_kind(
        conn,
        PDF_PARSE_JOB_KIND,
        machine_id=resolved_machine_id,
    ):
        asset_id = _pdf_parse_asset_id(job)
        if asset_id is None:
            mark_job_failed(
                conn,
                job.id,
                error_type="StaleBackgroundJob",
                message="Stale PDF parse job did not record an asset id.",
                retryable=False,
                progress={
                    "phase": "error",
                    "message": "Stale PDF parse job had no asset id.",
                },
            )
            reconciled.append(get_job(conn, job.id) or job)
            continue

        asset = get_asset(conn, asset_id)
        paper_id = 0
        if isinstance(job.request.get("paper_id"), int):
            paper_id = int(job.request["paper_id"])
        if asset is None:
            mark_job_failed(
                conn,
                job.id,
                error_type="StaleBackgroundJob",
                message=f"Stale PDF parse job referenced missing asset {asset_id}.",
                details={"asset_id": asset_id},
                retryable=False,
                progress={
                    "phase": "error",
                    "message": f"Stale PDF parse job referenced missing asset {asset_id}.",
                    "asset_id": asset_id,
                },
            )
            reconciled.append(get_job(conn, job.id) or job)
            continue

        if asset.parse_status == AssetParseStatus.PARSED:
            result = _pdf_parse_result_metadata(
                conn,
                paper_id=paper_id,
                asset_id=asset_id,
                cache_hit=False,
            )
            progress = {
                "phase": "done",
                "message": "PDF parse completed before app restart.",
                **result,
            }
            reconciled.append(
                mark_job_succeeded(
                    conn,
                    job.id,
                    result=result,
                    progress=progress,
                    message="Stale PDF parse job reconciled as succeeded.",
                )
            )
            continue

        if asset.parse_status == AssetParseStatus.FAILED:
            message = asset.parse_error or "PDF parse failed before app restart."
            mark_job_failed(
                conn,
                job.id,
                error_type="StaleBackgroundJob",
                message=message,
                details={"asset_id": asset_id, "parse_status": asset.parse_status.value},
                retryable=True,
                progress={
                    "phase": "error",
                    "message": message,
                    "asset_id": asset_id,
                    "parse_status": asset.parse_status.value,
                },
            )
            reconciled.append(get_job(conn, job.id) or job)
            continue

        old_status = asset.parse_status.value
        message = "PDF parse stopped before completion when the app exited."
        clear_pdf_ingest_cache(conn, asset_id, cfg=resolved_cfg)
        update_asset_parse_state(
            conn,
            asset_id,
            parse_status=AssetParseStatus.FAILED,
            parser_name=asset.parser_name,
            parser_version=asset.parser_version,
            parse_error=message,
        )
        mark_job_failed(
            conn,
            job.id,
            error_type="StaleBackgroundJob",
            message=message,
            details={"asset_id": asset_id, "parse_status": old_status},
            retryable=True,
            progress={
                "phase": "error",
                "message": message,
                "asset_id": asset_id,
                "parse_status": AssetParseStatus.FAILED.value,
            },
        )
        reconciled.append(get_job(conn, job.id) or job)
    _reconcile_legacy_queued_pdf_assets(conn, cfg=resolved_cfg)
    return reconciled


def _reconcile_legacy_queued_pdf_assets(
    conn: sqlite3.Connection,
    *,
    cfg,
) -> None:
    rows = conn.execute(
        """
        SELECT a.id, a.parser_name, a.parser_version
        FROM assets a
        WHERE a.kind=?
          AND a.parse_status=?
          AND NOT EXISTS (
              SELECT 1
              FROM background_jobs bj
              WHERE bj.kind=?
                AND bj.status IN ('queued', 'running', 'cancelling')
                AND (
                    (bj.resource_kind='asset' AND bj.resource_id=CAST(a.id AS TEXT))
                    OR bj.dedupe_key=('pdf_parse:' || CAST(a.id AS TEXT))
                )
          )
        ORDER BY a.id ASC
        """,
        (
            AssetKind.PDF.value,
            AssetParseStatus.QUEUED.value,
            PDF_PARSE_JOB_KIND,
        ),
    ).fetchall()
    for row in rows:
        asset_id = int(row["id"])
        message = "PDF parse was queued without a durable background job and cannot be resumed."
        clear_pdf_ingest_cache(conn, asset_id, cfg=cfg)
        update_asset_parse_state(
            conn,
            asset_id,
            parse_status=AssetParseStatus.FAILED,
            parser_name=row["parser_name"],
            parser_version=row["parser_version"],
            parse_error=message,
        )


@router.get("/papers")
def get_papers(
    days: Optional[int] = None,
    status: Optional[str] = None,
    sort: str = "score",
    include_dismissed: bool = False,
    conn=Depends(get_conn),
):
    since = date.today() - timedelta(days=days) if days is not None else None
    ps = PaperStatus(status) if status else None
    papers = list_papers(
        conn,
        since=since,
        status=ps,
        sort=sort,
        include_dismissed=include_dismissed,
    )
    return [p.model_dump(exclude={"embedding"}) for p in papers]


@router.get("/papers/count", response_model=PaperCountResponse)
def get_paper_count(
    include_dismissed: bool = False,
    conn=Depends(get_conn),
):
    return {"total_papers": count_papers(conn, include_dismissed=include_dismissed)}


@router.get("/papers/to-read")
def get_to_read_papers(
    sort: str = "score",
    conn=Depends(get_conn),
):
    papers = list_to_read_papers(conn, sort=sort)
    return [p.model_dump(exclude={"embedding"}) for p in papers]


@router.get("/papers/suggest")
def get_paper_suggestions(
    q: str = "",
    limit: int = 8,
    conn=Depends(get_conn),
):
    papers = suggest_papers(conn, q, limit=max(1, min(limit, 12)))
    return [
        {
            "id": paper.id,
            "title": paper.title,
            "source": paper.source,
            "published_date": paper.published_date.isoformat(),
            "journal_abbrev": paper.journal_abbrev,
        }
        for paper in papers
    ]


@router.post("/papers/doi")
def add_paper_by_doi(body: DoiAddRequest, conn=Depends(get_conn)):
    try:
        result = add_paper_by_doi_core(conn, body.doi, save=body.save)
    except InvalidDoiError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except DoiNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except DoiMetadataError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail="Added paper could not be loaded.") from exc
    conn.commit()
    return {
        "paper": result.paper.model_dump(exclude={"embedding"}),
        "status": result.status,
        "warnings": result.warnings,
    }


@router.get("/papers/{paper_id}/assets")
def get_paper_assets(paper_id: int, conn=Depends(get_conn)):
    if get_paper(conn, paper_id) is None:
        raise HTTPException(status_code=404, detail=f"Paper {paper_id} not found.")
    cfg = load_config()
    return [
        build_paper_asset_payload(asset, cfg=cfg, conn=conn)
        for asset in list_paper_assets(conn, paper_id)
    ]


@router.post("/papers/{paper_id}/assets")
def upload_paper_asset(
    paper_id: int,
    file: UploadFile = File(...),
    conn=Depends(get_conn),
):
    paper = get_paper(conn, paper_id)
    if paper is None:
        raise HTTPException(status_code=404, detail=f"Paper {paper_id} not found.")

    cfg = load_config()
    try:
        asset = attach_pdf_to_paper(
            conn,
            paper_id,
            file_obj=file.file,
            filename=file.filename,
            mime_type=file.content_type,
            source="manual",
            cfg=cfg,
        )
        conn.commit()
    except (InvalidPaperAssetFile, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return build_paper_asset_payload(asset, cfg=cfg, conn=conn)


@router.patch("/papers/{paper_id}/assets/{asset_id}")
def rename_paper_asset(
    paper_id: int,
    asset_id: int,
    body: PaperAssetRenameRequest,
    conn=Depends(get_conn),
):
    if get_paper(conn, paper_id) is None:
        raise HTTPException(status_code=404, detail=f"Paper {paper_id} not found.")

    display_name = body.display_name.strip()
    if not display_name:
        raise HTTPException(status_code=400, detail="Asset display name is required.")

    try:
        asset = update_paper_asset_display_name(
            conn,
            paper_id,
            asset_id,
            display_name,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    conn.commit()
    return build_paper_asset_payload(asset, cfg=load_config(), conn=conn)


@router.get("/papers/{paper_id}/assets/{asset_id}/file")
def get_paper_asset_file(paper_id: int, asset_id: int, conn=Depends(get_conn)):
    if get_paper(conn, paper_id) is None:
        raise HTTPException(status_code=404, detail=f"Paper {paper_id} not found.")
    asset = get_paper_asset(conn, paper_id, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail=f"Paper asset {asset_id} not found for paper {paper_id}.")
    if asset.kind != AssetKind.PDF:
        raise HTTPException(status_code=400, detail=f"Asset {asset_id} is not a PDF.")

    cfg = load_config()
    health = asset_file_health(asset.managed_path, cfg=cfg)
    if health.status == AssetFileStatus.INVALID_PATH:
        raise HTTPException(status_code=400, detail=health.error or "Invalid managed asset path.")
    if health.status == AssetFileStatus.NOT_MANAGED:
        raise HTTPException(status_code=404, detail=f"PDF file for asset {asset_id} is not managed by Claudesk.")
    if not health.file_exists or health.resolved_path is None:
        raise HTTPException(status_code=404, detail=f"Managed PDF file for asset {asset_id} was not found.")
    if not health.resolved_path.is_file():
        raise HTTPException(status_code=400, detail="Managed PDF path is not a file.")

    filename = (asset.display_name or asset.original_filename or f"asset-{asset.id or 0}.pdf").strip()
    if not filename.casefold().endswith(".pdf"):
        filename = f"{filename}.pdf"

    return FileResponse(
        str(health.resolved_path),
        media_type="application/pdf",
        filename=filename,
        content_disposition_type="inline",
    )


@router.post("/papers/{paper_id}/assets/{asset_id}/parse")
def parse_paper_asset(paper_id: int, asset_id: int, conn=Depends(get_conn)):
    if get_paper(conn, paper_id) is None:
        raise HTTPException(status_code=404, detail=f"Paper {paper_id} not found.")
    asset = get_paper_asset(conn, paper_id, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail=f"Paper asset {asset_id} not found for paper {paper_id}.")
    if asset.kind != AssetKind.PDF:
        raise HTTPException(status_code=400, detail=f"Asset {asset_id} is not a PDF.")

    cfg = load_config()
    response_asset = asset
    with _parse_job_lock:
        job = get_active_job_by_kind_dedupe_key(
            conn,
            PDF_PARSE_JOB_KIND,
            _pdf_parse_dedupe_key(asset_id),
        )
        if job is not None:
            launch_state = "already_running"
            response_asset = get_paper_asset(conn, paper_id, asset_id) or asset
        else:
            parser_name, parser_version = selected_pdf_parser_metadata(cfg)
            job = create_job(
                conn,
                kind=PDF_PARSE_JOB_KIND,
                request={"paper_id": paper_id, "asset_id": asset_id},
                resource_kind="asset",
                resource_id=asset_id,
                dedupe_key=_pdf_parse_dedupe_key(asset_id),
                machine_id=default_machine_id(),
                executor_kind="thread",
                executor_meta={"endpoint": "POST /api/papers/{paper_id}/assets/{asset_id}/parse"},
            )
            _record_pdf_parse_progress(
                conn,
                job.id,
                _pdf_parse_progress(
                    "queued",
                    "PDF parse queued.",
                    paper_id=paper_id,
                    asset_id=asset_id,
                ),
            )
            asset = update_asset_parse_state(
                conn,
                asset_id,
                parse_status=AssetParseStatus.QUEUED,
                parser_name=parser_name,
                parser_version=parser_version,
                parse_error=None,
            )
            conn.commit()
            response_asset = asset
            try:
                thread = threading.Thread(
                    target=_run_parse_job,
                    args=(job.id, paper_id, asset_id),
                    daemon=True,
                )
                _parse_threads[job.id] = thread
                thread.start()
            except Exception as exc:
                _parse_threads.pop(job.id, None)
                _fail_pdf_parse_job(
                    conn,
                    job.id,
                    paper_id=paper_id,
                    asset_id=asset_id,
                    error_type=type(exc).__name__,
                    message=f"Failed to start PDF parse worker: {exc}",
                    retryable=True,
                    cfg=cfg,
                )
                conn.commit()
                raise HTTPException(
                    status_code=500,
                    detail="PDF parse worker could not be started.",
                ) from exc
            launch_state = "started"
    return {
        "ok": True,
        "launch_state": launch_state,
        "asset": build_paper_asset_payload(response_asset, cfg=cfg, conn=conn),
    }


@router.delete("/papers/{paper_id}/assets/{asset_id}")
def remove_paper_asset(paper_id: int, asset_id: int, conn=Depends(get_conn)):
    if get_paper(conn, paper_id) is None:
        raise HTTPException(status_code=404, detail=f"Paper {paper_id} not found.")

    cfg = load_config()
    try:
        asset = get_paper_asset(conn, paper_id, asset_id)
        if asset is None:
            raise ValueError(f"Paper asset {asset_id} not found for paper {paper_id}.")
        _cleanup_asset_files_if_orphaned(conn, asset, cfg=cfg)
        delete_paper_asset(conn, paper_id, asset_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    conn.commit()
    return {"ok": True}


@router.get("/papers/{paper_id}")
def get_paper_by_id(paper_id: int, conn=Depends(get_conn)):
    paper = get_paper(conn, paper_id)
    if paper is None:
        raise HTTPException(status_code=404, detail=f"Paper {paper_id} not found.")
    return paper.model_dump(exclude={"embedding"})


@router.delete("/papers/{paper_id}")
def remove_paper(paper_id: int, conn=Depends(get_conn)):
    if get_paper(conn, paper_id) is None:
        raise HTTPException(status_code=404, detail=f"Paper {paper_id} not found.")
    cfg = load_config()
    for asset in list_paper_assets(conn, paper_id):
        _cleanup_asset_files_if_orphaned(conn, asset, cfg=cfg)
    try:
        delete_paper(conn, paper_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    conn.commit()
    return {"ok": True}


@router.patch("/papers/{paper_id}/status")
def set_paper_status(paper_id: int, body: StatusUpdate, conn=Depends(get_conn)):
    try:
        status_update = apply_paper_signal(conn, paper_id, body.status)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    conn.commit()
    return {"ok": True, "status": status_update.effective_status.value}


@router.patch("/papers/{paper_id}/abstract")
def set_paper_abstract(paper_id: int, body: AbstractUpdate, conn=Depends(get_conn)):
    abstract = body.abstract.strip()
    try:
        update_paper_abstract(conn, paper_id, abstract)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    conn.commit()
    return {"ok": True, "abstract": abstract}
