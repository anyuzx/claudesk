from __future__ import annotations

import hashlib
import shutil
import sqlite3
from pathlib import Path

from claudesk.core.config import Config
from claudesk.core.db.assets import (
    clear_asset_pdf_cache,
    count_asset_document_blocks,
    count_asset_page_images,
    count_asset_pdf_pages,
    create_asset_parse_artifact,
    insert_asset_document_block,
    insert_asset_text_chunk,
    list_asset_parse_artifacts,
    list_asset_pdf_pages,
    upsert_asset_pdf_page,
)
from claudesk.core.models import AssetParseStatus, PaperAsset
from claudesk.core.paper_assets import (
    InvalidPaperAssetFile,
    prune_empty_chat_attachment_directory,
    prune_empty_managed_directory,
    resolve_chat_attachment_path,
    resolve_managed_asset_path,
)
from claudesk.core.pdf_ingest_models import (
    CHUNK_OVERLAP,
    CHUNK_SIZE,
    DEFAULT_RENDER_DPI,
    PARSER_NAME,
    PARSER_VERSION,
    NormalizedPdfDocument,
    ParseArtifactContent,
    RenderedPdfPage,
)


def page_image_managed_path(asset_id: int, page_number: int, render_dpi: int) -> str:
    return f"derived/pdf-pages/{asset_id}/page-{page_number:04d}-dpi{render_dpi}.png"


def parse_artifact_managed_path(
    asset_id: int,
    parser_name: str,
    artifact_kind: str,
    extension: str,
) -> str:
    safe_parser = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in parser_name)
    safe_kind = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in artifact_kind)
    safe_extension = extension.lstrip(".") or "txt"
    return f"derived/pdf-parse/{asset_id}/{safe_parser}-{safe_kind}.{safe_extension}"


def asset_uses_chat_attachment_storage(conn: sqlite3.Connection, asset_id: int) -> bool:
    row = conn.execute(
        "SELECT 1 FROM chat_attachments WHERE asset_id=? LIMIT 1",
        (asset_id,),
    ).fetchone()
    return row is not None


def resolve_asset_managed_path(
    managed_path: str,
    *,
    chat_storage: bool,
    cfg: Config | None = None,
    create_root: bool = True,
) -> Path:
    if chat_storage:
        return resolve_chat_attachment_path(managed_path, cfg=cfg, create_root=create_root)
    return resolve_managed_asset_path(managed_path, cfg=cfg, create_root=create_root)


def prune_asset_managed_directory(
    managed_path: str,
    *,
    chat_storage: bool,
    cfg: Config | None = None,
) -> None:
    if chat_storage:
        prune_empty_chat_attachment_directory(managed_path, cfg=cfg)
    else:
        prune_empty_managed_directory(managed_path, cfg=cfg)


def pdf_cache_is_current(
    conn: sqlite3.Connection,
    asset: PaperAsset,
    *,
    parser_name: str = PARSER_NAME,
    parser_version: str = PARSER_VERSION,
    render_dpi: int = DEFAULT_RENDER_DPI,
) -> bool:
    if asset.id is None:
        return False
    if asset.parse_status != AssetParseStatus.PARSED:
        return False
    if asset.parser_name != parser_name or asset.parser_version != parser_version:
        return False
    pages = count_asset_pdf_pages(conn, asset.id)
    if pages <= 0:
        return False
    blocks = count_asset_document_blocks(conn, asset.id)
    if blocks <= 0:
        return False
    rendered = count_asset_page_images(conn, asset.id)
    if rendered != pages:
        return False
    stale_rows = conn.execute(
        """
        SELECT COUNT(*)
        FROM asset_pdf_pages
        WHERE asset_id=? AND render_dpi!=?
        """,
        (asset.id, render_dpi),
    ).fetchone()[0]
    return int(stale_rows) == 0


def delete_pdf_page_image_files(
    conn: sqlite3.Connection,
    asset_id: int,
    *,
    cfg: Config | None = None,
    chat_storage: bool | None = None,
) -> None:
    uses_chat_storage = (
        asset_uses_chat_attachment_storage(conn, asset_id) if chat_storage is None else chat_storage
    )
    for page in list_asset_pdf_pages(conn, asset_id):
        if not page.image_managed_path:
            continue
        try:
            path = resolve_asset_managed_path(
                page.image_managed_path,
                chat_storage=uses_chat_storage,
                cfg=cfg,
                create_root=False,
            )
        except InvalidPaperAssetFile:
            continue
        try:
            path.unlink()
        except FileNotFoundError:
            continue
    prune_asset_managed_directory(
        f"derived/pdf-pages/{asset_id}",
        chat_storage=uses_chat_storage,
        cfg=cfg,
    )


def delete_pdf_parse_artifact_files(
    conn: sqlite3.Connection,
    asset_id: int,
    *,
    cfg: Config | None = None,
    chat_storage: bool | None = None,
) -> None:
    uses_chat_storage = (
        asset_uses_chat_attachment_storage(conn, asset_id) if chat_storage is None else chat_storage
    )
    for artifact in list_asset_parse_artifacts(conn, asset_id):
        if not artifact.managed_path:
            continue
        try:
            path = resolve_asset_managed_path(
                artifact.managed_path,
                chat_storage=uses_chat_storage,
                cfg=cfg,
                create_root=False,
            )
        except InvalidPaperAssetFile:
            continue
        try:
            path.unlink()
        except FileNotFoundError:
            continue
    prune_asset_managed_directory(
        f"derived/pdf-parse/{asset_id}",
        chat_storage=uses_chat_storage,
        cfg=cfg,
    )


def clear_pdf_ingest_cache(
    conn: sqlite3.Connection,
    asset_id: int,
    *,
    cfg: Config | None = None,
    chat_storage: bool | None = None,
) -> None:
    uses_chat_storage = (
        asset_uses_chat_attachment_storage(conn, asset_id) if chat_storage is None else chat_storage
    )
    delete_pdf_page_image_files(conn, asset_id, cfg=cfg, chat_storage=uses_chat_storage)
    delete_pdf_parse_artifact_files(conn, asset_id, cfg=cfg, chat_storage=uses_chat_storage)
    clear_asset_pdf_cache(conn, asset_id)


def _split_page_text(text: str) -> list[str]:
    clean = text.strip()
    if not clean:
        return []
    chunks: list[str] = []
    start = 0
    text_length = len(clean)
    while start < text_length:
        hard_end = min(text_length, start + CHUNK_SIZE)
        end = hard_end
        if hard_end < text_length:
            split_candidates = [
                clean.rfind("\n\n", start, hard_end),
                clean.rfind("\n", start, hard_end),
                clean.rfind(". ", start, hard_end),
                clean.rfind(" ", start, hard_end),
            ]
            split_at = max(split_candidates)
            if split_at > start + (CHUNK_SIZE // 2):
                end = split_at + 1
        chunk = clean[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= text_length:
            break
        next_start = max(end - CHUNK_OVERLAP, start + 1)
        while next_start < text_length and clean[next_start].isspace():
            next_start += 1
        start = next_start
    return chunks


def _write_parse_artifact(
    conn: sqlite3.Connection,
    *,
    asset_id: int,
    parser_name: str,
    parser_version: str,
    artifact: ParseArtifactContent,
    chat_storage: bool,
    cfg: Config | None,
) -> None:
    managed_path = parse_artifact_managed_path(
        asset_id,
        parser_name,
        artifact.artifact_kind,
        artifact.extension,
    )
    path = resolve_asset_managed_path(managed_path, chat_storage=chat_storage, cfg=cfg)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(artifact.content)
    create_asset_parse_artifact(
        conn,
        asset_id=asset_id,
        artifact_kind=artifact.artifact_kind,
        parser_name=parser_name,
        parser_version=parser_version,
        managed_path=managed_path,
        mime_type=artifact.mime_type,
        size_bytes=len(artifact.content),
        content_hash=hashlib.sha256(artifact.content).hexdigest(),
    )


def _cache_rendered_pdf_pages(
    conn: sqlite3.Connection,
    *,
    asset_id: int,
    pages: list[RenderedPdfPage],
    chat_storage: bool,
    cfg: Config | None,
) -> None:
    for page in pages:
        image_path = resolve_asset_managed_path(
            page.image_managed_path,
            chat_storage=chat_storage,
            cfg=cfg,
        )
        image_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(page.temp_image_path), str(image_path))
        upsert_asset_pdf_page(
            conn,
            asset_id=asset_id,
            page_number=page.page_number,
            text=page.text,
            page_width=page.page_width,
            page_height=page.page_height,
            image_managed_path=page.image_managed_path,
            image_width=page.image_width,
            image_height=page.image_height,
            render_dpi=page.render_dpi,
        )


def write_pdf_ingest_cache(
    conn: sqlite3.Connection,
    *,
    asset_id: int,
    parser_name: str,
    parser_version: str,
    normalized: NormalizedPdfDocument,
    artifacts: list[ParseArtifactContent],
    rendered_pages: list[RenderedPdfPage],
    chat_storage: bool,
    cfg: Config | None,
) -> None:
    clear_pdf_ingest_cache(conn, asset_id, cfg=cfg, chat_storage=chat_storage)
    for artifact in artifacts:
        _write_parse_artifact(
            conn,
            asset_id=asset_id,
            parser_name=parser_name,
            parser_version=parser_version,
            artifact=artifact,
            chat_storage=chat_storage,
            cfg=cfg,
        )
    _cache_rendered_pdf_pages(
        conn,
        asset_id=asset_id,
        pages=rendered_pages,
        chat_storage=chat_storage,
        cfg=cfg,
    )

    chunk_index = 0
    for block in normalized.blocks:
        stored_block = insert_asset_document_block(
            conn,
            asset_id=asset_id,
            block_index=block.block_index,
            page_number=block.page_number,
            block_type=block.block_type,
            section_path=block.section_path,
            text=block.text,
            bbox=block.bbox,
            metadata=block.metadata,
        )
        for chunk_text in _split_page_text(block.text):
            insert_asset_text_chunk(
                conn,
                asset_id=asset_id,
                chunk_index=chunk_index,
                page_number=block.page_number,
                text=chunk_text,
                block_type=block.block_type,
                section_path=block.section_path,
                bbox=block.bbox,
                block_ids=[stored_block.id or 0],
            )
            chunk_index += 1
