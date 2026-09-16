from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from datetime import date

from fastapi import HTTPException

from claudesk.api import projects as projects_api
from claudesk.core.db import (
    SCHEMA_VERSION,
    init_db,
)
from claudesk.core.db.tasks import (
    complete_todo,
    get_todo,
    insert_todo,
    update_todo,
)
from claudesk.core.db.projects import (
    create_project,
    create_project_milestone,
    delete_project,
    delete_project_milestone,
    get_project_milestone,
    get_project_progress_summary,
    link_milestone_todo,
    list_milestone_todos,
    list_project_milestones,
    replace_milestone_todos,
    unlink_milestone_todo,
    update_project_milestone,
)
from claudesk.core.models import (
    ProjectMilestoneKind,
    ProjectMilestoneStatus,
    Todo,
    TodoPriority,
)


def make_conn(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=3000")
    return conn


class ProjectMilestoneDbTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.conn = make_conn(os.path.join(self.tmpdir.name, "claudesk.db"))
        init_db(self.conn)

    def tearDown(self) -> None:
        self.conn.close()
        self.tmpdir.cleanup()

    def _project_id(self, name: str = "Milestone Project") -> int:
        project = create_project(self.conn, name=name)
        return project.id or 0

    def _todo_id(self, text: str, project_ids: list[int]) -> int:
        return insert_todo(
            self.conn,
            Todo(title=text, priority=TodoPriority.MEDIUM, project_ids=project_ids),
        )

    def test_init_db_creates_milestone_schema_without_project_progress_columns(self) -> None:
        version = self.conn.execute(
            "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
        ).fetchone()[0]
        milestone_columns = {
            row["name"]
            for row in self.conn.execute("PRAGMA table_info(project_milestones)").fetchall()
        }
        link_columns = {
            row["name"]
            for row in self.conn.execute("PRAGMA table_info(project_milestone_todos)").fetchall()
        }
        project_columns = {
            row["name"]
            for row in self.conn.execute("PRAGMA table_info(projects)").fetchall()
        }
        indexes = {
            row["name"]
            for row in self.conn.execute("PRAGMA index_list(project_milestones)").fetchall()
        }

        self.assertEqual(version, SCHEMA_VERSION)
        self.assertIn("acceptance_criteria", milestone_columns)
        self.assertIn("target_date", milestone_columns)
        self.assertIn("completed_at", milestone_columns)
        self.assertIn("milestone_id", link_columns)
        self.assertIn("todo_id", link_columns)
        self.assertNotIn("weight", milestone_columns)
        self.assertNotIn("phase", project_columns)
        self.assertNotIn("current_summary", project_columns)
        self.assertNotIn("next_milestone_id", project_columns)
        self.assertIn("idx_project_milestones_project_order", indexes)
        self.assertIn("idx_project_milestones_project_status", indexes)

    def test_create_list_get_update_delete_milestone(self) -> None:
        project_id = self._project_id()

        milestone = create_project_milestone(
            self.conn,
            project_id=project_id,
            title="  Assemble dataset  ",
            description="  First pass table  ",
            kind=ProjectMilestoneKind.DATA,
            order_index=2,
            acceptance_criteria="  Dataset manifest exists.  ",
            target_date=date(2026, 6, 1),
        )

        self.assertEqual(milestone.title, "Assemble dataset")
        self.assertEqual(milestone.description, "First pass table")
        self.assertEqual(milestone.kind, ProjectMilestoneKind.DATA)
        self.assertEqual(milestone.status, ProjectMilestoneStatus.NOT_STARTED)
        self.assertEqual(milestone.target_date, date(2026, 6, 1))
        self.assertEqual([item.id for item in list_project_milestones(self.conn, project_id)], [milestone.id])
        self.assertEqual(get_project_milestone(self.conn, project_id, milestone.id or 0), milestone)

        done = update_project_milestone(
            self.conn,
            project_id,
            milestone.id or 0,
            status=ProjectMilestoneStatus.DONE,
        )
        self.assertEqual(done.status, ProjectMilestoneStatus.DONE)
        self.assertIsNotNone(done.completed_at)

        reopened = update_project_milestone(
            self.conn,
            project_id,
            milestone.id or 0,
            title="Dataset assembled",
            description=None,
            status=ProjectMilestoneStatus.IN_PROGRESS,
            target_date=None,
        )
        self.assertEqual(reopened.title, "Dataset assembled")
        self.assertIsNone(reopened.description)
        self.assertEqual(reopened.status, ProjectMilestoneStatus.IN_PROGRESS)
        self.assertIsNone(reopened.completed_at)
        self.assertIsNone(reopened.target_date)

        delete_project_milestone(self.conn, project_id, milestone.id or 0)
        self.assertIsNone(get_project_milestone(self.conn, project_id, milestone.id or 0))

    def test_milestones_are_scoped_to_projects(self) -> None:
        project_a = self._project_id("Project A")
        project_b = self._project_id("Project B")
        milestone = create_project_milestone(
            self.conn,
            project_id=project_a,
            title="Project A milestone",
        )

        self.assertIsNone(
            get_project_milestone(self.conn, project_b, milestone.id or 0)
        )
        with self.assertRaises(ValueError):
            update_project_milestone(
                self.conn,
                project_b,
                milestone.id or 0,
                title="Wrong project",
            )
        with self.assertRaises(ValueError):
            delete_project_milestone(self.conn, project_b, milestone.id or 0)

    def test_milestone_task_links_require_same_project_membership(self) -> None:
        project_a = self._project_id("Project A")
        project_b = self._project_id("Project B")
        milestone = create_project_milestone(
            self.conn,
            project_id=project_a,
            title="Analyze result",
        )
        other_project_task = self._todo_id("Only project B task", [project_b])
        shared_task = self._todo_id("Shared task", [project_a, project_b])

        with self.assertRaises(ValueError):
            link_milestone_todo(self.conn, project_a, milestone.id or 0, other_project_task)

        link_milestone_todo(self.conn, project_a, milestone.id or 0, shared_task)
        linked = list_milestone_todos(self.conn, project_a, milestone.id or 0)

        self.assertEqual([todo.id for todo in linked], [shared_task])
        self.assertEqual(linked[0].project_ids, [project_a, project_b])

    def test_replace_milestone_todos_dedupes_and_unlink_removes_only_join(self) -> None:
        project_id = self._project_id()
        milestone = create_project_milestone(
            self.conn,
            project_id=project_id,
            title="Draft result",
        )
        first = self._todo_id("First task", [project_id])
        second = self._todo_id("Second task", [project_id])

        replace_milestone_todos(self.conn, project_id, milestone.id or 0, [first, first, second])
        self.assertEqual(
            [todo.id for todo in list_milestone_todos(self.conn, project_id, milestone.id or 0)],
            [first, second],
        )

        unlink_milestone_todo(self.conn, project_id, milestone.id or 0, first)
        self.assertIsNotNone(get_todo(self.conn, first))
        self.assertEqual(
            [todo.id for todo in list_milestone_todos(self.conn, project_id, milestone.id or 0)],
            [second],
        )

    def test_replace_milestone_todos_rejects_invalid_ids_before_deleting_links(self) -> None:
        project_id = self._project_id()
        milestone = create_project_milestone(
            self.conn,
            project_id=project_id,
            title="Draft result",
        )
        task_id = self._todo_id("Linked task", [project_id])
        link_milestone_todo(self.conn, project_id, milestone.id or 0, task_id)

        for bad_ids in ([0], [-1], [task_id, 0]):
            with self.subTest(bad_ids=bad_ids):
                with self.assertRaises(ValueError):
                    replace_milestone_todos(self.conn, project_id, milestone.id or 0, bad_ids)
                self.assertEqual(
                    [todo.id for todo in list_milestone_todos(self.conn, project_id, milestone.id or 0)],
                    [task_id],
                )

    def test_update_todo_prunes_milestone_links_when_task_leaves_project(self) -> None:
        project_a = self._project_id("Project A")
        project_b = self._project_id("Project B")
        milestone_a = create_project_milestone(
            self.conn,
            project_id=project_a,
            title="Project A milestone",
        )
        milestone_b = create_project_milestone(
            self.conn,
            project_id=project_b,
            title="Project B milestone",
        )
        task_id = self._todo_id("Shared task", [project_a, project_b])
        link_milestone_todo(self.conn, project_a, milestone_a.id or 0, task_id)
        link_milestone_todo(self.conn, project_b, milestone_b.id or 0, task_id)
        self.assertEqual(get_project_progress_summary(self.conn, project_a).open_linked_task_count, 1)
        self.assertEqual(get_project_progress_summary(self.conn, project_b).open_linked_task_count, 1)

        update_todo(
            self.conn,
            task_id,
            "Shared task",
            "",
            TodoPriority.MEDIUM.value,
            [project_b],
            None,
        )

        self.assertEqual(list_milestone_todos(self.conn, project_a, milestone_a.id or 0), [])
        self.assertEqual(
            [todo.id for todo in list_milestone_todos(self.conn, project_b, milestone_b.id or 0)],
            [task_id],
        )
        self.assertEqual(get_project_progress_summary(self.conn, project_a).open_linked_task_count, 0)
        self.assertEqual(get_project_progress_summary(self.conn, project_b).open_linked_task_count, 1)

    def test_update_todo_with_no_projects_clears_all_milestone_links_for_task(self) -> None:
        project_a = self._project_id("Project A")
        project_b = self._project_id("Project B")
        milestone_a = create_project_milestone(
            self.conn,
            project_id=project_a,
            title="Project A milestone",
        )
        milestone_b = create_project_milestone(
            self.conn,
            project_id=project_b,
            title="Project B milestone",
        )
        task_id = self._todo_id("Shared task", [project_a, project_b])
        link_milestone_todo(self.conn, project_a, milestone_a.id or 0, task_id)
        link_milestone_todo(self.conn, project_b, milestone_b.id or 0, task_id)

        update_todo(
            self.conn,
            task_id,
            "Shared task",
            "",
            TodoPriority.MEDIUM.value,
            [],
            None,
        )

        self.assertEqual(list_milestone_todos(self.conn, project_a, milestone_a.id or 0), [])
        self.assertEqual(list_milestone_todos(self.conn, project_b, milestone_b.id or 0), [])
        self.assertEqual(
            self.conn.execute(
                "SELECT COUNT(*) FROM project_milestone_todos WHERE todo_id=?",
                (task_id,),
            ).fetchone()[0],
            0,
        )

    def test_project_milestone_and_task_deletes_cascade_links_only(self) -> None:
        project_id = self._project_id()
        milestone = create_project_milestone(
            self.conn,
            project_id=project_id,
            title="Complete analysis",
        )
        task = self._todo_id("Run model", [project_id])
        link_milestone_todo(self.conn, project_id, milestone.id or 0, task)

        delete_project_milestone(self.conn, project_id, milestone.id or 0)

        self.assertIsNotNone(get_todo(self.conn, task))
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM project_milestone_todos").fetchone()[0],
            0,
        )

        next_milestone = create_project_milestone(
            self.conn,
            project_id=project_id,
            title="Check robustness",
        )
        link_milestone_todo(self.conn, project_id, next_milestone.id or 0, task)
        self.conn.execute("DELETE FROM todos WHERE id=?", (task,))

        self.assertIsNotNone(get_project_milestone(self.conn, project_id, next_milestone.id or 0))
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM project_milestone_todos").fetchone()[0],
            0,
        )

        final_task = self._todo_id("Write summary", [project_id])
        final_milestone = create_project_milestone(
            self.conn,
            project_id=project_id,
            title="Write paper",
        )
        link_milestone_todo(self.conn, project_id, final_milestone.id or 0, final_task)
        delete_project(self.conn, project_id)

        self.assertIsNotNone(get_todo(self.conn, final_task))
        self.assertIsNone(get_project_milestone(self.conn, project_id, final_milestone.id or 0))
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM project_milestone_todos").fetchone()[0],
            0,
        )

    def test_progress_summary_is_counts_only_and_derives_next_milestone(self) -> None:
        project_id = self._project_id()
        blocked = create_project_milestone(
            self.conn,
            project_id=project_id,
            title="Blocked milestone",
            status=ProjectMilestoneStatus.BLOCKED,
            order_index=0,
        )
        done = create_project_milestone(
            self.conn,
            project_id=project_id,
            title="Done milestone",
            status=ProjectMilestoneStatus.DONE,
            order_index=1,
        )
        ready = create_project_milestone(
            self.conn,
            project_id=project_id,
            title="Ready milestone",
            status=ProjectMilestoneStatus.READY_FOR_REVIEW,
            order_index=2,
        )
        dropped = create_project_milestone(
            self.conn,
            project_id=project_id,
            title="Dropped milestone",
            status=ProjectMilestoneStatus.DROPPED,
            order_index=-1,
        )
        open_task = self._todo_id("Open linked task", [project_id])
        duplicate_open_task = self._todo_id("Duplicate open task", [project_id])
        done_task = self._todo_id("Done linked task", [project_id])
        dropped_only_task = self._todo_id("Dropped only task", [project_id])
        complete_todo(self.conn, done_task)

        link_milestone_todo(self.conn, project_id, blocked.id or 0, open_task)
        link_milestone_todo(self.conn, project_id, blocked.id or 0, duplicate_open_task)
        link_milestone_todo(self.conn, project_id, ready.id or 0, open_task)
        link_milestone_todo(self.conn, project_id, ready.id or 0, done_task)
        link_milestone_todo(self.conn, project_id, dropped.id or 0, dropped_only_task)

        summary = get_project_progress_summary(self.conn, project_id)

        self.assertEqual(summary.milestone_count, 4)
        self.assertEqual(summary.active_milestone_count, 3)
        self.assertEqual(summary.blocked_milestone_count, 1)
        self.assertEqual(summary.ready_for_review_count, 1)
        self.assertEqual(summary.done_milestone_count, 1)
        self.assertEqual(summary.dropped_milestone_count, 1)
        self.assertEqual(summary.open_linked_task_count, 2)
        self.assertEqual(summary.done_linked_task_count, 1)
        self.assertNotIn("progress", summary.model_dump())
        self.assertEqual(summary.next_milestone_id, blocked.id)
        self.assertIsNotNone(done.completed_at)

    def test_project_milestone_api_endpoints_return_expected_payloads(self) -> None:
        project_id = self._project_id()
        task_id = self._todo_id("API task", [project_id])

        created = projects_api.create_project_milestone_endpoint(
            project_id,
            projects_api.CreateProjectMilestoneRequest(
                title="API milestone",
                kind=ProjectMilestoneKind.WRITING,
                acceptance_criteria="Draft exists.",
            ),
            conn=self.conn,
        )
        milestone_id = created["id"]
        self.assertEqual(created["title"], "API milestone")
        self.assertEqual(created["kind"], ProjectMilestoneKind.WRITING)

        projects_api.link_milestone_todo_endpoint(
            project_id,
            milestone_id,
            projects_api.LinkMilestoneTodoRequest(todo_id=task_id),
            conn=self.conn,
        )
        linked_tasks = projects_api.get_milestone_todos_endpoint(
            project_id,
            milestone_id,
            conn=self.conn,
        )
        self.assertEqual([todo["id"] for todo in linked_tasks], [task_id])

        updated = projects_api.update_project_milestone_endpoint(
            project_id,
            milestone_id,
            projects_api.UpdateProjectMilestoneRequest(
                status=ProjectMilestoneStatus.DONE,
            ),
            conn=self.conn,
        )
        self.assertEqual(updated["status"], ProjectMilestoneStatus.DONE)
        self.assertIsNotNone(updated["completed_at"])

        summary = projects_api.get_project_progress_summary_endpoint(project_id, conn=self.conn)
        self.assertEqual(summary["done_milestone_count"], 1)
        self.assertNotIn("progress", summary)

        projects_api.replace_milestone_todos_endpoint(
            project_id,
            milestone_id,
            projects_api.ReplaceMilestoneTodosRequest(todo_ids=[]),
            conn=self.conn,
        )
        self.assertEqual(
            projects_api.get_milestone_todos_endpoint(project_id, milestone_id, conn=self.conn),
            [],
        )
        projects_api.delete_project_milestone_endpoint(project_id, milestone_id, conn=self.conn)
        with self.assertRaises(HTTPException) as ctx:
            projects_api.get_project_milestone_endpoint(project_id, milestone_id, conn=self.conn)
        self.assertEqual(ctx.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
