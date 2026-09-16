from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from typing import Optional, Sequence

from claudesk.core.paper_assets import (
    EXCALIDRAW_ASSET_MIME_TYPE,
    EXCALIDRAW_ASSET_SOURCE,
    MARKDOWN_IMAGE_MIME_TYPES,
    InvalidPaperAssetFile,
    delete_managed_asset_file,
)

from claudesk.core.models import (
    AssetKind,
    AssetDocumentBlock,
    AssetParseArtifact,
    AssetPdfPage,
    AssetParseStatus,
    AssetTextChunk,
    ChatAttachment,
    ChatAttachmentKind,
    ChatContextItem,
    ChatMessage,
    ChatResourceRead,
    ChatResourceReadInput,
    ChatResourceReadSource,
    ChatSessionDetail,
    ChatSessionSummary,
    ChatTraceEntry,
    LogEntry,
    LogTaskSubtask,
    ManualLogEntry,
    Note,
    Paper,
    PaperAsset,
    PaperPdfStatus,
    PaperScoreRubric,
    PaperSignal,
    PaperStatus,
    Project,
    ProjectListMetric,
    ProjectMilestone,
    ProjectMilestoneKind,
    ProjectMilestoneStatus,
    ProjectPaperRole,
    ProjectProgressSummary,
    ProjectStatus,
    Todo,
    TodoPriority,
    TodoStatus,
)

from .utils import (
    _decode_bbox,
    _decode_json_dict,
    _decode_json_list,
    _encode_json,
    _parse_datetime_text,
    _rank_fts_rows,
)


def _row_to_paper_asset(row: sqlite3.Row) -> PaperAsset:
    return PaperAsset(
        id=int(row["id"]),
        kind=AssetKind(row["kind"]),
        source=row["source"],
        managed_path=row["managed_path"],
        original_filename=row["original_filename"],
        display_name=row["display_name"],
        mime_type=row["mime_type"],
        size_bytes=int(row["size_bytes"]),
        content_hash=row["content_hash"],
        parse_status=AssetParseStatus(row["parse_status"]),
        parser_name=row["parser_name"],
        parser_version=row["parser_version"],
        source_asset_id=row["source_asset_id"],
        parsed_text=row["parsed_text"],
        parse_error=row["parse_error"],
        parsed_at=_parse_datetime_text(row["parsed_at"]),
        created_at=datetime.fromisoformat(row["created_at"]),
        updated_at=datetime.fromisoformat(row["updated_at"]),
    )


def get_asset(conn: sqlite3.Connection, asset_id: int) -> Optional[PaperAsset]:
    row = conn.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
    return _row_to_paper_asset(row) if row is not None else None


def count_asset_owners(conn: sqlite3.Connection, asset_id: int) -> int:
    counts = [
        int(conn.execute(
            "SELECT COUNT(*) FROM paper_assets WHERE asset_id=?",
            (asset_id,),
        ).fetchone()[0]),
        int(conn.execute(
            "SELECT COUNT(*) FROM note_assets WHERE asset_id=?",
            (asset_id,),
        ).fetchone()[0]),
        int(conn.execute(
            "SELECT COUNT(*) FROM chat_attachments WHERE asset_id=?",
            (asset_id,),
        ).fetchone()[0]),
    ]
    return sum(counts)


def _delete_asset_if_unowned(conn: sqlite3.Connection, asset_id: int) -> bool:
    if count_asset_owners(conn, asset_id) != 0:
        return False
    asset = get_asset(conn, asset_id)
    if asset is not None and (
        _is_managed_markdown_image_asset(asset) or _is_managed_excalidraw_asset(asset)
    ):
        try:
            delete_managed_asset_file(asset.managed_path)
        except InvalidPaperAssetFile:
            pass
    conn.execute("DELETE FROM assets WHERE id=?", (asset_id,))
    return True


def _is_managed_markdown_image_asset(asset: PaperAsset) -> bool:
    managed_path = asset.managed_path or ""
    return (
        asset.kind == AssetKind.ATTACHMENT
        and asset.source == "note_image"
        and asset.mime_type.casefold() in MARKDOWN_IMAGE_MIME_TYPES
        and managed_path.startswith("images/")
    )


def _is_managed_excalidraw_asset(asset: PaperAsset) -> bool:
    managed_path = asset.managed_path or ""
    return (
        asset.kind == AssetKind.ATTACHMENT
        and asset.source == EXCALIDRAW_ASSET_SOURCE
        and asset.mime_type.casefold() == EXCALIDRAW_ASSET_MIME_TYPE
        and managed_path.startswith("drawings/")
    )


def _insert_asset(
    conn: sqlite3.Connection,
    *,
    kind: AssetKind,
    source: str,
    managed_path: Optional[str],
    original_filename: str,
    display_name: Optional[str],
    mime_type: str,
    size_bytes: int,
    content_hash: str,
    parse_status: AssetParseStatus,
    parser_name: Optional[str] = None,
    parser_version: Optional[str] = None,
    source_asset_id: Optional[int] = None,
    parsed_text: Optional[str] = None,
    parse_error: Optional[str] = None,
    parsed_at: Optional[datetime] = None,
    created_at: Optional[datetime] = None,
) -> tuple[int, datetime]:
    now = created_at or datetime.now(timezone.utc).replace(tzinfo=None)
    visible_name = display_name.strip() if display_name else original_filename
    cur = conn.execute(
        """
        INSERT INTO assets (
            kind, source, managed_path, original_filename, display_name, mime_type, size_bytes,
            content_hash, parse_status, parser_name, parser_version, source_asset_id,
            parsed_text, parse_error, parsed_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            kind.value,
            source,
            managed_path,
            original_filename,
            visible_name,
            mime_type,
            size_bytes,
            content_hash,
            parse_status.value,
            parser_name,
            parser_version,
            source_asset_id,
            parsed_text,
            parse_error,
            parsed_at.isoformat() if parsed_at else None,
            now.isoformat(),
            now.isoformat(),
        ),
    )
    return int(cur.lastrowid), now  # type: ignore[arg-type]


def create_paper_asset(
    conn: sqlite3.Connection,
    paper_id: int,
    *,
    kind: AssetKind = AssetKind.PDF,
    source: str = "manual",
    managed_path: Optional[str],
    original_filename: str,
    display_name: Optional[str] = None,
    mime_type: str,
    size_bytes: int,
    content_hash: str,
    parse_status: AssetParseStatus = AssetParseStatus.NOT_PARSED,
    parser_name: Optional[str] = None,
    parser_version: Optional[str] = None,
    source_asset_id: Optional[int] = None,
    parsed_text: Optional[str] = None,
    parse_error: Optional[str] = None,
    parsed_at: Optional[datetime] = None,
    created_at: Optional[datetime] = None,
) -> PaperAsset:
    if conn.execute("SELECT id FROM papers WHERE id=?", (paper_id,)).fetchone() is None:
        raise ValueError(f"Paper {paper_id} not found.")

    asset_id, now = _insert_asset(
        conn,
        kind=kind,
        source=source,
        managed_path=managed_path,
        original_filename=original_filename,
        display_name=display_name,
        mime_type=mime_type,
        size_bytes=size_bytes,
        content_hash=content_hash,
        parse_status=parse_status,
        parser_name=parser_name,
        parser_version=parser_version,
        source_asset_id=source_asset_id,
        parsed_text=parsed_text,
        parse_error=parse_error,
        parsed_at=parsed_at,
        created_at=created_at,
    )
    conn.execute(
        """
        INSERT INTO paper_assets (paper_id, asset_id, created_at)
        VALUES (?, ?, ?)
        """,
        (paper_id, asset_id, now.isoformat()),
    )
    asset = get_asset(conn, asset_id)
    if asset is None:
        raise RuntimeError(f"Created asset {asset_id} could not be loaded.")
    return asset


def create_note_image_asset(
    conn: sqlite3.Connection,
    note_id: int,
    *,
    source: str = "note_image",
    managed_path: Optional[str],
    original_filename: str,
    display_name: Optional[str] = None,
    mime_type: str,
    size_bytes: int,
    content_hash: str,
    staged: bool = False,
    created_at: Optional[datetime] = None,
) -> PaperAsset:
    if conn.execute("SELECT id FROM notes WHERE id=?", (note_id,)).fetchone() is None:
        raise ValueError(f"Note {note_id} not found.")

    asset_id, now = _insert_asset(
        conn,
        kind=AssetKind.ATTACHMENT,
        source=source,
        managed_path=managed_path,
        original_filename=original_filename,
        display_name=display_name,
        mime_type=mime_type,
        size_bytes=size_bytes,
        content_hash=content_hash,
        parse_status=AssetParseStatus.NOT_PARSED,
        created_at=created_at,
    )
    conn.execute(
        """
        INSERT INTO note_assets (note_id, asset_id, status, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (note_id, asset_id, "staged" if staged else "committed", now.isoformat()),
    )
    asset = get_asset(conn, asset_id)
    if asset is None:
        raise RuntimeError(f"Created asset {asset_id} could not be loaded.")
    return asset


def create_note_drawing_asset(
    conn: sqlite3.Connection,
    note_id: int,
    *,
    managed_path: Optional[str],
    original_filename: str,
    display_name: Optional[str] = None,
    mime_type: str = EXCALIDRAW_ASSET_MIME_TYPE,
    size_bytes: int,
    content_hash: str,
    staged: bool = False,
    created_at: Optional[datetime] = None,
) -> PaperAsset:
    if conn.execute("SELECT id FROM notes WHERE id=?", (note_id,)).fetchone() is None:
        raise ValueError(f"Note {note_id} not found.")

    asset_id, now = _insert_asset(
        conn,
        kind=AssetKind.ATTACHMENT,
        source=EXCALIDRAW_ASSET_SOURCE,
        managed_path=managed_path,
        original_filename=original_filename,
        display_name=display_name,
        mime_type=mime_type,
        size_bytes=size_bytes,
        content_hash=content_hash,
        parse_status=AssetParseStatus.NOT_PARSED,
        created_at=created_at,
    )
    conn.execute(
        """
        INSERT INTO note_assets (note_id, asset_id, status, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (note_id, asset_id, "staged" if staged else "committed", now.isoformat()),
    )
    asset = get_asset(conn, asset_id)
    if asset is None:
        raise RuntimeError(f"Created drawing asset {asset_id} could not be loaded.")
    return asset


def get_note_drawing_asset(conn: sqlite3.Connection, asset_id: int) -> Optional[PaperAsset]:
    asset = get_asset(conn, asset_id)
    if asset is None or not _is_managed_excalidraw_asset(asset):
        return None
    return asset


def update_note_drawing_asset_metadata(
    conn: sqlite3.Connection,
    asset_id: int,
    *,
    size_bytes: int,
    content_hash: str,
    display_name: Optional[str] = None,
) -> PaperAsset:
    asset = get_note_drawing_asset(conn, asset_id)
    if asset is None:
        raise ValueError(f"Drawing asset {asset_id} not found.")
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    assignments = ["size_bytes=?", "content_hash=?", "updated_at=?"]
    params: list[object] = [size_bytes, content_hash, now.isoformat()]
    if display_name is not None:
        cleaned = display_name.strip()
        if not cleaned:
            raise ValueError("Drawing display name is required.")
        assignments.append("display_name=?")
        params.append(cleaned)
    params.append(asset_id)
    conn.execute(
        f"UPDATE assets SET {', '.join(assignments)} WHERE id=?",
        params,
    )
    updated = get_note_drawing_asset(conn, asset_id)
    if updated is None:
        raise RuntimeError(f"Updated drawing asset {asset_id} could not be loaded.")
    return updated


def update_paper_asset_display_name(
    conn: sqlite3.Connection,
    paper_id: int,
    asset_id: int,
    display_name: str,
) -> PaperAsset:
    asset = get_paper_asset(conn, paper_id, asset_id)
    if asset is None:
        raise ValueError(f"Paper asset {asset_id} not found for paper {paper_id}.")

    cleaned = display_name.strip()
    if not cleaned:
        raise ValueError("Asset display name is required.")

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    conn.execute(
        """
        UPDATE assets
        SET display_name=?, updated_at=?
        WHERE id=?
        """,
        (cleaned, now.isoformat(), asset_id),
    )
    updated = get_paper_asset(conn, paper_id, asset_id)
    if updated is None:
        raise RuntimeError(f"Updated asset {asset_id} could not be loaded.")
    return updated


def update_asset_parse_state(
    conn: sqlite3.Connection,
    asset_id: int,
    *,
    parse_status: AssetParseStatus,
    parser_name: Optional[str] = None,
    parser_version: Optional[str] = None,
    parse_error: Optional[str] = None,
    parsed_at: Optional[datetime] = None,
) -> PaperAsset:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    effective_parsed_at = parsed_at
    if parse_status == AssetParseStatus.PARSED and effective_parsed_at is None:
        effective_parsed_at = now
    conn.execute(
        """
        UPDATE assets
        SET parse_status=?,
            parser_name=?,
            parser_version=?,
            parse_error=?,
            parsed_at=?,
            updated_at=?
        WHERE id=?
        """,
        (
            parse_status.value,
            parser_name,
            parser_version,
            parse_error,
            effective_parsed_at.isoformat() if effective_parsed_at else None,
            now.isoformat(),
            asset_id,
        ),
    )
    asset = get_asset(conn, asset_id)
    if asset is None:
        raise ValueError(f"Asset {asset_id} not found.")
    return asset


def list_paper_assets(conn: sqlite3.Connection, paper_id: int) -> list[PaperAsset]:
    rows = conn.execute(
        """
        SELECT a.*
        FROM paper_assets pa
        JOIN assets a ON a.id = pa.asset_id
        WHERE pa.paper_id=?
        ORDER BY a.created_at DESC, a.id DESC
        """,
        (paper_id,),
    )
    return [_row_to_paper_asset(row) for row in rows]


def list_note_assets(conn: sqlite3.Connection, note_id: int) -> list[PaperAsset]:
    rows = conn.execute(
        """
        SELECT a.*
        FROM note_assets na
        JOIN assets a ON a.id = na.asset_id
        WHERE na.note_id=? AND na.status='committed'
        ORDER BY a.created_at DESC, a.id DESC
        """,
        (note_id,),
    ).fetchall()
    return [_row_to_paper_asset(row) for row in rows]


def delete_staged_note_image_asset(
    conn: sqlite3.Connection,
    note_id: int,
    asset_id: int,
) -> tuple[PaperAsset, bool]:
    row = conn.execute(
        """
        SELECT a.*
        FROM note_assets na
        JOIN assets a ON a.id = na.asset_id
        WHERE na.note_id=? AND na.asset_id=? AND na.status='staged'
        """,
        (note_id, asset_id),
    ).fetchone()
    if row is None:
        raise ValueError(f"Staged note image asset {asset_id} not found for note {note_id}.")

    conn.execute(
        "DELETE FROM note_assets WHERE note_id=? AND asset_id=? AND status='staged'",
        (note_id, asset_id),
    )
    deleted_asset = _delete_asset_if_unowned(conn, asset_id)
    return _row_to_paper_asset(row), deleted_asset


def delete_staged_note_drawing_asset(
    conn: sqlite3.Connection,
    note_id: int,
    asset_id: int,
) -> tuple[PaperAsset, bool]:
    row = conn.execute(
        """
        SELECT a.*
        FROM note_assets na
        JOIN assets a ON a.id = na.asset_id
        WHERE na.note_id=? AND na.asset_id=? AND na.status='staged'
          AND a.source=?
        """,
        (note_id, asset_id, EXCALIDRAW_ASSET_SOURCE),
    ).fetchone()
    if row is None:
        raise ValueError(f"Staged note drawing asset {asset_id} not found for note {note_id}.")

    conn.execute(
        "DELETE FROM note_assets WHERE note_id=? AND asset_id=? AND status='staged'",
        (note_id, asset_id),
    )
    deleted_asset = _delete_asset_if_unowned(conn, asset_id)
    return _row_to_paper_asset(row), deleted_asset


def get_paper_asset(
    conn: sqlite3.Connection,
    paper_id: int,
    asset_id: int,
) -> Optional[PaperAsset]:
    row = conn.execute(
        """
        SELECT a.*
        FROM paper_assets pa
        JOIN assets a ON a.id = pa.asset_id
        WHERE pa.paper_id=? AND pa.asset_id=?
        """,
        (paper_id, asset_id),
    ).fetchone()
    return _row_to_paper_asset(row) if row is not None else None


def delete_paper_asset(
    conn: sqlite3.Connection,
    paper_id: int,
    asset_id: int,
) -> tuple[PaperAsset, bool]:
    asset = get_paper_asset(conn, paper_id, asset_id)
    if asset is None:
        raise ValueError(f"Paper asset {asset_id} not found for paper {paper_id}.")

    conn.execute(
        "DELETE FROM paper_assets WHERE paper_id=? AND asset_id=?",
        (paper_id, asset_id),
    )
    deleted_asset = _delete_asset_if_unowned(conn, asset_id)
    return asset, deleted_asset


def _row_to_asset_pdf_page(row: sqlite3.Row) -> AssetPdfPage:
    return AssetPdfPage(
        asset_id=int(row["asset_id"]),
        page_number=int(row["page_number"]),
        text=row["text"],
        page_width=float(row["page_width"]),
        page_height=float(row["page_height"]),
        image_managed_path=row["image_managed_path"],
        image_width=int(row["image_width"]),
        image_height=int(row["image_height"]),
        render_dpi=int(row["render_dpi"]),
        created_at=datetime.fromisoformat(row["created_at"]),
        updated_at=datetime.fromisoformat(row["updated_at"]),
    )


def _row_to_asset_text_chunk(row: sqlite3.Row) -> AssetTextChunk:
    keys = set(row.keys())
    return AssetTextChunk(
        id=int(row["id"]),
        asset_id=int(row["asset_id"]),
        chunk_index=int(row["chunk_index"]),
        page_number=int(row["page_number"]),
        text=row["text"],
        char_count=int(row["char_count"]),
        block_type=row["block_type"] if "block_type" in keys else "paragraph",
        section_path=[
            str(item)
            for item in _decode_json_list(row["section_path"] if "section_path" in keys else "[]")
        ],
        bbox=_decode_bbox(row["bbox_json"] if "bbox_json" in keys else None),
        block_ids=[
            int(item)
            for item in _decode_json_list(row["block_ids"] if "block_ids" in keys else "[]")
            if isinstance(item, int) or (isinstance(item, str) and item.isdigit())
        ],
        created_at=datetime.fromisoformat(row["created_at"]),
        updated_at=datetime.fromisoformat(row["updated_at"]),
    )


def _row_to_asset_parse_artifact(row: sqlite3.Row) -> AssetParseArtifact:
    return AssetParseArtifact(
        id=int(row["id"]),
        asset_id=int(row["asset_id"]),
        artifact_kind=row["artifact_kind"],
        parser_name=row["parser_name"],
        parser_version=row["parser_version"],
        managed_path=row["managed_path"],
        mime_type=row["mime_type"],
        size_bytes=int(row["size_bytes"]),
        content_hash=row["content_hash"],
        created_at=datetime.fromisoformat(row["created_at"]),
    )


def _row_to_asset_document_block(row: sqlite3.Row) -> AssetDocumentBlock:
    return AssetDocumentBlock(
        id=int(row["id"]),
        asset_id=int(row["asset_id"]),
        block_index=int(row["block_index"]),
        page_number=int(row["page_number"]),
        block_type=row["block_type"],
        section_path=[str(item) for item in _decode_json_list(row["section_path"])],
        text=row["text"],
        bbox=_decode_bbox(row["bbox_json"]),
        image_managed_path=row["image_managed_path"],
        metadata=_decode_json_dict(row["metadata_json"]),
        created_at=datetime.fromisoformat(row["created_at"]),
        updated_at=datetime.fromisoformat(row["updated_at"]),
    )


def clear_asset_pdf_cache(conn: sqlite3.Connection, asset_id: int) -> None:
    conn.execute("DELETE FROM asset_text_chunks WHERE asset_id=?", (asset_id,))
    conn.execute("DELETE FROM asset_pdf_pages WHERE asset_id=?", (asset_id,))
    conn.execute("DELETE FROM asset_document_blocks WHERE asset_id=?", (asset_id,))
    conn.execute("DELETE FROM asset_parse_artifacts WHERE asset_id=?", (asset_id,))


def upsert_asset_pdf_page(
    conn: sqlite3.Connection,
    *,
    asset_id: int,
    page_number: int,
    text: str = "",
    page_width: float = 0,
    page_height: float = 0,
    image_managed_path: Optional[str] = None,
    image_width: int = 0,
    image_height: int = 0,
    render_dpi: int = 0,
    created_at: Optional[datetime] = None,
) -> AssetPdfPage:
    now = created_at or datetime.now(timezone.utc).replace(tzinfo=None)
    conn.execute(
        """
        INSERT INTO asset_pdf_pages (
            asset_id, page_number, text, page_width, page_height, image_managed_path,
            image_width, image_height, render_dpi, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(asset_id, page_number) DO UPDATE SET
            text=excluded.text,
            page_width=excluded.page_width,
            page_height=excluded.page_height,
            image_managed_path=excluded.image_managed_path,
            image_width=excluded.image_width,
            image_height=excluded.image_height,
            render_dpi=excluded.render_dpi,
            updated_at=excluded.updated_at
        """,
        (
            asset_id,
            page_number,
            text,
            page_width,
            page_height,
            image_managed_path,
            image_width,
            image_height,
            render_dpi,
            now.isoformat(),
            now.isoformat(),
        ),
    )
    page = get_asset_pdf_page(conn, asset_id, page_number)
    if page is None:
        raise RuntimeError(f"PDF page {asset_id}:{page_number} could not be loaded.")
    return page


def get_asset_pdf_page(
    conn: sqlite3.Connection,
    asset_id: int,
    page_number: int,
) -> Optional[AssetPdfPage]:
    row = conn.execute(
        """
        SELECT *
        FROM asset_pdf_pages
        WHERE asset_id=? AND page_number=?
        """,
        (asset_id, page_number),
    ).fetchone()
    return _row_to_asset_pdf_page(row) if row is not None else None


def list_asset_pdf_pages(conn: sqlite3.Connection, asset_id: int) -> list[AssetPdfPage]:
    rows = conn.execute(
        """
        SELECT *
        FROM asset_pdf_pages
        WHERE asset_id=?
        ORDER BY page_number ASC
        """,
        (asset_id,),
    ).fetchall()
    return [_row_to_asset_pdf_page(row) for row in rows]


def create_asset_parse_artifact(
    conn: sqlite3.Connection,
    *,
    asset_id: int,
    artifact_kind: str,
    parser_name: str,
    parser_version: str,
    managed_path: Optional[str] = None,
    mime_type: str = "",
    size_bytes: int = 0,
    content_hash: str = "",
    created_at: Optional[datetime] = None,
) -> AssetParseArtifact:
    now = created_at or datetime.now(timezone.utc).replace(tzinfo=None)
    cur = conn.execute(
        """
        INSERT INTO asset_parse_artifacts (
            asset_id, artifact_kind, parser_name, parser_version, managed_path,
            mime_type, size_bytes, content_hash, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            asset_id,
            artifact_kind,
            parser_name,
            parser_version,
            managed_path,
            mime_type,
            int(size_bytes),
            content_hash,
            now.isoformat(),
        ),
    )
    row = conn.execute(
        "SELECT * FROM asset_parse_artifacts WHERE id=?",
        (int(cur.lastrowid),),
    ).fetchone()
    if row is None:
        raise RuntimeError(f"Parse artifact {asset_id}:{artifact_kind} could not be loaded.")
    return _row_to_asset_parse_artifact(row)


def list_asset_parse_artifacts(
    conn: sqlite3.Connection,
    asset_id: int,
    *,
    artifact_kind: Optional[str] = None,
) -> list[AssetParseArtifact]:
    params: list[object] = [asset_id]
    where = "asset_id=?"
    if artifact_kind:
        where += " AND artifact_kind=?"
        params.append(artifact_kind)
    rows = conn.execute(
        f"""
        SELECT *
        FROM asset_parse_artifacts
        WHERE {where}
        ORDER BY created_at DESC, id DESC
        """,
        tuple(params),
    ).fetchall()
    return [_row_to_asset_parse_artifact(row) for row in rows]


def count_asset_parse_artifacts(conn: sqlite3.Connection, asset_id: int) -> int:
    return int(conn.execute(
        "SELECT COUNT(*) FROM asset_parse_artifacts WHERE asset_id=?",
        (asset_id,),
    ).fetchone()[0])


def insert_asset_document_block(
    conn: sqlite3.Connection,
    *,
    asset_id: int,
    block_index: int,
    page_number: int,
    block_type: str = "paragraph",
    section_path: Optional[Sequence[str]] = None,
    text: str = "",
    bbox: Optional[Sequence[float]] = None,
    image_managed_path: Optional[str] = None,
    metadata: Optional[dict[str, object]] = None,
    created_at: Optional[datetime] = None,
) -> AssetDocumentBlock:
    now = created_at or datetime.now(timezone.utc).replace(tzinfo=None)
    bbox_json = _encode_json([float(item) for item in bbox]) if bbox is not None else None
    conn.execute(
        """
        INSERT INTO asset_document_blocks (
            asset_id, block_index, page_number, block_type, section_path, text,
            bbox_json, image_managed_path, metadata_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(asset_id, block_index) DO UPDATE SET
            page_number=excluded.page_number,
            block_type=excluded.block_type,
            section_path=excluded.section_path,
            text=excluded.text,
            bbox_json=excluded.bbox_json,
            image_managed_path=excluded.image_managed_path,
            metadata_json=excluded.metadata_json,
            updated_at=excluded.updated_at
        """,
        (
            asset_id,
            block_index,
            page_number,
            block_type or "paragraph",
            _encode_json(list(section_path or [])),
            text or "",
            bbox_json,
            image_managed_path,
            _encode_json(metadata or {}),
            now.isoformat(),
            now.isoformat(),
        ),
    )
    row = conn.execute(
        "SELECT * FROM asset_document_blocks WHERE asset_id=? AND block_index=?",
        (asset_id, block_index),
    ).fetchone()
    if row is None:
        raise RuntimeError(f"Document block {asset_id}:{block_index} could not be loaded.")
    return _row_to_asset_document_block(row)


def list_asset_document_blocks(
    conn: sqlite3.Connection,
    asset_id: int,
    *,
    block_type: Optional[str] = None,
) -> list[AssetDocumentBlock]:
    params: list[object] = [asset_id]
    where = "asset_id=?"
    if block_type:
        where += " AND block_type=?"
        params.append(block_type)
    rows = conn.execute(
        f"""
        SELECT *
        FROM asset_document_blocks
        WHERE {where}
        ORDER BY block_index ASC
        """,
        tuple(params),
    ).fetchall()
    return [_row_to_asset_document_block(row) for row in rows]


def count_asset_document_blocks(conn: sqlite3.Connection, asset_id: int) -> int:
    return int(conn.execute(
        "SELECT COUNT(*) FROM asset_document_blocks WHERE asset_id=?",
        (asset_id,),
    ).fetchone()[0])


def insert_asset_text_chunk(
    conn: sqlite3.Connection,
    *,
    asset_id: int,
    chunk_index: int,
    page_number: int,
    text: str,
    block_type: str = "paragraph",
    section_path: Optional[Sequence[str]] = None,
    bbox: Optional[Sequence[float]] = None,
    block_ids: Optional[Sequence[int]] = None,
    created_at: Optional[datetime] = None,
) -> AssetTextChunk:
    now = created_at or datetime.now(timezone.utc).replace(tzinfo=None)
    bbox_json = _encode_json([float(item) for item in bbox]) if bbox is not None else None
    cur = conn.execute(
        """
        INSERT INTO asset_text_chunks (
            asset_id, chunk_index, page_number, text, char_count, block_type,
            section_path, bbox_json, block_ids, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            asset_id,
            chunk_index,
            page_number,
            text,
            len(text),
            block_type or "paragraph",
            _encode_json(list(section_path or [])),
            bbox_json,
            _encode_json([int(block_id) for block_id in block_ids or []]),
            now.isoformat(),
            now.isoformat(),
        ),
    )
    row = conn.execute(
        "SELECT * FROM asset_text_chunks WHERE id=?",
        (int(cur.lastrowid),),
    ).fetchone()
    if row is None:
        raise RuntimeError(f"PDF chunk {asset_id}:{chunk_index} could not be loaded.")
    return _row_to_asset_text_chunk(row)


def list_asset_text_chunks(
    conn: sqlite3.Connection,
    asset_id: int,
    *,
    start_chunk: int = 0,
    limit: int = 20,
) -> list[AssetTextChunk]:
    rows = conn.execute(
        """
        SELECT *
        FROM asset_text_chunks
        WHERE asset_id=? AND chunk_index>=?
        ORDER BY chunk_index ASC
        LIMIT ?
        """,
        (asset_id, max(0, start_chunk), max(1, limit)),
    ).fetchall()
    return [_row_to_asset_text_chunk(row) for row in rows]


def count_asset_pdf_pages(conn: sqlite3.Connection, asset_id: int) -> int:
    return int(conn.execute(
        "SELECT COUNT(*) FROM asset_pdf_pages WHERE asset_id=?",
        (asset_id,),
    ).fetchone()[0])


def count_asset_text_chunks(conn: sqlite3.Connection, asset_id: int) -> int:
    return int(conn.execute(
        "SELECT COUNT(*) FROM asset_text_chunks WHERE asset_id=?",
        (asset_id,),
    ).fetchone()[0])


def count_asset_page_images(conn: sqlite3.Connection, asset_id: int) -> int:
    return int(conn.execute(
        """
        SELECT COUNT(*)
        FROM asset_pdf_pages
        WHERE asset_id=? AND image_managed_path IS NOT NULL AND trim(image_managed_path) != ''
        """,
        (asset_id,),
    ).fetchone()[0])


def search_asset_text_chunks(
    conn: sqlite3.Connection,
    asset_id: int,
    query: str,
    *,
    limit: int = 10,
) -> list[AssetTextChunk]:
    rows = _rank_fts_rows(
        query,
        limit=limit,
        fetch_rows=lambda fts_query, pool_limit: conn.execute(
            """
            SELECT c.*
            FROM asset_text_chunks_fts f
            JOIN asset_text_chunks c ON c.id = f.rowid
            WHERE asset_text_chunks_fts MATCH ? AND c.asset_id=?
            ORDER BY bm25(asset_text_chunks_fts), c.chunk_index ASC
            LIMIT ?
            """,
            (fts_query, asset_id, max(1, pool_limit)),
        ).fetchall(),
        fields=lambda row: ((row["text"] or "", 1.0),),
    )
    return [_row_to_asset_text_chunk(row) for row in rows]
