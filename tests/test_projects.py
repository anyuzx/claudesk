from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from datetime import date

from claudesk.core.config import ChatRuntimeSettings
from claudesk.core.db import (
    SCHEMA_VERSION,
    get_connection,
    init_db,
)
from claudesk.core.db.chat import (
    create_chat_session,
    get_chat_session_detail,
    list_project_chat_sessions,
    replace_chat_session_projects,
)
from claudesk.core.db.notes import create_note
from claudesk.core.db.assets import create_paper_asset
from claudesk.core.db.projects import (
    create_project,
    delete_project,
    get_project,
    link_project_paper,
    list_project_metrics,
    list_project_assets,
    list_project_notes,
    list_project_papers,
    list_projects,
    create_project_milestone,
    update_project,
)
from claudesk.core.db.papers import (
    get_paper,
    list_papers,
)
from claudesk.core.db.tasks import (
    get_manual_log_entry,
    get_todo,
    create_manual_log_entry,
    insert_todo,
    list_log_entries,
    list_project_todos,
    update_manual_log_entry,
    update_todo,
)
from claudesk.core.models import (
    AssetKind,
    AssetParseStatus,
    Paper,
    ManualLogEntry,
    ProjectMilestoneStatus,
    ProjectStatus,
    Todo,
    TodoPriority,
    TodoStatus,
)
from claudesk.api import projects as projects_api


def make_conn(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=3000")
    return conn


class ProjectDbTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.conn = make_conn(os.path.join(self.tmpdir.name, "claudesk.db"))
        init_db(self.conn)

    def tearDown(self) -> None:
        self.conn.close()
        self.tmpdir.cleanup()

    def _column_names(self, table_name: str) -> set[str]:
        return {
            row["name"]
            for row in self.conn.execute(f"PRAGMA table_info({table_name})").fetchall()
        }

    def test_init_db_uses_canonical_project_join_storage(self) -> None:
        version = self.conn.execute(
            "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
        ).fetchone()[0]
        todo_indexes = {
            row["name"]
            for row in self.conn.execute("PRAGMA index_list(todos)").fetchall()
        }
        log_indexes = {
            row["name"]
            for row in self.conn.execute("PRAGMA index_list(log_entries)").fetchall()
        }
        chat_indexes = {
            row["name"]
            for row in self.conn.execute("PRAGMA index_list(chat_sessions)").fetchall()
        }

        self.assertEqual(version, SCHEMA_VERSION)
        self.assertFalse({"project_id", "project_tag"} & self._column_names("todos"))
        self.assertFalse({"project_id", "project_tag"} & self._column_names("log_entries"))
        self.assertNotIn("project_id", self._column_names("chat_sessions"))
        self.assertNotIn("idx_todos_project_id", todo_indexes)
        self.assertNotIn("idx_progress_project_id", log_indexes)
        self.assertNotIn("idx_chat_sessions_project_id", chat_indexes)

    def test_init_db_backfills_projects_from_legacy_project_tags(self) -> None:
        legacy_path = os.path.join(self.tmpdir.name, "legacy.db")
        legacy = make_conn(legacy_path)
        legacy.execute("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)")
        legacy.execute("INSERT INTO schema_version (version) VALUES (7)")
        legacy.execute(
            """
            CREATE TABLE todos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                text TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'open',
                priority TEXT NOT NULL DEFAULT 'medium',
                due_date TEXT,
                project_tag TEXT,
                created_at TEXT NOT NULL,
                completed_at TEXT
            )
            """
        )
        legacy.execute(
            """
            CREATE TABLE progress_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entry_date TEXT NOT NULL,
                project_tag TEXT,
                entry TEXT NOT NULL,
                linked_paper_ids TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL
            )
            """
        )
        legacy.execute(
            """
            CREATE TABLE chat_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                linked_paper_ids TEXT NOT NULL DEFAULT '[]',
                linked_todo_ids TEXT NOT NULL DEFAULT '[]',
                linked_progress_ids TEXT NOT NULL DEFAULT '[]'
            )
            """
        )
        legacy.execute(
            """
            INSERT INTO todos (text, status, priority, due_date, project_tag, created_at, completed_at)
            VALUES ('Draft analysis', 'open', 'high', NULL, 'Chromatin', '2026-04-20T12:00:00', NULL)
            """
        )
        legacy.execute(
            """
            INSERT INTO progress_log (entry_date, project_tag, entry, linked_paper_ids, created_at)
            VALUES ('2026-04-19', 'Single Molecule', 'Ran another pull-down.', '[]', '2026-04-19T18:00:00')
            """
        )
        legacy.commit()

        init_db(legacy)

        version = legacy.execute(
            "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
        ).fetchone()[0]
        projects = legacy.execute("SELECT id, name FROM projects ORDER BY name ASC").fetchall()
        todo_row = legacy.execute(
            "SELECT id FROM todos WHERE title='Draft analysis'"
        ).fetchone()
        log_row = legacy.execute(
            "SELECT id FROM log_entries WHERE entry_markdown='Ran another pull-down.'"
        ).fetchone()
        todo_link_rows = legacy.execute(
            """
            SELECT p.name, pt.todo_id
            FROM project_todos pt
            JOIN projects p ON p.id = pt.project_id
            ORDER BY pt.todo_id, p.name
            """
        ).fetchall()
        progress_link_rows = legacy.execute(
            """
            SELECT p.name, ple.log_entry_id
            FROM project_log_entries ple
            JOIN projects p ON p.id = ple.project_id
            ORDER BY ple.log_entry_id, p.name
            """
        ).fetchall()
        todo_columns = {row["name"] for row in legacy.execute("PRAGMA table_info(todos)").fetchall()}
        progress_columns = {
            row["name"]
            for row in legacy.execute("PRAGMA table_info(log_entries)").fetchall()
        }
        chat_columns = {
            row["name"]
            for row in legacy.execute("PRAGMA table_info(chat_sessions)").fetchall()
        }

        self.assertEqual(version, SCHEMA_VERSION)
        self.assertEqual([row["name"] for row in projects], ["Chromatin", "Single Molecule"])
        self.assertFalse({"project_id", "project_tag"} & todo_columns)
        self.assertFalse({"project_id", "project_tag"} & progress_columns)
        self.assertNotIn("project_id", chat_columns)
        self.assertEqual([(row["name"], row["todo_id"]) for row in todo_link_rows], [("Chromatin", todo_row["id"])])
        self.assertEqual(
            [(row["name"], row["log_entry_id"]) for row in progress_link_rows],
            [("Single Molecule", log_row["id"])],
        )

        legacy.close()

    def test_legacy_project_tag_migration_uses_unique_slug_collisions(self) -> None:
        legacy_path = os.path.join(self.tmpdir.name, "legacy-project-tag-slugs.db")
        legacy = make_conn(legacy_path)
        legacy.execute("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)")
        legacy.execute("INSERT INTO schema_version (version) VALUES (8)")
        legacy.execute(
            """
            CREATE TABLE projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                slug TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                description TEXT,
                obsidian_note_path TEXT,
                tags TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        legacy.execute(
            """
            CREATE TABLE todos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                text TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'open',
                priority TEXT NOT NULL DEFAULT 'medium',
                due_date TEXT,
                project_tag TEXT,
                created_at TEXT NOT NULL,
                completed_at TEXT
            )
            """
        )
        legacy.execute(
            """
            CREATE TABLE progress_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entry_date TEXT NOT NULL,
                project_tag TEXT,
                entry TEXT NOT NULL,
                linked_paper_ids TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL
            )
            """
        )
        legacy.execute(
            """
            INSERT INTO projects (slug, name, status, description, obsidian_note_path, tags, created_at, updated_at)
            VALUES ('alpha', 'Existing Alpha', 'active', NULL, NULL, '[]', '2026-04-18T10:00:00', '2026-04-18T10:00:00')
            """
        )
        legacy.execute(
            """
            INSERT INTO todos (text, status, priority, due_date, project_tag, created_at, completed_at)
            VALUES ('Alpha task', 'open', 'medium', NULL, 'Alpha', '2026-04-20T12:00:00', NULL)
            """
        )
        legacy.execute(
            """
            INSERT INTO progress_log (entry_date, project_tag, entry, linked_paper_ids, created_at)
            VALUES ('2026-04-19', 'Alpha!', 'Alpha log.', '[]', '2026-04-19T18:00:00')
            """
        )
        legacy.commit()

        init_db(legacy)

        projects = legacy.execute(
            "SELECT slug, name, status, tags FROM projects ORDER BY slug ASC"
        ).fetchall()
        todo_link = legacy.execute(
            """
            SELECT p.slug
            FROM project_todos pt
            JOIN projects p ON p.id = pt.project_id
            JOIN todos t ON t.id = pt.todo_id
            WHERE t.title='Alpha task'
            """
        ).fetchone()
        log_link = legacy.execute(
            """
            SELECT p.slug
            FROM project_log_entries ple
            JOIN projects p ON p.id = ple.project_id
            JOIN log_entries l ON l.id = ple.log_entry_id
            WHERE l.entry_markdown='Alpha log.'
            """
        ).fetchone()

        self.assertEqual(
            [(row["slug"], row["name"], row["status"], row["tags"]) for row in projects],
            [
                ("alpha", "Existing Alpha", "active", "[]"),
                ("alpha-2", "Alpha", "active", "[]"),
                ("alpha-3", "Alpha!", "active", "[]"),
            ],
        )
        self.assertEqual(todo_link["slug"], "alpha-2")
        self.assertEqual(log_link["slug"], "alpha-3")

        legacy.close()

    def test_init_db_backfills_legacy_nullable_project_ids_then_removes_columns(self) -> None:
        legacy_path = os.path.join(self.tmpdir.name, "legacy-project-id.db")
        legacy = make_conn(legacy_path)
        legacy.execute("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)")
        legacy.execute("INSERT INTO schema_version (version) VALUES (8)")
        legacy.execute(
            """
            CREATE TABLE projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                slug TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                description TEXT,
                obsidian_note_path TEXT,
                tags TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        legacy.execute(
            """
            CREATE TABLE todos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                text TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'open',
                priority TEXT NOT NULL DEFAULT 'medium',
                due_date TEXT,
                project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL,
                completed_at TEXT
            )
            """
        )
        legacy.execute(
            """
            CREATE TABLE progress_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entry_date TEXT NOT NULL,
                project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
                entry TEXT NOT NULL,
                linked_paper_ids TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL
            )
            """
        )
        legacy.execute(
            """
            CREATE TABLE chat_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL DEFAULT '',
                project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                linked_paper_ids TEXT NOT NULL DEFAULT '[]',
                linked_todo_ids TEXT NOT NULL DEFAULT '[]',
                linked_progress_ids TEXT NOT NULL DEFAULT '[]'
            )
            """
        )
        project_id = legacy.execute(
            """
            INSERT INTO projects (slug, name, status, description, obsidian_note_path, tags, created_at, updated_at)
            VALUES ('legacy-project', 'Legacy Project', 'active', NULL, NULL, '[]', '2026-04-18T10:00:00', '2026-04-18T10:00:00')
            """
        ).lastrowid
        legacy.execute(
            """
            INSERT INTO todos (text, status, priority, due_date, project_id, created_at, completed_at)
            VALUES ('Legacy task', 'open', 'medium', NULL, ?, '2026-04-20T12:00:00', NULL)
            """,
            (project_id,),
        )
        legacy.execute(
            """
            INSERT INTO progress_log (entry_date, project_id, entry, linked_paper_ids, created_at)
            VALUES ('2026-04-19', ?, 'Legacy log.', '[]', '2026-04-19T18:00:00')
            """,
            (project_id,),
        )
        legacy.execute(
            """
            INSERT INTO chat_sessions (title, project_id, created_at, updated_at, linked_paper_ids, linked_todo_ids, linked_progress_ids)
            VALUES ('Legacy chat', ?, '2026-04-18T10:00:00', '2026-04-18T10:00:00', '[]', '[]', '[]')
            """,
            (project_id,),
        )
        legacy.commit()

        init_db(legacy)

        todo_row = legacy.execute("SELECT id FROM todos WHERE title='Legacy task'").fetchone()
        log_row = legacy.execute("SELECT id FROM log_entries WHERE entry_markdown='Legacy log.'").fetchone()
        chat_row = legacy.execute("SELECT id FROM chat_sessions WHERE title='Legacy chat'").fetchone()

        self.assertFalse(
            {"project_id", "project_tag"}
            & {row["name"] for row in legacy.execute("PRAGMA table_info(todos)").fetchall()}
        )
        self.assertFalse(
            {"project_id", "project_tag"}
            & {row["name"] for row in legacy.execute("PRAGMA table_info(log_entries)").fetchall()}
        )
        self.assertNotIn(
            "project_id",
            {row["name"] for row in legacy.execute("PRAGMA table_info(chat_sessions)").fetchall()},
        )
        self.assertEqual(
            legacy.execute(
                "SELECT project_id FROM project_todos WHERE todo_id=?",
                (todo_row["id"],),
            ).fetchone()["project_id"],
            project_id,
        )
        self.assertEqual(
            legacy.execute(
                "SELECT project_id FROM project_log_entries WHERE log_entry_id=?",
                (log_row["id"],),
            ).fetchone()["project_id"],
            project_id,
        )
        self.assertEqual(
            legacy.execute(
                "SELECT project_id FROM project_chat_sessions WHERE chat_session_id=?",
                (chat_row["id"],),
            ).fetchone()["project_id"],
            project_id,
        )

        legacy.close()

    def test_project_relationship_queries_and_rename_keep_tags_in_sync(self) -> None:
        project = create_project(
            self.conn,
            name="Chromatin Mechanics",
            description="Force spectroscopy follow-up",
        )
        paper_id = self.conn.execute(
            """
            INSERT INTO papers (
                source, external_id, title, abstract, authors, published_date, journal_abbrev,
                url, embedding, relevance_score, note, status, is_saved, is_read, is_to_read, fetched_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "arxiv",
                "2501.12345",
                "Chromatin force spectroscopy",
                "A test abstract.",
                '["Alice Example"]',
                "2026-04-22",
                None,
                "https://arxiv.org/abs/2501.12345",
                None,
                0.93,
                None,
                "new",
                0,
                0,
                0,
                "2026-04-22T10:00:00",
            ),
        ).lastrowid
        todo_id = insert_todo(
            self.conn,
            Todo(
                title="Read the new force paper",
                priority=TodoPriority.HIGH,
                project_ids=[project.id or 0],
            ),
        )
        progress_id = create_manual_log_entry(
            self.conn,
            ManualLogEntry(
                entry="Compared pulling geometries.",
                project_ids=[project.id or 0],
            ),
        )
        session = create_chat_session(
            self.conn,
            runtime_settings=ChatRuntimeSettings(),
            title="Chromatin chat",
            project_ids=[project.id or 0],
        )
        link_project_paper(self.conn, project.id or 0, paper_id)
        self.conn.commit()

        todos = list_project_todos(self.conn, project.id or 0)
        progress = list_log_entries(self.conn, project_id=project.id or 0, days=None)
        chats = list_project_chat_sessions(self.conn, project.id or 0)
        papers = list_project_papers(self.conn, project.id or 0)

        self.assertEqual([todo.id for todo in todos], [todo_id])
        self.assertEqual([entry.id for entry in progress], [progress_id])
        self.assertEqual([chat.id for chat in chats], [session.id])
        self.assertEqual([paper.id for paper in papers], [paper_id])
        self.assertEqual(todos[0].project_ids, [project.id])
        self.assertEqual(progress[0].project_ids, [project.id])
        self.assertEqual(chats[0].project_ids, [project.id])

        renamed = update_project(
            self.conn,
            project.id or 0,
            name="Chromatin Mechanics Revision",
            status=ProjectStatus.PAUSED,
        )
        self.conn.commit()

        updated_todo = get_todo(self.conn, todo_id)
        updated_progress = list_log_entries(self.conn, project_id=project.id or 0, days=None)[0]

        self.assertEqual(renamed.name, "Chromatin Mechanics Revision")
        self.assertEqual(renamed.status, ProjectStatus.PAUSED)
        self.assertEqual(updated_todo.project_ids, [project.id])
        self.assertEqual(updated_progress.project_ids, [project.id])

    def test_project_list_metrics_aggregate_tasks_and_milestones(self) -> None:
        active_project = create_project(self.conn, name="Active Metrics")
        done_project = create_project(
            self.conn,
            name="Done Metrics",
            status=ProjectStatus.DONE,
        )
        other_project = create_project(self.conn, name="Other Metrics")
        active_project_id = active_project.id or 0
        done_project_id = done_project.id or 0
        other_project_id = other_project.id or 0

        insert_todo(
            self.conn,
            Todo(
                title="Open active task",
                priority=TodoPriority.HIGH,
                project_ids=[active_project_id],
            ),
        )
        insert_todo(
            self.conn,
            Todo(
                title="Done active task",
                status=TodoStatus.DONE,
                priority=TodoPriority.LOW,
                project_ids=[active_project_id],
            ),
        )
        insert_todo(
            self.conn,
            Todo(
                title="Open done project task",
                project_ids=[done_project_id],
            ),
        )
        insert_todo(
            self.conn,
            Todo(
                title="Open other task",
                project_ids=[other_project_id],
            ),
        )
        create_project_milestone(
            self.conn,
            project_id=active_project_id,
            title="Blocked milestone",
            status=ProjectMilestoneStatus.BLOCKED,
        )
        create_project_milestone(
            self.conn,
            project_id=active_project_id,
            title="Ready milestone",
            status=ProjectMilestoneStatus.READY_FOR_REVIEW,
        )
        create_project_milestone(
            self.conn,
            project_id=active_project_id,
            title="Done milestone",
            status=ProjectMilestoneStatus.DONE,
        )
        create_project_milestone(
            self.conn,
            project_id=active_project_id,
            title="Dropped milestone",
            status=ProjectMilestoneStatus.DROPPED,
        )
        create_project_milestone(
            self.conn,
            project_id=done_project_id,
            title="Done project milestone",
            status=ProjectMilestoneStatus.IN_PROGRESS,
        )

        metrics = {
            metric.project_id: metric
            for metric in list_project_metrics(self.conn)
        }

        self.assertEqual(metrics[active_project_id].open_task_count, 1)
        self.assertEqual(metrics[active_project_id].milestone_count, 4)
        self.assertEqual(metrics[active_project_id].active_milestone_count, 3)
        self.assertEqual(metrics[active_project_id].blocked_milestone_count, 1)
        self.assertEqual(metrics[active_project_id].ready_for_review_count, 1)
        self.assertEqual(metrics[active_project_id].done_milestone_count, 1)
        self.assertEqual(metrics[done_project_id].open_task_count, 1)
        self.assertEqual(metrics[other_project_id].open_task_count, 1)

        non_done_metrics = {
            metric.project_id: metric
            for metric in list_project_metrics(self.conn, include_done=False)
        }
        self.assertIn(active_project_id, non_done_metrics)
        self.assertNotIn(done_project_id, non_done_metrics)

        api_metrics = {
            item["project_id"]: item
            for item in projects_api.get_project_list_metrics(conn=self.conn)
        }
        self.assertEqual(api_metrics[active_project_id]["open_task_count"], 1)
        self.assertEqual(api_metrics[active_project_id]["blocked_milestone_count"], 1)

    def test_project_description_preserves_markdown_blocks(self) -> None:
        markdown_description = "Initial **markdown** description.\n\n- scoped save"
        project = create_project(
            self.conn,
            name="Markdown Description",
            description=markdown_description,
        )

        self.assertEqual(project.description, markdown_description)

        updated = update_project(
            self.conn,
            project.id or 0,
            description="  Updated **project** description.\n\n- preserved block  ",
        )

        self.assertEqual(updated.description, "Updated **project** description.\n\n- preserved block")

        cleared = update_project(self.conn, project.id or 0, description="  \n  ")

        self.assertIsNone(cleared.description)

    def test_project_notes_and_assets_are_read_through_linked_papers(self) -> None:
        project = create_project(self.conn, name="PDF Project")
        paper_id = self.conn.execute(
            """
            INSERT INTO papers (
                source, external_id, title, abstract, authors, published_date, journal_abbrev,
                url, embedding, relevance_score, note, status, is_saved, is_read, is_to_read, fetched_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "biorxiv",
                "10.1234/project-assets",
                "Project asset paper",
                "A test abstract.",
                '["Alice Example"]',
                "2026-04-22",
                None,
                "https://example.com/project-assets",
                None,
                0.8,
                None,
                "new",
                0,
                0,
                0,
                "2026-04-22T10:00:00",
            ),
        ).lastrowid
        link_project_paper(self.conn, project.id or 0, paper_id)
        note = create_note(
            self.conn,
            title="Project note",
            body="Linked note body.",
            manual_paper_ids=[paper_id],
        )
        asset = create_paper_asset(
            self.conn,
            paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path=f"papers/{paper_id}/project.pdf",
            original_filename="project.pdf",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-project",
            parse_status=AssetParseStatus.NOT_PARSED,
        )
        self.conn.commit()

        notes = list_project_notes(self.conn, project.id or 0)
        assets = list_project_assets(self.conn, project.id or 0)
        api_notes = projects_api.get_project_notes_endpoint(project.id or 0, conn=self.conn)
        api_assets = projects_api.get_project_assets_endpoint(project.id or 0, conn=self.conn)

        self.assertEqual([item.id for item in notes], [note.id])
        self.assertEqual(len(assets), 1)
        self.assertEqual(assets[0][0], paper_id)
        self.assertEqual(assets[0][1], "Project asset paper")
        self.assertEqual(assets[0][2].id, asset.id)
        self.assertEqual(api_notes[0]["id"], note.id)
        self.assertEqual(api_assets[0]["id"], asset.id)
        self.assertEqual(api_assets[0]["paper_id"], paper_id)
        self.assertEqual(api_assets[0]["paper_title"], "Project asset paper")

    def test_shared_items_appear_in_multiple_project_queries_and_links_can_be_replaced(self) -> None:
        project_a = create_project(self.conn, name="Optical Tweezers")
        project_b = create_project(self.conn, name="Magnetic Tweezers")
        todo_id = insert_todo(
            self.conn,
            Todo(
                title="Calibrate trap stiffness",
                priority=TodoPriority.MEDIUM,
                project_ids=[project_a.id or 0, project_b.id or 0],
            ),
        )
        progress_id = create_manual_log_entry(
            self.conn,
            ManualLogEntry(
                entry="Calibrated bead set A.",
                project_ids=[project_a.id or 0, project_b.id or 0],
            ),
        )
        session = create_chat_session(
            self.conn,
            runtime_settings=ChatRuntimeSettings(),
            title="Tweezers session",
            project_ids=[project_a.id or 0, project_b.id or 0],
        )
        self.conn.commit()

        self.assertEqual(
            [todo.id for todo in list_project_todos(self.conn, project_a.id or 0)],
            [todo_id],
        )
        self.assertEqual(
            [todo.id for todo in list_project_todos(self.conn, project_b.id or 0)],
            [todo_id],
        )
        self.assertEqual(
            [
                entry.id
                for entry in list_log_entries(self.conn, project_id=project_a.id or 0, days=None)
            ],
            [progress_id],
        )
        self.assertEqual(
            [
                entry.id
                for entry in list_log_entries(self.conn, project_id=project_b.id or 0, days=None)
            ],
            [progress_id],
        )
        self.assertEqual(
            [chat.id for chat in list_project_chat_sessions(self.conn, project_a.id or 0)],
            [session.id],
        )
        self.assertEqual(
            [chat.id for chat in list_project_chat_sessions(self.conn, project_b.id or 0)],
            [session.id],
        )

        update_todo(
            self.conn,
            todo_id,
            "Calibrate trap stiffness",
            "",
            TodoPriority.MEDIUM.value,
            [project_b.id or 0],
            None,
        )
        update_manual_log_entry(
            self.conn,
            progress_id,
            "Calibrated bead set A.",
            [],
            [],
        )
        replace_chat_session_projects(self.conn, session.id or 0, [project_b.id or 0])
        self.conn.commit()

        updated_todo = get_todo(self.conn, todo_id)
        updated_progress = get_manual_log_entry(self.conn, progress_id)
        updated_session = get_chat_session_detail(self.conn, session.id or 0)

        self.assertEqual(updated_todo.project_ids, [project_b.id])
        self.assertEqual(updated_progress.project_ids, [])
        self.assertEqual(updated_session.project_ids, [project_b.id])
        self.assertEqual(list_project_todos(self.conn, project_a.id or 0), [])
        self.assertEqual(
            [todo.id for todo in list_project_todos(self.conn, project_b.id or 0)],
            [todo_id],
        )
        self.assertEqual(
            list_log_entries(self.conn, project_id=project_a.id or 0, days=None),
            [],
        )
        self.assertEqual(
            list_log_entries(self.conn, project_id=project_b.id or 0, days=None),
            [],
        )
        self.assertEqual(list_project_chat_sessions(self.conn, project_a.id or 0), [])
        self.assertEqual(
            [chat.id for chat in list_project_chat_sessions(self.conn, project_b.id or 0)],
            [session.id],
        )

    def test_delete_project_removes_join_rows_but_keeps_related_records(self) -> None:
        project = create_project(self.conn, name="Optical Tweezers")
        second_project = create_project(self.conn, name="Trap Calibration")
        todo_id = insert_todo(
            self.conn,
            Todo(
                title="Calibrate trap stiffness",
                priority=TodoPriority.MEDIUM,
                project_ids=[project.id or 0, second_project.id or 0],
            ),
        )
        progress_id = create_manual_log_entry(
            self.conn,
            ManualLogEntry(
                entry="Calibrated bead set A.",
                project_ids=[project.id or 0, second_project.id or 0],
            ),
        )
        session = create_chat_session(
            self.conn,
            runtime_settings=ChatRuntimeSettings(),
            title="Tweezers session",
            project_ids=[project.id or 0, second_project.id or 0],
        )
        self.conn.commit()

        delete_project(self.conn, project.id or 0)
        self.conn.commit()

        remaining_todo = get_todo(self.conn, todo_id)
        remaining_progress = get_manual_log_entry(self.conn, progress_id)
        remaining_session = get_chat_session_detail(self.conn, session.id or 0)
        todo_link_rows = self.conn.execute(
            "SELECT project_id FROM project_todos WHERE todo_id=? ORDER BY project_id",
            (todo_id,),
        ).fetchall()
        progress_link_rows = self.conn.execute(
            """
            SELECT project_id
            FROM project_log_entries
            WHERE log_entry_id=?
            ORDER BY project_id
            """,
            (progress_id,),
        ).fetchall()
        chat_link_rows = self.conn.execute(
            """
            SELECT project_id
            FROM project_chat_sessions
            WHERE chat_session_id=?
            ORDER BY project_id
            """,
            (session.id,),
        ).fetchall()

        self.assertIsNone(get_project(self.conn, project.id or 0))
        self.assertIsNotNone(remaining_todo)
        self.assertIsNotNone(remaining_progress)
        self.assertIsNotNone(remaining_session)
        self.assertEqual(remaining_todo.project_ids, [second_project.id])
        self.assertEqual(remaining_progress.project_ids, [second_project.id])
        self.assertEqual(remaining_session.project_ids, [second_project.id])
        self.assertEqual([row["project_id"] for row in todo_link_rows], [second_project.id])
        self.assertEqual([row["project_id"] for row in progress_link_rows], [second_project.id])
        self.assertEqual([row["project_id"] for row in chat_link_rows], [second_project.id])

    def test_papers_expose_all_linked_project_ids_on_shared_queries(self) -> None:
        project_a = create_project(self.conn, name="Chromatin Mechanics")
        project_b = create_project(self.conn, name="DNA Repair")
        paper_id = self.conn.execute(
            """
            INSERT INTO papers (
                source, external_id, title, abstract, authors, published_date, journal_abbrev,
                url, embedding, relevance_score, note, status, is_saved, is_read, is_to_read, fetched_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "arxiv",
                "2504.42424",
                "Nucleosome remodeling measurements",
                "A test abstract.",
                '["Alice Example"]',
                "2026-04-24",
                None,
                "https://arxiv.org/abs/2504.42424",
                None,
                0.88,
                None,
                "new",
                0,
                0,
                0,
                "2026-04-24T09:00:00",
            ),
        ).lastrowid
        link_project_paper(self.conn, project_a.id or 0, paper_id)
        link_project_paper(self.conn, project_b.id or 0, paper_id)
        self.conn.commit()

        paper = get_paper(self.conn, paper_id)
        listed_papers = list_papers(self.conn)
        project_papers = list_project_papers(self.conn, project_a.id or 0)

        self.assertIsNotNone(paper)
        self.assertEqual(paper.project_ids, [project_a.id, project_b.id])
        self.assertEqual(len(listed_papers), 1)
        self.assertEqual(listed_papers[0].project_ids, [project_a.id, project_b.id])
        self.assertEqual(len(project_papers), 1)
        self.assertEqual(project_papers[0].project_ids, [project_a.id, project_b.id])


if __name__ == "__main__":
    unittest.main()
