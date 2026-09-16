from __future__ import annotations

from claudesk.agent.capabilities.registry import CapabilityRegistry, get_capability_registry
from claudesk.core.config import ChatToolsConfig


def openai_tool_schemas(
    tools_cfg: ChatToolsConfig | None = None,
    *,
    allowed_names: set[str] | None = None,
    registry: CapabilityRegistry | None = None,
) -> list[dict]:
    return (registry or get_capability_registry()).openai_schemas(
        tools_cfg,
        names=allowed_names,
    )


def tool_manifest_hash(
    tools_cfg: ChatToolsConfig | None = None,
    *,
    registry: CapabilityRegistry | None = None,
) -> str:
    return (registry or get_capability_registry()).manifest_hash(tools_cfg)
