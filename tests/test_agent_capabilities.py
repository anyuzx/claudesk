from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
import asyncio
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from pydantic import ValidationError
from pydantic_ai.messages import ToolReturn

from claudesk.core.config import ChatRuntimeSettings
from claudesk.agent.capabilities import (
    CapabilityDisabledError,
    execute_capability,
    execute_capability_text,
    get_capability_registry,
)
from claudesk.agent.context import CapabilityContext
from claudesk.agent.exports.mcp import mcp_tools
from claudesk.agent.exports.openai import openai_tool_schemas, tool_manifest_hash
from claudesk.agent.policy import NOTE_WRITE_CAPABILITY_NAMES, PAPER_PDF_CAPABILITY_NAMES
from claudesk.agent.runtime import CapabilityRuntimeDeps, CapabilityToolset
from claudesk.core.config import ChatConfig, ChatToolsConfig, Config
from claudesk.core.db.tasks import (
    complete_todo,
    get_manual_log_entry,
    get_todo,
    create_manual_log_entry,
    insert_todo,
    list_subtasks,
)
from claudesk.core.db.chat import (
    create_chat_attachment,
    create_chat_session,
    list_chat_resource_reads,
)
from claudesk.core.db.notes import (
    create_note,
    list_notes,
)
from claudesk.core.db.assets import (
    create_paper_asset,
    list_paper_assets,
)
from claudesk.core.db.projects import (
    create_project,
    create_project_milestone,
    get_project_milestone,
    link_project_paper,
    link_milestone_todo,
    list_milestone_todos,
    list_project_papers,
)
from claudesk.core.db.papers import (
    get_paper,
    upsert_paper,
)
from claudesk.core.db import init_db
from claudesk.core.models import (
    AssetKind,
    AssetParseStatus,
    ManualLogEntry,
    Paper,
    PaperStatus,
    ProjectPaperRole,
    ProjectMilestoneKind,
    ProjectMilestoneStatus,
    Todo,
    TodoPriority,
)
from claudesk.core.paper_asset_ops import download_pdf_from_https_url
from claudesk.core.paper_assets import (
    InvalidPaperAssetFile,
    resolve_chat_attachment_path,
    resolve_managed_asset_path,
)
from claudesk.core.public_http import MAX_REDIRECTS
from claudesk.core.retrieval import SemanticIndexStatus, SemanticSearchHit, TABLE_NAME
from claudesk.core.retrieval.models import RetrievalSourceType
from claudesk.core.retrieval.vector import SemanticDocument
from claudesk.sources import doi as doi_source
from tests.helpers import patched_data_dir


def make_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def make_paper(
    *,
    external_id: str = "10.1234/capability",
    title: str = "Capability paper",
) -> Paper:
    return Paper(
        source="biorxiv",
        external_id=external_id,
        title=title,
        abstract="Capability abstract",
        authors=["Alice Example"],
        published_date=date(2026, 5, 1),
        url="https://example.com/capability",
    )


def make_semantic_status(tmpdir: str, *, indexed_count: int = 1) -> SemanticIndexStatus:
    return SemanticIndexStatus(
        index_path=Path(tmpdir) / "semantic-index",
        table_name=TABLE_NAME,
        source_count=indexed_count,
        indexed_count=indexed_count,
        missing_count=0,
        stale_count=0,
        incompatible_count=0,
    )


def write_pdf(path, page_texts: list[str]) -> None:
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


class AgentCapabilityRegistryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.data_dir_ctx = patched_data_dir(self.tmpdir.name)
        self.data_dir_ctx.__enter__()
        self.conn = make_conn()
        init_db(self.conn)

    def tearDown(self) -> None:
        self.conn.close()
        self.data_dir_ctx.__exit__(None, None, None)
        self.tmpdir.cleanup()

    def test_registry_exports_openai_and_mcp_from_same_specs(self) -> None:
        registry_names = {spec.name for spec in get_capability_registry().list()}
        openai_names = {schema["function"]["name"] for schema in openai_tool_schemas()}
        mcp_names = {tool.name for tool in mcp_tools(Config().chat.tools)}

        self.assertEqual(openai_names, registry_names)
        self.assertEqual(mcp_names, registry_names)
        self.assertTrue(set(PAPER_PDF_CAPABILITY_NAMES).issubset(registry_names))
        self.assertTrue(set(NOTE_WRITE_CAPABILITY_NAMES).issubset(registry_names))
        self.assertIn("get_project_context", registry_names)
        self.assertIn("get_project_context", mcp_names)
        self.assertIn("list_project_milestones", registry_names)
        self.assertIn("create_project_milestone", registry_names)
        self.assertIn("create_milestone_task", registry_names)
        self.assertIn("get_note_context", registry_names)
        self.assertIn("get_note_context", mcp_names)
        self.assertIn("get_chat_attachment_context", registry_names)
        self.assertIn("get_chat_attachment_context", mcp_names)
        self.assertNotIn("update_paper_note", registry_names)
        self.assertEqual(len(openai_names), 50)

    def test_all_capabilities_have_policy_metadata(self) -> None:
        for spec in get_capability_registry().list():
            self.assertTrue(spec.domain, spec.name)
            self.assertTrue(spec.access, spec.name)
            self.assertTrue(spec.risk, spec.name)

    def test_forbidden_mutating_capabilities_are_absent(self) -> None:
        registry_names = {spec.name for spec in get_capability_registry().list()}
        forbidden = {
            "complete_task",
            "complete_todo",
            "delete_task",
            "delete_todo",
            "reopen_task",
            "reopen_todo",
            "delete_paper",
            "delete_note",
            "delete_project",
            "delete_log_entry",
            "delete_progress_entry",
            "delete_paper_asset",
            "delete_asset",
        }
        self.assertFalse(registry_names & forbidden)

    def test_disabled_capabilities_are_hidden_and_rejected(self) -> None:
        tools_cfg = ChatToolsConfig(paper_pdf=False, note_write=False)
        names = {schema["function"]["name"] for schema in openai_tool_schemas(tools_cfg)}

        self.assertNotIn("read_paper_pdf", names)
        self.assertNotIn("create_paper_note", names)
        with self.assertRaises(CapabilityDisabledError):
            execute_capability(
                "read_paper_pdf",
                {"paper_id": 1},
                self.conn,
                cfg=Config(),
                tools_cfg=tools_cfg,
            )

    def test_project_write_gate_hides_and_rejects_milestone_write_tools(self) -> None:
        tools_cfg = ChatToolsConfig(project_write=False)
        names = {schema["function"]["name"] for schema in openai_tool_schemas(tools_cfg)}

        self.assertIn("list_project_milestones", names)
        self.assertIn("get_project_milestone", names)
        for name in (
            "create_project_milestone",
            "update_project_milestone",
            "link_milestone_task",
            "unlink_milestone_task",
            "create_milestone_task",
        ):
            self.assertNotIn(name, names)
            with self.assertRaises(CapabilityDisabledError):
                execute_capability(
                    name,
                    {"project_id": 1, "milestone_id": 1},
                    self.conn,
                    cfg=Config(chat=ChatConfig(tools=tools_cfg)),
                    tools_cfg=tools_cfg,
                )

    def test_create_milestone_task_rejects_when_task_write_disabled(self) -> None:
        project = create_project(self.conn, name="Milestone Gate Project")
        milestone = create_project_milestone(
            self.conn,
            project_id=project.id or 0,
            title="Plan work",
        )
        cfg = Config(chat=ChatConfig(tools=ChatToolsConfig(project_write=True, task_write=False)))
        openai_names = {schema["function"]["name"] for schema in openai_tool_schemas(cfg.chat.tools)}
        mcp_names = {tool.name for tool in mcp_tools(cfg.chat.tools)}

        self.assertNotIn("create_milestone_task", openai_names)
        self.assertNotIn("create_milestone_task", mcp_names)

        with self.assertRaises(CapabilityDisabledError):
            execute_capability_text(
                "create_milestone_task",
                {
                    "project_id": project.id,
                    "milestone_id": milestone.id,
                    "title": "Blocked task write",
                },
                self.conn,
                cfg=cfg,
                tools_cfg=cfg.chat.tools,
            )
        self.assertEqual(list_milestone_todos(self.conn, project.id or 0, milestone.id or 0), [])

    def test_capabilities_support_multi_gate_exports_and_rejection(self) -> None:
        tools_cfg = ChatToolsConfig(project_write=False, task_write=True)
        names = {schema["function"]["name"] for schema in openai_tool_schemas(tools_cfg)}

        self.assertNotIn("create_milestone_task", names)
        with self.assertRaises(CapabilityDisabledError):
            execute_capability(
                "create_milestone_task",
                {"project_id": 1, "milestone_id": 1, "title": "Hidden"},
                self.conn,
                cfg=Config(chat=ChatConfig(tools=tools_cfg)),
                tools_cfg=tools_cfg,
            )

    def test_add_task_supports_project_links(self) -> None:
        project = create_project(self.conn, name="Linked project")
        result = json.loads(execute_capability_text(
            "add_task",
            {
                "title": "Follow up on data",
                "priority": "high",
                "project_ids": [project.id],
                "due_date": "2026-05-12",
            },
            self.conn,
        ))

        self.assertTrue(result["ok"])
        self.assertEqual(result["action"], "add_task")
        todo = get_todo(self.conn, result["id"])
        self.assertIsNotNone(todo)
        self.assertEqual(todo.priority, TodoPriority.HIGH)
        self.assertEqual(todo.project_ids, [project.id])
        self.assertEqual(str(todo.due_date), "2026-05-12")

    def test_add_subtask_inherits_parent_project_links(self) -> None:
        project = create_project(self.conn, name="Subtask project")
        parent_id = insert_todo(
            self.conn,
            Todo(title="Root task", priority=TodoPriority.MEDIUM, project_ids=[project.id]),
        )

        result = json.loads(execute_capability_text(
            "add_subtask",
            {"parent_id": parent_id, "title": "Subtask"},
            self.conn,
        ))

        self.assertTrue(result["ok"])
        self.assertEqual(result["action"], "add_subtask")
        subtasks = list_subtasks(self.conn, parent_id)
        self.assertEqual(len(subtasks), 1)
        self.assertEqual(subtasks[0].id, result["id"])
        self.assertEqual(subtasks[0].project_ids, [project.id])

    def test_update_task_edits_allowed_fields_and_rejects_status(self) -> None:
        project = create_project(self.conn, name="Updated project")
        task_id = insert_todo(
            self.conn,
            Todo(title="Original task", priority=TodoPriority.LOW),
        )

        result = json.loads(execute_capability_text(
            "update_task",
            {
                "task_id": task_id,
                "title": "Updated task",
                "priority": "high",
                "project_ids": [project.id],
                "due_date": "2026-05-13",
            },
            self.conn,
        ))

        self.assertTrue(result["ok"])
        self.assertEqual(result["before"]["title"], "Original task")
        self.assertEqual(result["after"]["title"], "Updated task")
        updated = get_todo(self.conn, task_id)
        self.assertEqual(updated.priority, TodoPriority.HIGH)
        self.assertEqual(updated.project_ids, [project.id])
        self.assertEqual(str(updated.due_date), "2026-05-13")

        with self.assertRaises(ValidationError):
            execute_capability_text(
                "update_task",
                {"task_id": task_id, "status": "done"},
                self.conn,
            )

    def test_task_capabilities_store_clickable_paper_mentions(self) -> None:
        paper_title = "Clickable [paper]\nTitle"
        paper_id = upsert_paper(self.conn, make_paper(title=paper_title))

        title_replaced = json.loads(execute_capability_text(
            "add_task",
            {"title": "Review paper", "description": "Review Clickable [paper]\nTitle", "paper_ids": [paper_id]},
            self.conn,
        ))
        title_replaced_task = get_todo(self.conn, title_replaced["id"])
        self.assertEqual(title_replaced_task.description, f"Review [@Clickable paper Title](paper://{paper_id})")

        created = json.loads(execute_capability_text(
            "add_task",
            {"title": "Read this", "paper_ids": [paper_id]},
            self.conn,
        ))
        task = get_todo(self.conn, created["id"])
        self.assertEqual(task.title, "Read this")
        self.assertEqual(task.description, f"[@Clickable paper Title](paper://{paper_id})")

        subtask = json.loads(execute_capability_text(
            "add_subtask",
            {"parent_id": created["id"], "title": "Check paper", "description": f"Check paper://{paper_id}", "paper_ids": [paper_id]},
            self.conn,
        ))
        stored_subtask = get_todo(self.conn, subtask["id"])
        self.assertEqual(stored_subtask.description, f"Check [@Clickable paper Title](paper://{paper_id})")
        self.assertEqual(stored_subtask.description.count(f"paper://{paper_id}"), 1)

        updated = json.loads(execute_capability_text(
            "update_task",
            {
                "task_id": created["id"],
                "description": f"Already [@Clickable paper Title](paper://{paper_id})",
                "paper_ids": [paper_id],
            },
            self.conn,
        ))
        self.assertEqual(updated["after"]["description"].count(f"paper://{paper_id}"), 1)

    def test_missing_paper_mentions_are_rejected_without_partial_task_write(self) -> None:
        before_count = self.conn.execute("SELECT COUNT(*) FROM todos").fetchone()[0]

        with self.assertRaises(ValueError):
            execute_capability_text(
                "add_task",
                {"title": "Read missing paper", "paper_ids": [999]},
                self.conn,
            )

        after_count = self.conn.execute("SELECT COUNT(*) FROM todos").fetchone()[0]
        self.assertEqual(after_count, before_count)

    def test_update_log_entry_returns_before_after(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        entry_id = create_manual_log_entry(self.conn, ManualLogEntry(entry="Original log"))

        result = json.loads(execute_capability_text(
            "update_log_entry",
            {
                "entry_id": entry_id,
                "entry": f"Updated log with [paper](paper://{paper_id})",
            },
            self.conn,
        ))

        self.assertTrue(result["ok"])
        self.assertEqual(result["action"], "update_log_entry")
        self.assertEqual(result["before"]["entry"], "Original log")
        self.assertEqual(result["after"]["entry"], f"Updated log with [paper](paper://{paper_id})")
        updated = get_manual_log_entry(self.conn, entry_id)
        self.assertEqual(updated.linked_paper_ids, [paper_id])

    def test_log_capabilities_store_clickable_paper_mentions(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper(title="Log paper"))

        title_replaced = json.loads(execute_capability_text(
            "add_log_entry",
            {"entry": "Reviewed Log paper. @Log paper", "paper_ids": [paper_id]},
            self.conn,
        ))
        title_replaced_entry = get_manual_log_entry(self.conn, title_replaced["id"])
        self.assertEqual(title_replaced_entry.entry, f"Reviewed [@Log paper](paper://{paper_id}).")
        self.assertEqual(title_replaced_entry.linked_paper_ids, [paper_id])

        created = json.loads(execute_capability_text(
            "add_log_entry",
            {"entry": "Discussed results", "paper_ids": [paper_id]},
            self.conn,
        ))
        entry = get_manual_log_entry(self.conn, created["id"])
        self.assertEqual(entry.entry, f"Discussed results [@Log paper](paper://{paper_id})")
        self.assertEqual(entry.linked_paper_ids, [paper_id])

        updated = json.loads(execute_capability_text(
            "update_log_entry",
            {
                "entry_id": created["id"],
                "entry": f"Revisited paper://{paper_id}",
                "paper_ids": [paper_id],
            },
            self.conn,
        ))
        self.assertEqual(updated["after"]["entry"], f"Revisited [@Log paper](paper://{paper_id})")
        self.assertEqual(updated["after"]["linked_paper_ids"], [paper_id])
        self.assertEqual(updated["after"]["entry"].count(f"paper://{paper_id}"), 1)

    def test_missing_paper_mentions_are_rejected_without_partial_log_write(self) -> None:
        before_count = self.conn.execute("SELECT COUNT(*) FROM log_entries WHERE entry_type='manual'").fetchone()[0]

        with self.assertRaises(ValueError):
            execute_capability_text(
                "add_log_entry",
                {"entry": "Discussed missing paper", "paper_ids": [999]},
                self.conn,
            )

        after_count = self.conn.execute("SELECT COUNT(*) FROM log_entries WHERE entry_type='manual'").fetchone()[0]
        self.assertEqual(after_count, before_count)

    def test_log_read_capabilities_include_completed_tasks(self) -> None:
        task_id = insert_todo(
            self.conn,
            Todo(
                title="Complete capability task",
                description="Task completion detail.",
                priority=TodoPriority.MEDIUM,
            ),
        )
        before_count = self.conn.execute("SELECT COUNT(*) FROM log_entries").fetchone()[0]
        complete_todo(self.conn, task_id)
        self.conn.commit()
        after_count = self.conn.execute("SELECT COUNT(*) FROM log_entries").fetchone()[0]
        self.assertEqual(after_count, before_count + 1)

        payload = json.loads(execute_capability_text("list_log", {"days": 30}, self.conn))

        self.assertEqual(len(payload), 1)
        entry = payload[0]
        self.assertIsInstance(entry["id"], int)
        self.assertEqual(entry["entry_type"], "task")
        self.assertEqual(entry["task_id"], task_id)
        self.assertEqual(entry["title"], "Complete capability task")
        self.assertIn("Completed task: Complete capability task", entry["entry"])
        self.assertIn("Task completion detail.", entry["entry"])

    def test_update_log_entry_rejects_task_logs_clearly(self) -> None:
        task_id = insert_todo(
            self.conn,
            Todo(
                title="Do not edit through log",
                description="Task log entries are task-backed.",
                priority=TodoPriority.MEDIUM,
            ),
        )
        complete_todo(self.conn, task_id)
        self.conn.commit()

        listed = json.loads(execute_capability_text("list_log", {"days": 30}, self.conn))
        task_entry = listed[0]
        result = json.loads(execute_capability_text(
            "update_log_entry",
            {
                "entry_id": task_entry["id"],
                "entry": "Changed through log tool",
            },
            self.conn,
        ))

        self.assertFalse(result["ok"])
        self.assertIn("not a manual log entry", result["error"])
        self.assertIn("task tools", result["error"])
        task = get_todo(self.conn, task_id)
        self.assertEqual(task.title, "Do not edit through log")
        refreshed = json.loads(execute_capability_text("list_log", {"days": 30}, self.conn))
        self.assertEqual(refreshed[0]["title"], "Do not edit through log")
        self.assertNotIn("Changed through log tool", refreshed[0]["entry"])

    def test_get_papers_by_ids_returns_resource_reads(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper(title="Readable paper"))

        result = execute_capability(
            "get_papers_by_ids",
            {"paper_ids": [paper_id, 999]},
            self.conn,
        )
        payload = json.loads(result.text)

        self.assertEqual(payload["missing_ids"], [999])
        self.assertEqual(len(result.resource_reads), 1)
        read = result.resource_reads[0]
        self.assertEqual(read.resource_kind, "paper")
        self.assertEqual(read.resource_id, str(paper_id))
        self.assertEqual(read.label, "Readable paper")
        self.assertEqual(read.locator, {"paper_id": paper_id})

    def test_search_papers_supports_semantic_backend(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper(title="Semantic capability paper"))
        self.conn.commit()
        document = SemanticDocument(
            row_id=f"paper:{paper_id}",
            source_type=RetrievalSourceType.PAPER,
            source_id=str(paper_id),
            title="Semantic capability paper",
            text="Semantic capability embedding text.",
            locator={"paper_id": paper_id},
            updated_at="2026-06-04T00:00:00",
            content_hash="semantic-capability-paper",
        )
        status = make_semantic_status(self.tmpdir.name)

        with patch("claudesk.core.retrieval.vector.semantic_index_status", return_value=status), \
                patch(
                    "claudesk.core.retrieval.vector.search_semantic_index",
                    return_value=[SemanticSearchHit(document=document, score=1.0)],
                ):
            payload = json.loads(execute_capability_text(
                "search_papers",
                {"query": "embedding neighbor", "backend": "semantic"},
                self.conn,
            ))

        self.assertEqual([paper["id"] for paper in payload], [paper_id])
        self.assertEqual(payload[0]["title"], "Semantic capability paper")

    def test_paper_collection_capabilities_save_and_queue_only(self) -> None:
        save_id = upsert_paper(self.conn, make_paper(title="Save paper"))
        queue_id = upsert_paper(self.conn, make_paper(
            external_id="10.1234/queue-paper",
            title="Queue paper",
        ))

        saved = json.loads(execute_capability_text("save_paper", {"paper_id": save_id}, self.conn))
        queued = json.loads(execute_capability_text(
            "add_paper_to_reading_queue",
            {"paper_id": queue_id},
            self.conn,
        ))

        self.assertTrue(saved["ok"])
        self.assertEqual(saved["action"], "save_paper")
        stored_saved = get_paper(self.conn, save_id)
        self.assertEqual(stored_saved.status, PaperStatus.SAVED)
        self.assertTrue(stored_saved.is_saved)
        self.assertFalse(stored_saved.is_read)
        self.assertTrue(queued["ok"])
        self.assertEqual(queued["action"], "add_paper_to_reading_queue")
        stored_queued = get_paper(self.conn, queue_id)
        self.assertEqual(stored_queued.status, PaperStatus.NEW)
        self.assertFalse(stored_queued.is_saved)
        self.assertFalse(stored_queued.is_read)
        self.assertTrue(stored_queued.is_to_read)

        with self.assertRaises(ValidationError):
            execute_capability_text("save_paper", {"paper_id": save_id, "status": "read"}, self.conn)

    def test_add_paper_by_doi_reuses_dedupe_and_does_not_save(self) -> None:
        existing_id = upsert_paper(self.conn, make_paper())

        with patch(
            "claudesk.core.paper_ingest.resolve_doi_metadata_with_warnings",
            side_effect=AssertionError("unexpected DOI resolver"),
        ):
            existing = json.loads(execute_capability_text(
                "add_paper_by_doi",
                {"doi": "https://doi.org/10.1234/CAPABILITY"},
                self.conn,
            ))

        self.assertTrue(existing["ok"])
        self.assertEqual(existing["ingest_status"], "existing")
        self.assertEqual(existing["id"], existing_id)
        self.assertFalse(get_paper(self.conn, existing_id).is_saved)

        resolver_paper = make_paper(
            external_id="10.1234/new-capability-doi",
            title="New capability DOI",
        )
        with patch(
            "claudesk.core.paper_ingest.resolve_doi_metadata_with_warnings",
            return_value=doi_source.DoiResolution(resolver_paper, (), "10.1234/new-capability-doi"),
        ) as resolver:
            created = json.loads(execute_capability_text(
                "add_paper_by_doi",
                {"doi": "10.1234/new-capability-doi"},
                self.conn,
            ))

        resolver.assert_called_once_with("10.1234/new-capability-doi")
        self.assertEqual(created["ingest_status"], "created")
        stored_created = get_paper(self.conn, created["id"])
        self.assertIsNotNone(stored_created)
        self.assertFalse(stored_created.is_saved)

        with self.assertRaises(ValidationError):
            execute_capability_text(
                "add_paper_by_doi",
                {"doi": "10.1234/new-capability-doi", "save": True},
                self.conn,
            )

    def test_get_project_context_returns_bounded_project_state(self) -> None:
        project = create_project(self.conn, name="Capability Project", description="Project description")
        first_paper = upsert_paper(self.conn, make_paper(title="First project paper"))
        second_paper = upsert_paper(self.conn, make_paper(
            external_id="10.1234/capability-project-two",
            title="Second project paper",
        ))
        link_project_paper(self.conn, project.id or 0, first_paper, role=ProjectPaperRole.SEED)
        link_project_paper(self.conn, project.id or 0, second_paper)
        create_note(
            self.conn,
            title="Project note",
            body="Detailed note body",
            manual_paper_ids=[first_paper],
        )
        create_paper_asset(
            self.conn,
            first_paper,
            kind=AssetKind.PDF,
            source="manual",
            managed_path="papers/project-context.pdf",
            original_filename="project-context.pdf",
            display_name="Project context PDF",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-project-context",
        )
        task_id = insert_todo(
            self.conn,
            Todo(
                title="Read project papers",
                priority=TodoPriority.HIGH,
                project_ids=[project.id or 0],
            ),
        )
        milestone = create_project_milestone(
            self.conn,
            project_id=project.id or 0,
            title="Analyze project data",
            description="Milestone description",
            kind=ProjectMilestoneKind.ANALYSIS,
            status=ProjectMilestoneStatus.IN_PROGRESS,
            acceptance_criteria="Analysis notebook exists.",
            target_date=date(2026, 6, 15),
        )
        link_milestone_todo(self.conn, project.id or 0, milestone.id or 0, task_id)
        create_manual_log_entry(
            self.conn,
            ManualLogEntry(
                entry="Compared project papers.",
                project_ids=[project.id or 0],
                linked_paper_ids=[first_paper],
            ),
        )
        create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings(), title="Project chat", project_ids=[project.id or 0], linked_paper_ids=[first_paper])

        result = execute_capability(
            "get_project_context",
            {"project_id": project.id, "max_items": 2, "log_days": 30},
            self.conn,
        )
        payload = json.loads(result.text)

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["project"]["name"], "Capability Project")
        self.assertEqual(payload["counts"]["linked_papers"], 2)
        self.assertEqual(payload["counts"]["linked_notes"], 1)
        self.assertEqual(payload["counts"]["pdf_assets"], 1)
        self.assertEqual(payload["counts"]["open_tasks"], 1)
        self.assertEqual(payload["counts"]["milestones"], 1)
        self.assertEqual(payload["progress_summary"]["milestone_count"], 1)
        self.assertEqual(payload["progress_summary"]["in_progress_milestone_count"], 1)
        self.assertEqual(payload["progress_summary"]["open_linked_task_count"], 1)
        self.assertEqual(payload["counts"]["recent_log_entries"], 1)
        self.assertEqual(payload["counts"]["recent_chats"], 1)
        self.assertEqual(len(payload["linked_papers"]), 2)
        paper_roles = {paper["id"]: paper["role"] for paper in payload["linked_papers"]}
        self.assertEqual(paper_roles[first_paper], "seed")
        self.assertEqual(paper_roles[second_paper], "relevant")
        self.assertEqual(payload["linked_notes"][0]["title"], "Project note")
        self.assertEqual(payload["pdf_assets"][0]["display_name"], "Project context PDF")
        self.assertEqual(payload["open_tasks"][0]["title"], "Read project papers")
        self.assertEqual(payload["milestones"][0]["title"], "Analyze project data")
        self.assertEqual(payload["milestones"][0]["linked_task_ids"], [task_id])
        self.assertEqual(payload["milestones"][0]["linked_task_count"], 1)
        self.assertEqual(payload["milestones"][0]["linked_tasks"][0]["title"], "Read project papers")
        self.assertEqual(payload["recent_log_entries"][0]["linked_paper_ids"], [first_paper])
        self.assertEqual(payload["recent_chats"][0]["title"], "Project chat")
        reads_by_kind = {}
        for read in result.resource_reads:
            reads_by_kind.setdefault(read.resource_kind, []).append(read)
        self.assertEqual(reads_by_kind["project"][0].resource_id, str(project.id))
        self.assertEqual(reads_by_kind["paper"][0].resource_id, str(payload["linked_papers"][0]["id"]))
        self.assertEqual(reads_by_kind["note"][0].label, "Project note")
        self.assertEqual(reads_by_kind["asset"][0].label, "Project context PDF")
        self.assertEqual(reads_by_kind["todo"][0].label, "Read project papers")
        self.assertEqual(reads_by_kind["project_milestone"][0].label, "Analyze project data")
        self.assertEqual(reads_by_kind["project_progress_summary"][0].locator["project_id"], project.id)
        self.assertEqual(reads_by_kind["log"][0].locator["project_id"], project.id)
        self.assertEqual(reads_by_kind["chat_session"][0].label, "Project chat")

    def test_get_project_context_includes_completed_task_activity(self) -> None:
        project = create_project(self.conn, name="Task Activity Project")
        other_project = create_project(self.conn, name="Other Activity Project")
        create_manual_log_entry(
            self.conn,
            ManualLogEntry(
                entry="Manual project progress.",
                project_ids=[project.id or 0],
            ),
        )
        task_id = insert_todo(
            self.conn,
            Todo(
                title="Finish project activity",
                description="Completed project context detail.",
                priority=TodoPriority.MEDIUM,
                project_ids=[project.id or 0],
            ),
        )
        other_task_id = insert_todo(
            self.conn,
            Todo(
                title="Other project activity",
                priority=TodoPriority.MEDIUM,
                project_ids=[other_project.id or 0],
            ),
        )
        complete_todo(self.conn, task_id)
        complete_todo(self.conn, other_task_id)
        self.conn.commit()

        result = execute_capability(
            "get_project_context",
            {"project_id": project.id, "max_items": 10, "log_days": 30},
            self.conn,
        )
        payload = json.loads(result.text)

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["counts"]["recent_log_entries"], 2)
        entries_by_type = {entry["entry_type"]: entry for entry in payload["recent_log_entries"]}
        self.assertEqual(entries_by_type["manual"]["entry"], "Manual project progress.")
        self.assertEqual(entries_by_type["task"]["task_id"], task_id)
        self.assertIn("Completed task: Finish project activity", entries_by_type["task"]["entry"])
        self.assertNotIn("Other project activity", json.dumps(payload["recent_log_entries"]))
        log_reads = [read for read in result.resource_reads if read.resource_kind == "log"]
        self.assertEqual({read.locator["entry_type"] for read in log_reads}, {"manual", "task"})
        self.assertIn(str(entries_by_type["task"]["id"]), {read.resource_id for read in log_reads})

    def test_get_project_context_bounds_milestone_linked_task_ids(self) -> None:
        project = create_project(self.conn, name="Bounded Milestone Project")
        milestone = create_project_milestone(
            self.conn,
            project_id=project.id or 0,
            title="Bounded milestone",
        )
        task_ids = [
            insert_todo(
                self.conn,
                Todo(
                    title=f"Linked task {index}",
                    priority=TodoPriority.MEDIUM,
                    project_ids=[project.id or 0],
                ),
            )
            for index in range(3)
        ]
        for task_id in task_ids:
            link_milestone_todo(self.conn, project.id or 0, milestone.id or 0, task_id)
        complete_todo(self.conn, task_ids[0])
        self.conn.commit()

        result = execute_capability(
            "get_project_context",
            {"project_id": project.id, "max_items": 1},
            self.conn,
        )
        payload = json.loads(result.text)

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["milestones"][0]["linked_task_count"], 3)
        self.assertEqual(payload["milestones"][0]["linked_task_ids"], [task_ids[0]])
        self.assertEqual(len(payload["milestones"][0]["linked_tasks"]), 1)
        self.assertEqual(payload["milestones"][0]["linked_tasks"][0]["status"], "done")
        todo_reads = {
            int(read.resource_id): read
            for read in result.resource_reads
            if read.resource_kind == "todo"
        }
        self.assertIn(task_ids[0], todo_reads)
        self.assertEqual(todo_reads[task_ids[0]].label, "Linked task 0")
        self.assertEqual(todo_reads[task_ids[0]].summary, "Project milestone linked task returned.")
        self.assertEqual(todo_reads[task_ids[0]].locator["milestone_id"], milestone.id)

    def test_get_project_context_rejects_old_log_window_field(self) -> None:
        project = create_project(self.conn, name="Log Contract Project")

        with self.assertRaises(ValidationError):
            execute_capability(
                "get_project_context",
                {"project_id": project.id, "progress_days": 30},
                self.conn,
            )

    def test_get_project_context_reports_missing_project(self) -> None:
        payload = json.loads(execute_capability_text(
            "get_project_context",
            {"project_id": 999},
            self.conn,
        ))

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"], "Project 999 not found.")

    def test_milestone_read_tools_include_linked_task_resource_reads(self) -> None:
        project = create_project(self.conn, name="Milestone Read Project")
        milestone = create_project_milestone(
            self.conn,
            project_id=project.id or 0,
            title="Read milestone",
        )
        task_id = insert_todo(
            self.conn,
            Todo(
                title="Completed milestone task",
                priority=TodoPriority.MEDIUM,
                project_ids=[project.id or 0],
            ),
        )
        link_milestone_todo(self.conn, project.id or 0, milestone.id or 0, task_id)
        complete_todo(self.conn, task_id)
        self.conn.commit()

        listed_result = execute_capability(
            "list_project_milestones",
            {"project_id": project.id, "max_linked_tasks": 1},
            self.conn,
        )
        listed = json.loads(listed_result.text)
        listed_reads = [read for read in listed_result.resource_reads if read.resource_kind == "todo"]

        self.assertEqual(listed["milestones"][0]["linked_tasks"][0]["status"], "done")
        self.assertEqual(len(listed_reads), 1)
        self.assertEqual(listed_reads[0].resource_id, str(task_id))
        self.assertEqual(listed_reads[0].label, "Completed milestone task")
        self.assertEqual(listed_reads[0].locator["milestone_id"], milestone.id)

        fetched_result = execute_capability(
            "get_project_milestone",
            {"project_id": project.id, "milestone_id": milestone.id, "max_linked_tasks": 1},
            self.conn,
        )
        fetched = json.loads(fetched_result.text)
        fetched_reads = [read for read in fetched_result.resource_reads if read.resource_kind == "todo"]

        self.assertEqual(fetched["milestone"]["linked_tasks"][0]["status"], "done")
        self.assertEqual(len(fetched_reads), 1)
        self.assertEqual(fetched_reads[0].resource_id, str(task_id))
        self.assertEqual(fetched_reads[0].label, "Completed milestone task")
        self.assertEqual(fetched_reads[0].locator["milestone_id"], milestone.id)

    def test_project_milestone_capabilities_create_update_list_get_link_unlink(self) -> None:
        project = create_project(self.conn, name="Milestone Tool Project")
        task_id = insert_todo(
            self.conn,
            Todo(
                title="Existing milestone task",
                priority=TodoPriority.MEDIUM,
                project_ids=[project.id or 0],
            ),
        )

        created = json.loads(execute_capability_text(
            "create_project_milestone",
            {
                "project_id": project.id,
                "title": "Draft analysis",
                "description": "Run first model.",
                "kind": "analysis",
                "status": "in_progress",
                "order_index": 2,
                "acceptance_criteria": "Notebook and figures exist.",
                "target_date": "2026-06-20",
            },
            self.conn,
        ))

        self.assertTrue(created["ok"])
        milestone_id = created["id"]
        self.assertEqual(created["after"]["title"], "Draft analysis")
        self.assertEqual(created["after"]["kind"], "analysis")
        self.assertEqual(created["after"]["status"], "in_progress")
        self.assertEqual(created["after"]["target_date"], "2026-06-20")

        listed = json.loads(execute_capability_text(
            "list_project_milestones",
            {"project_id": project.id, "status": "in_progress"},
            self.conn,
        ))
        self.assertEqual(listed["count"], 1)
        self.assertEqual(listed["milestones"][0]["id"], milestone_id)

        fetched = json.loads(execute_capability_text(
            "get_project_milestone",
            {"project_id": project.id, "milestone_id": milestone_id},
            self.conn,
        ))
        self.assertTrue(fetched["ok"])
        self.assertEqual(fetched["milestone"]["acceptance_criteria"], "Notebook and figures exist.")

        updated = json.loads(execute_capability_text(
            "update_project_milestone",
            {
                "project_id": project.id,
                "milestone_id": milestone_id,
                "title": "Analysis drafted",
                "description": None,
                "status": "ready_for_review",
                "target_date": None,
            },
            self.conn,
        ))
        self.assertTrue(updated["ok"])
        self.assertEqual(updated["before"]["description"], "Run first model.")
        self.assertEqual(updated["after"]["title"], "Analysis drafted")
        self.assertIsNone(updated["after"]["description"])
        self.assertEqual(updated["after"]["status"], "ready_for_review")
        self.assertIsNone(updated["after"]["target_date"])

        linked = json.loads(execute_capability_text(
            "link_milestone_task",
            {"project_id": project.id, "milestone_id": milestone_id, "task_id": task_id},
            self.conn,
        ))
        self.assertTrue(linked["ok"])
        self.assertEqual(linked["after"]["milestone"]["linked_task_ids"], [task_id])
        self.assertEqual(linked["after"]["milestone"]["linked_tasks"][0]["title"], "Existing milestone task")

        unlinked = json.loads(execute_capability_text(
            "unlink_milestone_task",
            {"project_id": project.id, "milestone_id": milestone_id, "task_id": task_id},
            self.conn,
        ))
        self.assertTrue(unlinked["ok"])
        self.assertEqual(unlinked["after"]["milestone"]["linked_task_ids"], [])
        self.assertIsNotNone(get_todo(self.conn, task_id))

    def test_update_project_milestone_rejects_invalid_enums_without_partial_mutation(self) -> None:
        project = create_project(self.conn, name="Milestone Enum Project")
        milestone = create_project_milestone(
            self.conn,
            project_id=project.id or 0,
            title="Analysis checkpoint",
            kind=ProjectMilestoneKind.ANALYSIS,
            status=ProjectMilestoneStatus.IN_PROGRESS,
        )

        invalid_status = json.loads(execute_capability_text(
            "update_project_milestone",
            {
                "project_id": project.id,
                "milestone_id": milestone.id,
                "title": "Should not persist",
                "status": "completed",
            },
            self.conn,
        ))
        self.assertFalse(invalid_status["ok"])
        self.assertIn("completed", invalid_status["error"])
        self.assertIn("ProjectMilestoneStatus", invalid_status["error"])

        unchanged = get_project_milestone(self.conn, project.id or 0, milestone.id or 0)
        self.assertIsNotNone(unchanged)
        assert unchanged is not None
        self.assertEqual(unchanged.title, "Analysis checkpoint")
        self.assertEqual(unchanged.status, ProjectMilestoneStatus.IN_PROGRESS)

        invalid_kind = json.loads(execute_capability_text(
            "update_project_milestone",
            {
                "project_id": project.id,
                "milestone_id": milestone.id,
                "kind": "experiment",
            },
            self.conn,
        ))
        self.assertFalse(invalid_kind["ok"])
        self.assertIn("experiment", invalid_kind["error"])
        self.assertIn("ProjectMilestoneKind", invalid_kind["error"])

    def test_link_milestone_task_rejects_cross_project_task_without_partial_mutation(self) -> None:
        project = create_project(self.conn, name="Milestone Link Project")
        other_project = create_project(self.conn, name="Other Milestone Link Project")
        milestone = create_project_milestone(
            self.conn,
            project_id=project.id or 0,
            title="Only this project",
        )
        other_task = insert_todo(
            self.conn,
            Todo(
                title="Other project task",
                priority=TodoPriority.MEDIUM,
                project_ids=[other_project.id or 0],
            ),
        )

        payload = json.loads(execute_capability_text(
            "link_milestone_task",
            {"project_id": project.id, "milestone_id": milestone.id, "task_id": other_task},
            self.conn,
        ))

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"], f"Todo {other_task} is not linked to project {project.id}.")
        self.assertEqual(list_milestone_todos(self.conn, project.id or 0, milestone.id or 0), [])

    def test_create_milestone_task_creates_project_task_and_links_it(self) -> None:
        project = create_project(self.conn, name="Milestone Task Project")
        milestone = create_project_milestone(
            self.conn,
            project_id=project.id or 0,
            title="Task milestone",
        )

        payload = json.loads(execute_capability_text(
            "create_milestone_task",
            {
                "project_id": project.id,
                "milestone_id": milestone.id,
                "title": "Run milestone experiment",
                "description": "Collect new data.",
                "priority": "high",
                "due_date": "2026-06-30",
            },
            self.conn,
        ))

        self.assertTrue(payload["ok"])
        task = get_todo(self.conn, payload["id"])
        self.assertIsNotNone(task)
        self.assertEqual(task.title, "Run milestone experiment")
        self.assertEqual(task.priority, TodoPriority.HIGH)
        self.assertEqual(task.project_ids, [project.id])
        self.assertEqual(str(task.due_date), "2026-06-30")
        self.assertEqual(
            [todo.id for todo in list_milestone_todos(self.conn, project.id or 0, milestone.id or 0)],
            [payload["id"]],
        )
        self.assertEqual(payload["milestone"]["linked_task_ids"], [payload["id"]])

    def test_get_note_context_returns_full_note(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        note = create_note(
            self.conn,
            title="Context note",
            body="Full note body",
            manual_paper_ids=[paper_id],
        )

        result = execute_capability(
            "get_note_context",
            {"note_id": note.id},
            self.conn,
        )
        payload = json.loads(result.text)

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["note"]["id"], note.id)
        self.assertEqual(payload["note"]["title"], "Context note")
        self.assertEqual(payload["note"]["body"], "Full note body")
        self.assertEqual(payload["note"]["linked_paper_ids"], [paper_id])
        self.assertEqual(payload["note"]["manual_paper_ids"], [paper_id])
        self.assertEqual(len(result.resource_reads), 1)
        self.assertEqual(result.resource_reads[0].resource_kind, "note")
        self.assertEqual(result.resource_reads[0].resource_id, str(note.id))
        self.assertEqual(result.resource_reads[0].locator, {"note_id": note.id})

    def test_search_notes_supports_semantic_backend(self) -> None:
        note = create_note(
            self.conn,
            title="Semantic capability note",
            body="Semantic capability note body.",
        )
        self.conn.commit()
        document = SemanticDocument(
            row_id=f"note:{note.id}",
            source_type=RetrievalSourceType.NOTE,
            source_id=str(note.id),
            title="Semantic capability note",
            text="Semantic capability note body.",
            locator={"note_id": note.id},
            updated_at="2026-06-04T00:00:00",
            content_hash="semantic-capability-note",
        )
        status = make_semantic_status(self.tmpdir.name)

        with patch("claudesk.core.retrieval.vector.semantic_index_status", return_value=status), \
                patch(
                    "claudesk.core.retrieval.vector.search_semantic_index",
                    return_value=[SemanticSearchHit(document=document, score=1.0)],
                ):
            payload = json.loads(execute_capability_text(
                "search_notes",
                {"query": "embedding neighbor", "backend": "semantic"},
                self.conn,
            ))

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["query"], "embedding neighbor")
        self.assertEqual([item["id"] for item in payload["notes"]], [note.id])
        self.assertEqual(payload["notes"][0]["title"], "Semantic capability note")

    def test_get_note_context_reports_missing_note(self) -> None:
        payload = json.loads(execute_capability_text(
            "get_note_context",
            {"note_id": 999},
            self.conn,
        ))

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"], "Note 999 not found.")

    def test_get_chat_attachment_context_returns_bounded_text(self) -> None:
        with tempfile.TemporaryDirectory():
            cfg = Config()
            session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
            managed_path = f"sessions/{session.id}/clipboard.txt"
            full_path = resolve_chat_attachment_path(managed_path, cfg=cfg)
            full_path.parent.mkdir(parents=True, exist_ok=True)
            full_path.write_text("abcdef", encoding="utf-8")
            attachment = create_chat_attachment(
                self.conn,
                session.id or 0,
                context_kind="clipboard_text",
                kind=AssetKind.TEXT,
                source="chat",
                managed_path=managed_path,
                original_filename="clipboard.txt",
                display_name="Pasted text",
                mime_type="text/plain",
                size_bytes=6,
                content_hash="sha256-text-attachment",
                parse_status=AssetParseStatus.PARSED,
                parsed_text="abcdef",
            )

            result = get_capability_registry().execute(
                "get_chat_attachment_context",
                {"asset_id": attachment.asset.id, "max_chars": 3},
                CapabilityContext.for_connection(self.conn, cfg=cfg, session_id=session.id),
                tools_cfg=cfg.chat.tools,
            )

        payload = json.loads(result.text)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["access_mode"], "attachment_text")
        self.assertEqual(payload["content"], "abc")
        self.assertTrue(payload["truncated"])
        self.assertEqual(len(result.resource_reads), 1)
        self.assertEqual(result.resource_reads[0].resource_kind, "asset")
        self.assertEqual(result.resource_reads[0].locator["context_kind"], "clipboard_text")

    def test_get_chat_attachment_context_returns_image_evidence(self) -> None:
        with tempfile.TemporaryDirectory():
            cfg = Config()
            session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
            managed_path = f"sessions/{session.id}/figure.png"
            full_path = resolve_chat_attachment_path(managed_path, cfg=cfg)
            full_path.parent.mkdir(parents=True, exist_ok=True)
            full_path.write_bytes(b"\x89PNG\r\n")
            attachment = create_chat_attachment(
                self.conn,
                session.id or 0,
                context_kind="file",
                kind=AssetKind.ATTACHMENT,
                source="chat",
                managed_path=managed_path,
                original_filename="figure.png",
                display_name="figure.png",
                mime_type="image/png",
                size_bytes=6,
                content_hash="sha256-image-attachment",
            )

            result = get_capability_registry().execute(
                "get_chat_attachment_context",
                {"asset_id": attachment.asset.id, "include_image": True},
                CapabilityContext.for_connection(self.conn, cfg=cfg, session_id=session.id),
                tools_cfg=cfg.chat.tools,
            )

        payload = json.loads(result.text)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["access_mode"], "attachment_image")
        self.assertEqual(len(result.images), 1)
        self.assertEqual(result.images[0].mime_type, "image/png")
        self.assertEqual(result.images[0].asset_id, attachment.asset.id)
        self.assertEqual(result.resource_reads[0].resource_kind, "asset")

    def test_get_chat_attachment_context_parses_pdf_chunks_pages_and_reads(self) -> None:
        with tempfile.TemporaryDirectory():
            cfg = Config()
            session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
            managed_path = f"sessions/{session.id}/attachment.pdf"
            write_pdf(
                resolve_chat_attachment_path(managed_path, cfg=cfg),
                ["Attachment page one text.", "Attachment page two text."],
            )
            attachment = create_chat_attachment(
                self.conn,
                session.id or 0,
                context_kind="file",
                kind=AssetKind.PDF,
                source="chat",
                managed_path=managed_path,
                original_filename="attachment.pdf",
                display_name="attachment.pdf",
                mime_type="application/pdf",
                size_bytes=128,
                content_hash="sha256-pdf-attachment",
            )

            result = get_capability_registry().execute(
                "get_chat_attachment_context",
                {"asset_id": attachment.asset.id, "limit": 2, "include_image": True},
                CapabilityContext.for_connection(self.conn, cfg=cfg, session_id=session.id),
                tools_cfg=cfg.chat.tools,
            )
            bounded_result = get_capability_registry().execute(
                "get_chat_attachment_context",
                {"asset_id": attachment.asset.id, "limit": 2, "max_chars": 10, "include_image": False},
                CapabilityContext.for_connection(self.conn, cfg=cfg, session_id=session.id),
                tools_cfg=cfg.chat.tools,
            )

        payload = json.loads(result.text)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["access_mode"], "attachment_pdf_chunks")
        self.assertEqual([chunk["page_number"] for chunk in payload["chunks"]], [1, 2])
        self.assertEqual([page["page_number"] for page in payload["pages"]], [1, 2])
        self.assertEqual(len(result.images), 2)
        reads_by_kind = {}
        for read in result.resource_reads:
            reads_by_kind.setdefault(read.resource_kind, []).append(read)
        self.assertEqual(len(reads_by_kind["asset"]), 1)
        self.assertEqual(len(reads_by_kind["pdf_chunk"]), 2)
        self.assertEqual(len(reads_by_kind["pdf_page"]), 2)
        self.assertEqual(reads_by_kind["pdf_chunk"][0].locator["context_kind"], "file")
        bounded_payload = json.loads(bounded_result.text)
        self.assertTrue(bounded_payload["ok"])
        self.assertLessEqual(sum(len(chunk["text"]) for chunk in bounded_payload["chunks"]), 10)
        self.assertLessEqual(bounded_payload["char_count"], 10)
        self.assertTrue(bounded_payload["truncated"])

    def test_get_chat_attachment_context_enforces_session_scope_and_file_state(self) -> None:
        with tempfile.TemporaryDirectory():
            cfg = Config()
            session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
            other_session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
            other = create_chat_attachment(
                self.conn,
                other_session.id or 0,
                context_kind="file",
                kind=AssetKind.TEXT,
                source="chat",
                managed_path=f"sessions/{other_session.id}/other.txt",
                original_filename="other.txt",
                display_name="other.txt",
                mime_type="text/plain",
                size_bytes=5,
                content_hash="sha256-other",
            )
            missing = create_chat_attachment(
                self.conn,
                session.id or 0,
                context_kind="file",
                kind=AssetKind.TEXT,
                source="chat",
                managed_path=f"sessions/{session.id}/missing.txt",
                original_filename="missing.txt",
                display_name="missing.txt",
                mime_type="text/plain",
                size_bytes=5,
                content_hash="sha256-missing",
            )

            scoped = get_capability_registry().execute(
                "get_chat_attachment_context",
                {"asset_id": other.asset.id},
                CapabilityContext.for_connection(self.conn, cfg=cfg, session_id=session.id),
                tools_cfg=cfg.chat.tools,
            )
            unscoped = get_capability_registry().execute(
                "get_chat_attachment_context",
                {"asset_id": other.asset.id},
                CapabilityContext.for_connection(self.conn, cfg=cfg),
                tools_cfg=cfg.chat.tools,
            )
            unavailable = get_capability_registry().execute(
                "get_chat_attachment_context",
                {"asset_id": missing.asset.id},
                CapabilityContext.for_connection(self.conn, cfg=cfg, session_id=session.id),
                tools_cfg=cfg.chat.tools,
            )

        self.assertFalse(json.loads(scoped.text)["ok"])
        self.assertIn("not found for this session", json.loads(scoped.text)["error"])
        self.assertFalse(json.loads(unscoped.text)["ok"])
        self.assertIn("active chat session", json.loads(unscoped.text)["error"])
        self.assertFalse(json.loads(unavailable.text)["ok"])
        self.assertIn("not locally available", json.loads(unavailable.text)["error"])

    def test_managed_pdf_asset_capabilities_rename_parse_and_attach_url(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        cfg = Config()
        managed_path = f"papers/{paper_id}/capability-parse.pdf"
        write_pdf(resolve_managed_asset_path(managed_path, cfg=cfg), ["Managed PDF text."])
        asset = create_paper_asset(
            self.conn,
            paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path=managed_path,
            original_filename="capability-parse.pdf",
            display_name="Original PDF",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-parse-capability",
            parse_status=AssetParseStatus.NOT_PARSED,
        )

        renamed = json.loads(execute_capability_text(
            "rename_paper_asset",
            {"paper_id": paper_id, "asset_id": asset.id, "display_name": "Renamed PDF"},
            self.conn,
            cfg=cfg,
        ))
        parsed = json.loads(execute_capability_text(
            "parse_paper_asset",
            {"paper_id": paper_id, "asset_id": asset.id, "force": True},
            self.conn,
            cfg=cfg,
        ))
        with (
            patch.object(httpx.HTTPTransport, "handle_request", return_value=httpx.Response(200, content=b"%PDF-1.4\n%%EOF")),
            patch("claudesk.core.public_http.socket.getaddrinfo", return_value=[(0, 0, 0, "", ("93.184.216.34", 0))]),
        ):
            attached = json.loads(execute_capability_text(
                "attach_pdf_from_url",
                {"paper_id": paper_id, "url": "https://example.com/paper.pdf"},
                self.conn,
                cfg=cfg,
            ))

        self.assertTrue(renamed["ok"])
        self.assertEqual(renamed["before"]["display_name"], "Original PDF")
        self.assertEqual(renamed["after"]["display_name"], "Renamed PDF")
        self.assertTrue(parsed["ok"])
        self.assertEqual(parsed["after"]["parse_status"], "parsed")
        self.assertGreater(parsed["after"]["page_count"], 0)
        self.assertTrue(attached["ok"])
        self.assertEqual(attached["after"]["kind"], "pdf")
        assets = list_paper_assets(self.conn, paper_id)
        self.assertEqual(len(assets), 2)
        url_asset = next(item for item in assets if item.id == attached["id"])
        self.assertTrue(url_asset.managed_path.startswith("papers/"))
        self.assertTrue(resolve_managed_asset_path(url_asset.managed_path, cfg=cfg).exists())

    def test_attach_pdf_from_url_generates_title_filename_without_pdf_path(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper(title="Readable Paper Title"))
        cfg = Config()

        with (
            patch.object(httpx.HTTPTransport, "handle_request", return_value=httpx.Response(200, content=b"%PDF-1.4\n%%EOF")),
            patch("claudesk.core.public_http.socket.getaddrinfo", return_value=[(0, 0, 0, "", ("93.184.216.34", 0))]),
        ):
            attached = json.loads(execute_capability_text(
                "attach_pdf_from_url",
                {"paper_id": paper_id, "url": "https://example.com/download?id=123"},
                self.conn,
                cfg=cfg,
            ))

        self.assertTrue(attached["ok"])
        self.assertEqual(attached["after"]["original_filename"], "Readable Paper Title.pdf")
        self.assertEqual(attached["after"]["display_name"], "Readable Paper Title.pdf")
        url_asset = next(item for item in list_paper_assets(self.conn, paper_id) if item.id == attached["id"])
        self.assertIn("Readable-Paper-Title.pdf", url_asset.managed_path)
        self.assertNotIn("download.pdf", url_asset.managed_path)

    def test_attach_pdf_from_url_rejects_unsafe_or_invalid_downloads(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())

        with self.assertRaises(ValueError):
            execute_capability_text(
                "attach_pdf_from_url",
                {"paper_id": paper_id, "url": "http://example.com/paper.pdf"},
                self.conn,
            )

        with (
            patch.object(httpx.HTTPTransport, "handle_request", return_value=httpx.Response(200, content=b"<html>not a pdf</html>")),
            patch("claudesk.core.public_http.socket.getaddrinfo", return_value=[(0, 0, 0, "", ("93.184.216.34", 0))]),
        ):
            with self.assertRaisesRegex(InvalidPaperAssetFile, "not a PDF"):
                execute_capability_text(
                    "attach_pdf_from_url",
                    {"paper_id": paper_id, "url": "https://example.com/not-pdf.pdf"},
                    self.conn,
                )

        with (
            patch("claudesk.core.paper_asset_ops.ATTACH_PDF_FROM_URL_MAX_BYTES", 8),
            patch.object(httpx.HTTPTransport, "handle_request", return_value=httpx.Response(200, content=b"%PDF-1.4\n%%EOF")),
            patch("claudesk.core.public_http.socket.getaddrinfo", return_value=[(0, 0, 0, "", ("93.184.216.34", 0))]),
        ):
            with self.assertRaisesRegex(InvalidPaperAssetFile, "8 byte size limit"):
                execute_capability_text(
                    "attach_pdf_from_url",
                    {"paper_id": paper_id, "url": "https://example.com/too-large.pdf"},
                    self.conn,
                )

    def test_download_pdf_blocks_initial_private_destinations_before_dispatch(self) -> None:
        for url, address in (
            ("https://127.0.0.1/paper.pdf", "127.0.0.1"),
            ("https://169.254.169.254/paper.pdf", "169.254.169.254"),
            ("https://100.64.0.1/file.pdf", "100.64.0.1"),
            ("https://[::ffff:100.64.0.1]/file.pdf", "::ffff:100.64.0.1"),
            ("https://private.example/paper.pdf", "192.168.1.5"),
        ):
            with (
                self.subTest(url=url),
                patch.object(httpx.HTTPTransport, "handle_request") as transport,
                patch("claudesk.core.public_http.socket.getaddrinfo", return_value=[(0, 0, 0, "", (address, 0))]),
                self.assertRaises(InvalidPaperAssetFile),
            ):
                download_pdf_from_https_url(url)
            transport.assert_not_called()

    def test_download_pdf_validates_redirects_before_dispatch(self) -> None:
        for target in (
            "https://127.0.0.1/private.pdf",
            "https://169.254.169.254/private.pdf",
            "https://private.example/private.pdf",
            "http://example.com/downgrade.pdf",
        ):
            def resolve(host, *args, **kwargs):
                address = "192.168.1.5" if host == "private.example" else "93.184.216.34"
                return [(0, 0, 0, "", (address, 0))]

            response = httpx.Response(302, headers={"Location": target})
            with (
                self.subTest(target=target),
                patch.object(httpx.HTTPTransport, "handle_request", return_value=response) as transport,
                patch("claudesk.core.public_http.socket.getaddrinfo", side_effect=resolve),
                self.assertRaises(InvalidPaperAssetFile),
            ):
                download_pdf_from_https_url("https://example.com/paper.pdf")
            self.assertEqual(transport.call_count, 1)
            self.assertEqual(str(transport.call_args.args[0].url), "https://example.com/paper.pdf")
            self.assertTrue(response.is_closed)

    def test_download_pdf_follows_public_redirects_and_uses_final_filename(self) -> None:
        content = b"%PDF-1.4\n%%EOF"
        responses = [
            httpx.Response(301, headers={"Location": "/papers/redirect"}),
            httpx.Response(307, headers={"Location": "https://cdn.example/Final%20Paper.pdf"}),
            httpx.Response(200, content=content),
        ]
        with (
            patch.object(httpx.HTTPTransport, "handle_request", side_effect=responses) as transport,
            patch("claudesk.core.public_http.socket.getaddrinfo", return_value=[(0, 0, 0, "", ("93.184.216.34", 0))]) as resolve,
        ):
            downloaded = download_pdf_from_https_url("https://example.com/original.pdf")

        self.assertEqual(
            [str(call.args[0].url) for call in transport.call_args_list],
            [
                "https://example.com/original.pdf",
                "https://example.com/papers/redirect",
                "https://cdn.example/Final%20Paper.pdf",
            ],
        )
        self.assertEqual(resolve.call_count, 3)
        self.assertEqual(downloaded.filename, "Final Paper.pdf")
        self.assertEqual(downloaded.mime_type, "application/pdf")
        self.assertEqual(downloaded.file_obj.read(), content)
        self.assertTrue(all(response.is_closed for response in responses))

    def test_download_pdf_bounds_redirect_loops(self) -> None:
        responses: list[httpx.Response] = []

        def redirect(request: httpx.Request) -> httpx.Response:
            response = httpx.Response(302, headers={"Location": "/paper.pdf"})
            responses.append(response)
            return response

        with (
            patch.object(httpx.HTTPTransport, "handle_request", side_effect=redirect) as transport,
            patch("claudesk.core.public_http.socket.getaddrinfo", return_value=[(0, 0, 0, "", ("93.184.216.34", 0))]),
            self.assertRaisesRegex(InvalidPaperAssetFile, "redirect"),
        ):
            download_pdf_from_https_url("https://example.com/paper.pdf")

        self.assertEqual(transport.call_count, MAX_REDIRECTS + 1)
        self.assertTrue(all(response.is_closed for response in responses))

    def test_download_pdf_bounds_streamed_content_and_closes_response(self) -> None:
        class PdfStream(httpx.SyncByteStream):
            def __init__(self) -> None:
                self.chunks_read = 0
                self.closed = False

            def __iter__(self):
                for chunk in (b"%PDF-", b"1234", b"must not be read"):
                    self.chunks_read += 1
                    yield chunk

            def close(self) -> None:
                self.closed = True

        for headers, expected_chunks in (({}, 2), ({"Content-Length": "9"}, 0)):
            stream = PdfStream()
            response = httpx.Response(200, headers=headers, stream=stream)
            with (
                self.subTest(headers=headers),
                patch.object(httpx.HTTPTransport, "handle_request", return_value=response),
                patch("claudesk.core.public_http.socket.getaddrinfo", return_value=[(0, 0, 0, "", ("93.184.216.34", 0))]),
                self.assertRaisesRegex(InvalidPaperAssetFile, "8 byte size limit"),
            ):
                download_pdf_from_https_url("https://example.com/paper.pdf", max_bytes=8)

            self.assertEqual(stream.chunks_read, expected_chunks)
            self.assertTrue(stream.closed)
            self.assertTrue(response.is_closed)

    def test_download_pdf_converts_transport_and_http_errors(self) -> None:
        for outcome in (httpx.ConnectTimeout("connection timed out"), httpx.Response(404)):
            with (
                self.subTest(outcome=outcome),
                patch.object(httpx.HTTPTransport, "handle_request", side_effect=[outcome]) as transport,
                patch("claudesk.core.public_http.socket.getaddrinfo", return_value=[(0, 0, 0, "", ("93.184.216.34", 0))]),
                self.assertRaises(InvalidPaperAssetFile),
            ):
                download_pdf_from_https_url("https://example.com/paper.pdf")
            transport.assert_called_once()

    def test_project_capabilities_create_update_and_link_papers(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())

        created = json.loads(execute_capability_text(
            "create_project",
            {"name": "Agent project", "description": "Draft", "tags": ["agent"]},
            self.conn,
        ))
        project_id = created["id"]
        updated = json.loads(execute_capability_text(
            "update_project_metadata",
            {"project_id": project_id, "name": "Updated project", "tags": ["updated"]},
            self.conn,
        ))
        linked = json.loads(execute_capability_text(
            "link_project_paper",
            {"project_id": project_id, "paper_id": paper_id, "role": "seed"},
            self.conn,
        ))

        self.assertTrue(created["ok"])
        self.assertEqual(updated["before"]["name"], "Agent project")
        self.assertEqual(updated["after"]["name"], "Updated project")
        self.assertTrue(linked["ok"])
        self.assertEqual([paper.id for paper in list_project_papers(self.conn, project_id)], [paper_id])

        unlinked = json.loads(execute_capability_text(
            "unlink_project_paper",
            {"project_id": project_id, "paper_id": paper_id},
            self.conn,
        ))
        self.assertTrue(unlinked["ok"])
        self.assertEqual(list_project_papers(self.conn, project_id), [])

        with self.assertRaises(ValidationError):
            execute_capability_text(
                "update_project_metadata",
                {"project_id": project_id, "status": "done"},
                self.conn,
            )

    def test_note_capabilities_create_edit_and_link_notes(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())

        standalone = json.loads(execute_capability_text(
            "create_note",
            {"title": "Standalone", "body": "Initial body"},
            self.conn,
        ))
        note_id = standalone["id"]
        linked = json.loads(execute_capability_text(
            "link_note_paper",
            {"note_id": note_id, "paper_id": paper_id},
            self.conn,
        ))
        updated = json.loads(execute_capability_text(
            "update_note",
            {"note_id": note_id, "title": "Edited", "body": "Edited body"},
            self.conn,
        ))

        self.assertTrue(standalone["ok"])
        self.assertEqual(standalone["after"]["linked_paper_ids"], [])
        self.assertEqual(linked["after"]["manual_paper_ids"], [paper_id])
        self.assertEqual(updated["before"]["body"], "Initial body")
        self.assertEqual(updated["after"]["body"], "Edited body")
        self.assertEqual(list_notes(self.conn, paper_id=paper_id)[0].title, "Edited")

        unlinked = json.loads(execute_capability_text(
            "unlink_note_paper",
            {"note_id": note_id, "paper_id": paper_id},
            self.conn,
        ))
        self.assertTrue(unlinked["ok"])
        self.assertEqual(unlinked["after"]["manual_paper_ids"], [])
        self.assertEqual(list_notes(self.conn, paper_id=paper_id), [])

        with self.assertRaises(ValidationError):
            execute_capability_text(
                "update_note",
                {"note_id": note_id, "linked_paper_ids": [paper_id]},
                self.conn,
            )

    def test_create_paper_note_still_creates_first_class_paper_note(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())

        created = json.loads(execute_capability_text(
            "create_paper_note",
            {"paper_id": paper_id, "note": "Initial note"},
            self.conn,
        ))

        self.assertTrue(created["ok"])
        notes = list_notes(self.conn, paper_id=paper_id)
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0].body, "Initial note")
        self.assertEqual(notes[0].manual_paper_ids, [paper_id])

    def test_manifest_hash_changes_with_tool_gates(self) -> None:
        self.assertNotEqual(
            tool_manifest_hash(ChatToolsConfig()),
            tool_manifest_hash(ChatToolsConfig(paper_pdf=False)),
        )

    def test_pydantic_toolset_lists_allowed_enabled_capabilities(self) -> None:
        deps = CapabilityRuntimeDeps(
            conn=self.conn,
            cfg=Config(chat=ChatConfig(tools=ChatToolsConfig(paper_pdf=False))),
            allowed_capabilities={"search_web", "read_paper_pdf", "get_papers_by_ids"},
        )
        toolset = CapabilityToolset()
        tools = asyncio.run(toolset.get_tools(SimpleNamespace(deps=deps)))

        self.assertIn("search_web", tools)
        self.assertIn("get_papers_by_ids", tools)
        self.assertNotIn("read_paper_pdf", tools)

    def test_pydantic_toolset_executes_through_registry(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        deps = CapabilityRuntimeDeps(
            conn=self.conn,
            cfg=Config(),
            allowed_capabilities={"get_papers_by_ids"},
        )
        ctx = SimpleNamespace(deps=deps)
        toolset = CapabilityToolset()
        tools = asyncio.run(toolset.get_tools(ctx))

        result = asyncio.run(toolset.call_tool(
            "get_papers_by_ids",
            {"paper_ids": [paper_id]},
            ctx,
            tools["get_papers_by_ids"],
        ))

        self.assertIsInstance(result, str)
        self.assertIn("Capability paper", result)
        self.assertEqual(len(deps.tool_executions), 1)
        self.assertEqual(deps.tool_executions[0].name, "get_papers_by_ids")
        self.assertEqual(deps.tool_executions[0].args, {"paper_ids": [paper_id]})

    def test_pydantic_toolset_returns_attachment_image_evidence(self) -> None:
        with tempfile.TemporaryDirectory():
            cfg = Config()
            session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
            managed_path = f"sessions/{session.id}/figure.png"
            full_path = resolve_chat_attachment_path(managed_path, cfg=cfg)
            full_path.parent.mkdir(parents=True, exist_ok=True)
            full_path.write_bytes(b"\x89PNG\r\n")
            attachment = create_chat_attachment(
                self.conn,
                session.id or 0,
                context_kind="file",
                kind=AssetKind.ATTACHMENT,
                source="chat",
                managed_path=managed_path,
                original_filename="figure.png",
                display_name="figure.png",
                mime_type="image/png",
                size_bytes=6,
                content_hash="sha256-toolset-image",
            )
            deps = CapabilityRuntimeDeps(
                conn=self.conn,
                cfg=cfg,
                allowed_capabilities={"get_chat_attachment_context"},
                session_id=session.id,
            )
            ctx = SimpleNamespace(deps=deps)
            toolset = CapabilityToolset()
            tools = asyncio.run(toolset.get_tools(ctx))

            result = asyncio.run(toolset.call_tool(
                "get_chat_attachment_context",
                {"asset_id": attachment.asset.id, "include_image": True},
                ctx,
                tools["get_chat_attachment_context"],
            ))

        self.assertIsInstance(result, ToolReturn)
        self.assertIn("attachment_image", result.return_value)
        self.assertGreaterEqual(len(result.content), 3)

    def test_pydantic_toolset_returns_attachment_pdf_page_evidence(self) -> None:
        with tempfile.TemporaryDirectory():
            cfg = Config()
            session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
            managed_path = f"sessions/{session.id}/attachment.pdf"
            write_pdf(resolve_chat_attachment_path(managed_path, cfg=cfg), ["PDF page evidence."])
            attachment = create_chat_attachment(
                self.conn,
                session.id or 0,
                context_kind="file",
                kind=AssetKind.PDF,
                source="chat",
                managed_path=managed_path,
                original_filename="attachment.pdf",
                display_name="attachment.pdf",
                mime_type="application/pdf",
                size_bytes=128,
                content_hash="sha256-toolset-pdf",
            )
            deps = CapabilityRuntimeDeps(
                conn=self.conn,
                cfg=cfg,
                allowed_capabilities={"get_chat_attachment_context"},
                session_id=session.id,
            )
            ctx = SimpleNamespace(deps=deps)
            toolset = CapabilityToolset()
            tools = asyncio.run(toolset.get_tools(ctx))

            result = asyncio.run(toolset.call_tool(
                "get_chat_attachment_context",
                {"asset_id": attachment.asset.id, "include_image": True},
                ctx,
                tools["get_chat_attachment_context"],
            ))

        self.assertIsInstance(result, ToolReturn)
        self.assertIn("attachment_pdf_chunks", result.return_value)
        self.assertGreaterEqual(len(result.content), 3)

    def test_pydantic_toolset_persists_capability_resource_reads(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper(title="Persisted read paper"))
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        deps = CapabilityRuntimeDeps(
            conn=self.conn,
            cfg=Config(),
            allowed_capabilities={"get_papers_by_ids"},
            session_id=session.id,
            turn_id="turn-tool-read",
            provider="openai_api",
        )
        ctx = SimpleNamespace(deps=deps)
        toolset = CapabilityToolset()
        tools = asyncio.run(toolset.get_tools(ctx))

        asyncio.run(toolset.call_tool(
            "get_papers_by_ids",
            {"paper_ids": [paper_id]},
            ctx,
            tools["get_papers_by_ids"],
        ))

        reads = list_chat_resource_reads(self.conn, session.id or 0)
        self.assertEqual(len(reads), 1)
        self.assertEqual(reads[0].source, "capability_result")
        self.assertEqual(reads[0].provider, "openai_api")
        self.assertEqual(reads[0].turn_id, "turn-tool-read")
        self.assertEqual(reads[0].capability_name, "get_papers_by_ids")
        self.assertEqual(reads[0].resource_kind, "paper")
        self.assertEqual(reads[0].resource_id, str(paper_id))
        self.assertIsNone(reads[0].assistant_message_id)

    def test_pydantic_toolset_ignores_resource_read_persistence_failures(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper(title="Best effort paper"))
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        deps = CapabilityRuntimeDeps(
            conn=self.conn,
            cfg=Config(),
            allowed_capabilities={"get_papers_by_ids"},
            session_id=session.id,
            turn_id="turn-ledger-failure",
            provider="openai_api",
        )
        ctx = SimpleNamespace(deps=deps)
        toolset = CapabilityToolset()
        tools = asyncio.run(toolset.get_tools(ctx))

        with (
            patch(
                "claudesk.agent.runtime.insert_chat_resource_reads",
                side_effect=RuntimeError("ledger write failed"),
            ),
            patch("claudesk.agent.runtime.logger.exception") as log_exception,
        ):
            result = asyncio.run(toolset.call_tool(
                "get_papers_by_ids",
                {"paper_ids": [paper_id]},
                ctx,
                tools["get_papers_by_ids"],
            ))

        self.assertIsInstance(result, str)
        self.assertIn("Best effort paper", result)
        self.assertEqual(len(deps.tool_executions), 1)
        log_exception.assert_called_once()
        self.assertIn(
            "Failed to persist capability resource reads",
            log_exception.call_args.args[0],
        )


if __name__ == "__main__":
    unittest.main()
