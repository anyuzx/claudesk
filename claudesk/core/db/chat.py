from __future__ import annotations

import json
import sqlite3
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, Optional, Sequence

from claudesk.core.config import ChatRuntimeSettings
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

from .assets import _insert_asset, _row_to_paper_asset
from .projects import (
    _load_project_link_map,
    _replace_project_links,
    _resolve_project_links,
    get_project,
)
from .utils import _UNSET, _normalize_linked_ids

_CHAT_ATTACHMENT_CONTEXT_KINDS = {"clipboard_text", "screenshot", "file"}


def _validate_chat_attachment_kind(context_kind: str) -> ChatAttachmentKind:
    cleaned = context_kind.strip()
    if cleaned not in _CHAT_ATTACHMENT_CONTEXT_KINDS:
        raise ValueError(f"Unsupported chat attachment kind: {context_kind}.")
    return cleaned  # type: ignore[return-value]


def _row_to_chat_attachment(row: sqlite3.Row) -> ChatAttachment:
    return ChatAttachment(
        session_id=int(row["chat_session_id"]),
        asset=_row_to_paper_asset(row),
        context_kind=_validate_chat_attachment_kind(str(row["chat_context_kind"])),
        user_message_id=(
            int(row["chat_user_message_id"])
            if row["chat_user_message_id"] is not None
            else None
        ),
        created_at=datetime.fromisoformat(row["chat_attachment_created_at"]),
    )


def create_chat_attachment(
    conn: sqlite3.Connection,
    session_id: int,
    *,
    context_kind: ChatAttachmentKind,
    kind: AssetKind,
    source: str = "chat",
    managed_path: Optional[str],
    original_filename: str,
    display_name: Optional[str] = None,
    mime_type: str,
    size_bytes: int,
    content_hash: str,
    parse_status: AssetParseStatus = AssetParseStatus.NOT_PARSED,
    parsed_text: Optional[str] = None,
    created_at: Optional[datetime] = None,
) -> ChatAttachment:
    if conn.execute("SELECT id FROM chat_sessions WHERE id=?", (session_id,)).fetchone() is None:
        raise ValueError(f"Chat session {session_id} not found.")
    validated_kind = _validate_chat_attachment_kind(context_kind)
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
        parsed_text=parsed_text,
        created_at=created_at,
    )
    conn.execute(
        """
        INSERT INTO chat_attachments (session_id, asset_id, user_message_id, context_kind, created_at)
        VALUES (?, ?, NULL, ?, ?)
        """,
        (session_id, asset_id, validated_kind, now.isoformat()),
    )
    attachment = get_chat_attachment(conn, session_id, asset_id)
    if attachment is None:
        raise RuntimeError(f"Created chat attachment {asset_id} could not be loaded.")
    return attachment


def get_chat_attachment(
    conn: sqlite3.Connection,
    session_id: int,
    asset_id: int,
) -> Optional[ChatAttachment]:
    row = conn.execute(
        """
        SELECT
            a.*,
            ca.session_id AS chat_session_id,
            ca.user_message_id AS chat_user_message_id,
            ca.context_kind AS chat_context_kind,
            ca.created_at AS chat_attachment_created_at
        FROM chat_attachments ca
        JOIN assets a ON a.id = ca.asset_id
        WHERE ca.session_id=? AND ca.asset_id=?
        """,
        (session_id, asset_id),
    ).fetchone()
    return _row_to_chat_attachment(row) if row is not None else None


def list_chat_attachments(
    conn: sqlite3.Connection,
    session_id: int,
    *,
    user_message_id: Optional[int] = None,
    pending_only: bool = False,
) -> list[ChatAttachment]:
    query = """
        SELECT
            a.*,
            ca.session_id AS chat_session_id,
            ca.user_message_id AS chat_user_message_id,
            ca.context_kind AS chat_context_kind,
            ca.created_at AS chat_attachment_created_at
        FROM chat_attachments ca
        JOIN assets a ON a.id = ca.asset_id
        WHERE ca.session_id=?
    """
    params: list[object] = [session_id]
    if user_message_id is not None:
        query += " AND ca.user_message_id=?"
        params.append(user_message_id)
    if pending_only:
        query += " AND ca.user_message_id IS NULL"
    query += " ORDER BY ca.created_at ASC, ca.asset_id ASC"
    rows = conn.execute(query, params).fetchall()
    return [_row_to_chat_attachment(row) for row in rows]


def list_all_chat_attachments(conn: sqlite3.Connection) -> list[ChatAttachment]:
    rows = conn.execute(
        """
        SELECT
            a.*,
            ca.session_id AS chat_session_id,
            ca.user_message_id AS chat_user_message_id,
            ca.context_kind AS chat_context_kind,
            ca.created_at AS chat_attachment_created_at
        FROM chat_attachments ca
        JOIN assets a ON a.id = ca.asset_id
        ORDER BY ca.session_id ASC, ca.created_at ASC, ca.asset_id ASC
        """
    ).fetchall()
    return [_row_to_chat_attachment(row) for row in rows]


def _expire_chat_attachment_context_payload(payload: object, asset_ids: set[int]) -> tuple[object, bool]:
    if not isinstance(payload, list):
        return payload, False
    changed = False
    next_items: list[object] = []
    for item in payload:
        if not isinstance(item, dict):
            next_items.append(item)
            continue
        ref = item.get("ref")
        asset_id = ref.get("asset_id") if isinstance(ref, dict) else None
        try:
            normalized_asset_id = int(asset_id)
        except (TypeError, ValueError):
            normalized_asset_id = 0
        if item.get("kind") in _CHAT_ATTACHMENT_CONTEXT_KINDS and normalized_asset_id in asset_ids:
            next_item = dict(item)
            next_item["status"] = "expired"
            next_item["preview"] = "Attachment expired when the app closed."
            next_items.append(next_item)
            changed = True
        else:
            next_items.append(item)
    return next_items, changed


def expire_chat_attachment_context_items(
    conn: sqlite3.Connection,
    asset_ids: Sequence[int],
) -> int:
    normalized_ids = {int(asset_id) for asset_id in asset_ids if int(asset_id) > 0}
    if not normalized_ids:
        return 0

    updated = 0
    for row in conn.execute(
        """
        SELECT id, context_items
        FROM chat_messages
        WHERE context_items IS NOT NULL AND context_items!='[]'
        """
    ).fetchall():
        try:
            payload = json.loads(row["context_items"] or "[]")
        except json.JSONDecodeError:
            continue
        next_payload, changed = _expire_chat_attachment_context_payload(payload, normalized_ids)
        if not changed:
            continue
        conn.execute(
            "UPDATE chat_messages SET context_items=? WHERE id=?",
            (json.dumps(next_payload, ensure_ascii=False), row["id"]),
        )
        updated += 1

    for row in conn.execute(
        """
        SELECT id, trace_entries
        FROM chat_messages
        WHERE trace_entries IS NOT NULL AND trace_entries!='[]'
        """
    ).fetchall():
        try:
            payload = json.loads(row["trace_entries"] or "[]")
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, list):
            continue
        changed = False
        next_entries: list[object] = []
        for entry in payload:
            if not isinstance(entry, dict):
                next_entries.append(entry)
                continue
            context_items, entry_changed = _expire_chat_attachment_context_payload(
                entry.get("context_items"),
                normalized_ids,
            )
            if entry_changed:
                next_entry = dict(entry)
                next_entry["context_items"] = context_items
                next_entries.append(next_entry)
                changed = True
            else:
                next_entries.append(entry)
        if not changed:
            continue
        conn.execute(
            "UPDATE chat_messages SET trace_entries=? WHERE id=?",
            (json.dumps(next_entries, ensure_ascii=False), row["id"]),
        )
        updated += 1
    return updated


def attach_chat_attachments_to_message(
    conn: sqlite3.Connection,
    session_id: int,
    asset_ids: Sequence[int],
    user_message_id: int,
) -> list[ChatAttachment]:
    row = conn.execute(
        """
        SELECT id
        FROM chat_messages
        WHERE id=? AND session_id=? AND role='user'
        """,
        (user_message_id, session_id),
    ).fetchone()
    if row is None:
        raise ValueError(
            f"User message {user_message_id} not found in chat session {session_id}."
        )
    normalized_ids = list(dict.fromkeys(int(asset_id) for asset_id in asset_ids))
    if not normalized_ids:
        return []
    placeholders = ",".join("?" for _ in normalized_ids)
    existing_rows = conn.execute(
        f"""
        SELECT asset_id
        FROM chat_attachments
        WHERE session_id=?
          AND user_message_id IS NULL
          AND asset_id IN ({placeholders})
        ORDER BY asset_id ASC
        """,
        [session_id, *normalized_ids],
    ).fetchall()
    existing_ids = {int(existing_row["asset_id"]) for existing_row in existing_rows}
    missing_ids = [asset_id for asset_id in normalized_ids if asset_id not in existing_ids]
    if missing_ids:
        raise ValueError(
            "Pending chat attachment(s) not found for session "
            f"{session_id}: {', '.join(str(asset_id) for asset_id in missing_ids)}."
        )
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    conn.execute(
        f"""
        UPDATE chat_attachments
        SET user_message_id=?
        WHERE session_id=?
          AND user_message_id IS NULL
          AND asset_id IN ({placeholders})
        """,
        [user_message_id, session_id, *normalized_ids],
    )
    conn.execute(
        f"""
        UPDATE assets
        SET updated_at=?
        WHERE id IN ({placeholders})
        """,
        [now.isoformat(), *normalized_ids],
    )
    return list_chat_attachments(conn, session_id, user_message_id=user_message_id)


def delete_pending_chat_attachment(
    conn: sqlite3.Connection,
    session_id: int,
    asset_id: int,
) -> ChatAttachment:
    attachment = get_chat_attachment(conn, session_id, asset_id)
    if attachment is None or attachment.user_message_id is not None:
        raise ValueError(f"Pending chat attachment {asset_id} not found for session {session_id}.")
    conn.execute("DELETE FROM assets WHERE id=?", (asset_id,))
    return attachment


def delete_chat_attachments_for_session(
    conn: sqlite3.Connection,
    session_id: int,
) -> int:
    asset_ids = [
        int(row["asset_id"])
        for row in conn.execute(
            "SELECT asset_id FROM chat_attachments WHERE session_id=?",
            (session_id,),
        ).fetchall()
    ]
    if not asset_ids:
        return 0
    placeholders = ",".join("?" for _ in asset_ids)
    conn.execute(f"DELETE FROM assets WHERE id IN ({placeholders})", asset_ids)
    return len(asset_ids)


def delete_all_chat_attachments(conn: sqlite3.Connection) -> int:
    asset_ids = [
        int(row["asset_id"])
        for row in conn.execute("SELECT asset_id FROM chat_attachments").fetchall()
    ]
    if not asset_ids:
        return 0
    expire_chat_attachment_context_items(conn, asset_ids)
    placeholders = ",".join("?" for _ in asset_ids)
    conn.execute(f"DELETE FROM assets WHERE id IN ({placeholders})", asset_ids)
    return len(asset_ids)


def _serialize_chat_trace_entries(trace_entries: Optional[list[ChatTraceEntry]]) -> str:
    return json.dumps([
        entry.model_dump(mode="json", exclude_none=True)
        for entry in (trace_entries or [])
    ])


def _serialize_chat_context_items(context_items: Optional[list[ChatContextItem]]) -> str:
    return json.dumps([
        item.model_dump(mode="json", exclude_none=True)
        for item in (context_items or [])
    ])


def _deserialize_chat_context_items(raw: str | None) -> list[ChatContextItem]:
    if not raw:
        return []
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(payload, list):
        return []
    out: list[ChatContextItem] = []
    for item in payload:
        try:
            out.append(ChatContextItem.model_validate(item))
        except Exception:
            continue
    return out


def _deserialize_chat_trace_entries(raw: str | None) -> list[ChatTraceEntry]:
    if not raw:
        return []
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(payload, list):
        return []
    out: list[ChatTraceEntry] = []
    for item in payload:
        try:
            out.append(ChatTraceEntry.model_validate(item))
        except Exception:
            continue
    return out


def _serialize_chat_resource_locator(locator: Mapping[str, Any] | None) -> str:
    return json.dumps(dict(locator or {}), ensure_ascii=False, default=str)


def _deserialize_chat_resource_locator(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def _row_to_chat_message(row: sqlite3.Row) -> ChatMessage:
    return ChatMessage(
        id=row["id"],
        session_id=row["session_id"],
        role=row["role"],
        content=row["content"],
        trace_entries=_deserialize_chat_trace_entries(
            row["trace_entries"] if "trace_entries" in row.keys() else None
        ),
        context_items=_deserialize_chat_context_items(
            row["context_items"] if "context_items" in row.keys() else None
        ),
        created_at=datetime.fromisoformat(row["created_at"]),
    )


def _row_to_chat_resource_read(row: sqlite3.Row) -> ChatResourceRead:
    return ChatResourceRead(
        id=row["id"],
        session_id=row["session_id"],
        assistant_message_id=row["assistant_message_id"],
        turn_id=row["turn_id"],
        provider=row["provider"],
        source=row["source"],
        capability_name=row["capability_name"],
        resource_kind=row["resource_kind"],
        resource_id=row["resource_id"],
        label=row["label"],
        summary=row["summary"],
        locator=_deserialize_chat_resource_locator(row["locator_json"]),
        created_at=datetime.fromisoformat(row["created_at"]),
    )


def _row_to_chat_session_summary(
    row: sqlite3.Row,
    project_ids: Optional[list[int]] = None,
) -> ChatSessionSummary:
    return ChatSessionSummary(
        id=row["id"],
        runtime_settings=ChatRuntimeSettings.model_validate_json(row["runtime_settings"]),
        title=row["title"],
        project_ids=project_ids or [],
        created_at=datetime.fromisoformat(row["created_at"]),
        updated_at=datetime.fromisoformat(row["updated_at"]),
        linked_paper_ids=_normalize_linked_ids(json.loads(row["linked_paper_ids"])),
        linked_todo_ids=_normalize_linked_ids(json.loads(row["linked_todo_ids"])),
        linked_progress_ids=_normalize_linked_ids(json.loads(row["linked_progress_ids"])),
    )


def create_chat_session(
    conn: sqlite3.Connection,
    *,
    runtime_settings: ChatRuntimeSettings,
    title: str = "",
    project_ids: Optional[list[int]] = None,
    linked_paper_ids: Optional[list[int]] = None,
    linked_todo_ids: Optional[list[int]] = None,
    linked_progress_ids: Optional[list[int]] = None,
    created_at: Optional[datetime] = None,
) -> ChatSessionSummary:
    runtime_settings = ChatRuntimeSettings.model_validate(runtime_settings)
    resolved_project_ids = _resolve_project_links(
        conn,
        project_ids=project_ids,
    )
    now = created_at or datetime.now(timezone.utc).replace(tzinfo=None)
    cur = conn.execute(
        """
        INSERT INTO chat_sessions
            (title, created_at, updated_at, linked_paper_ids, linked_todo_ids, linked_progress_ids,
             runtime_settings)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            title.strip(),
            now.isoformat(),
            now.isoformat(),
            json.dumps(_normalize_linked_ids(linked_paper_ids)),
            json.dumps(_normalize_linked_ids(linked_todo_ids)),
            json.dumps(_normalize_linked_ids(linked_progress_ids)),
            runtime_settings.model_dump_json(),
        ),
    )
    session_id = int(cur.lastrowid)  # type: ignore[arg-type]
    _replace_project_links(
        conn,
        join_table="project_chat_sessions",
        item_column="chat_session_id",
        item_id=session_id,
        project_ids=resolved_project_ids,
        created_at=now.isoformat(),
    )
    session = get_chat_session_summary(conn, session_id)
    if session is None:
        raise ValueError(f"Chat session {session_id} not found.")
    return session


def get_chat_session_summary(
    conn: sqlite3.Connection,
    session_id: int,
) -> Optional[ChatSessionSummary]:
    row = conn.execute(
        "SELECT * FROM chat_sessions WHERE id=?",
        (session_id,),
    ).fetchone()
    if row is None:
        return None
    project_map = _load_project_link_map(
        conn,
        join_table="project_chat_sessions",
        item_column="chat_session_id",
        item_ids=[session_id],
    )
    return _row_to_chat_session_summary(row, project_map.get(session_id, []))


def list_chat_sessions(
    conn: sqlite3.Connection,
    *,
    project_id: Optional[int] = None,
    limit: int = 50,
) -> list[ChatSessionSummary]:
    query = """
        SELECT DISTINCT chat_sessions.*
        FROM chat_sessions
    """
    params: list[object] = []
    if project_id is not None:
        query += """
            JOIN project_chat_sessions
            ON project_chat_sessions.chat_session_id = chat_sessions.id
            WHERE project_chat_sessions.project_id=?
        """
        params.append(project_id)
    query += " ORDER BY chat_sessions.updated_at DESC, chat_sessions.id DESC LIMIT ?"
    params.append(limit)
    cur = conn.execute(query, params)
    rows = cur.fetchall()
    project_map = _load_project_link_map(
        conn,
        join_table="project_chat_sessions",
        item_column="chat_session_id",
        item_ids=[int(row["id"]) for row in rows],
    )
    return [_row_to_chat_session_summary(row, project_map.get(int(row["id"]), [])) for row in rows]


def get_chat_session_detail(
    conn: sqlite3.Connection,
    session_id: int,
) -> Optional[ChatSessionDetail]:
    session = get_chat_session_summary(conn, session_id)
    if session is None:
        return None

    cur = conn.execute(
        """
        SELECT *
        FROM chat_messages
        WHERE session_id=?
        ORDER BY created_at ASC, id ASC
        """,
        (session_id,),
    )
    return ChatSessionDetail(
        **session.model_dump(),
        messages=[_row_to_chat_message(row) for row in cur.fetchall()],
    )


def get_chat_session_provider_state(
    conn: sqlite3.Connection,
    session_id: int,
) -> dict:
    row = conn.execute(
        "SELECT provider_state FROM chat_sessions WHERE id=?",
        (session_id,),
    ).fetchone()
    if row is None:
        raise ValueError(f"Chat session {session_id} not found.")
    try:
        state = json.loads(row["provider_state"] or "{}")
    except json.JSONDecodeError:
        return {}
    return state if isinstance(state, dict) else {}


def update_chat_session_provider_state(
    conn: sqlite3.Connection,
    session_id: int,
    provider: str,
    provider_state: dict,
) -> dict:
    state = get_chat_session_provider_state(conn, session_id)
    state[provider] = provider_state
    cur = conn.execute(
        "UPDATE chat_sessions SET provider_state=? WHERE id=?",
        (json.dumps(state), session_id),
    )
    if cur.rowcount == 0:
        raise ValueError(f"Chat session {session_id} not found.")
    return state


def append_chat_message(
    conn: sqlite3.Connection,
    session_id: int,
    *,
    role: str,
    content: str,
    trace_entries: Optional[list[ChatTraceEntry]] = None,
    context_items: Optional[list[ChatContextItem]] = None,
    created_at: Optional[datetime] = None,
) -> ChatMessage:
    now = created_at or datetime.now(timezone.utc).replace(tzinfo=None)
    cur = conn.execute(
        """
        INSERT INTO chat_messages (session_id, role, content, trace_entries, context_items, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            session_id,
            role,
            content,
            _serialize_chat_trace_entries(trace_entries),
            _serialize_chat_context_items(context_items),
            now.isoformat(),
        ),
    )
    return ChatMessage(
        id=int(cur.lastrowid),  # type: ignore[arg-type]
        session_id=session_id,
        role=role,  # type: ignore[arg-type]
        content=content,
        trace_entries=list(trace_entries or []),
        context_items=list(context_items or []),
        created_at=now,
    )


def _resource_read_payload(read: ChatResourceReadInput | Mapping[str, Any]) -> dict[str, Any]:
    if isinstance(read, ChatResourceReadInput):
        return {
            "resource_kind": read.resource_kind,
            "resource_id": read.resource_id,
            "label": read.label,
            "summary": read.summary,
            "locator": dict(read.locator),
        }
    if isinstance(read, Mapping):
        return dict(read)
    raise TypeError(f"Unsupported chat resource read payload: {type(read).__name__}")


def insert_chat_resource_reads(
    conn: sqlite3.Connection,
    session_id: int,
    *,
    turn_id: str,
    provider: str,
    source: ChatResourceReadSource,
    reads: Sequence[ChatResourceReadInput | Mapping[str, Any]],
    capability_name: Optional[str] = None,
    assistant_message_id: Optional[int] = None,
    created_at: Optional[datetime] = None,
) -> list[ChatResourceRead]:
    if not reads:
        return []
    now = created_at or datetime.now(timezone.utc).replace(tzinfo=None)
    inserted_ids: list[int] = []
    for read in reads:
        payload = _resource_read_payload(read)
        resource_kind = str(payload.get("resource_kind") or "").strip()
        if not resource_kind:
            raise ValueError("resource_kind is required for chat resource reads.")
        resource_id_value = payload.get("resource_id")
        resource_id = None if resource_id_value is None else str(resource_id_value)
        locator = payload.get("locator") or {}
        if not isinstance(locator, Mapping):
            raise ValueError("locator must be a JSON object for chat resource reads.")
        cur = conn.execute(
            """
            INSERT INTO chat_resource_reads
                (
                    session_id,
                    assistant_message_id,
                    turn_id,
                    provider,
                    source,
                    capability_name,
                    resource_kind,
                    resource_id,
                    label,
                    summary,
                    locator_json,
                    created_at
                )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                assistant_message_id,
                turn_id,
                provider,
                source,
                capability_name if capability_name is not None else payload.get("capability_name"),
                resource_kind,
                resource_id,
                str(payload.get("label") or ""),
                str(payload.get("summary") or ""),
                _serialize_chat_resource_locator(locator),
                now.isoformat(),
            ),
        )
        inserted_ids.append(int(cur.lastrowid))  # type: ignore[arg-type]
    placeholders = ",".join("?" for _ in inserted_ids)
    rows = conn.execute(
        f"""
        SELECT *
        FROM chat_resource_reads
        WHERE id IN ({placeholders})
        ORDER BY created_at ASC, id ASC
        """,
        inserted_ids,
    ).fetchall()
    return [_row_to_chat_resource_read(row) for row in rows]


def list_chat_resource_reads(
    conn: sqlite3.Connection,
    session_id: int,
    *,
    assistant_message_id: Optional[int] = None,
) -> list[ChatResourceRead]:
    query = """
        SELECT *
        FROM chat_resource_reads
        WHERE session_id=?
    """
    params: list[object] = [session_id]
    if assistant_message_id is not None:
        query += " AND assistant_message_id=?"
        params.append(assistant_message_id)
    query += " ORDER BY assistant_message_id ASC, created_at ASC, id ASC"
    rows = conn.execute(query, params).fetchall()
    return [_row_to_chat_resource_read(row) for row in rows]


def attach_chat_resource_reads_to_message(
    conn: sqlite3.Connection,
    session_id: int,
    turn_id: str,
    assistant_message_id: int,
) -> list[ChatResourceRead]:
    row = conn.execute(
        """
        SELECT id
        FROM chat_messages
        WHERE id=? AND session_id=? AND role='assistant'
        """,
        (assistant_message_id, session_id),
    ).fetchone()
    if row is None:
        raise ValueError(
            f"Assistant message {assistant_message_id} not found in chat session {session_id}."
        )
    conn.execute(
        """
        UPDATE chat_resource_reads
        SET assistant_message_id=?
        WHERE session_id=? AND turn_id=?
        """,
        (assistant_message_id, session_id, turn_id),
    )
    return list_chat_resource_reads(
        conn,
        session_id,
        assistant_message_id=assistant_message_id,
    )


def delete_chat_resource_reads_for_turn(
    conn: sqlite3.Connection,
    session_id: int,
    turn_id: str,
) -> None:
    conn.execute(
        "DELETE FROM chat_resource_reads WHERE session_id=? AND turn_id=?",
        (session_id, turn_id),
    )


def touch_chat_session(
    conn: sqlite3.Connection,
    session_id: int,
    *,
    updated_at: Optional[datetime] = None,
) -> ChatSessionSummary:
    now = updated_at or datetime.now(timezone.utc).replace(tzinfo=None)
    cur = conn.execute(
        "UPDATE chat_sessions SET updated_at=? WHERE id=?",
        (now.isoformat(), session_id),
    )
    if cur.rowcount == 0:
        raise ValueError(f"Chat session {session_id} not found.")

    session = get_chat_session_summary(conn, session_id)
    if session is None:
        raise ValueError(f"Chat session {session_id} not found.")
    return session


def update_chat_session(
    conn: sqlite3.Connection,
    session_id: int,
    *,
    runtime_settings: ChatRuntimeSettings | object = _UNSET,
    title: Optional[str] | object = _UNSET,
    project_ids: Optional[list[int]] | object = _UNSET,
    linked_paper_ids: Optional[list[int]] | object = _UNSET,
    linked_todo_ids: Optional[list[int]] | object = _UNSET,
    linked_progress_ids: Optional[list[int]] | object = _UNSET,
) -> ChatSessionSummary:
    assignments: list[str] = []
    params: list[object] = []
    resolved_project_ids: Optional[list[int]] | object = _UNSET

    if runtime_settings is not _UNSET:
        runtime_settings = ChatRuntimeSettings.model_validate(runtime_settings)
        current = get_chat_session_summary(conn, session_id)
        if current is None:
            raise ValueError(f"Chat session {session_id} not found.")
        if runtime_settings.model_dump() != current.runtime_settings.model_dump():
            assignments.extend(["runtime_settings=?", "provider_state=?"])
            params.extend([runtime_settings.model_dump_json(), "{}"])

    if title is not _UNSET:
        assignments.append("title=?")
        params.append(title.strip())
    if project_ids is not _UNSET:
        resolved_project_ids = _resolve_project_links(
            conn,
            project_ids=project_ids,
        )
    if linked_paper_ids is not _UNSET:
        assignments.append("linked_paper_ids=?")
        params.append(json.dumps(_normalize_linked_ids(linked_paper_ids)))
    if linked_todo_ids is not _UNSET:
        assignments.append("linked_todo_ids=?")
        params.append(json.dumps(_normalize_linked_ids(linked_todo_ids)))
    if linked_progress_ids is not _UNSET:
        assignments.append("linked_progress_ids=?")
        params.append(json.dumps(_normalize_linked_ids(linked_progress_ids)))

    if not assignments and resolved_project_ids is _UNSET:
        session = get_chat_session_summary(conn, session_id)
        if session is None:
            raise ValueError(f"Chat session {session_id} not found.")
        return session

    if assignments:
        params.append(session_id)
        cur = conn.execute(
            f"UPDATE chat_sessions SET {', '.join(assignments)} WHERE id=?",
            params,
        )
        if cur.rowcount == 0:
            raise ValueError(f"Chat session {session_id} not found.")
    elif get_chat_session_summary(conn, session_id) is None:
        raise ValueError(f"Chat session {session_id} not found.")

    if resolved_project_ids is not _UNSET:
        _replace_project_links(
            conn,
            join_table="project_chat_sessions",
            item_column="chat_session_id",
            item_id=session_id,
            project_ids=resolved_project_ids,
        )

    session = get_chat_session_summary(conn, session_id)
    if session is None:
        raise ValueError(f"Chat session {session_id} not found.")
    return session


def rename_chat_session(
    conn: sqlite3.Connection,
    session_id: int,
    title: str,
) -> ChatSessionSummary:
    return update_chat_session(conn, session_id, title=title)


def update_chat_session_links(
    conn: sqlite3.Connection,
    session_id: int,
    *,
    linked_paper_ids: Optional[list[int]] = None,
    linked_todo_ids: Optional[list[int]] = None,
    linked_progress_ids: Optional[list[int]] = None,
) -> ChatSessionSummary:
    return update_chat_session(
        conn,
        session_id,
        linked_paper_ids=linked_paper_ids,
        linked_todo_ids=linked_todo_ids,
        linked_progress_ids=linked_progress_ids,
    )


def replace_chat_session_projects(
    conn: sqlite3.Connection,
    session_id: int,
    project_ids: Optional[list[int]],
) -> ChatSessionSummary:
    return update_chat_session(conn, session_id, project_ids=project_ids)


def clear_chat_session_messages(
    conn: sqlite3.Connection,
    session_id: int,
    *,
    updated_at: Optional[datetime] = None,
) -> ChatSessionDetail:
    if get_chat_session_summary(conn, session_id) is None:
        raise ValueError(f"Chat session {session_id} not found.")

    conn.execute("DELETE FROM chat_resource_reads WHERE session_id=?", (session_id,))
    delete_chat_attachments_for_session(conn, session_id)
    conn.execute("DELETE FROM chat_messages WHERE session_id=?", (session_id,))
    touch_chat_session(conn, session_id, updated_at=updated_at)
    session = get_chat_session_detail(conn, session_id)
    if session is None:
        raise ValueError(f"Chat session {session_id} not found.")
    return session


def list_project_chat_sessions(
    conn: sqlite3.Connection,
    project_id: int,
    *,
    limit: int = 50,
) -> list[ChatSessionSummary]:
    if get_project(conn, project_id) is None:
        raise ValueError(f"Project {project_id} not found.")
    return list_chat_sessions(conn, project_id=project_id, limit=limit)


def count_project_chat_sessions(
    conn: sqlite3.Connection,
    project_id: int,
) -> int:
    if get_project(conn, project_id) is None:
        raise ValueError(f"Project {project_id} not found.")
    row = conn.execute(
        "SELECT COUNT(*) FROM project_chat_sessions WHERE project_id=?",
        (project_id,),
    ).fetchone()
    return int(row[0])


def delete_chat_session(conn: sqlite3.Connection, session_id: int) -> None:
    if get_chat_session_summary(conn, session_id) is None:
        raise ValueError(f"Chat session {session_id} not found.")
    delete_chat_attachments_for_session(conn, session_id)
    cur = conn.execute("DELETE FROM chat_sessions WHERE id=?", (session_id,))
    if cur.rowcount == 0:
        raise ValueError(f"Chat session {session_id} not found.")
