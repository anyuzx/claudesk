from __future__ import annotations

import os
import json
import sqlite3
import tempfile
import unittest
from datetime import date, datetime, timezone

from claudesk.api import papers as papers_api
from claudesk.api import search as search_api
from claudesk.core.config import ChatRuntimeSettings, Config
from claudesk.core.db import (
    SCHEMA_VERSION,
    init_db,
)
from claudesk.core.db.chat import create_chat_session
from claudesk.core.db.papers import (
    count_papers,
    find_title_duplicate_groups,
    get_paper,
    list_papers,
    list_to_read_papers,
    merge_title_duplicate_groups,
    search_papers,
    update_paper_ranking,
    update_paper_status,
    upsert_paper,
)
from claudesk.core.db.notes import (
    create_note,
    list_notes,
)
from claudesk.core.models import Paper, PaperScoreRubric, PaperSignal, PaperStatus
from claudesk.core.paper_identity import normalize_paper_title_key
from claudesk.core.paper_status import apply_paper_signal
from claudesk.pipeline.dedupe import dedupe
from claudesk.pipeline.digest import write_digest


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
    abstract: str = "Example abstract",
    authors: list[str] | None = None,
    published_date: date = date(2026, 4, 24),
    journal_abbrev: str | None = None,
    url: str = "https://example.com/paper",
    status: PaperStatus = PaperStatus.NEW,
    is_saved: bool = False,
    is_read: bool = False,
    is_to_read: bool = False,
    fetched_at: datetime | None = None,
    to_read_at: datetime | None = None,
) -> Paper:
    kwargs = {}
    if fetched_at is not None:
        kwargs["fetched_at"] = fetched_at
    if to_read_at is not None:
        kwargs["to_read_at"] = to_read_at
    return Paper(
        source=source,
        external_id=external_id,
        title=title,
        abstract=abstract,
        authors=authors if authors is not None else ["Alice Example"],
        published_date=published_date,
        journal_abbrev=journal_abbrev,
        url=url,
        status=status,
        is_saved=is_saved,
        is_read=is_read,
        is_to_read=is_to_read,
        **kwargs,
    )


def insert_raw_paper(conn: sqlite3.Connection, paper: Paper, *, legacy_note: str | None = None) -> int:
    conn.execute(
        """
        INSERT INTO papers
            (source, external_id, title, abstract, authors, published_date,
             journal_abbrev, url, note, status, is_saved, is_read, is_to_read, to_read_at, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            legacy_note,
            paper.status.value,
            int(paper.is_saved),
            int(paper.is_read),
            int(paper.is_to_read),
            paper.to_read_at.isoformat() if paper.to_read_at is not None else None,
            paper.fetched_at.isoformat(),
        ),
    )
    return int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])


class PaperDedupeTests(unittest.TestCase):
    def test_title_key_ignores_trailing_period_case_and_whitespace(self) -> None:
        self.assertEqual(
            normalize_paper_title_key("  A Useful Preprint. "),
            normalize_paper_title_key("a useful preprint"),
        )

    def test_same_doi_with_different_case_is_deduped(self) -> None:
        papers = [
            make_paper(source="biorxiv", external_id="10.1234/ABC", title="First"),
            make_paper(source="openalex", external_id="10.1234/abc", title="Second"),
        ]

        deduped = dedupe(papers)

        self.assertEqual([paper.source for paper in deduped], ["openalex"])

    def test_doi_with_leading_and_trailing_whitespace_is_deduped(self) -> None:
        papers = [
            make_paper(source="biorxiv", external_id=" 10.1234/example "),
            make_paper(source="pubmed", external_id="10.1234/example", title="Other title"),
        ]

        deduped = dedupe(papers)

        self.assertEqual(len(deduped), 1)
        self.assertEqual(deduped[0].source, "pubmed")

    def test_doi_prefix_and_url_forms_are_deduped(self) -> None:
        papers = [
            make_paper(source="biorxiv", external_id="doi:10.1234/Example"),
            make_paper(source="openalex", external_id="https://doi.org/10.1234/example", title="Other title"),
        ]

        deduped = dedupe(papers)

        self.assertEqual(len(deduped), 1)
        self.assertEqual(deduped[0].source, "openalex")

    def test_non_doi_external_ids_are_unaffected(self) -> None:
        papers = [
            make_paper(source="arxiv", external_id="2401.12345", title="First title"),
            make_paper(source="pubmed", external_id="2401.12345", title="Second title"),
        ]

        deduped = dedupe(papers)

        self.assertEqual([paper.source for paper in deduped], ["arxiv", "pubmed"])

    def test_first_seen_source_wins_inside_one_batch(self) -> None:
        papers = [
            make_paper(source="pubmed", external_id="10.1234/example", title="First"),
            make_paper(source="biorxiv", external_id="10.1234/EXAMPLE", title="Second"),
        ]

        deduped = dedupe(papers)

        self.assertEqual([paper.source for paper in deduped], ["pubmed"])

    def test_title_with_trailing_period_is_deduped_inside_batch(self) -> None:
        papers = [
            make_paper(source="biorxiv", external_id="10.1234/preprint", title="A useful preprint"),
            make_paper(source="pubmed", external_id="pmid:123", title="A useful preprint."),
        ]

        deduped = dedupe(papers)

        self.assertEqual(len(deduped), 1)
        self.assertEqual(deduped[0].source, "pubmed")


class PaperDoiUpsertTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.conn = make_conn(os.path.join(self.tmpdir.name, "claudesk.db"))
        init_db(self.conn)

    def tearDown(self) -> None:
        self.conn.close()
        self.tmpdir.cleanup()

    def test_init_db_creates_digest_run_marker_schema(self) -> None:
        digest_columns = {
            row["name"]
            for row in self.conn.execute("PRAGMA table_info(digest_runs)").fetchall()
        }
        paper_columns = {
            row["name"]
            for row in self.conn.execute("PRAGMA table_info(papers)").fetchall()
        }
        paper_indexes = {
            row["name"]
            for row in self.conn.execute("PRAGMA index_list(papers)").fetchall()
        }

        self.assertEqual(
            {
                "id",
                "created_at",
                "days_back",
                "sources_json",
                "total_fetched",
                "total_after_dedup",
                "total_in_digest",
                "total_new_papers",
            },
            digest_columns,
        )
        self.assertIn("new_digest_run_id", paper_columns)
        self.assertIn("idx_papers_new_digest_run_id", paper_indexes)

    def test_count_papers_defaults_to_non_dismissed_rows(self) -> None:
        upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/active",
                title="Active count paper",
                status=PaperStatus.NEW,
            ),
        )
        upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/dismissed",
                title="Dismissed count paper",
                status=PaperStatus.DISMISSED,
            ),
        )

        self.assertEqual(count_papers(self.conn), 1)
        self.assertEqual(count_papers(self.conn, include_dismissed=True), 2)
        self.assertEqual(
            papers_api.get_paper_count(conn=self.conn)["total_papers"],
            1,
        )

    def test_existing_v19_database_migrates_digest_marker_schema(self) -> None:
        self.conn.close()
        legacy_path = os.path.join(self.tmpdir.name, "legacy-v19.db")
        legacy_conn = make_conn(legacy_path)
        legacy_conn.executescript("""
            CREATE TABLE schema_version (
                version INTEGER PRIMARY KEY
            );
            INSERT INTO schema_version (version) VALUES (19);

            CREATE TABLE papers (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                source          TEXT NOT NULL,
                external_id     TEXT NOT NULL,
                title           TEXT NOT NULL,
                abstract        TEXT NOT NULL,
                authors         TEXT NOT NULL DEFAULT '[]',
                published_date  TEXT NOT NULL,
                journal_abbrev  TEXT,
                url             TEXT NOT NULL,
                embedding       BLOB,
                relevance_score REAL,
                score_rubric    TEXT,
                note            TEXT,
                status          TEXT NOT NULL DEFAULT 'new',
                is_saved        INTEGER NOT NULL DEFAULT 0,
                is_read         INTEGER NOT NULL DEFAULT 0,
                is_to_read      INTEGER NOT NULL DEFAULT 0,
                fetched_at      TEXT NOT NULL,
                UNIQUE(source, external_id)
            );
        """)

        init_db(legacy_conn)

        paper_columns = {
            row["name"]
            for row in legacy_conn.execute("PRAGMA table_info(papers)").fetchall()
        }
        paper_indexes = {
            row["name"]
            for row in legacy_conn.execute("PRAGMA index_list(papers)").fetchall()
        }
        schema_version = legacy_conn.execute(
            "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
        ).fetchone()[0]
        self.assertIn("new_digest_run_id", paper_columns)
        self.assertIn("idx_papers_new_digest_run_id", paper_indexes)
        self.assertEqual(schema_version, SCHEMA_VERSION)
        legacy_conn.close()
        self.conn = make_conn(os.path.join(self.tmpdir.name, "claudesk.db"))
        init_db(self.conn)

    def test_existing_v29_database_backfills_digest_new_paper_counts(self) -> None:
        self.conn.close()
        legacy_path = os.path.join(self.tmpdir.name, "legacy-v29-digest-summary.db")
        legacy_conn = make_conn(legacy_path)
        legacy_conn.executescript("""
            CREATE TABLE schema_version (
                version INTEGER PRIMARY KEY
            );
            INSERT INTO schema_version (version) VALUES (29);

            CREATE TABLE digest_runs (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at        TEXT NOT NULL,
                total_fetched     INTEGER NOT NULL DEFAULT 0,
                total_after_dedup INTEGER NOT NULL DEFAULT 0,
                total_in_digest   INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE papers (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                source          TEXT NOT NULL,
                external_id     TEXT NOT NULL,
                title           TEXT NOT NULL,
                abstract        TEXT NOT NULL,
                authors         TEXT NOT NULL DEFAULT '[]',
                published_date  TEXT NOT NULL,
                journal_abbrev  TEXT,
                url             TEXT NOT NULL,
                embedding       BLOB,
                relevance_score REAL,
                score_rubric    TEXT,
                note            TEXT,
                status          TEXT NOT NULL DEFAULT 'new',
                is_saved        INTEGER NOT NULL DEFAULT 0,
                is_read         INTEGER NOT NULL DEFAULT 0,
                is_to_read      INTEGER NOT NULL DEFAULT 0,
                to_read_at      TEXT,
                new_digest_run_id INTEGER REFERENCES digest_runs(id) ON DELETE SET NULL,
                fetched_at      TEXT NOT NULL,
                UNIQUE(source, external_id)
            );

            INSERT INTO digest_runs (
                id, created_at, total_fetched, total_after_dedup, total_in_digest
            )
            VALUES
                (1, '2026-05-15T10:00:00', 8, 7, 3),
                (2, '2026-05-16T10:00:00', 9, 8, 4);

            INSERT INTO papers (
                source, external_id, title, abstract, authors, published_date, journal_abbrev,
                url, embedding, relevance_score, score_rubric, note, status, is_saved, is_read,
                is_to_read, to_read_at, new_digest_run_id, fetched_at
            )
            VALUES
                ('arxiv', '10.1234/run-one', 'Run one paper', 'Abstract', '[]',
                 '2026-05-10', NULL, 'https://example.com/one', NULL, 0.5, NULL, NULL,
                 'new', 0, 0, 0, NULL, 1, '2026-05-15T10:00:00'),
                ('arxiv', '10.1234/run-two-a', 'Run two paper A', 'Abstract', '[]',
                 '2026-05-11', NULL, 'https://example.com/two-a', NULL, 0.6, NULL, NULL,
                 'new', 0, 0, 0, NULL, 2, '2026-05-16T10:00:00'),
                ('pubmed', '10.1234/run-two-b', 'Run two paper B', 'Abstract', '[]',
                 '2026-05-12', NULL, 'https://example.com/two-b', NULL, 0.7, NULL, NULL,
                 'new', 0, 0, 0, NULL, 2, '2026-05-16T10:00:00'),
                ('openalex', 'W123', 'Unmarked paper', 'Abstract', '[]',
                 '2026-05-13', NULL, 'https://example.com/unmarked', NULL, 0.1, NULL, NULL,
                 'new', 0, 0, 0, NULL, NULL, '2026-05-16T10:00:00');
        """)

        init_db(legacy_conn)

        rows = legacy_conn.execute(
            """
            SELECT id, total_new_papers
            FROM digest_runs
            ORDER BY id
            """
        ).fetchall()
        schema_version = legacy_conn.execute(
            "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
        ).fetchone()[0]

        self.assertEqual(
            [(int(row["id"]), int(row["total_new_papers"])) for row in rows],
            [(1, 1), (2, 2)],
        )
        self.assertEqual(schema_version, SCHEMA_VERSION)
        legacy_conn.close()
        self.conn = make_conn(os.path.join(self.tmpdir.name, "claudesk.db"))
        init_db(self.conn)

    def test_ordinary_inserted_paper_is_not_latest_digest_new(self) -> None:
        paper_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/manual-insert",
                title="Manual insert is not digest new",
            ),
        )

        stored = get_paper(self.conn, paper_id)

        self.assertIsNotNone(stored)
        self.assertFalse(stored.is_new_digest)

    def test_same_source_external_id_returns_existing_and_backfills_journal(self) -> None:
        paper = make_paper(source="pubmed", external_id="pmid:123", journal_abbrev=None)
        paper_id = upsert_paper(self.conn, paper)

        updated = paper.model_copy(update={"journal_abbrev": "Proc Natl Acad Sci U S A"})
        same_id = upsert_paper(self.conn, updated)

        stored = get_paper(self.conn, paper_id)
        self.assertEqual(same_id, paper_id)
        self.assertIsNotNone(stored)
        self.assertEqual(stored.journal_abbrev, "Proc Natl Acad Sci U S A")

    def test_cross_source_same_doi_different_case_returns_existing_row(self) -> None:
        existing = make_paper(source="biorxiv", external_id="10.1234/ABC")
        existing_id = upsert_paper(self.conn, existing)

        incoming = make_paper(source="openalex", external_id=" 10.1234/abc ", title="OpenAlex")
        returned_id = upsert_paper(self.conn, incoming)

        count = self.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0]
        stored = get_paper(self.conn, existing_id)
        self.assertEqual(returned_id, existing_id)
        self.assertEqual(count, 1)
        self.assertIsNotNone(stored)
        self.assertEqual(stored.source, "openalex")
        self.assertEqual(stored.title, "OpenAlex")

    def test_cross_source_same_doi_url_returns_existing_row(self) -> None:
        existing = make_paper(source="biorxiv", external_id="10.1234/example")
        existing_id = upsert_paper(self.conn, existing)

        incoming = make_paper(
            source="openalex",
            external_id="https://doi.org/10.1234/EXAMPLE",
            title="OpenAlex URL DOI",
        )
        returned_id = upsert_paper(self.conn, incoming)

        count = self.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0]
        stored = get_paper(self.conn, existing_id)
        self.assertEqual(returned_id, existing_id)
        self.assertEqual(count, 1)
        self.assertIsNotNone(stored)
        self.assertEqual(stored.source, "openalex")
        self.assertEqual(stored.title, "OpenAlex URL DOI")

    def test_existing_doi_url_matches_incoming_raw_doi(self) -> None:
        existing = make_paper(source="biorxiv", external_id="https://doi.org/10.1234/example")
        existing_id = upsert_paper(self.conn, existing)

        incoming = make_paper(
            source="pubmed",
            external_id="10.1234/EXAMPLE",
            title="PubMed raw DOI",
        )
        returned_id = upsert_paper(self.conn, incoming)

        count = self.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0]
        stored = get_paper(self.conn, existing_id)
        self.assertEqual(returned_id, existing_id)
        self.assertEqual(count, 1)
        self.assertIsNotNone(stored)
        self.assertEqual(stored.source, "pubmed")
        self.assertEqual(stored.title, "PubMed raw DOI")

    def test_cross_source_same_normalized_title_returns_existing_row(self) -> None:
        existing = make_paper(source="biorxiv", external_id="10.1234/preprint", title="A useful preprint")
        existing_id = upsert_paper(self.conn, existing)

        incoming = make_paper(
            source="pubmed",
            external_id="pmid:123",
            title="A useful preprint.",
            abstract="Backfilled abstract",
        )
        returned_id = upsert_paper(self.conn, incoming)

        count = self.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0]
        stored = get_paper(self.conn, existing_id)
        self.assertEqual(returned_id, existing_id)
        self.assertEqual(count, 1)
        self.assertIsNotNone(stored)
        self.assertEqual(stored.source, "pubmed")
        self.assertEqual(stored.title, "A useful preprint.")
        self.assertEqual(stored.abstract, "Backfilled abstract")

    def test_cross_source_same_normalized_title_backfills_missing_metadata(self) -> None:
        existing = make_paper(
            source="biorxiv",
            external_id="10.1234/preprint",
            title="A useful preprint",
            abstract="",
            authors=[],
            journal_abbrev=None,
            url="",
        )
        existing_id = upsert_paper(self.conn, existing)

        incoming = make_paper(
            source="pubmed",
            external_id="pmid:123",
            title="A useful preprint.",
            abstract="Backfilled abstract",
            authors=["Bob Example"],
            journal_abbrev="Nature",
            url="https://pubmed.ncbi.nlm.nih.gov/123/",
        )
        returned_id = upsert_paper(self.conn, incoming)

        stored = get_paper(self.conn, existing_id)
        self.assertEqual(returned_id, existing_id)
        self.assertIsNotNone(stored)
        self.assertEqual(stored.source, "pubmed")
        self.assertEqual(stored.abstract, "Backfilled abstract")
        self.assertEqual(stored.authors, ["Bob Example"])
        self.assertEqual(stored.journal_abbrev, "Nature")
        self.assertEqual(stored.url, "https://pubmed.ncbi.nlm.nih.gov/123/")

    def test_cross_source_duplicate_backfills_safe_metadata_only(self) -> None:
        existing = make_paper(
            source="biorxiv",
            external_id="10.1234/example",
            abstract="",
            authors=[],
            journal_abbrev=None,
            url="",
            status=PaperStatus.DISMISSED,
            is_saved=True,
            is_read=True,
        )
        existing_id = upsert_paper(self.conn, existing)
        create_note(
            self.conn,
            title="Existing note",
            body="Do not overwrite this note",
            manual_paper_ids=[existing_id],
        )

        incoming = make_paper(
            source="openalex",
            external_id="10.1234/EXAMPLE",
            abstract="Backfilled abstract",
            authors=["Bob Example"],
            journal_abbrev="Nature",
            url="https://doi.org/10.1234/example",
            status=PaperStatus.NEW,
            is_saved=False,
            is_read=False,
        )
        returned_id = upsert_paper(self.conn, incoming)

        stored = get_paper(self.conn, existing_id)
        self.assertEqual(returned_id, existing_id)
        self.assertIsNotNone(stored)
        self.assertEqual(stored.source, "openalex")
        self.assertEqual(stored.external_id, "10.1234/EXAMPLE")
        self.assertEqual(stored.abstract, "Backfilled abstract")
        self.assertEqual(stored.authors, ["Bob Example"])
        self.assertEqual(stored.journal_abbrev, "Nature")
        self.assertEqual(stored.url, "https://doi.org/10.1234/example")
        notes = list_notes(self.conn, paper_id=existing_id)
        self.assertEqual(stored.note_count, 1)
        self.assertEqual(notes[0].body, "Do not overwrite this note")
        self.assertEqual(stored.status, PaperStatus.DISMISSED)
        self.assertTrue(stored.is_saved)
        self.assertTrue(stored.is_read)

    def test_same_source_reupsert_preserves_lifecycle_state(self) -> None:
        cases = [
            (
                "saved-read",
                make_paper(
                    external_id="10.1234/saved-read",
                    title="Saved read lifecycle paper",
                    status=PaperStatus.SAVED,
                    is_saved=True,
                    is_read=True,
                ),
                PaperStatus.SAVED,
                True,
                True,
                False,
            ),
            (
                "to-read",
                make_paper(
                    external_id="10.1234/to-read",
                    title="Queued lifecycle paper",
                    is_to_read=True,
                ),
                PaperStatus.NEW,
                False,
                False,
                True,
            ),
            (
                "dismissed-saved-read",
                make_paper(
                    external_id="10.1234/dismissed",
                    title="Dismissed lifecycle paper",
                    status=PaperStatus.DISMISSED,
                    is_saved=True,
                    is_read=True,
                ),
                PaperStatus.DISMISSED,
                True,
                True,
                False,
            ),
        ]

        for label, existing, expected_status, expected_saved, expected_read, expected_to_read in cases:
            with self.subTest(label=label):
                paper_id = upsert_paper(self.conn, existing)
                incoming = make_paper(
                    source=existing.source,
                    external_id=existing.external_id,
                    title=f"Incoming {label}",
                    abstract="Incoming digest metadata",
                    status=PaperStatus.NEW,
                    is_saved=False,
                    is_read=False,
                    is_to_read=False,
                )

                returned_id = upsert_paper(self.conn, incoming)
                stored = get_paper(self.conn, paper_id)

                self.assertEqual(returned_id, paper_id)
                self.assertIsNotNone(stored)
                self.assertEqual(stored.status, expected_status)
                self.assertEqual(stored.is_saved, expected_saved)
                self.assertEqual(stored.is_read, expected_read)
                self.assertEqual(stored.is_to_read, expected_to_read)

    def test_cross_source_duplicate_preserves_to_read_when_metadata_promotes(self) -> None:
        existing = make_paper(
            source="biorxiv",
            external_id="10.1234/to-read-duplicate",
            title="A lifecycle paper",
            is_to_read=True,
        )
        existing_id = upsert_paper(self.conn, existing)
        incoming = make_paper(
            source="pubmed",
            external_id="10.1234/TO-READ-DUPLICATE",
            title="Published lifecycle paper",
            abstract="Published abstract",
            journal_abbrev="Nat Methods",
            is_to_read=False,
        )

        returned_id = upsert_paper(self.conn, incoming)

        stored = get_paper(self.conn, existing_id)
        self.assertEqual(returned_id, existing_id)
        self.assertIsNotNone(stored)
        self.assertEqual(stored.source, "pubmed")
        self.assertEqual(stored.abstract, "Published abstract")
        self.assertEqual(stored.journal_abbrev, "Nat Methods")
        self.assertEqual(stored.status, PaperStatus.NEW)
        self.assertTrue(stored.is_to_read)
        self.assertIn(existing_id, {paper.id for paper in list_to_read_papers(self.conn)})

    def test_old_papers_are_retained_across_date_windows_and_status_lists(self) -> None:
        old_date = date(2026, 3, 1)
        recent_since = date(2026, 4, 1)
        old_digest_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/old-digest",
                title="Old digest only paper",
                published_date=old_date,
            ),
        )
        old_saved_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/old-saved",
                title="Old saved paper",
                published_date=old_date,
                status=PaperStatus.SAVED,
                is_saved=True,
            ),
        )
        old_read_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/old-read",
                title="Old read paper",
                published_date=old_date,
                status=PaperStatus.READ,
                is_read=True,
            ),
        )
        old_to_read_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/old-to-read",
                title="Old to-read paper",
                published_date=old_date,
                is_to_read=True,
            ),
        )
        old_dismissed_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/old-dismissed",
                title="Old dismissed paper",
                published_date=old_date,
                status=PaperStatus.DISMISSED,
            ),
        )

        windowed_new_ids = {
            paper.id
            for paper in list_papers(
                self.conn,
                status=PaperStatus.NEW,
                since=recent_since,
            )
        }
        all_ids = {paper.id for paper in list_papers(self.conn)}
        all_with_dismissed_ids = {
            paper.id for paper in list_papers(self.conn, include_dismissed=True)
        }
        saved_ids = {paper.id for paper in list_papers(self.conn, status=PaperStatus.SAVED)}
        read_ids = {paper.id for paper in list_papers(self.conn, status=PaperStatus.READ)}
        dismissed_ids = {paper.id for paper in list_papers(self.conn, status=PaperStatus.DISMISSED)}
        to_read_ids = {paper.id for paper in list_to_read_papers(self.conn)}
        old_search_ids = {paper.id for paper in search_papers(self.conn, "old digest")}

        self.assertNotIn(old_digest_id, windowed_new_ids)
        self.assertIn(old_digest_id, all_ids)
        self.assertNotIn(old_dismissed_id, all_ids)
        self.assertIn(old_dismissed_id, all_with_dismissed_ids)
        self.assertIn(old_digest_id, old_search_ids)
        self.assertIsNotNone(get_paper(self.conn, old_digest_id))
        self.assertIn(old_saved_id, saved_ids)
        self.assertIn(old_read_id, read_ids)
        self.assertIn(old_to_read_id, to_read_ids)
        self.assertIn(old_dismissed_id, dismissed_ids)
        self.assertIsNotNone(get_paper(self.conn, old_dismissed_id))

    def test_default_paper_list_excludes_dismissed_with_explicit_recovery(self) -> None:
        visible_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/list-visible",
                title="Lifecycle visible list paper",
            ),
        )
        dismissed_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/list-dismissed",
                title="Lifecycle dismissed list paper",
                status=PaperStatus.DISMISSED,
            ),
        )

        default_ids = {paper.id for paper in list_papers(self.conn)}
        recovered_ids = {paper.id for paper in list_papers(self.conn, include_dismissed=True)}
        dismissed_ids = {paper.id for paper in list_papers(self.conn, status=PaperStatus.DISMISSED)}

        self.assertIn(visible_id, default_ids)
        self.assertNotIn(dismissed_id, default_ids)
        self.assertIn(visible_id, recovered_ids)
        self.assertIn(dismissed_id, recovered_ids)
        self.assertEqual(dismissed_ids, {dismissed_id})
        direct_lookup = get_paper(self.conn, dismissed_id)
        self.assertIsNotNone(direct_lookup)
        self.assertEqual(direct_lookup.id, dismissed_id)

    def test_paper_search_excludes_dismissed_with_explicit_recovery(self) -> None:
        visible_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/search-visible",
                title="Lifecycle visible search paper",
                abstract="chromatin visibility recovery",
            ),
        )
        dismissed_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/search-dismissed",
                title="Lifecycle dismissed search paper",
                abstract="chromatin visibility recovery",
                status=PaperStatus.DISMISSED,
            ),
        )

        default_ids = {paper.id for paper in search_papers(self.conn, "chromatin recovery")}
        recovered_ids = {
            paper.id
            for paper in search_papers(
                self.conn,
                "chromatin recovery",
                include_dismissed=True,
            )
        }

        self.assertEqual(default_ids, {visible_id})
        self.assertEqual(recovered_ids, {visible_id, dismissed_id})

    def test_paper_list_and_search_api_respect_dismissed_visibility(self) -> None:
        visible_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/api-visible",
                title="Lifecycle visible API paper",
                abstract="microtubule lifecycle recovery",
            ),
        )
        dismissed_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/api-dismissed",
                title="Lifecycle dismissed API paper",
                abstract="microtubule lifecycle recovery",
                status=PaperStatus.DISMISSED,
            ),
        )

        default_list_ids = {row["id"] for row in papers_api.get_papers(conn=self.conn)}
        recovered_list_ids = {
            row["id"]
            for row in papers_api.get_papers(
                include_dismissed=True,
                conn=self.conn,
            )
        }
        dismissed_list_ids = {
            row["id"]
            for row in papers_api.get_papers(
                status=PaperStatus.DISMISSED.value,
                conn=self.conn,
            )
        }
        default_search_ids = {
            row["id"]
            for row in search_api.search(
                "microtubule recovery",
                conn=self.conn,
            )["papers"]
        }
        recovered_search_ids = {
            row["id"]
            for row in search_api.search(
                "microtubule recovery",
                include_dismissed=True,
                conn=self.conn,
            )["papers"]
        }
        direct_lookup = papers_api.get_paper_by_id(dismissed_id, conn=self.conn)

        self.assertIn(visible_id, default_list_ids)
        self.assertNotIn(dismissed_id, default_list_ids)
        self.assertIn(visible_id, recovered_list_ids)
        self.assertIn(dismissed_id, recovered_list_ids)
        self.assertEqual(dismissed_list_ids, {dismissed_id})
        self.assertEqual(direct_lookup["id"], dismissed_id)
        self.assertEqual(default_search_ids, {visible_id})
        self.assertEqual(recovered_search_ids, {visible_id, dismissed_id})

    def test_marking_to_read_paper_read_clears_queue_without_deleting_row(self) -> None:
        paper_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/read-clears-to-read",
                is_to_read=True,
                to_read_at=datetime(2026, 4, 1, 8, 0, 0),
            ),
        )

        effective_status = update_paper_status(self.conn, paper_id, PaperSignal.READ)

        stored = get_paper(self.conn, paper_id)
        self.assertEqual(effective_status, PaperStatus.READ)
        self.assertIsNotNone(stored)
        self.assertEqual(stored.status, PaperStatus.READ)
        self.assertTrue(stored.is_read)
        self.assertFalse(stored.is_to_read)
        self.assertIsNone(stored.to_read_at)
        self.assertNotIn(paper_id, {paper.id for paper in list_to_read_papers(self.conn)})

    def test_to_read_status_sets_and_preserves_queue_timestamp(self) -> None:
        paper_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/queue-enter",
                fetched_at=datetime(2026, 3, 1, 8, 0, 0),
            ),
        )

        update_paper_status(self.conn, paper_id, PaperSignal.TO_READ)
        queued = get_paper(self.conn, paper_id)
        self.assertIsNotNone(queued)
        self.assertTrue(queued.is_to_read)
        self.assertIsNotNone(queued.to_read_at)

        first_to_read_at = queued.to_read_at
        update_paper_status(self.conn, paper_id, PaperSignal.TO_READ)
        requeued = get_paper(self.conn, paper_id)
        self.assertIsNotNone(requeued)
        self.assertEqual(requeued.to_read_at, first_to_read_at)

    def test_queue_exit_signals_clear_queue_timestamp(self) -> None:
        cases = [
            PaperSignal.READ,
            PaperSignal.REMOVE_TO_READ,
            PaperSignal.NEW,
            PaperSignal.DISMISSED,
        ]

        for signal in cases:
            with self.subTest(signal=signal.value):
                paper_id = upsert_paper(
                    self.conn,
                    make_paper(
                        external_id=f"10.1234/clear-{signal.value}",
                        title=f"Clear {signal.value}",
                        is_to_read=True,
                        to_read_at=datetime(2026, 4, 2, 9, 0, 0),
                    ),
                )

                update_paper_status(self.conn, paper_id, signal)

                stored = get_paper(self.conn, paper_id)
                self.assertIsNotNone(stored)
                self.assertFalse(stored.is_to_read)
                self.assertIsNone(stored.to_read_at)

    def test_apply_paper_signal_records_feedback_and_returns_before_after(self) -> None:
        paper_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/status-workflow",
                title="Status workflow paper",
            ),
        )

        update = apply_paper_signal(self.conn, paper_id, PaperSignal.TO_READ)

        self.assertEqual(update.before.status, PaperStatus.NEW)
        self.assertFalse(update.before.is_to_read)
        self.assertEqual(update.effective_status, PaperStatus.NEW)
        self.assertEqual(update.after.status, PaperStatus.NEW)
        self.assertTrue(update.after.is_to_read)
        self.assertIsNotNone(update.feedback_id)
        self.assertEqual(
            self.conn.execute("SELECT signal FROM feedback WHERE paper_id=?", (paper_id,)).fetchone()["signal"],
            "to_read",
        )

    def test_apply_paper_signal_can_skip_feedback_for_cli_status(self) -> None:
        paper_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/status-no-feedback",
                title="Status no feedback paper",
            ),
        )

        update = apply_paper_signal(
            self.conn,
            paper_id,
            PaperSignal.SAVED,
            record_feedback=False,
        )

        self.assertEqual(update.effective_status, PaperStatus.SAVED)
        self.assertTrue(update.after.is_saved)
        self.assertIsNone(update.feedback_id)
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM feedback WHERE paper_id=?", (paper_id,)).fetchone()[0],
            0,
        )

    def test_to_read_migration_backfills_queued_timestamp_from_fetched_at(self) -> None:
        self.conn.close()
        legacy_path = os.path.join(self.tmpdir.name, "legacy-v27-to-read-at.db")
        legacy_conn = make_conn(legacy_path)
        legacy_conn.executescript("""
            CREATE TABLE schema_version (
                version INTEGER PRIMARY KEY
            );
            INSERT INTO schema_version (version) VALUES (27);

            CREATE TABLE digest_runs (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at        TEXT NOT NULL,
                total_fetched     INTEGER NOT NULL DEFAULT 0,
                total_after_dedup INTEGER NOT NULL DEFAULT 0,
                total_in_digest   INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE papers (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                source          TEXT NOT NULL,
                external_id     TEXT NOT NULL,
                title           TEXT NOT NULL,
                abstract        TEXT NOT NULL,
                authors         TEXT NOT NULL DEFAULT '[]',
                published_date  TEXT NOT NULL,
                journal_abbrev  TEXT,
                url             TEXT NOT NULL,
                embedding       BLOB,
                relevance_score REAL,
                score_rubric    TEXT,
                note            TEXT,
                status          TEXT NOT NULL DEFAULT 'new',
                is_saved        INTEGER NOT NULL DEFAULT 0,
                is_read         INTEGER NOT NULL DEFAULT 0,
                is_to_read      INTEGER NOT NULL DEFAULT 0,
                new_digest_run_id INTEGER REFERENCES digest_runs(id) ON DELETE SET NULL,
                fetched_at      TEXT NOT NULL,
                UNIQUE(source, external_id)
            );
            INSERT INTO papers (
                source, external_id, title, abstract, authors, published_date, journal_abbrev,
                url, embedding, relevance_score, score_rubric, note, status, is_saved, is_read,
                is_to_read, fetched_at
            )
            VALUES (
                'arxiv', '10.1234/legacy-queued', 'Legacy queued paper', 'Abstract', '[]',
                '2026-01-01', NULL, 'https://example.com/legacy', NULL, 0.4, NULL, NULL,
                'new', 0, 0, 1, '2026-02-03T04:05:06'
            );
        """)

        init_db(legacy_conn)

        columns = {
            row["name"]
            for row in legacy_conn.execute("PRAGMA table_info(papers)").fetchall()
        }
        stored = list_to_read_papers(legacy_conn)[0]
        schema_version = legacy_conn.execute(
            "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
        ).fetchone()[0]
        self.assertIn("to_read_at", columns)
        self.assertEqual(stored.to_read_at, datetime(2026, 2, 3, 4, 5, 6))
        self.assertEqual(schema_version, SCHEMA_VERSION)
        legacy_conn.close()
        self.conn = make_conn(os.path.join(self.tmpdir.name, "claudesk.db"))
        init_db(self.conn)

    def test_list_to_read_papers_can_sort_by_queued_date(self) -> None:
        older_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/queued-older",
                title="Older queued paper",
                is_to_read=True,
                to_read_at=datetime(2026, 1, 10, 12, 0, 0),
                published_date=date(2026, 5, 1),
            ),
        )
        newer_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/queued-newer",
                title="Newer queued paper",
                is_to_read=True,
                to_read_at=datetime(2026, 3, 10, 12, 0, 0),
                published_date=date(2026, 1, 1),
            ),
        )
        middle_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/queued-middle",
                title="Middle queued paper",
                is_to_read=True,
                to_read_at=datetime(2026, 2, 10, 12, 0, 0),
                published_date=date(2026, 2, 1),
            ),
        )

        queued_ids = [paper.id for paper in list_to_read_papers(self.conn, sort="queued")]

        self.assertEqual(queued_ids, [newer_id, middle_id, older_id])

    def test_source_priority_is_deterministic_for_existing_duplicates(self) -> None:
        openalex_id = upsert_paper(
            self.conn,
            make_paper(source="openalex", external_id="10.5555/example", title="OpenAlex"),
        )
        biorxiv = make_paper(source="biorxiv", external_id="10.5555/EXAMPLE", title="bioRxiv")
        self.conn.execute(
            """
            INSERT INTO papers
                (source, external_id, title, abstract, authors, published_date,
                 journal_abbrev, url, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                biorxiv.source,
                biorxiv.external_id,
                biorxiv.title,
                biorxiv.abstract,
                '["Alice Example"]',
                biorxiv.published_date.isoformat(),
                biorxiv.journal_abbrev,
                biorxiv.url,
                biorxiv.fetched_at.isoformat(),
            ),
        )
        biorxiv_id = int(self.conn.execute("SELECT last_insert_rowid()").fetchone()[0])

        incoming = make_paper(source="pubmed", external_id="10.5555/example")
        returned_id = upsert_paper(self.conn, incoming)

        self.assertNotEqual(openalex_id, biorxiv_id)
        self.assertEqual(returned_id, openalex_id)
        stored = get_paper(self.conn, openalex_id)
        self.assertIsNotNone(stored)
        self.assertEqual(stored.source, "pubmed")

    def test_score_rubric_round_trips_and_ranking_update_persists_it(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        rubric = PaperScoreRubric(
            topic_match=3,
            method_match=2,
            usefulness=3,
            novelty=1,
            confidence=2,
            evidence=["Direct topic match"],
            reason="Likely useful.",
        )

        update_paper_ranking(
            self.conn,
            paper_id,
            [0.1, 0.2, 0.3],
            11 / 15,
            score_rubric=rubric,
        )
        self.conn.commit()

        stored = get_paper(self.conn, paper_id)
        self.assertIsNotNone(stored)
        self.assertAlmostEqual(stored.relevance_score or 0, 11 / 15)
        self.assertIsNotNone(stored.score_rubric)
        self.assertEqual(stored.score_rubric.topic_match, 3)
        self.assertEqual(stored.score_rubric.evidence, ["Direct topic match"])

    def test_ranking_update_can_clear_stale_score_rubric(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        rubric = PaperScoreRubric(
            topic_match=3,
            method_match=3,
            usefulness=3,
            novelty=3,
            confidence=3,
        )
        update_paper_ranking(self.conn, paper_id, [0.1], 1.0, score_rubric=rubric)
        self.conn.commit()

        update_paper_ranking(self.conn, paper_id, [0.2], 0.4, score_rubric=None)
        self.conn.commit()

        stored = get_paper(self.conn, paper_id)
        self.assertIsNotNone(stored)
        self.assertAlmostEqual(stored.relevance_score or 0, 0.4)
        self.assertIsNone(stored.score_rubric)

    def test_ranking_update_preserves_score_rubric_by_default(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        rubric = PaperScoreRubric(
            topic_match=3,
            method_match=3,
            usefulness=3,
            novelty=3,
            confidence=3,
        )
        update_paper_ranking(self.conn, paper_id, [0.1], 1.0, score_rubric=rubric)
        self.conn.commit()

        update_paper_ranking(self.conn, paper_id, [0.2], 0.4)
        self.conn.commit()

        stored = get_paper(self.conn, paper_id)
        self.assertIsNotNone(stored)
        self.assertAlmostEqual(stored.relevance_score or 0, 0.4)
        self.assertIsNotNone(stored.score_rubric)

    def test_write_digest_preserves_existing_score_rubric_when_ranked_paper_has_none(self) -> None:
        paper = make_paper()
        paper_id = upsert_paper(self.conn, paper)
        rubric = PaperScoreRubric(
            topic_match=3,
            method_match=3,
            usefulness=2,
            novelty=1,
            confidence=3,
            evidence=["Existing LLM evidence"],
            reason="Existing LLM reason.",
        )
        update_paper_ranking(self.conn, paper_id, [0.1], 0.8, score_rubric=rubric)
        self.conn.commit()

        ranked_without_rubric = paper.model_copy(
            update={
                "embedding": [0.2],
                "relevance_score": 0.4,
                "score_rubric": None,
            }
        )
        write_digest(
            [ranked_without_rubric],
            self.conn,
            days_back=7,
            sources=["arxiv"],
            total_fetched=1,
            cfg=Config(),
        )

        stored = get_paper(self.conn, paper_id)
        self.assertIsNotNone(stored)
        self.assertAlmostEqual(stored.relevance_score or 0, 0.4)
        self.assertIsNotNone(stored.score_rubric)
        self.assertEqual(stored.score_rubric.evidence, ["Existing LLM evidence"])
        self.assertEqual(stored.score_rubric.reason, "Existing LLM reason.")

    def test_latest_digest_inserts_are_marked_new(self) -> None:
        paper = make_paper(
            external_id="10.1234/latest-digest-new",
            title="Latest digest new paper",
        )

        result = write_digest(
            [paper],
            self.conn,
            days_back=7,
            sources=["arxiv"],
            total_fetched=1,
            total_after_dedup=1,
            cfg=Config(),
        )

        stored = get_paper(self.conn, 1)
        self.assertIsNotNone(stored)
        self.assertTrue(stored.is_new_digest)
        self.assertEqual(result.total_new_papers, 1)
        latest_run = self.conn.execute(
            "SELECT days_back, sources_json, total_new_papers FROM digest_runs"
        ).fetchone()
        self.assertEqual(latest_run["days_back"], 7)
        self.assertEqual(json.loads(latest_run["sources_json"]), ["arxiv"])
        self.assertEqual(latest_run["total_new_papers"], 1)

    def test_second_digest_clears_older_new_marker(self) -> None:
        first = make_paper(
            external_id="10.1234/first-digest",
            title="First digest marker paper",
        )
        second = make_paper(
            external_id="10.1234/second-digest",
            title="Second digest marker paper",
        )
        write_digest(
            [first],
            self.conn,
            days_back=7,
            sources=["arxiv"],
            total_fetched=1,
            total_after_dedup=1,
            cfg=Config(),
        )
        first_id = int(
            self.conn.execute(
                "SELECT id FROM papers WHERE external_id=?",
                (first.external_id,),
            ).fetchone()[0]
        )

        write_digest(
            [second],
            self.conn,
            days_back=7,
            sources=["arxiv"],
            total_fetched=1,
            total_after_dedup=1,
            cfg=Config(),
        )
        second_id = int(
            self.conn.execute(
                "SELECT id FROM papers WHERE external_id=?",
                (second.external_id,),
            ).fetchone()[0]
        )

        stored_first = get_paper(self.conn, first_id)
        stored_second = get_paper(self.conn, second_id)
        self.assertIsNotNone(stored_first)
        self.assertIsNotNone(stored_second)
        self.assertFalse(stored_first.is_new_digest)
        self.assertTrue(stored_second.is_new_digest)

    def test_refetched_and_duplicate_papers_are_not_marked_digest_new(self) -> None:
        existing = make_paper(
            external_id="10.1234/existing-digest",
            title="Existing digest paper",
        )
        existing_id = upsert_paper(self.conn, existing)

        write_digest(
            [
                make_paper(
                    external_id=existing.external_id,
                    title="Refetched digest paper",
                )
            ],
            self.conn,
            days_back=7,
            sources=["arxiv"],
            total_fetched=1,
            total_after_dedup=1,
            cfg=Config(),
        )
        refetched = get_paper(self.conn, existing_id)

        result = write_digest(
            [
                make_paper(
                    source="openalex",
                    external_id="https://doi.org/10.1234/existing-digest",
                    title="Duplicate digest paper",
                )
            ],
            self.conn,
            days_back=7,
            sources=["openalex"],
            total_fetched=1,
            total_after_dedup=1,
            cfg=Config(),
        )
        duplicate = get_paper(self.conn, existing_id)

        self.assertIsNotNone(refetched)
        self.assertIsNotNone(duplicate)
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0],
            1,
        )
        self.assertFalse(refetched.is_new_digest)
        self.assertFalse(duplicate.is_new_digest)
        self.assertEqual(result.total_new_papers, 0)

    def test_saved_read_and_dismissed_papers_are_not_marked_digest_new(self) -> None:
        papers = [
            make_paper(
                external_id="10.1234/digest-saved",
                title="Digest saved marker paper",
            ),
            make_paper(
                external_id="10.1234/digest-read",
                title="Digest read marker paper",
            ),
            make_paper(
                external_id="10.1234/digest-dismissed",
                title="Digest dismissed marker paper",
            ),
        ]
        write_digest(
            papers,
            self.conn,
            days_back=7,
            sources=["arxiv"],
            total_fetched=3,
            total_after_dedup=3,
            cfg=Config(),
        )
        rows = self.conn.execute(
            "SELECT id, external_id FROM papers ORDER BY id ASC"
        ).fetchall()
        ids_by_external_id = {row["external_id"]: int(row["id"]) for row in rows}

        update_paper_status(
            self.conn,
            ids_by_external_id["10.1234/digest-saved"],
            PaperSignal.SAVED,
        )
        update_paper_status(
            self.conn,
            ids_by_external_id["10.1234/digest-read"],
            PaperSignal.READ,
        )
        update_paper_status(
            self.conn,
            ids_by_external_id["10.1234/digest-dismissed"],
            PaperSignal.DISMISSED,
        )

        for paper_id in ids_by_external_id.values():
            stored = get_paper(self.conn, paper_id)
            self.assertIsNotNone(stored)
            self.assertFalse(stored.is_new_digest)

    def test_empty_successful_digest_clears_previous_marker(self) -> None:
        paper = make_paper(
            external_id="10.1234/empty-clears",
            title="Empty digest clear marker paper",
        )
        write_digest(
            [paper],
            self.conn,
            days_back=7,
            sources=["arxiv"],
            total_fetched=1,
            total_after_dedup=1,
            cfg=Config(),
        )
        paper_id = int(
            self.conn.execute(
                "SELECT id FROM papers WHERE external_id=?",
                (paper.external_id,),
            ).fetchone()[0]
        )
        initially_stored = get_paper(self.conn, paper_id)
        self.assertIsNotNone(initially_stored)
        self.assertTrue(initially_stored.is_new_digest)

        write_digest(
            [],
            self.conn,
            days_back=7,
            sources=["arxiv"],
            total_fetched=0,
            total_after_dedup=0,
            cfg=Config(),
        )

        stored = get_paper(self.conn, paper_id)
        latest_run = self.conn.execute(
            """
            SELECT total_fetched, total_after_dedup, total_in_digest, total_new_papers
            FROM digest_runs
            ORDER BY id DESC
            LIMIT 1
            """
        ).fetchone()
        self.assertIsNotNone(stored)
        self.assertIsNotNone(latest_run)
        self.assertFalse(stored.is_new_digest)
        self.assertEqual(
            (
                latest_run["total_fetched"],
                latest_run["total_after_dedup"],
                latest_run["total_in_digest"],
                latest_run["total_new_papers"],
            ),
            (0, 0, 0, 0),
        )

    def test_title_duplicate_groups_are_found_without_merging(self) -> None:
        insert_raw_paper(
            self.conn,
            make_paper(source="biorxiv", external_id="10.1234/preprint", title="A useful preprint"),
        )
        canonical_id = insert_raw_paper(
            self.conn,
            make_paper(source="pubmed", external_id="pmid:123", title="A useful preprint."),
        )

        groups = find_title_duplicate_groups(self.conn)

        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["canonical_id"], canonical_id)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0], 2)

    def test_merge_title_duplicates_preserves_to_read_state(self) -> None:
        duplicate_id = insert_raw_paper(
            self.conn,
            make_paper(
                source="biorxiv",
                external_id="10.1234/to-read-preprint",
                title="A useful queued paper",
                is_to_read=True,
            ),
        )
        canonical_id = insert_raw_paper(
            self.conn,
            make_paper(
                source="pubmed",
                external_id="pmid:queued",
                title="A useful queued paper.",
            ),
        )

        groups = merge_title_duplicate_groups(self.conn)

        stored = get_paper(self.conn, canonical_id)
        self.assertEqual(len(groups), 1)
        self.assertIsNone(get_paper(self.conn, duplicate_id))
        self.assertIsNotNone(stored)
        self.assertEqual(stored.status, PaperStatus.NEW)
        self.assertTrue(stored.is_to_read)
        self.assertIn(canonical_id, {paper.id for paper in list_to_read_papers(self.conn)})

    def test_merge_title_duplicates_preserves_dismissed_and_read_state(self) -> None:
        duplicate_id = insert_raw_paper(
            self.conn,
            make_paper(
                source="biorxiv",
                external_id="10.1234/dismissed-preprint",
                title="A dismissed paper",
                status=PaperStatus.DISMISSED,
                is_read=True,
            ),
        )
        canonical_id = insert_raw_paper(
            self.conn,
            make_paper(
                source="pubmed",
                external_id="pmid:dismissed",
                title="A dismissed paper.",
            ),
        )

        groups = merge_title_duplicate_groups(self.conn)

        stored = get_paper(self.conn, canonical_id)
        dismissed_ids = {paper.id for paper in list_papers(self.conn, status=PaperStatus.DISMISSED)}
        self.assertEqual(len(groups), 1)
        self.assertIsNone(get_paper(self.conn, duplicate_id))
        self.assertIsNotNone(stored)
        self.assertEqual(stored.status, PaperStatus.DISMISSED)
        self.assertTrue(stored.is_read)
        self.assertIn(canonical_id, dismissed_ids)

    def test_merge_title_duplicates_rewrites_references_and_appends_notes(self) -> None:
        duplicate_id = insert_raw_paper(
            self.conn,
            make_paper(
                source="biorxiv",
                external_id="10.1234/preprint",
                title="A useful preprint",
                is_saved=True,
            ),
            legacy_note="Duplicate note",
        )
        canonical_id = insert_raw_paper(
            self.conn,
            make_paper(
                source="pubmed",
                external_id="pmid:123",
                title="A useful preprint.",
                is_read=True,
            ),
            legacy_note=f"Canonical note with [old](paper://{duplicate_id})",
        )
        now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
        project_id = self.conn.execute(
            """
            INSERT INTO projects (slug, name, status, description, tags, created_at, updated_at)
            VALUES ('proj', 'Project', 'active', '', '[]', ?, ?)
            """,
            (now, now),
        ).lastrowid
        self.conn.execute(
            "INSERT INTO project_papers (project_id, paper_id, role, created_at) VALUES (?, ?, 'relevant', ?)",
            (project_id, duplicate_id, now),
        )
        self.conn.execute(
            "INSERT INTO feedback (paper_id, signal, created_at) VALUES (?, 'saved', ?)",
            (duplicate_id, now),
        )
        progress_id = self.conn.execute(
            """
            INSERT INTO log_entries (entry_type, entry_date, entry_markdown, linked_paper_ids, task_id, created_at)
            VALUES ('manual', '2026-04-29', ?, ?, NULL, ?)
            """,
            (
                f"Read [paper](paper://{duplicate_id})",
                json.dumps([duplicate_id]),
                now,
            ),
        ).lastrowid
        todo_id = self.conn.execute(
            """
            INSERT INTO todos (title, description, status, priority, created_at)
            VALUES ('Summarize paper', ?, 'open', 'medium', ?)
            """,
            (f"Summarize [paper](paper://{duplicate_id})", now),
        ).lastrowid
        session_id = create_chat_session(
            self.conn,
            runtime_settings=ChatRuntimeSettings(),
            title="Chat",
            linked_paper_ids=[duplicate_id],
            created_at=datetime.fromisoformat(now),
        ).id
        message_id = self.conn.execute(
            """
            INSERT INTO chat_messages (session_id, role, content, created_at)
            VALUES (?, 'user', ?, ?)
            """,
            (session_id, f"Discuss [paper](paper://{duplicate_id})", now),
        ).lastrowid
        linked_note = create_note(
            self.conn,
            title="Linked note",
            body=f"Discuss [paper](paper://{duplicate_id}) in the next meeting",
            manual_paper_ids=[duplicate_id],
        )

        groups = merge_title_duplicate_groups(self.conn)

        self.assertEqual(len(groups), 1)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0], 1)
        stored = get_paper(self.conn, canonical_id)
        self.assertIsNotNone(stored)
        self.assertTrue(stored.is_saved)
        self.assertTrue(stored.is_read)
        notes = list_notes(self.conn, paper_id=canonical_id)
        note_bodies = "\n\n".join(note.body for note in notes)
        self.assertEqual(stored.note_count, 3)
        self.assertIn(f"paper://{canonical_id}", note_bodies)
        self.assertIn("Canonical note", note_bodies)
        self.assertIn("Duplicate note", note_bodies)
        rewritten_linked_note = next(note for note in notes if note.id == linked_note.id)
        self.assertEqual(rewritten_linked_note.linked_paper_ids, [canonical_id])
        self.assertEqual(rewritten_linked_note.manual_paper_ids, [canonical_id])
        self.assertEqual(rewritten_linked_note.mentioned_paper_ids, [canonical_id])
        self.assertEqual(
            self.conn.execute("SELECT paper_id FROM project_papers").fetchone()[0],
            canonical_id,
        )
        self.assertEqual(
            self.conn.execute("SELECT paper_id FROM feedback").fetchone()[0],
            canonical_id,
        )
        progress = self.conn.execute(
            "SELECT entry_markdown, linked_paper_ids FROM log_entries WHERE id=?",
            (progress_id,),
        ).fetchone()
        self.assertIn(f"paper://{canonical_id}", progress["entry_markdown"])
        self.assertEqual(json.loads(progress["linked_paper_ids"]), [canonical_id])
        todo = self.conn.execute("SELECT description FROM todos WHERE id=?", (todo_id,)).fetchone()
        self.assertIn(f"paper://{canonical_id}", todo["description"])
        session = self.conn.execute(
            "SELECT linked_paper_ids FROM chat_sessions WHERE id=?",
            (session_id,),
        ).fetchone()
        self.assertEqual(json.loads(session["linked_paper_ids"]), [canonical_id])
        message = self.conn.execute("SELECT content FROM chat_messages WHERE id=?", (message_id,)).fetchone()
        self.assertIn(f"paper://{canonical_id}", message["content"])


if __name__ == "__main__":
    unittest.main()
