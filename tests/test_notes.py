from __future__ import annotations

import json
import io
import os
import sqlite3
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path
from urllib.parse import quote

from claudesk.api import notes as notes_api
from claudesk.api import search as search_api
from claudesk.core.config import load_config
from claudesk.core.db import (
    SCHEMA_VERSION,
    init_db,
)
from claudesk.core.db.notes import (
    create_note,
    delete_note,
    get_note,
    get_note_references,
    list_notes,
    search_notes,
    unlink_note_paper,
    update_note,
)
from claudesk.core.db.assets import (
    get_asset,
    list_note_assets,
)
from claudesk.core.db.papers import (
    get_paper,
    merge_title_duplicate_groups,
    upsert_paper,
)
from claudesk.core.models import Paper
from claudesk.core.note_wikilinks import normalize_note_title_key
from claudesk.core.paper_assets import resolve_managed_asset_path
from tests.helpers import patched_data_dir


def make_conn(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def make_paper(
    *,
    source: str = "biorxiv",
    external_id: str = "10.1234/example",
    title: str = "Example paper",
) -> Paper:
    return Paper(
        source=source,
        external_id=external_id,
        title=title,
        abstract="Example abstract",
        authors=["Alice Example"],
        published_date=date(2026, 4, 24),
        url="https://example.com/paper",
    )


def insert_raw_paper(conn: sqlite3.Connection, paper: Paper) -> int:
    conn.execute(
        """
        INSERT INTO papers
            (source, external_id, title, abstract, authors, published_date,
             journal_abbrev, url, status, is_saved, is_read, is_to_read, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            paper.source,
            paper.external_id,
            paper.title,
            paper.abstract,
            json.dumps(paper.authors),
            paper.published_date.isoformat(),
            paper.journal_abbrev,
            paper.url,
            paper.status.value,
            int(paper.is_saved),
            int(paper.is_read),
            int(paper.is_to_read),
            paper.fetched_at.isoformat(),
        ),
    )
    return int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])


class FakeUpload:
    def __init__(
        self,
        *,
        filename: str,
        content_type: str,
        content: bytes,
    ) -> None:
        self.filename = filename
        self.content_type = content_type
        self.file = io.BytesIO(content)


class NotesDbTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.conn = make_conn(os.path.join(self.tmpdir.name, "claudesk.db"))
        init_db(self.conn)

    def tearDown(self) -> None:
        self.conn.close()
        self.tmpdir.cleanup()

    def test_create_standalone_note(self) -> None:
        note = create_note(self.conn, title="Idea", body="Remember this")
        self.conn.commit()

        stored = get_note(self.conn, note.id or 0)

        self.assertIsNotNone(stored)
        self.assertEqual(stored.title, "Idea")
        self.assertEqual(stored.linked_paper_ids, [])

    def test_create_note_linked_to_multiple_papers(self) -> None:
        p1 = upsert_paper(self.conn, make_paper(external_id="10.1/a", title="Paper A"))
        p2 = upsert_paper(self.conn, make_paper(external_id="10.1/b", title="Paper B"))

        note = create_note(
            self.conn,
            title="Linked",
            body="Body",
            manual_paper_ids=[p1, p2],
        )
        self.conn.commit()

        self.assertEqual(note.linked_paper_ids, [p1, p2])
        self.assertEqual(note.manual_paper_ids, [p1, p2])
        self.assertEqual(note.mentioned_paper_ids, [])
        self.assertEqual([n.id for n in list_notes(self.conn, paper_id=p1)], [note.id])
        self.assertEqual([n.id for n in list_notes(self.conn, paper_id=p2)], [note.id])

    def test_note_payload_separates_manual_and_mentioned_links(self) -> None:
        p1 = upsert_paper(self.conn, make_paper(external_id="10.1/a", title="Paper A"))
        p2 = upsert_paper(self.conn, make_paper(external_id="10.1/b", title="Paper B"))

        note = create_note(
            self.conn,
            title="Mixed links",
            body=f"See [Paper B](paper://{p2})",
            manual_paper_ids=[p1],
        )
        self.conn.commit()

        self.assertEqual(note.linked_paper_ids, [p1, p2])
        self.assertEqual(note.manual_paper_ids, [p1])
        self.assertEqual(note.mentioned_paper_ids, [p2])

    def test_update_body_adds_mentioned_links_and_preserves_manual_links(self) -> None:
        p1 = upsert_paper(self.conn, make_paper(external_id="10.1/a", title="Paper A"))
        p2 = upsert_paper(self.conn, make_paper(external_id="10.1/b", title="Paper B"))
        note = create_note(self.conn, title="Linked", body="Body", manual_paper_ids=[p1])

        updated = update_note(
            self.conn,
            note.id or 0,
            body=f"See [Paper B](paper://{p2})",
        )
        self.conn.commit()

        self.assertEqual(updated.linked_paper_ids, [p1, p2])
        self.assertEqual(updated.manual_paper_ids, [p1])
        self.assertEqual(updated.mentioned_paper_ids, [p2])

    def test_update_manual_links_touches_timestamp_and_sorting(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper(external_id="10.1/a", title="Paper A"))
        older = create_note(
            self.conn,
            title="Older",
            body="Body",
            created_at=datetime(2000, 1, 1, 12, 0, 0),
        )
        newer = create_note(
            self.conn,
            title="Newer",
            body="Body",
            created_at=datetime(2000, 1, 2, 12, 0, 0),
        )

        self.assertEqual([note.id for note in list_notes(self.conn, limit=2)], [newer.id, older.id])

        updated = update_note(self.conn, older.id or 0, manual_paper_ids=[paper_id])
        self.conn.commit()

        self.assertEqual(updated.manual_paper_ids, [paper_id])
        self.assertGreater(updated.updated_at, older.updated_at)
        self.assertEqual([note.id for note in list_notes(self.conn, limit=2)], [older.id, newer.id])

    def test_unlink_manual_paper_keeps_mentioned_link(self) -> None:
        p1 = upsert_paper(self.conn, make_paper(external_id="10.1/a"))
        note = create_note(
            self.conn,
            title="Both",
            body=f"See [Paper](paper://{p1})",
            manual_paper_ids=[p1],
        )

        updated = unlink_note_paper(self.conn, note.id or 0, p1)
        self.conn.commit()

        self.assertEqual(updated.linked_paper_ids, [p1])
        self.assertEqual(updated.manual_paper_ids, [])
        self.assertEqual(updated.mentioned_paper_ids, [p1])

    def test_delete_note_cascades_join_rows(self) -> None:
        p1 = upsert_paper(self.conn, make_paper())
        note = create_note(self.conn, title="Delete me", body="Body", manual_paper_ids=[p1])

        delete_note(self.conn, note.id or 0)
        self.conn.commit()

        self.assertIsNone(get_note(self.conn, note.id or 0))
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM note_papers").fetchone()[0],
            0,
        )

    def test_search_notes_uses_fts(self) -> None:
        create_note(self.conn, title="Chromatin note", body="nucleosome remodeling")
        self.conn.commit()

        matches = search_notes(self.conn, "nucleosomes remodel")

        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0].title, "Chromatin note")

    def test_wikilinks_sync_resolved_unresolved_heading_alias_and_ignored_source(self) -> None:
        target = create_note(
            self.conn,
            title="Target Note",
            body="# Known Heading\n\nBody",
        )
        source = create_note(
            self.conn,
            title="Source",
            body=(
                "See [[Target Note|friendly alias]] and [[Target Note#Known Heading]].\n"
                "Broken [[Target Note#Missing Heading|bad heading]] and [[Missing Note]].\n"
                "`[[Target Note]]`\n"
                "$[[Target Note]]$\n"
                "```mermaid\n"
                "graph TD\n"
                "  A[[Target Note]] --> B\n"
                "```\n"
                "\\([[Target Note]]\\)\n"
                "\\[[[Target Note]]\\]\n"
                "```excalidraw asset://123\n"
                "[[Target Note]]\n"
                "```\n"
            ),
        )
        self.conn.commit()

        rows = self.conn.execute(
            """
            SELECT target_note_id, raw_target_title, heading_fragment, alias, status
            FROM note_links
            WHERE source_note_id=?
            ORDER BY position ASC
            """,
            (source.id,),
        ).fetchall()

        self.assertEqual(len(rows), 4)
        self.assertEqual(rows[0]["target_note_id"], target.id)
        self.assertEqual(rows[0]["raw_target_title"], "Target Note")
        self.assertEqual(rows[0]["alias"], "friendly alias")
        self.assertEqual(rows[0]["status"], "resolved")
        self.assertEqual(rows[1]["heading_fragment"], "Known Heading")
        self.assertEqual(rows[1]["status"], "resolved")
        self.assertEqual(rows[2]["target_note_id"], target.id)
        self.assertEqual(rows[2]["heading_fragment"], "Missing Heading")
        self.assertEqual(rows[2]["alias"], "bad heading")
        self.assertEqual(rows[2]["status"], "missing_heading")
        self.assertIsNone(rows[3]["target_note_id"])
        self.assertEqual(rows[3]["raw_target_title"], "Missing Note")
        self.assertEqual(rows[3]["status"], "unresolved")

    def test_note_links_ignore_self_links_for_wikilink_and_canonical_syntax(self) -> None:
        source = create_note(self.conn, title="Self Source", body="Initial")
        update_note(
            self.conn,
            source.id or 0,
            body=f"Legacy [[Self Source]] and canonical [@Self Source](note://{source.id}).",
        )
        self.conn.commit()

        count = self.conn.execute(
            "SELECT COUNT(*) FROM note_links WHERE source_note_id=?",
            (source.id,),
        ).fetchone()[0]
        self.assertEqual(count, 0)

    def test_id_backed_note_links_resolve_by_id_with_heading_validation(self) -> None:
        target = create_note(
            self.conn,
            title="Target Note",
            body="# Known Heading\n\nTarget body",
        )
        source = create_note(
            self.conn,
            title="Source",
            body=(
                f"See [@Target Note](note://{target.id}) and "
                f"[@Target Note > Known Heading](note://{target.id}#Known%20Heading). "
                f"Broken [@Target Note > Missing Heading](note://{target.id}#Missing%20Heading)."
            ),
        )
        timestamp = datetime(2026, 1, 1, 12, 0, 0).isoformat()
        self.conn.execute(
            """
            INSERT INTO notes (title, normalized_title, body, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            ("Target Note", "target note", "Duplicate title", timestamp, timestamp),
        )

        update_note(self.conn, source.id or 0, body=source.body)
        self.conn.commit()

        rows = self.conn.execute(
            """
            SELECT target_note_id, raw_target_title, normalized_target_title, heading_fragment, status
            FROM note_links
            WHERE source_note_id=?
            ORDER BY position ASC
            """,
            (source.id,),
        ).fetchall()

        self.assertEqual(len(rows), 3)
        self.assertEqual([row["target_note_id"] for row in rows], [target.id, target.id, target.id])
        self.assertEqual([row["raw_target_title"] for row in rows], ["Target Note", "Target Note", "Target Note"])
        self.assertEqual([row["normalized_target_title"] for row in rows], ["target note", "target note", "target note"])
        self.assertEqual(rows[1]["heading_fragment"], "Known Heading")
        self.assertEqual([row["status"] for row in rows], ["resolved", "resolved", "missing_heading"])

    def test_resolved_wikilinks_are_canonicalized_to_id_backed_markdown(self) -> None:
        target = create_note(
            self.conn,
            title="Target Note",
            body="# Known Heading\n\nTarget body",
        )
        source = create_note(
            self.conn,
            title="Source",
            body=(
                "See [[Target Note]] and [[Target Note#Known Heading]]. "
                "Alias [[Target Note|friendly alias]]. Missing [[Missing Note]]."
            ),
        )
        self.conn.commit()

        stored_source = get_note(self.conn, source.id or 0)
        self.assertIsNotNone(stored_source)
        self.assertIn(f"[@Target Note](note://{target.id})", stored_source.body)
        self.assertIn(f"[@Target Note > Known Heading](note://{target.id}#Known%20Heading)", stored_source.body)
        self.assertIn(f"[friendly alias](note://{target.id})", stored_source.body)
        self.assertIn("[[Missing Note]]", stored_source.body)

        alias_row = self.conn.execute(
            """
            SELECT target_note_id, raw_target_title, alias, status
            FROM note_links
            WHERE source_note_id=? AND alias='friendly alias'
            """,
            (source.id,),
        ).fetchone()
        self.assertIsNotNone(alias_row)
        self.assertEqual(alias_row["target_note_id"], target.id)
        self.assertEqual(alias_row["raw_target_title"], "Target Note")
        self.assertEqual(alias_row["status"], "resolved")

    def test_canonical_note_links_escape_markdown_label_syntax(self) -> None:
        target_title = "Target ] \\ Note"
        alias = "alias ] \\ label"
        target = create_note(self.conn, title=target_title, body="Target body")
        source = create_note(
            self.conn,
            title="Source",
            body=f"See [[{target_title}]] and [[{target_title}|{alias}]].",
        )
        self.conn.commit()

        stored_source = get_note(self.conn, source.id or 0)
        self.assertIsNotNone(stored_source)
        self.assertIn(f"[@Target \\] \\\\ Note](note://{target.id})", stored_source.body)
        self.assertIn(f"[alias \\] \\\\ label](note://{target.id})", stored_source.body)

        update_note(self.conn, source.id or 0, body=stored_source.body)
        self.conn.commit()

        rows = self.conn.execute(
            """
            SELECT target_note_id, raw_target_title, alias, status
            FROM note_links
            WHERE source_note_id=?
            ORDER BY position ASC
            """,
            (source.id,),
        ).fetchall()

        self.assertEqual(len(rows), 2)
        self.assertEqual([row["target_note_id"] for row in rows], [target.id, target.id])
        self.assertEqual([row["raw_target_title"] for row in rows], [target_title, target_title])
        self.assertIsNone(rows[0]["alias"])
        self.assertEqual(rows[1]["alias"], alias)
        self.assertEqual([row["status"] for row in rows], ["resolved", "resolved"])

    def test_canonical_note_links_escape_heading_labels(self) -> None:
        target_title = "Target Note"
        heading = "Method ] \\ Heading"
        target = create_note(self.conn, title=target_title, body=f"# {heading}\n\nTarget body")
        source = create_note(
            self.conn,
            title="Source",
            body=f"See [[{target_title}#{heading}]].",
        )
        self.conn.commit()

        stored_source = get_note(self.conn, source.id or 0)
        self.assertIsNotNone(stored_source)
        self.assertIn(
            f"[@Target Note > Method \\] \\\\ Heading](note://{target.id}#{quote(heading, safe='')})",
            stored_source.body,
        )

        update_note(self.conn, source.id or 0, body=stored_source.body)
        self.conn.commit()

        row = self.conn.execute(
            """
            SELECT target_note_id, heading_fragment, status
            FROM note_links
            WHERE source_note_id=?
            """,
            (source.id,),
        ).fetchone()

        self.assertEqual(row["target_note_id"], target.id)
        self.assertEqual(row["heading_fragment"], heading)
        self.assertEqual(row["status"], "resolved")

    def test_duplicate_normalized_note_titles_are_rejected_for_create_and_rename(self) -> None:
        create_note(self.conn, title="Alpha   Note", body="Body")
        other = create_note(self.conn, title="Other", body="Body")

        with self.assertRaisesRegex(ValueError, "Note title already exists"):
            create_note(self.conn, title="alpha note", body="Body")

        with self.assertRaisesRegex(ValueError, "Note title already exists"):
            update_note(self.conn, other.id or 0, title="ALPHA NOTE")

    def test_existing_duplicate_titles_make_wikilinks_ambiguous_until_renamed(self) -> None:
        timestamp = datetime(2026, 1, 1, 12, 0, 0).isoformat()
        self.conn.execute(
            """
            INSERT INTO notes (title, normalized_title, body, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            ("Duplicate", "duplicate", "First", timestamp, timestamp),
        )
        self.conn.execute(
            """
            INSERT INTO notes (title, normalized_title, body, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            ("duplicate", "duplicate", "Second", timestamp, timestamp),
        )

        source = create_note(self.conn, title="Source", body="[[Duplicate]]")
        self.conn.commit()

        row = self.conn.execute(
            "SELECT target_note_id, status FROM note_links WHERE source_note_id=?",
            (source.id,),
        ).fetchone()
        self.assertIsNone(row["target_note_id"])
        self.assertEqual(row["status"], "ambiguous")

    def test_note_rename_rewrites_resolved_inbound_wikilinks_preserving_heading_and_alias(self) -> None:
        target = create_note(self.conn, title="Old Title", body="# Heading\n\nTarget")
        source = create_note(
            self.conn,
            title="Source",
            body="See [[Old Title#Heading|kept alias]] and [[Unresolved Old Title]].",
        )

        update_note(self.conn, target.id or 0, title="New Title")
        self.conn.commit()

        stored_source = get_note(self.conn, source.id or 0)
        self.assertIsNotNone(stored_source)
        self.assertIn(f"[kept alias](note://{target.id}#Heading)", stored_source.body)
        self.assertIn("[[Unresolved Old Title]]", stored_source.body)
        rows = self.conn.execute(
            """
            SELECT target_note_id, raw_target_title, normalized_target_title, heading_fragment, alias, status
            FROM note_links
            WHERE source_note_id=?
            ORDER BY position ASC
            """,
            (source.id,),
        ).fetchall()
        self.assertEqual(rows[0]["target_note_id"], target.id)
        self.assertEqual(rows[0]["raw_target_title"], "New Title")
        self.assertEqual(rows[0]["normalized_target_title"], "new title")
        self.assertEqual(rows[0]["heading_fragment"], "Heading")
        self.assertEqual(rows[0]["alias"], "kept alias")
        self.assertEqual(rows[0]["status"], "resolved")
        self.assertIsNone(rows[1]["target_note_id"])
        self.assertEqual(rows[1]["status"], "unresolved")

    def test_note_rename_refreshes_search_body_for_rewritten_wikilinks(self) -> None:
        target = create_note(self.conn, title="Alphazeta", body="Target")
        source = create_note(self.conn, title="Search source", body="See [[Alphazeta]].")

        update_note(self.conn, target.id or 0, title="Betazeta")
        self.conn.commit()

        stored_source = get_note(self.conn, source.id or 0)
        self.assertIsNotNone(stored_source)
        self.assertIn(f"[@Betazeta](note://{target.id})", stored_source.body)
        self.assertCountEqual([note.id for note in search_notes(self.conn, "Betazeta")], [source.id, target.id])
        self.assertEqual(search_notes(self.conn, "Alphazeta"), [])

    def test_note_rename_rewrites_inbound_wikilinks_when_only_display_title_changes(self) -> None:
        target = create_note(self.conn, title="Display Title", body="Target")
        source = create_note(self.conn, title="Source", body="[[Display Title]]")

        update_note(self.conn, target.id or 0, title="display title")
        self.conn.commit()

        stored_source = get_note(self.conn, source.id or 0)
        self.assertIsNotNone(stored_source)
        self.assertEqual(stored_source.body, f"[@display title](note://{target.id})")
        row = self.conn.execute(
            """
            SELECT target_note_id, raw_target_title, normalized_target_title, status
            FROM note_links
            WHERE source_note_id=?
            """,
            (source.id,),
        ).fetchone()
        self.assertEqual(row["target_note_id"], target.id)
        self.assertEqual(row["raw_target_title"], "display title")
        self.assertEqual(row["normalized_target_title"], "display title")
        self.assertEqual(row["status"], "resolved")

    def test_note_delete_refreshes_inbound_wikilinks_as_unresolved(self) -> None:
        target = create_note(self.conn, title="Delete Target", body="Body")
        source = create_note(self.conn, title="Source", body="[[Delete Target]]")

        delete_note(self.conn, target.id or 0)
        self.conn.commit()

        stored_source = get_note(self.conn, source.id or 0)
        row = self.conn.execute(
            "SELECT target_note_id, status FROM note_links WHERE source_note_id=?",
            (source.id,),
        ).fetchone()
        self.assertIsNotNone(stored_source)
        self.assertEqual(stored_source.body, f"[@Delete Target](note://{target.id})")
        self.assertIsNone(row["target_note_id"])
        self.assertEqual(row["status"], "missing_target")

    def test_note_references_include_outgoing_and_backlinks_only(self) -> None:
        target = create_note(self.conn, title="Reference Target", body="# Details\n\nTarget body")
        source = create_note(
            self.conn,
            title="Linked source",
            body="See [[Reference Target#Details|target alias]]. Missing [[Missing Target]].",
        )
        plain = create_note(
            self.conn,
            title="Plain source",
            body="Reference Target appears in prose.",
        )
        create_note(
            self.conn,
            title="Ignored source",
            body="`Reference Target` and $Reference Target$.",
        )
        self.conn.commit()

        target_refs = get_note_references(self.conn, target.id or 0)
        source_refs = get_note_references(self.conn, source.id or 0)

        self.assertEqual(len(source_refs.outgoing), 1)
        self.assertEqual(source_refs.outgoing[0].target_note_id, target.id)
        self.assertEqual(source_refs.outgoing[0].target_title, "Reference Target")
        self.assertEqual(source_refs.outgoing[0].heading_fragment, "Details")
        self.assertEqual(source_refs.outgoing[0].alias, "target alias")
        self.assertEqual(source_refs.outgoing[0].status.value, "resolved")
        self.assertEqual([item.source_note_id for item in target_refs.backlinks], [source.id])
        self.assertEqual(target_refs.backlinks[0].source_title, "Linked source")
        self.assertIn("target alias", target_refs.backlinks[0].source_preview)
        self.assertNotIn(plain.id, [item.source_note_id for item in target_refs.backlinks])
        self.assertNotIn("unlinked_mentions", target_refs.model_dump())

    def test_v36_migration_adds_normalized_titles_and_backfills_note_links(self) -> None:
        self.conn.close()
        db_path = os.path.join(self.tmpdir.name, "v36-upgrade.db")
        self.conn = make_conn(db_path)
        timestamp = datetime(2026, 1, 1, 12, 0, 0).isoformat()
        self.conn.executescript("""
            CREATE TABLE schema_version (
                version INTEGER PRIMARY KEY
            );
            INSERT INTO schema_version (version) VALUES (36);
            CREATE TABLE notes (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                title      TEXT NOT NULL,
                body       TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
        """)
        self.conn.executemany(
            """
            INSERT INTO notes (id, title, body, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            [
                (1, "Target", "# Known\n\nBody", timestamp, timestamp),
                (2, "Source", "See [[Target#Known]] and [[Missing]].", timestamp, timestamp),
                (3, "Duplicate", "First duplicate", timestamp, timestamp),
                (4, "duplicate", "Second duplicate", timestamp, timestamp),
                (5, "Ambiguous source", "[[Duplicate]]", timestamp, timestamp),
            ],
        )
        self.conn.commit()

        init_db(self.conn)

        version = self.conn.execute(
            "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
        ).fetchone()[0]
        note_columns = {
            row["name"]
            for row in self.conn.execute("PRAGMA table_info(notes)").fetchall()
        }
        source_rows = self.conn.execute(
            """
            SELECT target_note_id, raw_target_title, heading_fragment, status
            FROM note_links
            WHERE source_note_id=2
            ORDER BY position ASC
            """
        ).fetchall()
        ambiguous_row = self.conn.execute(
            "SELECT target_note_id, status FROM note_links WHERE source_note_id=5"
        ).fetchone()

        self.assertEqual(version, SCHEMA_VERSION)
        self.assertIn("normalized_title", note_columns)
        self.assertIn("search_body", note_columns)
        self.assertEqual(source_rows[0]["target_note_id"], 1)
        self.assertEqual(source_rows[0]["raw_target_title"], "Target")
        self.assertEqual(source_rows[0]["heading_fragment"], "Known")
        self.assertEqual(source_rows[0]["status"], "resolved")
        self.assertIsNone(source_rows[1]["target_note_id"])
        self.assertEqual(source_rows[1]["status"], "unresolved")
        self.assertIsNone(ambiguous_row["target_note_id"])
        self.assertEqual(ambiguous_row["status"], "ambiguous")
        self.assertCountEqual([note.id for note in search_notes(self.conn, "Known")], [1, 2])

    def test_current_version_repairs_missing_note_title_schema(self) -> None:
        self.conn.close()
        db_path = os.path.join(self.tmpdir.name, "current-version-note-drift.db")
        self.conn = make_conn(db_path)
        timestamp = datetime(2026, 1, 1, 12, 0, 0).isoformat()
        self.conn.executescript(f"""
            CREATE TABLE schema_version (
                version INTEGER PRIMARY KEY
            );
            INSERT INTO schema_version (version) VALUES ({SCHEMA_VERSION});
            CREATE TABLE notes (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                title      TEXT NOT NULL,
                body       TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
        """)
        self.conn.executemany(
            """
            INSERT INTO notes (id, title, body, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            [
                (1, "Target Note", "# Known\n\nBody", timestamp, timestamp),
                (2, "Source Note", "See [[Target Note#Known]].", timestamp, timestamp),
            ],
        )
        self.conn.commit()

        init_db(self.conn)

        note_columns = {
            row["name"]
            for row in self.conn.execute("PRAGMA table_info(notes)").fetchall()
        }
        note_links_exists = self.conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='note_links'"
        ).fetchone()
        existing_row = self.conn.execute(
            "SELECT title, normalized_title FROM notes WHERE id=1"
        ).fetchone()
        link_row = self.conn.execute(
            """
            SELECT target_note_id, raw_target_title, heading_fragment, status
            FROM note_links
            WHERE source_note_id=2
            """
        ).fetchone()
        created = create_note(self.conn, title="Fresh Note", body="Created after repair")

        self.assertIn("normalized_title", note_columns)
        self.assertIn("search_body", note_columns)
        self.assertIsNotNone(note_links_exists)
        self.assertEqual(existing_row["normalized_title"], normalize_note_title_key(existing_row["title"]))
        self.assertEqual(link_row["target_note_id"], 1)
        self.assertEqual(link_row["raw_target_title"], "Target Note")
        self.assertEqual(link_row["heading_fragment"], "Known")
        self.assertEqual(link_row["status"], "resolved")
        self.assertIsNotNone(created.id)

    def _assert_missing_target_constraint_repaired_from_version(self, schema_version: int) -> None:
        target_title = "Delete Target"
        target = create_note(self.conn, title=target_title, body="Target body")
        source = create_note(
            self.conn,
            title="Source Note",
            body=f"See [@Delete Target](note://{target.id}).",
        )
        self.conn.commit()

        self.conn.executescript(f"""
            DROP INDEX IF EXISTS idx_note_links_source;
            DROP INDEX IF EXISTS idx_note_links_target;
            DROP INDEX IF EXISTS idx_note_links_normalized_target;
            ALTER TABLE note_links RENAME TO note_links_current;
            CREATE TABLE note_links (
                id                      INTEGER PRIMARY KEY AUTOINCREMENT,
                source_note_id          INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
                target_note_id          INTEGER REFERENCES notes(id) ON DELETE SET NULL,
                position                INTEGER NOT NULL DEFAULT 0,
                raw_target_title        TEXT NOT NULL,
                normalized_target_title TEXT NOT NULL,
                heading_fragment        TEXT,
                alias                   TEXT,
                status                  TEXT NOT NULL CHECK (
                    status IN ('resolved', 'unresolved', 'ambiguous', 'missing_heading')
                ),
                created_at              TEXT NOT NULL,
                updated_at              TEXT NOT NULL
            );
            INSERT INTO note_links (
                id, source_note_id, target_note_id, position, raw_target_title,
                normalized_target_title, heading_fragment, alias, status,
                created_at, updated_at
            )
            SELECT
                id, source_note_id, target_note_id, position, raw_target_title,
                normalized_target_title, heading_fragment, alias, status,
                created_at, updated_at
            FROM note_links_current;
            DROP TABLE note_links_current;
            DELETE FROM schema_version;
            INSERT INTO schema_version (version) VALUES ({schema_version});
        """)
        self.conn.commit()

        init_db(self.conn)
        delete_note(self.conn, target.id or 0)
        self.conn.commit()

        version = self.conn.execute(
            "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
        ).fetchone()[0]
        note_links_sql = self.conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='note_links'"
        ).fetchone()["sql"]
        link_row = self.conn.execute(
            "SELECT target_note_id, status FROM note_links WHERE source_note_id=?",
            (source.id,),
        ).fetchone()
        stored_source = get_note(self.conn, source.id or 0)

        self.assertEqual(version, SCHEMA_VERSION)
        self.assertIn("missing_target", note_links_sql)
        self.assertIsNotNone(stored_source)
        self.assertIsNone(link_row["target_note_id"])
        self.assertEqual(link_row["status"], "missing_target")

    def test_v41_migration_repairs_v40_missing_target_status_constraint(self) -> None:
        self._assert_missing_target_constraint_repaired_from_version(40)

    def test_schema_drift_repairs_missing_target_constraint_at_current_version(self) -> None:
        self._assert_missing_target_constraint_repaired_from_version(SCHEMA_VERSION)

    def test_list_notes_paginates_more_than_100_global_notes(self) -> None:
        created_ids = [
            create_note(self.conn, title=f"Note {index}", body="Body").id
            for index in range(105)
        ]
        self.conn.commit()

        first_page = list_notes(self.conn, limit=100, offset=0)
        second_page = list_notes(self.conn, limit=100, offset=100)

        self.assertEqual(len(first_page), 100)
        self.assertEqual(len(second_page), 5)
        self.assertEqual(first_page[0].id, created_ids[-1])
        self.assertEqual(second_page[-1].id, created_ids[0])
        self.assertTrue({note.id for note in first_page}.isdisjoint({note.id for note in second_page}))

    def test_list_notes_paginates_more_than_100_paper_linked_notes(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        created_ids = [
            create_note(
                self.conn,
                title=f"Paper note {index}",
                body="Body",
                manual_paper_ids=[paper_id],
            ).id
            for index in range(105)
        ]
        self.conn.commit()

        first_page = list_notes(self.conn, paper_id=paper_id, limit=100, offset=0)
        second_page = list_notes(self.conn, paper_id=paper_id, limit=100, offset=100)

        self.assertEqual(len(first_page), 100)
        self.assertEqual(len(second_page), 5)
        self.assertEqual(first_page[0].id, created_ids[-1])
        self.assertEqual(second_page[-1].id, created_ids[0])
        self.assertTrue({note.id for note in first_page}.isdisjoint({note.id for note in second_page}))

    def test_legacy_paper_note_migrates_to_note_row(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper(title="Legacy Paper"))
        legacy_timestamp = "2026-04-24T09:30:00"
        self.conn.execute(
            "UPDATE papers SET note='Legacy markdown note', fetched_at=? WHERE id=?",
            (legacy_timestamp, paper_id),
        )
        self.conn.execute("DELETE FROM schema_version")
        self.conn.execute("INSERT INTO schema_version (version) VALUES (14)")
        self.conn.commit()

        init_db(self.conn)

        version = self.conn.execute(
            "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
        ).fetchone()[0]
        paper = get_paper(self.conn, paper_id)
        notes = list_notes(self.conn, paper_id=paper_id)
        raw_note_row = self.conn.execute("SELECT * FROM notes").fetchone()
        raw_link_row = self.conn.execute("SELECT * FROM note_papers").fetchone()
        raw_note = self.conn.execute("SELECT note FROM papers WHERE id=?", (paper_id,)).fetchone()[0]

        self.assertEqual(version, SCHEMA_VERSION)
        self.assertIsNone(raw_note)
        self.assertIsNotNone(paper)
        self.assertEqual(paper.note_count, 1)
        self.assertEqual(len(notes), 1)
        self.assertEqual(raw_note_row["title"], "Note on: Legacy Paper")
        self.assertEqual(notes[0].body, "Legacy markdown note")
        self.assertEqual(raw_note_row["created_at"], legacy_timestamp)
        self.assertEqual(raw_note_row["updated_at"], legacy_timestamp)
        self.assertEqual(raw_link_row["note_id"], raw_note_row["id"])
        self.assertEqual(raw_link_row["paper_id"], paper_id)
        self.assertEqual(raw_link_row["manual"], 1)
        self.assertEqual(raw_link_row["mentioned"], 0)
        self.assertEqual(raw_link_row["created_at"], legacy_timestamp)
        self.assertEqual(raw_link_row["updated_at"], legacy_timestamp)
        self.assertEqual(notes[0].linked_paper_ids, [paper_id])

    def test_duplicate_merge_rewrites_note_body_and_join_rows(self) -> None:
        duplicate_id = insert_raw_paper(
            self.conn,
            make_paper(source="biorxiv", external_id="10.1/preprint", title="A useful preprint"),
        )
        canonical_id = insert_raw_paper(
            self.conn,
            make_paper(source="pubmed", external_id="pmid:1", title="A useful preprint."),
        )
        note = create_note(
            self.conn,
            title="Duplicate link",
            body=f"Discuss [old](paper://{duplicate_id})",
            manual_paper_ids=[duplicate_id],
        )
        self.conn.commit()

        merge_title_duplicate_groups(self.conn)
        self.conn.commit()

        stored = get_note(self.conn, note.id or 0)
        self.assertIsNotNone(stored)
        self.assertEqual(stored.linked_paper_ids, [canonical_id])
        self.assertEqual(stored.mentioned_paper_ids, [canonical_id])
        self.assertIn(f"paper://{canonical_id}", stored.body)
        search_body = self.conn.execute(
            "SELECT search_body FROM notes WHERE id=?",
            (note.id,),
        ).fetchone()["search_body"]
        self.assertIn(f"paper://{canonical_id}", search_body)
        self.assertNotIn(f"paper://{duplicate_id}", search_body)
        self.assertIsNone(get_paper(self.conn, duplicate_id))


class NotesApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.conn = make_conn(os.path.join(self.tmpdir.name, "claudesk.db"))
        init_db(self.conn)

    def tearDown(self) -> None:
        self.conn.close()
        self.tmpdir.cleanup()

    def test_notes_crud_routes(self) -> None:
        created = notes_api.post_note(
            notes_api.NoteCreate(title="API note", body="Body"),
            conn=self.conn,
        )
        note_id = created["id"]

        fetched = notes_api.get_note_by_id(note_id, conn=self.conn)
        patched = notes_api.patch_note(
            note_id,
            notes_api.NoteUpdate(title="Updated", body="New body"),
            conn=self.conn,
        )
        deleted = notes_api.remove_note(note_id, conn=self.conn)

        self.assertEqual(fetched["title"], "API note")
        self.assertEqual(patched["title"], "Updated")
        self.assertEqual(deleted, {"ok": True})

    def test_patch_note_link_only_touches_timestamp(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        note = create_note(
            self.conn,
            title="API link-only note",
            body="Body",
            created_at=datetime(2000, 1, 1, 12, 0, 0),
        )
        before = notes_api.get_note_by_id(note.id or 0, conn=self.conn)

        patched = notes_api.patch_note(
            note.id or 0,
            notes_api.NoteUpdate(linked_paper_ids=[paper_id]),
            conn=self.conn,
        )

        self.assertEqual(patched["manual_paper_ids"], [paper_id])
        self.assertGreater(patched["updated_at"], before["updated_at"])

    def test_get_notes_by_paper_and_search_payload(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        note = create_note(
            self.conn,
            title="Searchable note",
            body="alpha beta",
            manual_paper_ids=[paper_id],
        )
        self.conn.commit()

        by_paper = notes_api.get_paper_notes(paper_id, conn=self.conn)
        payload = search_api.search("alpha", conn=self.conn)

        self.assertEqual([row["id"] for row in by_paper], [note.id])
        self.assertEqual(by_paper[0]["manual_paper_ids"], [paper_id])
        self.assertEqual(payload["notes"][0]["id"], note.id)

    def test_get_note_references_payload(self) -> None:
        target = create_note(self.conn, title="API target", body="Body")
        source = create_note(self.conn, title="API source", body="[[API target|api alias]]")
        self.conn.commit()

        payload = notes_api.get_note_reference_payload(target.id or 0, conn=self.conn)

        self.assertEqual(payload["outgoing"], [])
        self.assertEqual(payload["backlinks"][0]["source_note_id"], source.id)
        self.assertEqual(payload["backlinks"][0]["source_title"], "API source")
        self.assertEqual(payload["backlinks"][0]["alias"], "api alias")
        self.assertEqual(payload["backlinks"][0]["status"], "resolved")
        self.assertNotIn("unlinked_mentions", payload)


class NoteImageAssetApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.data_dir_ctx = patched_data_dir(self.tmpdir.name)
        self.data_dir_ctx.__enter__()
        load_config.cache_clear()
        self.conn = make_conn(os.path.join(self.tmpdir.name, "claudesk.db"))
        init_db(self.conn)

    def tearDown(self) -> None:
        self.conn.close()
        load_config.cache_clear()
        self.data_dir_ctx.__exit__(None, None, None)
        self.tmpdir.cleanup()

    def test_upload_note_image_stores_managed_asset_and_serves_asset_url(self) -> None:
        note = create_note(self.conn, title="Image note", body="Body")
        payload = b"\x89PNG\r\n\x1a\nlocal image"

        response = notes_api.upload_note_image(
            note.id or 0,
            file=FakeUpload(
                filename="../figure paste.png",
                content_type="image/png",
                content=payload,
            ),
            conn=self.conn,
        )

        asset_id = response.asset_id
        asset = get_asset(self.conn, asset_id)
        self.assertIsNotNone(asset)
        self.assertEqual(response.markdown_url, f"asset://{asset_id}")
        self.assertEqual(list_note_assets(self.conn, note.id or 0), [])
        status = self.conn.execute(
            "SELECT status FROM note_assets WHERE note_id=? AND asset_id=?",
            (note.id or 0, asset_id),
        ).fetchone()
        self.assertIsNotNone(status)
        self.assertEqual(status["status"], "staged")
        self.assertEqual(asset.mime_type, "image/png")
        self.assertFalse(Path(asset.managed_path or "").is_absolute())

        path = resolve_managed_asset_path(asset.managed_path or "", cfg=load_config())
        self.assertEqual(path.read_bytes(), payload)
        self.assertEqual(Path(asset.managed_path or "").parts[0], "images")

        file_response = notes_api.get_managed_markdown_asset_file(asset_id, conn=self.conn)
        self.assertEqual(file_response.media_type, "image/png")
        self.assertEqual(Path(file_response.path).read_bytes(), payload)
        self.assertIn("inline", file_response.headers["content-disposition"])

        update_note(self.conn, note.id or 0, body=f"![1.00]({response.markdown_url})")
        self.assertEqual(list_note_assets(self.conn, note.id or 0)[0].id, asset_id)
        committed_status = self.conn.execute(
            "SELECT status FROM note_assets WHERE note_id=? AND asset_id=?",
            (note.id or 0, asset_id),
        ).fetchone()
        self.assertIsNotNone(committed_status)
        self.assertEqual(committed_status["status"], "committed")

    def test_same_body_note_save_preserves_staged_uploaded_image(self) -> None:
        note = create_note(self.conn, title="Staged image note", body="Body")
        response = notes_api.upload_note_image(
            note.id or 0,
            file=FakeUpload(
                filename="staged.png",
                content_type="image/png",
                content=b"staged image",
            ),
            conn=self.conn,
        )
        asset = get_asset(self.conn, response.asset_id)
        self.assertIsNotNone(asset)
        path = resolve_managed_asset_path(asset.managed_path or "", cfg=load_config())
        self.assertTrue(path.exists())

        update_note(self.conn, note.id or 0, body="Body")

        self.assertIsNotNone(get_asset(self.conn, response.asset_id))
        self.assertTrue(path.exists())
        self.assertEqual(list_note_assets(self.conn, note.id or 0), [])
        status = self.conn.execute(
            "SELECT status FROM note_assets WHERE note_id=? AND asset_id=?",
            (note.id or 0, response.asset_id),
        ).fetchone()
        self.assertIsNotNone(status)
        self.assertEqual(status["status"], "staged")

    def test_remove_staged_note_image_deletes_uncommitted_asset(self) -> None:
        note = create_note(self.conn, title="Abandoned image note", body="Body")
        response = notes_api.upload_note_image(
            note.id or 0,
            file=FakeUpload(
                filename="abandoned.png",
                content_type="image/png",
                content=b"abandoned image",
            ),
            conn=self.conn,
        )
        asset = get_asset(self.conn, response.asset_id)
        self.assertIsNotNone(asset)
        path = resolve_managed_asset_path(asset.managed_path or "", cfg=load_config())
        self.assertTrue(path.exists())

        result = notes_api.remove_staged_note_image(note.id or 0, response.asset_id, conn=self.conn)

        self.assertEqual(result, {"ok": True})
        self.assertIsNone(get_asset(self.conn, response.asset_id))
        self.assertFalse(path.exists())
        self.assertEqual(list_note_assets(self.conn, note.id or 0), [])

    def test_direct_delete_note_removes_orphaned_image_asset_and_file(self) -> None:
        note = create_note(self.conn, title="Delete image note", body="Body")
        response = notes_api.upload_note_image(
            note.id or 0,
            file=FakeUpload(
                filename="delete-me.webp",
                content_type="image/webp",
                content=b"webp image",
            ),
            conn=self.conn,
        )
        asset = get_asset(self.conn, response.asset_id)
        self.assertIsNotNone(asset)
        path = resolve_managed_asset_path(asset.managed_path or "", cfg=load_config())
        self.assertTrue(path.exists())

        delete_note(self.conn, note.id or 0)

        self.assertIsNone(get_asset(self.conn, response.asset_id))
        self.assertFalse(path.exists())

    def test_shared_note_image_survives_original_note_delete_until_last_reference_removed(self) -> None:
        first = create_note(self.conn, title="First image note", body="Body")
        second = create_note(self.conn, title="Second image note", body="Body")
        response = notes_api.upload_note_image(
            first.id or 0,
            file=FakeUpload(
                filename="shared.png",
                content_type="image/png",
                content=b"shared image",
            ),
            conn=self.conn,
        )
        asset = get_asset(self.conn, response.asset_id)
        self.assertIsNotNone(asset)
        path = resolve_managed_asset_path(asset.managed_path or "", cfg=load_config())

        update_note(self.conn, first.id or 0, body=f"![1.00]({response.markdown_url})")
        update_note(self.conn, second.id or 0, body=f"Reused: ![1.00]({response.markdown_url})")
        self.assertEqual({item.id for item in list_note_assets(self.conn, first.id or 0)}, {response.asset_id})
        self.assertEqual({item.id for item in list_note_assets(self.conn, second.id or 0)}, {response.asset_id})

        notes_api.remove_note(first.id or 0, conn=self.conn)

        self.assertIsNotNone(get_asset(self.conn, response.asset_id))
        self.assertTrue(path.exists())
        file_response = notes_api.get_managed_markdown_asset_file(response.asset_id, conn=self.conn)
        self.assertEqual(Path(file_response.path).read_bytes(), b"shared image")

        notes_api.remove_note(second.id or 0, conn=self.conn)

        self.assertIsNone(get_asset(self.conn, response.asset_id))
        self.assertFalse(path.exists())

    def test_direct_note_update_removes_unreferenced_image_asset_and_file(self) -> None:
        note = create_note(self.conn, title="Remove image ref", body="Body")
        response = notes_api.upload_note_image(
            note.id or 0,
            file=FakeUpload(
                filename="remove-me.jpg",
                content_type="image/jpeg",
                content=b"jpeg image",
            ),
            conn=self.conn,
        )
        update_note(self.conn, note.id or 0, body=f"![1.00]({response.markdown_url})")
        asset = get_asset(self.conn, response.asset_id)
        self.assertIsNotNone(asset)
        path = resolve_managed_asset_path(asset.managed_path or "", cfg=load_config())
        self.assertTrue(path.exists())

        update_note(self.conn, note.id or 0, body="Image removed.")

        self.assertEqual(list_note_assets(self.conn, note.id or 0), [])
        self.assertIsNone(get_asset(self.conn, response.asset_id))
        self.assertFalse(path.exists())


class NoteDrawingAssetApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.data_dir_ctx = patched_data_dir(self.tmpdir.name)
        self.data_dir_ctx.__enter__()
        load_config.cache_clear()
        self.conn = make_conn(os.path.join(self.tmpdir.name, "claudesk.db"))
        init_db(self.conn)

    def tearDown(self) -> None:
        self.conn.close()
        load_config.cache_clear()
        self.data_dir_ctx.__exit__(None, None, None)
        self.tmpdir.cleanup()

    def test_create_note_drawing_stores_staged_asset_and_commits_from_fence(self) -> None:
        note = create_note(self.conn, title="Drawing note", body="Body")
        scene = {
            "type": "excalidraw",
            "elements": [{"id": "text-1", "type": "text", "text": "Alpha"}],
            "appState": {"viewBackgroundColor": "#ffffff"},
            "files": {},
        }

        response = notes_api.create_note_drawing(
            note.id or 0,
            notes_api.NoteDrawingCreate(scene=scene, display_name="../Sketch"),
            conn=self.conn,
        )

        asset_id = response.asset_id
        asset = get_asset(self.conn, asset_id)
        self.assertIsNotNone(asset)
        self.assertEqual(response.markdown, f"```excalidraw asset://{asset_id}\n```")
        self.assertEqual(response.scene, scene)
        self.assertEqual(asset.source, "note_excalidraw")
        self.assertEqual(asset.mime_type, "application/json")
        self.assertEqual(asset.original_filename, "Sketch.excalidraw.json")
        self.assertFalse(Path(asset.managed_path or "").is_absolute())
        self.assertEqual(Path(asset.managed_path or "").parts[0], "drawings")
        self.assertEqual(list_note_assets(self.conn, note.id or 0), [])
        status = self.conn.execute(
            "SELECT status FROM note_assets WHERE note_id=? AND asset_id=?",
            (note.id or 0, asset_id),
        ).fetchone()
        self.assertIsNotNone(status)
        self.assertEqual(status["status"], "staged")

        path = resolve_managed_asset_path(asset.managed_path or "", cfg=load_config())
        self.assertEqual(json.loads(path.read_text()), scene)
        read_response = notes_api.get_note_drawing(asset_id, conn=self.conn)
        self.assertEqual(read_response.scene, scene)
        file_response = notes_api.export_note_drawing_source(asset_id, conn=self.conn)
        self.assertEqual(file_response.media_type, "application/json")
        self.assertIn("attachment", file_response.headers["content-disposition"])

        update_note(self.conn, note.id or 0, body=f"{response.markdown}\n")

        self.assertEqual({item.id for item in list_note_assets(self.conn, note.id or 0)}, {asset_id})
        committed_status = self.conn.execute(
            "SELECT status FROM note_assets WHERE note_id=? AND asset_id=?",
            (note.id or 0, asset_id),
        ).fetchone()
        self.assertIsNotNone(committed_status)
        self.assertEqual(committed_status["status"], "committed")

    def test_update_note_drawing_rewrites_managed_json_and_metadata(self) -> None:
        note = create_note(self.conn, title="Editable drawing note", body="Body")
        response = notes_api.create_note_drawing(
            note.id or 0,
            notes_api.NoteDrawingCreate(scene={"elements": []}, display_name="Original"),
            conn=self.conn,
        )
        asset = get_asset(self.conn, response.asset_id)
        self.assertIsNotNone(asset)
        path = resolve_managed_asset_path(asset.managed_path or "", cfg=load_config())
        old_hash = asset.content_hash
        next_scene = {"elements": [{"id": "box-1", "type": "rectangle"}], "files": {}}

        updated = notes_api.update_note_drawing(
            response.asset_id,
            notes_api.NoteDrawingUpdate(scene=next_scene, display_name="Updated drawing"),
            conn=self.conn,
        )

        self.assertEqual(updated.scene, next_scene)
        self.assertEqual(updated.display_name, "Updated drawing")
        self.assertEqual(json.loads(path.read_text()), next_scene)
        latest = get_asset(self.conn, response.asset_id)
        self.assertIsNotNone(latest)
        self.assertNotEqual(latest.content_hash, old_hash)
        self.assertEqual(latest.display_name, "Updated drawing")

    def test_search_notes_indexes_committed_excalidraw_text_labels(self) -> None:
        note = create_note(self.conn, title="Search drawing labels", body="Body")
        response = notes_api.create_note_drawing(
            note.id or 0,
            notes_api.NoteDrawingCreate(
                scene={
                    "elements": [
                        {"id": "label-1", "type": "text", "text": "Spectral phase gate"},
                        {"id": "deleted-label", "type": "text", "text": "Ghost label", "isDeleted": True},
                    ],
                    "files": {},
                },
                display_name="Searchable drawing",
            ),
            conn=self.conn,
        )
        update_note(self.conn, note.id or 0, body=response.markdown)
        self.conn.commit()

        stored_note = get_note(self.conn, note.id or 0)
        self.assertIsNotNone(stored_note)
        self.assertNotIn("Spectral phase gate", stored_note.body)
        self.assertEqual([match.id for match in search_notes(self.conn, "spectral phase")], [note.id])
        self.assertEqual(search_notes(self.conn, "ghost label"), [])

        payload = search_api.search("spectral phase", result_type=["notes"], conn=self.conn)
        self.assertEqual(payload["notes"][0]["id"], note.id)
        self.assertNotIn("search_body", payload["notes"][0])

    def test_nested_excalidraw_fences_do_not_commit_assets_or_index_labels(self) -> None:
        note = create_note(self.conn, title="Nested drawing source", body="Body")
        response = notes_api.create_note_drawing(
            note.id or 0,
            notes_api.NoteDrawingCreate(
                scene={
                    "elements": [{"id": "label-1", "type": "text", "text": "Spectrogramneedle"}],
                    "files": {},
                },
                display_name="Nested source",
            ),
            conn=self.conn,
        )

        update_note(
            self.conn,
            note.id or 0,
            body="\n".join([
                "> ```excalidraw asset://{asset_id}",
                "> ```",
                "",
                "- Listed drawing",
                "",
                "  ```excalidraw asset://{asset_id}",
                "  ```",
                "",
                "```text",
                "```not-a-close",
                "```excalidraw asset://{asset_id}",
                "```",
                "```",
            ]).format(asset_id=response.asset_id),
        )
        self.conn.commit()

        self.assertEqual(list_note_assets(self.conn, note.id or 0), [])
        self.assertEqual(search_notes(self.conn, "Spectrogramneedle"), [])

    def test_update_note_drawing_refreshes_committed_note_search_text(self) -> None:
        note = create_note(self.conn, title="Updated drawing search", body="Body")
        response = notes_api.create_note_drawing(
            note.id or 0,
            notes_api.NoteDrawingCreate(
                scene={"elements": [{"id": "label-1", "type": "text", "text": "Initial label"}]},
                display_name="Original",
            ),
            conn=self.conn,
        )
        update_note(self.conn, note.id or 0, body=response.markdown)
        self.conn.commit()
        self.assertEqual([match.id for match in search_notes(self.conn, "initial label")], [note.id])

        notes_api.update_note_drawing(
            response.asset_id,
            notes_api.NoteDrawingUpdate(
                scene={"elements": [{"id": "label-2", "type": "text", "text": "Updated flow field"}]},
            ),
            conn=self.conn,
        )

        self.assertEqual([match.id for match in search_notes(self.conn, "updated flow")], [note.id])
        self.assertEqual(search_notes(self.conn, "initial label"), [])

    def test_update_note_drawing_rejects_blank_display_name_before_file_write(self) -> None:
        note = create_note(self.conn, title="Invalid drawing update note", body="Body")
        response = notes_api.create_note_drawing(
            note.id or 0,
            notes_api.NoteDrawingCreate(scene={"elements": []}, display_name="Original"),
            conn=self.conn,
        )
        asset = get_asset(self.conn, response.asset_id)
        self.assertIsNotNone(asset)
        path = resolve_managed_asset_path(asset.managed_path or "", cfg=load_config())
        original_payload = path.read_bytes()

        with self.assertRaises(notes_api.HTTPException) as ctx:
            notes_api.update_note_drawing(
                response.asset_id,
                notes_api.NoteDrawingUpdate(scene={"elements": [{"id": "changed"}]}, display_name=" "),
                conn=self.conn,
            )

        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(path.read_bytes(), original_payload)

    def test_remove_staged_note_drawing_deletes_uncommitted_asset(self) -> None:
        note = create_note(self.conn, title="Abandoned drawing note", body="Body")
        response = notes_api.create_note_drawing(
            note.id or 0,
            notes_api.NoteDrawingCreate(scene={"elements": []}, display_name="Abandoned"),
            conn=self.conn,
        )
        asset = get_asset(self.conn, response.asset_id)
        self.assertIsNotNone(asset)
        path = resolve_managed_asset_path(asset.managed_path or "", cfg=load_config())
        self.assertTrue(path.exists())

        result = notes_api.remove_staged_note_drawing(note.id or 0, response.asset_id, conn=self.conn)

        self.assertEqual(result, {"ok": True})
        self.assertIsNone(get_asset(self.conn, response.asset_id))
        self.assertFalse(path.exists())
        self.assertEqual(list_note_assets(self.conn, note.id or 0), [])

    def test_drawing_asset_commits_only_from_excalidraw_fence(self) -> None:
        note = create_note(self.conn, title="Fence-only drawing note", body="Body")
        response = notes_api.create_note_drawing(
            note.id or 0,
            notes_api.NoteDrawingCreate(scene={"elements": []}, display_name="Fence only"),
            conn=self.conn,
        )

        update_note(self.conn, note.id or 0, body=f"Plain asset://{response.asset_id}")

        self.assertEqual(list_note_assets(self.conn, note.id or 0), [])
        status = self.conn.execute(
            "SELECT status FROM note_assets WHERE note_id=? AND asset_id=?",
            (note.id or 0, response.asset_id),
        ).fetchone()
        self.assertIsNotNone(status)
        self.assertEqual(status["status"], "staged")

    def test_direct_note_update_removes_unreferenced_drawing_asset_and_file(self) -> None:
        note = create_note(self.conn, title="Remove drawing ref", body="Body")
        response = notes_api.create_note_drawing(
            note.id or 0,
            notes_api.NoteDrawingCreate(scene={"elements": []}, display_name="Remove me"),
            conn=self.conn,
        )
        update_note(self.conn, note.id or 0, body=response.markdown)
        asset = get_asset(self.conn, response.asset_id)
        self.assertIsNotNone(asset)
        path = resolve_managed_asset_path(asset.managed_path or "", cfg=load_config())
        self.assertTrue(path.exists())

        update_note(self.conn, note.id or 0, body="Drawing removed.")

        self.assertEqual(list_note_assets(self.conn, note.id or 0), [])
        self.assertIsNone(get_asset(self.conn, response.asset_id))
        self.assertFalse(path.exists())

    def test_shared_note_drawing_survives_until_last_reference_removed(self) -> None:
        first = create_note(self.conn, title="First drawing note", body="Body")
        second = create_note(self.conn, title="Second drawing note", body="Body")
        response = notes_api.create_note_drawing(
            first.id or 0,
            notes_api.NoteDrawingCreate(scene={"elements": [{"id": "shared"}]}, display_name="Shared"),
            conn=self.conn,
        )
        asset = get_asset(self.conn, response.asset_id)
        self.assertIsNotNone(asset)
        path = resolve_managed_asset_path(asset.managed_path or "", cfg=load_config())

        update_note(self.conn, first.id or 0, body=response.markdown)
        update_note(self.conn, second.id or 0, body=f"Reused:\n{response.markdown}")

        notes_api.remove_note(first.id or 0, conn=self.conn)

        self.assertIsNotNone(get_asset(self.conn, response.asset_id))
        self.assertTrue(path.exists())

        notes_api.remove_note(second.id or 0, conn=self.conn)

        self.assertIsNone(get_asset(self.conn, response.asset_id))
        self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
