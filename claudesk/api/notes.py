from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from claudesk.api.deps import get_conn
from claudesk.core.config import load_config
from claudesk.core.db.assets import (
    create_note_drawing_asset,
    create_note_image_asset,
    delete_staged_note_drawing_asset,
    delete_staged_note_image_asset,
    get_asset,
    get_note_drawing_asset,
    update_note_drawing_asset_metadata,
)
from claudesk.core.db.notes import (
    create_note,
    delete_note,
    get_note,
    get_note_references,
    link_note_paper,
    list_notes,
    refresh_note_search_text_for_drawing_asset,
    unlink_note_paper,
    update_note,
)
from claudesk.core.models import AssetKind
from claudesk.core.paper_assets import (
    AssetFileStatus,
    IMAGE_ATTACHMENT_MIME_TYPES,
    InvalidPaperAssetFile,
    asset_file_health,
    delete_managed_asset_file,
    read_managed_excalidraw_drawing_asset,
    store_managed_excalidraw_drawing_asset,
    store_managed_markdown_image_asset,
    update_managed_excalidraw_drawing_asset,
)

router = APIRouter()


class NoteCreate(BaseModel):
    title: str
    body: str = ""
    linked_paper_ids: list[int] = Field(default_factory=list)


class NoteUpdate(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    linked_paper_ids: Optional[list[int]] = None


class NotePaperLink(BaseModel):
    paper_id: int


class NoteImageUploadResponse(BaseModel):
    asset_id: int
    markdown_url: str
    original_filename: str
    display_name: str
    mime_type: str
    size_bytes: int


class NoteDrawingCreate(BaseModel):
    scene: dict[str, Any] = Field(default_factory=dict)
    display_name: str = "Drawing"


class NoteDrawingUpdate(BaseModel):
    scene: dict[str, Any]
    display_name: Optional[str] = None


class NoteDrawingResponse(BaseModel):
    asset_id: int
    markdown: str
    scene: dict[str, Any]
    original_filename: str
    display_name: str
    mime_type: str
    size_bytes: int


def _asset_download_filename(asset) -> str:
    filename = (asset.display_name or asset.original_filename or f"asset-{asset.id or 0}").strip()
    return filename or f"asset-{asset.id or 0}"


def _drawing_display_name(name: str | None) -> str:
    cleaned = (name or "Drawing").strip()
    return cleaned or "Drawing"


def _drawing_markdown(asset_id: int) -> str:
    return f"```excalidraw asset://{asset_id}\n```"


def _drawing_download_filename(asset) -> str:
    filename = _asset_download_filename(asset)
    if not filename.casefold().endswith(".json"):
        filename = f"{filename}.excalidraw.json"
    return filename


def _drawing_response(asset, scene: dict[str, Any]) -> NoteDrawingResponse:
    asset_id = asset.id or 0
    return NoteDrawingResponse(
        asset_id=asset_id,
        markdown=_drawing_markdown(asset_id),
        scene=scene,
        original_filename=asset.original_filename,
        display_name=asset.display_name,
        mime_type=asset.mime_type,
        size_bytes=asset.size_bytes,
    )


def _get_note_drawing_asset_or_error(asset_id: int, conn):
    asset = get_asset(conn, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} not found.")
    drawing = get_note_drawing_asset(conn, asset_id)
    if drawing is None:
        raise HTTPException(status_code=400, detail=f"Asset {asset_id} is not an Excalidraw drawing.")
    return drawing


@router.get("/notes")
def get_notes(
    paper_id: Optional[int] = None,
    standalone: Optional[bool] = None,
    limit: int = 100,
    offset: int = 0,
    conn=Depends(get_conn),
):
    notes = list_notes(
        conn,
        paper_id=paper_id,
        standalone=standalone,
        limit=limit,
        offset=offset,
    )
    return [note.model_dump() for note in notes]


@router.post("/notes")
def post_note(body: NoteCreate, conn=Depends(get_conn)):
    try:
        note = create_note(
            conn,
            title=body.title,
            body=body.body,
            manual_paper_ids=body.linked_paper_ids,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    conn.commit()
    return note.model_dump()


@router.get("/notes/{note_id}")
def get_note_by_id(note_id: int, conn=Depends(get_conn)):
    note = get_note(conn, note_id)
    if note is None:
        raise HTTPException(status_code=404, detail=f"Note {note_id} not found.")
    return note.model_dump()


@router.get("/notes/{note_id}/references")
def get_note_reference_payload(note_id: int, conn=Depends(get_conn)):
    try:
        references = get_note_references(conn, note_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return references.model_dump()


@router.patch("/notes/{note_id}")
def patch_note(note_id: int, body: NoteUpdate, conn=Depends(get_conn)):
    fields = body.model_fields_set
    kwargs = {}
    if "title" in fields:
        kwargs["title"] = body.title
    if "body" in fields:
        kwargs["body"] = body.body
    if "linked_paper_ids" in fields:
        kwargs["manual_paper_ids"] = body.linked_paper_ids
    try:
        note = update_note(conn, note_id, **kwargs)
    except ValueError as exc:
        message = str(exc)
        status = 404 if f"Note {note_id} not found" in message else 400
        raise HTTPException(status_code=status, detail=message) from exc
    conn.commit()
    return note.model_dump()


@router.delete("/notes/{note_id}")
def remove_note(note_id: int, conn=Depends(get_conn)):
    if get_note(conn, note_id) is None:
        raise HTTPException(status_code=404, detail=f"Note {note_id} not found.")
    try:
        delete_note(conn, note_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    conn.commit()
    return {"ok": True}


@router.post("/notes/{note_id}/images", response_model=NoteImageUploadResponse)
def upload_note_image(
    note_id: int,
    file: UploadFile = File(...),
    conn=Depends(get_conn),
):
    if get_note(conn, note_id) is None:
        raise HTTPException(status_code=404, detail=f"Note {note_id} not found.")

    cfg = load_config()
    try:
        stored = store_managed_markdown_image_asset(
            file_obj=file.file,
            filename=file.filename,
            mime_type=file.content_type,
            cfg=cfg,
        )
        asset = create_note_image_asset(
            conn,
            note_id,
            managed_path=stored.managed_path,
            original_filename=stored.original_filename,
            display_name=stored.original_filename,
            mime_type=stored.mime_type,
            size_bytes=stored.size_bytes,
            content_hash=stored.content_hash,
            staged=True,
        )
        conn.commit()
    except InvalidPaperAssetFile as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        if "stored" in locals():
            delete_managed_asset_file(stored.managed_path, cfg=cfg)
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception:
        if "stored" in locals():
            delete_managed_asset_file(stored.managed_path, cfg=cfg)
        raise

    asset_id = asset.id or 0
    return NoteImageUploadResponse(
        asset_id=asset_id,
        markdown_url=f"asset://{asset_id}",
        original_filename=asset.original_filename,
        display_name=asset.display_name,
        mime_type=asset.mime_type,
        size_bytes=asset.size_bytes,
    )


@router.delete("/notes/{note_id}/images/{asset_id}/staged")
def remove_staged_note_image(note_id: int, asset_id: int, conn=Depends(get_conn)):
    if get_note(conn, note_id) is None:
        raise HTTPException(status_code=404, detail=f"Note {note_id} not found.")

    try:
        delete_staged_note_image_asset(conn, note_id, asset_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    conn.commit()
    return {"ok": True}


@router.post("/notes/{note_id}/drawings", response_model=NoteDrawingResponse)
def create_note_drawing(
    note_id: int,
    body: NoteDrawingCreate,
    conn=Depends(get_conn),
):
    if get_note(conn, note_id) is None:
        raise HTTPException(status_code=404, detail=f"Note {note_id} not found.")

    cfg = load_config()
    display_name = _drawing_display_name(body.display_name)
    try:
        stored = store_managed_excalidraw_drawing_asset(
            scene=body.scene,
            filename=display_name,
            cfg=cfg,
        )
        asset = create_note_drawing_asset(
            conn,
            note_id,
            managed_path=stored.managed_path,
            original_filename=stored.original_filename,
            display_name=display_name,
            mime_type=stored.mime_type,
            size_bytes=stored.size_bytes,
            content_hash=stored.content_hash,
            staged=True,
        )
        conn.commit()
    except InvalidPaperAssetFile as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        if "stored" in locals():
            delete_managed_asset_file(stored.managed_path, cfg=cfg)
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception:
        if "stored" in locals():
            delete_managed_asset_file(stored.managed_path, cfg=cfg)
        raise

    return _drawing_response(asset, body.scene)


@router.delete("/notes/{note_id}/drawings/{asset_id}/staged")
def remove_staged_note_drawing(note_id: int, asset_id: int, conn=Depends(get_conn)):
    if get_note(conn, note_id) is None:
        raise HTTPException(status_code=404, detail=f"Note {note_id} not found.")

    try:
        delete_staged_note_drawing_asset(conn, note_id, asset_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    conn.commit()
    return {"ok": True}


@router.get("/assets/{asset_id}/excalidraw", response_model=NoteDrawingResponse)
def get_note_drawing(asset_id: int, conn=Depends(get_conn)):
    asset = _get_note_drawing_asset_or_error(asset_id, conn)
    cfg = load_config()
    try:
        scene = read_managed_excalidraw_drawing_asset(asset.managed_path or "", cfg=cfg)
    except InvalidPaperAssetFile as exc:
        message = str(exc)
        status = 404 if "not found" in message else 400
        raise HTTPException(status_code=status, detail=message) from exc
    return _drawing_response(asset, scene)


@router.patch("/assets/{asset_id}/excalidraw", response_model=NoteDrawingResponse)
def update_note_drawing(asset_id: int, body: NoteDrawingUpdate, conn=Depends(get_conn)):
    asset = _get_note_drawing_asset_or_error(asset_id, conn)
    cfg = load_config()
    display_name = None
    if body.display_name is not None:
        display_name = body.display_name.strip()
        if not display_name:
            raise HTTPException(status_code=400, detail="Drawing display name is required.")
    try:
        stored = update_managed_excalidraw_drawing_asset(
            managed_path=asset.managed_path or "",
            scene=body.scene,
            cfg=cfg,
        )
        updated = update_note_drawing_asset_metadata(
            conn,
            asset_id,
            size_bytes=stored.size_bytes,
            content_hash=stored.content_hash,
            display_name=display_name,
        )
        refresh_note_search_text_for_drawing_asset(conn, asset_id)
    except InvalidPaperAssetFile as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    conn.commit()
    return _drawing_response(updated, body.scene)


@router.get("/assets/{asset_id}/excalidraw/file")
def export_note_drawing_source(asset_id: int, conn=Depends(get_conn)):
    asset = _get_note_drawing_asset_or_error(asset_id, conn)
    cfg = load_config()
    health = asset_file_health(asset.managed_path, cfg=cfg)
    if health.status == AssetFileStatus.INVALID_PATH:
        raise HTTPException(status_code=400, detail=health.error or "Invalid managed asset path.")
    if health.status == AssetFileStatus.NOT_MANAGED:
        raise HTTPException(status_code=404, detail=f"Drawing file for asset {asset_id} is not managed by Claudesk.")
    if not health.file_exists or health.resolved_path is None:
        raise HTTPException(status_code=404, detail=f"Managed drawing file for asset {asset_id} was not found.")
    if not health.resolved_path.is_file():
        raise HTTPException(status_code=400, detail="Managed drawing path is not a file.")

    return FileResponse(
        str(health.resolved_path),
        media_type=asset.mime_type,
        filename=_drawing_download_filename(asset),
        content_disposition_type="attachment",
    )


@router.get("/assets/{asset_id}/file")
def get_managed_markdown_asset_file(asset_id: int, conn=Depends(get_conn)):
    asset = get_asset(conn, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} not found.")
    if asset.kind != AssetKind.ATTACHMENT or asset.mime_type.casefold() not in IMAGE_ATTACHMENT_MIME_TYPES:
        raise HTTPException(status_code=400, detail=f"Asset {asset_id} is not a Markdown image.")

    cfg = load_config()
    health = asset_file_health(asset.managed_path, cfg=cfg)
    if health.status == AssetFileStatus.INVALID_PATH:
        raise HTTPException(status_code=400, detail=health.error or "Invalid managed asset path.")
    if health.status == AssetFileStatus.NOT_MANAGED:
        raise HTTPException(status_code=404, detail=f"Image file for asset {asset_id} is not managed by Claudesk.")
    if not health.file_exists or health.resolved_path is None:
        raise HTTPException(status_code=404, detail=f"Managed image file for asset {asset_id} was not found.")
    if not health.resolved_path.is_file():
        raise HTTPException(status_code=400, detail="Managed image path is not a file.")

    return FileResponse(
        str(health.resolved_path),
        media_type=asset.mime_type,
        filename=_asset_download_filename(asset),
        content_disposition_type="inline",
    )


@router.post("/notes/{note_id}/papers")
def post_note_paper(note_id: int, body: NotePaperLink, conn=Depends(get_conn)):
    try:
        note = link_note_paper(conn, note_id, body.paper_id)
    except ValueError as exc:
        message = str(exc)
        status = 404 if "not found" in message else 400
        raise HTTPException(status_code=status, detail=message) from exc
    conn.commit()
    return note.model_dump()


@router.delete("/notes/{note_id}/papers/{paper_id}")
def delete_note_paper(note_id: int, paper_id: int, conn=Depends(get_conn)):
    try:
        note = unlink_note_paper(conn, note_id, paper_id)
    except ValueError as exc:
        message = str(exc)
        status = 404 if "not found" in message else 400
        raise HTTPException(status_code=status, detail=message) from exc
    conn.commit()
    return note.model_dump()


@router.get("/papers/{paper_id}/notes")
def get_paper_notes(
    paper_id: int,
    limit: int = 100,
    offset: int = 0,
    conn=Depends(get_conn),
):
    notes = list_notes(conn, paper_id=paper_id, limit=limit, offset=offset)
    return [note.model_dump() for note in notes]
