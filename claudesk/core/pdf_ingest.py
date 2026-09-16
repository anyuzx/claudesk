from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path

from claudesk.core import pdf_ingest_parsers as parsers
from claudesk.core import pdf_ingest_rendering as rendering
from claudesk.core.config import Config
from claudesk.core.db.assets import (
    get_asset,
    get_paper_asset,
    list_asset_pdf_pages,
    list_asset_text_chunks,
    update_asset_parse_state,
)
from claudesk.core.models import AssetKind, AssetParseStatus, PaperAsset
from claudesk.core.pdf_ingest_cache import (
    asset_uses_chat_attachment_storage,
    clear_pdf_ingest_cache,
    delete_pdf_page_image_files,
    delete_pdf_parse_artifact_files,
    pdf_cache_is_current,
    resolve_asset_managed_path,
    write_pdf_ingest_cache,
)
from claudesk.core.pdf_ingest_models import (
    DEFAULT_RENDER_DPI,
    NORMALIZED_SCHEMA_VERSION,
    PARSER_NAME,
    PARSER_VERSION,
    NormalizedParseOutput,
    NormalizedPdfBlock,
    NormalizedPdfDocument,
    ParseArtifactContent,
    PdfIngestError,
    PdfIngestResult,
    RenderedPdfPage,
)


selected_pdf_parser_metadata = parsers.selected_pdf_parser_metadata


def _require_paper_pdf_asset(
    conn: sqlite3.Connection,
    paper_id: int,
    asset_id: int,
) -> PaperAsset:
    asset = get_paper_asset(conn, paper_id, asset_id)
    if asset is None:
        raise PdfIngestError(f"Paper asset {asset_id} not found for paper {paper_id}.")
    if asset.kind != AssetKind.PDF:
        raise PdfIngestError(f"Asset {asset_id} is not a PDF.")
    if not asset.managed_path:
        raise PdfIngestError(f"Asset {asset_id} has no managed file path.")
    return asset


def _require_pdf_asset(
    conn: sqlite3.Connection,
    asset_id: int,
) -> PaperAsset:
    asset = get_asset(conn, asset_id)
    if asset is None:
        raise PdfIngestError(f"Asset {asset_id} not found.")
    if asset.kind != AssetKind.PDF:
        raise PdfIngestError(f"Asset {asset_id} is not a PDF.")
    if not asset.managed_path:
        raise PdfIngestError(f"Asset {asset_id} has no managed file path.")
    return asset


def _commit_if_open(conn: sqlite3.Connection) -> None:
    if conn.in_transaction:
        conn.commit()


def ensure_asset_pdf_ingested(
    conn: sqlite3.Connection,
    *,
    asset_id: int,
    cfg: Config | None = None,
    render_dpi: int = DEFAULT_RENDER_DPI,
) -> PdfIngestResult:
    asset = _require_pdf_asset(conn, asset_id)
    resolved_asset_id = asset.id or asset_id
    parser_name = parsers.selected_pdf_parser(cfg)
    effective_parser_name, effective_parser_version = parsers.parser_metadata(parser_name)
    if pdf_cache_is_current(
        conn,
        asset,
        parser_name=effective_parser_name,
        parser_version=effective_parser_version,
        render_dpi=render_dpi,
    ):
        return PdfIngestResult(
            asset=asset,
            pages=list_asset_pdf_pages(conn, resolved_asset_id),
            chunks=list_asset_text_chunks(conn, resolved_asset_id, start_chunk=0, limit=100000),
            cache_hit=True,
        )

    chat_storage = asset_uses_chat_attachment_storage(conn, resolved_asset_id)
    temp_render_dir: Path | None = None
    try:
        update_asset_parse_state(
            conn,
            resolved_asset_id,
            parse_status=AssetParseStatus.QUEUED,
            parser_name=effective_parser_name,
            parser_version=effective_parser_version,
            parse_error=None,
        )
        _commit_if_open(conn)
        path = resolve_asset_managed_path(
            asset.managed_path or "",
            chat_storage=chat_storage,
            cfg=cfg,
        )
        if not path.exists():
            raise PdfIngestError(f"Managed PDF file not found for asset {resolved_asset_id}.")

        parse_output = parsers.normalize_pdf_document(path, parser_name)
        normalized = parse_output.document
        temp_render_dir, rendered_pages = rendering.render_pdf_pages(
            asset_id=resolved_asset_id,
            path=path,
            page_texts=normalized.page_texts,
            render_dpi=render_dpi,
            chat_storage=chat_storage,
            cfg=cfg,
        )
        artifacts = [
            *parse_output.artifacts,
            parsers.json_artifact(
                "normalized_json",
                parsers.normalized_document_payload(normalized),
            ),
        ]

        write_pdf_ingest_cache(
            conn,
            asset_id=resolved_asset_id,
            parser_name=effective_parser_name,
            parser_version=effective_parser_version,
            normalized=normalized,
            artifacts=artifacts,
            rendered_pages=rendered_pages,
            chat_storage=chat_storage,
            cfg=cfg,
        )

        parsed_asset = update_asset_parse_state(
            conn,
            resolved_asset_id,
            parse_status=AssetParseStatus.PARSED,
            parser_name=effective_parser_name,
            parser_version=effective_parser_version,
            parse_error=None,
        )
        _commit_if_open(conn)
        return PdfIngestResult(
            asset=parsed_asset,
            pages=list_asset_pdf_pages(conn, resolved_asset_id),
            chunks=list_asset_text_chunks(conn, resolved_asset_id, start_chunk=0, limit=100000),
            cache_hit=False,
        )
    except PdfIngestError as exc:
        clear_pdf_ingest_cache(conn, resolved_asset_id, cfg=cfg, chat_storage=chat_storage)
        update_asset_parse_state(
            conn,
            resolved_asset_id,
            parse_status=AssetParseStatus.FAILED,
            parser_name=effective_parser_name,
            parser_version=effective_parser_version,
            parse_error=str(exc),
        )
        _commit_if_open(conn)
        raise
    except Exception as exc:  # pragma: no cover - covered through mocked failures later.
        clear_pdf_ingest_cache(conn, resolved_asset_id, cfg=cfg, chat_storage=chat_storage)
        message = f"Failed to parse PDF asset {resolved_asset_id}: {exc}"
        update_asset_parse_state(
            conn,
            resolved_asset_id,
            parse_status=AssetParseStatus.FAILED,
            parser_name=effective_parser_name,
            parser_version=effective_parser_version,
            parse_error=message,
        )
        _commit_if_open(conn)
        raise PdfIngestError(message) from exc
    finally:
        if temp_render_dir is not None:
            shutil.rmtree(temp_render_dir, ignore_errors=True)


def ensure_pdf_ingested(
    conn: sqlite3.Connection,
    *,
    paper_id: int,
    asset_id: int,
    cfg: Config | None = None,
    render_dpi: int = DEFAULT_RENDER_DPI,
) -> PdfIngestResult:
    _require_paper_pdf_asset(conn, paper_id, asset_id)
    return ensure_asset_pdf_ingested(
        conn,
        asset_id=asset_id,
        cfg=cfg,
        render_dpi=render_dpi,
    )


def refresh_asset_from_db(conn: sqlite3.Connection, asset_id: int) -> PaperAsset:
    asset = get_asset(conn, asset_id)
    if asset is None:
        raise PdfIngestError(f"Asset {asset_id} not found.")
    return asset
