from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from claudesk.core.config import Config, load_config
from claudesk.core.db.chat import get_chat_attachment
from claudesk.core.db.notes import get_note
from claudesk.core.db.papers import get_paper
from claudesk.core.db.assets import get_paper_asset
from claudesk.core.db.projects import get_project
from claudesk.core.models import AssetKind, ChatContextItem, ChatContextRef, ChatResourceReadInput, resource_read
from claudesk.core.paper_assets import AssetFileStatus, asset_file_health, chat_attachment_file_health


MAX_CHAT_CONTEXT_ITEMS = 12
ATTACHMENT_CHAT_CONTEXT_KINDS = {"clipboard_text", "screenshot", "file"}
SUPPORTED_CHAT_CONTEXT_KINDS = {"paper", "project", "note", "pdf_asset", *ATTACHMENT_CHAT_CONTEXT_KINDS}


@dataclass(frozen=True)
class CapabilityContext:
    conn: sqlite3.Connection
    cfg: Config
    session_id: int | None = None

    @classmethod
    def for_connection(
        cls,
        conn: sqlite3.Connection,
        *,
        cfg: Config | None = None,
        session_id: int | None = None,
    ) -> "CapabilityContext":
        return cls(conn=conn, cfg=cfg or load_config(), session_id=session_id)


def _positive_int(value: int | None, label: str) -> int:
    try:
        normalized = int(value) if value is not None else 0
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} must be a positive integer.") from exc
    if normalized <= 0:
        raise ValueError(f"{label} must be a positive integer.")
    return normalized


def _context_ref(item: ChatContextItem) -> ChatContextRef:
    if item.ref is None:
        raise ValueError(f"{item.kind} context item is missing a ref.")
    return item.ref


def _preview(text: str, *, limit: int = 180) -> str:
    normalized = " ".join(text.split())
    if len(normalized) <= limit:
        return normalized
    return normalized[: limit - 3].rstrip() + "..."


def _dedupe_key(item: ChatContextItem) -> tuple[str, int, int]:
    ref = _context_ref(item)
    if item.kind == "paper":
        return (item.kind, _positive_int(ref.paper_id, "paper_id"), 0)
    if item.kind == "project":
        return (item.kind, _positive_int(ref.project_id, "project_id"), 0)
    if item.kind == "note":
        return (item.kind, _positive_int(ref.note_id, "note_id"), 0)
    if item.kind == "pdf_asset":
        return (
            item.kind,
            _positive_int(ref.paper_id, "paper_id"),
            _positive_int(ref.asset_id, "asset_id"),
        )
    if item.kind in ATTACHMENT_CHAT_CONTEXT_KINDS:
        return (item.kind, _positive_int(ref.asset_id, "asset_id"), 0)
    return (item.kind, 0, 0)


def _validate_attachment_context_asset(item: ChatContextItem, asset_kind: AssetKind, mime_type: str) -> None:
    normalized_mime = (mime_type or "").casefold()
    if item.kind == "clipboard_text" and asset_kind not in {AssetKind.TEXT, AssetKind.MARKDOWN}:
        raise ValueError("Clipboard text context must reference a text attachment.")
    if item.kind == "screenshot":
        if asset_kind != AssetKind.ATTACHMENT or not normalized_mime.startswith("image/"):
            raise ValueError("Screenshot context must reference an image attachment.")
    if item.kind == "file" and asset_kind not in {
        AssetKind.ATTACHMENT,
        AssetKind.MARKDOWN,
        AssetKind.PDF,
        AssetKind.TEXT,
    }:
        raise ValueError("File context must reference a supported attachment asset.")


def resolve_chat_context_items(
    conn: sqlite3.Connection,
    items: list[ChatContextItem],
    *,
    session_id: int | None = None,
    cfg: Config | None = None,
) -> list[ChatContextItem]:
    if len(items) > MAX_CHAT_CONTEXT_ITEMS:
        raise ValueError(f"At most {MAX_CHAT_CONTEXT_ITEMS} context items can be sent with one chat turn.")

    resolved: list[ChatContextItem] = []
    seen: set[tuple[str, int, int]] = set()
    for item in items:
        if item.kind not in SUPPORTED_CHAT_CONTEXT_KINDS:
            raise ValueError(f"Chat context kind '{item.kind}' is not supported yet.")

        key = _dedupe_key(item)
        if key in seen:
            continue
        seen.add(key)

        ref = _context_ref(item)
        if item.kind == "paper":
            paper_id = _positive_int(ref.paper_id, "paper_id")
            paper = get_paper(conn, paper_id)
            if paper is None:
                raise ValueError(f"Paper {paper_id} not found.")
            resolved.append(
                ChatContextItem(
                    kind="paper",
                    source=item.source,
                    ref=ChatContextRef(paper_id=paper_id),
                    label=paper.title,
                    preview=_preview(paper.abstract),
                    status="ready",
                )
            )
            continue

        if item.kind == "project":
            project_id = _positive_int(ref.project_id, "project_id")
            project = get_project(conn, project_id)
            if project is None:
                raise ValueError(f"Project {project_id} not found.")
            resolved.append(
                ChatContextItem(
                    kind="project",
                    source=item.source,
                    ref=ChatContextRef(project_id=project_id),
                    label=project.name,
                    preview=project.status.value,
                    status="ready",
                )
            )
            continue

        if item.kind == "note":
            note_id = _positive_int(ref.note_id, "note_id")
            note = get_note(conn, note_id)
            if note is None:
                raise ValueError(f"Note {note_id} not found.")
            resolved.append(
                ChatContextItem(
                    kind="note",
                    source=item.source,
                    ref=ChatContextRef(note_id=note_id),
                    label=note.title,
                    preview=_preview(note.body),
                    status="ready",
                )
            )
            continue

        if item.kind in ATTACHMENT_CHAT_CONTEXT_KINDS:
            if session_id is None:
                raise ValueError(f"{item.kind} context requires a chat session id.")
            asset_id = _positive_int(ref.asset_id, "asset_id")
            attachment = get_chat_attachment(conn, session_id, asset_id)
            if attachment is None:
                raise ValueError(f"Chat attachment {asset_id} not found for session {session_id}.")
            if attachment.user_message_id is not None:
                raise ValueError(f"Chat attachment {asset_id} is already attached to a message.")
            if attachment.context_kind != item.kind:
                raise ValueError(
                    f"Chat attachment {asset_id} is a {attachment.context_kind} context item, not {item.kind}."
                )
            asset = attachment.asset
            _validate_attachment_context_asset(item, asset.kind, asset.mime_type)
            active_cfg = cfg or load_config()
            health = chat_attachment_file_health(asset.managed_path, cfg=active_cfg)
            if health.status != AssetFileStatus.PRESENT:
                suffix = f": {health.error}" if health.error else ""
                raise ValueError(
                    f"Chat attachment {asset_id} is not locally available "
                    f"({health.status.value}){suffix}."
                )
            if health.resolved_path is None or not health.resolved_path.is_file():
                raise ValueError(f"Managed attachment file for asset {asset_id} is not a file.")
            resolved.append(
                ChatContextItem(
                    kind=item.kind,
                    source=item.source,
                    ref=ChatContextRef(asset_id=asset_id),
                    label=asset.display_name,
                    preview=_preview(asset.parsed_text or asset.parse_status.value),
                    mime_type=asset.mime_type,
                    size_bytes=asset.size_bytes,
                    status="ready",
                )
            )
            continue

        paper_id = _positive_int(ref.paper_id, "paper_id")
        asset_id = _positive_int(ref.asset_id, "asset_id")
        asset = get_paper_asset(conn, paper_id, asset_id)
        if asset is None:
            raise ValueError(f"PDF asset {asset_id} for paper {paper_id} not found.")
        if asset.kind != AssetKind.PDF:
            raise ValueError(f"Asset {asset_id} for paper {paper_id} is not a PDF.")
        active_cfg = cfg or load_config()
        health = asset_file_health(asset.managed_path, cfg=active_cfg)
        if health.status != AssetFileStatus.PRESENT:
            suffix = f": {health.error}" if health.error else ""
            raise ValueError(
                f"PDF asset {asset_id} for paper {paper_id} is not locally available "
                f"({health.status.value}){suffix}."
            )
        if health.resolved_path is None or not health.resolved_path.is_file():
            raise ValueError(f"Managed PDF file for asset {asset_id} is not a file.")
        resolved.append(
            ChatContextItem(
                kind="pdf_asset",
                source=item.source,
                ref=ChatContextRef(paper_id=paper_id, asset_id=asset_id),
                label=asset.display_name,
                preview=asset.parse_status.value,
                mime_type=asset.mime_type,
                size_bytes=asset.size_bytes,
                status="ready",
            )
        )
    return resolved


def paper_ids_from_chat_context(items: list[ChatContextItem]) -> list[int]:
    out: list[int] = []
    seen: set[int] = set()
    for item in items:
        paper_id = item.ref.paper_id if item.ref is not None else None
        if paper_id is None:
            continue
        try:
            normalized = int(paper_id)
        except (TypeError, ValueError):
            continue
        if normalized <= 0 or normalized in seen:
            continue
        seen.add(normalized)
        out.append(normalized)
    return out


def project_ids_from_chat_context(items: list[ChatContextItem]) -> list[int]:
    out: list[int] = []
    seen: set[int] = set()
    for item in items:
        if item.kind != "project" or item.ref is None:
            continue
        project_id = item.ref.project_id
        if project_id is None:
            continue
        try:
            normalized = int(project_id)
        except (TypeError, ValueError):
            continue
        if normalized <= 0 or normalized in seen:
            continue
        seen.add(normalized)
        out.append(normalized)
    return out


def note_ids_from_chat_context(items: list[ChatContextItem]) -> list[int]:
    out: list[int] = []
    seen: set[int] = set()
    for item in items:
        if item.kind != "note" or item.ref is None:
            continue
        note_id = item.ref.note_id
        if note_id is None:
            continue
        try:
            normalized = int(note_id)
        except (TypeError, ValueError):
            continue
        if normalized <= 0 or normalized in seen:
            continue
        seen.add(normalized)
        out.append(normalized)
    return out


def chat_context_resource_reads(items: list[ChatContextItem]) -> tuple[ChatResourceReadInput, ...]:
    reads: list[ChatResourceReadInput] = []
    for item in items:
        ref = item.ref or ChatContextRef()
        label = item.label or item.kind.replace("_", " ")
        if item.kind == "paper" and ref.paper_id is not None:
            reads.append(
                resource_read(
                    "paper",
                    ref.paper_id,
                    label=label,
                    summary="Paper context item attached to the prompt.",
                    locator={"paper_id": ref.paper_id},
                )
            )
        elif item.kind == "project" and ref.project_id is not None:
            reads.append(
                resource_read(
                    "project",
                    ref.project_id,
                    label=label,
                    summary="Project context item attached to the prompt.",
                    locator={"project_id": ref.project_id},
                )
            )
        elif item.kind == "note" and ref.note_id is not None:
            reads.append(
                resource_read(
                    "note",
                    ref.note_id,
                    label=label,
                    summary="Note context item attached to the prompt.",
                    locator={"note_id": ref.note_id},
                )
            )
        elif item.kind == "pdf_asset" and ref.asset_id is not None:
            reads.append(
                resource_read(
                    "asset",
                    ref.asset_id,
                    label=label,
                    summary="PDF asset context item attached to the prompt.",
                    locator={
                        "paper_id": ref.paper_id,
                        "asset_id": ref.asset_id,
                        "context_kind": "pdf_asset",
                    },
                )
            )
        elif item.kind in ATTACHMENT_CHAT_CONTEXT_KINDS and ref.asset_id is not None:
            reads.append(
                resource_read(
                    "asset",
                    ref.asset_id,
                    label=label,
                    summary="Chat attachment context item attached to the prompt.",
                    locator={
                        "asset_id": ref.asset_id,
                        "context_kind": item.kind,
                        "mime_type": item.mime_type,
                    },
                )
            )
    return tuple(reads)


def chat_context_prompt_block(items: list[ChatContextItem]) -> str:
    if not items:
        return ""
    lines = [
        "\n\nChat context:",
        "The user attached these Claudesk context items to this turn. Use them as grounding hints and use Claudesk tools for details when needed.",
    ]
    for item in items:
        ref = item.ref or ChatContextRef()
        label = item.label or item.kind
        if item.kind == "paper":
            lines.append(f"- Paper {ref.paper_id}: {label}")
        elif item.kind == "project":
            suffix = f" ({item.preview})" if item.preview else ""
            lines.append(
                f"- Project {ref.project_id}: {label}{suffix}. "
                f"Call get_project_context with project_id={ref.project_id} for linked papers, "
                "notes, PDF assets, open tasks, progress, and related chats."
            )
        elif item.kind == "note":
            lines.append(
                f"- Note {ref.note_id}: {label}. "
                f"Call get_note_context with note_id={ref.note_id} for the full note body and linked papers."
            )
        elif item.kind == "pdf_asset":
            suffix = f", parse status {item.preview}" if item.preview else ""
            lines.append(f"- PDF asset {ref.asset_id} for paper {ref.paper_id}: {label}{suffix}")
        elif item.kind in ATTACHMENT_CHAT_CONTEXT_KINDS:
            details = []
            if item.mime_type:
                details.append(item.mime_type)
            if item.size_bytes is not None:
                details.append(f"{item.size_bytes} bytes")
            suffix = f" ({', '.join(details)})" if details else ""
            lines.append(
                f"- Attachment asset {ref.asset_id}: {label}{suffix}. "
                f"Call get_chat_attachment_context with asset_id={ref.asset_id} for attachment details."
            )
    return "\n".join(lines)
