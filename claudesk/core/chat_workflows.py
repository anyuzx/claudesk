from __future__ import annotations

import io
import logging
import re
import shutil
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from claudesk.core.config import ChatConfig, ChatRuntimeSettings, Config, load_config
from claudesk.core.db import get_connection, init_db
from claudesk.core.db.chat import (
    delete_all_chat_attachments,
    get_chat_session_detail,
    list_all_chat_attachments,
)
from claudesk.core.errors import NotFoundError, ValidationError
from claudesk.core.models import (
    AssetKind,
    ChatAttachment,
    ChatAttachmentKind,
    ChatContextItem,
    ChatContextRef,
    ChatMessage,
    ChatSessionDetail,
)
from claudesk.core.paper_assets import (
    CHAT_ATTACHMENT_MAX_IMAGE_BYTES,
    CHAT_ATTACHMENT_MAX_PDF_BYTES,
    CHAT_ATTACHMENT_MAX_TEXT_BYTES,
    IMAGE_ATTACHMENT_MIME_TYPES,
    PDF_MIME_TYPES,
    TEXT_ATTACHMENT_MIME_TYPES,
    InvalidPaperAssetFile,
    chat_attachments_root,
    delete_chat_attachment_file,
)
from claudesk.core.paper_mentions import PAPER_MENTION_RE, extract_paper_ids
from claudesk.core.pdf_ingest import clear_pdf_ingest_cache


logger = logging.getLogger(__name__)

MAX_CHAT_TITLE_LENGTH = 80
CHAT_ATTACHMENT_KINDS = {"clipboard_text", "screenshot", "file"}
TEXT_FILE_EXTENSIONS = {
    ".csv",
    ".json",
    ".md",
    ".markdown",
    ".txt",
    ".tsv",
    ".xml",
    ".yaml",
    ".yml",
}


@dataclass(frozen=True)
class PreparedChatAttachmentUpload:
    context_kind: ChatAttachmentKind
    source: str
    asset_kind: AssetKind
    filename: str
    display_name: str
    mime_type: str
    max_bytes: int
    default_filename: str
    file_obj: BinaryIO
    parsed_text: str | None = None


def config_for_chat_session(cfg: Config, runtime_settings: ChatRuntimeSettings) -> Config:
    chat_values = {
        key: value
        for key, value in cfg.chat.model_dump().items()
        if key not in ChatRuntimeSettings.model_fields
    }
    chat_values.update(runtime_settings.model_dump())
    return cfg.model_copy(update={"chat": ChatConfig.model_validate(chat_values)}, deep=True)


def normalize_chat_message(message: dict) -> dict:
    role = message.get("role")
    content = message.get("content")
    if role != "user" or not isinstance(content, str):
        return message

    tagged_ids: list[str] = []

    def repl(match: re.Match[str]) -> str:
        label = match.group("label").lstrip("@").strip()
        paper_id = match.group("paper_id")
        tagged_ids.append(paper_id)
        return f"{label} (paper id {paper_id})"

    normalized = PAPER_MENTION_RE.sub(repl, content)
    if tagged_ids:
        unique_ids = ", ".join(dict.fromkeys(tagged_ids))
        normalized = f"{normalized}\n\nTagged paper ids: {unique_ids}."

    return {**message, "content": normalized}


def linked_paper_context(paper_ids: list[int]) -> str:
    ids = []
    seen: set[int] = set()
    for raw_id in paper_ids:
        try:
            paper_id = int(raw_id)
        except (TypeError, ValueError):
            continue
        if paper_id in seen:
            continue
        seen.add(paper_id)
        ids.append(paper_id)
    if not ids:
        return ""

    joined = ", ".join(str(paper_id) for paper_id in ids)
    if len(ids) == 1:
        return (
            "\n\nLinked paper context:\n"
            f"Current linked paper id: {joined}.\n"
            "When the user refers to this paper, the paper, or it, use this paper id."
        )
    return (
        "\n\nLinked paper context:\n"
        f"Current linked paper ids: {joined}.\n"
        "If the user asks about all or these linked papers, use all listed ids. "
        "If a singular reference is ambiguous, ask which paper."
    )


def paper_ids_from_text(text: str) -> list[int]:
    out: list[int] = []
    seen: set[int] = set()
    for raw_id in extract_paper_ids(text):
        try:
            paper_id = int(raw_id)
        except (TypeError, ValueError):
            continue
        if paper_id in seen:
            continue
        seen.add(paper_id)
        out.append(paper_id)
    return out


def merge_linked_paper_ids(*groups: list[int]) -> list[int]:
    out: list[int] = []
    seen: set[int] = set()
    for group in groups:
        for raw_id in group:
            try:
                paper_id = int(raw_id)
            except (TypeError, ValueError):
                continue
            if paper_id in seen:
                continue
            seen.add(paper_id)
            out.append(paper_id)
    return out


def conversation_paper_ids(messages: list[ChatMessage]) -> list[int]:
    ids: list[int] = []
    for message in messages:
        if message.role == "user":
            ids.extend(paper_ids_from_text(message.content))
    return merge_linked_paper_ids(ids)


def assistant_message_for_llm(message: ChatMessage) -> dict:
    content = message.content.strip()
    tool_results = [entry for entry in message.trace_entries if entry.type == "tool_result"]
    if not tool_results:
        return {"role": "assistant", "content": content}

    tool_lines = []
    for entry in tool_results:
        name = entry.name or entry.label or "tool"
        suffix = f": {entry.summary}" if entry.summary else ""
        tool_lines.append(f"- {name}{suffix}")
    tool_summary = "Tool use summary:\n" + "\n".join(tool_lines)
    merged = f"{content}\n\n{tool_summary}" if content else tool_summary
    return {"role": "assistant", "content": merged}


def initial_session_title(message: str) -> str:
    normalized = PAPER_MENTION_RE.sub(lambda match: match.group("label").strip(), message)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    if not normalized:
        return "New chat"
    if len(normalized) <= MAX_CHAT_TITLE_LENGTH:
        return normalized
    return normalized[: MAX_CHAT_TITLE_LENGTH - 3].rstrip() + "..."


def normalized_mime_type(mime_type: str | None) -> str:
    return (mime_type or "").split(";", 1)[0].strip().casefold()


def filename_suffix(filename: str | None) -> str:
    return Path(filename or "").suffix.casefold()


def is_pdf_attachment(mime_type: str, filename: str | None) -> bool:
    return mime_type in PDF_MIME_TYPES or filename_suffix(filename) == ".pdf"


def is_image_attachment(mime_type: str) -> bool:
    return mime_type in IMAGE_ATTACHMENT_MIME_TYPES


def is_text_attachment(mime_type: str, filename: str | None) -> bool:
    return (
        mime_type in TEXT_ATTACHMENT_MIME_TYPES
        or mime_type.startswith("text/")
        or filename_suffix(filename) in TEXT_FILE_EXTENSIONS
    )


def read_bounded_text_attachment(file_obj: BinaryIO, *, max_bytes: int) -> bytes:
    try:
        file_obj.seek(0)
    except (AttributeError, OSError):
        pass
    data = file_obj.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise ValidationError(f"Text attachment exceeds the {max_bytes} byte size limit.")
    return data


def decode_text_attachment(data: bytes) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValidationError("Text attachments must be UTF-8 encoded.") from exc


def prepare_chat_attachment_upload(
    *,
    kind: str,
    file_obj: BinaryIO | None,
    filename: str | None,
    mime_type: str | None,
    text: str | None,
) -> PreparedChatAttachmentUpload:
    context_kind = kind.strip()
    if context_kind not in CHAT_ATTACHMENT_KINDS:
        raise ValidationError(f"Unsupported chat attachment kind: {kind}.")

    if context_kind == "clipboard_text":
        if text is None and file_obj is None:
            raise ValidationError("Clipboard text attachment requires text or a file part.")
        data = text.encode("utf-8") if text is not None else read_bounded_text_attachment(
            file_obj,  # type: ignore[arg-type]
            max_bytes=CHAT_ATTACHMENT_MAX_TEXT_BYTES,
        )
        if len(data) > CHAT_ATTACHMENT_MAX_TEXT_BYTES:
            raise ValidationError(f"Clipboard text exceeds the {CHAT_ATTACHMENT_MAX_TEXT_BYTES} byte size limit.")
        parsed_text = decode_text_attachment(data)
        effective_filename = filename or "clipboard.txt"
        return PreparedChatAttachmentUpload(
            context_kind="clipboard_text",
            source="paste",
            asset_kind=AssetKind.TEXT,
            filename=effective_filename,
            display_name="Pasted text",
            mime_type="text/plain",
            max_bytes=CHAT_ATTACHMENT_MAX_TEXT_BYTES,
            default_filename="clipboard.txt",
            parsed_text=parsed_text,
            file_obj=io.BytesIO(data),
        )

    if file_obj is None:
        raise ValidationError(f"{context_kind} attachment requires a file part.")
    effective_mime_type = normalized_mime_type(mime_type)
    effective_filename = filename or ("screenshot.png" if context_kind == "screenshot" else "attachment")

    if context_kind == "screenshot":
        if not is_image_attachment(effective_mime_type):
            raise ValidationError("Screenshots must be PNG, JPEG, WEBP, or GIF images.")
        return PreparedChatAttachmentUpload(
            context_kind="screenshot",
            source="screenshot",
            asset_kind=AssetKind.ATTACHMENT,
            filename=effective_filename,
            display_name=effective_filename,
            mime_type=effective_mime_type,
            max_bytes=CHAT_ATTACHMENT_MAX_IMAGE_BYTES,
            default_filename="screenshot.png",
            file_obj=file_obj,
        )

    if is_pdf_attachment(effective_mime_type, effective_filename):
        return PreparedChatAttachmentUpload(
            context_kind="file",
            source="user_attached",
            asset_kind=AssetKind.PDF,
            filename=effective_filename,
            display_name=effective_filename,
            mime_type=effective_mime_type if effective_mime_type in PDF_MIME_TYPES else "application/pdf",
            max_bytes=CHAT_ATTACHMENT_MAX_PDF_BYTES,
            default_filename="attachment.pdf",
            file_obj=file_obj,
        )
    if is_image_attachment(effective_mime_type):
        return PreparedChatAttachmentUpload(
            context_kind="file",
            source="user_attached",
            asset_kind=AssetKind.ATTACHMENT,
            filename=effective_filename,
            display_name=effective_filename,
            mime_type=effective_mime_type,
            max_bytes=CHAT_ATTACHMENT_MAX_IMAGE_BYTES,
            default_filename="attachment",
            file_obj=file_obj,
        )
    if is_text_attachment(effective_mime_type, effective_filename):
        data = read_bounded_text_attachment(file_obj, max_bytes=CHAT_ATTACHMENT_MAX_TEXT_BYTES)
        parsed_text = decode_text_attachment(data)
        upload_mime_type = (
            effective_mime_type
            if effective_mime_type and effective_mime_type != "application/octet-stream"
            else "text/plain"
        )
        asset_kind = (
            AssetKind.MARKDOWN
            if upload_mime_type in {"text/markdown", "text/x-markdown"}
            or filename_suffix(effective_filename) in {".md", ".markdown"}
            else AssetKind.TEXT
        )
        return PreparedChatAttachmentUpload(
            context_kind="file",
            source="user_attached",
            asset_kind=asset_kind,
            filename=effective_filename,
            display_name=effective_filename,
            mime_type=upload_mime_type,
            max_bytes=CHAT_ATTACHMENT_MAX_TEXT_BYTES,
            default_filename="attachment.txt",
            parsed_text=parsed_text,
            file_obj=io.BytesIO(data),
        )

    raise ValidationError(f"Unsupported attachment type: {effective_mime_type or 'unknown'}.")


def get_chat_session_or_raise(
    conn: sqlite3.Connection,
    session_id: int,
) -> ChatSessionDetail:
    session = get_chat_session_detail(conn, session_id)
    if session is None:
        raise NotFoundError(f"Chat session {session_id} not found.")
    return session


def context_item_for_chat_attachment(
    asset_id: int,
    prepared: PreparedChatAttachmentUpload,
) -> ChatContextItem:
    return ChatContextItem(
        kind=prepared.context_kind,
        source=prepared.source,  # type: ignore[arg-type]
        ref=ChatContextRef(asset_id=asset_id),
        label=prepared.display_name,
        mime_type=prepared.mime_type,
        status="ready",
    )


def cleanup_chat_attachment_files(
    conn: sqlite3.Connection,
    attachments: list[ChatAttachment],
    *,
    cfg: Config,
) -> None:
    for attachment in attachments:
        asset = attachment.asset
        asset_id = asset.id or 0
        if asset.kind == AssetKind.PDF and asset_id > 0:
            clear_pdf_ingest_cache(conn, asset_id, cfg=cfg)
        try:
            delete_chat_attachment_file(asset.managed_path, cfg=cfg)
        except InvalidPaperAssetFile:
            logger.warning(
                "Skipping invalid chat attachment managed path during cleanup",
                extra={"asset_id": asset_id, "managed_path": asset.managed_path},
            )


def cleanup_app_lifetime_chat_attachments() -> dict[str, object]:
    conn = get_connection()
    try:
        init_db(conn)
        cfg = load_config()
        attachments = list_all_chat_attachments(conn)
        cleanup_chat_attachment_files(conn, attachments, cfg=cfg)
        deleted = delete_all_chat_attachments(conn)
        shutil.rmtree(chat_attachments_root(cfg, create=False), ignore_errors=True)
        conn.commit()
        return {
            "deleted_chat_attachments": deleted,
        }
    finally:
        conn.close()


def attachment_asset_ids_from_context(items: list[ChatContextItem]) -> list[int]:
    ids: list[int] = []
    seen: set[int] = set()
    for item in items:
        if item.kind not in CHAT_ATTACHMENT_KINDS or item.ref is None or item.ref.asset_id is None:
            continue
        asset_id = int(item.ref.asset_id)
        if asset_id <= 0 or asset_id in seen:
            continue
        seen.add(asset_id)
        ids.append(asset_id)
    return ids


def paper_context_ids_from_context(items: list[ChatContextItem]) -> list[int]:
    ids: list[int] = []
    seen: set[int] = set()
    for item in items:
        if item.kind != "paper" or item.ref is None or item.ref.paper_id is None:
            continue
        paper_id = int(item.ref.paper_id)
        if paper_id <= 0 or paper_id in seen:
            continue
        seen.add(paper_id)
        ids.append(paper_id)
    return ids


def pdf_asset_ids_from_context(items: list[ChatContextItem]) -> list[int]:
    ids: list[int] = []
    seen: set[int] = set()
    for item in items:
        if item.kind != "pdf_asset" or item.ref is None or item.ref.asset_id is None:
            continue
        asset_id = int(item.ref.asset_id)
        if asset_id <= 0 or asset_id in seen:
            continue
        seen.add(asset_id)
        ids.append(asset_id)
    return ids
