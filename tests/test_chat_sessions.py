from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
import asyncio
from contextlib import closing
from io import BytesIO
from datetime import date
from pathlib import Path
from unittest.mock import AsyncMock, patch

from starlette.requests import ClientDisconnect

from claudesk.agent import controller as controller_module
from claudesk.agent.capabilities.registry import CapabilityRegistry
from claudesk.agent.context import (
    MAX_CHAT_CONTEXT_ITEMS,
    chat_context_resource_reads,
    chat_context_prompt_block,
    note_ids_from_chat_context,
    paper_ids_from_chat_context,
    project_ids_from_chat_context,
    resolve_chat_context_items,
)
from claudesk.agent.policy import PAPER_PDF_CAPABILITY_NAMES
from claudesk.core.config import (
    ChatConfig,
    ChatRuntimeSettings,
    ChatToolsConfig,
    Config,
    LlmConfig,
    clear_vault_location_cache,
    load_config,
)
from claudesk.core.db import (
    SCHEMA_VERSION,
    init_db,
)
from claudesk.core.db.chat import (
    append_chat_message,
    attach_chat_attachments_to_message,
    attach_chat_resource_reads_to_message,
    clear_chat_session_messages,
    create_chat_attachment,
    create_chat_session,
    delete_pending_chat_attachment,
    delete_chat_resource_reads_for_turn,
    delete_chat_session,
    get_chat_attachment,
    get_chat_session_detail,
    get_chat_session_provider_state,
    insert_chat_resource_reads,
    list_chat_attachments,
    list_chat_resource_reads,
    list_chat_sessions,
    rename_chat_session,
    touch_chat_session,
    update_chat_session,
    update_chat_session_provider_state,
    update_chat_session_links,
)
from claudesk.core.chat_workflows import (
    config_for_chat_session,
    get_chat_session_or_raise,
    prepare_chat_attachment_upload,
)
from claudesk.core.db.assets import (
    create_paper_asset,
    get_asset,
)
from claudesk.core.errors import NotFoundError, ValidationError
from claudesk.core.db.notes import create_note
from claudesk.core.db.projects import create_project
from claudesk.core.db.papers import upsert_paper
from claudesk.core.models import AssetKind, AssetParseStatus, ChatContextItem, ChatContextRef, ChatTraceEntry, Paper
from claudesk.core.paper_assets import (
    CHAT_ATTACHMENT_MAX_IMAGE_BYTES,
    CHAT_ATTACHMENT_MAX_PDF_BYTES,
    CHAT_ATTACHMENT_MAX_TEXT_BYTES,
    InvalidPaperAssetFile,
    chat_attachments_root,
    resolve_chat_attachment_path,
    resolve_managed_asset_path,
    store_managed_chat_attachment,
)


def make_conn(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=3000")
    return conn


def make_paper(
    *,
    external_id: str = "10.1234/chat-paper",
    title: str = "Chat Paper",
) -> Paper:
    return Paper(
        source="biorxiv",
        external_id=external_id,
        title=title,
        abstract="Chat paper abstract",
        authors=["Alice Example"],
        published_date=date(2026, 4, 30),
        url="https://example.com/chat-paper",
    )


class FakeUpload:
    def __init__(self, *, filename: str, content_type: str, content: bytes) -> None:
        self.filename = filename
        self.content_type = content_type
        self.file = BytesIO(content)


class ChatDbTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.env_patcher = patch.dict(os.environ, {"CLAUDESK_DATA_DIR": self.tmpdir.name})
        self.env_patcher.start()
        clear_vault_location_cache()
        load_config.cache_clear()
        self.conn = make_conn(os.path.join(self.tmpdir.name, "claudesk.db"))
        init_db(self.conn)

    def tearDown(self) -> None:
        load_config.cache_clear()
        self.conn.close()
        self.env_patcher.stop()
        clear_vault_location_cache()
        self.tmpdir.cleanup()

    def test_init_db_creates_chat_tables_on_existing_schema(self) -> None:
        self.conn.close()
        legacy_conn = sqlite3.connect(os.path.join(self.tmpdir.name, "legacy.db"))
        legacy_conn.row_factory = sqlite3.Row
        legacy_conn.execute("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)")
        legacy_conn.execute("INSERT INTO schema_version (version) VALUES (5)")
        legacy_conn.commit()

        init_db(legacy_conn)

        tables = {
            row["name"]
            for row in legacy_conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        version = legacy_conn.execute(
            "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
        ).fetchone()[0]

        self.assertIn("chat_sessions", tables)
        self.assertIn("chat_messages", tables)
        self.assertIn("chat_resource_reads", tables)
        self.assertIn("chat_attachments", tables)
        chat_columns = {
            row["name"]
            for row in legacy_conn.execute("PRAGMA table_info(chat_sessions)").fetchall()
        }
        self.assertIn("provider_state", chat_columns)
        message_columns = [
            row["name"]
            for row in legacy_conn.execute("PRAGMA table_info(chat_messages)").fetchall()
        ]
        self.assertEqual(
            message_columns,
            ["id", "session_id", "role", "content", "trace_entries", "context_items", "created_at"],
        )
        self.assertEqual(version, SCHEMA_VERSION)

        legacy_conn.close()
        self.conn = make_conn(os.path.join(self.tmpdir.name, "claudesk.db"))
        init_db(self.conn)

    def test_migration_backup_uses_connected_database_path_before_creating_tables(self) -> None:
        connected_dir = Path(self.tmpdir.name) / "other-vault"
        connected_dir.mkdir()
        with closing(make_conn(str(connected_dir / "research.db"))) as conn:
            conn.execute("CREATE TABLE original_notes (body TEXT NOT NULL)")
            conn.execute("INSERT INTO original_notes VALUES ('Original research note')")
            conn.commit()

            init_db(conn)

            backups = list((connected_dir / "backups").glob("*.db"))
            self.assertEqual(len(backups), 1)
            self.assertFalse((Path(self.tmpdir.name) / "backups").exists())
            with closing(sqlite3.connect(backups[0])) as backup:
                self.assertEqual(backup.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                self.assertEqual(backup.execute("SELECT body FROM original_notes").fetchone()[0], "Original research note")
                self.assertEqual(backup.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall(), [("original_notes",)])
            self.assertEqual(conn.execute("SELECT MAX(version) FROM schema_version").fetchone()[0], SCHEMA_VERSION)

    def test_init_db_rejects_future_schema_before_any_mutation(self) -> None:
        self.conn.execute("INSERT INTO schema_version (version) VALUES (?)", (SCHEMA_VERSION + 1,))
        self.conn.commit()
        original = (Path(self.tmpdir.name) / "claudesk.db").read_bytes()
        with (
            patch("claudesk.core.db.schema._create_tables") as create_tables,
            patch("claudesk.core.db.migrations._migrate") as migrate,
            self.assertRaisesRegex(RuntimeError, "newer than supported"),
        ):
            init_db(self.conn)
        create_tables.assert_not_called()
        migrate.assert_not_called()
        self.assertEqual((Path(self.tmpdir.name) / "claudesk.db").read_bytes(), original)
        self.assertFalse((Path(self.tmpdir.name) / "backups").exists())

    def test_migration_backup_rejects_pending_transaction(self) -> None:
        self.conn.execute("DELETE FROM schema_version")
        self.conn.execute("INSERT INTO schema_version (version) VALUES (41)")
        with self.assertRaisesRegex(RuntimeError, "active transaction"):
            init_db(self.conn)
        self.assertTrue(self.conn.in_transaction)
        self.assertEqual(self.conn.execute("SELECT MAX(version) FROM schema_version").fetchone()[0], 41)
        self.assertFalse((Path(self.tmpdir.name) / "backups").exists())

    def test_failed_backup_cleans_partial_file_and_does_not_start_migration(self) -> None:
        class FailingBackupConnection(sqlite3.Connection):
            def backup(self, target, **kwargs) -> None:
                target.execute("CREATE TABLE incomplete (value TEXT)")
                target.commit()
                raise sqlite3.OperationalError("Simulated backup failure")

        self.conn.execute("DELETE FROM schema_version")
        self.conn.execute("INSERT INTO schema_version (version) VALUES (41)")
        self.conn.commit()
        self.conn.close()
        path = Path(self.tmpdir.name) / "claudesk.db"
        self.conn = sqlite3.connect(path, factory=FailingBackupConnection)
        original = path.read_bytes()
        with (
            patch("claudesk.core.db.schema._create_tables") as create_tables,
            patch("claudesk.core.db.migrations._migrate") as migrate,
            self.assertRaisesRegex(RuntimeError, "migration was not started: Simulated backup failure"),
        ):
            init_db(self.conn)
        create_tables.assert_not_called()
        migrate.assert_not_called()
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(list((Path(self.tmpdir.name) / "backups").iterdir()), [])

    def test_failed_migration_retains_backup_and_reports_its_path(self) -> None:
        note = create_note(self.conn, title="Preserve me", body="Before migration")
        self.conn.execute("DELETE FROM schema_version")
        self.conn.execute("INSERT INTO schema_version (version) VALUES (41)")
        self.conn.commit()

        def fail_after_committed_write(conn: sqlite3.Connection) -> None:
            conn.executescript("UPDATE notes SET body='Partial migration';")
            raise RuntimeError("Simulated migration failure")

        with (
            patch("claudesk.core.db.migrations._migrate", side_effect=fail_after_committed_write),
            self.assertRaisesRegex(RuntimeError, "Database migration failed") as raised,
        ):
            init_db(self.conn)

        backups = list((Path(self.tmpdir.name) / "backups").glob("*.db"))
        self.assertEqual(len(backups), 1)
        self.assertIn(str(backups[0]), str(raised.exception))
        self.assertEqual(self.conn.execute("SELECT body FROM notes WHERE id=?", (note.id,)).fetchone()[0], "Partial migration")
        with closing(sqlite3.connect(backups[0])) as backup:
            self.assertEqual(backup.execute("SELECT body FROM notes WHERE id=?", (note.id,)).fetchone()[0], "Before migration")
            self.assertEqual(backup.execute("SELECT MAX(version) FROM schema_version").fetchone()[0], 41)

        recovery_dir = Path(self.tmpdir.name) / "recovered-vault"
        recovery_dir.mkdir()
        recovery_path = recovery_dir / "claudesk.db"
        recovery_path.write_bytes(backups[0].read_bytes())
        with closing(make_conn(str(recovery_path))) as recovered:
            init_db(recovered)
            self.assertEqual(recovered.execute("SELECT body FROM notes WHERE id=?", (note.id,)).fetchone()[0], "Before migration")
            self.assertEqual(recovered.execute("SELECT MAX(version) FROM schema_version").fetchone()[0], SCHEMA_VERSION)

    def test_new_current_and_in_memory_databases_do_not_create_backups(self) -> None:
        with patch("claudesk.core.db.connection.tempfile.NamedTemporaryFile") as backup_file:
            init_db(self.conn)
            with closing(make_conn(str(Path(self.tmpdir.name) / "empty.db"))) as empty:
                init_db(empty)
            with closing(make_conn(":memory:")) as memory:
                memory.execute("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)")
                memory.execute("INSERT INTO schema_version (version) VALUES (41)")
                memory.commit()
                init_db(memory)
                self.assertEqual(memory.execute("SELECT MAX(version) FROM schema_version").fetchone()[0], SCHEMA_VERSION)
        backup_file.assert_not_called()
        self.assertFalse((Path(self.tmpdir.name) / "backups").exists())

    def test_chat_workflow_errors_are_typed(self) -> None:
        with self.assertRaisesRegex(NotFoundError, "Chat session 999 not found"):
            get_chat_session_or_raise(self.conn, 999)

        with self.assertRaisesRegex(ValidationError, "Unsupported attachment type"):
            prepare_chat_attachment_upload(
                kind="file",
                file_obj=BytesIO(b"\0\1"),
                filename="blob.bin",
                mime_type="application/octet-stream",
                text=None,
            )

    def test_chat_runtime_settings_are_isolated_and_clear_only_changed_provider_state(self) -> None:
        first_settings = ChatRuntimeSettings(
            backend="codex_cli", model="custom-codex", reasoning_effort="high",
        )
        second_settings = ChatRuntimeSettings(
            backend="gemini_api", model="custom-gemini", temperature=0.3,
        )
        first = create_chat_session(self.conn, runtime_settings=first_settings)
        second = create_chat_session(self.conn, runtime_settings=second_settings)
        append_chat_message(self.conn, first.id, role="user", content="Keep this transcript")
        update_chat_session_provider_state(self.conn, first.id, "codex_cli", {"thread_id": "old-thread"})
        self.conn.commit()

        update_chat_session(self.conn, first.id, runtime_settings=first_settings, title="Renamed")
        self.assertEqual(
            get_chat_session_provider_state(self.conn, first.id),
            {"codex_cli": {"thread_id": "old-thread"}},
        )
        replacement = ChatRuntimeSettings(backend="openai_api", model="custom-openai", temperature=0.2)
        updated = update_chat_session(self.conn, first.id, runtime_settings=replacement)
        self.conn.commit()

        self.assertEqual(updated.runtime_settings.model_dump(), replacement.model_dump())
        self.assertEqual(get_chat_session_provider_state(self.conn, first.id), {})
        self.assertEqual(
            get_chat_session_detail(self.conn, second.id).runtime_settings.model_dump(),
            second_settings.model_dump(),
        )
        self.assertEqual(
            get_chat_session_detail(self.conn, first.id).messages[0].content,
            "Keep this transcript",
        )
        cleared = clear_chat_session_messages(self.conn, first.id)
        self.assertEqual(cleared.runtime_settings.model_dump(), replacement.model_dump())
        self.assertEqual(cleared.messages, [])

    def test_chat_runtime_update_rejects_invalid_settings_without_mutation(self) -> None:
        settings = ChatRuntimeSettings(backend="codex_cli", model="custom-codex")
        session = create_chat_session(self.conn, runtime_settings=settings)
        update_chat_session_provider_state(self.conn, session.id, "codex_cli", {"thread_id": "thread"})
        self.conn.commit()

        with self.assertRaises(ValueError):
            update_chat_session(self.conn, session.id, runtime_settings={"backend": "unsupported"})
        self.assertEqual(get_chat_session_detail(self.conn, session.id).runtime_settings, settings)
        self.assertEqual(
            get_chat_session_provider_state(self.conn, session.id),
            {"codex_cli": {"thread_id": "thread"}},
        )

    def test_session_runtime_config_overrides_global_runtime_without_mutating_policy(self) -> None:
        global_cfg = Config(chat=ChatConfig(
            backend="codex_cli",
            model="global-codex",
            reasoning_effort="high",
            reasoning_summary="detailed",
            service_tier="fast",
            system_prompt_addendum="Global instructions",
            tools=ChatToolsConfig(task_write=False),
            codex_native_shell_tools=True,
        ))
        original = global_cfg.model_dump()
        settings = ChatRuntimeSettings(backend="gemini_api", model="session-gemini", temperature=0.2)

        effective = config_for_chat_session(global_cfg, settings)

        self.assertEqual(effective.chat.runtime_settings().model_dump(), settings.model_dump())
        self.assertEqual(effective.chat.system_prompt_addendum, "Global instructions")
        self.assertFalse(effective.chat.tools.task_write)
        self.assertTrue(effective.chat.codex_native_shell_tools)
        self.assertEqual(global_cfg.model_dump(), original)
        effective.chat.tools.task_write = True
        self.assertFalse(global_cfg.chat.tools.task_write)

    def test_v41_runtime_migration_preserves_chat_data_and_initializes_settings_once(self) -> None:
        note = create_note(self.conn, title="Migration note", body="Preserved research")
        project = create_project(self.conn, name="Migration project")
        session = create_chat_session(
            self.conn,
            runtime_settings=ChatRuntimeSettings(),
            title="Existing conversation",
            project_ids=[project.id],
            linked_paper_ids=[42],
        )
        message = append_chat_message(
            self.conn, session.id, role="user", content="Existing transcript",
            context_items=[ChatContextItem(kind="paper", source="active_ui", ref=ChatContextRef(paper_id=42), label="Paper")],
        )
        insert_chat_resource_reads(
            self.conn, session.id, turn_id="old-turn", provider="codex_cli", source="prompt_context",
            reads=[{"resource_kind": "paper", "resource_id": 42, "label": "Paper"}],
        )
        attachment = create_chat_attachment(
            self.conn, session.id, context_kind="clipboard_text", kind=AssetKind.TEXT, source="chat",
            managed_path="sessions/migration/text.txt", original_filename="text.txt", display_name="Text",
            mime_type="text/plain", size_bytes=4, content_hash="migration-hash", parsed_text="Text",
        )
        update_chat_session_provider_state(self.conn, session.id, "codex_cli", {"thread_id": "old-thread"})
        self.conn.execute("ALTER TABLE chat_sessions DROP COLUMN runtime_settings")
        self.conn.execute("DELETE FROM schema_version")
        self.conn.execute("INSERT INTO schema_version (version) VALUES (41)")
        self.conn.commit()
        defaults = Config(chat=ChatConfig(backend="codex_cli", model="migration-model", reasoning_effort="high"))

        with patch("claudesk.core.db.migrations.load_config", return_value=defaults):
            init_db(self.conn)

        backups = list((Path(self.tmpdir.name) / "backups").glob("*.db"))
        self.assertEqual(len(backups), 1)
        with closing(sqlite3.connect(backups[0])) as backup:
            self.assertEqual(backup.execute("SELECT MAX(version) FROM schema_version").fetchone()[0], 41)
            self.assertEqual(backup.execute("SELECT body FROM notes WHERE id=?", (note.id,)).fetchone()[0], "Preserved research")
            self.assertNotIn("runtime_settings", {row[1] for row in backup.execute("PRAGMA table_info(chat_sessions)")})

        migrated = get_chat_session_detail(self.conn, session.id)
        self.assertEqual(migrated.runtime_settings.model_dump(), defaults.chat.runtime_settings().model_dump())
        self.assertEqual(migrated.title, session.title)
        self.assertEqual(migrated.created_at, session.created_at)
        self.assertEqual(migrated.updated_at, session.updated_at)
        self.assertEqual(migrated.project_ids, [project.id])
        self.assertEqual(migrated.linked_paper_ids, [42])
        self.assertEqual(migrated.messages[0].id, message.id)
        self.assertEqual(migrated.messages[0].content, "Existing transcript")
        self.assertEqual(migrated.messages[0].context_items[0].ref.paper_id, 42)
        self.assertEqual(list_chat_attachments(self.conn, session.id)[0].asset.id, attachment.asset.id)
        self.assertEqual(list_chat_resource_reads(self.conn, session.id)[0].turn_id, "old-turn")
        self.assertEqual(get_chat_session_provider_state(self.conn, session.id), {})
        self.assertEqual(self.conn.execute("PRAGMA foreign_key_check").fetchall(), [])

        replacement = ChatRuntimeSettings(backend="anthropic_api", model="new-session-model", temperature=0.4)
        update_chat_session(self.conn, session.id, runtime_settings=replacement)
        update_chat_session_provider_state(self.conn, session.id, "codex_cli", {"thread_id": "new-thread"})
        self.conn.commit()
        with patch("claudesk.core.db.migrations.load_config", return_value=Config()):
            init_db(self.conn)
        self.assertEqual(list((Path(self.tmpdir.name) / "backups").glob("*.db")), backups)
        self.assertEqual(get_chat_session_detail(self.conn, session.id).runtime_settings, replacement)
        self.assertEqual(get_chat_session_provider_state(self.conn, session.id), {"codex_cli": {"thread_id": "new-thread"}})

    def test_chat_session_crud_and_cascade_delete(self) -> None:
        project = create_project(self.conn, name="Chat Project")
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings(), project_ids=[project.id or 0])
        renamed = rename_chat_session(self.conn, session.id or 0, "Renamed session")
        linked = update_chat_session_links(
            self.conn,
            renamed.id or 0,
            linked_paper_ids=[7, 7, 9],
            linked_todo_ids=[3],
            linked_progress_ids=[5],
        )

        append_chat_message(
            self.conn,
            linked.id or 0,
            role="user",
            content="Hello",
            context_items=[
                ChatContextItem(
                    kind="paper",
                    source="active_ui",
                    ref=ChatContextRef(paper_id=42),
                    label="Context Paper",
                )
            ],
        )
        append_chat_message(
            self.conn,
            linked.id or 0,
            role="assistant",
            content="Hi there",
            trace_entries=[
                ChatTraceEntry(
                    type="tool_result",
                    status="done",
                    label="search papers",
                    name="search_papers",
                    summary="[]",
                )
            ],
        )
        insert_chat_resource_reads(
            self.conn,
            linked.id or 0,
            turn_id="turn-cascade",
            provider="test",
            source="prompt_context",
            reads=[
                {
                    "resource_kind": "paper",
                    "resource_id": 42,
                    "label": "Context Paper",
                    "locator": {"paper_id": 42},
                }
            ],
        )
        create_chat_attachment(
            self.conn,
            linked.id or 0,
            context_kind="clipboard_text",
            kind=AssetKind.TEXT,
            source="chat",
            managed_path="sessions/1/clip.txt",
            original_filename="clip.txt",
            display_name="Pasted text",
            mime_type="text/plain",
            size_bytes=12,
            content_hash="sha256-clip",
            parsed_text="hello world",
        )
        touch_chat_session(self.conn, linked.id or 0)
        self.conn.commit()

        detail = get_chat_session_detail(self.conn, linked.id or 0)
        sessions = list_chat_sessions(self.conn)

        self.assertEqual(linked.title, "Renamed session")
        self.assertEqual(linked.linked_paper_ids, [7, 9])
        self.assertEqual(linked.linked_todo_ids, [3])
        self.assertEqual(linked.linked_progress_ids, [5])
        self.assertEqual(linked.project_ids, [project.id])
        self.assertIsNotNone(detail)
        self.assertEqual([message.role for message in detail.messages], ["user", "assistant"])
        self.assertEqual(detail.messages[0].context_items[0].kind, "paper")
        self.assertEqual(detail.messages[0].context_items[0].ref.paper_id, 42)
        self.assertEqual(detail.messages[1].context_items, [])
        self.assertEqual(detail.messages[1].trace_entries[0].name, "search_papers")
        self.assertEqual(sessions[0].id, linked.id)

        delete_chat_session(self.conn, linked.id or 0)
        self.conn.commit()

        self.assertIsNone(get_chat_session_detail(self.conn, linked.id or 0))
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM chat_messages").fetchone()[0],
            0,
        )
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM chat_resource_reads").fetchone()[0],
            0,
        )
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM chat_attachments").fetchone()[0],
            0,
        )
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM assets").fetchone()[0],
            0,
        )
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM project_chat_sessions").fetchone()[0],
            0,
        )

    def test_chat_attachment_helpers_attach_delete_and_cleanup_owned_assets(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        text = create_chat_attachment(
            self.conn,
            session.id or 0,
            context_kind="clipboard_text",
            kind=AssetKind.TEXT,
            source="chat",
            managed_path="sessions/1/clipboard.txt",
            original_filename="clipboard.txt",
            display_name="Pasted text",
            mime_type="text/plain",
            size_bytes=12,
            content_hash="sha256-clipboard",
            parsed_text="pasted text",
        )
        image = create_chat_attachment(
            self.conn,
            session.id or 0,
            context_kind="file",
            kind=AssetKind.ATTACHMENT,
            source="chat",
            managed_path="sessions/1/image.png",
            original_filename="image.png",
            display_name="image.png",
            mime_type="image/png",
            size_bytes=128,
            content_hash="sha256-image",
        )
        screenshot = create_chat_attachment(
            self.conn,
            session.id or 0,
            context_kind="screenshot",
            kind=AssetKind.ATTACHMENT,
            source="chat",
            managed_path="sessions/1/screenshot.png",
            original_filename="screenshot.png",
            display_name="Screenshot",
            mime_type="image/png",
            size_bytes=256,
            content_hash="sha256-screenshot",
        )
        pdf = create_chat_attachment(
            self.conn,
            session.id or 0,
            context_kind="file",
            kind=AssetKind.PDF,
            source="chat",
            managed_path="sessions/1/paper.pdf",
            original_filename="paper.pdf",
            display_name="paper.pdf",
            mime_type="application/pdf",
            size_bytes=512,
            content_hash="sha256-pdf",
        )

        listed = list_chat_attachments(self.conn, session.id or 0)
        self.assertEqual(
            [(item.context_kind, item.asset.kind) for item in listed],
            [
                ("clipboard_text", AssetKind.TEXT),
                ("file", AssetKind.ATTACHMENT),
                ("screenshot", AssetKind.ATTACHMENT),
                ("file", AssetKind.PDF),
            ],
        )
        loaded_text = get_chat_attachment(self.conn, session.id or 0, text.asset.id or 0)
        self.assertIsNotNone(loaded_text)
        self.assertEqual(loaded_text.asset.parsed_text, "pasted text")

        user_message = append_chat_message(self.conn, session.id or 0, role="user", content="Use these")
        attached = attach_chat_attachments_to_message(
            self.conn,
            session.id or 0,
            [pdf.asset.id or 0, image.asset.id or 0, image.asset.id or 0],
            user_message.id or 0,
        )
        self.assertEqual(
            [attachment.asset.id for attachment in attached],
            [image.asset.id, pdf.asset.id],
        )
        pending = list_chat_attachments(self.conn, session.id or 0, pending_only=True)
        self.assertEqual(
            [attachment.asset.id for attachment in pending],
            [text.asset.id, screenshot.asset.id],
        )
        with self.assertRaisesRegex(ValueError, "Pending chat attachment"):
            delete_pending_chat_attachment(self.conn, session.id or 0, image.asset.id or 0)

        deleted = delete_pending_chat_attachment(self.conn, session.id or 0, screenshot.asset.id or 0)
        self.assertEqual(deleted.asset.display_name, "Screenshot")
        self.assertIsNone(get_asset(self.conn, screenshot.asset.id or 0))
        self.assertIsNone(get_chat_attachment(self.conn, session.id or 0, screenshot.asset.id or 0))

        clear_chat_session_messages(self.conn, session.id or 0)
        self.assertEqual(list_chat_attachments(self.conn, session.id or 0), [])
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM assets").fetchone()[0],
            0,
        )

    def test_store_managed_chat_attachment_sanitizes_paths_and_enforces_limits(self) -> None:
        cfg = Config()
        session_id = 77
        text_file = store_managed_chat_attachment(
            session_id=session_id,
            file_obj=BytesIO(b"hello"),
            filename="../../unsafe name.txt",
            mime_type="text/plain",
            max_bytes=CHAT_ATTACHMENT_MAX_TEXT_BYTES,
            cfg=cfg,
        )
        image_file = store_managed_chat_attachment(
            session_id=session_id,
            file_obj=BytesIO(b"\x89PNG\r\n"),
            filename="shot",
            mime_type="image/png",
            max_bytes=CHAT_ATTACHMENT_MAX_IMAGE_BYTES,
            default_filename="screenshot.png",
            cfg=cfg,
        )
        pdf_file = store_managed_chat_attachment(
            session_id=session_id,
            file_obj=BytesIO(b"%PDF-1.7\n"),
            filename="paper.pdf",
            mime_type="application/pdf",
            max_bytes=CHAT_ATTACHMENT_MAX_PDF_BYTES,
            cfg=cfg,
        )

        expected_bytes = {
            text_file.managed_path: b"hello",
            image_file.managed_path: b"\x89PNG\r\n",
            pdf_file.managed_path: b"%PDF-1.7\n",
        }
        for stored in (text_file, image_file, pdf_file):
            self.assertTrue(stored.managed_path.startswith(f"sessions/{session_id}/"))
            resolved = resolve_chat_attachment_path(stored.managed_path, cfg=cfg)
            self.assertTrue(resolved.exists())
            self.assertEqual(resolved.read_bytes(), expected_bytes[stored.managed_path])
        self.assertTrue(text_file.managed_path.endswith(".txt"))
        self.assertTrue(image_file.managed_path.endswith(".png"))
        self.assertTrue(pdf_file.managed_path.endswith(".pdf"))

        with self.assertRaisesRegex(InvalidPaperAssetFile, "size limit"):
            store_managed_chat_attachment(
                session_id=session_id,
                file_obj=BytesIO(b"too large"),
                filename="large.txt",
                mime_type="text/plain",
                max_bytes=4,
                cfg=cfg,
            )

    def test_chat_resource_read_ledger_helpers(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        user_message = append_chat_message(
            self.conn,
            session.id or 0,
            role="user",
            content="Read these",
        )
        assistant_message = append_chat_message(
            self.conn,
            session.id or 0,
            role="assistant",
            content="Result",
        )
        turn_id = "turn-ledger"

        inserted = insert_chat_resource_reads(
            self.conn,
            session.id or 0,
            turn_id=turn_id,
            provider="openai_api",
            source="capability_result",
            capability_name="get_papers_by_ids",
            reads=[
                {
                    "resource_kind": "paper",
                    "resource_id": 11,
                    "label": "First paper",
                    "summary": "Exact paper metadata returned.",
                    "locator": {"paper_id": 11},
                },
                {
                    "resource_kind": "note",
                    "resource_id": "7",
                    "label": "Linked note",
                    "locator": {"note_id": 7, "paper_id": 11},
                },
            ],
        )

        self.assertEqual([read.resource_kind for read in inserted], ["paper", "note"])
        self.assertEqual(inserted[0].session_id, session.id)
        self.assertIsNone(inserted[0].assistant_message_id)
        self.assertEqual(inserted[0].resource_id, "11")
        self.assertEqual(inserted[0].locator, {"paper_id": 11})

        attached = attach_chat_resource_reads_to_message(
            self.conn,
            session.id or 0,
            turn_id,
            assistant_message.id or 0,
        )
        self.assertEqual([read.assistant_message_id for read in attached], [assistant_message.id, assistant_message.id])
        self.assertEqual(
            [read.label for read in list_chat_resource_reads(self.conn, session.id or 0)],
            ["First paper", "Linked note"],
        )
        self.assertEqual(
            [read.resource_kind for read in list_chat_resource_reads(
                self.conn,
                session.id or 0,
                assistant_message_id=assistant_message.id,
            )],
            ["paper", "note"],
        )

        insert_chat_resource_reads(
            self.conn,
            session.id or 0,
            turn_id="turn-cleanup",
            provider="openai_api",
            source="prompt_context",
            reads=[{"resource_kind": "paper", "resource_id": 99, "label": "Stale"}],
        )
        delete_chat_resource_reads_for_turn(self.conn, session.id or 0, "turn-cleanup")
        self.assertEqual(
            [read.label for read in list_chat_resource_reads(self.conn, session.id or 0)],
            ["First paper", "Linked note"],
        )

        clear_chat_session_messages(self.conn, session.id or 0)
        self.assertEqual(list_chat_resource_reads(self.conn, session.id or 0), [])
        self.assertIsNotNone(user_message.id)

    def test_chat_message_optional_json_fields_default_to_empty_for_minimal_inserts(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        self.conn.execute(
            """
            INSERT INTO chat_messages (session_id, role, content, created_at)
            VALUES (?, 'user', ?, ?)
            """,
            (session.id, "Legacy insert", date(2026, 5, 1).isoformat()),
        )
        self.conn.commit()

        detail = get_chat_session_detail(self.conn, session.id or 0)

        self.assertIsNotNone(detail)
        self.assertEqual(detail.messages[0].context_items, [])
        self.assertEqual(detail.messages[0].trace_entries, [])

    def test_chat_message_invalid_trace_entries_default_to_empty(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        self.conn.execute(
            """
            INSERT INTO chat_messages (session_id, role, content, trace_entries, created_at)
            VALUES (?, 'assistant', ?, ?, ?)
            """,
            (session.id, "Invalid trace", "not json", date(2026, 5, 1).isoformat()),
        )
        self.conn.commit()

        detail = get_chat_session_detail(self.conn, session.id or 0)

        self.assertIsNotNone(detail)
        self.assertEqual(detail.messages[0].trace_entries, [])

    def test_resolve_chat_context_items_validates_refs_and_builds_prompt_context(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper(title="Context Paper"))
        project = create_project(self.conn, name="Context Project")
        note = create_note(self.conn, title="Context Note", body="Important note body", manual_paper_ids=[paper_id])
        assets_root = os.path.join(self.tmpdir.name, "assets")
        managed_path = "papers/context.pdf"
        full_path = os.path.join(assets_root, managed_path)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "wb") as fh:
            fh.write(b"%PDF-1.7\n")
        asset = create_paper_asset(
            self.conn,
            paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path=managed_path,
            original_filename="context.pdf",
            display_name="Context PDF",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-context",
            parse_status=AssetParseStatus.PARSED,
        )

        resolved = resolve_chat_context_items(
            self.conn,
            [
                ChatContextItem(kind="paper", source="active_ui", ref=ChatContextRef(paper_id=paper_id), label="stale"),
                ChatContextItem(kind="paper", source="active_ui", ref=ChatContextRef(paper_id=paper_id), label="duplicate"),
                ChatContextItem(kind="project", source="active_ui", ref=ChatContextRef(project_id=project.id)),
                ChatContextItem(kind="note", source="active_ui", ref=ChatContextRef(note_id=note.id)),
                ChatContextItem(
                    kind="pdf_asset",
                    source="active_ui",
                    ref=ChatContextRef(paper_id=paper_id, asset_id=asset.id),
                ),
            ],
            cfg=Config(),
        )

        self.assertEqual([item.kind for item in resolved], ["paper", "project", "note", "pdf_asset"])
        self.assertEqual(resolved[0].label, "Context Paper")
        self.assertEqual(resolved[1].label, "Context Project")
        self.assertEqual(resolved[2].label, "Context Note")
        self.assertEqual(resolved[3].label, "Context PDF")
        self.assertEqual(paper_ids_from_chat_context(resolved), [paper_id])
        self.assertEqual(project_ids_from_chat_context(resolved), [project.id])
        self.assertEqual(note_ids_from_chat_context(resolved), [note.id])
        prompt_block = chat_context_prompt_block(resolved)
        self.assertIn(f"Paper {paper_id}: Context Paper", prompt_block)
        self.assertIn(f"Project {project.id}: Context Project", prompt_block)
        self.assertIn("Call get_project_context", prompt_block)
        self.assertIn(f"Note {note.id}: Context Note", prompt_block)
        self.assertIn("Call get_note_context", prompt_block)
        self.assertIn(f"PDF asset {asset.id} for paper {paper_id}: Context PDF", prompt_block)

    def test_resolve_chat_context_items_rejects_missing_future_and_too_many_items(self) -> None:
        with self.assertRaisesRegex(ValueError, "Paper 999 not found"):
            resolve_chat_context_items(
                self.conn,
                [ChatContextItem(kind="paper", source="active_ui", ref=ChatContextRef(paper_id=999))],
            )

        with self.assertRaisesRegex(ValueError, "requires a chat session id"):
            resolve_chat_context_items(
                self.conn,
                [
                    ChatContextItem(
                        kind="clipboard_text",
                        source="paste",
                        ref=ChatContextRef(asset_id=1),
                        label="Pasted text",
                    )
                ],
            )

        with self.assertRaisesRegex(ValueError, "At most"):
            resolve_chat_context_items(
                self.conn,
                [
                    ChatContextItem(kind="paper", source="active_ui", ref=ChatContextRef(paper_id=idx + 1))
                    for idx in range(MAX_CHAT_CONTEXT_ITEMS + 1)
                ],
            )

    def test_resolve_pdf_asset_context_rejects_non_pdf_and_unavailable_files(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper(title="PDF Context Paper"))
        text_asset = create_paper_asset(
            self.conn,
            paper_id,
            kind=AssetKind.TEXT,
            source="manual",
            managed_path="papers/context.txt",
            original_filename="context.txt",
            display_name="Context text",
            mime_type="text/plain",
            size_bytes=12,
            content_hash="sha256-text-context",
        )
        missing_pdf = create_paper_asset(
            self.conn,
            paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path="papers/missing.pdf",
            original_filename="missing.pdf",
            display_name="Missing PDF",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-missing-context",
        )
        unmanaged_pdf = create_paper_asset(
            self.conn,
            paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path=None,
            original_filename="unmanaged.pdf",
            display_name="Unmanaged PDF",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-unmanaged-context",
        )
        invalid_pdf = create_paper_asset(
            self.conn,
            paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path="../escape.pdf",
            original_filename="escape.pdf",
            display_name="Invalid PDF",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-invalid-context",
        )
        cfg = Config()

        with self.assertRaisesRegex(ValueError, "not a PDF"):
            resolve_chat_context_items(
                self.conn,
                [
                    ChatContextItem(
                        kind="pdf_asset",
                        source="active_ui",
                        ref=ChatContextRef(paper_id=paper_id, asset_id=text_asset.id),
                    )
                ],
                cfg=cfg,
            )
        with self.assertRaisesRegex(ValueError, "missing"):
            resolve_chat_context_items(
                self.conn,
                [
                    ChatContextItem(
                        kind="pdf_asset",
                        source="active_ui",
                        ref=ChatContextRef(paper_id=paper_id, asset_id=missing_pdf.id),
                    )
                ],
                cfg=cfg,
            )
        with self.assertRaisesRegex(ValueError, "not_managed"):
            resolve_chat_context_items(
                self.conn,
                [
                    ChatContextItem(
                        kind="pdf_asset",
                        source="active_ui",
                        ref=ChatContextRef(paper_id=paper_id, asset_id=unmanaged_pdf.id),
                    )
                ],
                cfg=cfg,
            )
        with self.assertRaisesRegex(ValueError, "invalid_path"):
            resolve_chat_context_items(
                self.conn,
                [
                    ChatContextItem(
                        kind="pdf_asset",
                        source="active_ui",
                        ref=ChatContextRef(paper_id=paper_id, asset_id=invalid_pdf.id),
                    )
                ],
                cfg=cfg,
            )

    def test_resolve_chat_attachment_context_validates_session_and_builds_prompt(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        other_session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        cfg = Config()

        def write_managed(path: str, content: bytes) -> None:
            full_path = resolve_chat_attachment_path(path, cfg=cfg)
            full_path.parent.mkdir(parents=True, exist_ok=True)
            full_path.write_bytes(content)

        write_managed(f"sessions/{session.id}/clipboard.txt", b"long pasted text")
        write_managed(f"sessions/{session.id}/screenshot.png", b"\x89PNG\r\n")
        write_managed(f"sessions/{session.id}/paper.pdf", b"%PDF-1.7\n")
        text = create_chat_attachment(
            self.conn,
            session.id or 0,
            context_kind="clipboard_text",
            kind=AssetKind.TEXT,
            source="chat",
            managed_path=f"sessions/{session.id}/clipboard.txt",
            original_filename="clipboard.txt",
            display_name="Pasted text",
            mime_type="text/plain",
            size_bytes=16,
            content_hash="sha256-clipboard-context",
            parse_status=AssetParseStatus.PARSED,
            parsed_text="long pasted text",
        )
        screenshot = create_chat_attachment(
            self.conn,
            session.id or 0,
            context_kind="screenshot",
            kind=AssetKind.ATTACHMENT,
            source="chat",
            managed_path=f"sessions/{session.id}/screenshot.png",
            original_filename="screenshot.png",
            display_name="Screenshot",
            mime_type="image/png",
            size_bytes=6,
            content_hash="sha256-screenshot-context",
        )
        pdf = create_chat_attachment(
            self.conn,
            session.id or 0,
            context_kind="file",
            kind=AssetKind.PDF,
            source="chat",
            managed_path=f"sessions/{session.id}/paper.pdf",
            original_filename="paper.pdf",
            display_name="paper.pdf",
            mime_type="application/pdf",
            size_bytes=9,
            content_hash="sha256-pdf-context",
        )
        other = create_chat_attachment(
            self.conn,
            other_session.id or 0,
            context_kind="file",
            kind=AssetKind.TEXT,
            source="chat",
            managed_path=f"sessions/{session.id}/clipboard.txt",
            original_filename="other.txt",
            display_name="other.txt",
            mime_type="text/plain",
            size_bytes=5,
            content_hash="sha256-other-context",
        )

        resolved = resolve_chat_context_items(
            self.conn,
            [
                ChatContextItem(kind="clipboard_text", source="paste", ref=ChatContextRef(asset_id=text.asset.id)),
                ChatContextItem(kind="screenshot", source="screenshot", ref=ChatContextRef(asset_id=screenshot.asset.id)),
                ChatContextItem(kind="file", source="user_attached", ref=ChatContextRef(asset_id=pdf.asset.id)),
            ],
            session_id=session.id,
            cfg=cfg,
        )

        self.assertEqual([item.kind for item in resolved], ["clipboard_text", "screenshot", "file"])
        self.assertEqual([item.label for item in resolved], ["Pasted text", "Screenshot", "paper.pdf"])
        self.assertEqual(resolved[2].mime_type, "application/pdf")
        prompt_block = chat_context_prompt_block(resolved)
        self.assertIn("Call get_chat_attachment_context", prompt_block)
        reads = chat_context_resource_reads(resolved)
        self.assertEqual([read.resource_kind for read in reads], ["asset", "asset", "asset"])
        self.assertEqual(reads[0].locator["context_kind"], "clipboard_text")
        self.assertEqual(reads[2].locator["mime_type"], "application/pdf")

        with self.assertRaisesRegex(ValueError, "not found"):
            resolve_chat_context_items(
                self.conn,
                [ChatContextItem(kind="file", source="user_attached", ref=ChatContextRef(asset_id=other.asset.id))],
                session_id=session.id,
                cfg=cfg,
            )
        user_message = append_chat_message(self.conn, session.id or 0, role="user", content="sent")
        attach_chat_attachments_to_message(self.conn, session.id or 0, [text.asset.id or 0], user_message.id or 0)
        with self.assertRaisesRegex(ValueError, "already attached"):
            resolve_chat_context_items(
                self.conn,
                [ChatContextItem(kind="clipboard_text", source="paste", ref=ChatContextRef(asset_id=text.asset.id))],
                session_id=session.id,
                cfg=cfg,
            )

    def test_clear_chat_session_messages_preserves_session_metadata_and_projects(self) -> None:
        project = create_project(self.conn, name="Project Alpha")
        session = create_chat_session(
            self.conn,
            runtime_settings=ChatRuntimeSettings(),
            title="Keep metadata",
            project_ids=[project.id or 0],
            linked_paper_ids=[10, 11],
            linked_todo_ids=[12],
            linked_progress_ids=[13],
        )
        update_chat_session_provider_state(
            self.conn,
            session.id or 0,
            "codex_cli",
            {"thread_id": "thread-1", "updated_at": "2026-04-28T00:00:00"},
        )
        append_chat_message(self.conn, session.id or 0, role="user", content="Hello")
        append_chat_message(self.conn, session.id or 0, role="assistant", content="Hi")
        self.conn.commit()

        cleared = clear_chat_session_messages(self.conn, session.id or 0)
        self.conn.commit()
        detail = get_chat_session_detail(self.conn, session.id or 0)

        self.assertEqual(cleared.id, session.id)
        self.assertEqual(cleared.messages, [])
        self.assertIsNotNone(detail)
        self.assertEqual(detail.title, "Keep metadata")
        self.assertEqual(detail.project_ids, [project.id])
        self.assertEqual(detail.linked_paper_ids, [10, 11])
        self.assertEqual(detail.linked_todo_ids, [12])
        self.assertEqual(detail.linked_progress_ids, [13])
        self.assertEqual(
            get_chat_session_provider_state(self.conn, session.id or 0)["codex_cli"]["thread_id"],
            "thread-1",
        )
        self.assertEqual(
            self.conn.execute(
                "SELECT COUNT(*) FROM chat_sessions WHERE id=?",
                (session.id,),
            ).fetchone()[0],
            1,
        )
        self.assertEqual(
            self.conn.execute(
                "SELECT COUNT(*) FROM chat_messages WHERE session_id=?",
                (session.id,),
            ).fetchone()[0],
            0,
        )

    def test_clear_empty_chat_session_succeeds(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings(), title="Empty")
        self.conn.commit()

        cleared = clear_chat_session_messages(self.conn, session.id or 0)
        self.conn.commit()

        self.assertEqual(cleared.id, session.id)
        self.assertEqual(cleared.messages, [])

    def test_clear_missing_chat_session_raises(self) -> None:
        with self.assertRaises(ValueError):
            clear_chat_session_messages(self.conn, 999)

    def test_chat_session_provider_state_is_internal_json(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings(), title="Provider state")
        self.conn.commit()

        self.assertEqual(get_chat_session_provider_state(self.conn, session.id or 0), {})

        update_chat_session_provider_state(
            self.conn,
            session.id or 0,
            "codex_cli",
            {
                "thread_id": "thread-abc",
                "session_file_path": "/tmp/thread.jsonl",
                "updated_at": "2026-04-28T00:00:00",
            },
        )
        self.conn.commit()

        detail = get_chat_session_detail(self.conn, session.id or 0)
        raw = self.conn.execute(
            "SELECT provider_state FROM chat_sessions WHERE id=?",
            (session.id,),
        ).fetchone()[0]
        self.assertEqual(json.loads(raw)["codex_cli"]["thread_id"], "thread-abc")
        self.assertIsNotNone(detail)
        self.assertNotIn("provider_state", detail.model_dump())


class ChatApiTests(unittest.TestCase):
    @staticmethod
    async def read_streaming_response(response) -> str:
        chunks: list[str] = []
        async for chunk in response.body_iterator:
            if isinstance(chunk, bytes):
                chunks.append(chunk.decode())
            else:
                chunks.append(chunk)
        return "".join(chunks)

    @staticmethod
    def streaming_events(payload: str) -> list[dict]:
        events: list[dict] = []
        for line in payload.splitlines():
            if not line.startswith("data: "):
                continue
            events.append(json.loads(line.removeprefix("data: ")))
        return events

    def patch_provider_stream(self, fake_chat_stream):
        async def fake_provider_stream(request):
            async for event in fake_chat_stream(
                request.messages,
                [],
                request.cfg,
                session_id=request.session_id,
                provider_state=request.provider_state,
                update_provider_state=request.update_provider_state,
            ):
                yield event

        return patch.object(self.chat_api, "provider_stream", new=fake_provider_stream)

    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.env_patcher = patch.dict(os.environ, {"CLAUDESK_DATA_DIR": self.tmpdir.name})
        self.env_patcher.start()
        clear_vault_location_cache()
        load_config.cache_clear()

        from claudesk.api import chat as chat_api

        self.chat_api = chat_api
        self.conn = make_conn(os.path.join(self.tmpdir.name, "claudesk.db"))
        init_db(self.conn)

    def tearDown(self) -> None:
        load_config.cache_clear()
        self.conn.close()
        self.env_patcher.stop()
        clear_vault_location_cache()
        self.tmpdir.cleanup()

    def test_model_discovery_route_validates_backend_and_forwards_refresh(self) -> None:
        import httpx
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(self.chat_api.router, prefix="/api")
        cfg = Config()
        result = {"backend": "codex_cli", "status": "ready", "models": [], "error": None, "fetched_at": "2026-09-14T00:00:00Z"}

        async def check():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                with patch.object(self.chat_api, "load_config", return_value=cfg), patch.object(
                    self.chat_api, "list_chat_models", new=AsyncMock(return_value=result),
                ) as discovery:
                    response = await client.get("/api/chat/models?backend=codex_cli&refresh=true")
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.json(), result)
                    discovery.assert_awaited_once_with(cfg, "codex_cli", refresh=True)
                    discovery.reset_mock()
                    response = await client.get("/api/chat/models?backend=not-a-backend")
                    self.assertEqual(response.status_code, 422)
                    discovery.assert_not_awaited()

        asyncio.run(check())
        self.assertEqual(list_chat_sessions(self.conn), [])

    def test_create_session_snapshots_defaults_and_accepts_explicit_runtime(self) -> None:
        first_defaults = Config(chat=ChatConfig(backend="codex_cli", model="first-model", reasoning_effort="high"))
        second_defaults = Config(chat=ChatConfig(backend="gemini_api", model="second-model", temperature=0.3))
        with patch.object(self.chat_api, "load_config", return_value=first_defaults):
            first = self.chat_api.create_chat_session_endpoint(self.chat_api.CreateChatSessionRequest(), conn=self.conn)
        with patch.object(self.chat_api, "load_config", return_value=second_defaults):
            second = self.chat_api.create_chat_session_endpoint(self.chat_api.CreateChatSessionRequest(), conn=self.conn)
            explicit = ChatRuntimeSettings(backend="anthropic_api", model="explicit-model", temperature=0.4)
            third = self.chat_api.create_chat_session_endpoint(
                self.chat_api.CreateChatSessionRequest(runtime_settings=explicit), conn=self.conn,
            )

        self.assertEqual(first["runtime_settings"], first_defaults.chat.runtime_settings().model_dump())
        self.assertEqual(second["runtime_settings"], second_defaults.chat.runtime_settings().model_dump())
        self.assertEqual(third["runtime_settings"], explicit.model_dump())
        self.assertEqual(
            get_chat_session_detail(self.conn, first["id"]).runtime_settings.model_dump(),
            first["runtime_settings"],
        )
        self.assertEqual(first["messages"], [])
        self.assertNotIn("provider_state", first)

    def test_all_backends_stream_with_saved_runtime_and_current_global_policy(self) -> None:
        global_cfg = Config(chat=ChatConfig(
            backend="codex_cli", model="unrelated-global-model", reasoning_effort="low",
            system_prompt_addendum="Current global instructions",
            tools=ChatToolsConfig(task_write=False),
        ))
        original = global_cfg.model_dump()
        captured = []

        async def fake_provider_stream(request):
            captured.append(request)
            yield {"type": "text", "content": "Stored settings used."}

        settings_by_backend = [
            ChatRuntimeSettings(backend="openai_api", model="custom-openai", temperature=0.2, service_tier="priority"),
            ChatRuntimeSettings(backend="gemini_api", model="custom-gemini", temperature=0.4),
            ChatRuntimeSettings(backend="anthropic_api", model="custom-anthropic", temperature=0.6),
            ChatRuntimeSettings(backend="codex_cli", model="custom-codex", reasoning_effort="high", reasoning_summary="concise"),
        ]
        with (
            patch.object(self.chat_api, "load_config", return_value=global_cfg),
            patch.object(self.chat_api, "provider_stream", new=fake_provider_stream),
        ):
            for settings in settings_by_backend:
                with self.subTest(backend=settings.backend):
                    session = create_chat_session(self.conn, runtime_settings=settings)
                    self.conn.commit()
                    response = asyncio.run(self.chat_api.stream_chat_message(
                        session.id, self.chat_api.CreateChatMessageRequest(content="Hello"), conn=self.conn,
                    ))
                    asyncio.run(self.read_streaming_response(response))
                    self.assertEqual(captured[-1].cfg.chat.runtime_settings().model_dump(), settings.model_dump())
                    self.assertEqual(captured[-1].cfg.chat.system_prompt_addendum, "Current global instructions")
                    self.assertNotIn("add_task", captured[-1].allowed_capabilities)
                    self.assertNotIn(session.id, self.chat_api._active_chat_turns)
        self.assertEqual(len(captured), 4)
        self.assertEqual(global_cfg.model_dump(), original)

    def test_supplied_runtime_requests_require_the_complete_backend_object(self) -> None:
        for request_type in (self.chat_api.CreateChatSessionRequest, self.chat_api.UpdateChatSessionRequest):
            for backend in ("openai_api", "gemini_api", "anthropic_api", "codex_cli"):
                settings = ChatRuntimeSettings(backend=backend)
                complete = settings.model_dump()
                with self.subTest(request=request_type.__name__, backend=backend):
                    validated = request_type.model_validate({"runtime_settings": complete})
                    self.assertEqual(validated.runtime_settings.model_dump(), complete)
                    typed = request_type(runtime_settings=settings)
                    self.assertEqual(typed.runtime_settings.model_dump(), complete)
                for missing in complete:
                    with self.subTest(request=request_type.__name__, backend=backend, missing=missing):
                        partial = {key: value for key, value in complete.items() if key != missing}
                        with self.assertRaisesRegex(ValueError, "Runtime settings must include"):
                            request_type.model_validate({"runtime_settings": partial})
        self.assertIsNone(self.chat_api.CreateChatSessionRequest().runtime_settings)
        self.assertIsNone(self.chat_api.CreateChatSessionRequest(runtime_settings=None).runtime_settings)

    def test_session_patch_returns_detail_and_rolls_back_invalid_combined_update(self) -> None:
        initial = ChatRuntimeSettings(backend="codex_cli", model="initial-model")
        session = create_chat_session(self.conn, runtime_settings=initial, title="Original title")
        append_chat_message(self.conn, session.id, role="user", content="Existing transcript")
        update_chat_session_provider_state(self.conn, session.id, "codex_cli", {"thread_id": "thread"})
        self.conn.commit()
        replacement = ChatRuntimeSettings(backend="gemini_api", model="replacement-model", temperature=0.1)

        with self.assertRaises(self.chat_api.HTTPException) as invalid:
            self.chat_api.update_chat_session_endpoint(
                session.id,
                self.chat_api.UpdateChatSessionRequest(
                    title="Should not persist", project_ids=[99999], runtime_settings=replacement,
                ),
                conn=self.conn,
            )
        self.assertEqual(invalid.exception.status_code, 404)
        unchanged = get_chat_session_detail(self.conn, session.id)
        self.assertEqual(unchanged.title, "Original title")
        self.assertEqual(unchanged.runtime_settings, initial)
        self.assertEqual(get_chat_session_provider_state(self.conn, session.id), {"codex_cli": {"thread_id": "thread"}})

        updated = self.chat_api.update_chat_session_endpoint(
            session.id,
            self.chat_api.UpdateChatSessionRequest(title="Updated title", runtime_settings=replacement),
            conn=self.conn,
        )
        self.assertEqual(updated["title"], "Updated title")
        self.assertEqual(updated["runtime_settings"], replacement.model_dump())
        self.assertEqual(updated["messages"][0]["content"], "Existing transcript")
        self.assertEqual(get_chat_session_provider_state(self.conn, session.id), {})
        with self.assertRaises(self.chat_api.HTTPException) as null_settings:
            self.chat_api.update_chat_session_endpoint(
                session.id, self.chat_api.UpdateChatSessionRequest(runtime_settings=None), conn=self.conn,
            )
        self.assertEqual(null_settings.exception.status_code, 400)

    def test_active_turn_blocks_runtime_patch_and_overlapping_turn_then_releases(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        other = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        self.conn.commit()
        replacement = ChatRuntimeSettings(backend="gemini_api", model="after-turn")

        async def fake_provider_stream(request):
            yield {"type": "text", "content": "Finished."}

        with (
            patch.object(self.chat_api, "load_config", return_value=Config()),
            patch.object(self.chat_api, "provider_stream", new=fake_provider_stream),
        ):
            response = asyncio.run(self.chat_api.stream_chat_message(
                session.id, self.chat_api.CreateChatMessageRequest(content="Hello"), conn=self.conn,
            ))
            with self.assertRaises(self.chat_api.HTTPException) as blocked_patch:
                self.chat_api.update_chat_session_endpoint(
                    session.id, self.chat_api.UpdateChatSessionRequest(runtime_settings=replacement), conn=self.conn,
                )
            self.assertEqual(blocked_patch.exception.status_code, 409)
            with self.assertRaises(self.chat_api.HTTPException) as blocked_turn:
                asyncio.run(self.chat_api.stream_chat_message(
                    session.id, self.chat_api.CreateChatMessageRequest(content="Overlapping"), conn=self.conn,
                ))
            self.assertEqual(blocked_turn.exception.status_code, 409)
            self.chat_api.update_chat_session_endpoint(
                other.id, self.chat_api.UpdateChatSessionRequest(runtime_settings=replacement), conn=self.conn,
            )
            asyncio.run(self.read_streaming_response(response))
        self.assertNotIn(session.id, self.chat_api._active_chat_turns)
        updated = self.chat_api.update_chat_session_endpoint(
            session.id, self.chat_api.UpdateChatSessionRequest(runtime_settings=replacement), conn=self.conn,
        )
        self.assertEqual(updated["runtime_settings"], replacement.model_dump())

    def test_provider_failure_releases_turn_and_allows_runtime_update(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        self.conn.commit()

        async def failing_provider_stream(request):
            raise RuntimeError("Provider failed")
            yield

        with (
            patch.object(self.chat_api, "load_config", return_value=Config()),
            patch.object(self.chat_api, "provider_stream", new=failing_provider_stream),
        ):
            response = asyncio.run(self.chat_api.stream_chat_message(
                session.id, self.chat_api.CreateChatMessageRequest(content="Hello"), conn=self.conn,
            ))
            with self.assertRaisesRegex(RuntimeError, "Provider failed"):
                asyncio.run(self.read_streaming_response(response))
        self.assertNotIn(session.id, self.chat_api._active_chat_turns)
        self.assertEqual(get_chat_session_detail(self.conn, session.id).messages, [])
        replacement = ChatRuntimeSettings(backend="codex_cli", model="after-failure")
        updated = self.chat_api.update_chat_session_endpoint(
            session.id, self.chat_api.UpdateChatSessionRequest(runtime_settings=replacement), conn=self.conn,
        )
        self.assertEqual(updated["runtime_settings"], replacement.model_dump())

    def test_transport_disconnect_releases_turn_before_headers_and_during_body(self) -> None:
        for failed_message_type in ("http.response.start", "http.response.body"):
            with self.subTest(failed_message_type=failed_message_type):
                session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
                self.conn.commit()
                provider_calls = []

                async def fake_provider_stream(request):
                    provider_calls.append(request)
                    insert_chat_resource_reads(
                        self.conn, session.id, turn_id=request.turn_id, provider=request.cfg.chat.backend,
                        source="capability_result", capability_name="get_papers_by_ids",
                        reads=[{"resource_kind": "paper", "resource_id": 42, "label": "Pending read"}],
                    )
                    self.conn.commit()
                    yield {"type": "text", "content": "Partial answer"}

                async def send(message):
                    if message["type"] == failed_message_type:
                        raise OSError("Client disconnected")

                async def receive():
                    return {"type": "http.disconnect"}

                async def run_response():
                    response = await self.chat_api.stream_chat_message(
                        session.id, self.chat_api.CreateChatMessageRequest(content="Hello"), conn=self.conn,
                    )
                    with self.assertRaises(ClientDisconnect):
                        await response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send)

                with (
                    patch.object(self.chat_api, "load_config", return_value=Config()),
                    patch.object(self.chat_api, "provider_stream", new=fake_provider_stream),
                ):
                    asyncio.run(run_response())
                self.assertEqual(len(provider_calls), int(failed_message_type == "http.response.body"))
                self.assertNotIn(session.id, self.chat_api._active_chat_turns)
                self.assertEqual(get_chat_session_detail(self.conn, session.id).messages, [])
                self.assertEqual(list_chat_resource_reads(self.conn, session.id), [])
                updated = self.chat_api.update_chat_session_endpoint(
                    session.id,
                    self.chat_api.UpdateChatSessionRequest(runtime_settings=ChatRuntimeSettings(backend="codex_cli")),
                    conn=self.conn,
                )
                self.assertEqual(updated["runtime_settings"]["backend"], "codex_cli")

    def test_completed_response_cleanup_keeps_a_new_turn_reservation(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        self.conn.commit()

        async def fake_provider_stream(request):
            yield {"type": "text", "content": "Answer"}

        async def receive():
            return {"type": "http.disconnect"}

        async def run_responses():
            second_response = None

            async def send_first(message):
                nonlocal second_response
                if message["type"] == "http.response.body" and not message.get("more_body", False):
                    second_response = await self.chat_api.stream_chat_message(
                        session.id, self.chat_api.CreateChatMessageRequest(content="Second turn"), conn=self.conn,
                    )

            async def send_second(message):
                pass

            first_response = await self.chat_api.stream_chat_message(
                session.id, self.chat_api.CreateChatMessageRequest(content="First turn"), conn=self.conn,
            )
            scope = {"type": "http", "asgi": {"spec_version": "2.4"}}
            await first_response(scope, receive, send_first)
            self.assertIsNotNone(second_response)
            self.assertIn(session.id, self.chat_api._active_chat_turns)
            with self.assertRaises(self.chat_api.HTTPException) as blocked:
                self.chat_api.update_chat_session_endpoint(
                    session.id,
                    self.chat_api.UpdateChatSessionRequest(runtime_settings=ChatRuntimeSettings(backend="codex_cli")),
                    conn=self.conn,
                )
            self.assertEqual(blocked.exception.status_code, 409)
            await second_response(scope, receive, send_second)

        with (
            patch.object(self.chat_api, "load_config", return_value=Config()),
            patch.object(self.chat_api, "provider_stream", new=fake_provider_stream),
        ):
            asyncio.run(run_responses())
        self.assertNotIn(session.id, self.chat_api._active_chat_turns)
        self.assertEqual(len(get_chat_session_detail(self.conn, session.id).messages), 4)

    def test_streamed_turn_auto_titles_and_persists_messages(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        self.conn.commit()

        async def fake_chat_stream(messages, tools, cfg, **_kwargs):
            yield {"type": "text", "content": "Stored response."}
            yield {"type": "done", "finish_reason": "stop"}

        with (
            patch.object(self.chat_api, "load_config", return_value=Config(llm=LlmConfig(api_key="test-key", model="test-model"))),
            self.patch_provider_stream(fake_chat_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(content="First line\nSecond line"),
                    conn=self.conn,
                )
            )
            payload = asyncio.run(self.read_streaming_response(response))

        self.assertEqual(response.status_code, 200)
        self.assertIn('"type": "text"', payload)
        self.assertIn('"type": "done"', payload)

        detail = get_chat_session_detail(self.conn, session.id or 0)
        self.assertIsNotNone(detail)
        self.assertEqual(detail.title, "First line Second line")
        self.assertEqual([message.role for message in detail.messages], ["user", "assistant"])
        self.assertEqual(detail.messages[0].content, "First line\nSecond line")
        self.assertEqual(detail.messages[1].content, "Stored response.")
        self.assertEqual(detail.messages[1].trace_entries, [])

    def test_resource_reads_endpoint_scopes_and_filters_rows(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        other_session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        empty_session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        first_assistant = append_chat_message(
            self.conn,
            session.id or 0,
            role="assistant",
            content="First",
        )
        second_assistant = append_chat_message(
            self.conn,
            session.id or 0,
            role="assistant",
            content="Second",
        )
        other_assistant = append_chat_message(
            self.conn,
            other_session.id or 0,
            role="assistant",
            content="Other",
        )
        insert_chat_resource_reads(
            self.conn,
            session.id or 0,
            turn_id="turn-first",
            provider="openai_api",
            source="prompt_context",
            reads=[
                {
                    "resource_kind": "paper",
                    "resource_id": 1,
                    "label": "First read",
                    "locator": {"paper_id": 1},
                }
            ],
            assistant_message_id=first_assistant.id,
        )
        insert_chat_resource_reads(
            self.conn,
            session.id or 0,
            turn_id="turn-second",
            provider="openai_api",
            source="capability_result",
            capability_name="get_note_context",
            reads=[
                {
                    "resource_kind": "note",
                    "resource_id": 2,
                    "label": "Second read",
                    "locator": {"note_id": 2},
                },
                {
                    "resource_kind": "pdf_chunk",
                    "resource_id": "5:12",
                    "label": "Second PDF read",
                    "locator": {"asset_id": 5, "page_number": 4, "chunk_index": 12},
                },
            ],
            assistant_message_id=second_assistant.id,
        )
        insert_chat_resource_reads(
            self.conn,
            other_session.id or 0,
            turn_id="turn-other",
            provider="openai_api",
            source="prompt_context",
            reads=[{"resource_kind": "paper", "resource_id": 3, "label": "Other read"}],
            assistant_message_id=other_assistant.id,
        )

        all_reads = self.chat_api.get_chat_session_resource_reads_endpoint(
            session.id or 0,
            conn=self.conn,
        )
        filtered_reads = self.chat_api.get_chat_session_resource_reads_endpoint(
            session.id or 0,
            assistant_message_id=second_assistant.id,
            conn=self.conn,
        )
        empty_reads = self.chat_api.get_chat_session_resource_reads_endpoint(
            empty_session.id or 0,
            conn=self.conn,
        )

        self.assertEqual([read["label"] for read in all_reads], ["First read", "Second read", "Second PDF read"])
        self.assertNotIn("Other read", [read["label"] for read in all_reads])
        self.assertEqual([read["label"] for read in filtered_reads], ["Second read", "Second PDF read"])
        self.assertEqual([read["assistant_message_id"] for read in filtered_reads], [second_assistant.id, second_assistant.id])
        self.assertEqual([read["capability_name"] for read in filtered_reads], ["get_note_context", "get_note_context"])
        self.assertEqual(filtered_reads[0]["locator"], {"note_id": 2})
        self.assertEqual(
            filtered_reads[1]["locator"],
            {"asset_id": 5, "page_number": 4, "chunk_index": 12},
        )
        self.assertEqual(empty_reads, [])
        with self.assertRaises(self.chat_api.HTTPException) as ctx:
            self.chat_api.get_chat_session_resource_reads_endpoint(999, conn=self.conn)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_chat_attachment_upload_endpoint_accepts_supported_attachment_types(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        cfg = Config()

        with patch.object(self.chat_api, "load_config", return_value=cfg):
            clipboard = self.chat_api.upload_chat_attachment_endpoint(
                session.id or 0,
                kind="clipboard_text",
                file=None,
                text="x" * 8000,
                conn=self.conn,
            )
            text_file = self.chat_api.upload_chat_attachment_endpoint(
                session.id or 0,
                kind="file",
                file=FakeUpload(filename="notes.md", content_type="text/markdown", content=b"# Notes"),
                text=None,
                conn=self.conn,
            )
            image = self.chat_api.upload_chat_attachment_endpoint(
                session.id or 0,
                kind="file",
                file=FakeUpload(filename="figure.png", content_type="image/png", content=b"\x89PNG\r\n"),
                text=None,
                conn=self.conn,
            )
            screenshot = self.chat_api.upload_chat_attachment_endpoint(
                session.id or 0,
                kind="screenshot",
                file=FakeUpload(filename="screen.png", content_type="image/png", content=b"\x89PNG\r\n"),
                text=None,
                conn=self.conn,
            )
            pdf = self.chat_api.upload_chat_attachment_endpoint(
                session.id or 0,
                kind="file",
                file=FakeUpload(filename="paper.pdf", content_type="application/pdf", content=b"%PDF-1.7\n"),
                text=None,
                conn=self.conn,
            )

        self.assertEqual(
            [item["kind"] for item in [clipboard, text_file, image, screenshot, pdf]],
            ["clipboard_text", "file", "file", "screenshot", "file"],
        )
        self.assertEqual(pdf["mime_type"], "application/pdf")
        attachments = list_chat_attachments(self.conn, session.id or 0, pending_only=True)
        self.assertEqual(len(attachments), 5)
        self.assertEqual(
            [attachment.asset.kind for attachment in attachments],
            [
                AssetKind.TEXT,
                AssetKind.MARKDOWN,
                AssetKind.ATTACHMENT,
                AssetKind.ATTACHMENT,
                AssetKind.PDF,
            ],
        )
        for attachment in attachments:
            self.assertIsNotNone(attachment.asset.managed_path)
            full_path = resolve_chat_attachment_path(attachment.asset.managed_path or "", cfg=cfg)
            self.assertTrue(full_path.exists())

    def test_chat_attachment_upload_endpoint_rejects_invalid_inputs(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        cfg = Config()

        with patch.object(self.chat_api, "load_config", return_value=cfg):
            with self.assertRaises(self.chat_api.HTTPException) as missing_session:
                self.chat_api.upload_chat_attachment_endpoint(
                    999,
                    kind="file",
                    file=FakeUpload(filename="notes.txt", content_type="text/plain", content=b"notes"),
                    text=None,
                    conn=self.conn,
                )
            with self.assertRaises(self.chat_api.HTTPException) as invalid_kind:
                self.chat_api.upload_chat_attachment_endpoint(
                    session.id or 0,
                    kind="paperclip",
                    file=FakeUpload(filename="notes.txt", content_type="text/plain", content=b"notes"),
                    text=None,
                    conn=self.conn,
                )
            with self.assertRaises(self.chat_api.HTTPException) as unsupported_type:
                self.chat_api.upload_chat_attachment_endpoint(
                    session.id or 0,
                    kind="file",
                    file=FakeUpload(filename="blob.bin", content_type="application/octet-stream", content=b"\0\1"),
                    text=None,
                    conn=self.conn,
                )
            with self.assertRaises(self.chat_api.HTTPException) as oversize:
                self.chat_api.upload_chat_attachment_endpoint(
                    session.id or 0,
                    kind="clipboard_text",
                    file=None,
                    text="x" * (CHAT_ATTACHMENT_MAX_TEXT_BYTES + 1),
                    conn=self.conn,
                )

        self.assertEqual(missing_session.exception.status_code, 404)
        self.assertEqual(invalid_kind.exception.status_code, 400)
        self.assertEqual(unsupported_type.exception.status_code, 400)
        self.assertEqual(oversize.exception.status_code, 400)

    def test_pending_chat_attachment_delete_endpoint_removes_file_and_row(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        cfg = Config()
        with patch.object(self.chat_api, "load_config", return_value=cfg):
            uploaded = self.chat_api.upload_chat_attachment_endpoint(
                session.id or 0,
                kind="file",
                file=FakeUpload(filename="notes.txt", content_type="text/plain", content=b"notes"),
                text=None,
                conn=self.conn,
            )
            asset_id = uploaded["ref"]["asset_id"]
            attachment = get_chat_attachment(self.conn, session.id or 0, asset_id)
            self.assertIsNotNone(attachment)
            managed_path = attachment.asset.managed_path
            attachment_path = resolve_chat_attachment_path(managed_path or "", cfg=cfg)
            self.assertTrue(attachment_path.exists())

            result = self.chat_api.delete_chat_attachment_endpoint(
                session.id or 0,
                asset_id,
                conn=self.conn,
            )

        self.assertEqual(result, {"ok": True})
        self.assertIsNone(get_chat_attachment(self.conn, session.id or 0, asset_id))
        self.assertFalse(attachment_path.exists())

    def test_app_lifetime_chat_attachment_cleanup_deletes_files_and_expires_context(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        managed_path = f"sessions/{session.id}/ephemeral.txt"
        attachment_path = resolve_chat_attachment_path(managed_path)
        attachment_path.parent.mkdir(parents=True, exist_ok=True)
        attachment_path.write_text("temporary attachment", encoding="utf-8")
        orphan_path = resolve_chat_attachment_path(f"sessions/{session.id}/orphan.txt")
        orphan_path.parent.mkdir(parents=True, exist_ok=True)
        orphan_path.write_text("orphan attachment", encoding="utf-8")
        attachment = create_chat_attachment(
            self.conn,
            session.id or 0,
            context_kind="file",
            kind=AssetKind.TEXT,
            source="chat",
            managed_path=managed_path,
            original_filename="ephemeral.txt",
            display_name="ephemeral.txt",
            mime_type="text/plain",
            size_bytes=20,
            content_hash="sha256-ephemeral",
            parse_status=AssetParseStatus.PARSED,
            parsed_text="temporary attachment",
        )
        context_item = ChatContextItem(
            kind="file",
            source="user_attached",
            ref=ChatContextRef(asset_id=attachment.asset.id),
            label="ephemeral.txt",
            mime_type="text/plain",
            status="ready",
        )
        user_message = append_chat_message(
            self.conn,
            session.id or 0,
            role="user",
            content="Use attachment",
            context_items=[context_item],
        )
        attach_chat_attachments_to_message(
            self.conn,
            session.id or 0,
            [attachment.asset.id or 0],
            user_message.id or 0,
        )
        append_chat_message(
            self.conn,
            session.id or 0,
            role="assistant",
            content="Used attachment",
            trace_entries=[
                ChatTraceEntry(
                    type="context",
                    label="Context",
                    context_items=[context_item],
                )
            ],
        )
        self.conn.commit()

        result = self.chat_api.cleanup_app_lifetime_chat_attachments()

        self.assertEqual(result, {"deleted_chat_attachments": 1})
        self.assertFalse(attachment_path.exists())
        self.assertFalse(orphan_path.exists())
        self.assertFalse(chat_attachments_root(create=False).exists())
        self.assertIsNone(get_asset(self.conn, attachment.asset.id or 0))
        self.assertEqual(list_chat_attachments(self.conn, session.id or 0), [])
        detail = get_chat_session_detail(self.conn, session.id or 0)
        self.assertIsNotNone(detail)
        self.assertEqual(detail.messages[0].context_items[0].status, "expired")
        self.assertEqual(detail.messages[1].trace_entries[0].context_items[0].status, "expired")

    def test_streamed_turn_persists_tool_summaries_and_normalizes_mentions(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        self.conn.commit()
        captured_messages: list[list[dict]] = []

        async def fake_chat_stream(messages, tools, cfg, **_kwargs):
            captured_messages.append([dict(message) for message in messages])
            yield {"type": "text", "content": "Checking. "}
            yield {"type": "tool_start", "name": "get_papers_by_ids"}
            yield {
                "type": "tool_result",
                "name": "get_papers_by_ids",
                "summary": json.dumps({"papers": [{"id": 42, "title": "Tagged Paper"}]}),
            }
            yield {"type": "text", "content": "Found it."}
            yield {"type": "done", "finish_reason": "stop"}

        with (
            patch.object(self.chat_api, "load_config", return_value=Config(llm=LlmConfig(api_key="test-key", model="test-model"))),
            self.patch_provider_stream(fake_chat_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(content="Tell me about [Tagged Paper](paper://42)"),
                    conn=self.conn,
                )
            )
            payload = asyncio.run(self.read_streaming_response(response))

        self.assertEqual(response.status_code, 200)
        self.assertIn('"type": "trace"', payload)
        self.assertIn('"type": "tool_start"', payload)
        self.assertIn('"type": "tool_result"', payload)
        trace_events = [event["entry"] for event in self.streaming_events(payload) if event.get("type") == "trace"]
        self.assertEqual([entry["type"] for entry in trace_events], ["tool_start", "tool_result"])
        self.assertEqual(trace_events[0]["name"], "get_papers_by_ids")
        self.assertEqual(trace_events[1]["summary"], json.dumps({"papers": [{"id": 42, "title": "Tagged Paper"}]}))

        normalized_user_message = captured_messages[0][-1]["content"]
        self.assertIn("Tagged Paper (paper id 42)", normalized_user_message)
        self.assertIn("Tagged paper ids: 42.", normalized_user_message)

        detail = get_chat_session_detail(self.conn, session.id or 0)
        self.assertIsNotNone(detail)
        self.assertEqual(detail.title, "Tell me about Tagged Paper")
        self.assertEqual(detail.messages[1].content, "Checking. Found it.")
        tool_results = [entry for entry in detail.messages[1].trace_entries if entry.type == "tool_result"]
        self.assertEqual(len(tool_results), 1)
        self.assertEqual(tool_results[0].name, "get_papers_by_ids")
        self.assertEqual(
            tool_results[0].summary,
            json.dumps({"papers": [{"id": 42, "title": "Tagged Paper"}]}),
        )

    def test_provider_runtime_request_carries_allowed_capabilities(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        self.conn.commit()
        captured_requests: list[object] = []

        async def fake_provider_stream(request):
            captured_requests.append(request)
            yield {"type": "tool_start", "name": "read_paper_pdf"}
            yield {"type": "tool_result", "name": "read_paper_pdf", "summary": "Chunk evidence."}
            yield {"type": "text", "content": "Final summary from gathered PDF chunks."}
            yield {"type": "done", "finish_reason": "stop"}

        with (
            patch.object(self.chat_api, "load_config", return_value=Config(
                chat=ChatConfig(backend="openai_api"),
                llm=LlmConfig(api_key="test-key", model="test-model"),
            )),
            patch.object(self.chat_api, "provider_stream", new=fake_provider_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(content="Summarize paper 91"),
                    conn=self.conn,
                )
            )
            payload = asyncio.run(self.read_streaming_response(response))

        self.assertIn("Final summary from gathered PDF chunks.", payload)
        self.assertEqual(len(captured_requests), 1)
        self.assertIs(captured_requests[0].conn, self.conn)
        self.assertIn("read_paper_pdf", captured_requests[0].allowed_capabilities)
        detail = get_chat_session_detail(self.conn, session.id or 0)
        self.assertIsNotNone(detail)
        self.assertEqual(detail.messages[1].content, "Final summary from gathered PDF chunks.")
        tool_results = [entry for entry in detail.messages[1].trace_entries if entry.type == "tool_result"]
        self.assertEqual(len(tool_results), 1)
        self.assertEqual(tool_results[0].name, "read_paper_pdf")
        self.assertEqual(tool_results[0].summary, "Chunk evidence.")

    def test_codex_mcp_resource_reads_attach_to_final_assistant_message(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings(backend="codex_cli"))
        self.conn.commit()

        async def fake_provider_stream(request):
            insert_chat_resource_reads(
                self.conn,
                session.id or 0,
                turn_id=request.turn_id,
                provider="codex_cli",
                source="capability_result",
                capability_name="get_papers_by_ids",
                reads=[
                    {
                        "resource_kind": "paper",
                        "resource_id": 42,
                        "label": "Codex MCP paper",
                        "locator": {"paper_id": 42},
                    }
                ],
            )
            self.conn.commit()
            yield {"type": "text", "content": "Codex answer."}
            yield {"type": "done", "finish_reason": "stop"}

        with (
            patch.object(
                self.chat_api,
                "load_config",
                return_value=Config(chat=ChatConfig(backend="codex_cli")),
            ),
            patch.object(self.chat_api, "provider_stream", new=fake_provider_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(content="Use Codex"),
                    conn=self.conn,
                )
            )
            asyncio.run(self.read_streaming_response(response))

        detail = get_chat_session_detail(self.conn, session.id or 0)
        self.assertIsNotNone(detail)
        reads = list_chat_resource_reads(
            self.conn,
            session.id or 0,
            assistant_message_id=detail.messages[1].id,
        )
        self.assertEqual(len(reads), 1)
        self.assertEqual(reads[0].provider, "codex_cli")
        self.assertEqual(reads[0].capability_name, "get_papers_by_ids")
        self.assertEqual(reads[0].resource_kind, "paper")
        self.assertEqual(reads[0].assistant_message_id, detail.messages[1].id)

    def test_streamed_progress_becomes_trace_entry(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        self.conn.commit()

        async def fake_provider_stream(request):
            yield {"type": "progress", "content": "Checking local context."}
            yield {"type": "text", "content": "Done."}
            yield {"type": "done", "finish_reason": "stop"}

        with (
            patch.object(self.chat_api, "load_config", return_value=Config(llm=LlmConfig(api_key="test-key", model="test-model"))),
            patch.object(self.chat_api, "provider_stream", new=fake_provider_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(content="Check progress"),
                    conn=self.conn,
                )
            )
            payload = asyncio.run(self.read_streaming_response(response))

        trace_events = [event["entry"] for event in self.streaming_events(payload) if event.get("type") == "trace"]
        self.assertEqual(trace_events[0]["type"], "progress")
        self.assertEqual(trace_events[0]["detail"], "Checking local context.")

        detail = get_chat_session_detail(self.conn, session.id or 0)
        self.assertIsNotNone(detail)
        self.assertEqual(detail.messages[1].trace_entries[0].type, "progress")
        self.assertEqual(detail.messages[1].trace_entries[0].detail, "Checking local context.")

    def test_adjacent_progress_fragments_persist_as_one_trace_entry(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        self.conn.commit()

        async def fake_provider_stream(request):
            yield {"type": "progress", "content": "I"}
            yield {"type": "progress", "content": "need"}
            yield {"type": "progress", "content": "tools"}
            yield {"type": "progress", "content": "."}
            yield {"type": "text", "content": "Done."}
            yield {"type": "done", "finish_reason": "stop"}

        with (
            patch.object(self.chat_api, "load_config", return_value=Config(llm=LlmConfig(api_key="test-key", model="test-model"))),
            patch.object(self.chat_api, "provider_stream", new=fake_provider_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(content="Check progress"),
                    conn=self.conn,
                )
            )
            payload = asyncio.run(self.read_streaming_response(response))

        trace_events = [event["entry"] for event in self.streaming_events(payload) if event.get("type") == "trace"]
        self.assertEqual([entry["detail"] for entry in trace_events], ["I", "need", "tools", "."])

        detail = get_chat_session_detail(self.conn, session.id or 0)
        self.assertIsNotNone(detail)
        self.assertEqual(len(detail.messages[1].trace_entries), 1)
        self.assertEqual(detail.messages[1].trace_entries[0].type, "progress")
        self.assertEqual(detail.messages[1].trace_entries[0].detail, "I need tools.")

    def test_library_listing_requires_recent_papers_tool(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings(backend="codex_cli"))
        self.conn.commit()
        captured_requests: list[object] = []

        async def fake_provider_stream(request):
            captured_requests.append(request)
            yield {"type": "tool_start", "name": "list_recent_papers"}
            yield {"type": "tool_result", "name": "list_recent_papers", "summary": "[]"}
            yield {"type": "text", "content": "No recent papers found."}
            yield {"type": "done", "finish_reason": "stop"}

        with (
            patch.object(self.chat_api, "load_config", return_value=Config(chat=ChatConfig(backend="codex_cli"))),
            patch.object(self.chat_api, "provider_stream", new=fake_provider_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(content="List a few papers from my library"),
                    conn=self.conn,
                )
            )
            payload = asyncio.run(self.read_streaming_response(response))

        self.assertIn("list_recent_papers", payload)
        self.assertEqual(captured_requests[0].required_capabilities, {"list_recent_papers"})

    def test_tagged_paper_metadata_requires_exact_lookup_tool(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper(title="Tagged Paper"))
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings(backend="codex_cli"))
        self.conn.commit()
        captured_requests: list[object] = []

        async def fake_provider_stream(request):
            captured_requests.append(request)
            yield {"type": "tool_start", "name": "get_papers_by_ids"}
            yield {
                "type": "tool_result",
                "name": "get_papers_by_ids",
                "summary": json.dumps({"papers": [{"id": paper_id}]}),
            }
            yield {"type": "text", "content": "Tagged Paper has score 0.81."}
            yield {"type": "done", "finish_reason": "stop"}

        with (
            patch.object(self.chat_api, "load_config", return_value=Config(chat=ChatConfig(backend="codex_cli"))),
            patch.object(self.chat_api, "provider_stream", new=fake_provider_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(
                        content=f"Tell me the title and score for [Tagged Paper](paper://{paper_id})"
                    ),
                    conn=self.conn,
                )
            )
            payload = asyncio.run(self.read_streaming_response(response))

        self.assertIn("get_papers_by_ids", payload)
        self.assertEqual(captured_requests[0].required_capabilities, {"get_papers_by_ids"})

        detail = get_chat_session_detail(self.conn, session.id or 0)
        self.assertIsNotNone(detail)
        self.assertEqual(detail.linked_paper_ids, [paper_id])

    def test_previous_tagged_paper_context_does_not_force_pdf_preflight_on_followup(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper(title="Tagged Paper"))
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings(backend="codex_cli"))
        assets_root = os.path.join(self.tmpdir.name, "assets")
        managed_path = f"papers/{paper_id}/main-paper.pdf"
        full_path = os.path.join(assets_root, "papers", str(paper_id), "main-paper.pdf")
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "wb") as fh:
            fh.write(b"%PDF-1.7\n")
        create_paper_asset(
            self.conn,
            paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path=managed_path,
            original_filename="main-paper.pdf",
            display_name="Main text",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-main",
            parse_status=AssetParseStatus.PARSED,
        )
        self.conn.commit()
        captured_requests: list[object] = []

        async def fake_provider_stream(request):
            captured_requests.append(request)
            yield {"type": "text", "content": "Answer."}
            yield {"type": "done", "finish_reason": "stop"}

        cfg = Config(
            chat=ChatConfig(backend="codex_cli"),
        )
        with (
            patch.object(self.chat_api, "load_config", return_value=cfg),
            patch.object(self.chat_api, "provider_stream", new=fake_provider_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(
                        content=f"What is the title of [Tagged Paper](paper://{paper_id})?"
                    ),
                    conn=self.conn,
                )
            )
            asyncio.run(self.read_streaming_response(response))

        detail = get_chat_session_detail(self.conn, session.id or 0)
        self.assertIsNotNone(detail)
        self.assertEqual(detail.linked_paper_ids, [paper_id])

        with (
            patch.object(self.chat_api, "load_config", return_value=cfg),
            patch.object(self.chat_api, "provider_stream", new=fake_provider_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(content="Summarize the attached PDF"),
                    conn=self.conn,
                )
            )
            asyncio.run(self.read_streaming_response(response))

        self.assertEqual(captured_requests[-1].required_capabilities, set())
        latest = captured_requests[-1].messages[-1]["content"]
        self.assertIn(f"Current linked paper id: {paper_id}.", latest)
        self.assertNotIn("Local paper asset inventory:", latest)

    def test_pdf_request_without_paper_context_reaches_provider(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings(backend="codex_cli"))
        self.conn.commit()
        captured_requests: list[object] = []

        async def fake_provider_stream(request):
            captured_requests.append(request)
            yield {"type": "text", "content": "Which file or paper should I summarize?"}
            yield {"type": "done", "finish_reason": "stop"}

        with (
            patch.object(self.chat_api, "load_config", return_value=Config(chat=ChatConfig(backend="codex_cli"))),
            patch.object(self.chat_api, "provider_stream", new=fake_provider_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(content="Summarize the attached PDF"),
                    conn=self.conn,
                )
            )
            payload = asyncio.run(self.read_streaming_response(response))

        self.assertIn("Which file or paper should I summarize?", payload)
        self.assertEqual(captured_requests[0].required_capabilities, set())
        detail = get_chat_session_detail(self.conn, session.id or 0)
        self.assertIsNotNone(detail)
        self.assertEqual(detail.messages[1].content, "Which file or paper should I summarize?")

    def test_title_only_paper_summary_reaches_provider_with_search_available(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings(backend="codex_cli"))
        self.conn.commit()
        captured_requests: list[object] = []

        async def fake_provider_stream(request):
            captured_requests.append(request)
            yield {"type": "text", "content": "I can search for that paper or ask which match you mean."}
            yield {"type": "done", "finish_reason": "stop"}

        with (
            patch.object(self.chat_api, "load_config", return_value=Config(chat=ChatConfig(backend="codex_cli"))),
            patch.object(self.chat_api, "provider_stream", new=fake_provider_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(
                        content="summarize the Smith condensate paper"
                    ),
                    conn=self.conn,
                )
            )
            payload = asyncio.run(self.read_streaming_response(response))

        self.assertIn("I can search for that paper or ask which match you mean.", payload)
        self.assertNotIn("Turn blocked", payload)
        self.assertEqual(captured_requests[0].required_capabilities, set())
        self.assertIn("search_papers", captured_requests[0].allowed_capabilities)

    def test_attachment_summary_context_requires_attachment_tool(self) -> None:
        plan = controller_module.TurnController(self.conn, Config()).plan_turn(
            "summarize the attached file",
            attached_attachment_ids=[7],
        )

        self.assertIsNone(plan.fail_closed_response)
        self.assertEqual(plan.required_capabilities, {"get_chat_attachment_context"})

    def test_no_attachment_pdf_summary_is_not_preflight_blocked(self) -> None:
        plan = controller_module.TurnController(self.conn, Config()).plan_turn(
            "summarize the attached PDF",
        )

        self.assertIsNone(plan.fail_closed_response)
        self.assertEqual(plan.required_capabilities, set())

    def test_explicit_pdf_asset_context_requires_pdf_tools(self) -> None:
        plan = controller_module.TurnController(self.conn, Config()).plan_turn(
            "summarize the attached PDF",
            attached_pdf_asset_ids=[8],
        )

        self.assertIsNone(plan.fail_closed_response)
        self.assertEqual(plan.required_capabilities, set(PAPER_PDF_CAPABILITY_NAMES))

    def test_linked_paper_unrelated_message_does_not_require_exact_lookup_tool(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper(title="Linked Paper"))

        plan = controller_module.TurnController(self.conn, Config()).plan_turn(
            "Hello there",
            linked_paper_ids=[paper_id],
        )

        self.assertEqual(plan.required_capabilities, set())

    def test_linked_paper_metadata_does_not_require_exact_lookup_tool(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper(title="Linked Paper"))

        plan = controller_module.TurnController(self.conn, Config()).plan_turn(
            "Tell me the title and score",
            linked_paper_ids=[paper_id],
        )

        self.assertEqual(plan.required_capabilities, set())

    def test_linked_paper_metadata_injects_linked_ids_for_provider(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper(title="Linked Paper"))
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings(backend="codex_cli"), linked_paper_ids=[paper_id])
        self.conn.commit()
        captured_requests: list[object] = []

        async def fake_provider_stream(request):
            captured_requests.append(request)
            yield {"type": "text", "content": "Linked Paper has score 0.81."}
            yield {"type": "done", "finish_reason": "stop"}

        with (
            patch.object(self.chat_api, "load_config", return_value=Config(chat=ChatConfig(backend="codex_cli"))),
            patch.object(self.chat_api, "provider_stream", new=fake_provider_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(content="What is its title and score?"),
                    conn=self.conn,
                )
            )
            asyncio.run(self.read_streaming_response(response))

        latest = captured_requests[0].messages[-1]["content"]
        self.assertIn("Linked paper context:", latest)
        self.assertIn(f"Current linked paper id: {paper_id}.", latest)
        self.assertIn("use this paper id", latest)
        self.assertEqual(captured_requests[0].required_capabilities, set())

    def test_context_items_are_resolved_injected_and_persisted_for_turn(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper(title="Context Turn Paper"))
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings(backend="codex_cli"))
        self.conn.commit()
        captured_requests: list[object] = []

        async def fake_provider_stream(request):
            captured_requests.append(request)
            yield {"type": "text", "content": "Context answer."}
            yield {"type": "done", "finish_reason": "stop"}

        with (
            patch.object(self.chat_api, "load_config", return_value=Config(chat=ChatConfig(backend="codex_cli"))),
            patch.object(self.chat_api, "provider_stream", new=fake_provider_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(
                        content="What should I remember?",
                        context_items=[
                            ChatContextItem(
                                kind="paper",
                                source="active_ui",
                                ref=ChatContextRef(paper_id=paper_id),
                                label="Stale frontend label",
                            )
                        ],
                    ),
                    conn=self.conn,
                )
            )
            payload = asyncio.run(self.read_streaming_response(response))

        trace_events = [event["entry"] for event in self.streaming_events(payload) if event.get("type") == "trace"]
        self.assertEqual(trace_events[0]["type"], "context")
        self.assertEqual(trace_events[0]["context_items"][0]["label"], "Context Turn Paper")

        latest = captured_requests[0].messages[-1]["content"]
        self.assertIn("Chat context:", latest)
        self.assertIn(f"Paper {paper_id}: Context Turn Paper", latest)
        self.assertIn(f"Current linked paper id: {paper_id}.", latest)
        self.assertEqual(captured_requests[0].required_capabilities, {"get_papers_by_ids"})

        detail = get_chat_session_detail(self.conn, session.id or 0)
        self.assertIsNotNone(detail)
        self.assertEqual(detail.linked_paper_ids, [paper_id])
        self.assertEqual(detail.messages[0].context_items[0].label, "Context Turn Paper")
        self.assertEqual(detail.messages[0].context_items[0].ref.paper_id, paper_id)
        self.assertEqual(detail.messages[1].trace_entries[0].type, "context")
        self.assertEqual(detail.messages[1].trace_entries[0].context_items[0].label, "Context Turn Paper")
        payload = self.chat_api.get_chat_session_endpoint(session.id or 0, conn=self.conn)
        self.assertEqual(payload["messages"][0]["context_items"][0]["label"], "Context Turn Paper")

    def test_project_context_item_requires_project_context_tool_and_persists(self) -> None:
        project = create_project(self.conn, name="Attached Project", description="Work in progress")
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings(backend="codex_cli"))
        self.conn.commit()
        captured_requests: list[object] = []

        async def fake_provider_stream(request):
            captured_requests.append(request)
            yield {"type": "text", "content": "Project answer."}
            yield {"type": "done", "finish_reason": "stop"}

        with (
            patch.object(self.chat_api, "load_config", return_value=Config(chat=ChatConfig(backend="codex_cli"))),
            patch.object(self.chat_api, "provider_stream", new=fake_provider_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(
                        content="What should I do next?",
                        context_items=[
                            ChatContextItem(
                                kind="project",
                                source="active_ui",
                                ref=ChatContextRef(project_id=project.id),
                                label="Stale project label",
                            )
                        ],
                    ),
                    conn=self.conn,
                )
            )
            asyncio.run(self.read_streaming_response(response))

        latest = captured_requests[0].messages[-1]["content"]
        self.assertIn("Chat context:", latest)
        self.assertIn(f"Project {project.id}: Attached Project", latest)
        self.assertIn("Call get_project_context", latest)
        self.assertEqual(captured_requests[0].required_capabilities, {"get_project_context"})

        detail = get_chat_session_detail(self.conn, session.id or 0)
        self.assertIsNotNone(detail)
        self.assertEqual(detail.messages[0].context_items[0].kind, "project")
        self.assertEqual(detail.messages[0].context_items[0].label, "Attached Project")
        self.assertEqual(detail.messages[0].context_items[0].ref.project_id, project.id)

    def test_note_context_item_requires_note_context_tool_and_persists(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper(title="Note Paper"))
        note = create_note(
            self.conn,
            title="Attached Note",
            body="Important note body",
            manual_paper_ids=[paper_id],
        )
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings(backend="codex_cli"))
        self.conn.commit()
        captured_requests: list[object] = []

        async def fake_provider_stream(request):
            captured_requests.append(request)
            yield {"type": "text", "content": "Note answer."}
            yield {"type": "done", "finish_reason": "stop"}

        with (
            patch.object(self.chat_api, "load_config", return_value=Config(chat=ChatConfig(backend="codex_cli"))),
            patch.object(self.chat_api, "provider_stream", new=fake_provider_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(
                        content="Use this note.",
                        context_items=[
                            ChatContextItem(
                                kind="note",
                                source="active_ui",
                                ref=ChatContextRef(note_id=note.id),
                                label="Stale note label",
                            )
                        ],
                    ),
                    conn=self.conn,
                )
            )
            asyncio.run(self.read_streaming_response(response))

        latest = captured_requests[0].messages[-1]["content"]
        self.assertIn("Chat context:", latest)
        self.assertIn(f"Note {note.id}: Attached Note", latest)
        self.assertIn("Call get_note_context", latest)
        self.assertEqual(captured_requests[0].required_capabilities, {"get_note_context"})

        detail = get_chat_session_detail(self.conn, session.id or 0)
        self.assertIsNotNone(detail)
        self.assertEqual(detail.messages[0].context_items[0].kind, "note")
        self.assertEqual(detail.messages[0].context_items[0].label, "Attached Note")
        self.assertEqual(detail.messages[0].context_items[0].ref.note_id, note.id)

    def test_attachment_context_item_is_injected_attached_and_logged(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings(backend="codex_cli"))
        managed_path = f"sessions/{session.id}/clip.txt"
        full_path = resolve_chat_attachment_path(managed_path)
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_bytes(b"attached text")
        attachment = create_chat_attachment(
            self.conn,
            session.id or 0,
            context_kind="clipboard_text",
            kind=AssetKind.TEXT,
            source="chat",
            managed_path=managed_path,
            original_filename="clip.txt",
            display_name="Pasted text",
            mime_type="text/plain",
            size_bytes=13,
            content_hash="sha256-chat-attachment",
            parse_status=AssetParseStatus.PARSED,
            parsed_text="attached text",
        )
        self.conn.commit()
        captured_requests: list[object] = []

        async def fake_provider_stream(request):
            captured_requests.append(request)
            yield {"type": "text", "content": "Attachment answer."}
            yield {"type": "done", "finish_reason": "stop"}

        cfg = Config(
            chat=ChatConfig(backend="codex_cli"),
        )
        with (
            patch.object(self.chat_api, "load_config", return_value=cfg),
            patch.object(self.chat_api, "provider_stream", new=fake_provider_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(
                        content="Use this attachment.",
                        context_items=[
                            ChatContextItem(
                                kind="clipboard_text",
                                source="paste",
                                ref=ChatContextRef(asset_id=attachment.asset.id),
                            )
                        ],
                    ),
                    conn=self.conn,
                )
            )
            asyncio.run(self.read_streaming_response(response))

        latest = captured_requests[0].messages[-1]["content"]
        self.assertIn("Call get_chat_attachment_context", latest)
        self.assertEqual(captured_requests[0].required_capabilities, {"get_chat_attachment_context"})

        detail = get_chat_session_detail(self.conn, session.id or 0)
        self.assertIsNotNone(detail)
        self.assertEqual(detail.messages[0].context_items[0].kind, "clipboard_text")
        self.assertEqual(detail.messages[0].context_items[0].label, "Pasted text")
        attached = list_chat_attachments(
            self.conn,
            session.id or 0,
            user_message_id=detail.messages[0].id,
        )
        self.assertEqual([item.asset.id for item in attached], [attachment.asset.id])
        self.assertEqual(list_chat_attachments(self.conn, session.id or 0, pending_only=True), [])

        reads = list_chat_resource_reads(
            self.conn,
            session.id or 0,
            assistant_message_id=detail.messages[1].id,
        )
        self.assertEqual(len(reads), 1)
        self.assertEqual(reads[0].resource_kind, "asset")
        self.assertEqual(reads[0].resource_id, str(attachment.asset.id))
        self.assertEqual(reads[0].locator["context_kind"], "clipboard_text")

    def test_attached_text_file_summary_reaches_provider_and_attaches_pending_context(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings(backend="codex_cli"))
        managed_path = f"sessions/{session.id}/summary.txt"
        full_path = resolve_chat_attachment_path(managed_path)
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_bytes(b"Long file body to summarize")
        attachment = create_chat_attachment(
            self.conn,
            session.id or 0,
            context_kind="file",
            kind=AssetKind.TEXT,
            source="chat",
            managed_path=managed_path,
            original_filename="summary.txt",
            display_name="summary.txt",
            mime_type="text/plain",
            size_bytes=27,
            content_hash="sha256-summary-text",
            parse_status=AssetParseStatus.PARSED,
            parsed_text="Long file body to summarize",
        )
        self.conn.commit()
        captured_requests: list[object] = []

        async def fake_provider_stream(request):
            captured_requests.append(request)
            yield {"type": "text", "content": "Summary from attached text."}
            yield {"type": "done", "finish_reason": "stop"}

        cfg = Config(
            chat=ChatConfig(backend="codex_cli"),
        )
        with (
            patch.object(self.chat_api, "load_config", return_value=cfg),
            patch.object(self.chat_api, "provider_stream", new=fake_provider_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(
                        content="summarize the attached file",
                        context_items=[
                            ChatContextItem(
                                kind="file",
                                source="user_attached",
                                ref=ChatContextRef(asset_id=attachment.asset.id),
                            )
                        ],
                    ),
                    conn=self.conn,
                )
            )
            payload = asyncio.run(self.read_streaming_response(response))

        self.assertIn("Summary from attached text.", payload)
        self.assertNotIn("Turn blocked", payload)
        self.assertEqual(captured_requests[0].required_capabilities, {"get_chat_attachment_context"})
        self.assertIn("Call get_chat_attachment_context", captured_requests[0].messages[-1]["content"])

        detail = get_chat_session_detail(self.conn, session.id or 0)
        self.assertIsNotNone(detail)
        self.assertEqual(detail.messages[0].context_items[0].kind, "file")
        attached = list_chat_attachments(
            self.conn,
            session.id or 0,
            user_message_id=detail.messages[0].id,
        )
        self.assertEqual([item.asset.id for item in attached], [attachment.asset.id])
        self.assertEqual(list_chat_attachments(self.conn, session.id or 0, pending_only=True), [])

    def test_attached_pdf_summary_reaches_provider_with_attachment_tool(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings(backend="codex_cli"))
        managed_path = f"sessions/{session.id}/attached.pdf"
        full_path = resolve_chat_attachment_path(managed_path)
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_bytes(b"%PDF-1.7\n")
        attachment = create_chat_attachment(
            self.conn,
            session.id or 0,
            context_kind="file",
            kind=AssetKind.PDF,
            source="chat",
            managed_path=managed_path,
            original_filename="attached.pdf",
            display_name="attached.pdf",
            mime_type="application/pdf",
            size_bytes=9,
            content_hash="sha256-attached-pdf",
            parse_status=AssetParseStatus.NOT_PARSED,
        )
        self.conn.commit()
        captured_requests: list[object] = []

        async def fake_provider_stream(request):
            captured_requests.append(request)
            yield {"type": "text", "content": "Summary from attached PDF."}
            yield {"type": "done", "finish_reason": "stop"}

        cfg = Config(
            chat=ChatConfig(backend="codex_cli"),
        )
        with (
            patch.object(self.chat_api, "load_config", return_value=cfg),
            patch.object(self.chat_api, "provider_stream", new=fake_provider_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(
                        content="summarize the attached PDF",
                        context_items=[
                            ChatContextItem(
                                kind="file",
                                source="user_attached",
                                ref=ChatContextRef(asset_id=attachment.asset.id),
                            )
                        ],
                    ),
                    conn=self.conn,
                )
            )
            payload = asyncio.run(self.read_streaming_response(response))

        self.assertIn("Summary from attached PDF.", payload)
        self.assertNotIn("Turn blocked", payload)
        self.assertEqual(captured_requests[0].required_capabilities, {"get_chat_attachment_context"})
        self.assertIn("Call get_chat_attachment_context", captured_requests[0].messages[-1]["content"])

    def test_attached_context_items_create_prompt_resource_reads(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper(title="Ledger Paper"))
        project = create_project(self.conn, name="Ledger Project")
        note = create_note(
            self.conn,
            title="Ledger Note",
            body="Ledger note body",
            manual_paper_ids=[paper_id],
        )
        assets_root = os.path.join(self.tmpdir.name, "assets")
        managed_path = f"papers/{paper_id}/ledger.pdf"
        full_path = os.path.join(assets_root, "papers", str(paper_id), "ledger.pdf")
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "wb") as fh:
            fh.write(b"%PDF-1.7\n")
        asset = create_paper_asset(
            self.conn,
            paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path=managed_path,
            original_filename="ledger.pdf",
            display_name="Ledger PDF",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-ledger",
            parse_status=AssetParseStatus.NOT_PARSED,
        )
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings(backend="codex_cli"))
        self.conn.commit()

        async def fake_provider_stream(request):
            yield {"type": "text", "content": "Ledger answer."}
            yield {"type": "done", "finish_reason": "stop"}

        cfg = Config(
            chat=ChatConfig(backend="codex_cli"),
        )
        with (
            patch.object(self.chat_api, "load_config", return_value=cfg),
            patch.object(self.chat_api, "provider_stream", new=fake_provider_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(
                        content="Use all attached context.",
                        context_items=[
                            ChatContextItem(
                                kind="paper",
                                source="active_ui",
                                ref=ChatContextRef(paper_id=paper_id),
                            ),
                            ChatContextItem(
                                kind="project",
                                source="active_ui",
                                ref=ChatContextRef(project_id=project.id),
                            ),
                            ChatContextItem(
                                kind="note",
                                source="active_ui",
                                ref=ChatContextRef(note_id=note.id),
                            ),
                            ChatContextItem(
                                kind="pdf_asset",
                                source="active_ui",
                                ref=ChatContextRef(paper_id=paper_id, asset_id=asset.id),
                            ),
                        ],
                    ),
                    conn=self.conn,
                )
            )
            asyncio.run(self.read_streaming_response(response))

        detail = get_chat_session_detail(self.conn, session.id or 0)
        self.assertIsNotNone(detail)
        assistant_id = detail.messages[1].id
        reads = list_chat_resource_reads(
            self.conn,
            session.id or 0,
            assistant_message_id=assistant_id,
        )
        self.assertEqual([read.source for read in reads], ["prompt_context"] * 4)
        self.assertEqual({(read.resource_kind, read.resource_id) for read in reads}, {
            ("paper", str(paper_id)),
            ("project", str(project.id)),
            ("note", str(note.id)),
            ("asset", str(asset.id)),
        })
        self.assertTrue(all(read.assistant_message_id == assistant_id for read in reads))
        self.assertTrue(all(read.provider == "codex_cli" for read in reads))

    def test_project_and_paper_context_items_combine_required_capabilities(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper(title="Project Paper"))
        project = create_project(self.conn, name="Paper Project")
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings(backend="codex_cli"))
        self.conn.commit()
        captured_requests: list[object] = []

        async def fake_provider_stream(request):
            captured_requests.append(request)
            yield {"type": "text", "content": "Combined answer."}
            yield {"type": "done", "finish_reason": "stop"}

        with (
            patch.object(self.chat_api, "load_config", return_value=Config(chat=ChatConfig(backend="codex_cli"))),
            patch.object(self.chat_api, "provider_stream", new=fake_provider_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(
                        content="How does this fit?",
                        context_items=[
                            ChatContextItem(
                                kind="project",
                                source="active_ui",
                                ref=ChatContextRef(project_id=project.id),
                            ),
                            ChatContextItem(
                                kind="paper",
                                source="active_ui",
                                ref=ChatContextRef(paper_id=paper_id),
                            ),
                        ],
                    ),
                    conn=self.conn,
                )
            )
            asyncio.run(self.read_streaming_response(response))

        self.assertEqual(
            captured_requests[0].required_capabilities,
            {"get_project_context", "get_papers_by_ids"},
        )
        latest = captured_requests[0].messages[-1]["content"]
        self.assertIn(f"Project {project.id}: Paper Project", latest)
        self.assertIn(f"Paper {paper_id}: Project Paper", latest)
        self.assertIn(f"Current linked paper id: {paper_id}.", latest)

    def test_multiple_linked_papers_inject_ambiguity_guidance(self) -> None:
        first_id = upsert_paper(self.conn, make_paper(title="First Paper", external_id="10.1/first"))
        second_id = upsert_paper(self.conn, make_paper(title="Second Paper", external_id="10.1/second"))
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings(backend="codex_cli"), linked_paper_ids=[first_id, second_id])
        self.conn.commit()
        captured_requests: list[object] = []

        async def fake_provider_stream(request):
            captured_requests.append(request)
            yield {"type": "text", "content": "Which linked paper?"}
            yield {"type": "done", "finish_reason": "stop"}

        with (
            patch.object(self.chat_api, "load_config", return_value=Config(chat=ChatConfig(backend="codex_cli"))),
            patch.object(self.chat_api, "provider_stream", new=fake_provider_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(content="What is its title?"),
                    conn=self.conn,
                )
            )
            asyncio.run(self.read_streaming_response(response))

        latest = captured_requests[0].messages[-1]["content"]
        self.assertIn("Linked paper context:", latest)
        self.assertIn(f"Current linked paper ids: {first_id}, {second_id}.", latest)
        self.assertIn("If a singular reference is ambiguous, ask which paper.", latest)

    def test_missing_general_required_capability_uses_generic_response(self) -> None:
        plan = controller_module.TurnController(
            self.conn,
            Config(),
            registry=CapabilityRegistry([]),
        ).plan_turn("List a few papers from my library")

        self.assertIsNotNone(plan.fail_closed_response)
        self.assertIn("required Claudesk capabilities", plan.fail_closed_response or "")
        self.assertIn("list_recent_papers", plan.fail_closed_response or "")
        self.assertNotIn("write Claudesk notes", plan.fail_closed_response or "")

    def test_attached_file_missing_attachment_capability_fails_before_provider(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings(backend="codex_cli"))
        managed_path = f"sessions/{session.id}/disabled.txt"
        full_path = resolve_chat_attachment_path(managed_path)
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_bytes(b"disabled capability text")
        attachment = create_chat_attachment(
            self.conn,
            session.id or 0,
            context_kind="file",
            kind=AssetKind.TEXT,
            source="chat",
            managed_path=managed_path,
            original_filename="disabled.txt",
            display_name="disabled.txt",
            mime_type="text/plain",
            size_bytes=24,
            content_hash="sha256-disabled-attachment",
            parse_status=AssetParseStatus.PARSED,
            parsed_text="disabled capability text",
        )
        self.conn.commit()
        registry = CapabilityRegistry(
            spec
            for spec in controller_module.get_capability_registry().list()
            if spec.name != "get_chat_attachment_context"
        )

        async def fail_provider_stream(request):
            raise AssertionError("provider should not run when a required attachment capability is missing")
            yield  # pragma: no cover

        cfg = Config(
            chat=ChatConfig(backend="codex_cli"),
        )
        with (
            patch.object(self.chat_api, "load_config", return_value=cfg),
            patch.object(controller_module, "get_capability_registry", return_value=registry),
            patch.object(self.chat_api, "provider_stream", new=fail_provider_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(
                        content="summarize the attached file",
                        context_items=[
                            ChatContextItem(
                                kind="file",
                                source="user_attached",
                                ref=ChatContextRef(asset_id=attachment.asset.id),
                            )
                        ],
                    ),
                    conn=self.conn,
                )
            )
            payload = asyncio.run(self.read_streaming_response(response))

        self.assertIn("Turn blocked", payload)
        self.assertIn("get_chat_attachment_context", payload)
        detail = get_chat_session_detail(self.conn, session.id or 0)
        self.assertIsNotNone(detail)
        self.assertEqual(detail.messages[1].trace_entries[0].label, "Turn blocked")

    def test_explicit_pdf_asset_context_with_disabled_pdf_tools_fails_before_provider(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        paper_id = upsert_paper(self.conn, make_paper(title="PDF Disabled Paper"))
        assets_root = os.path.join(self.tmpdir.name, "assets")
        managed_path = f"papers/{paper_id}/disabled.pdf"
        full_path = os.path.join(assets_root, managed_path)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "wb") as fh:
            fh.write(b"%PDF-1.7\n")
        asset = create_paper_asset(
            self.conn,
            paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path=managed_path,
            original_filename="disabled.pdf",
            display_name="disabled.pdf",
            mime_type="application/pdf",
            size_bytes=9,
            content_hash="sha256-disabled-pdf-tools",
            parse_status=AssetParseStatus.NOT_PARSED,
        )
        self.conn.commit()

        async def fail_provider_stream(request):
            raise AssertionError("provider should not run when required PDF capabilities are disabled")
            yield  # pragma: no cover

        cfg = Config(
            chat=ChatConfig(
                backend="codex_cli",
                tools=ChatToolsConfig(paper_pdf=False),
            ),
        )
        with (
            patch.object(self.chat_api, "load_config", return_value=cfg),
            patch.object(self.chat_api, "provider_stream", new=fail_provider_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(
                        content="summarize the attached PDF",
                        context_items=[
                            ChatContextItem(
                                kind="pdf_asset",
                                source="active_ui",
                                ref=ChatContextRef(paper_id=paper_id, asset_id=asset.id),
                            )
                        ],
                    ),
                    conn=self.conn,
                )
            )
            payload = asyncio.run(self.read_streaming_response(response))

        self.assertIn("Turn blocked", payload)
        self.assertIn("cannot read local PDFs", payload)
        self.assertIn("read_paper_pdf", payload)

    def test_si_request_reaches_provider_without_asset_inventory_preflight(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        paper_id = upsert_paper(self.conn, make_paper(title="Tagged Paper"))
        assets_root = os.path.join(self.tmpdir.name, "assets")
        managed_path = f"papers/{paper_id}/main-paper.pdf"
        full_path = os.path.join(assets_root, "papers", str(paper_id), "main-paper.pdf")
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "wb") as fh:
            fh.write(b"%PDF-1.7\n")
        create_paper_asset(
            self.conn,
            paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path=managed_path,
            original_filename="main-paper.pdf",
            display_name="Main paper PDF",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-main",
            parse_status=AssetParseStatus.NOT_PARSED,
        )
        self.conn.commit()
        captured_messages: list[list[dict]] = []

        async def fake_chat_stream(messages, tools, cfg, **_kwargs):
            captured_messages.append([dict(message) for message in messages])
            yield {"type": "text", "content": "No local SI PDF is attached."}
            yield {"type": "done", "finish_reason": "stop"}

        cfg = Config(
            llm=LlmConfig(api_key="test-key", model="test-model"),
        )
        with (
            patch.object(self.chat_api, "load_config", return_value=cfg),
            self.patch_provider_stream(fake_chat_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(
                        content=f"read SI of [Tagged Paper](paper://{paper_id}) and summarize it"
                    ),
                    conn=self.conn,
                )
            )
            asyncio.run(self.read_streaming_response(response))

        latest_user_message = captured_messages[0][-1]["content"]
        self.assertIn(f"Tagged paper ids: {paper_id}.", latest_user_message)
        self.assertNotIn("Local paper asset inventory", latest_user_message)
        self.assertNotIn("managed_path", latest_user_message)
        self.assertNotIn(assets_root, latest_user_message)
        self.assertNotIn(self.tmpdir.name, latest_user_message)

    def test_main_text_request_reaches_provider_without_asset_inventory_preflight(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        paper_id = upsert_paper(self.conn, make_paper(title="Tagged Paper"))
        assets_root = os.path.join(self.tmpdir.name, "assets")
        managed_path = f"papers/{paper_id}/main-paper.pdf"
        full_path = os.path.join(assets_root, "papers", str(paper_id), "main-paper.pdf")
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "wb") as fh:
            fh.write(b"%PDF-1.7\n")
        create_paper_asset(
            self.conn,
            paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path=managed_path,
            original_filename="main-paper.pdf",
            display_name="Main text",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-main",
            parse_status=AssetParseStatus.NOT_PARSED,
        )
        self.conn.commit()
        captured_messages: list[list[dict]] = []

        async def fake_chat_stream(messages, tools, cfg, **_kwargs):
            captured_messages.append([dict(message) for message in messages])
            yield {"type": "text", "content": "Main text summary."}
            yield {"type": "done", "finish_reason": "stop"}

        with (
            patch.object(
                self.chat_api,
                "load_config",
                return_value=Config(
                    llm=LlmConfig(api_key="test-key", model="test-model"),
                ),
            ),
            self.patch_provider_stream(fake_chat_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(
                        content=f"read the main text of [Tagged Paper](paper://{paper_id})"
                    ),
                    conn=self.conn,
                )
            )
            asyncio.run(self.read_streaming_response(response))

        latest_user_message = captured_messages[0][-1]["content"]
        self.assertIn(f"Tagged paper ids: {paper_id}.", latest_user_message)
        self.assertNotIn("Local paper asset inventory", latest_user_message)

    def test_explicit_pdf_request_ignores_old_linked_paper_for_preflight(self) -> None:
        old_id = upsert_paper(self.conn, make_paper(external_id="10.1/old", title="Old Linked Paper"))
        new_id = upsert_paper(self.conn, make_paper(external_id="10.1/new", title="New Tagged Paper"))
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings(), linked_paper_ids=[old_id])
        assets_root = os.path.join(self.tmpdir.name, "assets")
        managed_path = f"papers/{new_id}/main-paper.pdf"
        full_path = os.path.join(assets_root, "papers", str(new_id), "main-paper.pdf")
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "wb") as fh:
            fh.write(b"%PDF-1.7\n")
        create_paper_asset(
            self.conn,
            new_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path=managed_path,
            original_filename="main-paper.pdf",
            display_name="Main text",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-explicit",
            parse_status=AssetParseStatus.NOT_PARSED,
        )
        self.conn.commit()
        captured_messages: list[list[dict]] = []

        async def fake_chat_stream(messages, tools, cfg, **_kwargs):
            captured_messages.append([dict(message) for message in messages])
            yield {"type": "text", "content": "New tagged paper summary."}
            yield {"type": "done", "finish_reason": "stop"}

        with (
            patch.object(
                self.chat_api,
                "load_config",
                return_value=Config(
                    llm=LlmConfig(api_key="test-key", model="test-model"),
                ),
            ),
            self.patch_provider_stream(fake_chat_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(
                        content=f"summarize the PDF for [New Tagged Paper](paper://{new_id})"
                    ),
                    conn=self.conn,
                )
            )
            payload = asyncio.run(self.read_streaming_response(response))

        self.assertIn("New tagged paper summary.", payload)
        self.assertNotIn("no PDF is attached", payload)
        latest_user_message = captured_messages[0][-1]["content"]
        self.assertIn(f"Current linked paper id: {new_id}.", latest_user_message)
        self.assertNotIn(f"Current linked paper id: {old_id}.", latest_user_message)
        self.assertNotIn("Local paper asset inventory", latest_user_message)

        detail = get_chat_session_detail(self.conn, session.id or 0)
        self.assertIsNotNone(detail)
        self.assertEqual(detail.linked_paper_ids, [old_id, new_id])

    def test_pdf_summary_without_attached_pdf_reaches_provider(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        paper_id = upsert_paper(self.conn, make_paper(title="Tagged Paper"))
        self.conn.commit()
        captured_messages: list[list[dict]] = []

        async def fake_chat_stream(messages, tools, cfg, **_kwargs):
            captured_messages.append([dict(message) for message in messages])
            yield {"type": "text", "content": "I need to inspect the paper tools or ask a clarification."}
            yield {"type": "done", "finish_reason": "stop"}

        with (
            patch.object(self.chat_api, "load_config", return_value=Config(llm=LlmConfig(api_key="test-key", model="test-model"))),
            self.patch_provider_stream(fake_chat_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(
                        content=f"summarize [Tagged Paper](paper://{paper_id})"
                    ),
                    conn=self.conn,
                )
            )
            payload = asyncio.run(self.read_streaming_response(response))

        self.assertIn("I need to inspect the paper tools or ask a clarification.", payload)
        self.assertNotIn("no PDF is attached to this paper in Claudesk", payload)
        trace_events = [event["entry"] for event in self.streaming_events(payload) if event.get("type") == "trace"]
        self.assertFalse([entry for entry in trace_events if entry["type"] == "warning"])
        self.assertIn(f"Tagged paper ids: {paper_id}.", captured_messages[0][-1]["content"])

        detail = get_chat_session_detail(self.conn, session.id or 0)
        self.assertIsNotNone(detail)
        self.assertEqual([message.role for message in detail.messages], ["user", "assistant"])
        self.assertIn("I need to inspect the paper tools or ask a clarification.", detail.messages[1].content)
        self.assertFalse([entry for entry in detail.messages[1].trace_entries if entry.type == "warning"])

    def test_summary_typo_without_attached_pdf_reaches_provider(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        paper_id = upsert_paper(self.conn, make_paper(title="Tagged Paper"))
        self.conn.commit()
        captured_messages: list[list[dict]] = []

        async def fake_chat_stream(messages, tools, cfg, **_kwargs):
            captured_messages.append([dict(message) for message in messages])
            yield {"type": "text", "content": "Provider handled the typo."}
            yield {"type": "done", "finish_reason": "stop"}

        with (
            patch.object(self.chat_api, "load_config", return_value=Config(llm=LlmConfig(api_key="test-key", model="test-model"))),
            self.patch_provider_stream(fake_chat_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(
                        content=f"can you summarze [@Tagged Paper](paper://{paper_id})?"
                    ),
                    conn=self.conn,
                )
            )
            payload = asyncio.run(self.read_streaming_response(response))

        self.assertIn("Provider handled the typo.", payload)
        self.assertNotIn("Do you want me to summarize the available abstract?", payload)
        self.assertIn(f"Tagged paper ids: {paper_id}.", captured_messages[0][-1]["content"])

    def test_abstract_metadata_tagged_request_calls_model_without_asset_inventory(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        paper_id = upsert_paper(self.conn, make_paper(title="Tagged Paper"))
        self.conn.commit()
        captured_messages: list[list[dict]] = []

        async def fake_chat_stream(messages, tools, cfg, **_kwargs):
            captured_messages.append([dict(message) for message in messages])
            yield {"type": "text", "content": "Regular answer."}
            yield {"type": "done", "finish_reason": "stop"}

        with (
            patch.object(self.chat_api, "load_config", return_value=Config(llm=LlmConfig(api_key="test-key", model="test-model"))),
            self.patch_provider_stream(fake_chat_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(
                        content=f"what does the abstract say for [Tagged Paper](paper://{paper_id})?"
                    ),
                    conn=self.conn,
                )
            )
            asyncio.run(self.read_streaming_response(response))

        latest_user_message = captured_messages[0][-1]["content"]
        self.assertNotIn("Local paper asset inventory", latest_user_message)
        self.assertIn(f"Tagged paper ids: {paper_id}.", latest_user_message)

    def test_asset_question_calls_model_without_asset_inventory_preflight(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        paper_id = upsert_paper(self.conn, make_paper(title="Tagged Paper"))
        self.conn.commit()
        captured_messages: list[list[dict]] = []

        async def fake_chat_stream(messages, tools, cfg, **_kwargs):
            captured_messages.append([dict(message) for message in messages])
            yield {"type": "text", "content": "No SI asset attached."}
            yield {"type": "done", "finish_reason": "stop"}

        with (
            patch.object(self.chat_api, "load_config", return_value=Config(llm=LlmConfig(api_key="test-key", model="test-model"))),
            self.patch_provider_stream(fake_chat_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(
                        content=f"does [Tagged Paper](paper://{paper_id}) have SI attached?"
                    ),
                    conn=self.conn,
                )
            )
            asyncio.run(self.read_streaming_response(response))

        latest_user_message = captured_messages[0][-1]["content"]
        self.assertNotIn("Local paper asset inventory", latest_user_message)
        self.assertIn(f"Tagged paper ids: {paper_id}.", latest_user_message)

    def test_pdf_request_with_missing_managed_file_reaches_provider(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        paper_id = upsert_paper(self.conn, make_paper(title="Tagged Paper"))
        create_paper_asset(
            self.conn,
            paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path=f"papers/{paper_id}/missing.pdf",
            original_filename="missing.pdf",
            display_name="Missing PDF",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-missing",
            parse_status=AssetParseStatus.NOT_PARSED,
        )
        self.conn.commit()

        async def fake_chat_stream(messages, tools, cfg, **_kwargs):
            yield {"type": "text", "content": "Provider can use paper tools or ask for clarification."}
            yield {"type": "done", "finish_reason": "stop"}

        cfg = Config(
            llm=LlmConfig(api_key="test-key", model="test-model"),
        )
        with (
            patch.object(self.chat_api, "load_config", return_value=cfg),
            self.patch_provider_stream(fake_chat_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(
                        content=f"read the PDF for [Tagged Paper](paper://{paper_id})"
                    ),
                    conn=self.conn,
                )
            )
            payload = asyncio.run(self.read_streaming_response(response))

        self.assertIn("Provider can use paper tools or ask for clarification.", payload)
        self.assertNotIn("managed file cannot be found locally", payload)

    def test_streamed_turn_persists_runtime_tool_image_summary(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        self.conn.commit()

        async def fake_chat_stream(messages, tools, cfg, **_kwargs):
            yield {"type": "tool_start", "name": "inspect_paper_pdf_pages"}
            yield {
                "type": "tool_result",
                "name": "inspect_paper_pdf_pages",
                "summary": "Image evidence returned by capability `inspect_paper_pdf_pages`: PDF page 1",
            }
            yield {"type": "text", "content": "The figure is visible on page 1."}
            yield {"type": "done", "finish_reason": "stop"}

        with (
            patch.object(self.chat_api, "load_config", return_value=Config(llm=LlmConfig(api_key="test-key", model="test-model"))),
            self.patch_provider_stream(fake_chat_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(content="Which figure shows this?"),
                    conn=self.conn,
                )
            )
            payload = asyncio.run(self.read_streaming_response(response))

        self.assertEqual(response.status_code, 200)
        self.assertIn("The figure is visible on page 1.", payload)
        detail = get_chat_session_detail(self.conn, session.id or 0)
        self.assertIsNotNone(detail)
        tool_results = [entry for entry in detail.messages[1].trace_entries if entry.type == "tool_result"]
        self.assertEqual(tool_results[0].name, "inspect_paper_pdf_pages")
        self.assertIn("PDF page 1", tool_results[0].summary)

    def test_clear_chat_session_messages_endpoint_returns_empty_detail(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings(), title="Endpoint clear")
        append_chat_message(self.conn, session.id or 0, role="user", content="Hello")
        self.conn.commit()

        payload = self.chat_api.clear_chat_session_messages_endpoint(
            session.id or 0,
            conn=self.conn,
        )

        self.assertEqual(payload["id"], session.id)
        self.assertEqual(payload["title"], "Endpoint clear")
        self.assertEqual(payload["messages"], [])
        self.assertEqual(
            self.conn.execute(
                "SELECT COUNT(*) FROM chat_sessions WHERE id=?",
                (session.id,),
            ).fetchone()[0],
            1,
        )

    def test_clear_missing_chat_session_messages_endpoint_returns_404(self) -> None:
        with self.assertRaises(self.chat_api.HTTPException) as ctx:
            self.chat_api.clear_chat_session_messages_endpoint(999, conn=self.conn)

        self.assertEqual(ctx.exception.status_code, 404)

    def test_context_item_validation_errors_return_400_before_streaming(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        self.conn.commit()

        with self.assertRaises(self.chat_api.HTTPException) as missing_ctx:
            asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(
                        content="Use this context",
                        context_items=[
                            ChatContextItem(kind="paper", source="active_ui", ref=ChatContextRef(paper_id=999))
                        ],
                    ),
                    conn=self.conn,
                )
            )
        self.assertEqual(missing_ctx.exception.status_code, 400)
        self.assertIn("Paper 999 not found", str(missing_ctx.exception.detail))

        with self.assertRaises(self.chat_api.HTTPException) as unsupported_ctx:
            asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(
                        content="Use this context",
                        context_items=[
                            ChatContextItem(kind="screenshot", source="screenshot", label="Screenshot")
                        ],
                    ),
                    conn=self.conn,
                )
            )
        self.assertEqual(unsupported_ctx.exception.status_code, 400)
        self.assertIn("missing a ref", str(unsupported_ctx.exception.detail))

        paper_id = upsert_paper(self.conn, make_paper(title="Unavailable PDF Context"))
        asset = create_paper_asset(
            self.conn,
            paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path="papers/unavailable-context.pdf",
            original_filename="unavailable-context.pdf",
            display_name="Unavailable context PDF",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-unavailable-context-api",
        )
        self.conn.commit()
        with (
            patch.object(
                self.chat_api,
                "load_config",
                return_value=Config(),
            ),
            self.assertRaises(self.chat_api.HTTPException) as pdf_ctx,
        ):
            asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(
                        content="Use this PDF context",
                        context_items=[
                            ChatContextItem(
                                kind="pdf_asset",
                                source="active_ui",
                                ref=ChatContextRef(paper_id=paper_id, asset_id=asset.id),
                            )
                        ],
                    ),
                    conn=self.conn,
                )
            )
        self.assertEqual(pdf_ctx.exception.status_code, 400)
        self.assertIn("not locally available", str(pdf_ctx.exception.detail))

    def test_codex_cli_stream_persists_provider_state_callback(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings(backend="codex_cli"))
        self.conn.commit()
        captured_kwargs: list[dict] = []

        async def fake_chat_stream(messages, tools, cfg, **kwargs):  # noqa: ARG001
            captured_kwargs.append(kwargs)
            await kwargs["update_provider_state"]({
                "codex_cli": {
                    "thread_id": "thread-from-runtime",
                    "session_file_path": "/tmp/thread-from-runtime.jsonl",
                    "updated_at": "2026-04-28T00:00:00",
                }
            })
            yield {"type": "text", "content": "Codex response."}
            yield {"type": "done", "finish_reason": "stop"}

        with (
            patch.object(
                self.chat_api,
                "load_config",
                return_value=Config(chat=ChatConfig(backend="codex_cli")),
            ),
            self.patch_provider_stream(fake_chat_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(content="Hello Codex"),
                    conn=self.conn,
                )
            )
            payload = asyncio.run(self.read_streaming_response(response))

        self.assertIn("Codex response.", payload)
        self.assertEqual(captured_kwargs[0]["session_id"], session.id)
        self.assertEqual(captured_kwargs[0]["provider_state"], {})
        self.assertEqual(
            get_chat_session_provider_state(self.conn, session.id or 0)["codex_cli"]["thread_id"],
            "thread-from-runtime",
        )
        detail = get_chat_session_detail(self.conn, session.id or 0)
        self.assertEqual(detail.messages[1].content, "Codex response.")

    def test_stream_cancellation_does_not_persist_partial_turn(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        self.conn.commit()
        first_chunk_seen = asyncio.Event()

        async def fake_provider_stream(request):
            insert_chat_resource_reads(
                self.conn,
                session.id or 0,
                turn_id=request.turn_id,
                provider=request.cfg.chat.backend,
                source="capability_result",
                capability_name="get_papers_by_ids",
                reads=[
                    {
                        "resource_kind": "paper",
                        "resource_id": 123,
                        "label": "Pending paper",
                    }
                ],
            )
            self.conn.commit()
            yield {"type": "text", "content": "Partial response."}
            first_chunk_seen.set()
            await asyncio.Future()

        async def consume_until_cancelled(response) -> None:
            async for _chunk in response.body_iterator:
                if first_chunk_seen.is_set():
                    await asyncio.sleep(3600)

        with (
            patch.object(self.chat_api, "load_config", return_value=Config(llm=LlmConfig(api_key="test-key", model="test-model"))),
            patch.object(self.chat_api, "provider_stream", new=fake_provider_stream),
        ):
            response = asyncio.run(
                self.chat_api.stream_chat_message(
                    session.id or 0,
                    self.chat_api.CreateChatMessageRequest(content="Abort this turn"),
                    conn=self.conn,
                )
            )

            async def run_cancel() -> None:
                task = asyncio.create_task(consume_until_cancelled(response))
                await first_chunk_seen.wait()
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task

            asyncio.run(run_cancel())

        detail = get_chat_session_detail(self.conn, session.id or 0)
        self.assertIsNotNone(detail)
        self.assertEqual(detail.messages, [])
        self.assertEqual(list_chat_resource_reads(self.conn, session.id or 0), [])
        self.assertNotIn(session.id, self.chat_api._active_chat_turns)
        replacement = ChatRuntimeSettings(backend="codex_cli", model="after-cancellation")
        updated = self.chat_api.update_chat_session_endpoint(
            session.id, self.chat_api.UpdateChatSessionRequest(runtime_settings=replacement), conn=self.conn,
        )
        self.assertEqual(updated["runtime_settings"], replacement.model_dump())

    def test_system_prompt_includes_dollar_math_delimiter_rule(self) -> None:
        prompt = self.chat_api.get_system_prompt(load_config())
        self.assertIn("single dollar signs `$...$` for inline equations", prompt)
        self.assertIn("double dollar signs `$$...$$` for display/block equations", prompt)
        self.assertIn("Do not use `\\(...\\)` or `\\[...\\]`", prompt)

    def test_system_prompt_formats_multiple_profile_fields(self) -> None:
        from claudesk.core import config as cfg_mod

        cfg_mod.save_config_file(
            cfg_mod.Config(
                profile=cfg_mod.Profile(
                    name="Guang",
                    field=["biophysics", "chromatin biology"],
                    description="Studies cell mechanics.",
                )
            )
        )
        cfg_mod.load_config.cache_clear()

        prompt = self.chat_api.get_system_prompt(load_config())
        self.assertIn(
            "for Guang, a researcher working in biophysics and chromatin biology. Studies cell mechanics.",
            prompt,
        )
        self.assertNotIn("['", prompt)

    def test_system_prompt_routes_local_pdf_summary_tools(self) -> None:
        prompt = self.chat_api.get_system_prompt(load_config())
        self.assertIn("use list_recent_papers", prompt)
        self.assertIn("Do not inspect the filesystem, SQLite database, config files, or local paths", prompt)
        self.assertIn("Use get_chat_attachment_context for chat attachments", prompt)
        self.assertIn("attached file or attached PDF summaries", prompt)
        self.assertIn("search_papers is the title/topic lookup path", prompt)
        self.assertIn("use managed local paper PDFs before internet full-text", prompt)
        self.assertIn("Call list_paper_assets first when PDF availability or asset choice is unknown", prompt)
        self.assertIn("if a usable managed PDF exists, use read_paper_pdf", prompt)
        self.assertIn("Use fetch_paper_full_text for source-specific public HTML only when no usable managed PDF is available", prompt)
        self.assertIn("explicitly asks for online, arXiv, or publisher HTML/full text", prompt)
        self.assertNotIn("use fetch_paper_full_text first", prompt)
        self.assertIn("Use paper PDF tools only for managed Claudesk paper PDF assets", prompt)
        self.assertIn("Use read_paper_pdf for broad paper-PDF summaries", prompt)
        self.assertIn("Do not exhaustively read every chunk by default", prompt)
        self.assertIn("Use retrieve_paper_context for targeted factual questions", prompt)
        self.assertIn("Do not claim local PDF, full-text, image, or file evidence", prompt)
        self.assertIn("get_chat_attachment_context or the paper PDF tools", prompt)


if __name__ == "__main__":
    unittest.main()
