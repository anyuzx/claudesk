from __future__ import annotations

import asyncio
import json
import logging
import threading
import uuid
from collections.abc import AsyncGenerator
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator
from starlette.types import Receive, Scope, Send

from claudesk.agent.context import (
    chat_context_resource_reads,
    chat_context_prompt_block,
    note_ids_from_chat_context,
    paper_ids_from_chat_context,
    project_ids_from_chat_context,
    resolve_chat_context_items,
)
from claudesk.agent.controller import TurnController
from claudesk.agent.prompts import get_system_prompt
from claudesk.agent.runtime import ProviderTurnRequest, list_chat_models, shutdown_provider_runtimes, stream_provider_turn
from claudesk.api.deps import get_conn
from claudesk.core.config import CHAT_RUNTIME_CATALOG, ChatBackend, ChatRuntimeSettings, load_config
from claudesk.core.db.chat import (
    append_chat_message,
    attach_chat_attachments_to_message,
    attach_chat_resource_reads_to_message,
    clear_chat_session_messages,
    create_chat_attachment,
    create_chat_session,
    delete_pending_chat_attachment,
    delete_chat_resource_reads_for_turn,
    delete_chat_session,
    get_chat_attachment,
    get_chat_session_detail,
    get_chat_session_provider_state,
    insert_chat_resource_reads,
    list_chat_attachments,
    list_chat_resource_reads,
    list_chat_sessions,
    rename_chat_session,
    touch_chat_session,
    update_chat_session_provider_state,
    update_chat_session,
    update_chat_session_links,
)
from claudesk.core.chat_workflows import (
    assistant_message_for_llm,
    attachment_asset_ids_from_context,
    cleanup_app_lifetime_chat_attachments,
    cleanup_chat_attachment_files,
    context_item_for_chat_attachment,
    config_for_chat_session,
    conversation_paper_ids,
    get_chat_session_or_raise,
    initial_session_title,
    linked_paper_context,
    merge_linked_paper_ids,
    normalize_chat_message,
    paper_context_ids_from_context,
    paper_ids_from_text,
    pdf_asset_ids_from_context,
    prepare_chat_attachment_upload,
)
from claudesk.core.errors import NotFoundError, ValidationError
from claudesk.core.models import AssetParseStatus, ChatContextItem, ChatTraceEntry
from claudesk.core.paper_assets import (
    InvalidPaperAssetFile,
    delete_chat_attachment_file,
    store_managed_chat_attachment,
)

logger = logging.getLogger(__name__)
router = APIRouter()
_active_chat_turns: dict[int, str] = {}
_chat_turn_lock = threading.Lock()


class _ChatStreamingResponse(StreamingResponse):
    def __init__(self, session_id: int, turn_id: str, content: AsyncGenerator[str, None]):
        super().__init__(
            content,
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )
        self._session_id = session_id
        self._turn_id = turn_id

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            try:
                await self.body_iterator.aclose()
            finally:
                with _chat_turn_lock:
                    if _active_chat_turns.get(self._session_id) == self._turn_id:
                        _active_chat_turns.pop(self._session_id)


async def provider_stream(request: ProviderTurnRequest):
    async for event in stream_provider_turn(request):
        yield event


async def shutdown_chat_provider_runtimes() -> None:
    await shutdown_provider_runtimes()


class _ChatRuntimeRequest(BaseModel):
    runtime_settings: ChatRuntimeSettings | None = None

    @field_validator("runtime_settings", mode="before")
    @classmethod
    def require_complete_runtime(cls, value):
        if isinstance(value, ChatRuntimeSettings):
            value = value.model_dump()
        if isinstance(value, dict):
            if "backend" not in value:
                raise ValueError("Runtime settings must include backend.")
            backend = value["backend"]
            if isinstance(backend, str) and backend in CHAT_RUNTIME_CATALOG:
                missing = CHAT_RUNTIME_CATALOG[backend]["defaults"].keys() - value.keys()
                if missing:
                    raise ValueError("Runtime settings must include " + ", ".join(sorted(missing)) + ".")
        return value


class CreateChatSessionRequest(_ChatRuntimeRequest):
    title: str = ""
    project_ids: list[int] = Field(default_factory=list)
    linked_paper_ids: list[int] = Field(default_factory=list)
    linked_todo_ids: list[int] = Field(default_factory=list)
    linked_progress_ids: list[int] = Field(default_factory=list)


class UpdateChatSessionRequest(_ChatRuntimeRequest):
    title: Optional[str] = None
    project_ids: Optional[list[int]] = None
    linked_paper_ids: Optional[list[int]] = None
    linked_todo_ids: Optional[list[int]] = None
    linked_progress_ids: Optional[list[int]] = None


class CreateChatMessageRequest(BaseModel):
    content: str
    context_items: list[ChatContextItem] = Field(default_factory=list)


def _trace_label_for_tool(name: str) -> str:
    return name.replace("_", " ")


def _chat_context_trace_entry(items: list[ChatContextItem]) -> ChatTraceEntry | None:
    if not items:
        return None
    labels = [
        (item.label or item.kind.replace("_", " ")).strip()
        for item in items
    ]
    detail = "Attached context: " + "; ".join(label for label in labels if label)
    return ChatTraceEntry(
        type="context",
        status="done",
        label="Context",
        detail=detail,
        context_items=items,
    )


def _provider_event_to_trace_entry(event: dict) -> ChatTraceEntry | None:
    event_type = event.get("type")
    if event_type == "progress":
        detail = str(event.get("content") or event.get("summary") or "").strip()
        if not detail:
            return None
        return ChatTraceEntry(type="progress", status="running", label="Progress", detail=detail)
    if event_type == "tool_start":
        name = str(event.get("name") or "tool")
        return ChatTraceEntry(
            type="tool_start",
            status="running",
            label=_trace_label_for_tool(name),
            name=name,
        )
    if event_type == "tool_result":
        name = str(event.get("name") or "tool")
        summary = str(event.get("summary") or "")
        return ChatTraceEntry(
            type="tool_result",
            status="done",
            label=_trace_label_for_tool(name),
            name=name,
            summary=summary,
        )
    if event_type == "trace":
        payload = event.get("entry")
        try:
            return ChatTraceEntry.model_validate(payload)
        except Exception:
            return None
    return None


def _join_progress_detail(current: str, fragment: str) -> str:
    if not current:
        return fragment
    if not fragment:
        return current
    if current[-1].isspace() or fragment[0].isspace():
        return current + fragment
    if fragment[0] in ".,;:!?)]}%":
        return current + fragment
    if current[-1] in "([{":
        return current + fragment
    return f"{current} {fragment}"


def _append_trace_entry(entries: list[ChatTraceEntry], entry: ChatTraceEntry) -> None:
    if entries and entry.type == "progress":
        previous = entries[-1]
        if (
            previous.type == "progress"
            and previous.status == entry.status
            and previous.label == entry.label
            and previous.name == entry.name
        ):
            previous.detail = _join_progress_detail(previous.detail, entry.detail)
            if entry.summary:
                previous.summary = _join_progress_detail(previous.summary, entry.summary)
            return
    entries.append(entry)


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, default=str)}\n\n"


def _trace_sse(entry: ChatTraceEntry) -> str:
    return _sse({"type": "trace", "entry": entry.model_dump(mode="json", exclude_none=True)})


def _get_session_or_404(conn, session_id: int):
    try:
        return get_chat_session_or_raise(conn, session_id)
    except NotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/chat/models")
async def get_chat_models(backend: ChatBackend, refresh: bool = False):
    return await list_chat_models(load_config(), backend, refresh=refresh)


@router.get("/chat/sessions")
def get_chat_sessions(conn=Depends(get_conn)):
    return [session.model_dump() for session in list_chat_sessions(conn)]


@router.post("/chat/sessions")
def create_chat_session_endpoint(body: CreateChatSessionRequest, conn=Depends(get_conn)):
    try:
        session = create_chat_session(
            conn,
            title=body.title,
            runtime_settings=body.runtime_settings or load_config().chat.runtime_settings(),
            project_ids=body.project_ids,
            linked_paper_ids=body.linked_paper_ids,
            linked_todo_ids=body.linked_todo_ids,
            linked_progress_ids=body.linked_progress_ids,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    conn.commit()
    detail = get_chat_session_detail(conn, session.id or 0)
    if detail is None:
        raise HTTPException(status_code=500, detail="Failed to load created chat session.")
    return detail.model_dump()


@router.get("/chat/sessions/{session_id}")
def get_chat_session_endpoint(session_id: int, conn=Depends(get_conn)):
    session = _get_session_or_404(conn, session_id)
    return session.model_dump()


@router.get("/chat/sessions/{session_id}/resource-reads")
def get_chat_session_resource_reads_endpoint(
    session_id: int,
    assistant_message_id: Optional[int] = None,
    conn=Depends(get_conn),
):
    _get_session_or_404(conn, session_id)
    reads = list_chat_resource_reads(
        conn,
        session_id,
        assistant_message_id=assistant_message_id,
    )
    return [read.model_dump(mode="json") for read in reads]


@router.post("/chat/sessions/{session_id}/attachments")
def upload_chat_attachment_endpoint(
    session_id: int,
    kind: str = Form(...),
    file: UploadFile | None = File(None),
    text: Optional[str] = Form(None),
    conn=Depends(get_conn),
):
    _get_session_or_404(conn, session_id)
    try:
        prepared = prepare_chat_attachment_upload(
            kind=kind,
            file_obj=file.file if file is not None else None,
            filename=file.filename if file is not None else None,
            mime_type=file.content_type if file is not None else None,
            text=text,
        )
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    cfg = load_config()
    try:
        stored = store_managed_chat_attachment(
            session_id=session_id,
            file_obj=prepared.file_obj,
            filename=prepared.filename,
            mime_type=prepared.mime_type,
            max_bytes=prepared.max_bytes,
            default_filename=prepared.default_filename,
            cfg=cfg,
        )
    except InvalidPaperAssetFile as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        attachment = create_chat_attachment(
            conn,
            session_id,
            context_kind=prepared.context_kind,
            kind=prepared.asset_kind,
            source="chat",
            managed_path=stored.managed_path,
            original_filename=stored.original_filename,
            display_name=prepared.display_name,
            mime_type=prepared.mime_type,
            size_bytes=stored.size_bytes,
            content_hash=stored.content_hash,
            parse_status=(
                AssetParseStatus.PARSED
                if prepared.parsed_text is not None
                else AssetParseStatus.NOT_PARSED
            ),
            parsed_text=prepared.parsed_text,
        )
        context_item = context_item_for_chat_attachment(attachment.asset.id or 0, prepared)
        resolved = resolve_chat_context_items(conn, [context_item], session_id=session_id, cfg=cfg)
        conn.commit()
    except ValueError as exc:
        delete_chat_attachment_file(stored.managed_path, cfg=cfg)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception:
        delete_chat_attachment_file(stored.managed_path, cfg=cfg)
        raise
    return resolved[0].model_dump(mode="json")


@router.delete("/chat/sessions/{session_id}/attachments/{asset_id}")
def delete_chat_attachment_endpoint(session_id: int, asset_id: int, conn=Depends(get_conn)):
    _get_session_or_404(conn, session_id)
    attachment = get_chat_attachment(conn, session_id, asset_id)
    if attachment is None or attachment.user_message_id is not None:
        raise HTTPException(status_code=404, detail=f"Pending chat attachment {asset_id} not found.")
    cfg = load_config()
    cleanup_chat_attachment_files(conn, [attachment], cfg=cfg)
    delete_pending_chat_attachment(conn, session_id, asset_id)
    conn.commit()
    return {"ok": True}


@router.patch("/chat/sessions/{session_id}")
def update_chat_session_endpoint(
    session_id: int,
    body: UpdateChatSessionRequest,
    conn=Depends(get_conn),
):
    payload = {key: getattr(body, key) for key in body.model_fields_set}
    if "title" in payload:
        title = (payload["title"] or "").strip()
        if not title:
            raise HTTPException(status_code=400, detail="Session title cannot be empty.")
        payload["title"] = title
    if "runtime_settings" in payload and payload["runtime_settings"] is None:
        raise HTTPException(status_code=400, detail="Runtime settings cannot be null.")

    # Serialize runtime updates against turn reservation so a turn cannot restore
    # a provider thread belonging to a superseded session configuration.
    with _chat_turn_lock:
        if "runtime_settings" in payload and session_id in _active_chat_turns:
            raise HTTPException(status_code=409, detail="Wait for this chat's response to finish before changing runtime settings.")
        try:
            update_chat_session(conn, session_id, **payload)
            session = _get_session_or_404(conn, session_id)
            conn.commit()
        except Exception as exc:
            conn.rollback()
            if isinstance(exc, ValueError):
                raise HTTPException(status_code=404, detail=str(exc)) from exc
            raise
    return session.model_dump()


@router.delete("/chat/sessions/{session_id}")
def delete_chat_session_endpoint(session_id: int, conn=Depends(get_conn)):
    _get_session_or_404(conn, session_id)
    cfg = load_config()
    attachments = list_chat_attachments(conn, session_id)
    cleanup_chat_attachment_files(conn, attachments, cfg=cfg)
    try:
        delete_chat_session(conn, session_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    conn.commit()
    return {"ok": True}


@router.delete("/chat/sessions/{session_id}/messages")
def clear_chat_session_messages_endpoint(session_id: int, conn=Depends(get_conn)):
    _get_session_or_404(conn, session_id)
    cfg = load_config()
    attachments = list_chat_attachments(conn, session_id)
    cleanup_chat_attachment_files(conn, attachments, cfg=cfg)
    try:
        session = clear_chat_session_messages(conn, session_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    conn.commit()
    return session.model_dump()


@router.post("/chat/sessions/{session_id}/messages/stream")
async def stream_chat_message(
    session_id: int,
    body: CreateChatMessageRequest,
    conn=Depends(get_conn),
):
    user_content = body.content.strip()
    if not user_content:
        raise HTTPException(status_code=400, detail="Chat message content cannot be empty.")
    turn_id = uuid.uuid4().hex
    with _chat_turn_lock:
        if session_id in _active_chat_turns:
            raise HTTPException(status_code=409, detail="This chat already has a response in progress.")
        session = _get_session_or_404(conn, session_id)
        cfg = config_for_chat_session(load_config(), session.runtime_settings)
        try:
            resolved_context_items = resolve_chat_context_items(
                conn,
                body.context_items,
                session_id=session_id,
                cfg=cfg,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        _active_chat_turns[session_id] = turn_id

    user_created_at = datetime.now(timezone.utc).replace(tzinfo=None)

    async def generate():
        assistant_persisted = False
        try:
            mentioned_paper_ids = paper_ids_from_text(user_content)
            context_paper_ids = paper_ids_from_chat_context(resolved_context_items)
            context_project_ids = project_ids_from_chat_context(resolved_context_items)
            context_note_ids = note_ids_from_chat_context(resolved_context_items)
            context_attachment_ids = attachment_asset_ids_from_context(resolved_context_items)
            explicit_context_paper_ids = paper_context_ids_from_context(resolved_context_items)
            context_pdf_asset_ids = pdf_asset_ids_from_context(resolved_context_items)
            fallback_linked_paper_ids = merge_linked_paper_ids(
                session.linked_paper_ids,
                conversation_paper_ids(session.messages),
            )
            turn_linked_paper_ids = mentioned_paper_ids or context_paper_ids or fallback_linked_paper_ids
            effective_linked_paper_ids = merge_linked_paper_ids(
                fallback_linked_paper_ids,
                context_paper_ids,
                mentioned_paper_ids,
            )
            turn_plan = TurnController(conn, cfg).plan_turn(
                user_content,
                linked_paper_ids=turn_linked_paper_ids,
                attached_paper_ids=explicit_context_paper_ids,
                attached_project_ids=context_project_ids,
                attached_note_ids=context_note_ids,
                attached_attachment_ids=context_attachment_ids,
                attached_pdf_asset_ids=context_pdf_asset_ids,
            )
            if turn_plan.fail_closed_response is not None:
                assistant_created_at = datetime.now(timezone.utc).replace(tzinfo=None)
                trace_entries = [
                    ChatTraceEntry(
                        type="warning",
                        status="warning",
                        label="Turn blocked",
                        detail=turn_plan.fail_closed_response,
                    )
                ]
                user_message = append_chat_message(
                    conn,
                    session_id,
                    role="user",
                    content=user_content,
                    context_items=resolved_context_items,
                    created_at=user_created_at,
                )
                attach_chat_attachments_to_message(
                    conn,
                    session_id,
                    context_attachment_ids,
                    user_message.id or 0,
                )
                append_chat_message(
                    conn,
                    session_id,
                    role="assistant",
                    content=turn_plan.fail_closed_response,
                    trace_entries=trace_entries,
                    created_at=assistant_created_at,
                )
                if not session.messages and not session.title.strip():
                    rename_chat_session(conn, session_id, initial_session_title(user_content))
                if effective_linked_paper_ids != session.linked_paper_ids:
                    update_chat_session_links(conn, session_id, linked_paper_ids=effective_linked_paper_ids)
                touch_chat_session(conn, session_id, updated_at=assistant_created_at)
                conn.commit()
                for entry in trace_entries:
                    yield _trace_sse(entry)
                yield _sse({"type": "text", "content": turn_plan.fail_closed_response})
                yield _sse({"type": "done"})
                return

            messages: list[dict] = [{"role": "system", "content": get_system_prompt(cfg)}]
            for message in session.messages:
                if message.role == "user":
                    messages.append(
                        normalize_chat_message({
                            "role": "user",
                            "content": message.content,
                        })
                    )
                else:
                    messages.append(assistant_message_for_llm(message))

            latest_user_message = normalize_chat_message({"role": "user", "content": user_content})
            context_block = chat_context_prompt_block(resolved_context_items)
            if context_block:
                latest_user_message = {
                    **latest_user_message,
                    "content": f"{latest_user_message['content']}{context_block}",
                }
            linked_paper_prompt = linked_paper_context(turn_linked_paper_ids)
            if linked_paper_prompt:
                latest_user_message = {
                    **latest_user_message,
                    "content": f"{latest_user_message['content']}{linked_paper_prompt}",
                }
            messages.append(latest_user_message)

            assistant_chunks: list[str] = []
            trace_entries: list[ChatTraceEntry] = []
            provider_state = get_chat_session_provider_state(conn, session_id)

            async def persist_provider_state(next_state: dict) -> None:
                for provider, state in next_state.items():
                    update_chat_session_provider_state(conn, session_id, provider, state)
                conn.commit()

            def record_model_event(event: dict) -> str | None:
                if event["type"] == "text":
                    assistant_chunks.append(event["content"])
                    return _sse(event)
                trace_entry = _provider_event_to_trace_entry(event)
                if trace_entry is not None:
                    _append_trace_entry(trace_entries, trace_entry)
                    return _trace_sse(trace_entry)
                return None

            context_trace_entry = _chat_context_trace_entry(resolved_context_items)
            if context_trace_entry is not None:
                trace_entries.append(context_trace_entry)
                yield _trace_sse(context_trace_entry)

            request = ProviderTurnRequest(
                messages=messages,
                cfg=cfg,
                conn=conn,
                allowed_capabilities=turn_plan.allowed_capabilities,
                required_capabilities=turn_plan.required_capabilities,
                requires_note_write=turn_plan.requires_note_write,
                session_id=session_id,
                turn_id=turn_id,
                provider_state=provider_state,
                update_provider_state=persist_provider_state,
            )
            async for event in provider_stream(request):
                sse_event = record_model_event(event)
                if sse_event is not None:
                    yield sse_event

            assistant_created_at = datetime.now(timezone.utc).replace(tzinfo=None)
            user_message = append_chat_message(
                conn,
                session_id,
                role="user",
                content=user_content,
                context_items=resolved_context_items,
                created_at=user_created_at,
            )
            attach_chat_attachments_to_message(
                conn,
                session_id,
                context_attachment_ids,
                user_message.id or 0,
            )
            assistant_message = append_chat_message(
                conn,
                session_id,
                role="assistant",
                content="".join(assistant_chunks),
                trace_entries=trace_entries,
                created_at=assistant_created_at,
            )
            prompt_reads = chat_context_resource_reads(resolved_context_items)
            if prompt_reads:
                insert_chat_resource_reads(
                    conn,
                    session_id,
                    turn_id=turn_id,
                    provider=cfg.chat.backend,
                    source="prompt_context",
                    reads=prompt_reads,
                    assistant_message_id=None,
                    created_at=user_created_at,
                )
            attach_chat_resource_reads_to_message(
                conn,
                session_id,
                turn_id,
                assistant_message.id or 0,
            )
            if not session.messages and not session.title.strip():
                rename_chat_session(conn, session_id, initial_session_title(user_content))
            if effective_linked_paper_ids != session.linked_paper_ids:
                update_chat_session_links(conn, session_id, linked_paper_ids=effective_linked_paper_ids)
            touch_chat_session(conn, session_id, updated_at=assistant_created_at)
            conn.commit()
            assistant_persisted = True

            yield _sse({"type": "done"})
        except (asyncio.CancelledError, GeneratorExit):
            logger.info("Chat stream canceled before persistence", extra={"session_id": session_id})
            if not assistant_persisted:
                delete_chat_resource_reads_for_turn(conn, session_id, turn_id)
                conn.commit()
            raise
        except Exception:
            if not assistant_persisted:
                delete_chat_resource_reads_for_turn(conn, session_id, turn_id)
                conn.commit()
            raise
        finally:
            with _chat_turn_lock:
                if _active_chat_turns.get(session_id) == turn_id:
                    _active_chat_turns.pop(session_id)

    return _ChatStreamingResponse(session_id, turn_id, generate())
