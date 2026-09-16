from __future__ import annotations

import sqlite3

import mcp.types as types

from claudesk.agent.capabilities.registry import CapabilityRegistry, get_capability_registry
from claudesk.agent.context import CapabilityContext
from claudesk.agent.schemas import CapabilityResult
from claudesk.core.config import ChatToolsConfig, Config


def mcp_tools(
    tools_cfg: ChatToolsConfig,
    *,
    registry: CapabilityRegistry | None = None,
) -> list[types.Tool]:
    out = []
    for spec in (registry or get_capability_registry()).enabled(tools_cfg):
        out.append(types.Tool(
            name=spec.name,
            description=spec.description,
            inputSchema=spec.input_schema(),
        ))
    return out


def call_mcp_tool(
    name: str,
    args: dict,
    conn: sqlite3.Connection,
    *,
    cfg: Config,
    session_id: int | None = None,
    registry: CapabilityRegistry | None = None,
) -> CapabilityResult:
    active_registry = registry or get_capability_registry()
    return active_registry.execute(
        name,
        args,
        CapabilityContext.for_connection(conn, cfg=cfg, session_id=session_id),
        tools_cfg=cfg.chat.tools,
    )
