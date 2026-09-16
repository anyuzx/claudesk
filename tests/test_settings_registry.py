"""Tests for the schema-driven settings registry (Slice 1)."""
from __future__ import annotations

import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import yaml
from fastapi import HTTPException
from pydantic import ValidationError
from typer.testing import CliRunner


class _MiniResponse:
    def __init__(self, status_code: int, payload) -> None:
        self.status_code = status_code
        self._payload = payload
        self.text = str(payload)

    def json(self):
        return self._payload


class _SettingsClient:
    def __init__(self, settings_mod) -> None:
        self.settings_mod = settings_mod

    def get(self, path: str) -> _MiniResponse:
        if path == "/api/settings/vault":
            payload = self.settings_mod.get_vault_settings()
            if hasattr(payload, "model_dump"):
                payload = payload.model_dump()
            return _MiniResponse(200, payload)
        if path != "/api/settings":
            return _MiniResponse(404, {"detail": "Not found"})
        return _MiniResponse(200, self.settings_mod.get_settings())

    def patch(self, path: str, json: dict) -> _MiniResponse:
        if path == "/api/settings/vault":
            try:
                body = self.settings_mod.VaultPathRequest.model_validate(json)
                payload = self.settings_mod.patch_vault_settings(body)
                if hasattr(payload, "model_dump"):
                    payload = payload.model_dump()
                return _MiniResponse(200, payload)
            except HTTPException as exc:
                return _MiniResponse(exc.status_code, {"detail": exc.detail})
            except ValidationError as exc:
                return _MiniResponse(422, {"detail": exc.errors()})
        if path != "/api/settings":
            return _MiniResponse(404, {"detail": "Not found"})
        try:
            body = self.settings_mod.SettingsPatchRequest.model_validate(json)
            return _MiniResponse(200, self.settings_mod.patch_settings(body))
        except HTTPException as exc:
            return _MiniResponse(exc.status_code, {"detail": exc.detail})
        except ValidationError as exc:
            return _MiniResponse(422, {"detail": exc.errors()})

    def post(self, path: str, json: dict | None = None) -> _MiniResponse:
        if path == "/api/settings/vault/preview":
            try:
                body = self.settings_mod.VaultPathRequest.model_validate(json or {})
                payload = self.settings_mod.preview_vault_settings(body)
                if hasattr(payload, "model_dump"):
                    payload = payload.model_dump()
                return _MiniResponse(200, payload)
            except HTTPException as exc:
                return _MiniResponse(exc.status_code, {"detail": exc.detail})
            except ValidationError as exc:
                return _MiniResponse(422, {"detail": exc.errors()})
        if path == "/api/settings/pubmed/preview":
            try:
                body = self.settings_mod.SettingsPatchRequest.model_validate(json or {})
                payload = self.settings_mod.preview_pubmed_settings(body)
                if hasattr(payload, "model_dump"):
                    payload = payload.model_dump()
                return _MiniResponse(200, payload)
            except HTTPException as exc:
                return _MiniResponse(exc.status_code, {"detail": exc.detail})
            except ValidationError as exc:
                return _MiniResponse(422, {"detail": exc.errors()})
        if path != "/api/settings/pick-directory":
            return _MiniResponse(404, {"detail": "Not found"})
        try:
            body = self.settings_mod.DirectoryPickRequest.model_validate(json) if json is not None else None
            payload = self.settings_mod.pick_settings_directory(body)
            if hasattr(payload, "model_dump"):
                payload = payload.model_dump()
            return _MiniResponse(200, payload)
        except HTTPException as exc:
            return _MiniResponse(exc.status_code, {"detail": exc.detail})


def _make_app_with_isolated_data():
    """Spin up the FastAPI app pointed at a temp data dir.

    The api modules import claudesk.api.deps which initializes the SQLite DB
    at import time, so we set CLAUDESK_DATA_DIR before importing.
    """
    tmpdir = tempfile.mkdtemp(prefix="claudesk-settings-")
    os.environ["CLAUDESK_DATA_DIR"] = tmpdir
    os.environ["CLAUDESK_LOCAL_CONFIG"] = str(Path(tmpdir) / "local.yaml")
    # Force a fresh import so the data_dir() resolves under tmpdir.
    import importlib
    import claudesk.core.config as cfg_mod; importlib.reload(cfg_mod)
    import claudesk.api.settings_registry as reg_mod; importlib.reload(reg_mod)
    # The app has a module-level FastAPI() that already imported settings_registry
    # under the original data_dir; reload main to repoint everything cleanly.
    from claudesk.api import settings as settings_mod, main as main_mod
    importlib.reload(settings_mod)
    importlib.reload(main_mod)
    return _SettingsClient(settings_mod), tmpdir, cfg_mod


class SettingsRegistryHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client, cls.tmpdir, cls.cfg_mod = _make_app_with_isolated_data()

    def _post_pick_directory(self, selected: str | None, *, key: str | None = None) -> _MiniResponse:
        original = self.client.settings_mod.pick_directory_dialog
        self.client.settings_mod.pick_directory_dialog = lambda: selected
        try:
            body = {"key": key} if key is not None else None
            return self.client.post("/api/settings/pick-directory", json=body)
        finally:
            self.client.settings_mod.pick_directory_dialog = original

    def test_get_settings_returns_schema_values_groups(self) -> None:
        r = self.client.get("/api/settings")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertIn("schema", body)
        self.assertIn("values", body)
        self.assertIn("groups", body)
        keys = {item["key"] for item in body["schema"]}
        # Sample writable fields are present
        for k in (
            "profile.name",
            "profile.field",
            "topics",
            "digest.days_back",
            "sources.arxiv.enabled",
            "llm.scoring_system_prompt",
            "chat.backend",
            "chat.tools.paper_pdf",
            "chat.tools.task_write",
            "chat.tools.project_write",
            "chat.tools.log_write",
            "chat.tools.note_write",
            "chat.tools.paper_collection_write",
            "chat.tools.paper_ingest",
            "chat.tools.paper_asset_write",
            "paper_assets.pdf_parser",
            "ui.theme_mode",
        ):
            self.assertIn(k, keys, f"missing writable key {k}")
        for k in (
            "chat.tools.add_task",
            "chat.tools.add_log_entry",
            "chat.tools.update_paper_note",
            "chat.tools.complete_task",
        ):
            self.assertNotIn(k, keys, f"retired chat tool key {k} is still exposed")
        # Excluded api-key fields are NOT present
        for k in ("llm.api_key", "sources.openalex.api_key", "sources.pubmed.api_key"):
            self.assertNotIn(k, keys, f"secret key {k} leaked into schema")
        # Values mirror keys
        for item in body["schema"]:
            self.assertIn(item["key"], body["values"], f"value missing for {item['key']}")
        # Each schema item carries the registry metadata
        for item in body["schema"]:
            for prop in ("key", "label", "group", "widget", "restart", "order"):
                self.assertIn(prop, item)

    def test_pubmed_strategy_fields_are_writable_non_secret_settings(self) -> None:
        r = self.client.get("/api/settings")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        schema_by_key = {item["key"]: item for item in body["schema"]}

        for key in (
            "sources.pubmed.enabled",
            "sources.pubmed.query_mode",
            "sources.pubmed.concepts",
            "sources.pubmed.concept_scope",
            "sources.pubmed.exclude_terms",
            "sources.pubmed.search_terms",
        ):
            self.assertIn(key, schema_by_key)
            self.assertFalse(schema_by_key[key]["restart"])
            self.assertEqual(schema_by_key[key]["group"], "sources")

        self.assertEqual(schema_by_key["sources.pubmed.query_mode"]["widget"], "select")
        self.assertEqual(
            schema_by_key["sources.pubmed.query_mode"]["options"],
            [
                {"value": "auto", "label": "Auto from Topics & filters"},
                {"value": "builder", "label": "Custom PubMed builder"},
                {"value": "raw", "label": "Advanced raw PubMed query"},
            ],
        )
        self.assertEqual(schema_by_key["sources.pubmed.concepts"]["widget"], "tags")
        self.assertEqual(schema_by_key["sources.pubmed.exclude_terms"]["widget"], "tags")
        self.assertEqual(schema_by_key["sources.pubmed.search_terms"]["widget"], "tags")
        self.assertNotIn("sources.pubmed.api_key", schema_by_key)

    def test_legacy_pubmed_search_terms_round_trip_without_loss(self) -> None:
        yaml_path = os.path.join(self.tmpdir, "interests.yaml")
        with open(yaml_path, "w") as f:
            yaml.safe_dump(
                {
                    "sources": {
                        "pubmed": {
                            "enabled": True,
                            "search_terms": ["biophysics[MeSH]"],
                        }
                    }
                },
                f,
                sort_keys=False,
            )
        self.cfg_mod.load_config.cache_clear()

        r = self.client.get("/api/settings")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["values"]["sources.pubmed.query_mode"], "raw")
        self.assertEqual(r.json()["values"]["sources.pubmed.search_terms"], ["biophysics[MeSH]"])

        patched = self.client.patch(
            "/api/settings",
            json={"patches": [{"key": "sources.pubmed.enabled", "value": False}]},
        )
        self.assertEqual(patched.status_code, 200, patched.text)
        self.assertEqual(patched.json()["values"]["sources.pubmed.query_mode"], "raw")
        self.assertEqual(patched.json()["values"]["sources.pubmed.search_terms"], ["biophysics[MeSH]"])

        with open(yaml_path) as f:
            data = yaml.safe_load(f)
        self.assertEqual(data["sources"]["pubmed"]["query_mode"], "raw")
        self.assertEqual(data["sources"]["pubmed"]["search_terms"], ["biophysics[MeSH]"])

    def test_pubmed_preview_validates_draft_and_does_not_write_config(self) -> None:
        yaml_path = os.path.join(self.tmpdir, "interests.yaml")
        with open(yaml_path, "w") as f:
            yaml.safe_dump(
                {
                    "topics": ["chromatin"],
                    "keywords": {
                        "include": ["nucleosome"],
                        "exclude": ["clinical trial"],
                    },
                    "profile": {"field": ["Biophysics"]},
                    "sources": {"pubmed": {"enabled": True}},
                },
                f,
                sort_keys=False,
            )
        before = Path(yaml_path).read_text(encoding="utf-8")
        self.cfg_mod.load_config.cache_clear()

        r = self.client.post(
            "/api/settings/pubmed/preview",
            json={
                "patches": [
                    {"key": "sources.pubmed.query_mode", "value": "builder"},
                    {"key": "sources.pubmed.concepts", "value": ["optical tweezers"]},
                    {"key": "sources.pubmed.concept_scope", "value": "title_abstract"},
                    {"key": "sources.pubmed.exclude_terms", "value": ["case report"]},
                ]
            },
        )
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["query_mode"], "builder")
        self.assertEqual(
            body["query"],
            '"optical tweezers"[Title/Abstract] AND NOT "case report"[Title/Abstract]',
        )
        self.assertFalse(body["empty"])
        self.assertEqual(body["length_status"], "ok")
        self.assertIsNone(body["warning"])
        self.assertEqual(body["chunk_count"], 1)
        self.assertGreater(body["encoded_request_length"], 0)
        self.assertEqual(Path(yaml_path).read_text(encoding="utf-8"), before)

        auto = self.client.post("/api/settings/pubmed/preview", json={"patches": []})
        self.assertEqual(auto.status_code, 200, auto.text)
        self.assertEqual(auto.json()["query_mode"], "auto")
        self.assertIn('"chromatin"[Title/Abstract]', auto.json()["query"])
        self.assertIn('"nucleosome"[MeSH Terms]', auto.json()["query"])
        self.assertIn('AND NOT ("clinical trial"[Title/Abstract]', auto.json()["query"])

        disabled = self.client.post(
            "/api/settings/pubmed/preview",
            json={"patches": [{"key": "sources.pubmed.enabled", "value": False}]},
        )
        self.assertEqual(disabled.status_code, 200, disabled.text)
        self.assertEqual(disabled.json()["query_mode"], "auto")
        self.assertFalse(disabled.json()["empty"])
        self.assertIn('"chromatin"[Title/Abstract]', disabled.json()["query"])

    def test_pubmed_preview_reports_long_generated_query_metadata(self) -> None:
        yaml_path = os.path.join(self.tmpdir, "interests.yaml")
        with open(yaml_path, "w") as f:
            yaml.safe_dump(
                {
                    "topics": [
                        "chromatin remodeling mechanics",
                        "single molecule force spectroscopy",
                        "polymer condensate rheology",
                        "active chromatin microrheology",
                    ],
                    "keywords": {
                        "include": ["optical tweezer nucleosome mechanics"],
                        "exclude": ["clinical trial", "case report"],
                    },
                    "profile": {"field": []},
                    "sources": {"pubmed": {"enabled": True}},
                },
                f,
                sort_keys=False,
            )
        self.cfg_mod.load_config.cache_clear()

        with patch("claudesk.sources.pubmed.ESEARCH_SAFE_URL_LENGTH", 430):
            response = self.client.post("/api/settings/pubmed/preview", json={"patches": []})

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["query_mode"], "auto")
        self.assertFalse(body["empty"])
        self.assertEqual(body["length_status"], "too_long")
        self.assertGreater(body["encoded_request_length"], 430)
        self.assertGreater(body["chunk_count"], 1)
        self.assertIn("Generated PubMed ESearch request is long", body["warning"])
        self.assertIn('"clinical trial"[Title/Abstract]', body["query"])

    def test_pubmed_preview_rejects_invalid_input(self) -> None:
        invalid_value = self.client.post(
            "/api/settings/pubmed/preview",
            json={"patches": [{"key": "sources.pubmed.query_mode", "value": "simple"}]},
        )
        self.assertEqual(invalid_value.status_code, 422, invalid_value.text)

        invalid_key = self.client.post(
            "/api/settings/pubmed/preview",
            json={"patches": [{"key": "sources.pubmed.api_key", "value": "secret"}]},
        )
        self.assertEqual(invalid_key.status_code, 400, invalid_key.text)

    def test_ui_theme_mode_is_backend_synced_choice(self) -> None:
        self.assertEqual(self.cfg_mod.Config().ui.theme_mode, "light")
        reset = self.client.patch(
            "/api/settings",
            json={"patches": [{"key": "ui.theme_mode", "value": "light"}]},
        )
        self.assertEqual(reset.status_code, 200, reset.text)

        r = self.client.get("/api/settings")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        field = next(item for item in body["schema"] if item["key"] == "ui.theme_mode")
        self.assertEqual(field["label"], "Theme mode")
        self.assertEqual(field["group"], "ui")
        self.assertEqual(field["widget"], "select")
        self.assertFalse(field["restart"])
        self.assertEqual(body["values"]["ui.theme_mode"], "light")
        self.assertEqual(
            field["options"],
            [
                {"value": "light", "label": "Light"},
                {"value": "dark", "label": "Dark"},
                {"value": "system", "label": "System"},
            ],
        )

        r = self.client.patch(
            "/api/settings",
            json={"patches": [{"key": "ui.theme_mode", "value": "system"}]},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["values"]["ui.theme_mode"], "system")

        yaml_path = os.path.join(self.tmpdir, "interests.yaml")
        with open(yaml_path) as f:
            data = yaml.safe_load(f)
        self.assertEqual(data["ui"]["theme_mode"], "system")

    def test_ui_theme_mode_rejects_unknown_value(self) -> None:
        reset = self.client.patch(
            "/api/settings",
            json={"patches": [{"key": "ui.theme_mode", "value": "light"}]},
        )
        self.assertEqual(reset.status_code, 200, reset.text)

        r = self.client.patch(
            "/api/settings",
            json={"patches": [{"key": "ui.theme_mode", "value": "sepia"}]},
        )
        self.assertEqual(r.status_code, 422, r.text)

    def test_profile_field_is_tags_metadata(self) -> None:
        r = self.client.get("/api/settings")
        self.assertEqual(r.status_code, 200, r.text)
        field = next(item for item in r.json()["schema"] if item["key"] == "profile.field")
        self.assertEqual(field["label"], "Research fields")
        self.assertEqual(field["group"], "profile")
        self.assertEqual(field["widget"], "tags")
        self.assertFalse(field["restart"])
        self.assertIn("research context", field["help"])

    def test_legacy_profile_field_string_loads_as_tag_list(self) -> None:
        yaml_path = os.path.join(self.tmpdir, "interests.yaml")
        with open(yaml_path, "w") as f:
            yaml.safe_dump(
                {
                    "profile": {
                        "name": "Test Researcher",
                        "field": "biology",
                        "description": "Studies cell mechanics.",
                    }
                },
                f,
                sort_keys=False,
            )
        self.cfg_mod.load_config.cache_clear()

        r = self.client.get("/api/settings")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["values"]["profile.field"], ["biology"])

    def test_profile_field_tags_round_trip_and_persist_as_list(self) -> None:
        fields = ["biology", "biophysics"]
        r = self.client.patch(
            "/api/settings",
            json={"patches": [{"key": "profile.field", "value": fields}]},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["values"]["profile.field"], fields)

        yaml_path = os.path.join(self.tmpdir, "interests.yaml")
        with open(yaml_path) as f:
            data = yaml.safe_load(f)
        self.assertEqual(data["profile"]["field"], fields)

    def test_profile_field_rejects_non_string_list_items(self) -> None:
        r = self.client.patch(
            "/api/settings",
            json={"patches": [{"key": "profile.field", "value": ["biology", 12]}]},
        )
        self.assertEqual(r.status_code, 422, r.text)

    def test_profile_context_text_formats_multiple_fields(self) -> None:
        profile = self.cfg_mod.Profile(
            field=["biophysics", "chromatin biology", "single-molecule methods"],
            description="Studies mechanics.",
        )
        self.assertEqual(
            profile.field_text(),
            "biophysics, chromatin biology, and single-molecule methods",
        )
        self.assertEqual(
            profile.context_text(),
            "biophysics, chromatin biology, and single-molecule methods: Studies mechanics.",
        )
        self.assertEqual(self.cfg_mod.Profile(field=[]).context_text(), "research")

    def test_scoring_context_uses_profile_context_text(self) -> None:
        from claudesk.jobs.run_rubric_scoring import _interests_context, _profile_text
        from claudesk.pipeline.rank import _format_interests_context

        cfg = self.cfg_mod.Config(
            profile=self.cfg_mod.Profile(
                field=["biophysics", "chromatin biology"],
                description="Studies cell mechanics.",
            ),
            topics=["chromatin mechanics"],
            keywords=self.cfg_mod.Keywords(include=["optical tweezers"]),
            tracked_authors=["Dekker"],
        )
        profile = _profile_text(cfg)
        self.assertEqual(profile, "biophysics and chromatin biology: Studies cell mechanics.")

        for context in (
            _format_interests_context(cfg, profile),
            _interests_context(cfg, profile),
        ):
            self.assertIn("Profile: biophysics and chromatin biology: Studies cell mechanics.", context)
            self.assertIn("Topics: chromatin mechanics", context)
            self.assertIn("Include keywords: optical tweezers", context)
            self.assertIn("Tracked authors: Dekker", context)
            self.assertNotIn("['", context)

    def test_patch_updates_a_writable_field(self) -> None:
        r = self.client.patch(
            "/api/settings",
            json={"patches": [{"key": "digest.days_back", "value": 9}]},
        )
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["values"]["digest.days_back"], 9)
        # Verify the on-disk yaml actually changed
        yaml_path = os.path.join(self.tmpdir, "interests.yaml")
        with open(yaml_path) as f:
            data = yaml.safe_load(f)
        self.assertEqual(data["digest"]["days_back"], 9)

    def test_concurrent_patches_are_serialized_across_full_file_rewrite(self) -> None:
        import claudesk.api.settings_registry as reg_mod

        original_load_config_file = reg_mod.load_config_file
        counter_lock = threading.Lock()
        start = threading.Barrier(3)
        errors: list[BaseException] = []
        active_loads = 0
        max_active_loads = 0

        def delayed_load_config_file(*args, **kwargs):
            nonlocal active_loads, max_active_loads
            with counter_lock:
                active_loads += 1
                max_active_loads = max(max_active_loads, active_loads)
            try:
                time.sleep(0.05)
                return original_load_config_file(*args, **kwargs)
            finally:
                with counter_lock:
                    active_loads -= 1

        def patch_setting(key: str, value: object) -> None:
            try:
                start.wait(timeout=2)
                reg_mod.apply_patches([{"key": key, "value": value}])
            except BaseException as exc:  # pragma: no cover - assertion path
                errors.append(exc)

        with patch.object(reg_mod, "load_config_file", delayed_load_config_file):
            threads = [
                threading.Thread(target=patch_setting, args=("digest.days_back", 17)),
                threading.Thread(target=patch_setting, args=("digest.top_n", 23)),
            ]
            for thread in threads:
                thread.start()
            start.wait(timeout=2)
            for thread in threads:
                thread.join(timeout=3)

        for thread in threads:
            self.assertFalse(thread.is_alive(), "settings patch thread did not finish")
        if errors:
            self.fail(f"concurrent settings patch failed: {errors!r}")
        self.assertEqual(max_active_loads, 1)

        yaml_path = os.path.join(self.tmpdir, "interests.yaml")
        with open(yaml_path) as f:
            data = yaml.safe_load(f)
        self.assertEqual(data["digest"]["days_back"], 17)
        self.assertEqual(data["digest"]["top_n"], 23)

    def test_patch_rejects_invalid_type(self) -> None:
        r = self.client.patch(
            "/api/settings",
            json={"patches": [{"key": "digest.days_back", "value": "not-an-int"}]},
        )
        self.assertEqual(r.status_code, 422, r.text)

    def test_patch_rejects_excluded_or_unknown_key(self) -> None:
        for bad_key in ("llm.api_key", "no.such.field"):
            r = self.client.patch(
                "/api/settings",
                json={"patches": [{"key": bad_key, "value": "x"}]},
            )
            self.assertEqual(r.status_code, 400, f"{bad_key}: {r.text}")

    def test_patch_on_restart_no_field_busts_load_config_cache(self) -> None:
        # Prime the cache
        cached_before = self.cfg_mod.load_config()
        # Patch a restart=False field
        r = self.client.patch(
            "/api/settings",
            json={"patches": [{"key": "topics", "value": ["chromatin", "polymer"]}]},
        )
        self.assertEqual(r.status_code, 200, r.text)
        # Cache must have been invalidated; next call returns a fresh object
        cached_after = self.cfg_mod.load_config()
        self.assertEqual(cached_after.topics, ["chromatin", "polymer"])
        # The cached_before snapshot is stale; that is the contract — we
        # do not require cached_before is not cached_after, only that the
        # subsequent load returns the new values.

    def test_patch_preserves_tags_insertion_order(self) -> None:
        ordered = ["epsilon", "alpha", "delta", "beta"]
        r = self.client.patch(
            "/api/settings",
            json={"patches": [{"key": "keywords.include", "value": ordered}]},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["values"]["keywords.include"], ordered)

    def test_patch_can_replace_seed_papers_list(self) -> None:
        seeds = [
            {"id": "10.1234/foo", "source": "doi", "note": "anchor"},
            {"id": "10.5678/bar", "source": "doi", "note": ""},
        ]
        r = self.client.patch(
            "/api/settings",
            json={"patches": [{"key": "seed_papers", "value": seeds}]},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["values"]["seed_papers"], seeds)

    def test_patch_can_replace_scoring_system_prompt(self) -> None:
        prompt = "Score papers with a strict rubric."
        r = self.client.patch(
            "/api/settings",
            json={"patches": [{"key": "llm.scoring_system_prompt", "value": prompt}]},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["values"]["llm.scoring_system_prompt"], prompt)

    def test_chat_backend_select_round_trips(self) -> None:
        r = self.client.get("/api/settings")
        self.assertEqual(r.status_code, 200, r.text)
        backend_field = next(item for item in r.json()["schema"] if item["key"] == "chat.backend")
        self.assertEqual(backend_field["widget"], "select")
        self.assertIn("options", backend_field)

        r = self.client.patch(
            "/api/settings",
            json={"patches": [{"key": "chat.backend", "value": "gemini_api"}]},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["values"]["chat.backend"], "gemini_api")

    def test_codex_native_capability_toggles_round_trip(self) -> None:
        self.assertFalse(self.cfg_mod.Config().chat.codex_native_shell_tools)
        self.assertFalse(self.cfg_mod.Config().chat.codex_native_web_search)
        self.assertFalse(self.cfg_mod.Config().chat.codex_native_image_view)
        self.assertFalse(self.cfg_mod.Config().chat.codex_native_network_access)

        r = self.client.get("/api/settings")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        expected = {
            "chat.codex_native_shell_tools": "Codex native shell/file tools",
            "chat.codex_native_web_search": "Codex native web search",
            "chat.codex_native_image_view": "Codex native image view",
            "chat.codex_native_network_access": "Codex native internet access",
        }
        fields = {item["key"]: item for item in body["schema"]}
        for key, label in expected.items():
            with self.subTest(key=key):
                field = fields[key]
                self.assertEqual(field["label"], label)
                self.assertEqual(field["group"], "chat")
                self.assertEqual(field["widget"], "bool")
                self.assertFalse(field["restart"])
                self.assertIn("Codex research chat", field["help"])
                self.assertFalse(body["values"][key])

        r = self.client.patch(
            "/api/settings",
            json={"patches": [{"key": key, "value": True} for key in expected]},
        )
        self.assertEqual(r.status_code, 200, r.text)
        for key in expected:
            self.assertTrue(r.json()["values"][key])

        yaml_path = os.path.join(self.tmpdir, "interests.yaml")
        with open(yaml_path) as f:
            data = yaml.safe_load(f)
        self.assertTrue(data["chat"]["codex_native_shell_tools"])
        self.assertTrue(data["chat"]["codex_native_web_search"])
        self.assertTrue(data["chat"]["codex_native_image_view"])
        self.assertTrue(data["chat"]["codex_native_network_access"])

        r = self.client.patch(
            "/api/settings",
            json={"patches": [{"key": key, "value": False} for key in expected]},
        )
        self.assertEqual(r.status_code, 200, r.text)
        for key in expected:
            self.assertFalse(r.json()["values"][key])

    def test_biorxiv_provider_fields_are_selects(self) -> None:
        r = self.client.get("/api/settings")
        self.assertEqual(r.status_code, 200, r.text)
        fields = {item["key"]: item for item in r.json()["schema"]}

        provider_field = fields["sources.biorxiv.provider"]
        self.assertEqual(provider_field["widget"], "select")
        self.assertEqual(
            [option["value"] for option in provider_field["options"]],
            ["api", "crossref"],
        )

        fallback_field = fields["sources.biorxiv.fallback_provider"]
        self.assertEqual(fallback_field["widget"], "select")
        self.assertEqual(
            [option["value"] for option in fallback_field["options"]],
            ["api", "crossref", "none"],
        )

        r = self.client.patch(
            "/api/settings",
            json={
                "patches": [
                    {"key": "sources.biorxiv.provider", "value": "crossref"},
                    {"key": "sources.biorxiv.fallback_provider", "value": "none"},
                ]
            },
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["values"]["sources.biorxiv.provider"], "crossref")
        self.assertEqual(r.json()["values"]["sources.biorxiv.fallback_provider"], "none")

        r = self.client.patch(
            "/api/settings",
            json={
                "patches": [
                    {"key": "sources.biorxiv.provider", "value": "api"},
                    {"key": "sources.biorxiv.fallback_provider", "value": "crossref"},
                ]
            },
        )
        self.assertEqual(r.status_code, 200, r.text)

    def test_source_category_fields_expose_option_backed_tags(self) -> None:
        r = self.client.get("/api/settings")
        self.assertEqual(r.status_code, 200, r.text)
        fields = {item["key"]: item for item in r.json()["schema"]}

        arxiv_field = fields["sources.arxiv.categories"]
        self.assertEqual(arxiv_field["widget"], "tags")
        self.assertIn(
            {"value": "q-bio.BM", "label": "Biomolecules"},
            arxiv_field["options"],
        )
        self.assertIn(
            {"value": "physics.bio-ph", "label": "Biological Physics"},
            arxiv_field["options"],
        )

        biorxiv_field = fields["sources.biorxiv.categories"]
        self.assertEqual(biorxiv_field["widget"], "tags")
        self.assertIn(
            {"value": "Biophysics", "label": "Biophysics"},
            biorxiv_field["options"],
        )

    def test_source_category_fields_accept_custom_values(self) -> None:
        r = self.client.patch(
            "/api/settings",
            json={
                "patches": [
                    {"key": "sources.arxiv.categories", "value": ["q-bio.BM", "future.NEW"]},
                    {"key": "sources.biorxiv.categories", "value": ["Biophysics", "Future Biology"]},
                ]
            },
        )
        self.assertEqual(r.status_code, 200, r.text)
        values = r.json()["values"]
        self.assertEqual(values["sources.arxiv.categories"], ["q-bio.BM", "future.NEW"])
        self.assertEqual(values["sources.biorxiv.categories"], ["Biophysics", "Future Biology"])

    def test_scoring_provider_is_select_metadata_without_strict_validation(self) -> None:
        r = self.client.get("/api/settings")
        self.assertEqual(r.status_code, 200, r.text)
        field = next(item for item in r.json()["schema"] if item["key"] == "llm.provider")
        self.assertEqual(field["widget"], "select")
        self.assertEqual(field["options"], [{"value": "openai", "label": "OpenAI"}])

        r = self.client.patch(
            "/api/settings",
            json={"patches": [{"key": "llm.provider", "value": "custom-provider"}]},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["values"]["llm.provider"], "custom-provider")

        r = self.client.patch(
            "/api/settings",
            json={"patches": [{"key": "llm.provider", "value": "openai"}]},
        )
        self.assertEqual(r.status_code, 200, r.text)

    def test_paper_pdf_tool_toggle_round_trips(self) -> None:
        r = self.client.get("/api/settings")
        self.assertEqual(r.status_code, 200, r.text)
        field = next(item for item in r.json()["schema"] if item["key"] == "chat.tools.paper_pdf")
        self.assertEqual(field["group"], "chat")
        self.assertEqual(field["widget"], "bool")
        self.assertTrue(r.json()["values"]["chat.tools.paper_pdf"])

        r = self.client.patch(
            "/api/settings",
            json={"patches": [{"key": "chat.tools.paper_pdf", "value": False}]},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["values"]["chat.tools.paper_pdf"])
        r = self.client.patch(
            "/api/settings",
            json={"patches": [{"key": "chat.tools.paper_pdf", "value": True}]},
        )
        self.assertEqual(r.status_code, 200, r.text)

    def test_agent_write_tool_gates_round_trip(self) -> None:
        keys = [
            "chat.tools.task_write",
            "chat.tools.project_write",
            "chat.tools.log_write",
            "chat.tools.note_write",
            "chat.tools.paper_collection_write",
            "chat.tools.paper_ingest",
            "chat.tools.paper_asset_write",
        ]
        r = self.client.get("/api/settings")
        self.assertEqual(r.status_code, 200, r.text)
        schema_keys = {item["key"] for item in r.json()["schema"]}
        for key in keys:
            self.assertIn(key, schema_keys)
            self.assertTrue(r.json()["values"][key])

        r = self.client.patch(
            "/api/settings",
            json={"patches": [{"key": key, "value": False} for key in keys]},
        )
        self.assertEqual(r.status_code, 200, r.text)
        for key in keys:
            self.assertFalse(r.json()["values"][key])

    def test_paper_assets_root_path_is_not_writable(self) -> None:
        r = self.client.get("/api/settings")
        self.assertEqual(r.status_code, 200, r.text)
        keys = {item["key"] for item in r.json()["schema"]}
        self.assertNotIn("paper_assets.root_path", keys)
        self.assertNotIn("paper_assets.root_path", r.json()["values"])

        r = self.client.patch(
            "/api/settings",
            json={"patches": [{"key": "paper_assets.root_path", "value": "assets"}]},
        )
        self.assertEqual(r.status_code, 400, r.text)

    def test_paper_assets_pdf_parser_select_round_trips(self) -> None:
        r = self.client.get("/api/settings")
        self.assertEqual(r.status_code, 200, r.text)
        field = next(item for item in r.json()["schema"] if item["key"] == "paper_assets.pdf_parser")
        self.assertEqual(field["group"], "paper_assets")
        self.assertEqual(field["widget"], "select")
        self.assertEqual(
            [option["value"] for option in field["options"]],
            ["pymupdf", "pymupdf4llm", "docling", "mineru"],
        )
        self.assertEqual(r.json()["values"]["paper_assets.pdf_parser"], "pymupdf")

        r = self.client.patch(
            "/api/settings",
            json={"patches": [{"key": "paper_assets.pdf_parser", "value": "pymupdf4llm"}]},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["values"]["paper_assets.pdf_parser"], "pymupdf4llm")

    def test_paper_assets_root_is_fixed_under_vault(self) -> None:
        data_root = Path(self.tmpdir).resolve()

        default_root = self.cfg_mod.paper_assets_root(self.cfg_mod.Config())
        self.assertEqual(default_root, data_root / "assets")

        ignored_relative_root = self.cfg_mod.paper_assets_root(
            self.cfg_mod.Config(
                paper_assets=self.cfg_mod.PaperAssetsConfig(root_path="assets"),
            )
        )
        self.assertEqual(ignored_relative_root, data_root / "assets")

        ignored_sibling_root = self.cfg_mod.paper_assets_root(
            self.cfg_mod.Config(
                paper_assets=self.cfg_mod.PaperAssetsConfig(root_path="../shared-assets"),
            )
        )
        self.assertEqual(ignored_sibling_root, data_root / "assets")

    def test_paper_assets_relative_root_is_independent_of_cwd(self) -> None:
        with tempfile.TemporaryDirectory() as other_cwd:
            previous_cwd = os.getcwd()
            try:
                os.chdir(other_cwd)
                root = self.cfg_mod.paper_assets_root(
                    self.cfg_mod.Config(
                        paper_assets=self.cfg_mod.PaperAssetsConfig(root_path="assets"),
                    )
                )
            finally:
                os.chdir(previous_cwd)

        self.assertEqual(root, Path(self.tmpdir).resolve() / "assets")

    def test_paper_assets_absolute_root_extra_is_ignored(self) -> None:
        absolute_root = Path(self.tmpdir).resolve() / "absolute-assets"
        root = self.cfg_mod.paper_assets_root(
            self.cfg_mod.Config(
                paper_assets=self.cfg_mod.PaperAssetsConfig(root_path=str(absolute_root)),
            )
        )
        self.assertEqual(root, Path(self.tmpdir).resolve() / "assets")

    def test_vault_settings_reports_effective_vault_paths(self) -> None:
        self.cfg_mod.local_config_path().unlink(missing_ok=True)
        r = self.client.get("/api/settings/vault")

        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        data_root = Path(self.tmpdir).resolve()
        self.assertEqual(body["vault_path"], str(data_root))
        self.assertEqual(body["source"], "env")
        self.assertEqual(body["local_config_path"], str(self.cfg_mod.local_config_path()))
        self.assertEqual(body["configured_vault_path"], None)
        self.assertEqual(body["pending_vault_path"], None)
        self.assertEqual(body["configured_vault_error"], None)
        self.assertEqual(body["settings_file"], str(data_root / "interests.yaml"))
        self.assertEqual(body["database"], str(data_root / "claudesk.db"))
        self.assertEqual(body["asset_root"], str(data_root / "assets"))
        self.assertTrue(body["env_override"])
        self.assertFalse(body["restart_required"])

    def test_vault_settings_patch_saves_local_pointer_without_switching_running_env_vault(self) -> None:
        data_root = Path(self.tmpdir).resolve()
        next_vault = data_root / "next-vault"

        r = self.client.patch(
            "/api/settings/vault",
            json={"vault_path": str(next_vault)},
        )

        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["vault_path"], str(data_root))
        self.assertEqual(body["configured_vault_path"], str(next_vault.resolve()))
        self.assertEqual(body["pending_vault_path"], str(next_vault.resolve()))
        self.assertEqual(body["configured_vault_error"], None)
        self.assertTrue(body["env_override"])
        self.assertTrue(body["restart_required"])
        self.assertTrue(next_vault.exists())
        saved = yaml.safe_load(self.cfg_mod.local_config_path().read_text(encoding="utf-8"))
        self.assertEqual(saved["vault_path"], str(next_vault.resolve()))
        self.cfg_mod.local_config_path().unlink(missing_ok=True)

    def test_vault_settings_env_override_tolerates_bad_local_pointer(self) -> None:
        data_root = Path(self.tmpdir).resolve()
        self.cfg_mod.local_config_path().write_text("vault_path: relative-vault\n", encoding="utf-8")

        try:
            r = self.client.get("/api/settings/vault")

            self.assertEqual(r.status_code, 200, r.text)
            body = r.json()
            self.assertEqual(body["vault_path"], str(data_root))
            self.assertEqual(body["source"], "env")
            self.assertEqual(body["configured_vault_path"], None)
            self.assertEqual(body["pending_vault_path"], None)
            self.assertFalse(body["restart_required"])
            self.assertTrue(body["env_override"])
            self.assertIn("vault_path must be absolute", body["configured_vault_error"])
        finally:
            self.cfg_mod.local_config_path().unlink(missing_ok=True)

    def test_vault_preview_reports_nonexistent_target(self) -> None:
        data_root = Path(self.tmpdir).resolve()
        target = data_root / "new-vault"

        r = self.client.post(
            "/api/settings/vault/preview",
            json={"vault_path": str(target)},
        )

        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["target_path"], str(target.resolve()))
        self.assertFalse(body["exists"])
        self.assertFalse(body["is_directory"])
        self.assertFalse(body["has_claudesk_vault"])
        self.assertFalse(body["matches_current_vault"])
        self.assertTrue(body["env_override"])
        self.assertTrue(body["can_save"])
        self.assertIsNone(body["error"])

    def test_vault_preview_reports_empty_existing_directory(self) -> None:
        data_root = Path(self.tmpdir).resolve()
        target = data_root / "empty-vault-target"
        target.mkdir()

        r = self.client.post(
            "/api/settings/vault/preview",
            json={"vault_path": str(target)},
        )

        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["target_path"], str(target.resolve()))
        self.assertTrue(body["exists"])
        self.assertTrue(body["is_directory"])
        self.assertFalse(body["has_claudesk_vault"])
        self.assertTrue(body["can_save"])

    def test_vault_preview_detects_existing_vault_markers(self) -> None:
        data_root = Path(self.tmpdir).resolve()
        markers = {
            "db": lambda path: (path / "claudesk.db").write_text("", encoding="utf-8"),
            "settings": lambda path: (path / "interests.yaml").write_text("topics: []\n", encoding="utf-8"),
            "assets": lambda path: (path / "assets").mkdir(),
        }

        for name, create_marker in markers.items():
            with self.subTest(marker=name):
                target = data_root / f"existing-vault-{name}"
                target.mkdir(exist_ok=True)
                create_marker(target)

                r = self.client.post(
                    "/api/settings/vault/preview",
                    json={"vault_path": str(target)},
                )

                self.assertEqual(r.status_code, 200, r.text)
                body = r.json()
                self.assertTrue(body["exists"])
                self.assertTrue(body["is_directory"])
                self.assertTrue(body["has_claudesk_vault"])
                self.assertTrue(body["can_save"])

    def test_vault_preview_blocks_file_target(self) -> None:
        data_root = Path(self.tmpdir).resolve()
        target = data_root / "not-a-directory"
        target.write_text("file", encoding="utf-8")

        r = self.client.post(
            "/api/settings/vault/preview",
            json={"vault_path": str(target)},
        )

        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["target_path"], str(target.resolve()))
        self.assertTrue(body["exists"])
        self.assertFalse(body["is_directory"])
        self.assertFalse(body["has_claudesk_vault"])
        self.assertFalse(body["can_save"])
        self.assertIn("not a directory", body["error"])

    def test_vault_preview_reports_env_override_and_current_match(self) -> None:
        data_root = Path(self.tmpdir).resolve()

        r = self.client.post(
            "/api/settings/vault/preview",
            json={"vault_path": str(data_root)},
        )

        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["target_path"], str(data_root))
        self.assertTrue(body["exists"])
        self.assertTrue(body["is_directory"])
        self.assertTrue(body["matches_current_vault"])
        self.assertTrue(body["env_override"])
        self.assertTrue(body["can_save"])

    def test_pick_directory_under_data_dir_returns_absolute_path(self) -> None:
        selected = os.path.join(self.tmpdir, "selected-assets")
        r = self._post_pick_directory(selected, key="paper_assets.root_path")

        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["path"], os.path.abspath(selected))

    def test_pick_directory_for_obsidian_path_returns_absolute_path_under_data_dir(self) -> None:
        selected = os.path.join(self.tmpdir, "Obsidian")
        r = self._post_pick_directory(selected, key="obsidian.vault_path")

        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["path"], os.path.abspath(selected))

    def test_pick_directory_without_key_returns_absolute_path(self) -> None:
        selected = os.path.join(self.tmpdir, "generic-path")
        r = self._post_pick_directory(selected)

        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["path"], os.path.abspath(selected))

    def test_pick_directory_outside_data_dir_returns_absolute_path(self) -> None:
        with tempfile.TemporaryDirectory() as outside:
            selected = os.path.join(outside, "selected-assets")
            r = self._post_pick_directory(selected, key="paper_assets.root_path")

        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["path"], os.path.abspath(selected))

    def test_pick_directory_cancel_returns_null_path(self) -> None:
        r = self._post_pick_directory(None)

        self.assertEqual(r.status_code, 200, r.text)
        self.assertIsNone(r.json()["path"])

    def test_pick_directory_unavailable_returns_503(self) -> None:
        original = self.client.settings_mod.pick_directory_dialog

        def unavailable():
            raise self.client.settings_mod.DirectoryPickerUnavailable("Directory picker is unavailable on this system.")

        self.client.settings_mod.pick_directory_dialog = unavailable
        try:
            r = self.client.post("/api/settings/pick-directory")
        finally:
            self.client.settings_mod.pick_directory_dialog = original

        self.assertEqual(r.status_code, 503, r.text)
        self.assertIn("unavailable", r.json()["detail"])

    def test_macos_directory_picker_uses_osascript_path(self) -> None:
        selected = os.path.join(self.tmpdir, "mac-assets")
        original_which = self.client.settings_mod.shutil.which
        original_run = self.client.settings_mod.subprocess.run
        captured: list[list[str]] = []

        def fake_which(name: str):
            return "/usr/bin/osascript" if name == "osascript" else None

        def fake_run(command: list[str], **kwargs):
            captured.append(command)
            return SimpleNamespace(returncode=0, stdout=f"{selected}\n", stderr="")

        self.client.settings_mod.shutil.which = fake_which
        self.client.settings_mod.subprocess.run = fake_run
        try:
            path = self.client.settings_mod._pick_directory_macos()
        finally:
            self.client.settings_mod.shutil.which = original_which
            self.client.settings_mod.subprocess.run = original_run

        self.assertEqual(path, os.path.abspath(selected))
        self.assertEqual(captured[0][0], "osascript")

    def test_linux_zenity_picker_returns_selected_path(self) -> None:
        selected = os.path.join(self.tmpdir, "zenity-assets")
        original_which = self.client.settings_mod.shutil.which
        original_run = self.client.settings_mod.subprocess.run

        def fake_which(name: str):
            return f"/usr/bin/{name}" if name == "zenity" else None

        def fake_run(command: list[str], **kwargs):
            return SimpleNamespace(returncode=0, stdout=f"{selected}\n", stderr="")

        self.client.settings_mod.shutil.which = fake_which
        self.client.settings_mod.subprocess.run = fake_run
        try:
            path = self.client.settings_mod._pick_directory_zenity()
        finally:
            self.client.settings_mod.shutil.which = original_which
            self.client.settings_mod.subprocess.run = original_run

        self.assertEqual(path, os.path.abspath(selected))

    def test_linux_picker_falls_through_from_zenity_to_kdialog(self) -> None:
        selected = os.path.join(self.tmpdir, "kdialog-assets")
        original_which = self.client.settings_mod.shutil.which
        original_run = self.client.settings_mod.subprocess.run
        calls: list[str] = []

        def fake_which(name: str):
            return f"/usr/bin/{name}" if name in {"zenity", "kdialog"} else None

        def fake_run(command: list[str], **kwargs):
            calls.append(command[0])
            if command[0] == "zenity":
                return SimpleNamespace(returncode=2, stdout="", stderr="cannot open display")
            return SimpleNamespace(returncode=0, stdout=f"{selected}\n", stderr="")

        self.client.settings_mod.shutil.which = fake_which
        self.client.settings_mod.subprocess.run = fake_run
        try:
            path = self.client.settings_mod.pick_directory_dialog(platform_name="linux")
        finally:
            self.client.settings_mod.shutil.which = original_which
            self.client.settings_mod.subprocess.run = original_run

        self.assertEqual(path, os.path.abspath(selected))
        self.assertEqual(calls, ["zenity", "kdialog"])

    def test_picker_cancel_returns_none(self) -> None:
        original_which = self.client.settings_mod.shutil.which
        original_run = self.client.settings_mod.subprocess.run

        def fake_which(name: str):
            return f"/usr/bin/{name}" if name == "zenity" else None

        def fake_run(command: list[str], **kwargs):
            return SimpleNamespace(returncode=1, stdout="", stderr="")

        self.client.settings_mod.shutil.which = fake_which
        self.client.settings_mod.subprocess.run = fake_run
        try:
            path = self.client.settings_mod._pick_directory_zenity()
        finally:
            self.client.settings_mod.shutil.which = original_which
            self.client.settings_mod.subprocess.run = original_run

        self.assertIsNone(path)

    def test_all_directory_picker_providers_unavailable(self) -> None:
        original_which = self.client.settings_mod.shutil.which
        original_tk = self.client.settings_mod._pick_directory_tk_subprocess

        def unavailable_tk():
            raise self.client.settings_mod.DirectoryPickerUnavailable("tk unavailable")

        self.client.settings_mod.shutil.which = lambda name: None
        self.client.settings_mod._pick_directory_tk_subprocess = unavailable_tk
        try:
            with self.assertRaises(self.client.settings_mod.DirectoryPickerUnavailable):
                self.client.settings_mod.pick_directory_dialog(platform_name="linux")
        finally:
            self.client.settings_mod.shutil.which = original_which
            self.client.settings_mod._pick_directory_tk_subprocess = original_tk

    def test_unknown_platform_uses_tk_fallback(self) -> None:
        selected = os.path.join(self.tmpdir, "tk-assets")
        original_tk = self.client.settings_mod._pick_directory_tk_subprocess

        self.client.settings_mod._pick_directory_tk_subprocess = lambda: selected
        try:
            path = self.client.settings_mod.pick_directory_dialog(platform_name="plan9")
        finally:
            self.client.settings_mod._pick_directory_tk_subprocess = original_tk

        self.assertEqual(path, selected)


class VaultLocationTests(unittest.TestCase):
    def setUp(self) -> None:
        import claudesk.core.config as cfg_mod
        cfg_mod.clear_vault_location_cache()
        cfg_mod.load_config.cache_clear()
        self.cfg_mod = cfg_mod

    def tearDown(self) -> None:
        self.cfg_mod.clear_vault_location_cache()
        self.cfg_mod.load_config.cache_clear()

    def test_atomic_config_save_keeps_prior_yaml_and_cache_on_failure(self) -> None:
        for failure in ("serialize", "sync", "replace"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                target = Path(tmp) / "interests.yaml"
                original = self.cfg_mod.Config()
                original.profile.name = "Original"
                self.cfg_mod.save_config_file(original, str(target))
                cached = self.cfg_mod.load_config(str(target))
                before = target.read_bytes()
                attempted = original.model_copy(deep=True)
                attempted.profile.name = "Changed"
                function = {
                    "serialize": "yaml.safe_dump",
                    "sync": "os.fsync",
                    "replace": "os.replace",
                }[failure]
                with patch(f"claudesk.core.config.{function}", side_effect=OSError("save failed")):
                    with self.assertRaisesRegex(OSError, "save failed"):
                        self.cfg_mod.save_config_file(attempted, str(target))
                self.assertEqual(target.read_bytes(), before)
                self.assertIs(self.cfg_mod.load_config(str(target)), cached)
                self.assertEqual(cached.profile.name, "Original")
                self.assertEqual(list(Path(tmp).glob(".*.tmp")), [])

    def test_atomic_pointer_save_keeps_prior_vault_and_cache_on_failure(self) -> None:
        for failure in ("serialize", "sync", "replace"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                target = root / "local.yaml"
                with patch.dict(os.environ, {"CLAUDESK_LOCAL_CONFIG": str(target)}, clear=True):
                    self.cfg_mod.set_local_vault_path(root / "original")
                    cached = self.cfg_mod.vault_location()
                    before = target.read_bytes()
                    function = {
                        "serialize": "yaml.safe_dump",
                        "sync": "os.fsync",
                        "replace": "os.replace",
                    }[failure]
                    with patch(f"claudesk.core.config.{function}", side_effect=OSError("save failed")):
                        with self.assertRaisesRegex(OSError, "save failed"):
                            self.cfg_mod.set_local_vault_path(root / "attempted")
                    self.assertEqual(target.read_bytes(), before)
                    self.assertIs(self.cfg_mod.vault_location(), cached)
                    self.assertEqual(self.cfg_mod.local_vault_path(), root / "original")
                    self.assertEqual(list(root.glob(".*.tmp")), [])

    def test_atomic_config_and_pointer_saves_replace_complete_yaml(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "interests.yaml"
            config = self.cfg_mod.Config()
            self.cfg_mod.save_config_file(config, str(target))
            config.profile.name = "Researcher λ"
            self.cfg_mod.save_config_file(config, str(target))
            self.assertEqual(yaml.safe_load(target.read_text())["profile"]["name"], "Researcher λ")
            with patch.dict(os.environ, {"CLAUDESK_LOCAL_CONFIG": str(root / "local.yaml")}, clear=True):
                self.cfg_mod.set_local_vault_path(root / "first")
                self.cfg_mod.vault_location()
                self.cfg_mod.set_local_vault_path(root / "second")
                self.assertEqual(self.cfg_mod.vault_location().path, root / "second")
            self.assertEqual(list(root.glob(".*.tmp")), [])

    def test_partial_yaml_write_failure_preserves_previous_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "interests.yaml"
            config = self.cfg_mod.Config()
            self.cfg_mod.save_config_file(config, str(target))
            before = target.read_bytes()
            create_temporary = tempfile.NamedTemporaryFile

            def failing_temporary(**kwargs):
                handle = create_temporary(**kwargs)
                write = handle.write

                def partial_write(content):
                    write(content[:20])
                    raise OSError("disk full")

                handle.write = partial_write
                return handle

            with patch("claudesk.core.config.tempfile.NamedTemporaryFile", side_effect=failing_temporary):
                with self.assertRaisesRegex(OSError, "disk full"):
                    self.cfg_mod.save_config_file(config, str(target))
            self.assertEqual(target.read_bytes(), before)
            self.assertEqual(list(Path(tmp).glob(".*.tmp")), [])

    def test_env_var_overrides_local_config_and_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            local_config = root / "local.yaml"
            local_vault = root / "local-vault"
            env_vault = root / "env-vault"
            local_config.write_text(f"vault_path: {local_vault}\n", encoding="utf-8")

            with patch.dict(
                os.environ,
                {
                    "CLAUDESK_LOCAL_CONFIG": str(local_config),
                    "CLAUDESK_DATA_DIR": str(env_vault),
                },
                clear=True,
            ):
                location = self.cfg_mod.vault_location()
                resolved_data_dir = self.cfg_mod.data_dir()

            self.assertEqual(location.source, "env")
            self.assertEqual(location.path, env_vault.resolve())
            self.assertEqual(resolved_data_dir, env_vault.resolve())

    def test_local_config_controls_vault_when_env_is_absent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            local_config = root / "local.yaml"
            vault = root / "Dropbox" / "Claudesk"
            local_config.write_text(f"vault_path: {vault}\n", encoding="utf-8")

            with patch.dict(
                os.environ,
                {"CLAUDESK_LOCAL_CONFIG": str(local_config)},
                clear=True,
            ):
                from claudesk.core.db import db_path

                location = self.cfg_mod.vault_location()
                data_root = self.cfg_mod.data_dir()
                settings_path = self.cfg_mod.config_path()
                database_path = db_path()
                assets_path = self.cfg_mod.paper_assets_root(self.cfg_mod.Config())

            self.assertEqual(location.source, "local_config")
            self.assertEqual(location.path, vault.resolve())
            self.assertEqual(data_root, vault.resolve())
            self.assertEqual(settings_path, vault.resolve() / "interests.yaml")
            self.assertEqual(database_path, vault.resolve() / "claudesk.db")
            self.assertEqual(assets_path, vault.resolve() / "assets")

    def test_vault_location_is_pinned_until_cache_is_cleared(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            local_config = root / "local.yaml"
            first_vault = root / "first-vault"
            second_vault = root / "second-vault"
            local_config.write_text(f"vault_path: {first_vault}\n", encoding="utf-8")

            with patch.dict(
                os.environ,
                {"CLAUDESK_LOCAL_CONFIG": str(local_config)},
                clear=True,
            ):
                first = self.cfg_mod.vault_location()
                local_config.write_text(f"vault_path: {second_vault}\n", encoding="utf-8")
                still_first = self.cfg_mod.data_dir()
                self.cfg_mod.clear_vault_location_cache()
                second = self.cfg_mod.data_dir()

        self.assertEqual(first.path, first_vault.resolve())
        self.assertEqual(still_first, first_vault.resolve())
        self.assertEqual(second, second_vault.resolve())

    def test_missing_local_config_uses_project_data_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            missing_local_config = Path(tmp) / "missing-local.yaml"
            with patch.dict(
                os.environ,
                {"CLAUDESK_LOCAL_CONFIG": str(missing_local_config)},
                clear=True,
            ):
                location = self.cfg_mod.vault_location()

        self.assertEqual(location.source, "default")
        self.assertEqual(location.path, self.cfg_mod.project_root() / "data")

    def test_malformed_local_config_raises_clear_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            local_config = Path(tmp) / "local.yaml"
            local_config.write_text("vault_path: relative-vault\n", encoding="utf-8")

            with patch.dict(
                os.environ,
                {"CLAUDESK_LOCAL_CONFIG": str(local_config)},
                clear=True,
            ):
                with self.assertRaises(self.cfg_mod.VaultConfigError) as ctx:
                    self.cfg_mod.vault_location()

        self.assertIn(str(local_config), str(ctx.exception))
        self.assertIn("vault_path", str(ctx.exception))
        self.assertIn("absolute", str(ctx.exception))

    def test_cli_vault_set_writes_local_config_and_show_reports_paths(self) -> None:
        from claudesk.cli import app

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            local_config = root / "machine" / "local.yaml"
            vault = root / "Dropbox" / "Claudesk"
            runner = CliRunner()
            env = {"CLAUDESK_LOCAL_CONFIG": str(local_config), "CLAUDESK_DATA_DIR": ""}

            result = runner.invoke(app, ["vault", "set", str(vault)], env=env)
            self.assertEqual(result.exit_code, 0, result.output)
            data = yaml.safe_load(local_config.read_text(encoding="utf-8"))
            self.assertEqual(data["vault_path"], str(vault.resolve()))
            self.assertTrue(vault.exists())

            result = runner.invoke(app, ["vault", "show"], env=env)
            self.assertEqual(result.exit_code, 0, result.output)

        self.assertIn(str(vault.resolve()), result.output)
        self.assertIn("local_config", result.output)
        self.assertIn("interests.yaml", result.output)
        self.assertIn("claudesk.db", result.output)
        self.assertIn("assets", result.output)

    def test_cli_vault_set_warns_when_env_var_overrides_local_config(self) -> None:
        from claudesk.cli import app

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            local_config = root / "machine" / "local.yaml"
            local_vault = root / "local-vault"
            env_vault = root / "env-vault"
            runner = CliRunner()
            result = runner.invoke(
                app,
                ["vault", "set", str(local_vault)],
                env={
                    "CLAUDESK_LOCAL_CONFIG": str(local_config),
                    "CLAUDESK_DATA_DIR": str(env_vault),
                },
            )

        self.assertEqual(result.exit_code, 0, result.output)
        self.assertIn("CLAUDESK_DATA_DIR", result.output)
        self.assertIn("overrides", result.output)


class SettingsLegacyRoutesGoneTests(unittest.TestCase):
    """The legacy /api/settings/sources and /api/settings/digest routes were
    deleted in Slice 3 — confirm the same fields still round-trip through the
    generic registry. (The SPA wildcard catches GETs to old paths and returns
    HTML, so we assert via the registry round-trip rather than HTTP 404.)"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.client, cls.tmpdir, cls.cfg_mod = _make_app_with_isolated_data()

    def test_digest_round_trip_via_registry(self) -> None:
        r = self.client.patch(
            "/api/settings",
            json={"patches": [{"key": "digest.days_back", "value": 11}]},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["values"]["digest.days_back"], 11)

    def test_sources_round_trip_via_registry(self) -> None:
        r = self.client.patch(
            "/api/settings",
            json={"patches": [{"key": "sources.openalex.enabled", "value": True}]},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["values"]["sources.openalex.enabled"], True)


if __name__ == "__main__":
    unittest.main()


class ChatRuntimeDefaultsTests(unittest.TestCase):
    def setUp(self) -> None:
        from claudesk.core.config import clear_vault_location_cache, load_config
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)
        self.env = patch.dict(os.environ, {
            "CLAUDESK_DATA_DIR": self.tmpdir.name,
            "CLAUDESK_LOCAL_CONFIG": str(Path(self.tmpdir.name) / "local.yaml"),
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        clear_vault_location_cache()
        load_config.cache_clear()
        self.addCleanup(clear_vault_location_cache)
        self.addCleanup(load_config.cache_clear)

    def test_catalog_and_defaults_use_only_applicable_options(self) -> None:
        from claudesk.core.config import ChatRuntimeSettings, chat_runtime_catalog
        from claudesk.api.settings_registry import apply_patches
        catalog = chat_runtime_catalog()
        for backend, entry in catalog.items():
            with self.subTest(backend=backend):
                settings = ChatRuntimeSettings(backend=backend)
                self.assertEqual(settings.model_dump(), entry["defaults"])
                self.assertEqual({f["key"] for f in entry["fields"]}, set(entry["defaults"]) - {"backend"})
        result = apply_patches([
            {"key": "chat.backend", "value": "codex_cli"},
            {"key": "chat.model", "value": "my-custom-model"},
            {"key": "chat.reasoning_effort", "value": "high"},
            {"key": "chat.system_prompt_addendum", "value": "Keep global instructions"},
        ])
        self.assertEqual(result["values"]["chat.model"], "my-custom-model")
        self.assertNotIn("chat.temperature", result["values"])
        result = apply_patches([{"key": "chat.backend", "value": "gemini_api"}])
        self.assertEqual(result["values"]["chat.model"], "gemini-2.5-flash")
        self.assertEqual(result["values"]["chat.temperature"], 0.7)
        self.assertNotIn("chat.reasoning_effort", result["values"])
        self.assertNotIn("chat.service_tier", result["values"])
        self.assertEqual(result["values"]["chat.system_prompt_addendum"], "Keep global instructions")
        result = apply_patches([{"key": "chat.backend", "value": "codex_cli"}])
        self.assertEqual(result["values"]["chat.model"], "gpt-5.5")
        self.assertEqual(result["values"]["chat.reasoning_effort"], "medium")
        apply_patches([{"key": "chat.reasoning_summary", "value": "detailed"}])
        result = apply_patches([{"key": "chat.reasoning_summary", "value": ""}])
        self.assertIsNone(result["values"]["chat.reasoning_summary"])

    def test_runtime_validation_rejects_invalid_or_unsupported_fields(self) -> None:
        from claudesk.core.config import ChatRuntimeSettings
        invalid = [
            {"backend": "claude_cli"},
            {"model_override": "retired"},
            {"temperature": "0.2"},
            {"temperature": True},
            {"temperature": -0.1},
            {"temperature": float("nan")},
            {"temperature": 2.1},
            {"backend": "codex_cli", "temperature": 0.7},
            {"backend": "codex_cli", "temperature": None},
            {"backend": "gemini_api", "service_tier": "fast"},
            {"backend": "openai_api", "reasoning_effort": "high"},
            {"backend": "codex_cli", "reasoning_effort": "invalid effort"},
            {"backend": "codex_cli", "reasoning_summary": "invalid"},
            {"model": 42},
        ]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValidationError):
                ChatRuntimeSettings.model_validate(value)
        custom = ChatRuntimeSettings(model=" custom/model ", service_tier=" ")
        self.assertEqual(custom.model, "custom/model")
        self.assertIsNone(custom.service_tier)

    def test_discovered_model_controls_and_defaults_are_consistent(self) -> None:
        from claudesk.core.config import ChatRuntimeSettings, chat_model_choice, chat_runtime_catalog
        catalog = chat_runtime_catalog()
        for backend in ("openai_api", "codex_cli"):
            self.assertEqual(catalog[backend]["models"], [])
        for backend, model, kwargs in (
            ("openai_api", "gpt-4o-mini", {}),
            ("openai_api", "gpt-6-astra", {}),
            ("codex_cli", "future-codex-model", {
                "reasoning_efforts": ["low", "high", "max", "ultra"],
                "default_reasoning_effort": "ultra",
            }),
            ("codex_cli", "no-reasoning-model", {}),
            ("gemini_api", "gemini-2.5-flash", {}),
            ("anthropic_api", "claude-sonnet-4-5", {}),
        ):
            with self.subTest(backend=backend, model=model):
                choice = chat_model_choice(backend, model, **kwargs)
                self.assertTrue(choice["selectable"])
                self.assertEqual(ChatRuntimeSettings(**choice["defaults"]).model_dump(), choice["defaults"])
                for field in choice["fields"]:
                    if field.get("options") and choice["defaults"][field["key"]] is not None:
                        self.assertIn(choice["defaults"][field["key"]], [option["value"] for option in field["options"]])
        sampling = chat_model_choice("openai_api", "gpt-4o-mini")
        reasoning = chat_model_choice("openai_api", "gpt-6-astra")
        self.assertNotIn("reasoning_effort", [field["key"] for field in sampling["fields"]])
        self.assertNotIn("temperature", [field["key"] for field in reasoning["fields"]])
        self.assertIsNone(reasoning["defaults"]["temperature"])

    def test_specialized_models_are_excluded_and_unknown_models_are_disabled(self) -> None:
        from claudesk.core.config import ChatRuntimeSettings, chat_model_choice
        for model in ("gpt-audio", "gpt-realtime", "gpt-image-1", "o3-deep-research", "text-embedding-3-small"):
            with self.subTest(model=model):
                self.assertIsNone(chat_model_choice("openai_api", model))
        choice = chat_model_choice("openai_api", "gpt-future")
        self.assertFalse(choice["selectable"])
        self.assertTrue(choice["unavailable_reason"])
        self.assertEqual(ChatRuntimeSettings(model="gpt-future").model, "gpt-future")
        text_only = chat_model_choice("openai_api", "o3-mini")
        self.assertFalse(text_only["selectable"])
        self.assertEqual(text_only["input_modalities"], ["text"])
        self.assertIn("image attachments", text_only["unavailable_reason"])

    def test_api_effort_ranges_do_not_assume_codex_capabilities(self) -> None:
        from claudesk.core.config import ChatRuntimeSettings, chat_model_choice
        for model, allowed, default in (
            ("gpt-6-astra", ["low", "medium", "high", "xhigh", "max"], "medium"),
            ("gpt-5.6-sol", ["none", "low", "medium", "high", "xhigh", "max"], "medium"),
            ("gpt-5.6-terra", ["none", "low", "medium", "high", "xhigh", "max"], "medium"),
            ("gpt-5.6-luna", ["none", "low", "medium", "high", "xhigh", "max"], "medium"),
            ("gpt-5.5", ["none", "low", "medium", "high", "xhigh"], "medium"),
            ("gpt-5.4", ["none", "low", "medium", "high", "xhigh"], "none"),
            ("gpt-5.1", ["none", "low", "medium", "high"], "none"),
        ):
            with self.subTest(model=model):
                choice = chat_model_choice("openai_api", model)
                effort = next(field for field in choice["fields"] if field["key"] == "reasoning_effort")
                self.assertEqual([option["value"] for option in effort["options"]], allowed)
                self.assertEqual(choice["defaults"]["reasoning_effort"], default)
                with self.assertRaises(ValidationError):
                    ChatRuntimeSettings(model=model, reasoning_effort="ultra")
        self.assertEqual(ChatRuntimeSettings(backend="codex_cli", reasoning_effort="ultra").reasoning_effort, "ultra")

    def test_atomic_model_default_patch_clears_inapplicable_options(self) -> None:
        from claudesk.core.config import chat_model_choice, load_config
        from claudesk.api.settings_registry import apply_patches
        for model in ("gpt-6-astra", "gpt-4o-mini"):
            with self.subTest(model=model):
                choice = chat_model_choice("openai_api", model)
                result = apply_patches([
                    {"key": f"chat.{key}", "value": value}
                    for key, value in choice["defaults"].items()
                ])
                self.assertEqual(load_config().chat.runtime_settings().model_dump(), choice["defaults"])
                for key, value in choice["defaults"].items():
                    self.assertEqual(result["values"][f"chat.{key}"], value)

    def test_invalid_default_patch_does_not_write_any_fields(self) -> None:
        from claudesk.core.config import config_path
        from claudesk.api.settings_registry import apply_patches
        apply_patches([{"key": "chat.model", "value": "existing-model"}])
        original = config_path().read_bytes()
        for invalid in (
            {"key": "chat.reasoning_effort", "value": "high"},
            {"key": "chat.model_override", "value": "retired"},
            {"key": "chat.backend", "value": ["invalid"]},
        ):
            with self.subTest(invalid=invalid), self.assertRaises((ValueError, ValidationError)):
                apply_patches([{"key": "chat.model", "value": "must-not-save"}, invalid])
            self.assertEqual(config_path().read_bytes(), original)
