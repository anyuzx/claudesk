from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from datetime import date, datetime

from claudesk.core.db import (
    SCHEMA_VERSION,
    init_db,
)
from claudesk.core.db.tasks import (
    complete_todo,
    delete_todo,
    get_todo,
    insert_todo,
    create_manual_log_entry as db_create_manual_log_entry,
    list_log_entries,
    list_manual_log_entries,
    list_root_todos_with_subtasks,
    list_subtasks,
    list_todos,
    reopen_todo,
    search_todos,
)
from claudesk.core.db.projects import create_project
from claudesk.core.db.papers import upsert_paper
from claudesk.core.task_log_workflows import (
    create_manual_log_from_text,
    create_task,
    update_manual_log_from_text,
    update_task_fields,
)
from claudesk.core.models import (
    Paper,
    PaperStatus,
    ManualLogEntry,
    ProjectStatus,
    Todo,
    TodoPriority,
    TodoStatus,
)
from claudesk.api.log import (
    CreateLogEntry,
    UpdateLogEntry,
    create_manual_log_entry as api_create_manual_log_entry,
    delete_manual_log_entry,
    get_log_entries,
    update_manual_log_entry,
)
from claudesk.api.todos import UpdateTodo, update_todo_endpoint


def make_conn(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=3000")
    return conn


class TaskCascadeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.conn = make_conn(os.path.join(self.tmpdir.name, "claudesk.db"))
        init_db(self.conn)

    def tearDown(self) -> None:
        self.conn.close()
        self.tmpdir.cleanup()

    def _add_root(self, text: str = "Root task") -> int:
        return insert_todo(self.conn, Todo(title=text, priority=TodoPriority.MEDIUM))

    def _add_subtask(self, parent_id: int, text: str) -> int:
        return insert_todo(
            self.conn,
            Todo(title=text, priority=TodoPriority.MEDIUM, parent_id=parent_id),
        )

    # ------------------------------------------------------------------ T1
    def test_root_with_subtask_is_listed_nested(self) -> None:
        root_id = self._add_root("Plan analysis")
        sub_a = self._add_subtask(root_id, "Outline figures")
        sub_b = self._add_subtask(root_id, "Draft methods")

        nested = list_root_todos_with_subtasks(self.conn, status=TodoStatus.OPEN)
        self.assertEqual(len(nested), 1)
        root = nested[0]
        self.assertEqual(root.id, root_id)
        self.assertIsNone(root.parent_id)
        self.assertEqual([s.id for s in root.subtasks], [sub_a, sub_b])
        self.assertEqual([s.parent_id for s in root.subtasks], [root_id, root_id])
        # sort_order auto-incremented per parent
        self.assertEqual([s.sort_order for s in root.subtasks], [0, 1])

    # ------------------------------------------------------------------ T2
    def test_partial_subtask_completion_does_not_complete_parent(self) -> None:
        root_id = self._add_root()
        sub_a = self._add_subtask(root_id, "first")
        self._add_subtask(root_id, "second")
        self._add_subtask(root_id, "third")

        result = complete_todo(self.conn, sub_a)
        self.conn.commit()

        self.assertEqual(result["completed_ids"], [sub_a])
        # Parent still open; no task activity yet.
        parent = get_todo(self.conn, root_id)
        self.assertIsNotNone(parent)
        assert parent is not None
        self.assertEqual(parent.status, TodoStatus.OPEN)
        self.assertEqual(list_manual_log_entries(self.conn), [])

    # ------------------------------------------------------------------ T3
    def test_completing_last_subtask_cascades_without_manual_log(self) -> None:
        root_id = self._add_root("Wrap up section 2")
        sub_a = self._add_subtask(root_id, "draft text")
        sub_b = self._add_subtask(root_id, "fix figure")

        complete_todo(self.conn, sub_a)
        result = complete_todo(self.conn, sub_b)
        self.conn.commit()

        self.assertIn(root_id, result["completed_ids"])
        self.assertIn(sub_b, result["completed_ids"])
        self.assertEqual(result["root_id"], root_id)
        parent = get_todo(self.conn, root_id)
        assert parent is not None
        self.assertEqual(parent.status, TodoStatus.DONE)
        self.assertEqual(list_manual_log_entries(self.conn), [])

    # ------------------------------------------------------------------ T4
    def test_completing_parent_cascades_to_open_subtasks(self) -> None:
        root_id = self._add_root("Run experiment X")
        sub_a = self._add_subtask(root_id, "set up rig")
        sub_b = self._add_subtask(root_id, "collect data")

        result = complete_todo(self.conn, root_id)
        self.conn.commit()

        self.assertEqual(set(result["completed_ids"]), {root_id, sub_a, sub_b})
        self.assertEqual(result["root_id"], root_id)
        for tid in (sub_a, sub_b, root_id):
            row = get_todo(self.conn, tid)
            assert row is not None
            self.assertEqual(row.status, TodoStatus.DONE, f"todo {tid} should be done")
        self.assertEqual(list_manual_log_entries(self.conn), [])

    # ------------------------------------------------------------------ T5
    def test_completing_simple_task_does_not_create_manual_log(self) -> None:
        tid = self._add_root("Email collaborator about Fig 3")

        result = complete_todo(self.conn, tid)
        self.conn.commit()

        self.assertEqual(result["completed_ids"], [tid])
        self.assertEqual(result["root_id"], tid)
        self.assertEqual(list_manual_log_entries(self.conn), [])

    # ------------------------------------------------------------------ T6
    def test_reopen_subtask_reopens_parent(self) -> None:
        root_id = self._add_root("Plan")
        sub_a = self._add_subtask(root_id, "alpha")
        sub_b = self._add_subtask(root_id, "beta")
        # Complete both → cascade closes parent
        complete_todo(self.conn, sub_a)
        complete_todo(self.conn, sub_b)
        self.conn.commit()
        self.assertEqual(len(list_manual_log_entries(self.conn)), 0)

        reopen = reopen_todo(self.conn, sub_a)
        self.conn.commit()

        self.assertIn(sub_a, reopen["reopened_ids"])
        self.assertIn(root_id, reopen["reopened_ids"])
        # Parent and the reopened subtask are now open again
        sub_after = get_todo(self.conn, sub_a)
        parent_after = get_todo(self.conn, root_id)
        other_after = get_todo(self.conn, sub_b)
        assert sub_after is not None and parent_after is not None and other_after is not None
        self.assertEqual(sub_after.status, TodoStatus.OPEN)
        self.assertEqual(parent_after.status, TodoStatus.OPEN)
        # The other (untouched) subtask stays done
        self.assertEqual(other_after.status, TodoStatus.DONE)
        self.assertEqual(len(list_manual_log_entries(self.conn)), 0)

    # ------------------------------------------------------------------ T7
    def test_reopen_then_recomplete_does_not_create_manual_log(self) -> None:
        root_id = self._add_root("Write up")
        sub_a = self._add_subtask(root_id, "intro")

        complete_todo(self.conn, root_id)
        self.conn.commit()
        self.assertEqual(len(list_manual_log_entries(self.conn)), 0)

        reopen_todo(self.conn, root_id)
        self.conn.commit()
        # Subtask stays done after reopen of root → re-completing root is a no-op for subs
        result = complete_todo(self.conn, root_id)
        self.conn.commit()

        self.assertEqual(len(list_manual_log_entries(self.conn)), 0)
        # The subtask was not re-marked (already done)
        self.assertEqual(result["completed_ids"], [root_id])
        # Reference the unused subtask id to avoid lint noise.
        self.assertIsNotNone(get_todo(self.conn, sub_a))

    # ------------------------------------------------------------------ T8
    def test_paper_to_read_state_unaffected_by_task_completion(self) -> None:
        paper = Paper(
            source="arxiv",
            external_id="2401.99999",
            title="Sample paper",
            abstract="abs",
            authors=["A"],
            published_date=date(2026, 1, 1),
            url="https://arxiv.org/abs/2401.99999",
            status=PaperStatus.NEW,
            is_to_read=True,
        )
        paper_id = upsert_paper(self.conn, paper)
        self.conn.commit()
        tid = self._add_root("Unrelated task")
        complete_todo(self.conn, tid)
        self.conn.commit()
        # Paper to_read flag untouched
        cur = self.conn.execute(
            "SELECT is_to_read, status FROM papers WHERE id=?", (paper_id,)
        )
        row = cur.fetchone()
        self.assertEqual(int(row["is_to_read"]), 1)
        self.assertEqual(row["status"], "new")

    # ------------------------------------------------------------------ T9
    def test_completed_task_is_listed_as_done_task_not_progress(self) -> None:
        tid = self._add_root("Hand off draft")
        complete_todo(self.conn, tid)
        self.conn.commit()
        self.assertEqual(list_manual_log_entries(self.conn), [])
        # And list_todos still surfaces the now-done task
        todos = list_todos(self.conn, status=TodoStatus.DONE)
        self.assertEqual([t.id for t in todos], [tid])

    # ------------------------------------------------------------------ T10
    def test_paper_mention_in_task_does_not_write_manual_log(self) -> None:
        paper = Paper(
            source="arxiv",
            external_id="2401.55555",
            title="Cited paper",
            abstract="abs",
            authors=["B"],
            published_date=date(2026, 1, 1),
            url="https://arxiv.org/abs/2401.55555",
        )
        paper_id = upsert_paper(self.conn, paper)
        self.conn.commit()
        # Paper mention markdown: [label](paper://N)
        root_id = insert_todo(
            self.conn,
            Todo(
                title=f"Read [Cited paper](paper://{paper_id}) and summarize",
                priority=TodoPriority.MEDIUM,
            ),
        )
        complete_todo(self.conn, root_id)
        self.conn.commit()
        self.assertEqual(list_manual_log_entries(self.conn), [])
        task_entries = list_log_entries(self.conn, days=None, entry_type="task")
        self.assertEqual([entry.linked_paper_ids for entry in task_entries], [[paper_id]])

    def test_task_workflow_normalizes_agent_paper_mentions(self) -> None:
        project = create_project(self.conn, name="Workflow Project")
        paper_id = upsert_paper(self.conn, Paper(
            source="arxiv",
            external_id="2401.77777",
            title="Workflow paper",
            abstract="abs",
            authors=["B"],
            published_date=date(2026, 1, 1),
            url="https://arxiv.org/abs/2401.77777",
        ))

        created = create_task(
            self.conn,
            title="Review",
            description="Read Workflow paper",
            priority="high",
            project_ids=[project.id or 0],
            due_date="2026-05-25",
            paper_ids=[paper_id],
        )

        task = created.task
        assert task is not None
        self.assertEqual(task.description, f"Read [@Workflow paper](paper://{paper_id})")
        self.assertEqual(task.priority, TodoPriority.HIGH)
        self.assertEqual(task.project_ids, [project.id])
        self.assertEqual(task.due_date, date(2026, 5, 25))

        updated = update_task_fields(
            self.conn,
            created.task_id,
            description=f"Revisit paper://{paper_id}",
            paper_ids=[paper_id],
        )

        assert updated.after is not None
        self.assertEqual(updated.before.description, f"Read [@Workflow paper](paper://{paper_id})")
        self.assertEqual(updated.after.description, f"Revisit [@Workflow paper](paper://{paper_id})")

    # ------------------------------------------------------------------ Extra
    def test_completed_task_keeps_project_links_on_task(self) -> None:
        project = create_project(
            self.conn,
            name="Chromatin",
            status=ProjectStatus.ACTIVE,
        )
        self.conn.commit()
        project_id = project.id
        assert project_id is not None
        root_id = insert_todo(
            self.conn,
            Todo(
                title="Run pull-down",
                priority=TodoPriority.MEDIUM,
                project_ids=[project_id],
            ),
        )
        complete_todo(self.conn, root_id)
        self.conn.commit()
        task = get_todo(self.conn, root_id)
        assert task is not None
        self.assertEqual(task.project_ids, [project_id])
        self.assertEqual(list_manual_log_entries(self.conn), [])

    def test_list_log_entries_combines_manual_and_task_activity(self) -> None:
        project = create_project(
            self.conn,
            name="Ledger Project",
            status=ProjectStatus.ACTIVE,
        )
        self.conn.commit()
        project_id = project.id
        assert project_id is not None
        manual_id = db_create_manual_log_entry(
            self.conn,
            ManualLogEntry(
                entry_date=date(2026, 5, 19),
                entry="Meeting with collaborator\n\nReviewed the next analysis branch.",
                project_ids=[project_id],
                created_at=datetime(2026, 5, 19, 9, 0, 0),
            ),
        )
        root_id = insert_todo(
            self.conn,
            Todo(
                title="Finish ledger task",
                description="Task body details.",
                priority=TodoPriority.MEDIUM,
                project_ids=[project_id],
            ),
        )
        subtask_id = insert_todo(
            self.conn,
            Todo(
                title="Check boxed subtask",
                priority=TodoPriority.MEDIUM,
                parent_id=root_id,
                project_ids=[project_id],
            ),
        )
        complete_todo(self.conn, root_id)
        self.conn.execute(
            "UPDATE todos SET completed_at=?, updated_at=? WHERE id IN (?, ?)",
            ("2026-05-19T11:00:00", "2026-05-19T11:00:00", root_id, subtask_id),
        )
        self.conn.execute(
            "UPDATE log_entries SET entry_date=?, created_at=? WHERE entry_type='task' AND task_id=?",
            ("2026-05-19", "2026-05-19T11:00:00", root_id),
        )
        self.conn.commit()

        entries = list_log_entries(self.conn, days=None)

        self.assertEqual([entry.entry_type for entry in entries], ["task", "manual"])
        task_entry = entries[0]
        self.assertEqual(task_entry.task_id, root_id)
        self.assertEqual(task_entry.title, "Finish ledger task")
        self.assertEqual(task_entry.body_markdown, "Task body details.")
        self.assertEqual(task_entry.task_id, root_id)
        self.assertEqual([subtask.title for subtask in task_entry.subtasks], ["Check boxed subtask"])
        manual_entry = entries[1]
        self.assertEqual(manual_entry.id, manual_id)
        self.assertEqual(manual_entry.title, "Meeting with collaborator")
        self.assertEqual(manual_entry.body_markdown, "Reviewed the next analysis branch.")

    def test_insert_completed_root_task_creates_task_log_entry(self) -> None:
        completed_at = datetime(2026, 5, 20, 10, 15, 0)
        task_id = insert_todo(
            self.conn,
            Todo(
                title="Imported completed task",
                description="Imported completion detail.",
                status=TodoStatus.DONE,
                priority=TodoPriority.MEDIUM,
                completed_at=completed_at,
            ),
        )
        self.conn.commit()

        rows = self.conn.execute(
            """
            SELECT
                id, entry_type, task_id, entry_date, created_at,
                entry_markdown, linked_paper_ids
            FROM log_entries
            WHERE entry_type='task'
            """
        ).fetchall()
        self.assertEqual(len(rows), 1)
        self.assertIsInstance(rows[0]["id"], int)
        self.assertEqual(rows[0]["task_id"], task_id)
        self.assertEqual(rows[0]["entry_date"], "2026-05-20")
        self.assertEqual(rows[0]["created_at"], "2026-05-20T10:15:00")
        self.assertEqual(rows[0]["entry_markdown"], "")
        self.assertEqual(rows[0]["linked_paper_ids"], "[]")

        entries = list_log_entries(self.conn, days=None, entry_type="task")

        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertEqual(entry.id, rows[0]["id"])
        self.assertEqual(entry.task_id, task_id)
        self.assertEqual(entry.title, "Imported completed task")
        self.assertEqual(entry.body_markdown, "Imported completion detail.")
        self.assertEqual(entry.entry_date, date(2026, 5, 20))
        self.assertEqual(entry.created_at, completed_at)

    def test_insert_completed_subtask_does_not_create_task_log_entry(self) -> None:
        root_id = insert_todo(
            self.conn,
            Todo(title="Open parent task", priority=TodoPriority.MEDIUM),
        )
        insert_todo(
            self.conn,
            Todo(
                title="Imported completed subtask",
                status=TodoStatus.DONE,
                priority=TodoPriority.MEDIUM,
                completed_at=datetime(2026, 5, 20, 10, 15, 0),
                parent_id=root_id,
            ),
        )
        self.conn.commit()

        rows = self.conn.execute("SELECT id FROM log_entries WHERE entry_type='task'").fetchall()
        entries = list_log_entries(self.conn, days=None, entry_type="task")

        self.assertEqual(rows, [])
        self.assertEqual(entries, [])

    def test_list_log_entries_filters_type_query_and_project(self) -> None:
        included_project = create_project(
            self.conn,
            name="Included Ledger",
            status=ProjectStatus.ACTIVE,
        )
        excluded_project = create_project(
            self.conn,
            name="Excluded Ledger",
            status=ProjectStatus.ACTIVE,
        )
        self.conn.commit()
        included_id = included_project.id
        excluded_id = excluded_project.id
        assert included_id is not None and excluded_id is not None
        manual_id = db_create_manual_log_entry(
            self.conn,
            ManualLogEntry(
                entry="Manual alpha marker\n\nGamma appears later.",
                project_ids=[included_id],
            ),
        )
        db_create_manual_log_entry(
            self.conn,
            ManualLogEntry(
                entry="Other manual entry",
                project_ids=[excluded_id],
            ),
        )
        root_id = insert_todo(
            self.conn,
            Todo(
                title="Task query marker",
                description="Alpha result details with gamma elsewhere.",
                priority=TodoPriority.MEDIUM,
                project_ids=[included_id],
            ),
        )
        complete_todo(self.conn, root_id)
        self.conn.commit()

        manual_entries = list_log_entries(self.conn, days=None, entry_type="manual")
        task_entries = list_log_entries(self.conn, days=None, entry_type="task")
        project_entries = list_log_entries(self.conn, days=None, project_id=included_id)
        query_entries = list_log_entries(self.conn, days=None, query="task query")
        term_query_entries = list_log_entries(self.conn, days=None, query="alpha gamma")
        missing_term_entries = list_log_entries(self.conn, days=None, query="alpha missing")

        self.assertEqual({entry.entry_type for entry in manual_entries}, {"manual"})
        self.assertEqual({entry.entry_type for entry in task_entries}, {"task"})
        self.assertEqual({entry.project_ids[0] for entry in project_entries}, {included_id})
        task_log_id = task_entries[0].id
        self.assertEqual([(entry.entry_type, entry.id) for entry in query_entries], [("task", task_log_id)])
        self.assertEqual(
            {(entry.entry_type, entry.id) for entry in term_query_entries},
            {("manual", manual_id), ("task", task_log_id)},
        )
        self.assertEqual(
            {(entry.entry_type, entry.id) for entry in missing_term_entries},
            {("manual", manual_id), ("task", task_log_id)},
        )

    def test_list_log_entries_rejects_unknown_type(self) -> None:
        with self.assertRaises(ValueError):
            list_log_entries(self.conn, entry_type="system")

    def test_manual_log_api_uses_explicit_manual_routes(self) -> None:
        created = api_create_manual_log_entry(
            CreateLogEntry(
                entry="Manual API entry",
                project_ids=[],
                entry_date=date(2026, 5, 19),
            ),
            conn=self.conn,
        )
        entry_id = int(created["id"])
        created_row = self.conn.execute(
            "SELECT entry_date, created_at FROM log_entries WHERE id=?",
            (entry_id,),
        ).fetchone()
        self.assertEqual(created_row["entry_date"], "2026-05-19")
        created_at = created_row["created_at"]

        entries = get_log_entries(days=None, entry_type="manual", conn=self.conn)
        self.assertEqual(entries[0]["id"], entry_id)
        self.assertEqual(entries[0]["entry_date"], date(2026, 5, 19))
        self.assertEqual(entries[0]["title"], "Manual API entry")

        update_manual_log_entry(
            entry_id,
            UpdateLogEntry(
                entry="Updated API entry",
                project_ids=[],
                entry_date=date(2026, 5, 20),
            ),
            conn=self.conn,
        )
        updated_row = self.conn.execute(
            "SELECT entry_date, created_at FROM log_entries WHERE id=?",
            (entry_id,),
        ).fetchone()
        self.assertEqual(updated_row["entry_date"], "2026-05-20")
        self.assertEqual(updated_row["created_at"], created_at)
        updated = get_log_entries(days=None, q="updated api", conn=self.conn)
        self.assertEqual(updated[0]["entry_date"], date(2026, 5, 20))
        self.assertEqual(updated[0]["title"], "Updated API entry")

        delete_manual_log_entry(entry_id, conn=self.conn)
        self.assertEqual(get_log_entries(days=None, conn=self.conn), [])

    def test_manual_log_workflow_derives_links_and_preserves_projects(self) -> None:
        project = create_project(self.conn, name="Log Workflow Project")
        paper_id = upsert_paper(self.conn, Paper(
            source="arxiv",
            external_id="2401.88888",
            title="Log workflow paper",
            abstract="abs",
            authors=["C"],
            published_date=date(2026, 1, 1),
            url="https://arxiv.org/abs/2401.88888",
        ))

        created = create_manual_log_from_text(
            self.conn,
            entry="Discussed Log workflow paper",
            project_ids=[project.id or 0],
            entry_date=date(2026, 5, 21),
            paper_ids=[paper_id],
        )

        assert created.entry is not None
        self.assertEqual(created.entry.entry, f"Discussed [@Log workflow paper](paper://{paper_id})")
        self.assertEqual(created.entry.linked_paper_ids, [paper_id])
        self.assertEqual(created.entry.project_ids, [project.id])

        updated = update_manual_log_from_text(
            self.conn,
            created.entry_id,
            entry=f"Revisited paper://{paper_id}",
            project_ids=None,
            paper_ids=[paper_id],
        )

        assert updated.after is not None
        self.assertEqual(updated.after.entry, f"Revisited [@Log workflow paper](paper://{paper_id})")
        self.assertEqual(updated.after.linked_paper_ids, [paper_id])
        self.assertEqual(updated.after.project_ids, [project.id])

    def test_list_subtasks_returns_in_sort_order(self) -> None:
        root_id = self._add_root()
        s1 = self._add_subtask(root_id, "first")
        s2 = self._add_subtask(root_id, "second")
        subs = list_subtasks(self.conn, root_id)
        self.assertEqual([s.id for s in subs], [s1, s2])

    def test_delete_root_cascades_to_subtasks(self) -> None:
        root_id = self._add_root()
        sub_a = self._add_subtask(root_id, "child")
        delete_todo(self.conn, root_id)
        self.conn.commit()
        self.assertIsNone(get_todo(self.conn, root_id))
        self.assertIsNone(get_todo(self.conn, sub_a))

    def test_update_endpoint_preserves_omitted_description_and_allows_explicit_clear(self) -> None:
        task_id = insert_todo(
            self.conn,
            Todo(
                title="Original task",
                description="Keep [@paper](paper://1)",
                priority=TodoPriority.MEDIUM,
            ),
        )
        self.conn.commit()

        update_todo_endpoint(
            task_id,
            UpdateTodo(title="Renamed task", priority=TodoPriority.LOW.value),
            conn=self.conn,
        )

        preserved = get_todo(self.conn, task_id)
        assert preserved is not None
        self.assertEqual(preserved.title, "Renamed task")
        self.assertEqual(preserved.description, "Keep [@paper](paper://1)")

        update_todo_endpoint(
            task_id,
            UpdateTodo(
                title="Renamed task",
                description="",
                priority=TodoPriority.LOW.value,
            ),
            conn=self.conn,
        )

        cleared = get_todo(self.conn, task_id)
        assert cleared is not None
        self.assertEqual(cleared.description, "")

    def test_schema_version_is_ten(self) -> None:
        row = self.conn.execute(
            "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
        ).fetchone()
        self.assertEqual(int(row["version"]), SCHEMA_VERSION)

    def test_migrates_legacy_task_text_to_title_description_and_fts(self) -> None:
        legacy = make_conn(os.path.join(self.tmpdir.name, "legacy-tasks.db"))
        try:
            legacy.executescript("""
                CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
                INSERT INTO schema_version (version) VALUES (28);

                CREATE TABLE todos (
                    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
                    text                    TEXT NOT NULL,
                    status                  TEXT NOT NULL DEFAULT 'open',
                    priority                TEXT NOT NULL DEFAULT 'medium',
                    due_date                TEXT,
                    created_at              TEXT NOT NULL,
                    completed_at            TEXT,
                    parent_id               INTEGER,
                    sort_order              INTEGER NOT NULL DEFAULT 0,
                    updated_at              TEXT
                );

                INSERT INTO todos (text, status, priority, created_at, updated_at)
                VALUES ('Legacy task text', 'open', 'medium', '2026-05-19T10:00:00', '2026-05-19T10:00:00');
            """)

            init_db(legacy)

            columns = {
                row["name"]
                for row in legacy.execute("PRAGMA table_info(todos)").fetchall()
            }
            self.assertIn("title", columns)
            self.assertIn("description", columns)
            self.assertNotIn("text", columns)
            self.assertNotIn("completion_log_entry_id", columns)

            row = legacy.execute("SELECT title, description FROM todos").fetchone()
            self.assertEqual(row["title"], "Legacy task text")
            self.assertEqual(row["description"], "")
            self.assertEqual(search_todos(legacy, "legacy")[0].title, "Legacy task text")
        finally:
            legacy.close()

    def test_title_migration_preserves_completion_log_links_until_cleanup(self) -> None:
        legacy = make_conn(os.path.join(self.tmpdir.name, "legacy-text-completion-log.db"))
        try:
            legacy.executescript("""
                CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
                INSERT INTO schema_version (version) VALUES (28);

                CREATE TABLE todos (
                    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
                    text                    TEXT NOT NULL,
                    status                  TEXT NOT NULL DEFAULT 'open',
                    priority                TEXT NOT NULL DEFAULT 'medium',
                    due_date                TEXT,
                    created_at              TEXT NOT NULL,
                    completed_at            TEXT,
                    parent_id               INTEGER,
                    sort_order              INTEGER NOT NULL DEFAULT 0,
                    updated_at              TEXT,
                    completion_log_entry_id INTEGER
                );

                CREATE TABLE progress_log (
                    id               INTEGER PRIMARY KEY AUTOINCREMENT,
                    entry_date       TEXT NOT NULL,
                    entry            TEXT NOT NULL,
                    linked_paper_ids TEXT NOT NULL DEFAULT '[]',
                    created_at       TEXT NOT NULL
                );

                INSERT INTO progress_log (id, entry_date, entry, linked_paper_ids, created_at)
                VALUES
                    (1, '2026-05-19', 'Completed task: **Legacy text generated**', '[]', '2026-05-19T10:00:00'),
                    (2, '2026-05-19', 'Completed task: **Legacy text edited**

Edited text survives.', '[]', '2026-05-19T11:00:00');

                INSERT INTO todos (
                    id, text, status, priority, created_at, completed_at,
                    updated_at, completion_log_entry_id
                )
                VALUES
                    (
                        1, 'Legacy text generated', 'done', 'medium', '2026-05-19T09:00:00',
                        '2026-05-19T10:00:00', '2026-05-19T10:00:00', 1
                    ),
                    (
                        2, 'Legacy text edited', 'done', 'medium', '2026-05-19T09:30:00',
                        '2026-05-19T11:00:00', '2026-05-19T11:00:00', 2
                    );
            """)

            init_db(legacy)

            columns = {
                row["name"]
                for row in legacy.execute("PRAGMA table_info(todos)").fetchall()
            }
            self.assertNotIn("completion_log_entry_id", columns)
            entries = legacy.execute(
                "SELECT entry_markdown FROM log_entries WHERE entry_type='manual' ORDER BY id"
            ).fetchall()
            self.assertEqual(
                [row["entry_markdown"] for row in entries],
                ["Completed task: **Legacy text edited**\n\nEdited text survives."],
            )
            ledger_titles = {
                entry.title
                for entry in list_log_entries(legacy, days=None)
                if entry.entry_type == "task"
            }
            self.assertEqual(ledger_titles, {"Legacy text generated", "Legacy text edited"})
        finally:
            legacy.close()

    def test_project_storage_migration_preserves_completion_log_links_until_cleanup(self) -> None:
        legacy = make_conn(os.path.join(self.tmpdir.name, "legacy-project-completion-log.db"))
        try:
            legacy.executescript("""
                CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
                INSERT INTO schema_version (version) VALUES (26);

                CREATE TABLE todos (
                    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
                    text                    TEXT NOT NULL,
                    status                  TEXT NOT NULL DEFAULT 'open',
                    priority                TEXT NOT NULL DEFAULT 'medium',
                    due_date                TEXT,
                    created_at              TEXT NOT NULL,
                    completed_at            TEXT,
                    parent_id               INTEGER,
                    sort_order              INTEGER NOT NULL DEFAULT 0,
                    updated_at              TEXT,
                    project_tag             TEXT,
                    completion_log_entry_id INTEGER
                );

                CREATE TABLE progress_log (
                    id               INTEGER PRIMARY KEY AUTOINCREMENT,
                    entry_date       TEXT NOT NULL,
                    entry            TEXT NOT NULL,
                    linked_paper_ids TEXT NOT NULL DEFAULT '[]',
                    created_at       TEXT NOT NULL
                );

                INSERT INTO progress_log (id, entry_date, entry, linked_paper_ids, created_at)
                VALUES
                    (1, '2026-05-19', 'Completed task: **Tagged generated**', '[]', '2026-05-19T10:00:00'),
                    (2, '2026-05-19', 'Completed task: **Tagged edited**

Tagged edit survives.', '[]', '2026-05-19T11:00:00');

                INSERT INTO todos (
                    id, text, status, priority, created_at, completed_at,
                    updated_at, project_tag, completion_log_entry_id
                )
                VALUES
                    (
                        1, 'Tagged generated', 'done', 'medium', '2026-05-19T09:00:00',
                        '2026-05-19T10:00:00', '2026-05-19T10:00:00', 'Migration Project', 1
                    ),
                    (
                        2, 'Tagged edited', 'done', 'medium', '2026-05-19T09:30:00',
                        '2026-05-19T11:00:00', '2026-05-19T11:00:00', 'Migration Project', 2
                    );
            """)

            init_db(legacy)

            columns = {
                row["name"]
                for row in legacy.execute("PRAGMA table_info(todos)").fetchall()
            }
            self.assertNotIn("completion_log_entry_id", columns)
            entries = legacy.execute(
                "SELECT entry_markdown FROM log_entries WHERE entry_type='manual' ORDER BY id"
            ).fetchall()
            self.assertEqual(
                [row["entry_markdown"] for row in entries],
                ["Completed task: **Tagged edited**\n\nTagged edit survives."],
            )
            project_row = legacy.execute("SELECT id FROM projects WHERE name='Migration Project'").fetchone()
            self.assertIsNotNone(project_row)
            project_links = legacy.execute(
                "SELECT COUNT(*) AS count FROM project_todos WHERE project_id=?",
                (int(project_row["id"]),),
            ).fetchone()
            self.assertEqual(int(project_links["count"]), 2)
            ledger_titles = {
                entry.title
                for entry in list_log_entries(legacy, days=None)
                if entry.entry_type == "task"
            }
            self.assertEqual(ledger_titles, {"Tagged generated", "Tagged edited"})
        finally:
            legacy.close()

    def test_migration_preserves_edited_legacy_completion_log_rows_and_removes_column(self) -> None:
        legacy = make_conn(os.path.join(self.tmpdir.name, "legacy-completion-log.db"))
        try:
            legacy.executescript("""
                CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
                INSERT INTO schema_version (version) VALUES (30);

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
                );

                CREATE TABLE todos (
                    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
                    title                   TEXT NOT NULL,
                    description             TEXT NOT NULL DEFAULT '',
                    status                  TEXT NOT NULL DEFAULT 'open',
                    priority                TEXT NOT NULL DEFAULT 'medium',
                    due_date                TEXT,
                    created_at              TEXT NOT NULL,
                    completed_at            TEXT,
                    parent_id               INTEGER,
                    sort_order              INTEGER NOT NULL DEFAULT 0,
                    updated_at              TEXT,
                    completion_log_entry_id INTEGER
                );

                CREATE TABLE progress_log (
                    id               INTEGER PRIMARY KEY AUTOINCREMENT,
                    entry_date       TEXT NOT NULL,
                    entry            TEXT NOT NULL,
                    linked_paper_ids TEXT NOT NULL DEFAULT '[]',
                    created_at       TEXT NOT NULL
                );

                INSERT INTO progress_log (id, entry_date, entry, linked_paper_ids, created_at)
                VALUES
                    (1, '2026-05-19', 'Completed task: **Legacy generated**', '[]', '2026-05-19T10:00:00'),
                    (2, '2026-05-19', 'Manual note survives', '[]', '2026-05-19T11:00:00'),
                    (3, '2026-05-19', 'Completed task: **Legacy edited**

Research notes added by hand.', '[]', '2026-05-19T12:00:00'),
                    (4, '2026-05-19', 'Completed task: **Legacy parent**

Subtasks:
- [x] First subtask
- [x] Second subtask', '[]', '2026-05-19T13:00:00');

                INSERT INTO todos (
                    id, title, description, status, priority, created_at, completed_at,
                    updated_at, completion_log_entry_id
                )
                VALUES
                    (
                        1, 'Legacy generated', '', 'done', 'medium', '2026-05-19T09:00:00',
                        '2026-05-19T10:00:00', '2026-05-19T10:00:00', 1
                    ),
                    (
                        2, 'Legacy edited', '', 'done', 'medium', '2026-05-19T09:30:00',
                        '2026-05-19T12:00:00', '2026-05-19T12:00:00', 3
                    ),
                    (
                        3, 'Legacy parent', '', 'done', 'medium', '2026-05-19T09:45:00',
                        '2026-05-19T13:00:00', '2026-05-19T13:00:00', 4
                    ),
                    (
                        4, 'First subtask', '', 'done', 'medium', '2026-05-19T09:46:00',
                        '2026-05-19T13:00:00', '2026-05-19T13:00:00', NULL
                    ),
                    (
                        5, 'Second subtask', '', 'done', 'medium', '2026-05-19T09:47:00',
                        '2026-05-19T13:00:00', '2026-05-19T13:00:00', NULL
                    );

                UPDATE todos SET parent_id=3, sort_order=0 WHERE id=4;
                UPDATE todos SET parent_id=3, sort_order=1 WHERE id=5;
            """)

            init_db(legacy)

            columns = {
                row["name"]
                for row in legacy.execute("PRAGMA table_info(todos)").fetchall()
            }
            self.assertNotIn("completion_log_entry_id", columns)
            entries = legacy.execute(
                "SELECT entry_markdown FROM log_entries WHERE entry_type='manual' ORDER BY id"
            ).fetchall()
            self.assertEqual(
                [row["entry_markdown"] for row in entries],
                [
                    "Manual note survives",
                    "Completed task: **Legacy edited**\n\nResearch notes added by hand.",
                ],
            )
            task_entries = [
                entry
                for entry in list_log_entries(legacy, days=None)
                if entry.entry_type == "task"
            ]
            self.assertEqual(
                {entry.title for entry in task_entries},
                {"Legacy generated", "Legacy edited", "Legacy parent"},
            )
            parent_entry = next(entry for entry in task_entries if entry.title == "Legacy parent")
            self.assertEqual([subtask.title for subtask in parent_entry.subtasks], ["First subtask", "Second subtask"])
        finally:
            legacy.close()

if __name__ == "__main__":
    unittest.main()
