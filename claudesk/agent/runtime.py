from __future__ import annotations

import base64
import asyncio
import copy
import hashlib
import json
import logging
import os
import sqlite3
import time
from collections.abc import AsyncGenerator, Awaitable, Callable, Mapping
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Any, Protocol

from pydantic import TypeAdapter, ValidationError
from openai import AsyncOpenAI, AuthenticationError, PermissionDeniedError
from pydantic_ai import AbstractToolset, Agent, AgentRunResultEvent, ModelSettings, RunContext, ToolDefinition
from pydantic_ai.exceptions import UsageLimitExceeded
from pydantic_ai.messages import (
    BinaryContent,
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    PartDeltaEvent,
    PartStartEvent,
    TextContent,
    TextPart,
    TextPartDelta,
    ThinkingPart,
    ThinkingPartDelta,
    ToolReturn,
)
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.models.openai import OpenAIResponsesModel
from pydantic_ai.profiles.openai import openai_model_profile
from pydantic_ai.providers.anthropic import AnthropicProvider
from pydantic_ai.providers.google import GoogleProvider
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.toolsets.abstract import ToolsetTool
from pydantic_ai.usage import UsageLimits

from claudesk.agent.capabilities.registry import (
    CapabilityDisabledError,
    CapabilityNotFoundError,
    CapabilityRegistry,
    get_capability_registry,
)
from claudesk.agent.context import CapabilityContext
from claudesk.agent.exports.openai import tool_manifest_hash
from claudesk.agent.schemas import CapabilityResult
from claudesk.core.config import (
    CHAT_RUNTIME_CATALOG, Config, chat_model_choice, openai_chat_model_capabilities, paper_assets_root,
)
from claudesk.core.db.chat import insert_chat_resource_reads

logger = logging.getLogger(__name__)

API_BACKENDS = {"openai_api", "gemini_api", "anthropic_api"}

MAX_API_TOOL_ROUNDS = 8
TOOL_LIMIT_FINAL_INSTRUCTION = (
    "You have reached Claudesk's tool-call limit for this turn. Write the final answer now "
    "using only the tool results already provided in this conversation. Do not call more tools. "
    "If the gathered evidence is insufficient for the user's request, say exactly what evidence "
    "is missing instead of continuing to read."
)
MAX_TOOL_LIMIT_RESULT_CHARS = 4000


ProviderEvent = dict[str, Any]
ProviderStateUpdate = Callable[[dict[str, Any]], Awaitable[None]]


@dataclass(frozen=True)
class ApiCredentials:
    api_key: str | None
    env_names: tuple[str, ...]


@dataclass(frozen=True)
class ProviderTurnRequest:
    messages: list[dict[str, Any]]
    cfg: Config
    conn: sqlite3.Connection | None = None
    allowed_capabilities: set[str] | None = None
    required_capabilities: set[str] = field(default_factory=set)
    requires_note_write: bool = False
    session_id: int | None = None
    turn_id: str | None = None
    provider_state: dict[str, Any] | None = None
    update_provider_state: ProviderStateUpdate | None = None


def resolve_api_credentials(backend: str, cfg: Config) -> ApiCredentials:
    if backend == "openai_api":
        return ApiCredentials(cfg.llm.api_key or os.environ.get("OPENAI_API_KEY"), ("OPENAI_API_KEY",))
    if backend == "gemini_api":
        return ApiCredentials(
            os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"),
            ("GEMINI_API_KEY", "GOOGLE_API_KEY"),
        )
    if backend == "anthropic_api":
        return ApiCredentials(os.environ.get("ANTHROPIC_API_KEY"), ("ANTHROPIC_API_KEY",))
    return ApiCredentials(None, ())


def missing_key_message(backend: str, env_names: Mapping[str, Any] | tuple[str, ...]) -> str:
    label = CHAT_RUNTIME_CATALOG.get(backend, {}).get("label", backend)
    joined = " or ".join(env_names)
    return f"{label} not configured - set the {joined} environment variable."


MODEL_CACHE_SECONDS = 15 * 60
_model_cache: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}
_model_requests: dict[tuple[str, str], asyncio.Task] = {}


async def list_chat_models(cfg: Config, backend: str, *, refresh: bool = False) -> dict[str, Any]:
    """Discover model choices without creating a session or starting a model turn."""
    if backend not in CHAT_RUNTIME_CATALOG:
        raise ValueError(f"Unknown chat backend: {backend}")
    if backend in {"gemini_api", "anthropic_api"}:
        return {
            "backend": backend, "status": "builtin", "fetched_at": None, "error": None,
            "models": [chat_model_choice(backend, entry["value"], label=entry["label"],
                                         is_default=entry["value"] == CHAT_RUNTIME_CATALOG[backend]["defaults"]["model"])
                       for entry in CHAT_RUNTIME_CATALOG[backend]["models"]],
        }
    if backend == "codex_cli":
        from claudesk.agent.codex_runtime import _codex_runtime

        try:
            identity = _codex_runtime.model_discovery_identity(cfg)
        except OSError:
            return {
                "backend": backend, "status": "error", "fetched_at": None, "models": [],
                "error": "Could not read the Codex installation or configuration. Check file permissions and refresh.",
            }
    else:
        credentials = resolve_api_credentials(backend, cfg)
        identity = hashlib.sha256(json.dumps([
            credentials.api_key, os.environ.get("OPENAI_BASE_URL"),
            os.environ.get("OPENAI_ORG_ID"), os.environ.get("OPENAI_PROJECT_ID"),
        ]).encode()).hexdigest()
    key = (backend, identity)
    cached = _model_cache.get(key)
    if cached is not None and not refresh and time.monotonic() - cached[0] < MODEL_CACHE_SECONDS:
        return copy.deepcopy(cached[1])
    pending = _model_requests.get(key)
    if pending is None:
        pending = asyncio.create_task(_discover_chat_models(cfg, backend, key))
        _model_requests[key] = pending
    # One disconnected browser must not cancel discovery shared by other controls.
    return copy.deepcopy(await asyncio.shield(pending))


async def _discover_chat_models(cfg: Config, backend: str, key: tuple[str, str]) -> dict[str, Any]:
    try:
        try:
            if backend == "codex_cli":
                from claudesk.agent.codex_runtime import _codex_runtime

                models = await _codex_runtime.list_models(cfg)
            else:
                credentials = resolve_api_credentials(backend, cfg)
                if not credentials.api_key:
                    raise RuntimeError(missing_key_message(backend, credentials.env_names))
                async with AsyncOpenAI(api_key=credentials.api_key, timeout=30, max_retries=0) as client:
                    page = await client.models.list()
                    models = []
                    async for entry in page:
                        choice = chat_model_choice(backend, entry.id)
                        if choice is not None:
                            models.append(choice)
            # Providers can repeat IDs across pages; preserve the first advertised entry.
            unique = {model["id"]: model for model in reversed(models)}
            result = {
                "backend": backend, "status": "ready", "error": None,
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "models": sorted(unique.values(), key=lambda model: (not model["is_default"], model["label"].casefold())),
            }
            _model_cache[key] = (time.monotonic(), result)
            # Credential switches must not grow the process cache indefinitely.
            if len(_model_cache) > 16:
                oldest = min(_model_cache, key=lambda entry: _model_cache[entry][0])
                del _model_cache[oldest]
            return result
        except Exception as exc:
            logger.warning("Model discovery failed for %s (%s)", backend, type(exc).__name__)
            if backend == "openai_api" and not resolve_api_credentials(backend, cfg).api_key:
                error = missing_key_message(backend, resolve_api_credentials(backend, cfg).env_names)
            elif isinstance(exc, (AuthenticationError, PermissionDeniedError)):
                error = "OpenAI model discovery was denied. Check the configured API key and project permissions, then refresh."
            elif backend == "codex_cli":
                error = "Could not load Codex models. Check your Codex login, installation, and configuration, then refresh."
            else:
                error = "Could not load OpenAI models. Check your connection and API configuration, then refresh."
            cached = _model_cache.get(key)
            return {
                **(cached[1] if cached else {"backend": backend, "models": [], "fetched_at": None}),
                "status": "stale" if cached else "error", "error": error,
            }
    finally:
        _model_requests.pop(key, None)


class ProviderRuntime(Protocol):
    backend: str

    async def stream_turn(self, request: ProviderTurnRequest) -> AsyncGenerator[ProviderEvent, None]:
        ...


@dataclass
class CapabilityToolExecution:
    name: str
    args: dict[str, Any]
    result: CapabilityResult


@dataclass
class CapabilityRuntimeDeps:
    conn: sqlite3.Connection
    cfg: Config
    allowed_capabilities: set[str] | None = None
    session_id: int | None = None
    turn_id: str | None = None
    provider: str = ""
    tool_executions: list[CapabilityToolExecution] = field(default_factory=list)


_TOOL_ARGS_VALIDATOR = TypeAdapter(dict[str, Any]).validator


def _capability_error_result(name: str, error_type: str, message: str, **extra: Any) -> CapabilityResult:
    payload = {
        "ok": False,
        "type": error_type,
        "capability": name,
        "error": message,
        **extra,
    }
    return CapabilityResult(text=json.dumps(payload, default=str))


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


class CapabilityToolset(AbstractToolset[CapabilityRuntimeDeps]):
    def __init__(
        self,
        *,
        registry: CapabilityRegistry | None = None,
        allowed_names: set[str] | None = None,
        toolset_id: str | None = "claudesk-capabilities",
    ) -> None:
        self.registry = registry or get_capability_registry()
        self.allowed_names = allowed_names
        self._id = toolset_id

    @property
    def id(self) -> str | None:
        return self._id

    def _allowed_for_context(self, ctx: RunContext[CapabilityRuntimeDeps]) -> set[str] | None:
        if self.allowed_names is not None:
            return self.allowed_names
        return ctx.deps.allowed_capabilities

    async def get_tools(self, ctx: RunContext[CapabilityRuntimeDeps]) -> dict[str, ToolsetTool[CapabilityRuntimeDeps]]:
        allowed = self._allowed_for_context(ctx)
        tools: dict[str, ToolsetTool[CapabilityRuntimeDeps]] = {}
        for spec in self.registry.enabled(ctx.deps.cfg.chat.tools):
            if allowed is not None and spec.name not in allowed:
                continue
            definition = ToolDefinition(
                name=spec.name,
                description=spec.description,
                parameters_json_schema=spec.input_schema(),
            )
            tools[spec.name] = ToolsetTool(
                toolset=self,
                tool_def=definition,
                max_retries=0,
                args_validator=_TOOL_ARGS_VALIDATOR,
            )
        return tools

    async def call_tool(
        self,
        name: str,
        tool_args: dict[str, Any],
        ctx: RunContext[CapabilityRuntimeDeps],
        tool: ToolsetTool[CapabilityRuntimeDeps],
    ) -> Any:
        try:
            result = self.registry.execute(
                name,
                tool_args,
                CapabilityContext(
                    conn=ctx.deps.conn,
                    cfg=ctx.deps.cfg,
                    session_id=ctx.deps.session_id,
                ),
                tools_cfg=ctx.deps.cfg.chat.tools,
            )
        except ValidationError as exc:
            result = _capability_error_result(
                name,
                "validation_error",
                "Invalid capability arguments.",
                errors=exc.errors(),
            )
        except CapabilityNotFoundError as exc:
            result = _capability_error_result(name, "unknown_capability", str(exc))
        except CapabilityDisabledError as exc:
            result = _capability_error_result(name, "disabled_capability", str(exc))
        except Exception as exc:
            _rollback_quietly(ctx.deps.conn, boundary="capability", capability_name=name)
            logger.exception("Capability execution failed: %s", name)
            result = _capability_error_result(name, "capability_execution_error", str(exc))
        ctx.deps.tool_executions.append(CapabilityToolExecution(name=name, args=tool_args, result=result))
        _persist_capability_resource_reads(ctx.deps, name, result)
        return capability_result_to_pydantic_tool_return(name, result, cfg=ctx.deps.cfg)


def _persist_capability_resource_reads(
    deps: CapabilityRuntimeDeps,
    capability_name: str,
    result: CapabilityResult,
) -> None:
    if deps.session_id is None or not deps.turn_id or not deps.provider or not result.resource_reads:
        return
    try:
        insert_chat_resource_reads(
            deps.conn,
            deps.session_id,
            turn_id=deps.turn_id,
            provider=deps.provider,
            source="capability_result",
            capability_name=capability_name,
            reads=result.resource_reads,
        )
        deps.conn.commit()
    except Exception:
        _rollback_quietly(deps.conn, boundary="capability resource-read", capability_name=capability_name)
        logger.exception(
            "Failed to persist capability resource reads",
            extra={
                "capability_name": capability_name,
                "session_id": deps.session_id,
                "turn_id": deps.turn_id,
                "provider": deps.provider,
            },
        )


def capability_result_to_pydantic_tool_return(
    capability_name: str,
    result: CapabilityResult,
    *,
    cfg: Config,
) -> str | ToolReturn:
    if not result.images:
        return result.text

    content: list[Any] = [TextContent(content=result.text)]
    evidence_lines = [f"Image evidence returned by capability `{capability_name}`:"]
    for image in result.images:
        page = f", page {image.page_number}" if image.page_number is not None else ""
        size = f", {image.width}x{image.height}" if image.width and image.height else ""
        evidence_lines.append(f"- {image.label} (asset {image.asset_id}{page}{size})")
        content.append(BinaryContent(data=base64.b64decode(image.data_base64(cfg=cfg)), media_type=image.mime_type))
    content.insert(1, TextContent(content="\n".join(evidence_lines)))
    return ToolReturn(return_value=result.text, content=content, metadata={"capability": capability_name})


def _content_to_plain_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return str(content or "")
    parts: list[str] = []
    for item in content:
        if isinstance(item, str):
            parts.append(item)
            continue
        if not isinstance(item, dict):
            continue
        if item.get("type") == "text":
            parts.append(str(item.get("text") or ""))
        elif item.get("type") == "image_url":
            parts.append("[image evidence attached]")
    return "\n".join(part for part in parts if part)


def provider_prompt_from_messages(messages: list[dict[str, Any]]) -> tuple[str, str]:
    system_parts: list[str] = []
    history: list[tuple[str, str]] = []
    latest_user = ""

    for message in messages:
        role = str(message.get("role") or "user")
        if role == "system":
            content = _content_to_plain_text(message.get("content") or "").strip()
            if content:
                system_parts.append(content)
            continue
        if role == "tool":
            content = f"Tool result {message.get('tool_call_id', '')}: {message.get('content', '')}"
        elif message.get("tool_calls"):
            content = f"Assistant requested tool calls: {json.dumps(message.get('tool_calls', []))}"
        else:
            content = _content_to_plain_text(message.get("content") or "")
        if role == "user":
            latest_user = content
        history.append((role, content))

    prior_history = history[:-1] if latest_user and history and history[-1][0] == "user" else history
    sections: list[str] = []
    if prior_history:
        rendered = "\n\n".join(f"{role.title()}: {content}" for role, content in prior_history)
        sections.append("Conversation history for context:\n" + rendered)
    sections.append("Latest user message:\n" + (latest_user or (history[-1][1] if history else "")))
    return "\n\n".join(system_parts), "\n\n---\n\n".join(sections)


def _model_settings(cfg: Config) -> ModelSettings:
    settings: ModelSettings = {}
    capabilities = openai_chat_model_capabilities(cfg.chat.model) if cfg.chat.backend == "openai_api" else None
    if cfg.chat.temperature is not None and (cfg.chat.backend != "openai_api" or (capabilities and capabilities["temperature"])):
        settings["temperature"] = cfg.chat.temperature
    service_tier = (cfg.chat.service_tier or "").strip()
    if cfg.chat.backend == "openai_api" and service_tier:
        settings["openai_service_tier"] = service_tier
    if cfg.chat.backend == "openai_api":
        settings["openai_store"] = False
        if capabilities and capabilities["reasoning_efforts"]:
            if cfg.chat.reasoning_effort is not None:
                settings["openai_reasoning_effort"] = cfg.chat.reasoning_effort
            if cfg.chat.reasoning_summary not in (None, "none"):
                settings["openai_reasoning_summary"] = cfg.chat.reasoning_summary
    return settings


def _pydantic_model_for_backend(backend: str, cfg: Config) -> Any:
    model_name = cfg.chat.model
    settings = _model_settings(cfg)
    credentials = resolve_api_credentials(backend, cfg)
    if not credentials.api_key:
        raise RuntimeError(missing_key_message(backend, credentials.env_names))
    if backend == "openai_api":
        capabilities = openai_chat_model_capabilities(model_name)
        profile = openai_model_profile(model_name)
        if capabilities and capabilities["supported"]:
            supports_reasoning = bool(capabilities["reasoning_efforts"])
            profile = replace(
                profile,
                supports_thinking=supports_reasoning,
                thinking_always_enabled=supports_reasoning and "none" not in capabilities["reasoning_efforts"],
                openai_supports_reasoning=supports_reasoning,
                openai_supports_reasoning_effort_none="none" in capabilities["reasoning_efforts"],
                openai_supports_encrypted_reasoning_content=supports_reasoning,
                openai_supports_phase=profile.openai_supports_phase or model_name.startswith(("gpt-5.6", "gpt-6")),
                openai_unsupported_model_settings=() if capabilities["temperature"] else ("temperature", "top_p", "presence_penalty", "frequency_penalty", "logprobs", "top_logprobs"),
            )
        return OpenAIResponsesModel(
            model_name,
            provider=OpenAIProvider(api_key=credentials.api_key),
            profile=profile,
            settings=settings,
        )
    if backend == "gemini_api":
        return GoogleModel(
            model_name,
            provider=GoogleProvider(api_key=credentials.api_key),
            settings=settings,
        )
    if backend == "anthropic_api":
        return AnthropicModel(
            model_name,
            provider=AnthropicProvider(api_key=credentials.api_key),
            settings=settings,
        )
    raise RuntimeError(f"Unknown API chat backend: {backend}")


def _tool_return_summary(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value[:400]
    if isinstance(value, list):
        parts = []
        for item in value:
            text = getattr(item, "content", None)
            if text:
                parts.append(str(text))
        return "\n".join(parts)[:400]
    return str(value)[:400]


def _format_tool_limit_context(deps: CapabilityRuntimeDeps) -> str:
    if not deps.tool_executions:
        return "No tool results were successfully gathered before the tool-call limit was reached."

    rendered: list[str] = []
    for index, execution in enumerate(deps.tool_executions, start=1):
        args = json.dumps(execution.args, sort_keys=True, default=str)
        result_text = execution.result.text
        if len(result_text) > MAX_TOOL_LIMIT_RESULT_CHARS:
            result_text = result_text[:MAX_TOOL_LIMIT_RESULT_CHARS].rstrip() + "\n[truncated]"
        rendered.append(f"{index}. {execution.name} args={args}\n{result_text}")
    return "Tool results already gathered in this turn:\n" + "\n\n".join(rendered)


def _tool_limit_final_prompt(user_prompt: str, deps: CapabilityRuntimeDeps) -> str:
    return "\n\n---\n\n".join([
        user_prompt,
        _format_tool_limit_context(deps),
        TOOL_LIMIT_FINAL_INSTRUCTION,
    ])


def normalize_pydantic_ai_event(event: Any) -> ProviderEvent | None:
    if isinstance(event, PartStartEvent):
        if isinstance(event.part, TextPart) and event.part.content:
            return {"type": "text", "content": event.part.content}
        if isinstance(event.part, ThinkingPart) and event.part.content:
            return {"type": "progress", "content": event.part.content}
        return None
    if isinstance(event, PartDeltaEvent):
        if isinstance(event.delta, TextPartDelta) and event.delta.content_delta:
            return {"type": "text", "content": event.delta.content_delta}
        if isinstance(event.delta, ThinkingPartDelta) and event.delta.content_delta:
            return {"type": "progress", "content": event.delta.content_delta}
        return None
    if isinstance(event, FunctionToolCallEvent):
        return {"type": "tool_start", "name": event.part.tool_name}
    if isinstance(event, FunctionToolResultEvent):
        result = event.result
        return {
            "type": "tool_result",
            "name": result.tool_name,
            "summary": _tool_return_summary(getattr(result, "content", None)),
        }
    if isinstance(event, AgentRunResultEvent):
        return {"type": "done", "finish_reason": "stop"}
    return None


class PydanticAIRuntime:
    def __init__(self, backend: str) -> None:
        if backend not in API_BACKENDS:
            raise ValueError(f"PydanticAIRuntime only supports API backends: {backend}")
        self.backend = backend

    async def stream_turn(self, request: ProviderTurnRequest) -> AsyncGenerator[ProviderEvent, None]:
        if request.conn is None:
            yield {"type": "text", "content": "API provider runtime requires a database connection."}
            yield {"type": "done", "finish_reason": "stop"}
            return

        credentials = resolve_api_credentials(self.backend, request.cfg)
        if not credentials.api_key:
            yield {"type": "text", "content": missing_key_message(self.backend, credentials.env_names)}
            yield {"type": "done", "finish_reason": "stop"}
            return

        system_prompt, user_prompt = provider_prompt_from_messages(request.messages)
        deps = CapabilityRuntimeDeps(
            conn=request.conn,
            cfg=request.cfg,
            allowed_capabilities=request.allowed_capabilities,
            session_id=request.session_id,
            turn_id=request.turn_id,
            provider=self.backend,
        )
        model = _pydantic_model_for_backend(self.backend, request.cfg)
        agent = Agent(
            model,
            system_prompt=system_prompt,
            deps_type=CapabilityRuntimeDeps,
            toolsets=[CapabilityToolset()],
        )
        try:
            async for raw_event in agent.run_stream_events(
                user_prompt,
                deps=deps,
                usage_limits=UsageLimits(request_limit=MAX_API_TOOL_ROUNDS),
            ):
                event = normalize_pydantic_ai_event(raw_event)
                if event is not None:
                    yield event
        except UsageLimitExceeded:
            final_agent = Agent(
                model,
                system_prompt=system_prompt,
                deps_type=CapabilityRuntimeDeps,
                toolsets=[],
            )
            try:
                async for raw_event in final_agent.run_stream_events(
                    _tool_limit_final_prompt(user_prompt, deps),
                    deps=deps,
                    usage_limits=UsageLimits(request_limit=1),
                ):
                    event = normalize_pydantic_ai_event(raw_event)
                    if event is not None:
                        yield event
            except Exception as exc:
                logger.exception("Pydantic AI no-tool finalization failed")
                yield {"type": "text", "content": f"\n\n[{CHAT_RUNTIME_CATALOG[self.backend]['label']} error: {exc}]"}
                yield {"type": "done", "finish_reason": "stop"}
        except Exception as exc:
            logger.exception("Pydantic AI chat turn failed")
            yield {"type": "text", "content": f"\n\n[{CHAT_RUNTIME_CATALOG[self.backend]['label']} error: {exc}]"}
            yield {"type": "done", "finish_reason": "stop"}


_API_RUNTIMES = {backend: PydanticAIRuntime(backend) for backend in API_BACKENDS}


async def stream_api_provider_turn(request: ProviderTurnRequest) -> AsyncGenerator[ProviderEvent, None]:
    backend = request.cfg.chat.backend
    runtime = _API_RUNTIMES.get(backend)
    if runtime is None:
        yield {"type": "text", "content": f"Unknown API chat backend: {backend}"}
        yield {"type": "done", "finish_reason": "stop"}
        return
    async for event in runtime.stream_turn(request):
        yield event


async def stream_provider_turn(request: ProviderTurnRequest) -> AsyncGenerator[ProviderEvent, None]:
    if request.cfg.chat.backend in API_BACKENDS:
        async for event in stream_api_provider_turn(request):
            yield event
        return
    if request.cfg.chat.backend == "codex_cli":
        from claudesk.agent.codex_runtime import stream_codex_provider_turn

        async for event in stream_codex_provider_turn(request):
            yield event
        return
    yield {"type": "text", "content": f"Unknown chat backend: {request.cfg.chat.backend}"}
    yield {"type": "done", "finish_reason": "stop"}


async def shutdown_provider_runtimes() -> None:
    from claudesk.agent.codex_runtime import shutdown_codex_app_server

    await shutdown_codex_app_server()


@dataclass(frozen=True)
class ProviderRuntimeSignature:
    backend: str
    model: str
    temperature: float | None
    reasoning_effort: str | None
    reasoning_summary: str | None
    service_tier: str | None
    skills_enabled: bool
    skills_roots: list[str]
    system_prompt_addendum: str
    tool_manifest_hash: str
    enabled_tool_gates: dict[str, Any]
    managed_pdf_asset_root: str
    paper_assets_config: dict[str, Any]
    runtime_version: int | None = None
    extra: dict[str, Any] | None = None

    def digest(self) -> str:
        return json.dumps(self.payload(), sort_keys=True)

    def payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "backend": self.backend,
            "model": self.model,
            "temperature": self.temperature,
            "reasoning_effort": self.reasoning_effort,
            "reasoning_summary": self.reasoning_summary,
            "service_tier": self.service_tier,
            "skills_enabled": self.skills_enabled,
            "skills_roots": self.skills_roots,
            "system_prompt_addendum": self.system_prompt_addendum,
            "tool_manifest_hash": self.tool_manifest_hash,
            "enabled_tool_gates": self.enabled_tool_gates,
            "managed_pdf_asset_root": self.managed_pdf_asset_root,
            "paper_assets_config": self.paper_assets_config,
            "runtime_version": self.runtime_version,
        }
        if self.extra:
            payload["extra"] = self.extra
        return payload


def provider_runtime_signature(
    cfg: Config,
    *,
    backend: str | None = None,
    runtime_version: int | None = None,
    extra: Mapping[str, Any] | None = None,
) -> ProviderRuntimeSignature:
    return ProviderRuntimeSignature(
        backend=backend or cfg.chat.backend,
        model=cfg.chat.model,
        temperature=cfg.chat.temperature,
        reasoning_effort=cfg.chat.reasoning_effort,
        reasoning_summary=cfg.chat.reasoning_summary,
        service_tier=cfg.chat.service_tier,
        skills_enabled=cfg.chat.skills.enabled,
        skills_roots=list(cfg.chat.skills.roots),
        system_prompt_addendum=cfg.chat.system_prompt_addendum,
        tool_manifest_hash=tool_manifest_hash(cfg.chat.tools),
        enabled_tool_gates=cfg.chat.tools.model_dump(),
        managed_pdf_asset_root=str(paper_assets_root(cfg)),
        paper_assets_config=cfg.paper_assets.model_dump(mode="json"),
        runtime_version=runtime_version,
        extra=dict(extra) if extra is not None else None,
    )
