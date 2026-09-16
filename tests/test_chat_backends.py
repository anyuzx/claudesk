from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from openai import AsyncOpenAI
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from pydantic_ai import AgentRunResultEvent
from pydantic_ai.exceptions import UsageLimitExceeded
from pydantic_ai.messages import PartStartEvent, TextPart
from pydantic_ai.providers.openai import OpenAIProvider

from claudesk import __version__
from claudesk.agent import mcp_server
from claudesk.agent.capabilities.registry import CapabilityRegistry, CapabilitySpec, get_capability_registry
from claudesk.agent.codex_runtime import (
    CODEX_CHAT_RUNTIME_VERSION,
    CODEX_MCP_DIAGNOSTICS_ENV,
    CodexAppServerRuntime,
    _mcp_status_tool_names,
    build_codex_app_server_command,
    clear_codex_mcp_ledger_context,
    codex_config_payload,
    codex_config_hash,
    codex_chat_cwd,
    codex_mcp_ledger_context_path,
    codex_runtime_state,
    codex_sandbox_policy,
    codex_thread_params,
    extract_skill_mentions,
    openai_messages_to_cli_prompt,
    stream_codex_provider_turn,
    write_codex_mcp_ledger_context,
)
from claudesk.agent.codex_events import (
    CodexTranscriptTail,
    parse_codex_app_server_notification,
    parse_codex_transcript_event,
)
from claudesk.agent.codex_transport import (
    CODEX_APP_SERVER_START_RETRY_DELAY_SECONDS,
    CODEX_STDIO_LIMIT_BYTES,
    JsonlRpcTransport,
)
from claudesk.agent.exports.mcp import mcp_tools
from claudesk.agent.policy import NOTE_WRITE_CAPABILITY_NAMES, PAPER_PDF_CAPABILITY_NAMES
from claudesk.agent.runtime import (
    MAX_API_TOOL_ROUNDS,
    TOOL_LIMIT_FINAL_INSTRUCTION,
    CapabilityRuntimeDeps,
    CapabilityToolExecution,
    CapabilityToolset,
    ProviderTurnRequest,
    _pydantic_model_for_backend,
    _model_cache,
    _model_requests,
    list_chat_models,
    missing_key_message,
    provider_runtime_signature,
    resolve_api_credentials,
    stream_api_provider_turn,
)
from claudesk.agent.schemas import CapabilityInput, CapabilityResult, ToolImageAttachment
from claudesk.core.config import ChatConfig, ChatRuntimeSettings, ChatToolsConfig, Config, LlmConfig, PaperAssetsConfig, data_dir, load_config, project_root
from claudesk.core.db.chat import (
    create_chat_attachment,
    create_chat_session,
    list_chat_resource_reads,
)
from claudesk.core.db import init_db
from claudesk.core.models import AssetKind, resource_read
from claudesk.core.paper_assets import resolve_chat_attachment_path, resolve_managed_asset_path
from tests.helpers import patched_data_dir


class ChatBackendConfigTests(unittest.TestCase):
    def test_provider_turn_request_carries_runtime_context(self) -> None:
        cfg = Config(chat=ChatConfig(backend="openai_api"))
        request = ProviderTurnRequest(
            messages=[{"role": "user", "content": "Hi"}],
            cfg=cfg,
            allowed_capabilities={"search_web"},
            session_id=123,
            provider_state={"codex_cli": {"thread_id": "thread-1"}},
        )
        self.assertEqual(request.cfg.chat.backend, "openai_api")
        self.assertEqual(request.allowed_capabilities, {"search_web"})
        self.assertEqual(request.required_capabilities, set())
        self.assertFalse(request.requires_note_write)
        self.assertEqual(request.session_id, 123)

    def test_provider_runtime_signature_tracks_tool_gates_and_assets(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patched_data_dir(tmp):
            base = Config(
                chat=ChatConfig(backend="codex_cli"),
                paper_assets=PaperAssetsConfig(root_path="assets"),
            )
            without_pdf = Config(
                chat=ChatConfig(backend="codex_cli", tools=ChatToolsConfig(paper_pdf=False)),
                paper_assets=PaperAssetsConfig(root_path="assets"),
            )
            ignored_asset_root_extra = Config(
                chat=ChatConfig(backend="codex_cli"),
                paper_assets=PaperAssetsConfig(root_path="other-assets"),
            )

            base_signature = provider_runtime_signature(
                base,
                runtime_version=7,
                extra={"runtime": "codex_app_server"},
            )

            self.assertEqual(base_signature.payload()["backend"], "codex_cli")
            self.assertEqual(base_signature.payload()["runtime_version"], 7)
            self.assertEqual(base_signature.payload()["extra"], {"runtime": "codex_app_server"})
            self.assertTrue(base_signature.payload()["enabled_tool_gates"]["paper_pdf"])
            self.assertEqual(base_signature.payload()["managed_pdf_asset_root"], str((Path(tmp) / "assets").resolve()))
            self.assertNotEqual(base_signature.digest(), provider_runtime_signature(without_pdf, runtime_version=7).digest())
            self.assertEqual(
                base_signature.digest(),
                provider_runtime_signature(
                    ignored_asset_root_extra,
                    runtime_version=7,
                    extra={"runtime": "codex_app_server"},
                ).digest(),
            )

    def test_pydantic_api_runtime_reports_missing_key_without_model_call(self) -> None:
        async def collect() -> list[dict]:
            conn = sqlite3.connect(":memory:")
            events = []
            try:
                async for event in stream_api_provider_turn(ProviderTurnRequest(
                    messages=[{"role": "user", "content": "Hi"}],
                    cfg=Config(chat=ChatConfig(backend="anthropic_api")),
                    conn=conn,
                )):
                    events.append(event)
                return events
            finally:
                conn.close()

        with patch.dict(os.environ, {}, clear=True):
            events = asyncio.run(collect())

        self.assertIn("Claude API not configured", events[0]["content"])
        self.assertEqual(events[-1], {"type": "done", "finish_reason": "stop"})

    def test_api_models_use_session_model_and_supported_options(self) -> None:
        cases = (
            ("openai_api", "OpenAIResponsesModel", "gpt-4o-mini", {"temperature": 0.3, "service_tier": "priority"}),
            ("gemini_api", "GoogleModel", "gemini-2.5-pro", {"temperature": 0.3}),
            ("anthropic_api", "AnthropicModel", "claude-sonnet-4-5", {"temperature": 0.3}),
        )
        for backend, adapter, model, expected_settings in cases:
            with self.subTest(backend=backend):
                cfg = Config(
                    chat=ChatConfig(
                        backend=backend,
                        model=model,
                        **expected_settings,
                    ),
                    llm=LlmConfig(model="unrelated-digest-model"),
                )
                with (
                    patch.dict(os.environ, {
                        "OPENAI_API_KEY": "test-key",
                        "GEMINI_API_KEY": "test-key",
                        "ANTHROPIC_API_KEY": "test-key",
                    }),
                    patch(f"claudesk.agent.runtime.{adapter}") as model_adapter,
                ):
                    result = _pydantic_model_for_backend(backend, cfg)

                self.assertIs(result, model_adapter.return_value)
                self.assertEqual(model_adapter.call_args.args, (model,))
                expected_request = dict(expected_settings)
                if backend == "openai_api":
                    expected_request["openai_service_tier"] = expected_request.pop("service_tier")
                    expected_request["openai_store"] = False
                self.assertEqual(model_adapter.call_args.kwargs["settings"], expected_request)

    def test_responses_profile_supports_current_reasoning_models(self) -> None:
        for model_name in ("gpt-5.6-sol", "gpt-6-astra"):
            with self.subTest(model_name=model_name):
                cfg = Config(chat=ChatConfig(backend="openai_api", model=model_name, reasoning_effort="high"), llm=LlmConfig(api_key="test"))
                model = _pydantic_model_for_backend("openai_api", cfg)
                self.assertTrue(model.profile.openai_supports_reasoning)
                self.assertTrue(model.profile.openai_supports_encrypted_reasoning_content)
                self.assertTrue(model.profile.openai_supports_phase)
                self.assertFalse(model.settings["openai_store"])
                self.assertEqual(model.settings["openai_reasoning_effort"], "high")
                self.assertNotIn("temperature", model.settings)

    def test_capability_toolset_returns_structured_tool_errors(self) -> None:
        async def call_tool(
            name: str,
            args: dict,
            *,
            cfg: Config | None = None,
            registry: CapabilityRegistry | None = None,
        ) -> tuple[dict, CapabilityRuntimeDeps]:
            conn = sqlite3.connect(":memory:")
            deps = CapabilityRuntimeDeps(conn=conn, cfg=cfg or Config())
            try:
                text = await CapabilityToolset(registry=registry).call_tool(
                    name,
                    args,
                    SimpleNamespace(deps=deps),
                    None,
                )
                return json.loads(text), deps
            finally:
                conn.close()

        validation, validation_deps = asyncio.run(call_tool("read_paper_pdf", {}))
        self.assertFalse(validation["ok"])
        self.assertEqual(validation["type"], "validation_error")
        self.assertEqual(validation["capability"], "read_paper_pdf")
        self.assertEqual(len(validation_deps.tool_executions), 1)

        disabled, _ = asyncio.run(call_tool(
            "read_paper_pdf",
            {"paper_id": 1},
            cfg=Config(chat=ChatConfig(tools=ChatToolsConfig(paper_pdf=False))),
        ))
        self.assertFalse(disabled["ok"])
        self.assertEqual(disabled["type"], "disabled_capability")

        unknown, _ = asyncio.run(call_tool("not_a_capability", {}))
        self.assertFalse(unknown["ok"])
        self.assertEqual(unknown["type"], "unknown_capability")

        class EmptyInput(CapabilityInput):
            pass

        def boom(_args, _context):
            raise RuntimeError("boom")

        registry = CapabilityRegistry([
            CapabilitySpec(
                name="boom",
                description="Raise a test exception.",
                input_model=EmptyInput,
                handler=boom,
                domain="web",
                access="read",
                risk="low",
            )
        ])
        with patch("claudesk.agent.runtime.logger.exception") as logged_exception:
            execution_error, _ = asyncio.run(call_tool("boom", {}, registry=registry))
        logged_exception.assert_called_once()
        self.assertFalse(execution_error["ok"])
        self.assertEqual(execution_error["type"], "capability_execution_error")
        self.assertEqual(execution_error["error"], "boom")

    def test_capability_toolset_rolls_back_failed_capability_transaction(self) -> None:
        class EmptyInput(CapabilityInput):
            pass

        def partial_write(_args, context):
            context.conn.execute("INSERT INTO partial_writes (value) VALUES ('leaked')")
            raise RuntimeError("boom")

        registry = CapabilityRegistry([
            CapabilitySpec(
                name="partial_write",
                description="Write then fail.",
                input_model=EmptyInput,
                handler=partial_write,
                domain="web",
                access="read",
                risk="low",
            )
        ])
        conn = sqlite3.connect(":memory:")
        try:
            conn.execute("CREATE TABLE partial_writes (value TEXT)")
            conn.commit()
            deps = CapabilityRuntimeDeps(conn=conn, cfg=Config())
            with patch("claudesk.agent.runtime.logger.exception") as logged_exception:
                result = asyncio.run(CapabilityToolset(registry=registry).call_tool(
                    "partial_write",
                    {},
                    SimpleNamespace(deps=deps),
                    None,
                ))
            payload = json.loads(result)

            self.assertFalse(payload["ok"])
            self.assertEqual(payload["type"], "capability_execution_error")
            logged_exception.assert_called_once()
            self.assertFalse(conn.in_transaction)
            self.assertEqual(
                conn.execute("SELECT COUNT(*) FROM partial_writes").fetchone()[0],
                0,
            )
        finally:
            conn.close()

    def test_pydantic_api_runtime_finalizes_after_tool_limit(self) -> None:
        class FakeAgent:
            instances: list["FakeAgent"] = []

            def __init__(self, _model, *, system_prompt, deps_type, toolsets):
                self.system_prompt = system_prompt
                self.deps_type = deps_type
                self.toolsets = toolsets
                self.calls: list[tuple[str, dict]] = []
                FakeAgent.instances.append(self)

            def run_stream_events(self, prompt, **kwargs):
                should_raise_limit = len(FakeAgent.instances) == 1
                self.calls.append((prompt, kwargs))

                async def events():
                    if should_raise_limit:
                        kwargs["deps"].tool_executions.append(CapabilityToolExecution(
                            name="read_paper_pdf",
                            args={"paper_id": 134},
                            result=CapabilityResult(text='{"ok": true, "chunk": "cached evidence"}'),
                        ))
                        raise UsageLimitExceeded("request limit reached")
                    yield PartStartEvent(index=0, part=TextPart(content="final answer"))
                    yield AgentRunResultEvent(result=object())

                return events()

        async def collect() -> list[dict]:
            conn = sqlite3.connect(":memory:")
            events = []
            try:
                async for event in stream_api_provider_turn(ProviderTurnRequest(
                    messages=[{"role": "user", "content": "Summarize paper 134."}],
                    cfg=Config(
                        chat=ChatConfig(backend="openai_api"),
                        llm=LlmConfig(api_key="test-key"),
                    ),
                    conn=conn,
                )):
                    events.append(event)
                return events
            finally:
                conn.close()

        with (
            patch("claudesk.agent.runtime.Agent", new=FakeAgent),
            patch("claudesk.agent.runtime._pydantic_model_for_backend", return_value=object()),
        ):
            events = asyncio.run(collect())

        self.assertEqual(events, [
            {"type": "text", "content": "final answer"},
            {"type": "done", "finish_reason": "stop"},
        ])
        self.assertEqual(len(FakeAgent.instances), 2)
        self.assertTrue(FakeAgent.instances[0].toolsets)
        self.assertEqual(FakeAgent.instances[0].calls[0][1]["usage_limits"].request_limit, MAX_API_TOOL_ROUNDS)
        self.assertEqual(FakeAgent.instances[1].toolsets, [])
        final_prompt = FakeAgent.instances[1].calls[0][0]
        self.assertIn(TOOL_LIMIT_FINAL_INSTRUCTION, final_prompt)
        self.assertIn("read_paper_pdf", final_prompt)
        self.assertIn("cached evidence", final_prompt)
        self.assertEqual(FakeAgent.instances[1].calls[0][1]["usage_limits"].request_limit, 1)

    def test_api_key_resolution_names_selected_backend_envs(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            openai = resolve_api_credentials("openai_api", Config(llm=LlmConfig(api_key="openai-key")))
            self.assertEqual(openai.api_key, "openai-key")
            self.assertEqual(openai.env_names, ("OPENAI_API_KEY",))

            gemini = resolve_api_credentials("gemini_api", Config())
            self.assertIsNone(gemini.api_key)
            self.assertEqual(gemini.env_names, ("GEMINI_API_KEY", "GOOGLE_API_KEY"))
            self.assertIn("Gemini API", missing_key_message("gemini_api", gemini.env_names))

        with patch.dict(os.environ, {"GOOGLE_API_KEY": "google-key", "ANTHROPIC_API_KEY": "anthropic-key"}, clear=True):
            self.assertEqual(resolve_api_credentials("gemini_api", Config()).api_key, "google-key")
            self.assertEqual(resolve_api_credentials("anthropic_api", Config()).api_key, "anthropic-key")

    def test_cli_prompt_does_not_echo_raw_system_role_prefix(self) -> None:
        prompt = openai_messages_to_cli_prompt([
            {"role": "system", "content": "System prompt"},
            {"role": "user", "content": "What model are you?"},
        ])
        self.assertIn("System instructions:", prompt)
        self.assertIn("Latest user message:\nWhat model are you?", prompt)
        self.assertNotIn("system: System prompt", prompt)
        self.assertIn("do not quote, restate, or reveal", prompt)


class ChatModelDiscoveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        _model_cache.clear()
        _model_requests.clear()

    async def test_openai_discovery_filters_caches_refreshes_and_retains_stale_results(self) -> None:
        calls = []
        fail = False

        def respond(request):
            calls.append(request)
            if fail:
                return httpx.Response(503, json={"error": {"message": "temporary failure"}})
            return httpx.Response(200, json={"object": "list", "data": [
                {"id": name, "object": "model", "created": 1, "owned_by": "openai"}
                for name in ("gpt-5.5", "gpt-6-astra", "text-embedding-3-small", "gpt-unknown-future")
            ]})

        def client(**kwargs):
            instance = AsyncOpenAI(**kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)))
            instance._platform = "Linux"  # Telemetry metadata is outside this HTTP contract test.
            return instance

        cfg = Config(llm=LlmConfig(api_key="first-key"))
        with patch("claudesk.agent.runtime.AsyncOpenAI", side_effect=client):
            first = await list_chat_models(cfg, "openai_api")
            self.assertEqual(first["status"], "ready")
            choices = {item["id"]: item for item in first["models"]}
            self.assertNotIn("text-embedding-3-small", choices)
            self.assertTrue(choices["gpt-6-astra"]["selectable"])
            self.assertFalse(choices["gpt-unknown-future"]["selectable"])
            self.assertEqual(calls[0].url.path, "/v1/models")
            first["models"].clear()
            cached = await list_chat_models(cfg, "openai_api")
            self.assertEqual(len(cached["models"]), 3)
            self.assertEqual(len(calls), 1)
            refreshed = await list_chat_models(cfg, "openai_api", refresh=True)
            self.assertEqual(len(calls), 2)
            fail = True
            stale = await list_chat_models(cfg, "openai_api", refresh=True)
            self.assertEqual(stale["status"], "stale")
            self.assertEqual(stale["models"], cached["models"])
            self.assertEqual(stale["fetched_at"], refreshed["fetched_at"])
            other = await list_chat_models(Config(llm=LlmConfig(api_key="second-key")), "openai_api")
            self.assertEqual(other["status"], "error")
            self.assertEqual(other["models"], [])
            self.assertNotIn("second-key", other["error"])

    async def test_openai_cache_expiry_and_concurrent_requests(self) -> None:
        entered = asyncio.Event()
        release = asyncio.Event()
        calls = 0

        async def respond(_request):
            nonlocal calls
            calls += 1
            entered.set()
            await release.wait()
            return httpx.Response(200, json={"object": "list", "data": []})

        def client(**kwargs):
            instance = AsyncOpenAI(**kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)))
            instance._platform = "Linux"
            return instance

        cfg = Config(llm=LlmConfig(api_key="test-key"))
        with patch("claudesk.agent.runtime.AsyncOpenAI", side_effect=client):
            first = asyncio.create_task(list_chat_models(cfg, "openai_api"))
            await entered.wait()
            second = asyncio.create_task(list_chat_models(cfg, "openai_api", refresh=True))
            await asyncio.sleep(0)
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first
            release.set()
            self.assertEqual((await second)["status"], "ready")
            self.assertEqual(calls, 1)
            for key, (_, result) in _model_cache.copy().items():
                _model_cache[key] = (-1000, result)
            await list_chat_models(cfg, "openai_api")
            self.assertEqual(calls, 2)
            self.assertFalse(_model_requests)

    async def test_missing_credentials_and_builtin_models_do_not_call_provider(self) -> None:
        with patch.dict(os.environ, {}, clear=True), patch("claudesk.agent.runtime.AsyncOpenAI") as client:
            result = await list_chat_models(Config(), "openai_api")
            self.assertEqual(result["status"], "error")
            self.assertIn("OPENAI_API_KEY", result["error"])
            for backend in ("gemini_api", "anthropic_api"):
                result = await list_chat_models(Config(), backend)
                self.assertEqual(result["status"], "builtin")
                self.assertTrue(result["models"])
            client.assert_not_called()

    async def test_denied_authentication_keeps_only_same_identity_cached_models(self) -> None:
        deny = False

        def respond(_request):
            if deny:
                return httpx.Response(401, json={"error": {"message": "secret-key-invalid", "type": "invalid_request_error"}})
            return httpx.Response(200, json={"object": "list", "data": [
                {"id": "gpt-5.5", "object": "model", "created": 1, "owned_by": "openai"},
            ]})

        def client(**kwargs):
            instance = AsyncOpenAI(**kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)))
            instance._platform = "Linux"
            return instance

        cfg = Config(llm=LlmConfig(api_key="first-key"))
        with patch("claudesk.agent.runtime.AsyncOpenAI", side_effect=client):
            ready = await list_chat_models(cfg, "openai_api")
            deny = True
            stale = await list_chat_models(cfg, "openai_api", refresh=True)
            self.assertEqual(stale["status"], "stale")
            self.assertEqual(stale["models"], ready["models"])
            self.assertIn("API key", stale["error"])
            self.assertNotIn("secret-key-invalid", stale["error"])
            other = await list_chat_models(Config(llm=LlmConfig(api_key="second-key")), "openai_api")
            self.assertEqual(other["status"], "error")
            self.assertFalse(other["models"])

    async def test_codex_identity_read_failure_is_a_controlled_error_without_cached_fallback(self) -> None:
        with patch("claudesk.agent.codex_runtime._codex_runtime.model_discovery_identity", side_effect=PermissionError("private config")):
            result = await list_chat_models(Config(), "codex_cli")
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["models"], [])
        self.assertIsNone(result["fetched_at"])
        self.assertIn("permissions", result["error"])
        self.assertNotIn("private config", result["error"])

    async def test_codex_discovery_paginates_without_starting_chat(self) -> None:
        class ModelTransport(FakeCodexTransport):
            async def request(self, method, params=None, **kwargs):
                if method != "model/list":
                    return await super().request(method, params, **kwargs)
                self.requests.append((method, params))
                entry = {
                    "id": "catalog-id", "model": "gpt-5.5", "displayName": "GPT 5.5", "isDefault": True,
                    "defaultReasoningEffort": "high", "supportedReasoningEfforts": [
                        {"reasoningEffort": "high"}, {"reasoningEffort": "xhigh"},
                    ], "inputModalities": ["text", "image"],
                }
                if params["cursor"] is None:
                    return {"data": [entry, {**entry, "model": "secret", "hidden": True}], "nextCursor": "next"}
                return {"data": [{**entry, "model": "gpt-5.6-sol", "isDefault": False}], "nextCursor": None}

        runtime = CodexAppServerRuntime(transport_factory=ModelTransport)
        with tempfile.TemporaryDirectory() as tmp, patched_data_dir(tmp), patch.dict(os.environ, {"CODEX_HOME": tmp}), patch("claudesk.agent.codex_runtime._codex_runtime", runtime):
            try:
                result = await list_chat_models(Config(), "codex_cli")
                self.assertEqual(result["status"], "ready")
                self.assertEqual([model["id"] for model in result["models"]], ["gpt-5.5", "gpt-5.6-sol"])
                self.assertEqual(result["models"][0]["defaults"]["reasoning_effort"], "high")
                self.assertEqual(result["models"][0]["input_modalities"], ["text", "image"])
                methods = [name for name, _ in runtime._transport.requests]
                self.assertEqual(methods, ["initialize", "initialized", "model/list", "model/list"])
                for name, params in runtime._transport.requests:
                    if name == "model/list":
                        self.assertFalse(params["includeHidden"])
                old_identity = runtime.model_discovery_identity(Config())
                (Path(tmp) / "auth.json").write_text('{"token":"changed"}')
                self.assertNotEqual(old_identity, runtime.model_discovery_identity(Config()))
                await list_chat_models(Config(), "codex_cli")
                self.assertEqual(len(_model_cache), 2)
            finally:
                await runtime.close()

    async def test_responses_stream_continues_function_tools_with_images_and_local_history(self) -> None:
        class EmptyInput(CapabilityInput):
            pass

        png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kvwAAAABJRU5ErkJggg=="
        registry = CapabilityRegistry([CapabilitySpec(
            name="test_evidence", description="Read a page image.", input_model=EmptyInput,
            handler=lambda _args, _context: CapabilityResult(
                text='{"ok":true,"evidence":"read locally"}',
                images=[ToolImageAttachment(label="Page 1", mime_type="image/png", managed_path="papers/1/page-1.png")],
            ),
            domain="paper", access="read", risk="low",
        )])
        requests = []

        def respond(request):
            body = json.loads(request.content)
            requests.append(body)
            self.assertEqual(request.url.path, "/v1/responses")
            response = {
                "id": f"resp_{len(requests)}", "object": "response", "created_at": 1,
                "model": "gpt-6-astra", "status": "completed", "output": [],
                "usage": {"input_tokens": 5, "output_tokens": 5, "total_tokens": 10},
            }
            if len(requests) == 1:
                reasoning = {"id": "rs_1", "type": "reasoning", "summary": [{"type": "summary_text", "text": "Inspect local evidence."}], "encrypted_content": "encrypted-state"}
                item = {"id": "fc_1", "type": "function_call", "call_id": "call_1", "name": "test_evidence", "arguments": "{}", "status": "completed"}
                response["output"] = [reasoning, item]
                events = [
                    {"type": "response.output_item.added", "output_index": 0, "item": reasoning},
                    {"type": "response.output_item.done", "output_index": 0, "item": reasoning},
                    {"type": "response.output_item.added", "output_index": 1, "item": item},
                    {"type": "response.output_item.done", "output_index": 1, "item": item},
                ]
            else:
                events = [
                    {"type": "response.reasoning_summary_text.delta", "item_id": "rs_2", "output_index": 0, "summary_index": 0, "delta": "Checked the evidence."},
                    {"type": "response.output_text.delta", "item_id": "msg_2", "output_index": 1, "content_index": 0, "delta": "The page supports this answer."},
                ]
            events = [{"type": "response.created", "response": {**response, "status": "in_progress"}}, *events, {"type": "response.completed", "response": response}]
            data = "".join(f"event: {event['type']}\ndata: {json.dumps({**event, 'sequence_number': i})}\n\n" for i, event in enumerate(events))
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=data)

        client = AsyncOpenAI(api_key="test", http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)))
        client._platform = "Linux"
        conn = sqlite3.connect(":memory:")
        try:
            with (
                patch("claudesk.agent.runtime.OpenAIProvider", return_value=OpenAIProvider(openai_client=client)),
                patch("claudesk.agent.runtime.get_capability_registry", return_value=registry),
                patch.object(ToolImageAttachment, "data_base64", return_value=png),
            ):
                events = [event async for event in stream_api_provider_turn(ProviderTurnRequest(
                    messages=[{"role": "system", "content": "Use local evidence."}, {"role": "user", "content": "Inspect the page."}],
                    cfg=Config(chat=ChatConfig(backend="openai_api", model="gpt-6-astra", reasoning_effort="high", reasoning_summary="auto", service_tier="priority"), llm=LlmConfig(api_key="test")),
                    conn=conn, allowed_capabilities={"test_evidence"},
                ))]
            self.assertEqual(len(requests), 2)
            for body in requests:
                self.assertFalse(body["store"])
                self.assertNotIn("previous_response_id", body)
                self.assertNotIn("temperature", body)
                self.assertIn("reasoning.encrypted_content", body["include"])
                self.assertEqual(body["reasoning"], {"effort": "high", "summary": "auto"})
                self.assertEqual(body["service_tier"], "priority")
                self.assertEqual([tool["name"] for tool in body["tools"]], ["test_evidence"])
            continuation = requests[1]["input"]
            self.assertTrue(any(item.get("type") == "reasoning" and item.get("encrypted_content") == "encrypted-state" for item in continuation))
            self.assertTrue(any(item.get("type") == "function_call_output" and item["call_id"] == "call_1" for item in continuation))
            self.assertIn("data:image/png;base64,", json.dumps(continuation))
            self.assertTrue(any(event["type"] == "tool_start" for event in events))
            self.assertTrue(any(event["type"] == "tool_result" for event in events))
            self.assertTrue(any(event["type"] == "progress" for event in events))
            self.assertIn({"type": "text", "content": "The page supports this answer."}, events)
            self.assertEqual(events[-1]["type"], "done")
        finally:
            conn.close()
            await client.close()


class McpRichToolTests(unittest.TestCase):
    @staticmethod
    def write_pdf(path: Path, page_texts: list[str]) -> None:
        import fitz

        path.parent.mkdir(parents=True, exist_ok=True)
        doc = fitz.open()
        try:
            for text in page_texts:
                page = doc.new_page(width=300, height=200)
                page.insert_text((36, 72), text, fontsize=12)
            doc.save(str(path))
        finally:
            doc.close()

    async def list_subprocess_tools(self, *, data_dir_path: str, cwd: Path) -> tuple[str, str, set[str]]:
        params = StdioServerParameters(
            command=sys.executable,
            args=["-m", "claudesk.agent.mcp_server"],
            env={**os.environ, "CLAUDESK_DATA_DIR": data_dir_path},
            cwd=str(cwd),
        )
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                initialized = await session.initialize()
                tools = await session.list_tools()
        return (
            str(initialized.protocolVersion),
            initialized.serverInfo.name,
            {tool.name for tool in tools.tools},
        )

    def test_mcp_tool_manifest_matches_registry_enabled_names(self) -> None:
        cfg = Config()
        expected = get_capability_registry().enabled_names(cfg.chat.tools)
        names = {tool.name for tool in mcp_tools(cfg.chat.tools)}
        self.assertEqual(names, expected)

    def test_mcp_sdk_stdio_initializes_and_lists_tools(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            protocol_version, server_name, names = asyncio.run(
                self.list_subprocess_tools(data_dir_path=tmp, cwd=project_root())
            )

        self.assertTrue(protocol_version)
        self.assertEqual(server_name, "claudesk")
        self.assertIn("read_paper_pdf", names)

    def test_mcp_subprocess_from_codex_chat_cwd_exposes_enabled_tools(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patched_data_dir(tmp):
            _, _, names = asyncio.run(
                self.list_subprocess_tools(data_dir_path=tmp, cwd=codex_chat_cwd())
            )

        expected = get_capability_registry().enabled_names(Config().chat.tools)
        self.assertEqual(names, expected)
        self.assertTrue(set(PAPER_PDF_CAPABILITY_NAMES).issubset(names))

    def test_mcp_tools_list_includes_pdf_tools_when_enabled(self) -> None:
        names = {tool.name for tool in mcp_tools(Config().chat.tools)}
        self.assertIn("list_paper_assets", names)
        self.assertIn("list_paper_structure", names)
        self.assertIn("retrieve_paper_context", names)
        self.assertIn("read_paper_section", names)
        self.assertIn("read_paper_pdf", names)
        self.assertIn("search_paper_pdf", names)
        self.assertIn("inspect_paper_pdf_pages", names)
        self.assertIn("get_chat_attachment_context", names)

    def test_mcp_tools_call_returns_text_and_image_content_items(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patched_data_dir(tmp):
            assets_root = Path(tmp) / "assets"
            image_path = assets_root / "papers" / "1" / "page-1.png"
            image_path.parent.mkdir(parents=True, exist_ok=True)
            image_path.write_bytes(b"hello")
            cfg = Config()
            rich = CapabilityResult(
                text='{"ok": true}',
                images=(
                    ToolImageAttachment(
                        label="Page 1",
                        mime_type="image/png",
                        managed_path="papers/1/page-1.png",
                        asset_id=1,
                        page_number=1,
                    ),
                ),
            )
            conn = sqlite3.connect(":memory:")
            with (
                patch.object(mcp_server, "load_config", return_value=cfg),
                patch.object(mcp_server, "call_mcp_tool", return_value=rich),
            ):
                try:
                    response = mcp_server.call_tool_result("fake_rich", {}, conn)
                finally:
                    conn.close()

        self.assertIsNotNone(response)
        content = response.content
        self.assertEqual(content[0].type, "text")
        self.assertEqual(content[1].type, "image")
        self.assertEqual(content[1].mimeType, "image/png")

    def test_mcp_tools_call_returns_structured_tool_errors(self) -> None:
        conn = sqlite3.connect(":memory:")
        try:
            with patch.object(mcp_server, "load_config", return_value=Config()):
                validation = mcp_server.call_tool_result("read_paper_pdf", {}, conn)
                unknown = mcp_server.call_tool_result("not_a_capability", {}, conn)
            with patch.object(
                mcp_server,
                "load_config",
                return_value=Config(chat=ChatConfig(tools=ChatToolsConfig(paper_pdf=False))),
            ):
                disabled = mcp_server.call_tool_result("read_paper_pdf", {"paper_id": 1}, conn)
        finally:
            conn.close()

        validation_payload = json.loads(validation.content[0].text)
        self.assertTrue(validation.isError)
        self.assertEqual(validation_payload["type"], "validation_error")
        self.assertEqual(validation_payload["name"], "read_paper_pdf")

        disabled_payload = json.loads(disabled.content[0].text)
        self.assertTrue(disabled.isError)
        self.assertEqual(disabled_payload["type"], "disabled_capability")

        unknown_payload = json.loads(unknown.content[0].text)
        self.assertTrue(unknown.isError)
        self.assertEqual(unknown_payload["type"], "unknown_capability")

    def test_mcp_tool_call_rolls_back_failed_capability_transaction(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE TABLE partial_writes (value TEXT)")
        conn.commit()

        def partial_write(_name, _args, tool_conn, **_kwargs):
            tool_conn.execute("INSERT INTO partial_writes (value) VALUES ('leaked')")
            raise RuntimeError("boom")

        try:
            with (
                patch.object(mcp_server, "load_config", return_value=Config()),
                patch.object(mcp_server, "call_mcp_tool", side_effect=partial_write),
            ):
                response = mcp_server.call_tool_result("partial_write", {}, conn)
            payload = json.loads(response.content[0].text)

            self.assertTrue(response.isError)
            self.assertEqual(payload["type"], "capability_execution_error")
            self.assertFalse(conn.in_transaction)
            self.assertEqual(
                conn.execute("SELECT COUNT(*) FROM partial_writes").fetchone()[0],
                0,
            )
        finally:
            conn.close()

    def test_mcp_tools_call_returns_chat_attachment_image_content(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patched_data_dir(tmp):
            cfg = Config()
            conn = sqlite3.connect(":memory:")
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys=ON")
            try:
                init_db(conn)
                session = create_chat_session(conn, runtime_settings=ChatRuntimeSettings())
                managed_path = f"sessions/{session.id}/figure.png"
                image_path = resolve_chat_attachment_path(managed_path, cfg=cfg)
                image_path.parent.mkdir(parents=True, exist_ok=True)
                image_path.write_bytes(b"\x89PNG\r\n")
                attachment = create_chat_attachment(
                    conn,
                    session.id or 0,
                    context_kind="file",
                    kind=AssetKind.ATTACHMENT,
                    source="chat",
                    managed_path=managed_path,
                    original_filename="figure.png",
                    display_name="figure.png",
                    mime_type="image/png",
                    size_bytes=6,
                    content_hash="sha256-mcp-image",
                )
                conn.commit()
                write_codex_mcp_ledger_context(
                    session_id=session.id or 0,
                    turn_id="turn-mcp-attachment-image",
                    provider="codex_cli",
                )
                with patch.object(mcp_server, "load_config", return_value=cfg):
                    response = mcp_server.call_tool_result(
                        "get_chat_attachment_context",
                        {"asset_id": attachment.asset.id, "include_image": True},
                        conn,
                    )
            finally:
                clear_codex_mcp_ledger_context()
                conn.close()

        content = response.content
        self.assertEqual(content[0].type, "text")
        self.assertEqual(content[1].type, "image")
        self.assertEqual(content[1].mimeType, "image/png")

    def test_mcp_tools_call_returns_chat_attachment_pdf_page_content(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patched_data_dir(tmp):
            cfg = Config()
            conn = sqlite3.connect(":memory:")
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys=ON")
            try:
                init_db(conn)
                session = create_chat_session(conn, runtime_settings=ChatRuntimeSettings())
                managed_path = f"sessions/{session.id}/attachment.pdf"
                self.write_pdf(
                    resolve_chat_attachment_path(managed_path, cfg=cfg),
                    ["MCP PDF page evidence."],
                )
                attachment = create_chat_attachment(
                    conn,
                    session.id or 0,
                    context_kind="file",
                    kind=AssetKind.PDF,
                    source="chat",
                    managed_path=managed_path,
                    original_filename="attachment.pdf",
                    display_name="attachment.pdf",
                    mime_type="application/pdf",
                    size_bytes=128,
                    content_hash="sha256-mcp-pdf",
                )
                conn.commit()
                write_codex_mcp_ledger_context(
                    session_id=session.id or 0,
                    turn_id="turn-mcp-attachment-pdf",
                    provider="codex_cli",
                )
                with patch.object(mcp_server, "load_config", return_value=cfg):
                    response = mcp_server.call_tool_result(
                        "get_chat_attachment_context",
                        {"asset_id": attachment.asset.id, "include_image": True},
                        conn,
                    )
            finally:
                clear_codex_mcp_ledger_context()
                conn.close()

        content = response.content
        self.assertEqual(content[0].type, "text")
        self.assertEqual(content[1].type, "image")
        self.assertEqual(content[1].mimeType, "image/png")

    def test_mcp_tools_call_persists_active_ledger_resource_reads(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patched_data_dir(tmp):
            conn = sqlite3.connect(":memory:")
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys=ON")
            reads = []
            try:
                init_db(conn)
                session = create_chat_session(conn, runtime_settings=ChatRuntimeSettings())
                conn.commit()
                write_codex_mcp_ledger_context(
                    session_id=session.id or 0,
                    turn_id="turn-mcp-ledger",
                    provider="codex_cli",
                )
                rich = CapabilityResult(
                    text='{"ok": true}',
                    resource_reads=(
                        resource_read(
                            "paper",
                            42,
                            label="MCP paper",
                            locator={"paper_id": 42},
                        ),
                    ),
                )
                with (
                    patch.object(mcp_server, "load_config", return_value=Config()),
                    patch.object(mcp_server, "call_mcp_tool", return_value=rich),
                ):
                    response = mcp_server.call_tool_result(
                        "get_papers_by_ids",
                        {"paper_ids": [42]},
                        conn,
                    )
                reads = list_chat_resource_reads(conn, session.id or 0)
            finally:
                clear_codex_mcp_ledger_context()
                self.assertFalse(codex_mcp_ledger_context_path().exists())
                conn.close()

        self.assertIsNotNone(response)
        self.assertEqual(len(reads), 1)
        self.assertEqual(reads[0].source, "capability_result")
        self.assertEqual(reads[0].provider, "codex_cli")
        self.assertEqual(reads[0].turn_id, "turn-mcp-ledger")
        self.assertEqual(reads[0].capability_name, "get_papers_by_ids")
        self.assertEqual(reads[0].resource_kind, "paper")
        self.assertEqual(reads[0].resource_id, "42")

    def test_mcp_tools_call_ignores_resource_read_persistence_failures(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patched_data_dir(tmp):
            conn = sqlite3.connect(":memory:")
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys=ON")
            try:
                init_db(conn)
                session = create_chat_session(conn, runtime_settings=ChatRuntimeSettings())
                conn.commit()
                write_codex_mcp_ledger_context(
                    session_id=session.id or 0,
                    turn_id="turn-mcp-ledger-failure",
                    provider="codex_cli",
                )
                rich = CapabilityResult(
                    text='{"ok": true, "paper": "MCP result"}',
                    resource_reads=(
                        resource_read(
                            "paper",
                            42,
                            label="MCP paper",
                            locator={"paper_id": 42},
                        ),
                    ),
                )
                with (
                    patch.object(mcp_server, "load_config", return_value=Config()),
                    patch.object(mcp_server, "call_mcp_tool", return_value=rich),
                    patch.object(
                        mcp_server,
                        "insert_chat_resource_reads",
                        side_effect=RuntimeError("ledger write failed"),
                    ),
                    patch.object(mcp_server.logger, "exception") as log_exception,
                ):
                    response = mcp_server.call_tool_result(
                        "get_papers_by_ids",
                        {"paper_ids": [42]},
                        conn,
                    )
            finally:
                clear_codex_mcp_ledger_context()
                conn.close()

        self.assertIsNotNone(response)
        self.assertFalse(response.isError)
        self.assertEqual(response.content[0].text, '{"ok": true, "paper": "MCP result"}')
        log_exception.assert_called_once()
        self.assertIn(
            "Failed to persist MCP resource reads",
            log_exception.call_args.args[0],
        )

    def test_mcp_status_parser_normalizes_namespaced_tool_names(self) -> None:
        response = {
            "data": [
                {
                    "name": "claudesk",
                    "tools": {
                        "mcp__claudesk__read_paper_pdf": {
                            "name": "mcp__claudesk__read_paper_pdf",
                            "inputSchema": {},
                        }
                    },
                }
            ]
        }

        names = _mcp_status_tool_names(response)

        self.assertIn("mcp__claudesk__read_paper_pdf", names)
        self.assertIn("read_paper_pdf", names)


class FakeCodexTransport:
    instances: list["FakeCodexTransport"] = []
    ledger_context_snapshots: list[dict | None] = []

    def __init__(self, command: list[str], cwd: str | Path | None = None) -> None:
        self.command = command
        self.cwd = Path(cwd).resolve() if cwd is not None else None
        self.requests: list[tuple[str, dict | None]] = []
        self.notifications: asyncio.Queue[dict] = asyncio.Queue()
        self.alive = True
        FakeCodexTransport.instances.append(self)

    async def start(self) -> None:
        return None

    async def request(self, method: str, params: dict | None = None, *, timeout: float = 120.0) -> dict:  # noqa: ARG002
        self.requests.append((method, params))
        if method == "initialize":
            return {}
        if method == "thread/start":
            return {"thread": {"id": "thread-new", "path": "/tmp/thread-new.jsonl"}}
        if method == "thread/resume":
            return {"thread": {"id": params["threadId"], "path": "/tmp/thread-existing.jsonl"}}
        if method == "mcpServerStatus/list":
            tools = {name: {"name": name, "inputSchema": {}} for name in PAPER_PDF_CAPABILITY_NAMES}
            return {"data": [{"name": "claudesk", "authStatus": "none", "resources": [], "resourceTemplates": [], "tools": tools}]}
        if method == "turn/start":
            context_path = codex_mcp_ledger_context_path()
            FakeCodexTransport.ledger_context_snapshots.append(
                json.loads(context_path.read_text(encoding="utf-8"))
                if context_path.exists()
                else None
            )
            thread_id = params["threadId"]
            await self.notifications.put({
                "method": "item/agentMessage/delta",
                "params": {"threadId": thread_id, "turnId": "turn-1", "itemId": "item-1", "delta": "Hello"},
            })
            await self.notifications.put({
                "method": "turn/completed",
                "params": {"threadId": thread_id, "turn": {"id": "turn-1"}},
            })
            return {"turn": {"id": "turn-1"}}
        if method == "turn/abort":
            return {"ok": True}
        if method == "turn/interrupt":
            return {"ok": True}
        raise AssertionError(method)

    async def notify(self, method: str, params: dict | None = None) -> None:
        self.requests.append((method, params))

    async def close(self) -> None:
        self.alive = False


class CodexAppServerRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        FakeCodexTransport.instances = []
        FakeCodexTransport.ledger_context_snapshots = []
        self._tmp_data_dir = tempfile.TemporaryDirectory()
        self._data_dir_patch = patched_data_dir(self._tmp_data_dir.name)
        self._data_dir_patch.__enter__()

    def tearDown(self) -> None:
        self._data_dir_patch.__exit__(None, None, None)
        self._tmp_data_dir.cleanup()

    def _provider_state_for_thread(self, cfg: Config, thread_id: str, **overrides) -> dict:
        state = {**codex_runtime_state(cfg), "thread_id": thread_id}
        state.update(overrides)
        return {"codex_cli": state}

    def _runtime_methods_for_provider_state(self, cfg: Config, provider_state: dict) -> list[str]:
        runtime = CodexAppServerRuntime(transport_factory=FakeCodexTransport)

        async def collect() -> None:
            async for _event in runtime.stream_turn(
                session_id=99,
                latest_user_message="Again",
                system_prompt="System",
                cfg=cfg,
                provider_state=provider_state,
                update_provider_state=lambda state: asyncio.sleep(0),
            ):
                pass
            await runtime.close()

        asyncio.run(collect())
        return [method for method, _ in FakeCodexTransport.instances[-1].requests]

    def test_app_server_command_uses_stdio(self) -> None:
        cfg = Config()
        command = build_codex_app_server_command(cfg)
        self.assertEqual(command[:4], ["codex", "app-server", "--listen", "stdio://"])
        overrides = command[4:]
        self.assertEqual(overrides[0::2], ["-c"] * (len(overrides) // 2))
        override_values = dict(arg.split("=", 1) for arg in overrides[1::2])
        payload = codex_config_payload(cfg)
        claudesk = payload["mcp_servers"]["claudesk"]

        self.assertEqual(
            set(override_values),
            {
                "features.shell_tool",
                "features.shell_snapshot",
                "mcp_servers.claudesk.command",
                "mcp_servers.claudesk.args",
                "mcp_servers.claudesk.env.CLAUDESK_DATA_DIR",
                "mcp_servers.claudesk.default_tools_approval_mode",
                "mcp_servers.claudesk.required",
                "mcp_servers.claudesk.startup_timeout_sec",
                "mcp_servers.claudesk.tool_timeout_sec",
                "sandbox_mode",
                "sandbox_workspace_write.network_access",
                "tools.view_image",
                "web_search",
            },
        )
        self.assertEqual(override_values["features.shell_tool"], "false")
        self.assertEqual(override_values["features.shell_snapshot"], "false")
        self.assertEqual(
            override_values["mcp_servers.claudesk.command"],
            json.dumps(claudesk["command"], separators=(",", ":")),
        )
        self.assertEqual(
            override_values["mcp_servers.claudesk.args"],
            json.dumps(claudesk["args"], separators=(",", ":")),
        )
        self.assertEqual(
            override_values["mcp_servers.claudesk.env.CLAUDESK_DATA_DIR"],
            json.dumps(str(data_dir().resolve())),
        )
        self.assertEqual(override_values["mcp_servers.claudesk.default_tools_approval_mode"], '"approve"')
        self.assertEqual(override_values["mcp_servers.claudesk.required"], "true")
        self.assertEqual(override_values["mcp_servers.claudesk.startup_timeout_sec"], "30")
        self.assertEqual(override_values["mcp_servers.claudesk.tool_timeout_sec"], "120")
        self.assertEqual(override_values["sandbox_mode"], '"read-only"')
        self.assertEqual(override_values["sandbox_workspace_write.network_access"], "false")
        self.assertEqual(override_values["tools.view_image"], "false")
        self.assertEqual(override_values["web_search"], '"disabled"')

    def test_codex_runtime_writes_and_clears_mcp_ledger_context(self) -> None:
        runtime = CodexAppServerRuntime(transport_factory=FakeCodexTransport)

        async def collect() -> list[dict]:
            events = []
            async for event in runtime.stream_turn(
                session_id=77,
                latest_user_message="Read this",
                system_prompt="System",
                cfg=Config(),
                provider_state={},
                update_provider_state=lambda state: asyncio.sleep(0),
                ledger_turn_id="chat-turn-77",
            ):
                events.append(event)
            await runtime.close()
            return events

        events = asyncio.run(collect())

        self.assertIn({"type": "text", "content": "Hello"}, events)
        self.assertEqual(FakeCodexTransport.ledger_context_snapshots, [{
            "session_id": 77,
            "turn_id": "chat-turn-77",
            "provider": "codex_cli",
        }])
        self.assertFalse(codex_mcp_ledger_context_path().exists())

    def test_codex_native_shell_tool_setting_controls_feature_flags(self) -> None:
        disabled_cfg = Config()
        disabled_payload = codex_config_payload(disabled_cfg)
        self.assertEqual(
            disabled_payload["features"],
            {"shell_tool": False, "shell_snapshot": False},
        )
        self.assertEqual(disabled_payload["sandbox_mode"], "read-only")
        disabled_thread = codex_thread_params("System", disabled_cfg)
        self.assertEqual(disabled_thread["sandbox"], "read-only")

        enabled_cfg = Config(chat=ChatConfig(codex_native_shell_tools=True))
        enabled_payload = codex_config_payload(enabled_cfg)
        self.assertEqual(
            enabled_payload["features"],
            {"shell_tool": True, "shell_snapshot": True},
        )
        self.assertEqual(enabled_payload["sandbox_mode"], "workspace-write")
        self.assertEqual(enabled_payload["web_search"], "disabled")
        self.assertFalse(enabled_payload["tools"]["view_image"])
        self.assertFalse(enabled_payload["sandbox_workspace_write"]["network_access"])
        self.assertEqual(
            enabled_payload["sandbox_workspace_write"]["writable_roots"],
            disabled_payload["sandbox_workspace_write"]["writable_roots"],
        )
        enabled_thread = codex_thread_params("System", enabled_cfg)
        self.assertEqual(enabled_thread["sandbox"], "workspace-write")

        command = build_codex_app_server_command(enabled_cfg)
        override_values = dict(arg.split("=", 1) for arg in command[5::2])
        self.assertEqual(override_values["features.shell_tool"], "true")
        self.assertEqual(override_values["features.shell_snapshot"], "true")
        self.assertEqual(override_values["sandbox_mode"], '"workspace-write"')

    def test_codex_native_web_image_and_network_settings_control_native_config(self) -> None:
        native_web_cfg = Config(chat=ChatConfig(codex_native_web_search=True))
        native_web_payload = codex_config_payload(native_web_cfg)
        self.assertEqual(native_web_payload["web_search"], "live")
        self.assertIn("search_web", get_capability_registry().enabled_names(native_web_cfg.chat.tools))

        native_web_without_mcp_cfg = Config(
            chat=ChatConfig(
                codex_native_web_search=True,
                tools=ChatToolsConfig(search_web=False),
            )
        )
        self.assertEqual(codex_config_payload(native_web_without_mcp_cfg)["web_search"], "live")
        self.assertNotIn("search_web", get_capability_registry().enabled_names(native_web_without_mcp_cfg.chat.tools))

        native_image_cfg = Config(chat=ChatConfig(codex_native_image_view=True))
        self.assertTrue(codex_config_payload(native_image_cfg)["tools"]["view_image"])

        network_without_shell_cfg = Config(chat=ChatConfig(codex_native_network_access=True))
        network_without_shell_payload = codex_config_payload(network_without_shell_cfg)
        self.assertEqual(network_without_shell_payload["sandbox_mode"], "read-only")
        self.assertFalse(network_without_shell_payload["sandbox_workspace_write"]["network_access"])
        self.assertEqual(codex_sandbox_policy(network_without_shell_cfg), {"type": "readOnly", "networkAccess": False})

        network_with_shell_cfg = Config(
            chat=ChatConfig(
                codex_native_shell_tools=True,
                codex_native_network_access=True,
            )
        )
        network_with_shell_payload = codex_config_payload(network_with_shell_cfg)
        self.assertEqual(network_with_shell_payload["sandbox_mode"], "workspace-write")
        self.assertTrue(network_with_shell_payload["sandbox_workspace_write"]["network_access"])
        self.assertEqual(
            codex_sandbox_policy(network_with_shell_cfg),
            {
                "type": "workspaceWrite",
                "networkAccess": True,
                "writableRoots": [str(codex_chat_cwd().resolve())],
            },
        )

        command = build_codex_app_server_command(network_with_shell_cfg)
        override_values = dict(arg.split("=", 1) for arg in command[5::2])
        self.assertEqual(override_values["sandbox_workspace_write.network_access"], "true")

    def test_codex_config_hash_tracks_native_codex_settings(self) -> None:
        disabled_cfg = Config()
        variants = [
            ChatConfig(codex_native_shell_tools=True),
            ChatConfig(codex_native_web_search=True),
            ChatConfig(codex_native_image_view=True),
            ChatConfig(codex_native_shell_tools=True, codex_native_network_access=True),
        ]

        for chat_cfg in variants:
            with self.subTest(chat_cfg=chat_cfg):
                self.assertNotEqual(codex_config_hash(disabled_cfg), codex_config_hash(Config(chat=chat_cfg)))

        self.assertEqual(
            codex_config_hash(disabled_cfg),
            codex_config_hash(Config(chat=ChatConfig(codex_native_network_access=True))),
        )
        self.assertNotEqual(
            codex_config_hash(Config(chat=ChatConfig(codex_native_shell_tools=True))),
            codex_config_hash(Config(chat=ChatConfig(
                codex_native_shell_tools=True,
                codex_native_network_access=True,
            ))),
        )

    def test_codex_config_approves_claudesk_mcp_tools(self) -> None:
        claudesk = codex_config_payload(Config())["mcp_servers"]["claudesk"]
        self.assertEqual(claudesk["command"], sys.executable)
        self.assertEqual(claudesk["args"], ["-m", "claudesk.agent.mcp_server"])
        self.assertEqual(claudesk["env"], {"CLAUDESK_DATA_DIR": str(data_dir().resolve())})
        self.assertEqual(claudesk["default_tools_approval_mode"], "approve")
        self.assertIs(claudesk["required"], True)
        self.assertEqual(claudesk["startup_timeout_sec"], 30)
        self.assertEqual(claudesk["tool_timeout_sec"], 120)

    def test_jsonl_transport_declines_app_server_approval_requests(self) -> None:
        class FakeStdin:
            def __init__(self) -> None:
                self.lines: list[bytes] = []

            def write(self, data: bytes) -> None:
                self.lines.append(data)

            async def drain(self) -> None:
                return None

        class FakeProcess:
            def __init__(self) -> None:
                self.stdin = FakeStdin()
                self.returncode = None

        async def respond(method: str, params: dict | None = None) -> dict:
            process = FakeProcess()
            transport = JsonlRpcTransport(["codex", "app-server"])
            transport.process = process
            await transport._respond_to_server_request({
                "jsonrpc": "2.0",
                "id": 7,
                "method": method,
                "params": params or {},
            })
            line = process.stdin.lines[-1].decode("utf-8")
            return json.loads(line)

        self.assertEqual(
            asyncio.run(respond("item/commandExecution/requestApproval"))["result"],
            {"decision": "decline"},
        )
        self.assertEqual(
            asyncio.run(respond("item/fileChange/requestApproval"))["result"],
            {"decision": "decline"},
        )
        self.assertEqual(
            asyncio.run(respond("item/permissions/requestApproval"))["result"],
            {"permissions": {"fileSystem": None, "network": None}, "scope": "turn"},
        )

    def test_jsonl_transport_matches_request_response_ids(self) -> None:
        script = (
            "import json,sys\n"
            "for line in sys.stdin:\n"
            "    msg=json.loads(line)\n"
            "    print(json.dumps({'jsonrpc':'2.0','id':msg['id'],'result':{'method':msg['method']}}), flush=True)\n"
        )

        async def run_transport() -> dict:
            transport = JsonlRpcTransport([sys.executable, "-c", script])
            await transport.start()
            try:
                return await transport.request("ping", {"value": 1})
            finally:
                await transport.close()

        self.assertEqual(asyncio.run(run_transport()), {"method": "ping"})

    def test_jsonl_transport_uses_enlarged_stdio_limit(self) -> None:
        async def run_transport() -> int:
            class FakeProcess:
                stdin = None
                stdout = None
                stderr = None
                returncode = 0

            patched = AsyncMock(return_value=FakeProcess())
            with patch("asyncio.create_subprocess_exec", new=patched):
                transport = JsonlRpcTransport(["codex", "app-server"])
                await transport.start()
                transport._reader_task.cancel()
                transport._stderr_task.cancel()
                return patched.call_args.kwargs["limit"]

        self.assertEqual(asyncio.run(run_transport()), CODEX_STDIO_LIMIT_BYTES)

    def test_jsonl_transport_uses_project_root_cwd(self) -> None:
        async def run_transport() -> str:
            class FakeProcess:
                stdin = None
                stdout = None
                stderr = None
                returncode = 0

            patched = AsyncMock(return_value=FakeProcess())
            with patch("asyncio.create_subprocess_exec", new=patched):
                transport = JsonlRpcTransport(["codex", "app-server"])
                await transport.start()
                transport._reader_task.cancel()
                transport._stderr_task.cancel()
                return patched.call_args.kwargs["cwd"]

        self.assertEqual(asyncio.run(run_transport()), str(project_root()))

    def test_jsonl_transport_retries_transient_spawn_eagain(self) -> None:
        async def run_transport() -> tuple[int, list[float]]:
            class FakeProcess:
                stdin = None
                stdout = None
                stderr = None
                returncode = 0

            calls = 0
            sleep_delays: list[float] = []

            async def patched_create(*_args, **_kwargs):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise BlockingIOError(35, "Resource temporarily unavailable")
                return FakeProcess()

            async def patched_sleep(delay: float) -> None:
                sleep_delays.append(delay)

            with (
                patch("asyncio.create_subprocess_exec", new=patched_create),
                patch("asyncio.sleep", new=patched_sleep),
            ):
                transport = JsonlRpcTransport(["codex", "app-server"])
                await transport.start()
                transport._reader_task.cancel()
                transport._stderr_task.cancel()
                return calls, sleep_delays

        calls, sleep_delays = asyncio.run(run_transport())
        self.assertEqual(calls, 2)
        self.assertEqual(sleep_delays, [CODEX_APP_SERVER_START_RETRY_DELAY_SECONDS])

    def test_app_server_notifications_map_to_frontend_events(self) -> None:
        self.assertEqual(
            parse_codex_app_server_notification({
                "method": "item/agentMessage/delta",
                "params": {"threadId": "t1", "turnId": "u1", "itemId": "i1", "delta": "Hi"},
            }, thread_id="t1", turn_id="u1"),
            {"type": "text", "content": "Hi"},
        )
        self.assertEqual(
            parse_codex_app_server_notification({
                "method": "turn/completed",
                "params": {"threadId": "t1", "turn": {"id": "u1"}},
            }, thread_id="t1"),
            {"type": "done", "finish_reason": "stop"},
        )
        self.assertIsNone(
            parse_codex_app_server_notification({
                "method": "item/agentMessage/delta",
                "params": {"threadId": "other", "turnId": "u1", "itemId": "i1", "delta": "Skip"},
            }, thread_id="t1", turn_id="u1")
        )
        self.assertEqual(
            parse_codex_app_server_notification({
                "method": "item/reasoning/textDelta",
                "params": {"threadId": "t1", "turnId": "u1", "delta": "Plan"},
            }, thread_id="t1", turn_id="u1"),
            {"type": "progress", "content": "Plan"},
        )

    def test_transcript_parser_ignores_reasoning_and_maps_tool_results(self) -> None:
        self.assertIsNone(
            parse_codex_transcript_event({"type": "response_item", "item": {"type": "reasoning", "summary": "Think"}}),
        )
        self.assertEqual(
            parse_codex_transcript_event({"type": "response_item", "item": {"type": "mcp_tool_call", "name": "search_web"}}),
            {"type": "tool_start", "name": "search_web"},
        )
        self.assertEqual(
            parse_codex_transcript_event({"type": "response_item", "item": {"type": "mcp_tool_result", "name": "search_web", "output": "Done"}}),
            {"type": "tool_result", "name": "search_web", "summary": "Done"},
        )
        self.assertIsNone(
            parse_codex_transcript_event({"event_msg": {"type": "response_item", "item": {"type": "exec_command_end", "id": "x1", "name": "exec", "exit_code": 0, "output": "ok"}}})
        )
        self.assertIsNone(
            parse_codex_transcript_event({"type": "response_item", "payload": {"type": "function_call", "name": "exec_command", "call_id": "shell-1"}})
        )
        self.assertIsNone(
            parse_codex_transcript_event({"type": "response_item", "payload": {"type": "function_call_output", "call_id": "shell-1", "output": "shell output"}})
        )
        self.assertIsNone(
            parse_codex_transcript_event({"type": "response_item", "payload": {"type": "web_search_call", "status": "completed"}})
        )
        self.assertIsNone(
            parse_codex_transcript_event({"type": "response_item", "payload": {"type": "tool_search_call", "call_id": "search-1"}})
        )
        self.assertIsNone(
            parse_codex_transcript_event({"type": "response_item", "payload": {"type": "tool_search_output", "call_id": "search-1"}})
        )
        self.assertEqual(
            parse_codex_transcript_event({"payload": {"type": "custom_tool_call", "call_id": "c1", "name": "fetch_url"}}),
            {"name": "fetch_url", "id": "c1", "type": "tool_start"},
        )
        self.assertEqual(
            parse_codex_transcript_event({
                "type": "event_msg",
                "payload": {
                    "type": "mcp_tool_call_end",
                    "call_id": "pdf-1",
                    "invocation": {"server": "claudesk", "tool": "read_paper_pdf"},
                    "result": {
                        "Ok": {
                            "content": [
                                {
                                    "type": "text",
                                    "text": json.dumps({
                                        "ok": True,
                                        "paper_id": 133,
                                        "asset": {"display_name": "paper.pdf"},
                                        "chunks": [{"chunk_index": 0}, {"chunk_index": 1}],
                                        "next_chunk_index": 2,
                                    }),
                                }
                            ]
                        }
                    },
                },
            }),
            {
                "name": "read_paper_pdf",
                "id": "pdf-1",
                "server": "claudesk",
                "tool": "read_paper_pdf",
                "type": "tool_result",
                "summary": "ok=true paper_id=133 asset=paper.pdf chunks=2 next_chunk_index=2",
            },
        )
        self.assertEqual(
            parse_codex_transcript_event({
                "type": "event_msg",
                "payload": {
                    "type": "mcp_tool_call_end",
                    "call_id": "search-1",
                    "invocation": {"server": "claudesk", "tool": "search_paper_pdf"},
                    "result": {
                        "Ok": {
                            "content": [
                                {
                                    "type": "text",
                                    "text": json.dumps({
                                        "content": [
                                            {
                                                "type": "text",
                                                "text": json.dumps({
                                                    "ok": True,
                                                    "paper_id": 133,
                                                    "asset": {"display_name": "paper.pdf"},
                                                    "matches": [{}, {}, {}],
                                                    "attached_images": [{}, {}],
                                                }),
                                            }
                                        ],
                                        "isError": False,
                                    }),
                                }
                            ]
                        }
                    },
                },
            }),
            {
                "name": "search_paper_pdf",
                "id": "search-1",
                "server": "claudesk",
                "tool": "search_paper_pdf",
                "type": "tool_result",
                "summary": "ok=true paper_id=133 asset=paper.pdf matches=3 attached_images=2",
            },
        )
        self.assertEqual(
            parse_codex_transcript_event({"response_item": {"type": "function_call_output", "call_id": "f1", "name": "search_papers", "content": {"ok": True}}}),
            {"name": "search_papers", "id": "f1", "type": "tool_result", "summary": "{\"ok\": true}"},
        )
        self.assertEqual(
            parse_codex_transcript_event({"type": "token_count", "input": 1, "output": 2}),
            None,
        )
        self.assertIsNone(
            parse_codex_transcript_event({"type": "response_item", "payload": {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "hidden"}]}})
        )
        self.assertIsNone(
            parse_codex_transcript_event({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hidden"}]}})
        )
        self.assertEqual(
            parse_codex_transcript_event({"type": "event_msg", "payload": {"type": "agent_message", "message": "Final answer"}}),
            {"type": "text", "content": "Final answer"},
        )

    def test_skill_mentions_are_explicit_and_deduped(self) -> None:
        self.assertEqual(extract_skill_mentions("Use $Alpha and $Alpha plus $beta-2."), ["Alpha", "beta-2"])

    def test_transcript_tail_starts_when_file_appears_after_prime(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "late.jsonl"
            tail = CodexTranscriptTail(str(transcript))
            tail.prime()

            transcript.write_text(
                json.dumps({"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": "late"}}) + "\n",
                encoding="utf-8",
            )

            self.assertFalse(tail.available)
            self.assertEqual(tail.drain(), [{"type": "text", "content": "late"}])
            self.assertTrue(tail.available)
            self.assertEqual(tail.drain(), [])

    def test_runtime_starts_new_thread_and_persists_state(self) -> None:
        runtime = CodexAppServerRuntime(transport_factory=FakeCodexTransport)
        captured_state: list[dict] = []
        with tempfile.TemporaryDirectory() as tmp, patched_data_dir(tmp):
            expected_cwd = codex_chat_cwd()
            blocked_data_root = data_dir().resolve()
            blocked_asset_root = (Path(tmp) / "assets").resolve()
            cfg = Config()
            expected_runtime_state = codex_runtime_state(cfg)

            async def collect() -> list[dict]:
                async def update_state(state: dict) -> None:
                    captured_state.append(state)

                events = []
                async for event in runtime.stream_turn(
                    session_id=1,
                    latest_user_message="Hi",
                    system_prompt="System",
                    cfg=cfg,
                    provider_state={},
                    update_provider_state=update_state,
                ):
                    events.append(event)
                await runtime.close()
                return events

            with patch("os.getcwd", return_value="/tmp/not-claudesk"):
                events = asyncio.run(collect())
        transport = FakeCodexTransport.instances[0]
        self.assertEqual(transport.cwd, expected_cwd)
        self.assertEqual([method for method, _ in transport.requests[:3]], ["initialize", "initialized", "thread/start"])
        self.assertEqual(
            transport.requests[0],
            (
                "initialize",
                {
                    "clientInfo": {"name": "claudesk", "version": __version__},
                    "capabilities": {"experimentalApi": True},
                },
            ),
        )
        self.assertEqual(transport.requests[1], ("initialized", None))
        thread_params = next(params for method, params in transport.requests if method == "thread/start")
        self.assertEqual(thread_params["cwd"], str(expected_cwd))
        self.assertEqual(thread_params["sandbox"], "read-only")
        self.assertEqual(thread_params["config"]["features"], {"shell_tool": False, "shell_snapshot": False})
        self.assertEqual(thread_params["config"]["sandbox_mode"], "read-only")
        self.assertEqual(thread_params["config"]["web_search"], "disabled")
        self.assertNotIn("web_search", thread_params["config"]["tools"])
        self.assertFalse(thread_params["config"]["tools"]["view_image"])
        self.assertFalse(thread_params["config"]["sandbox_workspace_write"]["network_access"])
        turn_params = next(params for method, params in transport.requests if method == "turn/start")
        self.assertEqual(turn_params["cwd"], str(expected_cwd))
        self.assertEqual(turn_params["threadId"], "thread-new")
        self.assertEqual(turn_params["input"], [{"type": "text", "text": "Hi"}])
        self.assertEqual(turn_params["sandboxPolicy"], {"type": "readOnly", "networkAccess": False})
        writable_roots = turn_params["sandboxPolicy"].get("writableRoots", [])
        self.assertNotIn(str(blocked_data_root), writable_roots)
        self.assertNotIn(str(blocked_asset_root), writable_roots)
        self.assertNotIn(str(project_root().resolve()), writable_roots)
        self.assertEqual(events[0], {"type": "text", "content": "Hello"})
        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual(captured_state[0]["codex_cli"]["thread_id"], "thread-new")
        self.assertEqual(captured_state[0]["codex_cli"]["session_file_path"], "/tmp/thread-new.jsonl")
        self.assertEqual(captured_state[0]["codex_cli"]["runtime_version"], CODEX_CHAT_RUNTIME_VERSION)
        for key, value in expected_runtime_state.items():
            self.assertEqual(captured_state[0]["codex_cli"][key], value)

    def test_thread_start_uses_setting_specific_codex_config(self) -> None:
        runtime = CodexAppServerRuntime(transport_factory=FakeCodexTransport)
        cfg = Config(chat=ChatConfig(codex_native_shell_tools=True))

        async def collect() -> None:
            async for _event in runtime.stream_turn(
                session_id=12,
                latest_user_message="Hi",
                system_prompt="System",
                cfg=cfg,
                provider_state={},
                update_provider_state=lambda state: asyncio.sleep(0),
            ):
                pass
            await runtime.close()

        asyncio.run(collect())
        transport = FakeCodexTransport.instances[0]
        thread_params = next(params for method, params in transport.requests if method == "thread/start")
        self.assertEqual(thread_params["config"]["features"], {"shell_tool": True, "shell_snapshot": True})
        self.assertEqual(thread_params["sandbox"], "workspace-write")
        self.assertEqual(thread_params["config"]["sandbox_mode"], "workspace-write")
        turn_params = next(params for method, params in transport.requests if method == "turn/start")
        self.assertEqual(turn_params["sandboxPolicy"]["type"], "workspaceWrite")
        self.assertFalse(turn_params["sandboxPolicy"]["networkAccess"])
        self.assertEqual(turn_params["sandboxPolicy"]["writableRoots"], [str(codex_chat_cwd().resolve())])

    def test_runtime_resumes_existing_thread(self) -> None:
        runtime = CodexAppServerRuntime(transport_factory=FakeCodexTransport)
        cfg = Config()
        provider_state = self._provider_state_for_thread(cfg, "thread-existing")

        async def collect() -> list[dict]:
            events = []
            async for event in runtime.stream_turn(
                session_id=2,
                latest_user_message="Again",
                system_prompt="System",
                cfg=cfg,
                provider_state=provider_state,
                update_provider_state=lambda state: asyncio.sleep(0),
            ):
                events.append(event)
            await runtime.close()
            return events

        with patch("os.getcwd", return_value="/tmp/not-claudesk"):
            events = asyncio.run(collect())
        transport = FakeCodexTransport.instances[0]
        self.assertIn("thread/resume", [method for method, _ in transport.requests])
        self.assertNotIn("thread/start", [method for method, _ in transport.requests])
        resume_params = next(params for method, params in transport.requests if method == "thread/resume")
        self.assertEqual(resume_params["cwd"], str(codex_chat_cwd()))
        self.assertEqual(events[0]["content"], "Hello")

    def test_runtime_fail_closes_when_required_mcp_tools_are_missing(self) -> None:
        class MissingToolTransport(FakeCodexTransport):
            async def request(self, method: str, params: dict | None = None, *, timeout: float = 120.0) -> dict:  # noqa: ARG002
                self.requests.append((method, params))
                if method == "initialize":
                    return {}
                if method == "thread/start":
                    return {"thread": {"id": "thread-new", "path": "/tmp/thread-new.jsonl"}}
                if method == "mcpServerStatus/list":
                    return {"data": [{"name": "claudesk", "authStatus": "none", "resources": [], "resourceTemplates": [], "tools": {}}]}
                if method == "turn/start":
                    raise AssertionError("Codex turn should not start without required MCP tools")
                raise AssertionError(method)

        runtime = CodexAppServerRuntime(transport_factory=MissingToolTransport)

        async def collect() -> list[dict]:
            events = []
            async for event in runtime.stream_turn(
                session_id=7,
                latest_user_message="Read the attached paper PDF",
                system_prompt="System",
                cfg=Config(),
                provider_state={},
                update_provider_state=lambda state: asyncio.sleep(0),
                required_capabilities=set(PAPER_PDF_CAPABILITY_NAMES),
            ):
                events.append(event)
            await runtime.close()
            return events

        with self.assertLogs("claudesk.agent.codex_runtime", level="WARNING") as logs:
            events = asyncio.run(collect())
        requests = FakeCodexTransport.instances[0].requests
        self.assertIn(("mcpServerStatus/list", {"detail": "toolsAndAuthOnly"}), requests)
        self.assertNotIn("turn/start", [method for method, _ in requests])
        self.assertIn("Codex required MCP tools are missing", "\n".join(logs.output))
        self.assertIn("required Claudesk PDF capabilities", events[0]["content"])
        self.assertIn("read_paper_pdf", events[0]["content"])
        self.assertIn("Codex MCP tool inventory diagnostic", events[0]["content"])
        self.assertIn("required_missing_from_registry=none", events[0]["content"])
        self.assertIn("required_missing_from_manifest=none", events[0]["content"])
        self.assertIn("required_missing_from_codex_registered=", events[0]["content"])
        self.assertIn("manifest_minus_codex_registered=", events[0]["content"])
        self.assertEqual(events[-1], {"type": "done", "finish_reason": "stop"})

    def test_runtime_logs_codex_mcp_tool_inventory_when_diagnostics_enabled(self) -> None:
        runtime = CodexAppServerRuntime(transport_factory=FakeCodexTransport)

        async def collect() -> list[dict]:
            events = []
            async for event in runtime.stream_turn(
                session_id=17,
                latest_user_message="Hi",
                system_prompt="System",
                cfg=Config(),
                provider_state={},
                update_provider_state=lambda state: asyncio.sleep(0),
            ):
                events.append(event)
            await runtime.close()
            return events

        with (
            patch.dict(os.environ, {CODEX_MCP_DIAGNOSTICS_ENV: "1"}, clear=False),
            self.assertLogs("claudesk.agent.codex_runtime", level="INFO") as logs,
        ):
            events = asyncio.run(collect())

        transport = FakeCodexTransport.instances[0]
        methods = [method for method, _params in transport.requests]
        self.assertLess(methods.index("mcpServerStatus/list"), methods.index("turn/start"))
        turn_params = next(params for method, params in transport.requests if method == "turn/start")
        self.assertEqual(turn_params["sandboxPolicy"], {"type": "readOnly", "networkAccess": False})
        self.assertIn("Codex MCP tool inventory snapshot (pre-turn)", "\n".join(logs.output))
        self.assertIn("read_paper_pdf", "\n".join(logs.output))
        self.assertEqual(events[0], {"type": "text", "content": "Hello"})
        self.assertEqual(events[-1], {"type": "done", "finish_reason": "stop"})

    def test_runtime_diagnostics_status_failure_does_not_block_optional_turn(self) -> None:
        class StatusFailureTransport(FakeCodexTransport):
            async def request(self, method: str, params: dict | None = None, *, timeout: float = 120.0) -> dict:
                if method == "mcpServerStatus/list":
                    self.requests.append((method, params))
                    raise RuntimeError("status down")
                return await super().request(method, params, timeout=timeout)

        runtime = CodexAppServerRuntime(transport_factory=StatusFailureTransport)

        async def collect() -> list[dict]:
            events = []
            async for event in runtime.stream_turn(
                session_id=18,
                latest_user_message="Hi",
                system_prompt="System",
                cfg=Config(),
                provider_state={},
                update_provider_state=lambda state: asyncio.sleep(0),
            ):
                events.append(event)
            await runtime.close()
            return events

        with (
            patch.dict(os.environ, {CODEX_MCP_DIAGNOSTICS_ENV: "1"}, clear=False),
            self.assertLogs("claudesk.agent.codex_runtime", level="WARNING") as logs,
        ):
            events = asyncio.run(collect())

        methods = [method for method, _params in FakeCodexTransport.instances[0].requests]
        self.assertIn("mcpServerStatus/list", methods)
        self.assertIn("turn/start", methods)
        output = "\n".join(logs.output)
        self.assertIn("Codex MCP tool inventory snapshot (status-error)", output)
        self.assertIn("status down", output)
        self.assertEqual(events[0], {"type": "text", "content": "Hello"})
        self.assertEqual(events[-1], {"type": "done", "finish_reason": "stop"})

    def test_runtime_ignores_legacy_unsafe_thread_state(self) -> None:
        runtime = CodexAppServerRuntime(transport_factory=FakeCodexTransport)

        async def collect() -> list[dict]:
            events = []
            async for event in runtime.stream_turn(
                session_id=22,
                latest_user_message="Again",
                system_prompt="System",
                cfg=Config(),
                provider_state={"codex_cli": {"thread_id": "legacy-thread"}},
                update_provider_state=lambda state: asyncio.sleep(0),
            ):
                events.append(event)
            await runtime.close()
            return events

        events = asyncio.run(collect())
        transport = FakeCodexTransport.instances[0]
        self.assertNotIn("thread/resume", [method for method, _ in transport.requests])
        self.assertIn("thread/start", [method for method, _ in transport.requests])
        self.assertEqual(events[0]["content"], "Hello")

    def test_runtime_refuses_to_resume_when_runtime_signature_digest_changes(self) -> None:
        cfg = Config()
        provider_state = self._provider_state_for_thread(
            cfg,
            "thread-existing",
            runtime_signature_digest="old-signature",
        )

        methods = self._runtime_methods_for_provider_state(cfg, provider_state)

        self.assertNotIn("thread/resume", methods)
        self.assertIn("thread/start", methods)

    def test_runtime_refuses_to_resume_when_codex_config_hash_changes(self) -> None:
        cfg = Config()
        provider_state = self._provider_state_for_thread(
            cfg,
            "thread-existing",
            codex_config_hash="old-config",
        )

        methods = self._runtime_methods_for_provider_state(cfg, provider_state)

        self.assertNotIn("thread/resume", methods)
        self.assertIn("thread/start", methods)

    def test_runtime_refuses_to_resume_when_native_codex_setting_changes(self) -> None:
        old_cfg = Config(chat=ChatConfig(backend="codex_cli"))
        provider_state = self._provider_state_for_thread(old_cfg, "thread-existing")
        variants = [
            ChatConfig(backend="codex_cli", codex_native_shell_tools=True),
            ChatConfig(backend="codex_cli", codex_native_web_search=True),
            ChatConfig(backend="codex_cli", codex_native_image_view=True),
            ChatConfig(backend="codex_cli", codex_native_shell_tools=True, codex_native_network_access=True),
        ]

        for chat_cfg in variants:
            with self.subTest(chat_cfg=chat_cfg):
                methods = self._runtime_methods_for_provider_state(Config(chat=chat_cfg), provider_state)

                self.assertNotIn("thread/resume", methods)
                self.assertIn("thread/start", methods)

    def test_runtime_resumes_when_ignored_native_network_setting_changes(self) -> None:
        old_cfg = Config(chat=ChatConfig(backend="codex_cli"))
        provider_state = self._provider_state_for_thread(old_cfg, "thread-existing")

        methods = self._runtime_methods_for_provider_state(
            Config(chat=ChatConfig(backend="codex_cli", codex_native_network_access=True)),
            provider_state,
        )

        self.assertIn("thread/resume", methods)
        self.assertNotIn("thread/start", methods)

    def test_runtime_refuses_to_resume_when_effective_native_network_setting_changes(self) -> None:
        old_cfg = Config(chat=ChatConfig(backend="codex_cli", codex_native_shell_tools=True))
        provider_state = self._provider_state_for_thread(old_cfg, "thread-existing")

        methods = self._runtime_methods_for_provider_state(
            Config(chat=ChatConfig(
                backend="codex_cli",
                codex_native_shell_tools=True,
                codex_native_network_access=True,
            )),
            provider_state,
        )

        self.assertNotIn("thread/resume", methods)
        self.assertIn("thread/start", methods)

    def test_runtime_refuses_to_resume_when_local_runtime_identity_changes(self) -> None:
        cfg = Config()
        provider_state = self._provider_state_for_thread(
            cfg,
            "thread-existing",
            data_dir="/old/data",
            managed_pdf_asset_root="/old/assets",
            sys_executable="/old/python",
        )

        methods = self._runtime_methods_for_provider_state(cfg, provider_state)

        self.assertNotIn("thread/resume", methods)
        self.assertIn("thread/start", methods)

    def test_runtime_reuses_loaded_thread_without_resume(self) -> None:
        runtime = CodexAppServerRuntime(transport_factory=FakeCodexTransport)
        cfg = Config()
        provider_state = self._provider_state_for_thread(cfg, "thread-hot")

        async def run_two_turns() -> list[str]:
            async def update_state(state: dict) -> None:
                return None

            for text in ("First", "Second"):
                async for _event in runtime.stream_turn(
                    session_id=3,
                    latest_user_message=text,
                    system_prompt="System",
                    cfg=cfg,
                    provider_state=provider_state,
                    update_provider_state=update_state,
                ):
                    pass
            await runtime.close()
            return [method for method, _ in FakeCodexTransport.instances[0].requests]

        methods = asyncio.run(run_two_turns())
        self.assertEqual(methods.count("thread/resume"), 1)
        self.assertEqual(methods.count("turn/start"), 2)

    def test_runtime_forwards_session_model_and_codex_options(self) -> None:
        runtime = CodexAppServerRuntime(transport_factory=FakeCodexTransport)
        cfg = Config(chat=ChatConfig(
            backend="codex_cli",
            model="gpt-5.4",
            reasoning_effort="high",
            reasoning_summary="concise",
            service_tier="fast",
        ))

        async def collect() -> None:
            async for _event in runtime.stream_turn(
                session_id=1,
                latest_user_message="Hi",
                system_prompt="System",
                cfg=cfg,
                provider_state={},
                update_provider_state=None,
            ):
                pass
            await runtime.close()

        asyncio.run(collect())
        requests = FakeCodexTransport.instances[0].requests
        thread_params = next(params for method, params in requests if method == "thread/start")
        turn_params = next(params for method, params in requests if method == "turn/start")
        self.assertEqual(thread_params["model"], "gpt-5.4")
        self.assertEqual(turn_params["model"], "gpt-5.4")
        self.assertEqual(turn_params["effort"], "high")
        self.assertEqual(turn_params["summary"], "concise")
        self.assertEqual(turn_params["serviceTier"], "fast")
        self.assertNotIn("temperature", turn_params)

    def test_runtime_omits_unset_codex_summary_and_service_tier(self) -> None:
        for summary in (None, "none"):
            with self.subTest(summary=summary):
                runtime = CodexAppServerRuntime(transport_factory=FakeCodexTransport)
                cfg = Config(chat=ChatConfig(backend="codex_cli", reasoning_summary=summary))

                async def collect() -> None:
                    async for _event in runtime.stream_turn(
                        session_id=1,
                        latest_user_message="Hi",
                        system_prompt="System",
                        cfg=cfg,
                        provider_state={},
                        update_provider_state=None,
                    ):
                        pass
                    await runtime.close()

                asyncio.run(collect())
                requests = FakeCodexTransport.instances[-1].requests
                turn_params = next(params for method, params in requests if method == "turn/start")
                self.assertNotIn("summary", turn_params)
                self.assertNotIn("serviceTier", turn_params)

    def test_sessions_with_different_settings_reuse_transport_and_their_threads(self) -> None:
        runtime = CodexAppServerRuntime(transport_factory=FakeCodexTransport)
        first_cfg = Config(chat=ChatConfig(backend="codex_cli", model="gpt-5.5", reasoning_effort="low"))
        second_cfg = Config(chat=ChatConfig(
            backend="codex_cli",
            model="gpt-5.4",
            reasoning_effort="high",
            reasoning_summary="concise",
            service_tier="fast",
        ))
        configs = {1: first_cfg, 2: second_cfg}
        states = {
            session_id: self._provider_state_for_thread(cfg, f"thread-{session_id}")
            for session_id, cfg in configs.items()
        }

        async def collect() -> None:
            for session_id in (1, 2, 1):
                async for _event in runtime.stream_turn(
                    session_id=session_id,
                    latest_user_message="Continue",
                    system_prompt="System",
                    cfg=configs[session_id],
                    provider_state=states[session_id],
                    update_provider_state=None,
                ):
                    pass
            await runtime.close()

        asyncio.run(collect())
        self.assertEqual(len(FakeCodexTransport.instances), 1)
        requests = FakeCodexTransport.instances[0].requests
        resumed = [params["threadId"] for method, params in requests if method == "thread/resume"]
        self.assertEqual(resumed, ["thread-1", "thread-2"])
        self.assertNotIn("thread/start", [method for method, _ in requests])
        turns = [params for method, params in requests if method == "turn/start"]
        self.assertEqual([turn["threadId"] for turn in turns], ["thread-1", "thread-2", "thread-1"])
        self.assertEqual([turn["model"] for turn in turns], ["gpt-5.5", "gpt-5.4", "gpt-5.5"])
        self.assertEqual([turn["effort"] for turn in turns], ["low", "high", "low"])
        self.assertEqual([turn.get("serviceTier") for turn in turns], [None, "fast", None])

    def test_session_runtime_change_restarts_only_its_thread(self) -> None:
        runtime = CodexAppServerRuntime(transport_factory=FakeCodexTransport)
        original_cfg = Config(chat=ChatConfig(backend="codex_cli", model="gpt-5.5"))
        changed_cfg = Config(chat=ChatConfig(backend="codex_cli", model="gpt-5.4"))
        first_state = self._provider_state_for_thread(original_cfg, "thread-1")
        second_state = self._provider_state_for_thread(original_cfg, "thread-2")

        async def collect() -> None:
            for session_id, cfg, state in (
                (1, original_cfg, first_state),
                (2, original_cfg, second_state),
                (1, changed_cfg, first_state),
                (2, original_cfg, second_state),
            ):
                async for _event in runtime.stream_turn(
                    session_id=session_id,
                    latest_user_message="Continue",
                    system_prompt="System",
                    cfg=cfg,
                    provider_state=state,
                    update_provider_state=None,
                ):
                    pass
            await runtime.close()

        asyncio.run(collect())
        self.assertEqual(len(FakeCodexTransport.instances), 1)
        requests = FakeCodexTransport.instances[0].requests
        self.assertEqual([method for method, _ in requests].count("thread/start"), 1)
        turns = [params for method, params in requests if method == "turn/start"]
        self.assertEqual(
            [turn["threadId"] for turn in turns],
            ["thread-1", "thread-2", "thread-new", "thread-2"],
        )

    def test_global_tool_policy_change_restarts_transport_and_thread(self) -> None:
        runtime = CodexAppServerRuntime(transport_factory=FakeCodexTransport)
        original_cfg = Config(chat=ChatConfig(backend="codex_cli"))
        changed_cfg = Config(chat=ChatConfig(backend="codex_cli", tools=ChatToolsConfig(paper_pdf=False)))
        state = self._provider_state_for_thread(original_cfg, "thread-existing")

        async def collect() -> None:
            for cfg in (original_cfg, changed_cfg):
                async for _event in runtime.stream_turn(
                    session_id=1,
                    latest_user_message="Continue",
                    system_prompt="System",
                    cfg=cfg,
                    provider_state=state,
                    update_provider_state=None,
                ):
                    pass
            await runtime.close()

        asyncio.run(collect())
        self.assertEqual(len(FakeCodexTransport.instances), 2)
        self.assertFalse(FakeCodexTransport.instances[0].alive)
        second_requests = FakeCodexTransport.instances[1].requests
        self.assertIn("thread/start", [method for method, _ in second_requests])
        self.assertNotIn("thread/resume", [method for method, _ in second_requests])

    def test_runtime_drains_transcript_tool_result_before_done(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "thread.jsonl"
            transcript.write_text("", encoding="utf-8")

            class TranscriptCodexTransport(FakeCodexTransport):
                async def request(self, method: str, params: dict | None = None, *, timeout: float = 120.0) -> dict:  # noqa: ARG002
                    self.requests.append((method, params))
                    if method == "initialize":
                        return {}
                    if method == "thread/start":
                        return {"thread": {"id": "thread-new", "path": str(transcript)}}
                    if method == "turn/start":
                        thread_id = params["threadId"]
                        await self.notifications.put({
                            "method": "turn/completed",
                            "params": {"threadId": thread_id, "turn": {"id": "turn-1"}},
                        })

                        async def append_late() -> None:
                            await asyncio.sleep(0.05)
                            with transcript.open("a", encoding="utf-8") as fh:
                                fh.write(json.dumps({"type": "response_item", "item": {"type": "mcp_tool_call_end", "name": "search_web", "output": "late result"}}) + "\n")

                        asyncio.create_task(append_late())
                        return {"turn": {"id": "turn-1"}}
                    raise AssertionError(method)

            runtime = CodexAppServerRuntime(transport_factory=TranscriptCodexTransport)

            async def collect() -> list[dict]:
                events = []
                async for event in runtime.stream_turn(
                    session_id=6,
                    latest_user_message="Hi",
                    system_prompt="System",
                    cfg=Config(),
                    provider_state={},
                    update_provider_state=lambda state: asyncio.sleep(0),
                ):
                    events.append(event)
                await runtime.close()
                return events

            events = asyncio.run(collect())
            self.assertEqual(events[-2], {"name": "search_web", "type": "tool_result", "summary": "late result"})
            self.assertEqual(events[-1]["type"], "done")

    def test_runtime_dedupes_transcript_final_text_after_live_deltas(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "thread.jsonl"
            transcript.write_text("", encoding="utf-8")
            final_text = "Final answer from Codex."
            transcript_text = "Final answer  from Codex.\n"

            class TranscriptCodexTransport(FakeCodexTransport):
                async def request(self, method: str, params: dict | None = None, *, timeout: float = 120.0) -> dict:  # noqa: ARG002
                    self.requests.append((method, params))
                    if method == "initialize":
                        return {}
                    if method == "thread/start":
                        return {"thread": {"id": "thread-new", "path": str(transcript)}}
                    if method == "turn/start":
                        thread_id = params["threadId"]
                        await self.notifications.put({
                            "method": "item/agentMessage/delta",
                            "params": {"threadId": thread_id, "turnId": "turn-1", "delta": "Final answer "},
                        })
                        await self.notifications.put({
                            "method": "item/agentMessage/delta",
                            "params": {"threadId": thread_id, "turnId": "turn-1", "delta": "from Codex."},
                        })

                        async def append_late() -> None:
                            await asyncio.sleep(0.05)
                            with transcript.open("a", encoding="utf-8") as fh:
                                fh.write(json.dumps({"type": "event_msg", "payload": {"type": "agent_message", "message": transcript_text}}) + "\n")
                                fh.write(json.dumps({"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": f"{final_text}\n"}]}}) + "\n")
                            await self.notifications.put({
                                "method": "turn/completed",
                                "params": {"threadId": thread_id, "turn": {"id": "turn-1"}},
                            })

                        asyncio.create_task(append_late())
                        return {"turn": {"id": "turn-1"}}
                    raise AssertionError(method)

            runtime = CodexAppServerRuntime(transport_factory=TranscriptCodexTransport)

            async def collect() -> list[dict]:
                events = []
                async for event in runtime.stream_turn(
                    session_id=9,
                    latest_user_message="Hi",
                    system_prompt="System",
                    cfg=Config(),
                    provider_state={},
                    update_provider_state=lambda state: asyncio.sleep(0),
                ):
                    events.append(event)
                await runtime.close()
                return events

            events = asyncio.run(collect())
            text = "".join(event["content"] for event in events if event.get("type") == "text")
            self.assertEqual(text, final_text)

    def test_runtime_uses_live_only_progress_stream(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "thread.jsonl"
            transcript.write_text("", encoding="utf-8")
            progress = "Inspecting file access pathways\n\nLooking for the right source."
            transcript_only_progress = "This transcript-only reasoning should not be emitted."

            class TranscriptCodexTransport(FakeCodexTransport):
                async def request(self, method: str, params: dict | None = None, *, timeout: float = 120.0) -> dict:  # noqa: ARG002
                    self.requests.append((method, params))
                    if method == "initialize":
                        return {}
                    if method == "thread/start":
                        return {"thread": {"id": "thread-new", "path": str(transcript)}}
                    if method == "turn/start":
                        thread_id = params["threadId"]
                        await self.notifications.put({
                            "method": "item/reasoning/textDelta",
                            "params": {"threadId": thread_id, "turnId": "turn-1", "delta": progress},
                        })

                        async def append_late() -> None:
                            await asyncio.sleep(0.05)
                            with transcript.open("a", encoding="utf-8") as fh:
                                fh.write(json.dumps({"type": "response_item", "item": {"type": "reasoning", "summary": progress}}) + "\n")
                                fh.write(json.dumps({"type": "response_item", "item": {"type": "reasoning", "summary": transcript_only_progress}}) + "\n")
                            await self.notifications.put({
                                "method": "turn/completed",
                                "params": {"threadId": thread_id, "turn": {"id": "turn-1"}},
                            })

                        asyncio.create_task(append_late())
                        return {"turn": {"id": "turn-1"}}
                    raise AssertionError(method)

            runtime = CodexAppServerRuntime(transport_factory=TranscriptCodexTransport)

            async def collect() -> list[dict]:
                events = []
                async for event in runtime.stream_turn(
                    session_id=14,
                    latest_user_message="Hi",
                    system_prompt="System",
                    cfg=Config(),
                    provider_state={},
                    update_provider_state=lambda state: asyncio.sleep(0),
                ):
                    events.append(event)
                await runtime.close()
                return events

            events = asyncio.run(collect())
            self.assertEqual([event["content"] for event in events if event.get("type") == "progress"], [progress])

    def test_runtime_emits_only_transcript_suffix_after_partial_live_delta(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "thread.jsonl"
            transcript.write_text("", encoding="utf-8")
            final_text = "Final answer from Codex."

            class TranscriptCodexTransport(FakeCodexTransport):
                async def request(self, method: str, params: dict | None = None, *, timeout: float = 120.0) -> dict:  # noqa: ARG002
                    self.requests.append((method, params))
                    if method == "initialize":
                        return {}
                    if method == "thread/start":
                        return {"thread": {"id": "thread-new", "path": str(transcript)}}
                    if method == "turn/start":
                        thread_id = params["threadId"]
                        await self.notifications.put({
                            "method": "item/agentMessage/delta",
                            "params": {"threadId": thread_id, "turnId": "turn-1", "delta": "Final answer "},
                        })

                        async def append_late() -> None:
                            await asyncio.sleep(0.05)
                            with transcript.open("a", encoding="utf-8") as fh:
                                fh.write(json.dumps({"type": "event_msg", "payload": {"type": "agent_message", "message": final_text}}) + "\n")
                            await self.notifications.put({"method": "noop", "params": {"threadId": thread_id, "turnId": "turn-1"}})
                            await asyncio.sleep(0.01)
                            await self.notifications.put({
                                "method": "item/agentMessage/delta",
                                "params": {"threadId": thread_id, "turnId": "turn-1", "delta": "from Codex."},
                            })
                            await self.notifications.put({
                                "method": "turn/completed",
                                "params": {"threadId": thread_id, "turn": {"id": "turn-1"}},
                            })

                        asyncio.create_task(append_late())
                        return {"turn": {"id": "turn-1"}}
                    raise AssertionError(method)

            runtime = CodexAppServerRuntime(transport_factory=TranscriptCodexTransport)

            async def collect() -> list[dict]:
                events = []
                async for event in runtime.stream_turn(
                    session_id=10,
                    latest_user_message="Hi",
                    system_prompt="System",
                    cfg=Config(),
                    provider_state={},
                    update_provider_state=lambda state: asyncio.sleep(0),
                ):
                    events.append(event)
                await runtime.close()
                return events

            events = asyncio.run(collect())
            text_events = [event for event in events if event.get("type") == "text"]
            self.assertEqual([event["content"] for event in text_events], ["Final answer ", "from Codex."])
            self.assertEqual("".join(event["content"] for event in text_events), final_text)

    def test_runtime_dedupes_duplicate_transcript_text_shapes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "thread.jsonl"
            transcript.write_text("", encoding="utf-8")
            final_text = "Transcript-only final answer."

            class TranscriptCodexTransport(FakeCodexTransport):
                async def request(self, method: str, params: dict | None = None, *, timeout: float = 120.0) -> dict:  # noqa: ARG002
                    self.requests.append((method, params))
                    if method == "initialize":
                        return {}
                    if method == "thread/start":
                        return {"thread": {"id": "thread-new", "path": str(transcript)}}
                    if method == "turn/start":
                        thread_id = params["threadId"]

                        async def append_late() -> None:
                            await asyncio.sleep(0.05)
                            with transcript.open("a", encoding="utf-8") as fh:
                                fh.write(json.dumps({"type": "event_msg", "payload": {"type": "agent_message", "message": final_text}}) + "\n")
                                fh.write(json.dumps({"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": f"{final_text}\n"}]}}) + "\n")
                            await self.notifications.put({"method": "noop", "params": {"threadId": thread_id, "turnId": "turn-1"}})
                            await self.notifications.put({
                                "method": "turn/completed",
                                "params": {"threadId": thread_id, "turn": {"id": "turn-1"}},
                            })

                        asyncio.create_task(append_late())
                        return {"turn": {"id": "turn-1"}}
                    raise AssertionError(method)

            runtime = CodexAppServerRuntime(transport_factory=TranscriptCodexTransport)

            async def collect() -> list[dict]:
                events = []
                async for event in runtime.stream_turn(
                    session_id=11,
                    latest_user_message="Hi",
                    system_prompt="System",
                    cfg=Config(),
                    provider_state={},
                    update_provider_state=lambda state: asyncio.sleep(0),
                ):
                    events.append(event)
                await runtime.close()
                return events

            events = asyncio.run(collect())
            self.assertEqual([event["content"] for event in events if event.get("type") == "text"], [final_text])

    def test_runtime_suppresses_transcript_body_repeated_after_live_preamble(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "thread.jsonl"
            transcript.write_text("", encoding="utf-8")
            preamble = "Using the local paper/PDF path in the repo data."
            answer = (
                "I read the local PDF. Citations below use PDF page plus local extracted chunk. "
                "The paper argues that activity-weighted multiway enhancer-promoter hubs explain "
                "gene expression changes better than pairwise enhancer-promoter distance alone."
            )

            class TranscriptCodexTransport(FakeCodexTransport):
                async def request(self, method: str, params: dict | None = None, *, timeout: float = 120.0) -> dict:  # noqa: ARG002
                    self.requests.append((method, params))
                    if method == "initialize":
                        return {}
                    if method == "thread/start":
                        return {"thread": {"id": "thread-new", "path": str(transcript)}}
                    if method == "turn/start":
                        thread_id = params["threadId"]
                        await self.notifications.put({
                            "method": "item/agentMessage/delta",
                            "params": {"threadId": thread_id, "turnId": "turn-1", "delta": preamble},
                        })
                        await self.notifications.put({
                            "method": "item/agentMessage/delta",
                            "params": {"threadId": thread_id, "turnId": "turn-1", "delta": answer},
                        })

                        async def append_late() -> None:
                            await asyncio.sleep(0.05)
                            with transcript.open("a", encoding="utf-8") as fh:
                                fh.write(json.dumps({"type": "event_msg", "payload": {"type": "agent_message", "message": answer}}) + "\n")
                            await self.notifications.put({
                                "method": "turn/completed",
                                "params": {"threadId": thread_id, "turn": {"id": "turn-1"}},
                            })

                        asyncio.create_task(append_late())
                        return {"turn": {"id": "turn-1"}}
                    raise AssertionError(method)

            runtime = CodexAppServerRuntime(transport_factory=TranscriptCodexTransport)

            async def collect() -> list[dict]:
                events = []
                async for event in runtime.stream_turn(
                    session_id=13,
                    latest_user_message="Hi",
                    system_prompt="System",
                    cfg=Config(),
                    provider_state={},
                    update_provider_state=lambda state: asyncio.sleep(0),
                ):
                    events.append(event)
                await runtime.close()
                return events

            events = asyncio.run(collect())
            self.assertEqual("".join(event["content"] for event in events if event.get("type") == "text"), preamble + answer)

    def test_runtime_emits_transcript_only_text_without_live_deltas(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "thread.jsonl"
            transcript.write_text("", encoding="utf-8")
            final_text = "Transcript text without live deltas."

            class TranscriptCodexTransport(FakeCodexTransport):
                async def request(self, method: str, params: dict | None = None, *, timeout: float = 120.0) -> dict:  # noqa: ARG002
                    self.requests.append((method, params))
                    if method == "initialize":
                        return {}
                    if method == "thread/start":
                        return {"thread": {"id": "thread-new", "path": str(transcript)}}
                    if method == "turn/start":
                        thread_id = params["threadId"]

                        async def append_late() -> None:
                            await asyncio.sleep(0.05)
                            with transcript.open("a", encoding="utf-8") as fh:
                                fh.write(json.dumps({"type": "event_msg", "payload": {"type": "agent_message", "message": final_text}}) + "\n")
                            await self.notifications.put({"method": "noop", "params": {"threadId": thread_id, "turnId": "turn-1"}})
                            await self.notifications.put({
                                "method": "turn/completed",
                                "params": {"threadId": thread_id, "turn": {"id": "turn-1"}},
                            })

                        asyncio.create_task(append_late())
                        return {"turn": {"id": "turn-1"}}
                    raise AssertionError(method)

            runtime = CodexAppServerRuntime(transport_factory=TranscriptCodexTransport)

            async def collect() -> list[dict]:
                events = []
                async for event in runtime.stream_turn(
                    session_id=12,
                    latest_user_message="Hi",
                    system_prompt="System",
                    cfg=Config(),
                    provider_state={},
                    update_provider_state=lambda state: asyncio.sleep(0),
                ):
                    events.append(event)
                await runtime.close()
                return events

            events = asyncio.run(collect())
            self.assertEqual([event["content"] for event in events if event.get("type") == "text"], [final_text])

    def test_runtime_suppresses_live_tool_events_when_transcript_is_available(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "thread.jsonl"
            transcript.write_text("", encoding="utf-8")

            class TranscriptCodexTransport(FakeCodexTransport):
                async def request(self, method: str, params: dict | None = None, *, timeout: float = 120.0) -> dict:  # noqa: ARG002
                    self.requests.append((method, params))
                    if method == "initialize":
                        return {}
                    if method == "thread/start":
                        return {"thread": {"id": "thread-new", "path": str(transcript)}}
                    if method == "turn/start":
                        thread_id = params["threadId"]
                        with transcript.open("a", encoding="utf-8") as fh:
                            fh.write(json.dumps({"type": "response_item", "item": {"type": "mcp_tool_call", "id": "tool-1", "name": "search_web"}}) + "\n")
                        await self.notifications.put({
                            "method": "item/started",
                            "params": {"threadId": thread_id, "turnId": "turn-1", "item": {"type": "mcp_tool_call", "name": "search_web"}},
                        })
                        await self.notifications.put({
                            "method": "turn/completed",
                            "params": {"threadId": thread_id, "turn": {"id": "turn-1"}},
                        })
                        return {"turn": {"id": "turn-1"}}
                    raise AssertionError(method)

            runtime = CodexAppServerRuntime(transport_factory=TranscriptCodexTransport)

            async def collect() -> list[dict]:
                events = []
                async for event in runtime.stream_turn(
                    session_id=7,
                    latest_user_message="Hi",
                    system_prompt="System",
                    cfg=Config(),
                    provider_state={},
                    update_provider_state=lambda state: asyncio.sleep(0),
                ):
                    events.append(event)
                await runtime.close()
                return events

            events = asyncio.run(collect())
            tool_starts = [event for event in events if event.get("type") == "tool_start"]
            self.assertEqual(tool_starts, [{"name": "search_web", "id": "tool-1", "type": "tool_start"}])

    def test_runtime_uses_live_tool_events_when_transcript_is_missing(self) -> None:
        missing_transcript = "/tmp/claudesk-missing-transcript.jsonl"

        class LiveOnlyCodexTransport(FakeCodexTransport):
            async def request(self, method: str, params: dict | None = None, *, timeout: float = 120.0) -> dict:  # noqa: ARG002
                self.requests.append((method, params))
                if method == "initialize":
                    return {}
                if method == "thread/start":
                    return {"thread": {"id": "thread-new", "path": missing_transcript}}
                if method == "turn/start":
                    thread_id = params["threadId"]
                    await self.notifications.put({
                        "method": "item/started",
                        "params": {"threadId": thread_id, "turnId": "turn-1", "item": {"type": "mcp_tool_call", "name": "search_web"}},
                    })
                    await self.notifications.put({
                        "method": "item/completed",
                        "params": {"threadId": thread_id, "turnId": "turn-1", "item": {"type": "mcp_tool_call", "name": "search_web", "output": "live result"}},
                    })
                    await self.notifications.put({
                        "method": "turn/completed",
                        "params": {"threadId": thread_id, "turn": {"id": "turn-1"}},
                    })
                    return {"turn": {"id": "turn-1"}}
                raise AssertionError(method)

        runtime = CodexAppServerRuntime(transport_factory=LiveOnlyCodexTransport)

        async def collect() -> list[dict]:
            events = []
            async for event in runtime.stream_turn(
                session_id=8,
                latest_user_message="Hi",
                system_prompt="System",
                cfg=Config(),
                provider_state={},
                update_provider_state=lambda state: asyncio.sleep(0),
            ):
                events.append(event)
            await runtime.close()
            return events

        events = asyncio.run(collect())
        self.assertIn({"type": "tool_start", "name": "search_web"}, events)
        self.assertIn({"type": "tool_result", "name": "search_web", "summary": "live result"}, events)

    def test_runtime_interrupts_active_turn_on_cancellation(self) -> None:
        class HangingCodexTransport(FakeCodexTransport):
            async def request(self, method: str, params: dict | None = None, *, timeout: float = 120.0) -> dict:  # noqa: ARG002
                self.requests.append((method, params))
                if method == "initialize":
                    return {}
                if method == "thread/start":
                    return {"thread": {"id": "thread-new", "path": "/tmp/thread-new.jsonl"}}
                if method == "turn/start":
                    return {"turn": {"id": "turn-cancel"}}
                if method == "turn/interrupt":
                    return {"ok": True}
                raise AssertionError(method)

        runtime = CodexAppServerRuntime(transport_factory=HangingCodexTransport)

        async def run_and_cancel() -> list[tuple[str, dict | None]]:
            async def consume() -> None:
                async for _event in runtime.stream_turn(
                    session_id=4,
                    latest_user_message="Cancel me",
                    system_prompt="System",
                    cfg=Config(),
                    provider_state={},
                    update_provider_state=lambda state: asyncio.sleep(0),
                ):
                    pass

            task = asyncio.create_task(consume())
            while not FakeCodexTransport.instances:
                await asyncio.sleep(0)
            transport = FakeCodexTransport.instances[0]
            while not any(method == "turn/start" for method, _ in transport.requests):
                await asyncio.sleep(0)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            requests = transport.requests
            await runtime.close()
            return requests

        requests = asyncio.run(run_and_cancel())
        self.assertIn(("turn/interrupt", {"threadId": "thread-new", "turnId": "turn-cancel"}), requests)
        self.assertNotIn(("turn/abort", {"threadId": "thread-new", "turnId": "turn-cancel"}), requests)

    def test_runtime_falls_back_to_abort_when_interrupt_fails(self) -> None:
        class HangingCodexTransport(FakeCodexTransport):
            async def request(self, method: str, params: dict | None = None, *, timeout: float = 120.0) -> dict:  # noqa: ARG002
                self.requests.append((method, params))
                if method == "initialize":
                    return {}
                if method == "thread/start":
                    return {"thread": {"id": "thread-new", "path": "/tmp/thread-new.jsonl"}}
                if method == "turn/start":
                    return {"turn": {"id": "turn-cancel"}}
                if method == "turn/interrupt":
                    raise RuntimeError("method not found")
                if method == "turn/abort":
                    return {"ok": True}
                raise AssertionError(method)

        runtime = CodexAppServerRuntime(transport_factory=HangingCodexTransport)

        async def run_and_cancel() -> list[tuple[str, dict | None]]:
            async def consume() -> None:
                async for _event in runtime.stream_turn(
                    session_id=5,
                    latest_user_message="Cancel me",
                    system_prompt="System",
                    cfg=Config(),
                    provider_state={},
                    update_provider_state=lambda state: asyncio.sleep(0),
                ):
                    pass

            task = asyncio.create_task(consume())
            while not FakeCodexTransport.instances:
                await asyncio.sleep(0)
            transport = FakeCodexTransport.instances[0]
            while not any(method == "turn/start" for method, _ in transport.requests):
                await asyncio.sleep(0)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            requests = transport.requests
            await runtime.close()
            return requests

        requests = asyncio.run(run_and_cancel())
        payload = {"threadId": "thread-new", "turnId": "turn-cancel"}
        self.assertIn(("turn/interrupt", payload), requests)
        self.assertIn(("turn/abort", payload), requests)

    def test_stream_backend_surfaces_app_server_failure(self) -> None:
        class FailingRuntime:
            async def stream_turn(self, **kwargs):  # noqa: ARG002
                raise RuntimeError("boom")
                yield  # pragma: no cover

        async def collect() -> list[dict]:
            events = []
            async for event in stream_codex_provider_turn(ProviderTurnRequest(
                messages=[{"role": "system", "content": "System"}, {"role": "user", "content": "Hi"}],
                cfg=Config(chat=ChatConfig(backend="codex_cli")),
                session_id=1,
                turn_id="chat-turn-runtime",
                provider_state={},
                update_provider_state=None,
            )):
                events.append(event)
            return events

        with (
            patch("claudesk.agent.codex_runtime._codex_runtime", FailingRuntime()),
            patch("claudesk.agent.codex_runtime.logger.exception"),
        ):
            events = asyncio.run(collect())

        self.assertEqual(events[-1], {"type": "done", "finish_reason": "stop"})
        self.assertIn("Codex app-server error", events[0]["content"])

    def test_stream_backend_sends_conversation_prompt_to_codex_runtime(self) -> None:
        captured: dict = {}

        class CapturingRuntime:
            async def stream_turn(self, **kwargs):
                captured.update(kwargs)
                yield {"type": "text", "content": "Abstract summary."}
                yield {"type": "done", "finish_reason": "stop"}

        messages = [
            {"role": "system", "content": "System"},
            {"role": "user", "content": "summarize Tagged Paper (paper id 109)"},
            {
                "role": "assistant",
                "content": (
                    "I cannot read the local PDF for paper 109 because no PDF is attached. "
                    "Do you want me to summarize the available abstract?"
                ),
            },
            {"role": "user", "content": "Yes, please"},
        ]

        async def collect() -> list[dict]:
            events = []
            async for event in stream_codex_provider_turn(ProviderTurnRequest(
                messages=messages,
                cfg=Config(chat=ChatConfig(backend="codex_cli")),
                session_id=1,
                turn_id="chat-turn-runtime",
                provider_state={},
                update_provider_state=None,
            )):
                events.append(event)
            return events

        with patch("claudesk.agent.codex_runtime._codex_runtime", CapturingRuntime()):
            events = asyncio.run(collect())

        self.assertEqual(events[0]["content"], "Abstract summary.")
        prompt = captured["latest_user_message"]
        self.assertIn("Conversation history for context", prompt)
        self.assertIn("paper 109", prompt)
        self.assertIn("Latest user message:\nYes, please", prompt)
        self.assertEqual(captured["ledger_turn_id"], "chat-turn-runtime")

    def test_stream_backend_adds_codex_required_tool_guardrail(self) -> None:
        captured: dict = {}

        class CapturingRuntime:
            async def stream_turn(self, **kwargs):
                captured.update(kwargs)
                yield {"type": "text", "content": "PDF answer."}
                yield {"type": "done", "finish_reason": "stop"}

        async def collect() -> list[dict]:
            events = []
            async for event in stream_codex_provider_turn(ProviderTurnRequest(
                messages=[{"role": "system", "content": "System"}, {"role": "user", "content": "Read the attached PDF"}],
                cfg=Config(chat=ChatConfig(backend="codex_cli")),
                session_id=1,
                provider_state={},
                update_provider_state=None,
                required_capabilities=set(PAPER_PDF_CAPABILITY_NAMES),
            )):
                events.append(event)
            return events

        with patch("claudesk.agent.codex_runtime._codex_runtime", CapturingRuntime()):
            events = asyncio.run(collect())

        self.assertEqual(events[0]["content"], "PDF answer.")
        prompt = captured["latest_user_message"]
        self.assertTrue(prompt.startswith("Codex research-mode requirements for this turn:"))
        self.assertIn("Required Claudesk MCP tools: list_paper_assets", prompt)
        self.assertIn("read_paper_pdf", prompt)
        self.assertNotIn("already verified these required MCP tools", prompt)
        self.assertIn("mcp__claudesk__read_paper_pdf", prompt)
        self.assertNotIn("or not listed", prompt)
        self.assertEqual(captured["required_capabilities"], set(PAPER_PDF_CAPABILITY_NAMES))

    def test_stream_backend_adds_required_library_tool_guardrail(self) -> None:
        captured: dict = {}

        class CapturingRuntime:
            async def stream_turn(self, **kwargs):
                captured.update(kwargs)
                yield {"type": "text", "content": "Library answer."}
                yield {"type": "done", "finish_reason": "stop"}

        async def collect() -> list[dict]:
            events = []
            async for event in stream_codex_provider_turn(ProviderTurnRequest(
                messages=[{"role": "system", "content": "System"}, {"role": "user", "content": "List papers"}],
                cfg=Config(chat=ChatConfig(backend="codex_cli")),
                session_id=1,
                provider_state={},
                update_provider_state=None,
                required_capabilities={"list_recent_papers"},
            )):
                events.append(event)
            return events

        with patch("claudesk.agent.codex_runtime._codex_runtime", CapturingRuntime()):
            events = asyncio.run(collect())

        self.assertEqual(events[0]["content"], "Library answer.")
        prompt = captured["latest_user_message"]
        self.assertTrue(prompt.startswith("Codex research-mode requirements for this turn:"))
        self.assertIn("Required Claudesk MCP tools: list_recent_papers", prompt)
        self.assertIn("mcp__claudesk__list_recent_papers", prompt)
        self.assertNotIn("already verified these required MCP tools", prompt)
        self.assertNotIn("local managed PDF content", prompt)
        self.assertEqual(captured["required_capabilities"], {"list_recent_papers"})

    def test_stream_backend_names_required_lookup_tool_alias(self) -> None:
        captured: dict = {}

        class CapturingRuntime:
            async def stream_turn(self, **kwargs):
                captured.update(kwargs)
                yield {"type": "text", "content": "Lookup answer."}
                yield {"type": "done", "finish_reason": "stop"}

        async def collect() -> list[dict]:
            events = []
            async for event in stream_codex_provider_turn(ProviderTurnRequest(
                messages=[{"role": "system", "content": "System"}, {"role": "user", "content": "What is its title?"}],
                cfg=Config(chat=ChatConfig(backend="codex_cli")),
                session_id=1,
                provider_state={},
                update_provider_state=None,
                required_capabilities={"get_papers_by_ids"},
            )):
                events.append(event)
            return events

        with patch("claudesk.agent.codex_runtime._codex_runtime", CapturingRuntime()):
            events = asyncio.run(collect())

        self.assertEqual(events[0]["content"], "Lookup answer.")
        prompt = captured["latest_user_message"]
        self.assertIn("get_papers_by_ids", prompt)
        self.assertIn("mcp__claudesk__get_papers_by_ids", prompt)
        self.assertNotIn("already verified these required MCP tools", prompt)
        self.assertEqual(captured["required_capabilities"], {"get_papers_by_ids"})


@unittest.skipUnless(os.environ.get("CLAUDESK_CODEX_SMOKE") == "1", "Set CLAUDESK_CODEX_SMOKE=1 to run the real Codex app-server smoke test.")
class CodexAppServerSmokeTests(unittest.TestCase):
    def test_real_app_server_lists_models_without_starting_a_thread(self) -> None:
        if shutil.which("codex") is None:
            self.skipTest("codex CLI is not on PATH")

        async def run_smoke() -> list[dict]:
            with tempfile.TemporaryDirectory() as tmp, patched_data_dir(tmp):
                runtime = CodexAppServerRuntime()
                try:
                    result = await runtime.list_models(Config(chat=ChatConfig(backend="codex_cli")))
                    self.assertEqual(runtime._loaded_threads, {})
                    return result
                finally:
                    await runtime.close()

        models = asyncio.run(run_smoke())
        self.assertTrue(models)
        self.assertTrue(all(model["id"] and model["label"] for model in models))
        self.assertTrue(any(model["selectable"] for model in models))

    def test_real_app_server_loads_claudesk_mcp_tools(self) -> None:
        if shutil.which("codex") is None:
            self.skipTest("codex CLI is not on PATH")

        async def run_smoke() -> dict:
            with tempfile.TemporaryDirectory(dir=str(project_root())) as tmp:
                home = Path(tmp) / "home"
                home.mkdir()
                codex_home = os.environ.get("CODEX_HOME") or str(Path.home() / ".codex")
                cfg = Config(chat=ChatConfig(backend="codex_cli"))
                registry_tools = get_capability_registry().enabled_names(cfg.chat.tools)
                direct_tools = {tool.name for tool in mcp_tools(cfg.chat.tools)}
                transport = JsonlRpcTransport(
                    build_codex_app_server_command(cfg),
                    cwd=codex_chat_cwd(),
                    env={
                        "CODEX_HOME": codex_home,
                        "HOME": str(home),
                    },
                )
                try:
                    await transport.start()
                    await transport.request(
                        "initialize",
                        {
                            "clientInfo": {"name": "claudesk-test", "version": __version__},
                            "capabilities": {"experimentalApi": True},
                        },
                        timeout=15.0,
                    )
                    await transport.notify("initialized")
                    thread_response = await transport.request(
                        "thread/start",
                        codex_thread_params("Claudesk Codex smoke test.", cfg),
                        timeout=20.0,
                    )
                    thread = thread_response.get("thread") if isinstance(thread_response.get("thread"), dict) else {}
                    thread_id = str(thread.get("id") or "")
                    status = await transport.request("mcpServerStatus/list", {"detail": "toolsAndAuthOnly"}, timeout=20.0)
                    codex_tools = _mcp_status_tool_names(status)
                    call = await transport.request(
                        "mcpServer/tool/call",
                        {
                            "server": "claudesk",
                            "threadId": thread_id,
                            "tool": "list_recent_papers",
                            "arguments": {"days": 1},
                        },
                        timeout=20.0,
                    )
                    return {
                        "call": call,
                        "codex_tools": sorted(codex_tools),
                        "direct_tools": sorted(direct_tools),
                        "registry_tools": sorted(registry_tools),
                        "status": status,
                    }
                finally:
                    await transport.close()

        result = asyncio.run(run_smoke())
        registry_tools = set(result["registry_tools"])
        direct_tools = set(result["direct_tools"])
        codex_tools = set(result["codex_tools"])
        target_tools = set(PAPER_PDF_CAPABILITY_NAMES) | set(NOTE_WRITE_CAPABILITY_NAMES)
        self.assertEqual(direct_tools, registry_tools)
        self.assertTrue(target_tools.issubset(registry_tools))
        self.assertFalse(target_tools - codex_tools)
        self.assertFalse(registry_tools - codex_tools)
        self.assertIn("content", result["call"])


if __name__ == "__main__":
    unittest.main()
