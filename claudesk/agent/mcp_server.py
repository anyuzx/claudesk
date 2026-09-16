from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
from typing import Any

import mcp.server.stdio
import mcp.types as types
from mcp.server.lowlevel import NotificationOptions, Server
from pydantic import ValidationError

from claudesk import __version__
from claudesk.agent.capabilities.registry import CapabilityDisabledError, CapabilityNotFoundError
from claudesk.agent.codex_runtime import codex_mcp_ledger_context_path
from claudesk.agent.exports.mcp import call_mcp_tool, mcp_tools
from claudesk.agent.schemas import CapabilityResult
from claudesk.core.config import Config, load_config
from claudesk.core.db import get_connection
from claudesk.core.db.chat import insert_chat_resource_reads

logger = logging.getLogger(__name__)


def _rollback_quietly(conn: sqlite3.Connection, *, boundary: str, capability_name: str) -> None:
    if not conn.in_transaction:
        return
    try:
        conn.rollback()
    except Exception:
        logger.exception(
            "Failed to roll back %s transaction",
            boundary,
            extra={"capability_name": capability_name},
        )


def _active_ledger_context() -> dict[str, Any] | None:
    path = codex_mcp_ledger_context_path()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    if not isinstance(payload, dict):
        return None
    try:
        session_id = int(payload.get("session_id"))
    except (TypeError, ValueError):
        return None
    turn_id = str(payload.get("turn_id") or "").strip()
    provider = str(payload.get("provider") or "codex_cli").strip()
    if session_id <= 0 or not turn_id or not provider:
        return None
    return {"session_id": session_id, "turn_id": turn_id, "provider": provider}


def _persist_mcp_resource_reads(
    conn: sqlite3.Connection,
    *,
    capability_name: str,
    result: CapabilityResult,
) -> None:
    if not result.resource_reads:
        return
    context = _active_ledger_context()
    if context is None:
        return
    try:
        insert_chat_resource_reads(
            conn,
            context["session_id"],
            turn_id=context["turn_id"],
            provider=context["provider"],
            source="capability_result",
            capability_name=capability_name,
            reads=result.resource_reads,
        )
        conn.commit()
    except Exception:
        _rollback_quietly(conn, boundary="MCP resource-read", capability_name=capability_name)
        logger.exception(
            "Failed to persist MCP resource reads",
            extra={
                "capability_name": capability_name,
                "session_id": context["session_id"],
                "turn_id": context["turn_id"],
                "provider": context["provider"],
            },
        )


def _content_blocks(result: CapabilityResult, cfg: Config) -> list[types.ContentBlock]:
    content: list[types.ContentBlock] = [types.TextContent(type="text", text=result.text)]
    content.extend(
        types.ImageContent(
            type="image",
            data=image.data_base64(cfg=cfg),
            mimeType=image.mime_type,
        )
        for image in result.images
    )
    return content


def _tool_error_result(
    *,
    error_type: str,
    name: str,
    message: str,
    errors: list[dict[str, Any]] | None = None,
) -> types.CallToolResult:
    payload: dict[str, Any] = {
        "ok": False,
        "type": error_type,
        "name": name,
        "error": message,
    }
    if errors is not None:
        payload["errors"] = errors
    return types.CallToolResult(
        content=[
            types.TextContent(
                type="text",
                text=json.dumps(payload, ensure_ascii=False, default=str),
            )
        ],
        isError=True,
    )


def call_tool_result(
    name: str,
    args: dict[str, Any] | None,
    conn: sqlite3.Connection,
) -> types.CallToolResult:
    cfg = load_config()
    ledger_context = _active_ledger_context()
    try:
        rich = call_mcp_tool(
            name,
            args or {},
            conn,
            cfg=cfg,
            session_id=ledger_context["session_id"] if ledger_context else None,
        )
    except CapabilityNotFoundError as exc:
        return _tool_error_result(
            error_type="unknown_capability",
            name=name,
            message=str(exc),
        )
    except CapabilityDisabledError as exc:
        return _tool_error_result(
            error_type="disabled_capability",
            name=name,
            message=str(exc),
        )
    except ValidationError as exc:
        return _tool_error_result(
            error_type="validation_error",
            name=name,
            message="Invalid capability arguments.",
            errors=exc.errors(),
        )
    except Exception as exc:
        _rollback_quietly(conn, boundary="MCP capability", capability_name=name)
        return _tool_error_result(
            error_type="capability_execution_error",
            name=name,
            message=str(exc),
        )
    _persist_mcp_resource_reads(conn, capability_name=name, result=rich)
    return types.CallToolResult(
        content=_content_blocks(rich, cfg),
        isError=False,
    )


def create_server(conn: sqlite3.Connection) -> Server:
    server = Server("claudesk", version=__version__)

    @server.list_tools()
    async def list_tools() -> list[types.Tool]:
        cfg = load_config()
        return mcp_tools(cfg.chat.tools)

    @server.call_tool(validate_input=False)
    async def call_tool(name: str, arguments: dict[str, Any]) -> types.CallToolResult:
        return call_tool_result(name, arguments, conn)

    return server


async def run() -> None:
    conn = get_connection()
    try:
        server = create_server(conn)
        async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
            await server.run(
                read_stream,
                write_stream,
                server.create_initialization_options(
                    notification_options=NotificationOptions(),
                    experimental_capabilities={},
                ),
            )
    finally:
        conn.close()


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
