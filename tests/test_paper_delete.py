from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from datetime import date, datetime, timezone

from fastapi import HTTPException

from claudesk.api import papers as papers_api
from claudesk.core.config import ChatRuntimeSettings
from claudesk.core.db.chat import create_chat_session
from claudesk.core.db.notes import (
    create_note,
    list_notes,
)
from claudesk.core.db.papers import (
    delete_paper,
    get_paper,
    search_papers,
    upsert_paper,
)
from claudesk.core.db import init_db
from claudesk.core.models import Paper


def make_conn(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def make_paper(
    *,
    source: str = "biorxiv",
    external_id: str = "10.1234/delete-me",
    title: str = "Deleted reference paper",
) -> Paper:
    return Paper(
        source=source,
        external_id=external_id,
        title=title,
        abstract="Reference abstract",
        authors=["Alice Example"],
        published_date=date(2026, 4, 24),
        url="https://example.com/paper",
    )


class PaperDeleteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.conn = make_conn(os.path.join(self.tmpdir.name, "claudesk.db"))
        init_db(self.conn)

    def tearDown(self) -> None:
        self.conn.close()
        self.tmpdir.cleanup()

    def test_delete_paper_removes_row_and_relational_links_but_keeps_mentions(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
        project_id = self.conn.execute(
            """
            INSERT INTO projects (slug, name, status, description, tags, created_at, updated_at)
            VALUES ('delete-project', 'Delete Project', 'active', '', '[]', ?, ?)
            """,
            (now, now),
        ).lastrowid
        self.conn.execute(
            "INSERT INTO project_papers (project_id, paper_id, role, created_at) VALUES (?, ?, 'relevant', ?)",
            (project_id, paper_id, now),
        )
        self.conn.execute(
            "INSERT INTO feedback (paper_id, signal, created_at) VALUES (?, 'saved', ?)",
            (paper_id, now),
        )
        progress_id = self.conn.execute(
            """
            INSERT INTO log_entries (entry_type, entry_date, entry_markdown, linked_paper_ids, task_id, created_at)
            VALUES ('manual', '2026-04-29', ?, ?, NULL, ?)
            """,
            (
                f"Logged [paper](paper://{paper_id})",
                json.dumps([paper_id]),
                now,
            ),
        ).lastrowid
        todo_id = self.conn.execute(
            """
            INSERT INTO todos (title, description, status, priority, created_at)
            VALUES ('Read paper', ?, 'open', 'medium', ?)
            """,
            (f"Read [paper](paper://{paper_id})", now),
        ).lastrowid
        session_id = create_chat_session(
            self.conn,
            runtime_settings=ChatRuntimeSettings(),
            title="Chat",
            linked_paper_ids=[paper_id],
            created_at=datetime.fromisoformat(now),
        ).id
        message_id = self.conn.execute(
            """
            INSERT INTO chat_messages (session_id, role, content, created_at)
            VALUES (?, 'user', ?, ?)
            """,
            (session_id, f"Discuss [paper](paper://{paper_id})", now),
        ).lastrowid
        note = create_note(
            self.conn,
            title="Linked note",
            body=f"Discuss [paper](paper://{paper_id}) in notes",
            manual_paper_ids=[paper_id],
        )
        self.conn.commit()

        delete_paper(self.conn, paper_id)
        self.conn.commit()

        self.assertIsNone(get_paper(self.conn, paper_id))
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM papers WHERE id=?", (paper_id,)).fetchone()[0], 0)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM feedback WHERE paper_id=?", (paper_id,)).fetchone()[0], 0)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM project_papers WHERE paper_id=?", (paper_id,)).fetchone()[0], 0)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM note_papers WHERE paper_id=?", (paper_id,)).fetchone()[0], 0)
        self.assertEqual(search_papers(self.conn, "Deleted reference"), [])

        stored_note = self.conn.execute("SELECT body FROM notes WHERE id=?", (note.id,)).fetchone()
        self.assertIsNotNone(stored_note)
        self.assertIn(f"paper://{paper_id}", stored_note["body"])
        self.assertEqual(list_notes(self.conn, paper_id=paper_id), [])

        progress = self.conn.execute(
            "SELECT entry_markdown, linked_paper_ids FROM log_entries WHERE id=?",
            (progress_id,),
        ).fetchone()
        self.assertIn(f"paper://{paper_id}", progress["entry_markdown"])
        self.assertEqual(json.loads(progress["linked_paper_ids"]), [paper_id])
        todo = self.conn.execute("SELECT description FROM todos WHERE id=?", (todo_id,)).fetchone()
        self.assertIn(f"paper://{paper_id}", todo["description"])
        session = self.conn.execute(
            "SELECT linked_paper_ids FROM chat_sessions WHERE id=?",
            (session_id,),
        ).fetchone()
        self.assertEqual(json.loads(session["linked_paper_ids"]), [paper_id])
        message = self.conn.execute("SELECT content FROM chat_messages WHERE id=?", (message_id,)).fetchone()
        self.assertIn(f"paper://{paper_id}", message["content"])

    def test_delete_paper_reports_missing_paper(self) -> None:
        with self.assertRaisesRegex(ValueError, "Paper 999 not found"):
            delete_paper(self.conn, 999)

    def test_delete_paper_api_returns_404_for_missing_paper(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            papers_api.remove_paper(999, conn=self.conn)

        self.assertEqual(ctx.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
