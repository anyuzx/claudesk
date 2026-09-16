from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import HTTPException
from fastapi.responses import FileResponse, HTMLResponse

from claudesk.api import main
from tests.helpers import patched_data_dir


class LocalRequestSecurityTests(unittest.IsolatedAsyncioTestCase):
    async def test_untrusted_requests_never_reach_the_handler_or_consume_uploads(self) -> None:
        async def forbidden_app(scope, receive, send):
            self.fail("Rejected requests must not enter the application.")

        cases = [
            ("GET", [("host", "attacker.example:8765")], 400),
            ("GET", [("host", "localhost.evil.example")], 400),
            ("POST", [("host", "localhost:8765@attacker.example")], 400),
            ("GET", [("host", "localhost:70000")], 400),
            ("GET", [("host", "localhost"), ("host", "attacker.example")], 400),
            ("POST", [("origin", "https://attacker.example")], 403),
            ("POST", [("origin", "null")], 403),
            ("POST", [("origin", "http://localhost:8765/")], 403),
            ("POST", [("origin", "http://localhost:70000")], 403),
            ("POST", [("origin", "http://localhost"), ("origin", "https://attacker.example")], 403),
            ("DELETE", [("sec-fetch-site", "cross-site")], 403),
            ("PATCH", [("sec-fetch-site", "same-site")], 403),
            ("OPTIONS", [("origin", "https://attacker.example")], 403),
        ]
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.LocalRequestMiddleware(forbidden_app)),
            base_url="http://127.0.0.1:8765",
        ) as client:
            for method, headers, expected in cases:
                with self.subTest(method=method, headers=headers):
                    response = await client.request(method, "/api/chat/sessions/1/attachments", headers=headers, data={"text": "untrusted"})
                    self.assertEqual(response.status_code, expected)

    async def test_local_clients_and_streaming_responses_pass_through(self) -> None:
        async def stream_app(scope, receive, send):
            await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/event-stream")]})
            await send({"type": "http.response.body", "body": b"data: first\n\n", "more_body": True})
            await send({"type": "http.response.body", "body": b"data: done\n\n"})

        for authority in ("localhost:8765", "127.0.0.1:18765", "[::1]:8765"):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=main.LocalRequestMiddleware(stream_app)),
                base_url=f"http://{authority}",
            ) as client:
                for headers in ({}, {"origin": f"http://{authority}"}, {"origin": "http://127.0.0.1:15173"}):
                    response = await client.post("/api/chat/sessions/1/messages/stream", headers=headers)
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.text, "data: first\n\ndata: done\n\n")


class AppLifespanTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.vault = Path(self.enterContext(tempfile.TemporaryDirectory(prefix="claudesk-lock-")))
        self.enterContext(patched_data_dir(self.vault))
        self.get_connection = self.enterContext(patch.object(main, "get_connection"))
        self.init_db = self.enterContext(patch.object(main, "init_db"))
        self.reconcile_pdf = self.enterContext(patch.object(main.papers, "reconcile_stale_pdf_parse_jobs"))
        self.reconcile_jobs = self.enterContext(patch.object(main, "reconcile_stale_jobs"))
        self.cleanup = self.enterContext(patch.object(main.chat, "cleanup_app_lifetime_chat_attachments"))
        self.shutdown_handlers = [
            self.enterContext(patch.object(module, name))
            for module, name in (
                (main.digest, "shutdown_digest_job"),
                (main.settings, "shutdown_rubric_job"),
                (main.search, "shutdown_semantic_index_job"),
                (main.chat, "shutdown_chat_provider_runtimes"),
            )
        ]

    async def test_second_lifespan_cannot_initialize_or_clean_the_active_vault(self) -> None:
        lock_path = self.vault / ".claudesk-app.lock"
        lock_path.write_text("persistent lock marker", encoding="utf-8")
        inode = lock_path.stat().st_ino
        async with main.lifespan(main.app):
            with self.assertRaisesRegex(RuntimeError, "Another Claudesk app is already using vault"):
                async with main.lifespan(main.app):
                    self.fail("A second app must not start on the same vault.")
            self.get_connection.assert_called_once()
            self.init_db.assert_called_once()
            self.reconcile_pdf.assert_called_once()
            self.reconcile_jobs.assert_called_once()
            self.cleanup.assert_called_once()
            for shutdown in self.shutdown_handlers:
                shutdown.assert_not_called()

        self.assertEqual(self.cleanup.call_count, 2)
        for shutdown in self.shutdown_handlers:
            shutdown.assert_called_once()
        self.assertEqual(lock_path.stat().st_ino, inode)
        self.assertEqual(lock_path.read_text(encoding="utf-8"), "persistent lock marker")
        with main._app_vault_lock():
            pass

    async def test_initialization_failure_aborts_without_cleanup_and_releases_lock(self) -> None:
        self.init_db.side_effect = RuntimeError("Migration failed; restore backup.")
        with self.assertRaisesRegex(RuntimeError, "Migration failed"):
            async with main.lifespan(main.app):
                self.fail("Failed initialization must not serve requests.")

        self.get_connection.return_value.close.assert_called_once()
        self.reconcile_pdf.assert_not_called()
        self.reconcile_jobs.assert_not_called()
        self.cleanup.assert_not_called()
        for shutdown in self.shutdown_handlers:
            shutdown.assert_not_called()
        with main._app_vault_lock():
            pass

    async def test_lock_remains_held_through_startup_and_shutdown(self) -> None:
        def require_lock(*args, **kwargs):
            with self.assertRaisesRegex(RuntimeError, "Another Claudesk app"):
                with main._app_vault_lock():
                    self.fail("Startup and shutdown must keep the vault lock.")

        self.init_db.side_effect = require_lock
        self.cleanup.side_effect = require_lock
        for shutdown in self.shutdown_handlers:
            shutdown.side_effect = require_lock
        async with main.lifespan(main.app):
            require_lock()
        self.assertEqual(self.cleanup.call_count, 2)
        with main._app_vault_lock():
            pass

    async def test_shutdown_failure_or_cancellation_runs_remaining_cleanup_under_lock(self) -> None:
        def require_lock():
            with self.assertRaisesRegex(RuntimeError, "Another Claudesk app"):
                with main._app_vault_lock():
                    self.fail("Failed shutdown must keep the lock until remaining cleanup ends.")

        for error in (RuntimeError("Shutdown failed"), asyncio.CancelledError()):
            with self.subTest(error=type(error).__name__):
                for shutdown in self.shutdown_handlers:
                    shutdown.reset_mock()
                    shutdown.side_effect = require_lock
                self.shutdown_handlers[0].side_effect = error
                self.cleanup.reset_mock()
                self.cleanup.side_effect = require_lock
                with self.assertRaises(type(error)):
                    async with main.lifespan(main.app):
                        pass
                for shutdown in self.shutdown_handlers:
                    shutdown.assert_called_once()
                self.assertEqual(self.cleanup.call_count, 2)
                with main._app_vault_lock():
                    pass

    def test_lock_excludes_another_process_without_blocking_its_database_access(self) -> None:
        script = """
import sys
from claudesk.api.main import _app_vault_lock
from claudesk.core.db import get_connection

conn = get_connection()
conn.execute('CREATE TABLE IF NOT EXISTS worker_probe (value TEXT)')
conn.execute('INSERT INTO worker_probe VALUES (?)', ('worker access',))
conn.commit()
conn.close()
try:
    with _app_vault_lock():
        print('acquired')
except RuntimeError:
    print('blocked')
    sys.exit(2)
"""
        with main._app_vault_lock():
            blocked = subprocess.run(
                [sys.executable, "-c", script], capture_output=True, text=True, check=False, timeout=20,
            )
        self.assertEqual(blocked.returncode, 2, blocked.stdout + blocked.stderr)
        self.assertEqual(blocked.stdout.strip(), "blocked")
        released = subprocess.run(
            [sys.executable, "-c", script], capture_output=True, text=True, check=False, timeout=20,
        )
        self.assertEqual(released.returncode, 0, released.stdout + released.stderr)
        self.assertEqual(released.stdout.strip(), "acquired")


class FrontendStaticServingTests(unittest.TestCase):
    def test_fresh_vault_starts_and_serves_core_api_without_provider_credentials(self) -> None:
        script = """
import sqlite3
import sys

from fastapi.testclient import TestClient
from claudesk.core.config import config_path, data_dir, load_config, load_config_file
from claudesk.core.db import SCHEMA_VERSION

assert not config_path().exists()
assert not (data_dir() / 'claudesk.db').exists()
assert load_config().llm.api_key is None
load_config_file('examples/interests.example.yaml')

from claudesk.api.main import DIST, app

assert (DIST / 'index.html').is_file(), 'Build the frontend before running the fresh-install smoke test.'
with TestClient(app, base_url='http://127.0.0.1:8765') as client:
    response = client.get('/api/settings')
    assert response.status_code == 200, response.text
    assert response.json()['values']['profile.name'] == 'Researcher'
    for path in ('/api/papers', '/api/notes', '/api/tasks', '/api/projects'):
        response = client.get(path)
        assert response.status_code == 200, (path, response.text)
        assert response.json() == [], (path, response.text)
    response = client.post('/api/notes', json={'title': 'First note', 'body': 'Saved in a fresh vault.'})
    assert response.status_code == 200, response.text
    note_id = response.json()['id']
    response = client.get('/api/notes/' + str(note_id))
    assert response.status_code == 200, response.text
    assert response.json()['body'] == 'Saved in a fresh vault.'
    for headers in ({'Origin': 'https://attacker.example'}, {'Origin': 'null'}, {'Sec-Fetch-Site': 'cross-site'}):
        response = client.post('/api/notes', json={'title': 'Rejected'}, headers=headers)
        assert response.status_code == 403, response.text
        response = client.post('/api/chat/sessions/1/attachments', data={'kind': 'clipboard_text', 'text': 'Rejected'}, headers=headers)
        assert response.status_code == 403, response.text
    response = client.get('/api/notes', headers={'Host': 'attacker.example:8765'})
    assert response.status_code == 400, response.text
    response = client.get('/')
    assert response.status_code == 200, response.text

with TestClient(app, base_url='http://127.0.0.1:8765') as restarted_client:
    response = restarted_client.get('/api/notes/' + str(note_id))
    assert response.status_code == 200, response.text
    assert response.json()['body'] == 'Saved in a fresh vault.'

with sqlite3.connect(data_dir() / 'claudesk.db') as conn:
    assert conn.execute('SELECT max(version) FROM schema_version').fetchone()[0] == SCHEMA_VERSION
    assert conn.execute('SELECT count(*) FROM notes').fetchone()[0] == 1
assert not any(name in sys.modules for name in ('sentence_transformers', 'torch', 'triton'))
"""
        with tempfile.TemporaryDirectory(prefix="claudesk-startup-") as tmpdir:
            env = {key: value for key, value in os.environ.items() if key not in {
                "OPENAI_API_KEY", "OPENALEX_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY",
                "CLAUDESK_OBSIDIAN_VAULT",
            }}
            env.update({
                "CLAUDESK_DATA_DIR": str(Path(tmpdir) / "vault"),
                "CLAUDESK_LOCAL_CONFIG": str(Path(tmpdir) / "local.yaml"),
                "HF_HUB_OFFLINE": "1",
            })
            result = subprocess.run(
                [sys.executable, "-c", script], cwd=Path(__file__).resolve().parents[1],
                env=env, capture_output=True, text=True, check=False, timeout=45,
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_root_icon_files_are_allowlisted_before_spa_fallback(self) -> None:
        paths = [getattr(route, "path", "") for route in main.app.routes]
        spa_index = paths.index("/{full_path:path}")

        for file_name in main.FRONTEND_ROOT_STATIC_FILES:
            self.assertLess(paths.index(f"/{file_name}"), spa_index)

    def test_root_icon_files_serve_from_built_frontend_dist(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            dist = Path(tmpdir)
            (dist / "index.html").write_text("<!doctype html>", encoding="utf-8")
            for file_name in main.FRONTEND_ROOT_STATIC_FILES:
                (dist / file_name).write_bytes(f"asset:{file_name}".encode("utf-8"))

            with patch.object(main, "DIST", dist):
                for file_name in main.FRONTEND_ROOT_STATIC_FILES:
                    response = main.frontend_root_static_response(file_name)
                    self.assertIsInstance(response, FileResponse)
                    self.assertEqual(Path(response.path), dist / file_name)

    def test_root_icon_files_keep_frontend_not_built_response(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.object(main, "DIST", Path(tmpdir)):
                response = main.frontend_root_static_response("favicon.svg")

        self.assertIsInstance(response, HTMLResponse)
        self.assertEqual(response.status_code, 503)

    def test_missing_root_icon_file_returns_404_when_frontend_is_built(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            dist = Path(tmpdir)
            (dist / "index.html").write_text("<!doctype html>", encoding="utf-8")

            with patch.object(main, "DIST", dist):
                with self.assertRaises(HTTPException) as raised:
                    main.frontend_root_static_response("favicon.svg")

        self.assertEqual(raised.exception.status_code, 404)

    def test_spa_fallback_still_serves_index_for_app_routes(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            dist = Path(tmpdir)
            (dist / "index.html").write_text("<!doctype html>", encoding="utf-8")

            with patch.object(main, "DIST", dist):
                response = asyncio.run(main.serve_spa("notes"))

        self.assertIsInstance(response, FileResponse)
        self.assertEqual(Path(response.path), dist / "index.html")


if __name__ == "__main__":
    unittest.main()
