from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import tempfile
import textwrap
import unittest
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi import HTTPException

from claudesk.api import log as log_api
from claudesk.api import projects as projects_api
from claudesk.api import search as search_api
from claudesk.api import todos as todos_api
from claudesk.core.db import init_db
from claudesk.core.db.assets import (
    create_paper_asset,
    insert_asset_text_chunk,
)
from claudesk.core.db.notes import create_note
from claudesk.core.db.papers import upsert_paper
from claudesk.core.db.projects import create_project, link_project_paper
from claudesk.core.db.tasks import complete_todo
from claudesk.core.models import AssetKind, AssetParseStatus, Paper
from claudesk.core.retrieval import (
    RetrievalBackend,
    RetrievalEvidenceLocator,
    RetrievalHit,
    RetrievalQuery,
    RetrievalRequest,
    RetrievalScoreMetadata,
    RetrievalSourceType,
    RetrievalSnippet,
    fuse_hits,
    retrieve,
    search_pdf_chunks,
)
from claudesk.core.retrieval.vector import (
    SemanticDocument,
    SemanticIndexStatus,
    SemanticIndexUnavailable,
    SemanticSearchHit,
    TABLE_NAME,
)
from claudesk.core.task_log_workflows import (
    create_subtask,
    create_manual_log_from_text,
    create_task,
    update_task_fields,
)


def make_conn(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def make_paper(
    *,
    external_id: str = "10.1234/retrieval",
    title: str = "Retrieval paper",
    abstract: str = "Retrieval abstract",
) -> Paper:
    return Paper(
        source="biorxiv",
        external_id=external_id,
        title=title,
        abstract=abstract,
        authors=["Alice Retrieval"],
        published_date=date(2026, 6, 1),
        url="https://example.com/retrieval",
    )


class RetrievalServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        _reset_search_api_semantic_index_state()
        self.tmpdir = tempfile.TemporaryDirectory()
        self.conn = make_conn(os.path.join(self.tmpdir.name, "claudesk.db"))
        init_db(self.conn)

    def tearDown(self) -> None:
        _reset_search_api_semantic_index_state()
        self.conn.close()
        self.tmpdir.cleanup()

    def test_empty_query_returns_no_hits(self) -> None:
        results = retrieve(self.conn, RetrievalRequest.from_text("   "))

        self.assertEqual(results.hits, ())
        self.assertTrue(results.query.is_empty)

    def test_query_parser_trims_and_tokenizes_terms(self) -> None:
        query = RetrievalQuery.parse("  Alpha-beta retrieval_42  ")

        self.assertEqual(query.text, "Alpha-beta retrieval_42")
        self.assertEqual(query.terms, ("alpha", "beta", "retrieval_42"))
        self.assertFalse(query.is_empty)

    def test_global_retrieval_wraps_existing_lexical_sources(self) -> None:
        paper_id = upsert_paper(
            self.conn,
            make_paper(
                title="Alpha chromatin paper",
                abstract="Polymer retrieval evidence.",
            ),
        )
        note = create_note(
            self.conn,
            title="Alpha note",
            body="Note retrieval evidence.",
        )
        task = create_task(
            self.conn,
            title="Alpha task",
            description="Task retrieval evidence.",
        )
        log = create_manual_log_from_text(
            self.conn,
            entry="Alpha log\n\nLog retrieval evidence.",
        )
        self.conn.commit()

        results = retrieve(
            self.conn,
            RetrievalRequest.from_text(
                "alpha",
                source_types=(
                    RetrievalSourceType.PAPER,
                    RetrievalSourceType.NOTE,
                    RetrievalSourceType.TASK,
                    RetrievalSourceType.LOG,
                ),
            ),
        )

        self.assertEqual(
            [hit.locator.paper_id for hit in results.hits_for(RetrievalSourceType.PAPER)],
            [paper_id],
        )
        self.assertEqual(
            [hit.locator.note_id for hit in results.hits_for(RetrievalSourceType.NOTE)],
            [note.id],
        )
        self.assertEqual(
            [hit.locator.task_id for hit in results.hits_for(RetrievalSourceType.TASK)],
            [task.task_id],
        )
        self.assertEqual(
            [hit.locator.log_entry_id for hit in results.hits_for(RetrievalSourceType.LOG)],
            [log.entry_id],
        )
        for hit in results.hits:
            self.assertEqual(hit.score.backend, RetrievalBackend.LEXICAL)
            self.assertEqual(hit.score.rank, 1)
            self.assertGreater(hit.score.normalized_score, 0)
            self.assertEqual(hit.score.fusion_score, hit.score.normalized_score)
            self.assertEqual(hit.score.contributing_backends, (RetrievalBackend.LEXICAL,))
            self.assertIn("Alpha", hit.snippet.text)

        paper_hit = results.hits_for(RetrievalSourceType.PAPER)[0]
        note_hit = results.hits_for(RetrievalSourceType.NOTE)[0]
        self.assertEqual(
            [field_score.field for field_score in paper_hit.score.field_scores],
            ["title", "authors", "abstract"],
        )
        self.assertEqual(paper_hit.score.field_matches, ("title",))
        self.assertEqual(
            [field_score.field for field_score in note_hit.score.field_scores],
            ["title", "body"],
        )
        self.assertEqual(note_hit.score.field_matches, ("title",))

    def test_lexical_search_keeps_exact_matches_before_relaxed_fallback(self) -> None:
        exact_note = create_note(
            self.conn,
            title="Exact alpha retrieval note",
            body="Strong exact text evidence.",
        )
        relaxed_note = create_note(
            self.conn,
            title="Exact alpha unrelated note",
            body="Relaxed fallback text evidence.",
        )
        self.conn.commit()

        results = retrieve(
            self.conn,
            RetrievalRequest.from_text(
                "exact alpha retrieval",
                source_types=(RetrievalSourceType.NOTE,),
                limit_per_source=2,
            ),
        )

        self.assertEqual(
            [hit.locator.note_id for hit in results.hits_for(RetrievalSourceType.NOTE)],
            [exact_note.id, relaxed_note.id],
        )

    def test_lexical_search_matches_incomplete_final_term_prefixes(self) -> None:
        note = create_note(
            self.conn,
            title="Prefix alpha retrieval note",
            body="Prefix fallback evidence.",
        )
        self.conn.commit()

        results = retrieve(
            self.conn,
            RetrievalRequest.from_text(
                "prefix alpha retrie",
                source_types=(RetrievalSourceType.NOTE,),
            ),
        )

        hits = results.hits_for(RetrievalSourceType.NOTE)
        self.assertEqual([hit.locator.note_id for hit in hits], [note.id])
        self.assertIn("retrieval", hits[0].snippet.text.casefold())

    def test_lexical_search_relaxes_one_missing_query_term(self) -> None:
        note = create_note(
            self.conn,
            title="Relaxed alpha note",
            body="Strong text evidence survives one missing term.",
        )
        self.conn.commit()

        results = retrieve(
            self.conn,
            RetrievalRequest.from_text(
                "relaxed absentterm",
                source_types=(RetrievalSourceType.NOTE,),
            ),
        )

        self.assertEqual(
            [hit.locator.note_id for hit in results.hits_for(RetrievalSourceType.NOTE)],
            [note.id],
        )

    def test_lexical_search_requires_short_terms_as_whole_tokens_in_relaxed_fallback(self) -> None:
        bad_note = create_note(
            self.conn,
            title="Chair safety protocol",
            body="Chair safety evidence.",
        )
        good_note = create_note(
            self.conn,
            title="AI safety protocol",
            body="Whole-token AI safety evidence.",
        )
        self.conn.commit()

        results = retrieve(
            self.conn,
            RetrievalRequest.from_text(
                "ai safety",
                source_types=(RetrievalSourceType.NOTE,),
                limit_per_source=10,
            ),
        )

        hit_ids = [hit.locator.note_id for hit in results.hits_for(RetrievalSourceType.NOTE)]
        self.assertIn(good_note.id, hit_ids)
        self.assertNotIn(bad_note.id, hit_ids)

    def test_lexical_search_candidate_pool_honors_large_requested_limit(self) -> None:
        for index in range(240):
            create_note(
                self.conn,
                title=f"Largepool retrieval candidate {index}",
                body="Shared largepool lexical evidence.",
            )
        self.conn.commit()

        results = retrieve(
            self.conn,
            RetrievalRequest.from_text(
                "largepool",
                source_types=(RetrievalSourceType.NOTE,),
                limit_per_source=225,
            ),
        )

        self.assertEqual(len(results.hits_for(RetrievalSourceType.NOTE)), 225)

    def test_lexical_search_admits_misspelled_terms_from_bounded_fts_candidates(self) -> None:
        task = create_task(
            self.conn,
            title="Typo tolerant retrieval task",
            description="Task text evidence.",
        )
        self.conn.commit()

        results = retrieve(
            self.conn,
            RetrievalRequest.from_text(
                "retrievel",
                source_types=(RetrievalSourceType.TASK,),
            ),
        )

        hits = results.hits_for(RetrievalSourceType.TASK)
        self.assertEqual([hit.locator.task_id for hit in hits], [task.task_id])
        self.assertIn("retrieval", hits[0].snippet.text.casefold())

    def test_pdf_lexical_search_grounds_fuzzy_snippets_in_matched_chunk_text(self) -> None:
        paper_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/pdf-fuzzy-snippet",
                title="PDF fuzzy snippet paper",
                abstract="PDF fuzzy snippet paper.",
            ),
        )
        asset = create_paper_asset(
            self.conn,
            paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path=f"papers/{paper_id}/fuzzy.pdf",
            original_filename="fuzzy.pdf",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-fuzzy-snippet",
            parse_status=AssetParseStatus.PARSED,
        )
        insert_asset_text_chunk(
            self.conn,
            asset_id=asset.id or 0,
            chunk_index=0,
            page_number=1,
            text="The concrete retrieval evidence appears in this PDF chunk.",
        )
        self.conn.commit()

        results = search_pdf_chunks(
            self.conn,
            "retrievel",
            paper_id=paper_id,
            asset_id=asset.id,
        )

        hits = results.hits_for(RetrievalSourceType.PDF_CHUNK)
        self.assertEqual(len(hits), 1)
        self.assertIn("retrieval evidence", hits[0].snippet.text.casefold())

    def test_api_lexical_default_does_not_import_embedding_stack(self) -> None:
        repo_root = Path(__file__).resolve().parents[1]
        env = os.environ.copy()
        env["PYTHONPATH"] = (
            str(repo_root)
            if not env.get("PYTHONPATH")
            else f"{repo_root}{os.pathsep}{env['PYTHONPATH']}"
        )
        script = textwrap.dedent("""
            import os
            import sqlite3
            import sys
            import tempfile
            from datetime import date

            from claudesk.api import search as search_api
            from claudesk.core.db import init_db
            from claudesk.core.db.papers import upsert_paper
            from claudesk.core.models import Paper

            assert "claudesk.core.retrieval.vector" not in sys.modules
            assert "claudesk.core.embeddings" not in sys.modules

            with tempfile.TemporaryDirectory() as tmpdir:
                conn = sqlite3.connect(os.path.join(tmpdir, "claudesk.db"))
                conn.row_factory = sqlite3.Row
                conn.execute("PRAGMA journal_mode=DELETE")
                conn.execute("PRAGMA foreign_keys=ON")
                init_db(conn)
                upsert_paper(
                    conn,
                    Paper(
                        source="biorxiv",
                        external_id="10.1234/no-vector",
                        title="Alpha lexical paper",
                        abstract="Fast local text retrieval.",
                        authors=["Alice Lexical"],
                        published_date=date(2026, 6, 1),
                        url="https://example.com/no-vector",
                    ),
                )
                conn.commit()
                payload = search_api.search("alpha", conn=conn)
                conn.close()

            assert [paper["title"] for paper in payload["papers"]] == ["Alpha lexical paper"]
            assert "claudesk.core.retrieval.vector" not in sys.modules
            assert "claudesk.core.embeddings" not in sys.modules
        """)
        completed = subprocess.run(
            [sys.executable, "-c", script],
            cwd=repo_root,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr or completed.stdout)

    def test_project_lexical_retrieval_uses_project_fts_fields(self) -> None:
        project = create_project(
            self.conn,
            name="HIPPS memory project",
            description="Chromatin mechanics notebook.",
            tags=["dense chromatin", "single molecule"],
            obsidian_note_path="Projects/HIPPS-DIMES.md",
        )
        self.conn.commit()

        tag_results = retrieve(
            self.conn,
            RetrievalRequest.from_text(
                "dense chromatin",
                source_types=(RetrievalSourceType.PROJECT,),
            ),
        )
        path_results = retrieve(
            self.conn,
            RetrievalRequest.from_text(
                "dimes",
                source_types=(RetrievalSourceType.PROJECT,),
            ),
        )

        self.assertEqual(
            [hit.locator.project_id for hit in tag_results.hits],
            [project.id],
        )
        self.assertEqual(
            [hit.locator.project_id for hit in path_results.hits],
            [project.id],
        )

    def test_log_lexical_retrieval_uses_task_display_fts(self) -> None:
        task = create_task(
            self.conn,
            title="Initial completed task",
            description="Original completed task body.",
        )
        create_subtask(
            self.conn,
            parent_id=task.task_id,
            title="Gelation checkpoint",
            description="Subtask evidence term.",
        )
        complete_todo(self.conn, task.task_id)
        self.conn.commit()

        subtask_results = retrieve(
            self.conn,
            RetrievalRequest.from_text(
                "gelation checkpoint",
                source_types=(RetrievalSourceType.LOG,),
            ),
        )
        self.assertEqual(len(subtask_results.hits), 1)
        log_entry_id = subtask_results.hits[0].locator.log_entry_id

        update_task_fields(
            self.conn,
            task.task_id,
            title="Refined diffusion task",
            description="Updated diffusion evidence.",
        )
        self.conn.commit()

        updated_results = retrieve(
            self.conn,
            RetrievalRequest.from_text(
                "refined diffusion",
                source_types=(RetrievalSourceType.LOG,),
            ),
        )
        stale_results = retrieve(
            self.conn,
            RetrievalRequest.from_text(
                "initial completed",
                source_types=(RetrievalSourceType.LOG,),
            ),
        )

        self.assertEqual(
            [hit.locator.log_entry_id for hit in updated_results.hits],
            [log_entry_id],
        )
        self.assertEqual(stale_results.hits, ())

    def test_migration_rebuilds_existing_project_and_log_fts_rows(self) -> None:
        legacy = make_conn(os.path.join(self.tmpdir.name, "legacy-search-fts.db"))
        try:
            init_db(legacy)
            legacy.executescript("""
                DROP TRIGGER IF EXISTS projects_ai;
                DROP TRIGGER IF EXISTS projects_ad;
                DROP TRIGGER IF EXISTS projects_au;
                DROP TRIGGER IF EXISTS log_entries_ai;
                DROP TRIGGER IF EXISTS log_entries_ad;
                DROP TRIGGER IF EXISTS log_entries_au;
                DROP TRIGGER IF EXISTS todos_log_fts_ai;
                DROP TRIGGER IF EXISTS todos_log_fts_ad;
                DROP TRIGGER IF EXISTS todos_log_fts_au;
                DROP TABLE IF EXISTS projects_fts;
                DROP TABLE IF EXISTS log_entries_fts;
                DELETE FROM schema_version;
                INSERT INTO schema_version (version) VALUES (34);
            """)
            project = create_project(
                legacy,
                name="Migration alpha project",
                description="Existing project row before FTS migration.",
            )
            log = create_manual_log_from_text(
                legacy,
                entry="Migration alpha log\n\nExisting log row before FTS migration.",
            )
            legacy.commit()

            init_db(legacy)
            payload = search_api.search("migration alpha", conn=legacy)

            self.assertEqual([item["id"] for item in payload["projects"]], [project.id])
            self.assertEqual([item["id"] for item in payload["log"]], [log.entry_id])
        finally:
            legacy.close()

    def test_pdf_chunk_retrieval_exposes_stable_locator(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = create_paper_asset(
            self.conn,
            paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path=f"papers/{paper_id}/retrieval.pdf",
            original_filename="retrieval.pdf",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-retrieval",
            parse_status=AssetParseStatus.PARSED,
        )
        chunk = insert_asset_text_chunk(
            self.conn,
            asset_id=asset.id or 0,
            chunk_index=3,
            page_number=7,
            text="Semantic foundations appear in this retrieval paragraph.",
            block_type="paragraph",
            section_path=["Methods", "Retrieval"],
            bbox=[10, 20, 110, 80],
            block_ids=[10, 11],
        )
        self.conn.commit()

        results = search_pdf_chunks(
            self.conn,
            "semantic retrieval",
            paper_id=paper_id,
            asset_id=asset.id or 0,
        )

        hits = results.hits_for(RetrievalSourceType.PDF_CHUNK)
        self.assertEqual(len(hits), 1)
        hit = hits[0]
        self.assertEqual(hit.payload.id, chunk.id)
        self.assertEqual(hit.locator.as_dict(), {
            "paper_id": paper_id,
            "asset_id": asset.id,
            "chunk_id": chunk.id,
            "chunk_index": 3,
            "page_number": 7,
            "section_path": ["Methods", "Retrieval"],
            "bbox": [10.0, 20.0, 110.0, 80.0],
            "block_ids": [10, 11],
        })
        self.assertEqual(hit.snippet.field, "text")
        self.assertIn("Semantic foundations", hit.snippet.text)
        self.assertEqual(
            [field_score.field for field_score in hit.score.field_scores],
            ["text", "page", "section"],
        )
        section_score = hit.score.field_scores[2]
        self.assertEqual(section_score.field, "section")
        self.assertEqual(section_score.matched_terms, ("retrieval",))

    def test_fusion_merges_duplicate_backend_hits_without_raw_scores(self) -> None:
        lexical = _hit(
            RetrievalSourceType.PAPER,
            "1",
            backend=RetrievalBackend.LEXICAL,
            rank=1,
        )
        semantic = _hit(
            RetrievalSourceType.PAPER,
            "1",
            backend=RetrievalBackend.SEMANTIC,
            rank=2,
        )
        note = _hit(
            RetrievalSourceType.NOTE,
            "5",
            backend=RetrievalBackend.LEXICAL,
            rank=1,
        )

        fused = fuse_hits([note, semantic, lexical])

        self.assertEqual([(hit.source_type, hit.source_id) for hit in fused], [
            (RetrievalSourceType.PAPER, "1"),
            (RetrievalSourceType.NOTE, "5"),
        ])
        self.assertEqual(fused[0].score.contributing_backends, (
            RetrievalBackend.LEXICAL,
            RetrievalBackend.SEMANTIC,
        ))
        self.assertGreater(fused[0].score.fusion_score, fused[1].score.fusion_score)
        self.assertIsNone(fused[0].score.backend_score)

    def test_semantic_backend_hydrates_sqlite_hits(self) -> None:
        paper_id = upsert_paper(
            self.conn,
            make_paper(
                title="Hydrated semantic paper",
                abstract="Stored canonical paper body.",
            ),
        )
        self.conn.commit()
        document = _semantic_document(
            RetrievalSourceType.PAPER,
            paper_id,
            locator={"paper_id": paper_id},
        )

        with _patched_semantic_hits(self.tmpdir.name, [document]):
            results = retrieve(
                self.conn,
                RetrievalRequest.from_text(
                    "neighbor embedding",
                    source_types=(RetrievalSourceType.PAPER,),
                    backends=(RetrievalBackend.SEMANTIC,),
                ),
            )

        hits = results.hits_for(RetrievalSourceType.PAPER)
        self.assertEqual([hit.payload.id for hit in hits], [paper_id])
        self.assertEqual(hits[0].score.backend, RetrievalBackend.SEMANTIC)
        self.assertEqual(hits[0].score.contributing_backends, (RetrievalBackend.SEMANTIC,))
        self.assertEqual(hits[0].payload.abstract, "Stored canonical paper body.")

    def test_semantic_backend_preserves_vector_score_metadata(self) -> None:
        paper_id = upsert_paper(
            self.conn,
            make_paper(
                title="Scored semantic paper",
                abstract="Stored semantic scoring body.",
            ),
        )
        self.conn.commit()
        document = _semantic_document(
            RetrievalSourceType.PAPER,
            paper_id,
            locator={"paper_id": paper_id},
        )

        with _patched_semantic_hits(self.tmpdir.name, [document], scores=[0.83]):
            results = retrieve(
                self.conn,
                RetrievalRequest.from_text(
                    "neighbor embedding",
                    source_types=(RetrievalSourceType.PAPER,),
                    backends=(RetrievalBackend.SEMANTIC,),
                ),
            )

        hits = results.hits_for(RetrievalSourceType.PAPER)
        self.assertEqual([hit.payload.id for hit in hits], [paper_id])
        self.assertEqual(hits[0].score.backend_score, 0.83)
        self.assertEqual(hits[0].score.normalized_score, 0.83)
        self.assertEqual(hits[0].score.fusion_score, 0.83)

    def test_semantic_backend_filters_low_absolute_score_noise(self) -> None:
        note = create_note(
            self.conn,
            title="Weak semantic note",
            body="Unrelated stored note body.",
        )
        self.conn.commit()
        document = _semantic_document(
            RetrievalSourceType.NOTE,
            note.id or 0,
            locator={"note_id": note.id},
        )

        with _patched_semantic_hits(self.tmpdir.name, [document], scores=[0.50]):
            results = retrieve(
                self.conn,
                RetrievalRequest.from_text(
                    "arbitrary weak query",
                    source_types=(RetrievalSourceType.NOTE,),
                    backends=(RetrievalBackend.SEMANTIC,),
                ),
            )

        self.assertEqual(results.hits, ())

    def test_semantic_backend_filters_non_finite_score_noise(self) -> None:
        note = create_note(
            self.conn,
            title="Malformed semantic note",
            body="Malformed vector score should not be trusted.",
        )
        self.conn.commit()
        document = _semantic_document(
            RetrievalSourceType.NOTE,
            note.id or 0,
            locator={"note_id": note.id},
        )

        with _patched_semantic_hits(self.tmpdir.name, [document], scores=[float("nan")]):
            results = retrieve(
                self.conn,
                RetrievalRequest.from_text(
                    "malformed semantic score",
                    source_types=(RetrievalSourceType.NOTE,),
                    backends=(RetrievalBackend.SEMANTIC,),
                ),
            )

        self.assertEqual(results.hits, ())

    def test_semantic_backend_filters_relative_tail_noise(self) -> None:
        first_paper_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/semantic-relative-first",
                title="Strong relative semantic paper",
                abstract="Strong semantic result body.",
            ),
        )
        second_paper_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/semantic-relative-second",
                title="Weak relative semantic paper",
                abstract="Weak semantic result body.",
            ),
        )
        self.conn.commit()
        documents = [
            _semantic_document(
                RetrievalSourceType.PAPER,
                first_paper_id,
                locator={"paper_id": first_paper_id},
            ),
            _semantic_document(
                RetrievalSourceType.PAPER,
                second_paper_id,
                locator={"paper_id": second_paper_id},
            ),
        ]

        with _patched_semantic_hits(self.tmpdir.name, documents, scores=[0.92, 0.75]):
            results = retrieve(
                self.conn,
                RetrievalRequest.from_text(
                    "semantic relative query",
                    source_types=(RetrievalSourceType.PAPER,),
                    backends=(RetrievalBackend.SEMANTIC,),
                ),
            )

        self.assertEqual([hit.payload.id for hit in results.hits], [first_paper_id])

    def test_hybrid_keeps_lexical_hit_when_semantic_noise_is_filtered(self) -> None:
        paper_id = upsert_paper(
            self.conn,
            make_paper(
                title="Hybrid noise alpha paper",
                abstract="Hybrid noise alpha lexical body.",
            ),
        )
        self.conn.commit()
        document = _semantic_document(
            RetrievalSourceType.PAPER,
            paper_id,
            locator={"paper_id": paper_id},
        )

        with _patched_semantic_hits(self.tmpdir.name, [document], scores=[0.50]):
            results = retrieve(
                self.conn,
                RetrievalRequest.from_text(
                    "hybrid noise alpha",
                    source_types=(RetrievalSourceType.PAPER,),
                    backends=(RetrievalBackend.LEXICAL, RetrievalBackend.SEMANTIC),
                ),
            )

        hits = results.hits_for(RetrievalSourceType.PAPER)
        self.assertEqual([hit.payload.id for hit in hits], [paper_id])
        self.assertEqual(hits[0].score.backend, RetrievalBackend.LEXICAL)
        self.assertEqual(hits[0].score.contributing_backends, (RetrievalBackend.LEXICAL,))

    def test_semantic_backend_hydrates_task_log_and_project_hits(self) -> None:
        project = create_project(self.conn, name="Hydrated semantic project")
        task = create_task(
            self.conn,
            title="Hydrated semantic task",
            description="Stored semantic task body.",
            project_ids=[project.id or 0],
        )
        log = create_manual_log_from_text(
            self.conn,
            entry="Hydrated semantic log\n\nStored semantic log body.",
            project_ids=[project.id or 0],
        )
        self.conn.commit()
        documents = [
            _semantic_document(
                RetrievalSourceType.PROJECT,
                project.id or 0,
                locator={"project_id": project.id},
            ),
            _semantic_document(
                RetrievalSourceType.TASK,
                task.task_id,
                locator={"task_id": task.task_id},
            ),
            _semantic_document(
                RetrievalSourceType.LOG,
                log.entry_id,
                locator={"log_entry_id": log.entry_id},
            ),
        ]

        with _patched_semantic_hits(self.tmpdir.name, documents):
            results = retrieve(
                self.conn,
                RetrievalRequest.from_text(
                    "neighbor embedding",
                    source_types=(
                        RetrievalSourceType.PROJECT,
                        RetrievalSourceType.TASK,
                        RetrievalSourceType.LOG,
                    ),
                    backends=(RetrievalBackend.SEMANTIC,),
                ),
            )

        self.assertEqual(
            [hit.payload.id for hit in results.hits_for(RetrievalSourceType.PROJECT)],
            [project.id],
        )
        self.assertEqual(
            [hit.payload.id for hit in results.hits_for(RetrievalSourceType.TASK)],
            [task.task_id],
        )
        self.assertEqual(
            [hit.payload.id for hit in results.hits_for(RetrievalSourceType.LOG)],
            [log.entry_id],
        )
        for hit in results.hits:
            self.assertEqual(hit.score.backend, RetrievalBackend.SEMANTIC)

    def test_hybrid_retrieval_fuses_lexical_and_semantic_hits(self) -> None:
        paper_id = upsert_paper(
            self.conn,
            make_paper(
                title="Hybrid alpha paper",
                abstract="Hybrid alpha lexical body.",
            ),
        )
        self.conn.commit()
        document = _semantic_document(
            RetrievalSourceType.PAPER,
            paper_id,
            locator={"paper_id": paper_id},
        )

        with _patched_semantic_hits(self.tmpdir.name, [document]):
            results = retrieve(
                self.conn,
                RetrievalRequest.from_text(
                    "hybrid alpha",
                    source_types=(RetrievalSourceType.PAPER,),
                    backends=(RetrievalBackend.LEXICAL, RetrievalBackend.SEMANTIC),
                ),
            )

        hits = results.hits_for(RetrievalSourceType.PAPER)
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0].payload.id, paper_id)
        self.assertEqual(hits[0].score.contributing_backends, (
            RetrievalBackend.LEXICAL,
            RetrievalBackend.SEMANTIC,
        ))
        self.assertGreater(hits[0].score.fusion_score, hits[0].score.normalized_score)

    def test_missing_semantic_index_falls_back_to_lexical_hits(self) -> None:
        paper_id = upsert_paper(
            self.conn,
            make_paper(
                title="Fallback alpha paper",
                abstract="Fallback alpha body.",
            ),
        )
        self.conn.commit()
        status = _semantic_status(self.tmpdir.name, indexed_count=1)

        with patch("claudesk.core.retrieval.vector.semantic_index_status", return_value=status), \
                patch(
                    "claudesk.core.retrieval.vector.search_semantic_index",
                    side_effect=SemanticIndexUnavailable("missing"),
                ):
            hybrid = retrieve(
                self.conn,
                RetrievalRequest.from_text(
                    "fallback alpha",
                    source_types=(RetrievalSourceType.PAPER,),
                    backends=(RetrievalBackend.LEXICAL, RetrievalBackend.SEMANTIC),
                ),
            )
            semantic_only = retrieve(
                self.conn,
                RetrievalRequest.from_text(
                    "fallback alpha",
                    source_types=(RetrievalSourceType.PAPER,),
                    backends=(RetrievalBackend.SEMANTIC,),
                ),
            )

        self.assertEqual([hit.payload.id for hit in hybrid.hits], [paper_id])
        self.assertEqual(hybrid.hits[0].score.contributing_backends, (RetrievalBackend.LEXICAL,))
        self.assertEqual(semantic_only.hits, ())

    def test_semantic_retrieval_uses_bounded_candidate_limit_without_status_scan(self) -> None:
        paper_id = upsert_paper(
            self.conn,
            make_paper(
                title="Bounded semantic paper",
                abstract="Bounded semantic body.",
            ),
        )
        self.conn.commit()
        document = _semantic_document(
            RetrievalSourceType.PAPER,
            paper_id,
            locator={"paper_id": paper_id},
        )
        captured: dict[str, object] = {}

        def fake_search_semantic_index(conn, query, *, limit, source_types, **kwargs):
            captured["limit"] = limit
            captured["source_types"] = source_types
            return [SemanticSearchHit(document=document, score=1.0)]

        with patch(
            "claudesk.core.retrieval.vector.semantic_index_status",
            side_effect=AssertionError("semantic index status should not size candidates"),
        ), patch(
            "claudesk.core.retrieval.vector.search_semantic_index",
            side_effect=fake_search_semantic_index,
        ):
            results = retrieve(
                self.conn,
                RetrievalRequest.from_text(
                    "bounded semantic",
                    source_types=(RetrievalSourceType.PAPER,),
                    limit_per_source=500,
                    backends=(RetrievalBackend.SEMANTIC,),
                ),
            )

        self.assertEqual([hit.payload.id for hit in results.hits], [paper_id])
        self.assertEqual(captured["limit"], 200)
        self.assertEqual(captured["source_types"], (RetrievalSourceType.PAPER,))

    def test_semantic_pdf_backend_hydrates_chunk_locator(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = create_paper_asset(
            self.conn,
            paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path=f"papers/{paper_id}/semantic.pdf",
            original_filename="semantic.pdf",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-semantic-pdf",
            parse_status=AssetParseStatus.PARSED,
        )
        chunk = insert_asset_text_chunk(
            self.conn,
            asset_id=asset.id or 0,
            chunk_index=2,
            page_number=5,
            text="Canonical semantic PDF evidence.",
            section_path=["Results"],
        )
        self.conn.commit()
        document = _semantic_document(
            RetrievalSourceType.PDF_CHUNK,
            f"{paper_id}:{asset.id}:{chunk.id}",
            locator={
                "paper_id": paper_id,
                "asset_id": asset.id,
                "chunk_id": chunk.id,
                "chunk_index": 2,
                "page_number": 5,
                "section_path": ["Results"],
            },
        )

        with _patched_semantic_hits(self.tmpdir.name, [document]):
            results = search_pdf_chunks(
                self.conn,
                "embedding neighbor",
                paper_id=paper_id,
                asset_id=asset.id or 0,
                backends=(RetrievalBackend.SEMANTIC,),
            )

        hits = results.hits_for(RetrievalSourceType.PDF_CHUNK)
        self.assertEqual([hit.payload.id for hit in hits], [chunk.id])
        self.assertEqual(hits[0].score.backend, RetrievalBackend.SEMANTIC)
        self.assertEqual(hits[0].locator.as_dict(), {
            "paper_id": paper_id,
            "asset_id": asset.id,
            "chunk_id": chunk.id,
            "chunk_index": 2,
            "page_number": 5,
            "section_path": ["Results"],
        })

    def test_semantic_pdf_backend_rejects_stale_unlinked_locator(self) -> None:
        linked_paper_id = upsert_paper(self.conn, make_paper())
        stale_paper_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/stale-semantic-pdf",
                title="Stale semantic PDF paper",
                abstract="Stale semantic PDF paper.",
            ),
        )
        asset = create_paper_asset(
            self.conn,
            linked_paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path=f"papers/{linked_paper_id}/semantic-stale.pdf",
            original_filename="semantic-stale.pdf",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-semantic-stale",
            parse_status=AssetParseStatus.PARSED,
        )
        chunk = insert_asset_text_chunk(
            self.conn,
            asset_id=asset.id or 0,
            chunk_index=0,
            page_number=1,
            text="Stale semantic PDF evidence.",
        )
        self.conn.commit()
        document = _semantic_document(
            RetrievalSourceType.PDF_CHUNK,
            f"{stale_paper_id}:{asset.id}:{chunk.id}",
            locator={
                "paper_id": stale_paper_id,
                "asset_id": asset.id,
                "chunk_id": chunk.id,
                "chunk_index": 0,
                "page_number": 1,
            },
        )

        with _patched_semantic_hits(self.tmpdir.name, [document]):
            global_results = retrieve(
                self.conn,
                RetrievalRequest.from_text(
                    "embedding neighbor",
                    source_types=(RetrievalSourceType.PDF_CHUNK,),
                    backends=(RetrievalBackend.SEMANTIC,),
                ),
            )
            stale_paper_results = search_pdf_chunks(
                self.conn,
                "embedding neighbor",
                paper_id=stale_paper_id,
                asset_id=asset.id or 0,
                backends=(RetrievalBackend.SEMANTIC,),
            )

        self.assertEqual(global_results.hits, ())
        self.assertEqual(stale_paper_results.hits, ())

    def test_api_search_applies_default_log_limit(self) -> None:
        for index in range(55):
            create_manual_log_from_text(
                self.conn,
                entry=f"Alpha retrieval log {index}\n\nLong-running retrieval trace.",
            )
        self.conn.commit()

        payload = search_api.search("alpha retrieval", conn=self.conn)

        self.assertEqual(len(payload["log"]), 50)

    def test_api_search_applies_log_limit(self) -> None:
        for index in range(3):
            create_manual_log_from_text(
                self.conn,
                entry=f"Limited alpha retrieval log {index}\n\nBounded retrieval trace.",
            )
        self.conn.commit()

        payload = search_api.search(
            "limited alpha retrieval",
            result_type="log",
            limit=1,
            conn=self.conn,
        )

        self.assertEqual(len(payload["log"]), 1)
        self.assertEqual(payload["papers"], [])
        self.assertEqual(payload["notes"], [])
        self.assertEqual(payload["projects"], [])
        self.assertEqual(payload["tasks"], [])

    def test_api_search_accepts_semantic_backend_without_shape_change(self) -> None:
        paper_id = upsert_paper(
            self.conn,
            make_paper(
                title="API semantic paper",
                abstract="API canonical semantic body.",
            ),
        )
        self.conn.commit()
        document = _semantic_document(
            RetrievalSourceType.PAPER,
            paper_id,
            locator={"paper_id": paper_id},
        )

        with _patched_semantic_hits(self.tmpdir.name, [document]):
            payload = search_api.search("embedding neighbor", backend="semantic", conn=self.conn)

        self.assertEqual(sorted(payload.keys()), ["log", "notes", "papers", "projects", "tasks"])
        self.assertEqual([paper["id"] for paper in payload["papers"]], [paper_id])
        self.assertEqual(payload["notes"], [])
        self.assertEqual(payload["projects"], [])
        self.assertEqual(payload["tasks"], [])
        self.assertEqual(payload["log"], [])

    def test_api_search_filters_result_types(self) -> None:
        project = create_project(
            self.conn,
            name="API filter alpha project",
            description="API filter alpha project body.",
        )
        paper_id = upsert_paper(
            self.conn,
            make_paper(
                title="API filter alpha paper",
                abstract="API filter alpha paper body.",
            ),
        )
        note = create_note(
            self.conn,
            title="API filter alpha note",
            body="API filter alpha note body.",
        )
        task = create_task(
            self.conn,
            title="API filter alpha task",
            description="API filter alpha task body.",
        )
        log = create_manual_log_from_text(
            self.conn,
            entry="API filter alpha log\n\nAPI filter alpha log body.",
        )
        self.conn.commit()

        default_payload = search_api.search("api filter alpha", conn=self.conn)
        papers_payload = search_api.search("api filter alpha", result_type="papers", conn=self.conn)
        notes_payload = search_api.search("api filter alpha", result_type="notes", conn=self.conn)
        projects_payload = search_api.search("api filter alpha", result_type="projects", conn=self.conn)
        tasks_payload = search_api.search("api filter alpha", result_type="tasks", conn=self.conn)
        log_payload = search_api.search("api filter alpha", result_type="log", conn=self.conn)
        multi_payload = search_api.search(
            "api filter alpha",
            result_type=["papers", "notes"],
            conn=self.conn,
        )

        self.assertNotIn("pdfs", default_payload)
        self.assertEqual([paper["id"] for paper in default_payload["papers"]], [paper_id])
        self.assertEqual([item["id"] for item in default_payload["notes"]], [note.id])
        self.assertEqual([item["id"] for item in default_payload["projects"]], [project.id])
        self.assertEqual([item["id"] for item in default_payload["tasks"]], [task.task_id])
        self.assertEqual([item["id"] for item in default_payload["log"]], [log.entry_id])

        self.assertEqual([paper["id"] for paper in papers_payload["papers"]], [paper_id])
        self.assertEqual(papers_payload["notes"], [])
        self.assertEqual(papers_payload["projects"], [])
        self.assertEqual(papers_payload["tasks"], [])
        self.assertEqual(papers_payload["log"], [])
        self.assertNotIn("pdfs", papers_payload)

        self.assertEqual(notes_payload["papers"], [])
        self.assertEqual([item["id"] for item in notes_payload["notes"]], [note.id])
        self.assertEqual(notes_payload["projects"], [])
        self.assertEqual(notes_payload["tasks"], [])
        self.assertEqual(notes_payload["log"], [])
        self.assertNotIn("pdfs", notes_payload)

        self.assertEqual(projects_payload["papers"], [])
        self.assertEqual(projects_payload["notes"], [])
        self.assertEqual([item["id"] for item in projects_payload["projects"]], [project.id])
        self.assertEqual(projects_payload["tasks"], [])
        self.assertEqual(projects_payload["log"], [])

        self.assertEqual(tasks_payload["papers"], [])
        self.assertEqual(tasks_payload["notes"], [])
        self.assertEqual(tasks_payload["projects"], [])
        self.assertEqual([item["id"] for item in tasks_payload["tasks"]], [task.task_id])
        self.assertEqual(tasks_payload["log"], [])

        self.assertEqual(log_payload["papers"], [])
        self.assertEqual(log_payload["notes"], [])
        self.assertEqual(log_payload["projects"], [])
        self.assertEqual(log_payload["tasks"], [])
        self.assertEqual([item["id"] for item in log_payload["log"]], [log.entry_id])

        self.assertEqual([paper["id"] for paper in multi_payload["papers"]], [paper_id])
        self.assertEqual([item["id"] for item in multi_payload["notes"]], [note.id])
        self.assertEqual(multi_payload["projects"], [])
        self.assertEqual(multi_payload["tasks"], [])
        self.assertEqual(multi_payload["log"], [])
        self.assertNotIn("pdfs", multi_payload)

    def test_pane_list_endpoints_accept_backend_search_params(self) -> None:
        project = create_project(
            self.conn,
            name="Pane search alpha project",
            description="Pane search alpha project body.",
        )
        task = create_task(
            self.conn,
            title="Pane search alpha task",
            description="Pane search alpha task body.",
            project_ids=[project.id or 0],
        )
        log = create_manual_log_from_text(
            self.conn,
            entry="Pane search alpha log\n\nPane search alpha log body.",
            project_ids=[project.id or 0],
        )
        self.conn.commit()

        project_payload = projects_api.get_projects(
            q="pane search alpha project",
            backend="lexical",
            conn=self.conn,
        )
        task_payload = todos_api.get_todos(
            status="open",
            project_id=project.id,
            nested=True,
            q="pane search alpha task",
            backend="lexical",
            conn=self.conn,
        )
        log_payload = log_api.get_log_entries(
            days=None,
            project_id=project.id,
            q="pane search alpha log",
            backend="lexical",
            conn=self.conn,
        )

        self.assertEqual([item["id"] for item in project_payload], [project.id])
        self.assertEqual([item["id"] for item in task_payload], [task.task_id])
        self.assertEqual([item["id"] for item in log_payload], [log.entry_id])

    def test_log_endpoint_query_mode_accepts_all_history_window(self) -> None:
        old_entry = create_manual_log_from_text(
            self.conn,
            entry="Pane search old alpha log\n\nHistorical pane-local search evidence.",
            entry_date=date.today() - timedelta(days=90),
        )
        recent_entry = create_manual_log_from_text(
            self.conn,
            entry="Recent unrelated log\n\nNo matching search terms.",
        )
        self.conn.commit()

        query_payload = log_api.get_log_entries(
            days=0,
            q="old alpha",
            backend="lexical",
            conn=self.conn,
        )
        explicit_window_payload = log_api.get_log_entries(
            days=30,
            q="old alpha",
            backend="lexical",
            conn=self.conn,
        )
        browse_payload = log_api.get_log_entries(
            days=0,
            conn=self.conn,
        )

        self.assertEqual([item["id"] for item in query_payload], [old_entry.entry_id])
        self.assertEqual(explicit_window_payload, [])
        self.assertEqual([item["id"] for item in browse_payload], [recent_entry.entry_id])

    def test_api_search_returns_narrow_pdf_payloads(self) -> None:
        paper_id = upsert_paper(
            self.conn,
            make_paper(
                title="API PDF alpha paper",
                abstract="API PDF alpha abstract.",
            ),
        )
        asset = create_paper_asset(
            self.conn,
            paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path=f"papers/{paper_id}/api-payload.pdf",
            original_filename="api-payload.pdf",
            display_name="Readable API payload PDF",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-api-payload",
            parse_status=AssetParseStatus.PARSED,
        )
        chunk = insert_asset_text_chunk(
            self.conn,
            asset_id=asset.id or 0,
            chunk_index=4,
            page_number=9,
            text="API PDF alpha payload " + ("bounded snippet evidence " * 20),
            block_type="paragraph",
            section_path=["Results", "Evidence"],
            bbox=[14, 24, 114, 84],
            block_ids=[7, 8],
        )
        self.conn.commit()

        payload = search_api.search("api pdf alpha payload", result_type="pdfs", conn=self.conn)

        self.assertEqual(payload["papers"], [])
        self.assertEqual(payload["notes"], [])
        self.assertEqual(payload["projects"], [])
        self.assertEqual(payload["tasks"], [])
        self.assertEqual(payload["log"], [])
        self.assertEqual(len(payload["pdfs"]), 1)
        pdf = payload["pdfs"][0]
        self.assertEqual(set(pdf), {
            "paper_id",
            "paper_title",
            "asset_id",
            "asset_display_name",
            "chunk_id",
            "chunk_index",
            "page_number",
            "section_path",
            "bbox",
            "block_ids",
            "snippet",
            "snippet_field",
            "snippet_start_char",
            "snippet_end_char",
            "snippet_truncated",
        })
        self.assertEqual(pdf["paper_id"], paper_id)
        self.assertEqual(pdf["paper_title"], "API PDF alpha paper")
        self.assertEqual(pdf["asset_id"], asset.id)
        self.assertEqual(pdf["asset_display_name"], "Readable API payload PDF")
        self.assertEqual(pdf["chunk_id"], chunk.id)
        self.assertEqual(pdf["chunk_index"], 4)
        self.assertEqual(pdf["page_number"], 9)
        self.assertEqual(pdf["section_path"], ["Results", "Evidence"])
        self.assertEqual(pdf["bbox"], [14.0, 24.0, 114.0, 84.0])
        self.assertEqual(pdf["block_ids"], [7, 8])
        self.assertEqual(pdf["snippet_field"], "text")
        self.assertIn("API PDF alpha payload", pdf["snippet"])
        self.assertTrue(pdf["snippet_truncated"])
        self.assertLessEqual(len(pdf["snippet"]), 246)

    def test_api_search_rejects_invalid_backend(self) -> None:
        with self.assertRaises(HTTPException) as exc:
            search_api.search("alpha", backend="invalid", conn=self.conn)

        self.assertEqual(exc.exception.status_code, 400)

    def test_api_search_rejects_invalid_type(self) -> None:
        with self.assertRaises(HTTPException) as exc:
            search_api.search("alpha", result_type="everything", conn=self.conn)

        self.assertEqual(exc.exception.status_code, 400)
        self.assertIn("Search type", str(exc.exception.detail))

        with self.assertRaises(HTTPException) as multi_exc:
            search_api.search("alpha", result_type=["papers", "everything"], conn=self.conn)

        self.assertEqual(multi_exc.exception.status_code, 400)
        self.assertIn("Search type", str(multi_exc.exception.detail))

    def test_semantic_index_status_surfaces_product_states(self) -> None:
        cases = [
            (
                "ready",
                _index_status(source_count=2, indexed_count=2),
            ),
            (
                "missing",
                _index_status(source_count=2, indexed_count=0, missing_count=2),
            ),
            (
                "stale",
                _index_status(source_count=2, indexed_count=3, stale_count=1),
            ),
            (
                "incompatible",
                _index_status(source_count=2, indexed_count=2, incompatible_count=1),
            ),
        ]
        for expected_state, status in cases:
            with self.subTest(expected_state=expected_state):
                _reset_search_api_semantic_index_state()
                vector = SimpleNamespace(semantic_index_status=lambda conn: status)
                with patch.object(search_api, "_semantic_vector", return_value=vector):
                    state = search_api.semantic_index_status(conn=self.conn)

                self.assertEqual(state.state, expected_state)
                self.assertFalse(state.running)
                self.assertEqual(state.source_count, status.source_count)
                self.assertEqual(state.indexed_count, status.indexed_count)

        with search_api._semantic_index_state_lock:
            search_api._semantic_index_state.running = True
            search_api._semantic_index_state.started_at = "2026-06-04T12:00:00"
            search_api._semantic_index_state.cached_status = cases[0][1]
        vector = SimpleNamespace(
            semantic_index_status=lambda conn: (_ for _ in ()).throw(
                AssertionError("running status should use cached counts")
            )
        )
        with patch.object(
            search_api,
            "_semantic_vector",
            return_value=vector,
        ):
            rebuilding = search_api.semantic_index_status(conn=self.conn)
        self.assertEqual(rebuilding.state, "rebuilding")
        self.assertTrue(rebuilding.running)
        self.assertEqual(rebuilding.source_count, cases[0][1].source_count)
        self.assertEqual(rebuilding.indexed_count, cases[0][1].indexed_count)

        _reset_search_api_semantic_index_state()
        with search_api._semantic_index_state_lock:
            search_api._semantic_index_state.last_error = "embedding model unavailable"
            search_api._semantic_index_state.finished_at = "2026-06-04T12:05:00"
        vector = SimpleNamespace(semantic_index_status=lambda conn: cases[0][1])
        with patch.object(search_api, "_semantic_vector", return_value=vector):
            failed = search_api.semantic_index_status(conn=self.conn)
        self.assertEqual(failed.state, "failed")
        self.assertEqual(failed.last_error, "embedding model unavailable")

    def test_semantic_index_rebuild_endpoint_starts_one_job(self) -> None:
        status = _index_status(source_count=3, indexed_count=0, missing_count=3)
        vector = SimpleNamespace(semantic_index_status=lambda conn: status)
        with (
            patch.object(search_api, "_semantic_vector", return_value=vector),
            patch.object(search_api, "_start_semantic_index_job") as start_mock,
        ):
            started = search_api.rebuild_semantic_index_api(conn=self.conn)
            duplicate = search_api.rebuild_semantic_index_api(conn=self.conn)

        self.assertEqual(started.state, "rebuilding")
        self.assertTrue(started.running)
        self.assertEqual(started.launch_state, "started")
        self.assertEqual(duplicate.launch_state, "already_running")
        start_mock.assert_called_once_with("rebuild")

    def test_semantic_index_update_endpoint_starts_update_job(self) -> None:
        status = _index_status(source_count=3, indexed_count=2, stale_count=1)
        vector = SimpleNamespace(semantic_index_status=lambda conn: status)
        with (
            patch.object(search_api, "_semantic_vector", return_value=vector),
            patch.object(search_api, "_start_semantic_index_job") as start_mock,
        ):
            started = search_api.update_semantic_index_api(conn=self.conn)

        self.assertEqual(started.state, "rebuilding")
        self.assertEqual(started.launch_state, "started")
        start_mock.assert_called_once_with("update")

    def test_semantic_index_launch_failure_records_failed_state(self) -> None:
        status = _index_status(source_count=3, indexed_count=0, missing_count=3)
        vector = SimpleNamespace(semantic_index_status=lambda conn: status)
        with (
            patch.object(search_api, "_semantic_vector", return_value=vector),
            patch.object(search_api, "_start_semantic_index_job", side_effect=RuntimeError("thread failed")),
            patch.object(search_api.logger, "exception") as log_mock,
        ):
            state = search_api.rebuild_semantic_index_api(conn=self.conn)

        self.assertEqual(state.launch_state, "started")
        self.assertEqual(state.state, "failed")
        self.assertFalse(state.running)
        self.assertEqual(state.last_error, search_api.SEMANTIC_INDEX_JOB_ERROR)
        log_mock.assert_called_once()

    def test_semantic_index_job_records_success_and_failure(self) -> None:
        class FakeConn:
            closed = False

            def close(self) -> None:
                self.closed = True

        success_conn = FakeConn()
        success_status = _index_status(source_count=1, indexed_count=1)
        rebuild_mock = Mock(return_value=success_status)
        success_vector = SimpleNamespace(rebuild_semantic_index=rebuild_mock)
        with (
            patch.object(search_api, "get_connection", return_value=success_conn),
            patch.object(search_api, "_semantic_vector", return_value=success_vector),
        ):
            with search_api._semantic_index_state_lock:
                search_api._semantic_index_state.running = True
            search_api._run_semantic_index_job("rebuild")

        rebuild_mock.assert_called_once_with(success_conn)
        self.assertTrue(success_conn.closed)
        with search_api._semantic_index_state_lock:
            self.assertFalse(search_api._semantic_index_state.running)
            self.assertIsNone(search_api._semantic_index_state.last_error)
        self.assertIsNotNone(search_api._semantic_index_state.finished_at)

        failed_conn = FakeConn()
        update_mock = Mock(side_effect=RuntimeError("index failed"))
        failed_vector = SimpleNamespace(update_semantic_index=update_mock)
        with (
            patch.object(search_api, "get_connection", return_value=failed_conn),
            patch.object(search_api, "_semantic_vector", return_value=failed_vector),
            patch.object(search_api.logger, "exception") as log_mock,
        ):
            with search_api._semantic_index_state_lock:
                search_api._semantic_index_state.running = True
            search_api._run_semantic_index_job("update")

        log_mock.assert_called_once()
        self.assertTrue(failed_conn.closed)
        with search_api._semantic_index_state_lock:
            self.assertFalse(search_api._semantic_index_state.running)
            self.assertEqual(
                search_api._semantic_index_state.last_error,
                search_api.SEMANTIC_INDEX_JOB_ERROR,
            )

    def test_core_project_scope_filters_all_current_sources(self) -> None:
        project = create_project(self.conn, name="Scoped Retrieval")
        included_paper_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/project-included",
                title="Project scoped alpha paper",
                abstract="Alpha scoped paper.",
            ),
        )
        excluded_paper_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/project-excluded",
                title="Project scoped alpha outsider",
                abstract="Alpha scoped outsider.",
            ),
        )
        link_project_paper(self.conn, project.id or 0, included_paper_id)
        included_note = create_note(
            self.conn,
            title="Project scoped alpha note",
            body="Alpha scoped note.",
            manual_paper_ids=[included_paper_id],
        )
        create_note(
            self.conn,
            title="Project scoped alpha other note",
            body="Alpha scoped other note.",
            manual_paper_ids=[excluded_paper_id],
        )
        task = create_task(
            self.conn,
            title="Project scoped alpha task",
            description="Alpha scoped task.",
            project_ids=[project.id or 0],
        )
        create_task(
            self.conn,
            title="Project scoped alpha other task",
            description="Alpha scoped other task.",
        )
        log = create_manual_log_from_text(
            self.conn,
            entry="Project scoped alpha log\n\nAlpha scoped log.",
            project_ids=[project.id or 0],
        )
        create_manual_log_from_text(
            self.conn,
            entry="Project scoped alpha other log\n\nAlpha scoped other log.",
        )
        asset = create_paper_asset(
            self.conn,
            included_paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path=f"papers/{included_paper_id}/scoped.pdf",
            original_filename="scoped.pdf",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-scoped",
            parse_status=AssetParseStatus.PARSED,
        )
        chunk = insert_asset_text_chunk(
            self.conn,
            asset_id=asset.id or 0,
            chunk_index=0,
            page_number=3,
            text="Project scoped alpha PDF chunk.",
        )
        self.conn.commit()

        results = retrieve(
            self.conn,
            RetrievalRequest.from_text(
                "project scoped alpha",
                source_types=(
                    RetrievalSourceType.PAPER,
                    RetrievalSourceType.NOTE,
                    RetrievalSourceType.TASK,
                    RetrievalSourceType.LOG,
                    RetrievalSourceType.PDF_CHUNK,
                ),
                project_id=project.id,
                asset_id=asset.id,
            ),
        )

        self.assertEqual(
            [hit.locator.paper_id for hit in results.hits_for(RetrievalSourceType.PAPER)],
            [included_paper_id],
        )
        self.assertEqual(
            [hit.locator.note_id for hit in results.hits_for(RetrievalSourceType.NOTE)],
            [included_note.id],
        )
        self.assertEqual(
            [hit.locator.task_id for hit in results.hits_for(RetrievalSourceType.TASK)],
            [task.task_id],
        )
        self.assertEqual(
            [hit.locator.log_entry_id for hit in results.hits_for(RetrievalSourceType.LOG)],
            [log.entry_id],
        )
        self.assertEqual(
            [hit.locator.chunk_id for hit in results.hits_for(RetrievalSourceType.PDF_CHUNK)],
            [chunk.id],
        )

    def test_source_type_and_paper_pdf_scopes_are_core_enforced(self) -> None:
        first_paper_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/scope-first",
                title="Scope alpha paper",
                abstract="Scope alpha paper.",
            ),
        )
        second_paper_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/scope-second",
                title="Scope alpha other paper",
                abstract="Scope alpha other paper.",
            ),
        )
        note = create_note(
            self.conn,
            title="Scope alpha note",
            body="Scope alpha note.",
            manual_paper_ids=[first_paper_id],
        )
        asset = create_paper_asset(
            self.conn,
            first_paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path=f"papers/{first_paper_id}/scope.pdf",
            original_filename="scope.pdf",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-scope",
            parse_status=AssetParseStatus.PARSED,
        )
        chunk = insert_asset_text_chunk(
            self.conn,
            asset_id=asset.id or 0,
            chunk_index=0,
            page_number=1,
            text="Scope alpha PDF chunk.",
        )
        self.conn.commit()

        paper_only = retrieve(
            self.conn,
            RetrievalRequest.from_text(
                "scope alpha",
                source_types=(RetrievalSourceType.PAPER,),
            ),
        )
        notes_only = retrieve(
            self.conn,
            RetrievalRequest.from_text(
                "scope alpha",
                source_types=(RetrievalSourceType.NOTE,),
                paper_id=first_paper_id,
            ),
        )
        pdf_only = retrieve(
            self.conn,
            RetrievalRequest.from_text(
                "scope alpha",
                source_types=(RetrievalSourceType.PDF_CHUNK,),
                paper_id=first_paper_id,
                asset_id=asset.id,
            ),
        )
        excluded_pdf = retrieve(
            self.conn,
            RetrievalRequest.from_text(
                "scope alpha",
                source_types=(RetrievalSourceType.PDF_CHUNK,),
                paper_id=second_paper_id,
                asset_id=asset.id,
            ),
        )

        self.assertEqual(
            {hit.source_type for hit in paper_only.hits},
            {RetrievalSourceType.PAPER},
        )
        self.assertEqual(
            [hit.locator.note_id for hit in notes_only.hits],
            [note.id],
        )
        self.assertEqual(
            [hit.locator.chunk_id for hit in pdf_only.hits],
            [chunk.id],
        )
        self.assertEqual(excluded_pdf.hits, ())

    def test_scoped_fts_filters_before_limit(self) -> None:
        project = create_project(self.conn, name="Late Scoped Retrieval")
        for index in range(55):
            upsert_paper(
                self.conn,
                make_paper(
                    external_id=f"10.1234/late-paper-{index}",
                    title=f"Late scoped alpha outsider paper {index}",
                    abstract="Late scoped alpha outsider.",
                ),
            )
            create_note(
                self.conn,
                title=f"Late scoped alpha outsider note {index}",
                body="Late scoped alpha outsider.",
            )
            create_task(
                self.conn,
                title=f"Late scoped alpha outsider task {index}",
                description="Late scoped alpha outsider.",
            )
        paper_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/late-paper-included",
                title="Late scoped alpha included paper",
                abstract="Late scoped alpha included.",
            ),
        )
        link_project_paper(self.conn, project.id or 0, paper_id)
        note = create_note(
            self.conn,
            title="Late scoped alpha included note",
            body="Late scoped alpha included.",
            manual_paper_ids=[paper_id],
        )
        task = create_task(
            self.conn,
            title="Late scoped alpha included task",
            description="Late scoped alpha included.",
            project_ids=[project.id or 0],
        )
        self.conn.commit()

        results = retrieve(
            self.conn,
            RetrievalRequest.from_text(
                "late scoped alpha",
                source_types=(
                    RetrievalSourceType.PAPER,
                    RetrievalSourceType.NOTE,
                    RetrievalSourceType.TASK,
                ),
                project_id=project.id,
                limit_per_source=10,
            ),
        )

        self.assertEqual(
            [hit.locator.paper_id for hit in results.hits_for(RetrievalSourceType.PAPER)],
            [paper_id],
        )
        self.assertEqual(
            [hit.locator.note_id for hit in results.hits_for(RetrievalSourceType.NOTE)],
            [note.id],
        )
        self.assertEqual(
            [hit.locator.task_id for hit in results.hits_for(RetrievalSourceType.TASK)],
            [task.task_id],
        )

    def test_pdfs_only_search_without_asset_id_searches_all_scoped_pdfs(self) -> None:
        first_paper_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/pdf-scope-first",
                title="PDF scope first",
                abstract="PDF scope first.",
            ),
        )
        second_paper_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/pdf-scope-second",
                title="PDF scope second",
                abstract="PDF scope second.",
            ),
        )
        first_asset = create_paper_asset(
            self.conn,
            first_paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path=f"papers/{first_paper_id}/first.pdf",
            original_filename="first.pdf",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-first",
            parse_status=AssetParseStatus.PARSED,
        )
        second_asset = create_paper_asset(
            self.conn,
            second_paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path=f"papers/{second_paper_id}/second.pdf",
            original_filename="second.pdf",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-second",
            parse_status=AssetParseStatus.PARSED,
        )
        first_chunk = insert_asset_text_chunk(
            self.conn,
            asset_id=first_asset.id or 0,
            chunk_index=0,
            page_number=1,
            text="Global PDF scope alpha first chunk.",
        )
        second_chunk = insert_asset_text_chunk(
            self.conn,
            asset_id=second_asset.id or 0,
            chunk_index=0,
            page_number=1,
            text="Global PDF scope alpha second chunk.",
        )
        self.conn.commit()

        global_results = retrieve(
            self.conn,
            RetrievalRequest.from_text(
                "global pdf scope alpha",
                source_types=(RetrievalSourceType.PDF_CHUNK,),
            ),
        )
        paper_results = retrieve(
            self.conn,
            RetrievalRequest.from_text(
                "global pdf scope alpha",
                source_types=(RetrievalSourceType.PDF_CHUNK,),
                paper_id=second_paper_id,
            ),
        )

        self.assertEqual(
            sorted(hit.locator.chunk_id for hit in global_results.hits),
            sorted([first_chunk.id, second_chunk.id]),
        )
        self.assertEqual(
            [hit.locator.chunk_id for hit in paper_results.hits],
            [second_chunk.id],
        )
        self.assertEqual(
            [hit.locator.paper_id for hit in paper_results.hits],
            [second_paper_id],
        )

    def test_shared_pdf_combined_paper_project_scope_uses_same_link_row(self) -> None:
        project = create_project(self.conn, name="Shared PDF Scope")
        first_paper_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/shared-scope-first",
                title="Shared scope first",
                abstract="Shared scope first.",
            ),
        )
        second_paper_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/shared-scope-second",
                title="Shared scope second",
                abstract="Shared scope second.",
            ),
        )
        link_project_paper(self.conn, project.id or 0, first_paper_id)
        asset = create_paper_asset(
            self.conn,
            first_paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path=f"papers/{first_paper_id}/shared-scope.pdf",
            original_filename="shared-scope.pdf",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-shared-scope",
            parse_status=AssetParseStatus.PARSED,
        )
        chunk = insert_asset_text_chunk(
            self.conn,
            asset_id=asset.id or 0,
            chunk_index=0,
            page_number=1,
            text="Shared PDF combined alpha scope.",
        )
        self.conn.execute(
            "INSERT INTO paper_assets (paper_id, asset_id, created_at) VALUES (?, ?, ?)",
            (second_paper_id, asset.id, "2026-06-03T00:00:00"),
        )
        self.conn.commit()

        matching = retrieve(
            self.conn,
            RetrievalRequest.from_text(
                "shared pdf combined alpha",
                source_types=(RetrievalSourceType.PDF_CHUNK,),
                paper_id=first_paper_id,
                project_id=project.id,
                asset_id=asset.id,
            ),
        )
        mismatched = retrieve(
            self.conn,
            RetrievalRequest.from_text(
                "shared pdf combined alpha",
                source_types=(RetrievalSourceType.PDF_CHUNK,),
                paper_id=second_paper_id,
                project_id=project.id,
                asset_id=asset.id,
            ),
        )

        self.assertEqual([hit.locator.chunk_id for hit in matching.hits], [chunk.id])
        self.assertEqual([hit.locator.paper_id for hit in matching.hits], [first_paper_id])
        self.assertEqual(mismatched.hits, ())

    def test_combined_note_paper_project_scope_uses_same_link_row(self) -> None:
        project = create_project(self.conn, name="Shared Note Scope")
        project_paper_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/shared-note-project",
                title="Shared note project paper",
                abstract="Shared note project.",
            ),
        )
        outside_paper_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/shared-note-outside",
                title="Shared note outside paper",
                abstract="Shared note outside.",
            ),
        )
        link_project_paper(self.conn, project.id or 0, project_paper_id)
        note = create_note(
            self.conn,
            title="Shared note combined alpha",
            body="Shared note combined alpha.",
            manual_paper_ids=[project_paper_id, outside_paper_id],
        )
        self.conn.commit()

        matching = retrieve(
            self.conn,
            RetrievalRequest.from_text(
                "shared note combined alpha",
                source_types=(RetrievalSourceType.NOTE,),
                paper_id=project_paper_id,
                project_id=project.id,
            ),
        )
        mismatched = retrieve(
            self.conn,
            RetrievalRequest.from_text(
                "shared note combined alpha",
                source_types=(RetrievalSourceType.NOTE,),
                paper_id=outside_paper_id,
                project_id=project.id,
            ),
        )

        self.assertEqual([hit.locator.note_id for hit in matching.hits], [note.id])
        self.assertEqual(mismatched.hits, ())

    def test_shared_pdf_global_search_keeps_distinct_paper_locators(self) -> None:
        first_paper_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/shared-pdf-global-first",
                title="Shared PDF global first",
                abstract="Shared PDF global first.",
            ),
        )
        second_paper_id = upsert_paper(
            self.conn,
            make_paper(
                external_id="10.1234/shared-pdf-global-second",
                title="Shared PDF global second",
                abstract="Shared PDF global second.",
            ),
        )
        asset = create_paper_asset(
            self.conn,
            first_paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path=f"papers/{first_paper_id}/shared-global.pdf",
            original_filename="shared-global.pdf",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-shared-global",
            parse_status=AssetParseStatus.PARSED,
        )
        chunk = insert_asset_text_chunk(
            self.conn,
            asset_id=asset.id or 0,
            chunk_index=0,
            page_number=1,
            text="Shared PDF global alpha locator.",
        )
        self.conn.execute(
            "INSERT INTO paper_assets (paper_id, asset_id, created_at) VALUES (?, ?, ?)",
            (second_paper_id, asset.id, "2026-06-03T00:00:00"),
        )
        self.conn.commit()

        results = retrieve(
            self.conn,
            RetrievalRequest.from_text(
                "shared pdf global alpha",
                source_types=(RetrievalSourceType.PDF_CHUNK,),
            ),
        )

        self.assertEqual(
            sorted((hit.locator.paper_id, hit.locator.chunk_id) for hit in results.hits),
            sorted([(first_paper_id, chunk.id), (second_paper_id, chunk.id)]),
        )
        self.assertEqual(
            sorted(hit.source_id for hit in results.hits),
            sorted([f"{first_paper_id}:{chunk.id}", f"{second_paper_id}:{chunk.id}"]),
        )


def _semantic_document(
    source_type: RetrievalSourceType,
    source_id: int | str,
    *,
    locator: dict,
) -> SemanticDocument:
    return SemanticDocument(
        row_id=f"{source_type.value}:{source_id}",
        source_type=source_type,
        source_id=str(source_id),
        title=f"{source_type.value} semantic result",
        text=f"{source_type.value} semantic text",
        locator=locator,
        updated_at="2026-06-04T00:00:00",
        content_hash=f"hash-{source_type.value}-{source_id}",
    )


def _semantic_status(tmpdir: str, *, indexed_count: int) -> SemanticIndexStatus:
    return SemanticIndexStatus(
        index_path=Path(tmpdir) / "semantic-index",
        table_name=TABLE_NAME,
        source_count=indexed_count,
        indexed_count=indexed_count,
        missing_count=0,
        stale_count=0,
        incompatible_count=0,
    )


def _reset_search_api_semantic_index_state() -> None:
    with search_api._semantic_index_state_lock:
        search_api._semantic_index_state = search_api._SemanticIndexJobState()
        search_api._semantic_index_thread = None


def _index_status(
    *,
    source_count: int,
    indexed_count: int,
    missing_count: int = 0,
    stale_count: int = 0,
    incompatible_count: int = 0,
) -> SemanticIndexStatus:
    return SemanticIndexStatus(
        index_path=Path("/tmp/claudesk-test-semantic-index"),
        table_name=TABLE_NAME,
        source_count=source_count,
        indexed_count=indexed_count,
        missing_count=missing_count,
        stale_count=stale_count,
        incompatible_count=incompatible_count,
    )


def _patched_semantic_hits(
    tmpdir: str,
    documents: list[SemanticDocument],
    *,
    scores: list[float] | None = None,
):
    status = _semantic_status(tmpdir, indexed_count=len(documents))
    hit_scores = scores if scores is not None else [1.0] * len(documents)
    hits = [
        SemanticSearchHit(document=document, score=score)
        for document, score in zip(documents, hit_scores, strict=True)
    ]
    return patch.multiple(
        "claudesk.core.retrieval.vector",
        semantic_index_status=lambda conn: status,
        search_semantic_index=lambda conn, query, *, limit, source_types, **kwargs: [
            hit for hit in hits if hit.document.source_type in set(source_types or ())
        ][:limit],
    )


def _hit(
    source_type: RetrievalSourceType,
    source_id: str,
    *,
    backend: RetrievalBackend,
    rank: int,
) -> RetrievalHit:
    score = 1.0 / (60 + rank)
    return RetrievalHit(
        source_type=source_type,
        source_id=source_id,
        title=f"{source_type.value} {source_id}",
        snippet=RetrievalSnippet(text="", field=""),
        score=RetrievalScoreMetadata(
            backend=backend,
            rank=rank,
            normalized_score=score,
            fusion_score=score,
            contributing_backends=(backend,),
        ),
        locator=RetrievalEvidenceLocator(),
        payload={},
    )


if __name__ == "__main__":
    unittest.main()
