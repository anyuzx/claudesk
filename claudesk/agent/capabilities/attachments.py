from __future__ import annotations

import json

from claudesk.agent.capabilities.registry import CapabilitySpec
from claudesk.agent.context import CapabilityContext
from claudesk.agent.schemas import (
    CapabilityInput,
    CapabilityResult,
    GetChatAttachmentContextInput,
    ToolImageAttachment,
)
from claudesk.core.db.assets import (
    count_asset_text_chunks,
    list_asset_pdf_pages,
    list_asset_text_chunks,
)
from claudesk.core.db.chat import get_chat_attachment
from claudesk.core.models import AssetKind, AssetPdfPage, resource_read
from claudesk.core.paper_assets import (
    AssetFileStatus,
    chat_attachment_file_health,
    resolve_chat_attachment_path,
)
from claudesk.core.pdf_ingest import PdfIngestError, ensure_asset_pdf_ingested


def _json_result(payload: dict) -> CapabilityResult:
    return CapabilityResult(text=json.dumps(payload, ensure_ascii=False))


def _select_attachment(context: CapabilityContext, asset_id: int):
    if context.session_id is not None:
        attachment = get_chat_attachment(context.conn, context.session_id, asset_id)
        if attachment is None:
            return None, {"ok": False, "error": f"Chat attachment {asset_id} not found for this session."}
        return attachment, None
    return None, {"ok": False, "error": "Chat attachment context requires an active chat session."}


def _asset_payload(attachment) -> dict:
    asset = attachment.asset
    return {
        "id": asset.id,
        "kind": asset.kind.value,
        "context_kind": attachment.context_kind,
        "session_id": attachment.session_id,
        "display_name": asset.display_name,
        "original_filename": asset.original_filename,
        "mime_type": asset.mime_type,
        "size_bytes": asset.size_bytes,
        "parse_status": asset.parse_status.value,
        "parser_name": asset.parser_name,
        "parser_version": asset.parser_version,
        "parse_error": asset.parse_error,
        "parsed_at": asset.parsed_at.isoformat() if asset.parsed_at else None,
        "created_at": asset.created_at.isoformat(),
        "updated_at": asset.updated_at.isoformat(),
    }


def _asset_resource_read(attachment):
    asset = attachment.asset
    return resource_read(
        "asset",
        asset.id,
        label=asset.display_name,
        summary="Chat attachment returned.",
        locator={
            "asset_id": asset.id,
            "session_id": attachment.session_id,
            "context_kind": attachment.context_kind,
            "asset_kind": asset.kind.value,
            "mime_type": asset.mime_type,
        },
    )


def _chunk_payload(chunk) -> dict:
    return {
        "chunk_id": chunk.id,
        "asset_id": chunk.asset_id,
        "chunk_index": chunk.chunk_index,
        "page_number": chunk.page_number,
        "block_type": chunk.block_type,
        "section_path": chunk.section_path,
        "bbox": chunk.bbox,
        "block_ids": chunk.block_ids,
        "char_count": chunk.char_count,
        "source": "parsed_attachment_pdf",
        "text": chunk.text,
    }


def _page_payload(page: AssetPdfPage) -> dict:
    return {
        "page_number": page.page_number,
        "text_available": bool(page.text.strip()),
        "page_width": page.page_width,
        "page_height": page.page_height,
        "image_label": f"PDF page {page.page_number}" if page.image_managed_path else None,
        "image_width": page.image_width,
        "image_height": page.image_height,
        "render_dpi": page.render_dpi,
    }


def _limit_chunks_by_chars(chunks, max_chars: int):
    candidates = list(chunks)
    selected = []
    total = 0
    truncated = False
    for index, chunk in enumerate(candidates):
        if total >= max_chars:
            truncated = True
            break
        remaining = max_chars - total
        bounded_text = chunk.text[:remaining]
        if len(bounded_text) < len(chunk.text):
            truncated = True
        selected.append(chunk.model_copy(update={"text": bounded_text, "char_count": len(bounded_text)}))
        total += len(bounded_text)
        if total >= max_chars:
            if index < len(candidates) - 1:
                truncated = True
            break
    return selected, truncated


def _image_attachments_for_pages(
    pages: list[AssetPdfPage],
    *,
    asset_id: int,
    limit: int = 3,
) -> tuple[ToolImageAttachment, ...]:
    images: list[ToolImageAttachment] = []
    seen: set[int] = set()
    for page in pages:
        if page.page_number in seen or not page.image_managed_path:
            continue
        seen.add(page.page_number)
        images.append(
            ToolImageAttachment(
                label=f"Attachment PDF asset {asset_id} page {page.page_number}",
                mime_type="image/png",
                managed_path=page.image_managed_path,
                asset_id=asset_id,
                page_number=page.page_number,
                width=page.image_width,
                height=page.image_height,
                temporary=True,
            )
        )
        if len(images) >= limit:
            break
    return tuple(images)


def _chunk_resource_read(attachment, chunk):
    return resource_read(
        "pdf_chunk",
        chunk.id,
        label=f"Attachment PDF chunk {chunk.chunk_index}",
        summary="Attachment PDF text chunk evidence returned.",
        locator={
            "asset_id": chunk.asset_id,
            "session_id": attachment.session_id,
            "context_kind": attachment.context_kind,
            "chunk_id": chunk.id,
            "chunk_index": chunk.chunk_index,
            "page_number": chunk.page_number,
            "section_path": chunk.section_path,
            "block_ids": chunk.block_ids,
        },
    )


def _page_resource_read(attachment, page_number: int):
    asset = attachment.asset
    return resource_read(
        "pdf_page",
        f"{asset.id}:{page_number}",
        label=f"Attachment PDF page {page_number}",
        summary="Attachment PDF page evidence returned.",
        locator={
            "asset_id": asset.id,
            "session_id": attachment.session_id,
            "context_kind": attachment.context_kind,
            "page_number": page_number,
        },
    )


def _read_text_attachment(attachment, context: CapabilityContext, *, max_chars: int) -> CapabilityResult:
    asset = attachment.asset
    if asset.parsed_text is not None:
        text = asset.parsed_text
    else:
        try:
            path = resolve_chat_attachment_path(asset.managed_path or "", cfg=context.cfg)
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            return _json_result({"ok": False, "error": f"Attachment {asset.id} is not UTF-8 text."})
    bounded = text[:max_chars]
    payload = {
        "ok": True,
        "asset": _asset_payload(attachment),
        "access_mode": "attachment_text",
        "char_count": len(text),
        "truncated": len(text) > len(bounded),
        "content": bounded,
    }
    return CapabilityResult(
        text=json.dumps(payload, ensure_ascii=False),
        resource_reads=(_asset_resource_read(attachment),),
    )


def _read_image_attachment(
    attachment,
    *,
    include_image: bool,
) -> CapabilityResult:
    asset = attachment.asset
    images = (
        ToolImageAttachment(
            label=asset.display_name,
            mime_type=asset.mime_type,
            managed_path=asset.managed_path or "",
            asset_id=asset.id,
            temporary=True,
        ),
    ) if include_image else ()
    payload = {
        "ok": True,
        "asset": _asset_payload(attachment),
        "access_mode": "attachment_image",
        "attached_images": [image.metadata() for image in images],
    }
    return CapabilityResult(
        text=json.dumps(payload, ensure_ascii=False),
        images=images,
        resource_reads=(_asset_resource_read(attachment),),
    )


def _read_pdf_attachment(
    attachment,
    context: CapabilityContext,
    *,
    start_chunk: int,
    limit: int,
    max_chars: int,
    include_image: bool,
) -> CapabilityResult:
    asset = attachment.asset
    asset_id = asset.id or 0
    try:
        result = ensure_asset_pdf_ingested(
            context.conn,
            asset_id=asset_id,
            cfg=context.cfg,
        )
        context.conn.commit()
    except PdfIngestError as exc:
        context.conn.commit()
        return _json_result({"ok": False, "error": str(exc)})

    attachment = attachment.model_copy(update={"asset": result.asset})
    chunks, truncated = _limit_chunks_by_chars(
        list_asset_text_chunks(context.conn, asset_id, start_chunk=start_chunk, limit=limit),
        max_chars,
    )
    total_chunks = count_asset_text_chunks(context.conn, asset_id)
    next_chunk_index = None
    if chunks and chunks[-1].chunk_index + 1 < total_chunks:
        next_chunk_index = chunks[-1].chunk_index + 1
    page_numbers = {chunk.page_number for chunk in chunks}
    pages = [
        page
        for page in list_asset_pdf_pages(context.conn, asset_id)
        if page.page_number in page_numbers
    ]
    images = _image_attachments_for_pages(
        pages,
        asset_id=asset_id,
    ) if include_image else ()
    payload = {
        "ok": True,
        "asset": _asset_payload(attachment),
        "access_mode": "attachment_pdf_chunks",
        "cache_hit": result.cache_hit,
        "chunks": [_chunk_payload(chunk) for chunk in chunks],
        "pages": [_page_payload(page) for page in pages],
        "char_count": sum(len(chunk.text) for chunk in chunks),
        "truncated": truncated,
        "next_chunk_index": next_chunk_index,
        "attached_images": [image.metadata() for image in images],
    }
    reads = [_asset_resource_read(attachment)]
    reads.extend(_chunk_resource_read(attachment, chunk) for chunk in chunks)
    reads.extend(_page_resource_read(attachment, page.page_number) for page in pages)
    return CapabilityResult(
        text=json.dumps(payload, ensure_ascii=False),
        images=images,
        resource_reads=tuple(reads),
    )


def _get_chat_attachment_context(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = GetChatAttachmentContextInput.model_validate(args)
    attachment, selection_error = _select_attachment(context, data.asset_id)
    if selection_error is not None:
        return _json_result(selection_error)

    asset = attachment.asset
    health = chat_attachment_file_health(asset.managed_path, cfg=context.cfg)
    if health.status != AssetFileStatus.PRESENT:
        suffix = f": {health.error}" if health.error else ""
        return _json_result({
            "ok": False,
            "error": f"Chat attachment {data.asset_id} is not locally available ({health.status.value}){suffix}.",
        })
    if health.resolved_path is None or not health.resolved_path.is_file():
        return _json_result({"ok": False, "error": f"Managed attachment file for asset {data.asset_id} is not a file."})

    if asset.kind in {AssetKind.TEXT, AssetKind.MARKDOWN}:
        return _read_text_attachment(attachment, context, max_chars=data.max_chars)
    if asset.kind == AssetKind.ATTACHMENT and asset.mime_type.casefold().startswith("image/"):
        return _read_image_attachment(attachment, include_image=data.include_image)
    if asset.kind == AssetKind.PDF:
        return _read_pdf_attachment(
            attachment,
            context,
            start_chunk=data.start_chunk,
            limit=data.limit,
            max_chars=data.max_chars,
            include_image=data.include_image,
        )
    return _json_result({
        "ok": False,
        "error": f"Unsupported chat attachment asset kind: {asset.kind.value}.",
    })


def capabilities() -> list[CapabilitySpec]:
    return [
        CapabilitySpec(
            name="get_chat_attachment_context",
            description="Read a chat attachment uploaded to the current Claudesk chat. Supports bounded text, image evidence, and locally parsed PDF chunks/page images.",
            input_model=GetChatAttachmentContextInput,
            handler=_get_chat_attachment_context,
            domain="asset",
            access="read",
            risk="low",
        ),
    ]
