from __future__ import annotations

import sqlite3

from claudesk.agent.capabilities.registry import (
    CapabilityDisabledError,
    CapabilityError,
    CapabilityNotFoundError,
    CapabilityRegistry,
    CapabilitySpec,
    get_capability_registry,
)
from claudesk.agent.context import CapabilityContext
from claudesk.agent.schemas import CapabilityResult, ToolImageAttachment
from claudesk.core.config import ChatToolsConfig, Config


def execute_capability(
    name: str,
    args: dict,
    conn: sqlite3.Connection,
    *,
    cfg: Config | None = None,
    tools_cfg: ChatToolsConfig | None = None,
) -> CapabilityResult:
    context = CapabilityContext.for_connection(conn, cfg=cfg)
    return get_capability_registry().execute(
        name,
        args,
        context,
        tools_cfg=tools_cfg,
    )


def execute_capability_text(
    name: str,
    args: dict,
    conn: sqlite3.Connection,
    *,
    cfg: Config | None = None,
    tools_cfg: ChatToolsConfig | None = None,
) -> str:
    return execute_capability(name, args, conn, cfg=cfg, tools_cfg=tools_cfg).text


def capability_enabled(name: str, tools_cfg: ChatToolsConfig) -> bool:
    return get_capability_registry().enabled_for(name, tools_cfg)


__all__ = [
    "CapabilityDisabledError",
    "CapabilityError",
    "CapabilityNotFoundError",
    "CapabilityRegistry",
    "CapabilityResult",
    "CapabilitySpec",
    "ToolImageAttachment",
    "capability_enabled",
    "execute_capability",
    "execute_capability_text",
    "get_capability_registry",
]
