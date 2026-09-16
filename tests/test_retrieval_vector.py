from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

import numpy as np

from claudesk.core.config import clear_vault_location_cache, retrieval_index_root
from claudesk.core.db import init_db
from claudesk.core.db.assets import create_paper_asset, insert_asset_text_chunk
from claudesk.core.db.notes import create_note, update_note
from claudesk.core.db.papers import upsert_paper
from claudesk.core.db.projects import create_project
from claudesk.core.models import AssetKind, AssetParseStatus, Paper
from claudesk.core.retrieval import vector
from claudesk.core.retrieval.models import RetrievalSourceType
from claudesk.core.task_log_workflows import create_manual_log_from_text, create_task


def make_conn(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def make_paper() -> Paper:
    return Paper(
        source="biorxiv",
        external_id="10.1234/vector",
        title="Alpha semantic paper",
        abstract="Alpha paper embedding text.",
        authors=["Alice Vector"],
        published_date=date(2026, 6, 2),
        url="https://example.com/vector",
    )


def fake_embed(texts: list[str]) -> np.ndarray:
    vectors: list[list[float]] = []
    for text in texts:
        lowered = text.casefold()
        values = [0.0] * vector.EMBEDDING_DIMENSION
        if "alpha" in lowered:
            values[0] = 1.0
        elif "beta" in lowered:
            values[1] = 1.0
        elif "gamma" in lowered:
            values[2] = 1.0
        else:
            values[3] = 1.0
        vectors.append(values)
    return np.asarray(vectors, dtype=np.float32)


class FakeSearch:
    def __init__(self, rows: list[dict], query_vector: list[float] | None = None) -> None:
        self.rows = rows
        self.query_vector = query_vector
        self._limit = len(rows)
        self.where_expression: str | None = None
        self.where_prefilter: bool | None = None
        self.source_filter_values: set[str] | None = None

    def where(self, expression: str, *, prefilter: bool = False) -> "FakeSearch":
        self.where_expression = expression
        self.where_prefilter = prefilter
        if expression.startswith("source_type = "):
            self.source_filter_values = {_unquote_filter_value(expression.removeprefix("source_type = "))}
        elif expression.startswith("source_type IN (") and expression.endswith(")"):
            raw_values = expression.removeprefix("source_type IN (").removesuffix(")")
            self.source_filter_values = {
                _unquote_filter_value(raw_value.strip())
                for raw_value in raw_values.split(",")
                if raw_value.strip()
            }
        return self

    def limit(self, value: int) -> "FakeSearch":
        self._limit = value
        return self

    def to_list(self) -> list[dict]:
        rows = [dict(row) for row in self.rows]
        if self.source_filter_values is not None:
            rows = [
                row
                for row in rows
                if row.get("source_type") in self.source_filter_values
            ]
        if self.query_vector is not None:
            query = np.asarray(self.query_vector, dtype=np.float32)
            for row in rows:
                vector_value = np.asarray(row["vector"], dtype=np.float32)
                row["_distance"] = float(np.linalg.norm(vector_value - query))
            rows.sort(key=lambda row: (float(row["_distance"]), str(row["row_id"])))
        return rows[: self._limit]


class FakeTable:
    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows
        self.last_search: FakeSearch | None = None

    def search(self, query_vector: list[float] | None = None) -> FakeSearch:
        self.last_search = FakeSearch(self.rows, query_vector=query_vector)
        return self.last_search

    def count_rows(self) -> int:
        return len(self.rows)


class FakeLanceDb:
    def __init__(self) -> None:
        self.tables: dict[str, FakeTable] = {}

    def create_table(self, name: str, *, data: list[dict], mode: str) -> FakeTable:
        if mode != "overwrite":
            raise AssertionError(f"unexpected mode {mode}")
        table = FakeTable([dict(row) for row in data])
        self.tables[name] = table
        return table

    def open_table(self, name: str) -> FakeTable:
        if name not in self.tables:
            raise KeyError(name)
        return self.tables[name]

    def drop_table(self, name: str) -> None:
        self.tables.pop(name, None)


def _unquote_filter_value(value: str) -> str:
    if value.startswith("'") and value.endswith("'"):
        value = value[1:-1]
    return value.replace("''", "'")


class RetrievalVectorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.vault_dir = Path(self.tmpdir.name) / "vault"
        self.local_config = Path(self.tmpdir.name) / "local" / "local.yaml"
        self.env_patch = patch.dict(
            os.environ,
            {
                "CLAUDESK_DATA_DIR": str(self.vault_dir),
                "CLAUDESK_LOCAL_CONFIG": str(self.local_config),
            },
            clear=False,
        )
        self.env_patch.start()
        clear_vault_location_cache()
        self.vault_dir.mkdir(parents=True, exist_ok=True)
        self.conn = make_conn(str(self.vault_dir / "claudesk.db"))
        init_db(self.conn)
        self.fake_db = FakeLanceDb()

    def tearDown(self) -> None:
        self.conn.close()
        clear_vault_location_cache()
        self.env_patch.stop()
        self.tmpdir.cleanup()

    def test_retrieval_index_root_is_machine_local_not_vault_content(self) -> None:
        root = retrieval_index_root()

        self.assertNotEqual(root, self.vault_dir)
        self.assertNotIn(self.vault_dir.resolve(), root.parents)
        self.assertIn("retrieval-index", root.parts)

    def test_distance_to_score_rejects_non_finite_distances(self) -> None:
        self.assertEqual(vector._distance_to_score(float("nan")), 0.0)
        self.assertEqual(vector._distance_to_score(float("inf")), 0.0)
        self.assertEqual(vector._distance_to_score("-inf"), 0.0)

    def test_rebuild_status_search_and_full_rebuild_fallback(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        note = create_note(
            self.conn,
            title="Beta semantic note",
            body="Beta note embedding text.",
        )
        asset = create_paper_asset(
            self.conn,
            paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path=f"papers/{paper_id}/vector.pdf",
            original_filename="vector.pdf",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-vector",
            parse_status=AssetParseStatus.PARSED,
        )
        chunk = insert_asset_text_chunk(
            self.conn,
            asset_id=asset.id or 0,
            chunk_index=0,
            page_number=4,
            text="Gamma semantic PDF chunk.",
            section_path=["Results"],
        )
        project = create_project(
            self.conn,
            name="Delta semantic project",
            description="Delta project embedding text.",
        )
        task = create_task(
            self.conn,
            title="Epsilon semantic task",
            description="Epsilon task embedding text.",
            project_ids=[project.id or 0],
        )
        log = create_manual_log_from_text(
            self.conn,
            entry="Zeta semantic log\n\nZeta log embedding text.",
            project_ids=[project.id or 0],
        )
        self.conn.commit()

        with patch.object(vector, "_connect", return_value=self.fake_db):
            status = vector.rebuild_semantic_index(self.conn, embedder=fake_embed)
            hits = vector.search_semantic_index(self.conn, "beta query", embedder=fake_embed)

            self.assertTrue(status.fresh)
            self.assertEqual(status.source_count, 6)
            self.assertEqual(status.indexed_count, 6)
            self.assertEqual(hits[0].document.source_type, RetrievalSourceType.NOTE)
            self.assertEqual(hits[0].document.locator, {"note_id": note.id})

            task_hits = vector.search_semantic_index(
                self.conn,
                "epsilon query",
                source_types=(RetrievalSourceType.TASK,),
                limit=5,
                embedder=fake_embed,
            )
            table = self.fake_db.open_table(vector.TABLE_NAME)
            self.assertTrue(task_hits)
            self.assertTrue(all(hit.document.source_type == RetrievalSourceType.TASK for hit in task_hits))
            self.assertIsNotNone(table.last_search)
            self.assertEqual(table.last_search.where_expression, "source_type = 'task'")
            self.assertTrue(table.last_search.where_prefilter)

            note = update_note(
                self.conn,
                note.id or 0,
                body="Beta note embedding text changed.",
            )
            self.conn.commit()
            stale = vector.semantic_index_status(self.conn)
            self.assertEqual(stale.stale_count, 1)
            self.assertFalse(stale.fresh)

            refreshed = vector.update_semantic_index(self.conn, embedder=fake_embed)
            self.assertTrue(refreshed.fresh)
        self.assertEqual(refreshed.source_count, 6)

        rows = self.fake_db.open_table(vector.TABLE_NAME).rows
        pdf_row = next(row for row in rows if row["row_id"] == f"pdf_chunk:{paper_id}:{asset.id}:{chunk.id}")
        self.assertEqual(pdf_row["paper_id"], paper_id)
        self.assertEqual(pdf_row["asset_id"], asset.id)
        self.assertEqual(pdf_row["chunk_id"], chunk.id)
        self.assertEqual(pdf_row["page_number"], 4)
        self.assertEqual(pdf_row["embedding_model_name"], vector.MODEL_NAME)
        self.assertEqual(pdf_row["embedding_dimension"], vector.EMBEDDING_DIMENSION)
        project_row = next(row for row in rows if row["row_id"] == f"project:{project.id}")
        task_row = next(row for row in rows if row["row_id"] == f"task:{task.task_id}")
        log_row = next(row for row in rows if row["row_id"] == f"log:{log.entry_id}")
        self.assertEqual(project_row["project_id"], project.id)
        self.assertEqual(task_row["task_id"], task.task_id)
        self.assertEqual(log_row["log_entry_id"], log.entry_id)

    def test_status_detects_incompatible_embedding_metadata(self) -> None:
        upsert_paper(self.conn, make_paper())
        self.conn.commit()

        with patch.object(vector, "_connect", return_value=self.fake_db):
            vector.rebuild_semantic_index(self.conn, embedder=fake_embed)
            rows = self.fake_db.open_table(vector.TABLE_NAME).rows
            rows[0]["embedding_model_version"] = "old-model"

            status = vector.semantic_index_status(self.conn)

        self.assertEqual(status.incompatible_count, 1)
        self.assertFalse(status.fresh)

    def test_shared_pdf_asset_chunks_keep_paper_specific_row_ids(self) -> None:
        first_paper_id = upsert_paper(self.conn, make_paper())
        second_paper_id = upsert_paper(self.conn, Paper(
            source="biorxiv",
            external_id="10.1234/vector-shared",
            title="Shared semantic paper",
            abstract="Shared paper embedding text.",
            authors=["Alice Vector"],
            published_date=date(2026, 6, 3),
            url="https://example.com/vector-shared",
        ))
        asset = create_paper_asset(
            self.conn,
            first_paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path=f"papers/{first_paper_id}/shared.pdf",
            original_filename="shared.pdf",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-shared",
            parse_status=AssetParseStatus.PARSED,
        )
        chunk = insert_asset_text_chunk(
            self.conn,
            asset_id=asset.id or 0,
            chunk_index=0,
            page_number=2,
            text="Gamma shared chunk.",
        )
        self.conn.execute(
            "INSERT INTO paper_assets (paper_id, asset_id, created_at) VALUES (?, ?, ?)",
            (second_paper_id, asset.id, "2026-06-03T00:00:00"),
        )
        self.conn.commit()

        documents = vector.collect_semantic_documents(self.conn)
        pdf_documents = [
            document
            for document in documents
            if document.source_type == RetrievalSourceType.PDF_CHUNK
        ]

        self.assertEqual(
            sorted(document.row_id for document in pdf_documents),
            [
                f"pdf_chunk:{first_paper_id}:{asset.id}:{chunk.id}",
                f"pdf_chunk:{second_paper_id}:{asset.id}:{chunk.id}",
            ],
        )
        self.assertEqual(
            sorted(document.locator["paper_id"] for document in pdf_documents),
            [first_paper_id, second_paper_id],
        )

    def test_missing_index_does_not_embed_query(self) -> None:
        def fail_embed(texts: list[str]) -> np.ndarray:
            raise AssertionError("query should not be embedded before the index table opens")

        with patch.object(vector, "_connect", side_effect=vector.SemanticIndexUnavailable("missing")):
            with self.assertRaises(vector.SemanticIndexUnavailable):
                vector.search_semantic_index(self.conn, "alpha query", embedder=fail_embed)


if __name__ == "__main__":
    unittest.main()
