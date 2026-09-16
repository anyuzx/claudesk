from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from datetime import date, datetime, timezone
from unittest.mock import patch

import httpx
from fastapi import HTTPException

from claudesk.api import papers as papers_api
from claudesk.core import paper_ingest
from claudesk.core.config import ChatRuntimeSettings
from claudesk.core.db.chat import create_chat_session
from claudesk.core.db.notes import (
    create_note,
    list_notes,
)
from claudesk.core.db.papers import (
    get_paper,
    insert_feedback,
    search_papers,
    upsert_paper,
)
from claudesk.core.db import init_db
from claudesk.core.models import Paper, PaperStatus
from claudesk.sources import doi as doi_source


def make_conn(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def make_response(url: str, status_code: int, payload: dict) -> httpx.Response:
    request = httpx.Request("GET", url)
    return httpx.Response(status_code, json=payload, request=request)


def crossref_payload(
    *,
    title: str = "Useful DOI paper",
    abstract: str = "Example abstract",
    doi_date: list[int] | None = None,
) -> dict:
    message: dict[str, object] = {
        "title": [title],
        "author": [{"given": "Alice", "family": "Example"}],
        "published-online": {"date-parts": [doi_date or [2026, 4, 28]]},
        "short-container-title": ["J Test"],
        "URL": "https://example.org/paper",
    }
    if abstract:
        message["abstract"] = f"<jats:p>{abstract}</jats:p>"
    return {"message": message}


def make_paper(
    *,
    source: str = "crossref",
    external_id: str = "10.1234/example",
    title: str = "Example paper",
    abstract: str = "Example abstract",
    status: PaperStatus = PaperStatus.NEW,
    is_saved: bool = False,
    is_read: bool = False,
    is_to_read: bool = False,
) -> Paper:
    return Paper(
        source=source,
        external_id=external_id,
        title=title,
        abstract=abstract,
        authors=["Alice Example"],
        published_date=date(2026, 4, 24),
        journal_abbrev="J Test",
        url=f"https://doi.org/{external_id}",
        status=status,
        is_saved=is_saved,
        is_read=is_read,
        is_to_read=is_to_read,
    )


class CrossrefDoiResolverTests(unittest.TestCase):
    def test_resolve_doi_metadata_parses_crossref_work(self) -> None:
        payload = {
            "message": {
                "title": ["<i>Useful</i> DOI paper"],
                "abstract": "<jats:p>Chromatin &amp; mechanics.</jats:p>",
                "author": [
                    {"given": "Alice", "family": "Example"},
                    {"name": "Example Consortium"},
                ],
                "published-online": {"date-parts": [[2026, 4, 28]]},
                "short-container-title": ["Nat Methods"],
                "container-title": ["Nature Methods"],
                "URL": "https://example.org/paper",
            }
        }

        def fake_get(url: str, *, headers: dict, timeout: float) -> httpx.Response:
            self.assertEqual(url, f"{doi_source.CROSSREF_WORKS_API}/10.1234%2Fabc.def")
            self.assertEqual(headers, doi_source._HEADERS)
            self.assertEqual(timeout, 30.0)
            return make_response(url, 200, payload)

        with patch.object(doi_source.httpx, "get", side_effect=fake_get):
            paper = doi_source.resolve_doi_metadata("https://doi.org/10.1234/ABC.Def")

        self.assertEqual(paper.source, "crossref")
        self.assertEqual(paper.external_id, "10.1234/abc.def")
        self.assertEqual(paper.title, "Useful DOI paper")
        self.assertEqual(paper.abstract, "Chromatin & mechanics.")
        self.assertEqual(paper.authors, ["Alice Example", "Example Consortium"])
        self.assertEqual(paper.published_date, date(2026, 4, 28))
        self.assertEqual(paper.journal_abbrev, "Nat Methods")
        self.assertEqual(paper.url, "https://example.org/paper")

    def test_resolve_doi_metadata_reports_not_found(self) -> None:
        with (
            patch.object(
                doi_source.httpx,
                "get",
                return_value=make_response("https://example.org", 404, {"message": {}}),
            ),
            patch.object(doi_source.openalex, "fetch_work_by_doi", return_value=None),
        ):
            with self.assertRaisesRegex(doi_source.DoiNotFoundError, "No metadata"):
                doi_source.resolve_doi_metadata("10.1234/missing")

    def test_resolve_doi_metadata_rejects_missing_required_fields(self) -> None:
        with (
            patch.object(
                doi_source.httpx,
                "get",
                return_value=make_response("https://example.org", 200, {"message": {"title": []}}),
            ),
            patch.object(doi_source.openalex, "fetch_work_by_doi", return_value=None),
        ):
            with self.assertRaisesRegex(doi_source.DoiMetadataError, "missing required fields"):
                doi_source.resolve_doi_metadata("10.1234/bad")

    def test_resolve_doi_metadata_retries_crossref_without_version_suffix(self) -> None:
        requested_urls: list[str] = []

        def fake_get(url: str, *, headers: dict, timeout: float) -> httpx.Response:
            requested_urls.append(url)
            if url.endswith("10.64898%2F2025.12.09.693073v3"):
                return make_response(url, 404, {"message": {}})
            if url.endswith("10.64898%2F2025.12.09.693073"):
                return make_response(url, 200, crossref_payload(title="Stripped DOI paper"))
            raise AssertionError(f"Unexpected Crossref URL: {url}")

        with (
            patch.object(doi_source.httpx, "get", side_effect=fake_get),
            patch.object(doi_source.openalex, "fetch_work_by_doi", return_value=None),
        ):
            resolution = doi_source.resolve_doi_metadata_with_warnings(
                "10.64898/2025.12.09.693073v3"
            )

        self.assertEqual(
            requested_urls,
            [
                f"{doi_source.CROSSREF_WORKS_API}/10.64898%2F2025.12.09.693073v3",
                f"{doi_source.CROSSREF_WORKS_API}/10.64898%2F2025.12.09.693073",
            ],
        )
        self.assertEqual(resolution.paper.external_id, "10.64898/2025.12.09.693073")
        self.assertIn(doi_source.WARNING_VERSION_STRIPPED, resolution.warnings)

    def test_resolve_doi_metadata_suggests_stripped_doi_when_all_providers_miss(self) -> None:
        with (
            patch.object(
                doi_source.httpx,
                "get",
                return_value=make_response("https://example.org", 404, {"message": {}}),
            ),
            patch.object(doi_source.openalex, "fetch_work_by_doi", return_value=None),
        ):
            with self.assertRaisesRegex(
                doi_source.DoiNotFoundError,
                "Try 10.64898/2025.12.09.693073 without the version suffix",
            ):
                doi_source.resolve_doi_metadata_with_warnings(
                    "10.64898/2025.12.09.693073v3"
                )

    def test_resolve_doi_metadata_uses_openalex_when_crossref_misses(self) -> None:
        openalex_paper = make_paper(
            source="openalex",
            external_id="10.48550/arxiv.2604.08316",
            title="OpenAlex arXiv paper",
            abstract="OpenAlex abstract",
        )

        with (
            patch.object(
                doi_source.httpx,
                "get",
                return_value=make_response("https://example.org", 404, {"message": {}}),
            ),
            patch.object(doi_source.openalex, "fetch_work_by_doi", return_value=openalex_paper) as openalex_fetch,
        ):
            resolution = doi_source.resolve_doi_metadata_with_warnings(
                "10.48550/arXiv.2604.08316"
            )

        openalex_fetch.assert_called_once_with("10.48550/arxiv.2604.08316")
        self.assertEqual(resolution.paper.source, "openalex")
        self.assertEqual(resolution.paper.title, "OpenAlex arXiv paper")
        self.assertEqual(resolution.paper.abstract, "OpenAlex abstract")

    def test_resolve_doi_metadata_fills_crossref_abstract_from_openalex(self) -> None:
        openalex_paper = make_paper(
            source="openalex",
            external_id="10.26434/chemrxiv.15001559/v1",
            title="OpenAlex title",
            abstract="OpenAlex abstract",
        )

        with (
            patch.object(
                doi_source.httpx,
                "get",
                return_value=make_response(
                    "https://example.org",
                    200,
                    crossref_payload(title="Crossref title", abstract=""),
                ),
            ),
            patch.object(doi_source.openalex, "fetch_work_by_doi", return_value=openalex_paper),
        ):
            resolution = doi_source.resolve_doi_metadata_with_warnings(
                "10.26434/chemrxiv.15001559/v1"
            )

        self.assertEqual(resolution.paper.source, "crossref")
        self.assertEqual(resolution.paper.title, "Crossref title")
        self.assertEqual(resolution.paper.abstract, "OpenAlex abstract")
        self.assertIn(doi_source.WARNING_ABSTRACT_FILLED_FROM_OPENALEX, resolution.warnings)

    def test_resolve_doi_metadata_warns_when_no_provider_has_abstract(self) -> None:
        with (
            patch.object(
                doi_source.httpx,
                "get",
                return_value=make_response(
                    "https://example.org",
                    200,
                    crossref_payload(title="Title only", abstract=""),
                ),
            ),
            patch.object(doi_source.openalex, "fetch_work_by_doi", return_value=None),
        ):
            resolution = doi_source.resolve_doi_metadata_with_warnings("10.1234/title-only")

        self.assertEqual(resolution.paper.title, "Title only")
        self.assertEqual(resolution.paper.abstract, "")
        self.assertIn(doi_source.WARNING_NO_ABSTRACT, resolution.warnings)


class PaperDoiIngestionApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.conn = make_conn(os.path.join(self.tmpdir.name, "claudesk.db"))
        init_db(self.conn)

    def tearDown(self) -> None:
        self.conn.close()
        self.tmpdir.cleanup()

    def test_add_paper_by_doi_creates_and_saves_new_paper(self) -> None:
        resolver_paper = make_paper(
            external_id="10.1234/new",
            title="New DOI paper",
        )

        with patch.object(
            paper_ingest,
            "resolve_doi_metadata_with_warnings",
            return_value=doi_source.DoiResolution(resolver_paper, (), "10.1234/new"),
        ) as resolver:
            result = papers_api.add_paper_by_doi(
                papers_api.DoiAddRequest(doi="https://doi.org/10.1234/NEW", save=True),
                conn=self.conn,
            )

        resolver.assert_called_once_with("10.1234/new")
        self.assertEqual(result["status"], "created")
        self.assertEqual(result["warnings"], [])
        stored = get_paper(self.conn, result["paper"]["id"])
        self.assertIsNotNone(stored)
        self.assertEqual(stored.external_id, "10.1234/new")
        self.assertEqual(stored.status, PaperStatus.SAVED)
        self.assertTrue(stored.is_saved)
        self.assertEqual(
            self.conn.execute("SELECT signal FROM feedback").fetchone()["signal"],
            "saved",
        )

    def test_add_paper_by_doi_returns_existing_without_status_or_link_mutation(self) -> None:
        existing_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/existing",
                title="Existing DOI paper",
                status=PaperStatus.DISMISSED,
                is_read=True,
            ),
        )
        note = create_note(
            self.conn,
            title="Existing note",
            body=f"See [paper](paper://{existing_id})",
            manual_paper_ids=[existing_id],
        )
        now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
        project_id = self.conn.execute(
            """
            INSERT INTO projects (slug, name, status, description, tags, created_at, updated_at)
            VALUES ('doi-project', 'DOI Project', 'active', '', '[]', ?, ?)
            """,
            (now, now),
        ).lastrowid
        self.conn.execute(
            "INSERT INTO project_papers (project_id, paper_id, role, created_at) VALUES (?, ?, 'relevant', ?)",
            (project_id, existing_id, now),
        )
        self.conn.execute(
            "INSERT INTO todos (title, description, status, priority, created_at) VALUES ('Read paper', ?, 'open', 'medium', ?)",
            (f"Read [paper](paper://{existing_id})", now),
        )
        self.conn.execute(
            """
            INSERT INTO log_entries (entry_type, entry_date, entry_markdown, linked_paper_ids, task_id, created_at)
            VALUES ('manual', '2026-04-29', ?, ?, NULL, ?)
            """,
            (f"Logged [paper](paper://{existing_id})", json.dumps([existing_id]), now),
        )
        session_id = create_chat_session(
            self.conn,
            runtime_settings=ChatRuntimeSettings(),
            title="DOI chat",
            linked_paper_ids=[existing_id],
            created_at=datetime.fromisoformat(now),
        ).id
        self.conn.execute(
            "INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, 'user', ?, ?)",
            (session_id, f"Discuss [paper](paper://{existing_id})", now),
        )

        with patch.object(
            paper_ingest,
            "resolve_doi_metadata_with_warnings",
            side_effect=AssertionError("unexpected fetch"),
        ), patch.object(
            paper_ingest,
            "fetch_openalex_metadata_for_doi",
            side_effect=AssertionError("unexpected OpenAlex enrichment"),
        ):
            result = papers_api.add_paper_by_doi(
                papers_api.DoiAddRequest(doi=" DOI:10.1234/EXISTING ", save=True),
                conn=self.conn,
            )

        self.assertEqual(result["status"], "existing")
        self.assertEqual(result["warnings"], [])
        self.assertEqual(result["paper"]["id"], existing_id)
        stored = get_paper(self.conn, existing_id)
        self.assertIsNotNone(stored)
        self.assertEqual(stored.status, PaperStatus.DISMISSED)
        self.assertFalse(stored.is_saved)
        self.assertTrue(stored.is_read)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0], 1)
        self.assertEqual(list_notes(self.conn, paper_id=existing_id)[0].id, note.id)
        self.assertEqual(
            self.conn.execute("SELECT paper_id FROM project_papers").fetchone()["paper_id"],
            existing_id,
        )
        self.assertIn(
            f"paper://{existing_id}",
            self.conn.execute("SELECT description FROM todos").fetchone()["description"],
        )
        self.assertEqual(
            json.loads(self.conn.execute("SELECT linked_paper_ids FROM log_entries").fetchone()[0]),
            [existing_id],
        )
        self.assertEqual(
            json.loads(self.conn.execute("SELECT linked_paper_ids FROM chat_sessions").fetchone()[0]),
            [existing_id],
        )
        self.assertIn(
            f"paper://{existing_id}",
            self.conn.execute("SELECT content FROM chat_messages").fetchone()["content"],
        )

    def test_add_existing_paper_by_doi_promotes_openalex_metadata_when_abstract_is_missing(self) -> None:
        existing_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/existing-empty",
                title="Existing empty abstract paper",
                abstract="",
                status=PaperStatus.SAVED,
                is_saved=True,
                is_to_read=True,
            ),
        )
        note = create_note(
            self.conn,
            title="Existing empty note",
            body=f"See paper://{existing_id}",
            manual_paper_ids=[existing_id],
        )
        insert_feedback(self.conn, existing_id, "saved")
        now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
        project_id = self.conn.execute(
            """
            INSERT INTO projects (slug, name, status, description, tags, created_at, updated_at)
            VALUES ('existing-empty', 'Existing Empty', 'active', '', '[]', ?, ?)
            """,
            (now, now),
        ).lastrowid
        self.conn.execute(
            "INSERT INTO project_papers (project_id, paper_id, role, created_at) VALUES (?, ?, 'relevant', ?)",
            (project_id, existing_id, now),
        )
        openalex_paper = make_paper(
            source="openalex",
            external_id="10.1234/existing-empty",
            title="OpenAlex enriched title",
            abstract="OpenAlex filled abstract",
        ).model_copy(update={
            "authors": ["OpenAlex Author"],
            "published_date": date(2026, 5, 1),
            "journal_abbrev": "ChemRxiv",
            "url": "https://example.org/openalex-enriched",
        })

        with patch.object(
            paper_ingest,
            "fetch_openalex_metadata_for_doi",
            return_value=doi_source.DoiMetadataEnrichment(
                paper=openalex_paper,
                warnings=(doi_source.WARNING_ABSTRACT_FILLED_FROM_OPENALEX,),
                resolved_doi="10.1234/existing-empty",
            ),
        ) as openalex_fetch, patch.object(
            paper_ingest,
            "resolve_doi_metadata_with_warnings",
            side_effect=AssertionError("unexpected Crossref resolver"),
        ):
            result = papers_api.add_paper_by_doi(
                papers_api.DoiAddRequest(doi="DOI:10.1234/EXISTING-EMPTY", save=True),
                conn=self.conn,
            )

        openalex_fetch.assert_called_once_with("10.1234/existing-empty")
        self.assertEqual(result["status"], "existing")
        self.assertEqual(result["paper"]["id"], existing_id)
        self.assertEqual(result["paper"]["source"], "openalex")
        self.assertEqual(result["paper"]["title"], "OpenAlex enriched title")
        self.assertEqual(result["paper"]["abstract"], "OpenAlex filled abstract")
        self.assertEqual(result["paper"]["authors"], ["OpenAlex Author"])
        self.assertEqual(result["paper"]["published_date"], date(2026, 5, 1))
        self.assertEqual(result["paper"]["journal_abbrev"], "ChemRxiv")
        self.assertEqual(result["paper"]["url"], "https://example.org/openalex-enriched")
        self.assertEqual(result["warnings"], [doi_source.WARNING_ABSTRACT_FILLED_FROM_OPENALEX])
        stored = get_paper(self.conn, existing_id)
        self.assertIsNotNone(stored)
        self.assertEqual(stored.source, "openalex")
        self.assertEqual(stored.title, "OpenAlex enriched title")
        self.assertEqual(stored.abstract, "OpenAlex filled abstract")
        self.assertEqual(stored.authors, ["OpenAlex Author"])
        self.assertEqual(stored.published_date, date(2026, 5, 1))
        self.assertEqual(stored.journal_abbrev, "ChemRxiv")
        self.assertEqual(stored.url, "https://example.org/openalex-enriched")
        self.assertEqual(stored.status, PaperStatus.SAVED)
        self.assertTrue(stored.is_saved)
        self.assertTrue(stored.is_to_read)
        self.assertEqual(list_notes(self.conn, paper_id=existing_id)[0].id, note.id)
        self.assertEqual(
            self.conn.execute("SELECT project_id FROM project_papers WHERE paper_id=?", (existing_id,)).fetchone()["project_id"],
            project_id,
        )
        self.assertEqual(
            self.conn.execute("SELECT signal FROM feedback WHERE paper_id=?", (existing_id,)).fetchone()["signal"],
            "saved",
        )

    def test_add_existing_paper_by_doi_keeps_empty_abstract_when_openalex_misses(self) -> None:
        existing_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/existing-no-abstract",
                title="Existing no abstract paper",
                abstract="",
            ),
        )

        with patch.object(
            paper_ingest,
            "fetch_openalex_metadata_for_doi",
            return_value=doi_source.DoiMetadataEnrichment(
                paper=None,
                warnings=(),
                resolved_doi=None,
            ),
        ) as openalex_fetch:
            result = papers_api.add_paper_by_doi(
                papers_api.DoiAddRequest(doi="10.1234/existing-no-abstract"),
                conn=self.conn,
            )

        openalex_fetch.assert_called_once_with("10.1234/existing-no-abstract")
        self.assertEqual(result["status"], "existing")
        self.assertEqual(result["paper"]["id"], existing_id)
        self.assertEqual(result["paper"]["source"], "crossref")
        self.assertEqual(result["paper"]["abstract"], "")
        self.assertEqual(result["warnings"], [doi_source.WARNING_NO_ABSTRACT])
        stored = get_paper(self.conn, existing_id)
        self.assertIsNotNone(stored)
        self.assertEqual(stored.source, "crossref")
        self.assertEqual(stored.abstract, "")

    def test_add_existing_versioned_doi_uses_openalex_stripped_abstract(self) -> None:
        versioned_doi = "10.64898/2025.12.09.693073v3"
        stripped_doi = "10.64898/2025.12.09.693073"
        existing_id = upsert_paper(
            self.conn,
            make_paper(
                external_id=versioned_doi,
                title="Existing versioned DOI paper",
                abstract="",
            ),
        )
        openalex_paper = make_paper(
            source="openalex",
            external_id=stripped_doi,
            title="OpenAlex stripped paper",
            abstract="Stripped OpenAlex abstract",
        )

        def fake_openalex(doi: str) -> Paper | None:
            if doi == versioned_doi:
                return None
            if doi == stripped_doi:
                return openalex_paper
            raise AssertionError(f"Unexpected OpenAlex DOI: {doi}")

        with patch.object(doi_source.openalex, "fetch_work_by_doi", side_effect=fake_openalex):
            result = papers_api.add_paper_by_doi(
                papers_api.DoiAddRequest(doi=versioned_doi),
                conn=self.conn,
            )

        self.assertEqual(result["status"], "existing")
        self.assertEqual(result["paper"]["id"], existing_id)
        self.assertEqual(result["paper"]["source"], "openalex")
        self.assertEqual(result["paper"]["title"], "OpenAlex stripped paper")
        self.assertEqual(result["paper"]["external_id"], versioned_doi)
        self.assertEqual(result["paper"]["abstract"], "Stripped OpenAlex abstract")
        self.assertEqual(
            result["warnings"],
            [
                doi_source.WARNING_VERSION_STRIPPED,
                doi_source.WARNING_ABSTRACT_FILLED_FROM_OPENALEX,
            ],
        )
        stored = get_paper(self.conn, existing_id)
        self.assertIsNotNone(stored)
        self.assertEqual(stored.source, "openalex")
        self.assertEqual(stored.external_id, versioned_doi)
        self.assertEqual(stored.title, "OpenAlex stripped paper")
        self.assertEqual(stored.abstract, "Stripped OpenAlex abstract")
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0], 1)

    def test_add_paper_by_doi_returns_title_duplicate_without_status_mutation(self) -> None:
        existing_id = upsert_paper(
            self.conn,
            make_paper(
                source="pubmed",
                external_id="pmid:123",
                title="A duplicate DOI paper",
                abstract="",
                status=PaperStatus.READ,
                is_read=True,
            ),
        )
        resolver_paper = make_paper(
            external_id="10.1234/duplicate",
            title="A duplicate DOI paper.",
            abstract="Backfilled abstract",
        )

        with patch.object(
            paper_ingest,
            "resolve_doi_metadata_with_warnings",
            return_value=doi_source.DoiResolution(resolver_paper, (), "10.1234/duplicate"),
        ):
            result = papers_api.add_paper_by_doi(
                papers_api.DoiAddRequest(doi="10.1234/duplicate", save=True),
                conn=self.conn,
            )

        self.assertEqual(result["status"], "duplicate")
        self.assertEqual(result["paper"]["id"], existing_id)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0], 1)
        stored = get_paper(self.conn, existing_id)
        self.assertIsNotNone(stored)
        self.assertEqual(stored.status, PaperStatus.READ)
        self.assertTrue(stored.is_read)
        self.assertFalse(stored.is_saved)
        self.assertEqual(stored.abstract, "Backfilled abstract")

    def test_add_paper_by_doi_returns_version_suffix_warning(self) -> None:
        resolver_paper = make_paper(
            external_id="10.64898/2025.12.09.693073",
            title="Version fallback paper",
        )

        with patch.object(
            paper_ingest,
            "resolve_doi_metadata_with_warnings",
            return_value=doi_source.DoiResolution(
                resolver_paper,
                (doi_source.WARNING_VERSION_STRIPPED,),
                "10.64898/2025.12.09.693073",
            ),
        ):
            result = papers_api.add_paper_by_doi(
                papers_api.DoiAddRequest(doi="10.64898/2025.12.09.693073v3"),
                conn=self.conn,
            )

        self.assertEqual(result["status"], "created")
        self.assertIn(doi_source.WARNING_VERSION_STRIPPED, result["warnings"])

    def test_add_paper_by_doi_returns_missing_abstract_warning(self) -> None:
        resolver_paper = make_paper(
            external_id="10.1234/no-abstract",
            title="No abstract paper",
            abstract="",
        )

        with patch.object(
            paper_ingest,
            "resolve_doi_metadata_with_warnings",
            return_value=doi_source.DoiResolution(
                resolver_paper,
                (doi_source.WARNING_NO_ABSTRACT,),
                "10.1234/no-abstract",
            ),
        ):
            result = papers_api.add_paper_by_doi(
                papers_api.DoiAddRequest(doi="10.1234/no-abstract"),
                conn=self.conn,
            )

        self.assertEqual(result["status"], "created")
        self.assertEqual(result["warnings"], [doi_source.WARNING_NO_ABSTRACT])

    def test_add_paper_by_doi_reports_invalid_doi(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            papers_api.add_paper_by_doi(
                papers_api.DoiAddRequest(doi="not a doi"),
                conn=self.conn,
            )

        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("Invalid DOI", str(ctx.exception.detail))

    def test_add_paper_by_doi_reports_metadata_failure_without_inserting(self) -> None:
        with patch.object(
            paper_ingest,
            "resolve_doi_metadata_with_warnings",
            side_effect=doi_source.DoiMetadataError("Failed to fetch DOI metadata."),
        ):
            with self.assertRaises(HTTPException) as ctx:
                papers_api.add_paper_by_doi(
                    papers_api.DoiAddRequest(doi="10.1234/missing"),
                    conn=self.conn,
                )

        self.assertEqual(ctx.exception.status_code, 502)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0], 0)

    def test_update_paper_abstract_persists_search_and_preserves_links(self) -> None:
        paper_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/manual-abstract",
                title="Manual abstract paper",
                abstract="",
                status=PaperStatus.SAVED,
                is_saved=True,
                is_to_read=True,
            ),
        )
        note = create_note(
            self.conn,
            title="Manual abstract note",
            body=f"Linked to paper://{paper_id}",
            manual_paper_ids=[paper_id],
        )
        now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
        project_id = self.conn.execute(
            """
            INSERT INTO projects (slug, name, status, description, tags, created_at, updated_at)
            VALUES ('abstract-project', 'Abstract Project', 'active', '', '[]', ?, ?)
            """,
            (now, now),
        ).lastrowid
        self.conn.execute(
            "INSERT INTO project_papers (project_id, paper_id, role, created_at) VALUES (?, ?, 'relevant', ?)",
            (project_id, paper_id, now),
        )

        result = papers_api.set_paper_abstract(
            paper_id,
            papers_api.AbstractUpdate(abstract="  Pasted chromatin mechanics abstract.  "),
            conn=self.conn,
        )

        self.assertEqual(result, {"ok": True, "abstract": "Pasted chromatin mechanics abstract."})
        stored = get_paper(self.conn, paper_id)
        self.assertIsNotNone(stored)
        self.assertEqual(stored.abstract, "Pasted chromatin mechanics abstract.")
        self.assertEqual(stored.status, PaperStatus.SAVED)
        self.assertTrue(stored.is_saved)
        self.assertTrue(stored.is_to_read)
        self.assertEqual(list_notes(self.conn, paper_id=paper_id)[0].id, note.id)
        self.assertEqual(
            self.conn.execute("SELECT project_id FROM project_papers WHERE paper_id=?", (paper_id,)).fetchone()["project_id"],
            project_id,
        )
        search_results = search_papers(self.conn, "chromatin mechanics")
        self.assertEqual([paper.id for paper in search_results], [paper_id])

    def test_update_paper_abstract_rejects_missing_paper(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            papers_api.set_paper_abstract(
                999,
                papers_api.AbstractUpdate(abstract="Missing paper abstract"),
                conn=self.conn,
            )

        self.assertEqual(ctx.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
