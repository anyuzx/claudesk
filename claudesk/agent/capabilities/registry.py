from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Callable, Iterable, Literal

from pydantic import BaseModel, ValidationError

from claudesk.agent.context import CapabilityContext
from claudesk.agent.schemas import CapabilityInput, CapabilityJsonOutput, CapabilityResult
from claudesk.core.config import ChatToolsConfig


class CapabilityError(RuntimeError):
    pass


class CapabilityNotFoundError(CapabilityError):
    pass


class CapabilityDisabledError(CapabilityError):
    pass


CapabilityHandler = Callable[[CapabilityInput, CapabilityContext], CapabilityResult]
CapabilityDomain = Literal["web", "paper", "project", "task", "log", "note", "asset"]
CapabilityAccess = Literal["read", "create", "update", "link", "external_ingest"]
CapabilityRisk = Literal["low", "medium", "high"]


@dataclass(frozen=True)
class CapabilitySpec:
    name: str
    description: str
    input_model: type[CapabilityInput]
    handler: CapabilityHandler
    domain: CapabilityDomain
    access: CapabilityAccess
    risk: CapabilityRisk
    output_model: type[BaseModel] = CapabilityJsonOutput
    gate: str | tuple[str, ...] | None = None

    def input_schema(self) -> dict:
        schema = self.input_model.model_json_schema()
        schema.setdefault("type", "object")
        schema.pop("title", None)
        return schema

    def output_schema(self) -> dict:
        schema = self.output_model.model_json_schema()
        schema.setdefault("type", "object")
        schema.pop("title", None)
        return schema


class CapabilityRegistry:
    def __init__(self, specs: Iterable[CapabilitySpec] = ()) -> None:
        self._specs: dict[str, CapabilitySpec] = {}
        for spec in specs:
            self.register(spec)

    def register(self, spec: CapabilitySpec) -> None:
        if spec.name in self._specs:
            raise ValueError(f"Capability already registered: {spec.name}")
        self._specs[spec.name] = spec

    def get(self, name: str) -> CapabilitySpec:
        try:
            return self._specs[name]
        except KeyError as exc:
            raise CapabilityNotFoundError(f"Unknown capability: {name}") from exc

    def list(self) -> list[CapabilitySpec]:
        return list(self._specs.values())

    def enabled(self, tools_cfg: ChatToolsConfig) -> list[CapabilitySpec]:
        return [spec for spec in self.list() if self.enabled_for(spec.name, tools_cfg)]

    def enabled_names(self, tools_cfg: ChatToolsConfig) -> set[str]:
        return {spec.name for spec in self.enabled(tools_cfg)}

    def enabled_for(self, name: str, tools_cfg: ChatToolsConfig) -> bool:
        spec = self.get(name)
        if spec.gate is None:
            return True
        enabled = tools_cfg.model_dump()
        gates = (spec.gate,) if isinstance(spec.gate, str) else spec.gate
        return all(bool(enabled.get(gate, True)) for gate in gates)

    def execute(
        self,
        name: str,
        args: dict,
        context: CapabilityContext,
        *,
        tools_cfg: ChatToolsConfig | None = None,
    ) -> CapabilityResult:
        spec = self.get(name)
        if tools_cfg is not None and not self.enabled_for(name, tools_cfg):
            raise CapabilityDisabledError(f"Capability disabled: {name}")
        try:
            validated = spec.input_model.model_validate(args or {})
        except ValidationError:
            raise
        return spec.handler(validated, context)

    def openai_schemas(
        self,
        tools_cfg: ChatToolsConfig | None = None,
        *,
        names: set[str] | None = None,
    ) -> list[dict]:
        specs = self.list() if tools_cfg is None else self.enabled(tools_cfg)
        out: list[dict] = []
        for spec in specs:
            if names is not None and spec.name not in names:
                continue
            out.append({
                "type": "function",
                "function": {
                    "name": spec.name,
                    "description": spec.description,
                    "parameters": spec.input_schema(),
                },
            })
        return out

    def manifest_hash(self, tools_cfg: ChatToolsConfig | None = None) -> str:
        payload = self.openai_schemas(tools_cfg)
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()


_DEFAULT_REGISTRY: CapabilityRegistry | None = None


def get_capability_registry() -> CapabilityRegistry:
    global _DEFAULT_REGISTRY
    if _DEFAULT_REGISTRY is None:
        registry = CapabilityRegistry()
        from claudesk.agent.capabilities import attachments, logs, notes, papers, pdf, projects, tasks, web

        for module in (web, pdf, papers, projects, tasks, logs, notes, attachments):
            for spec in module.capabilities():
                registry.register(spec)
        _DEFAULT_REGISTRY = registry
    return _DEFAULT_REGISTRY
