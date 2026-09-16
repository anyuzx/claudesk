from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


def _text_from_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for part in value:
            if isinstance(part, dict):
                parts.append(_text_from_value(part.get("text") or part.get("content") or part.get("summary")))
            else:
                parts.append(str(part))
        return "".join(parts)
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _codex_transcript_payload(data: dict) -> dict:
    current = data
    for key in ("event_msg", "response_item", "payload", "item"):
        value = current.get(key)
        if isinstance(value, dict):
            current = value
    return current


def _codex_tool_name(item: dict) -> str:
    invocation = item.get("invocation") if isinstance(item.get("invocation"), dict) else {}
    return str(
        item.get("name")
        or item.get("toolName")
        or item.get("tool_name")
        or item.get("serverName")
        or item.get("server")
        or invocation.get("tool")
        or invocation.get("toolName")
        or invocation.get("name")
        or item.get("call_name")
        or "tool"
    )


def _codex_tool_metadata(item: dict) -> dict[str, Any]:
    event: dict[str, Any] = {"name": _codex_tool_name(item)}
    for source_key, target_key in (
        ("id", "id"),
        ("call_id", "id"),
        ("callId", "id"),
        ("item_id", "id"),
        ("itemId", "id"),
        ("exit_code", "exit_code"),
        ("exitCode", "exit_code"),
        ("server", "server"),
        ("serverName", "server"),
        ("tool", "tool"),
        ("toolName", "tool"),
        ("tool_name", "tool"),
    ):
        if source_key in item and target_key not in event:
            event[target_key] = item[source_key]
    invocation = item.get("invocation") if isinstance(item.get("invocation"), dict) else {}
    if "server" not in event and invocation.get("server"):
        event["server"] = invocation["server"]
    if "tool" not in event and invocation.get("tool"):
        event["tool"] = invocation["tool"]
    return event


def _is_hidden_codex_native_tool(item: dict, lowered_type: str) -> bool:
    name = _codex_tool_name(item)
    if lowered_type in {
        "exec_command",
        "exec_command_end",
        "patch_apply",
        "patch_apply_end",
        "tool_search_call",
        "tool_search_output",
        "web_search_call",
    }:
        return True
    if lowered_type in {"function_call", "function_call_output"} and name in {"exec_command", "tool"}:
        return True
    return False


def _mcp_result_text(result: Any) -> str | None:
    if not isinstance(result, dict):
        return None
    payload = result.get("Ok")
    if not isinstance(payload, dict):
        return None
    content = payload.get("content")
    if not isinstance(content, list):
        return None
    texts = [
        str(part.get("text") or "")
        for part in content
        if isinstance(part, dict) and part.get("type") == "text" and part.get("text")
    ]
    return "\n".join(texts) if texts else None


def _json_payload_from_text(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def _unwrap_nested_content_payload(payload: Any) -> Any:
    for _ in range(4):
        if not isinstance(payload, dict) or not isinstance(payload.get("content"), list):
            return payload
        nested_text = _text_from_value(payload["content"]).strip()
        if not nested_text:
            return payload
        nested_payload = _json_payload_from_text(nested_text)
        if nested_payload is None:
            return payload
        payload = nested_payload
    return payload


def _summarize_mcp_json_payload(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None

    parts: list[str] = []
    if "ok" in payload:
        parts.append(f"ok={str(bool(payload.get('ok'))).lower()}")
    if isinstance(payload.get("papers"), list):
        parts.append(f"papers={len(payload['papers'])}")
    if payload.get("paper_id") is not None:
        parts.append(f"paper_id={payload['paper_id']}")
    asset = payload.get("asset") if isinstance(payload.get("asset"), dict) else {}
    if asset.get("display_name"):
        parts.append(f"asset={asset['display_name']}")
    for key in ("assets", "chunks", "sections", "pages", "notes", "results", "matches", "attached_images"):
        if isinstance(payload.get(key), list):
            parts.append(f"{key}={len(payload[key])}")
    if payload.get("next_chunk_index") is not None:
        parts.append(f"next_chunk_index={payload['next_chunk_index']}")
    if payload.get("error"):
        parts.append(f"error={payload['error']}")
    return " ".join(parts) if parts else None


def _mcp_tool_result_summary(item: dict) -> str | None:
    text = _mcp_result_text(item.get("result"))
    if not text:
        return None
    payload = _unwrap_nested_content_payload(_json_payload_from_text(text))
    return _summarize_mcp_json_payload(payload)


def parse_codex_transcript_event(data: dict) -> dict | None:
    event_type = str(data.get("type") or data.get("event") or data.get("event_type") or "")
    item = _codex_transcript_payload(data)
    item_type = str(item.get("type") or item.get("kind") or item.get("event") or event_type)
    lowered = item_type.lower()

    if lowered in {"task_started", "task_complete", "turn_aborted", "token_count", "compacted"}:
        return None

    if lowered in {"message", "agent_message", "assistant_message"} or "agent_message" in lowered:
        role = str(item.get("role") or "")
        if role and role != "assistant":
            return None
        text = _text_from_value(item.get("text") or item.get("content") or item.get("message"))
        return {"type": "text", "content": text} if text else None

    if "reasoning" in lowered or lowered in {"thinking", "thought"}:
        return None

    tool_start_types = {
        "exec_command",
        "patch_apply",
        "mcp_tool_call",
        "function_call",
        "custom_tool_call",
        "web_search_call",
    }
    tool_end_types = {
        "exec_command_end",
        "patch_apply_end",
        "mcp_tool_call_end",
        "function_call_output",
        "custom_tool_call_output",
    }
    is_tool = (
        lowered in tool_start_types
        or lowered in tool_end_types
        or "tool" in lowered
        or "function" in lowered
        or "mcp" in lowered
        or lowered.startswith("exec_")
        or lowered.startswith("patch_")
        or lowered == "web_search_call"
    )
    if not is_tool:
        return None
    if _is_hidden_codex_native_tool(item, lowered):
        return None

    event = _codex_tool_metadata(item)
    is_result = (
        lowered in tool_end_types
        or lowered.endswith("_end")
        or lowered.endswith("_output")
        or any(key in item for key in ("output", "result", "summary", "content", "stderr", "stdout"))
    )
    if is_result:
        summary = (
            item.get("summary")
            or item.get("output")
            or item.get("result")
            or item.get("content")
            or item.get("stdout")
            or item.get("stderr")
            or ""
        )
        event.update({"type": "tool_result", "summary": (_mcp_tool_result_summary(item) or _text_from_value(summary))[:400]})
        return event
    event["type"] = "tool_start"
    return event


class CodexTranscriptTail:
    def __init__(self, path: str | None) -> None:
        self.path = Path(path).expanduser() if path else None
        self.offset = 0
        self._seen: set[tuple[str, str, str, str]] = set()
        self.available = False

    def prime(self) -> None:
        if self.path is None or not self.path.exists() or not os.access(self.path, os.R_OK):
            self.offset = 0
            self.available = False
            return
        self.offset = self.path.stat().st_size
        self.available = True

    def drain(self) -> list[dict]:
        if self.path is None or not self.path.exists() or not os.access(self.path, os.R_OK):
            return []
        if not self.available:
            self.offset = 0
            self.available = True
        events: list[dict] = []
        with self.path.open("r", encoding="utf-8", errors="replace") as fh:
            fh.seek(self.offset)
            for line in fh:
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue
                event = parse_codex_transcript_event(data)
                if event is None:
                    continue
                key = (
                    str(event.get("id") or ""),
                    str(event.get("type", "")),
                    str(event.get("name", "")),
                    str(event.get("content") or event.get("summary") or ""),
                )
                if key in self._seen:
                    continue
                self._seen.add(key)
                events.append(event)
            self.offset = fh.tell()
        return events


def _normalize_codex_stream_text(text: str) -> str:
    return " ".join(text.split())


def _codex_transcript_text_already_emitted(emitted: str, transcript: str) -> bool:
    if not emitted or not transcript:
        return False
    if transcript == emitted or emitted.startswith(transcript) or emitted.endswith(transcript):
        return True
    return len(transcript) >= 80 and transcript in emitted


def _suffix_after_whitespace_insensitive_prefix(text: str, prefix: str) -> str | None:
    if not prefix:
        return text

    text_index = 0
    prefix_index = 0
    while prefix_index < len(prefix) and text_index < len(text):
        if prefix[prefix_index].isspace():
            while prefix_index < len(prefix) and prefix[prefix_index].isspace():
                prefix_index += 1
            while text_index < len(text) and text[text_index].isspace():
                text_index += 1
            continue
        if text[text_index].isspace():
            while text_index < len(text) and text[text_index].isspace():
                text_index += 1
            continue
        if prefix[prefix_index] != text[text_index]:
            return None
        prefix_index += 1
        text_index += 1

    if prefix_index < len(prefix) and prefix[prefix_index:].strip():
        return None
    return text[text_index:]


class CodexTextCoalescer:
    def __init__(self) -> None:
        self._emitted_text = ""
        self._seen_transcript_texts: set[str] = set()
        self._pending_live_duplicate = ""

    def coalesce(self, event: dict, *, source: str) -> dict | None:
        if event.get("type") != "text":
            return event
        content = str(event.get("content") or "")
        if not content:
            return None
        if source == "transcript":
            return self._coalesce_transcript(event, content)
        return self._coalesce_live(event, content)

    def _coalesce_live(self, event: dict, content: str) -> dict | None:
        content = self._trim_pending_live_duplicate(content)
        if not content:
            return None
        self._emitted_text += content
        return {**event, "content": content}

    def _coalesce_transcript(self, event: dict, content: str) -> dict | None:
        normalized = _normalize_codex_stream_text(content)
        if not normalized or normalized in self._seen_transcript_texts:
            return None
        self._seen_transcript_texts.add(normalized)

        emitted_normalized = _normalize_codex_stream_text(self._emitted_text)
        if emitted_normalized:
            if _codex_transcript_text_already_emitted(emitted_normalized, normalized):
                return None
            suffix = _suffix_after_whitespace_insensitive_prefix(content, self._emitted_text)
            if suffix is not None:
                if not _normalize_codex_stream_text(suffix):
                    return None
                return self._emit_transcript_text(event, suffix)
            if _suffix_after_whitespace_insensitive_prefix(self._emitted_text, content) is not None:
                return None

        return self._emit_transcript_text(event, content)

    def _emit_transcript_text(self, event: dict, content: str) -> dict:
        self._emitted_text += content
        self._pending_live_duplicate += content
        return {**event, "content": content}

    def _trim_pending_live_duplicate(self, content: str) -> str:
        pending = self._pending_live_duplicate
        if not pending:
            return content

        pending_after_content = _suffix_after_whitespace_insensitive_prefix(pending, content)
        if pending_after_content is not None:
            self._pending_live_duplicate = pending_after_content
            return ""

        content_after_pending = _suffix_after_whitespace_insensitive_prefix(content, pending)
        if content_after_pending is not None:
            self._pending_live_duplicate = ""
            return content_after_pending

        return content


def parse_codex_app_server_notification(message: dict, *, thread_id: str | None = None, turn_id: str | None = None) -> dict | None:
    method = str(message.get("method") or message.get("type") or "")
    params = message.get("params") if isinstance(message.get("params"), dict) else message
    if thread_id and params.get("threadId") not in {None, thread_id}:
        return None
    nested_turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
    message_turn_id = params.get("turnId") or nested_turn.get("id")
    if turn_id and message_turn_id not in {None, turn_id}:
        return None

    if method == "item/agentMessage/delta":
        delta = params.get("delta")
        return {"type": "text", "content": delta} if isinstance(delta, str) and delta else None
    if method in {"item/reasoning/summaryTextDelta", "item/reasoning/textDelta"}:
        delta = params.get("delta") or params.get("text")
        return {"type": "progress", "content": delta} if isinstance(delta, str) and delta else None
    if method in {"turn/completed", "turn/failed"}:
        return {"type": "done", "finish_reason": "stop"}
    if method == "error":
        detail = params.get("message") or params.get("error") or params
        return {"type": "text", "content": f"\n\n[Codex app-server error: {detail}]"}
    if method in {"item/started", "item/completed"}:
        item = params.get("item") if isinstance(params.get("item"), dict) else {}
        item_type = str(item.get("type") or item.get("kind") or "")
        name = item.get("name") or item.get("toolName") or item.get("serverName") or "tool"
        if "tool" in item_type.lower() or "mcp" in item_type.lower():
            if method == "item/started":
                return {"type": "tool_start", "name": name}
            summary = item.get("summary") or item.get("output") or item.get("result") or ""
            return {"type": "tool_result", "name": name, "summary": str(summary)[:400]}
    if method in {"mcp/tool/call/progress", "item/tool/call"}:
        name = params.get("name") or params.get("toolName") or "tool"
        return {"type": "tool_start", "name": name}
    return None
