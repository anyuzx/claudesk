from __future__ import annotations

import hashlib
import io
import json
import os
import sqlite3
import tempfile
import time
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from claudesk.api import papers as papers_api
from claudesk.api.main import app
from claudesk.core.config import Config, clear_vault_location_cache, paper_assets_root
from claudesk.core.config import load_config
from claudesk.core.db import (
    SCHEMA_VERSION,
    init_db,
)
from claudesk.core.db.assets import (
    count_asset_document_blocks,
    count_asset_parse_artifacts,
    count_asset_pdf_pages,
    create_paper_asset,
    create_asset_parse_artifact,
    delete_paper_asset,
    get_asset,
    get_paper_asset,
    insert_asset_document_block,
    insert_asset_text_chunk,
    list_asset_document_blocks,
    list_asset_parse_artifacts,
    list_asset_text_chunks,
    list_paper_assets,
    upsert_asset_pdf_page,
    update_asset_parse_state,
    update_paper_asset_display_name,
)
from claudesk.core.db.jobs import (
    create_job,
    get_active_job_by_kind_dedupe_key,
    get_job,
    get_latest_job_by_kind,
    list_job_events,
    list_job_failures,
    mark_job_running,
)
from claudesk.core.db.papers import (
    delete_paper,
    list_papers,
    upsert_paper,
)
from claudesk.core.models import AssetKind, AssetParseStatus, Paper
from claudesk.core.paper_assets import (
    AssetFileStatus,
    InvalidPaperAssetFile,
    asset_file_health,
    delete_managed_asset_file,
    resolve_managed_asset_path,
    safe_asset_filename,
    safe_paper_folder_name,
    store_managed_pdf_asset,
)
from claudesk.core.pdf_ingest_models import PdfIngestError
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
    external_id: str = "10.1234/assets",
    title: str = "Asset paper",
) -> Paper:
    return Paper(
        source=source,
        external_id=external_id,
        title=title,
        abstract="Asset abstract",
        authors=["Alice Example"],
        published_date=date(2026, 4, 30),
        url="https://example.com/assets",
    )


def make_pdf_asset(conn: sqlite3.Connection, paper_id: int, filename: str):
    return create_paper_asset(
        conn,
        paper_id,
        kind=AssetKind.PDF,
        source="manual",
        managed_path=f"papers/{paper_id}/{filename}",
        original_filename=filename,
        mime_type="application/pdf",
        size_bytes=128,
        content_hash=f"sha256-{filename}",
        parse_status=AssetParseStatus.NOT_PARSED,
    )


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


class PaperAssetDbTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmpdir.name, "claudesk.db")
        self.conn = make_conn(self.db_path)
        init_db(self.conn)

    def tearDown(self) -> None:
        self.conn.close()
        self.tmpdir.cleanup()

    def test_schema_creates_asset_tables_and_indexes(self) -> None:
        version = self.conn.execute(
            "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
        ).fetchone()[0]
        table_names = {
            row["name"]
            for row in self.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        index_names = {
            row["name"]
            for row in self.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='index'"
            ).fetchall()
        }

        self.assertEqual(version, SCHEMA_VERSION)
        self.assertIn("assets", table_names)
        self.assertIn("paper_assets", table_names)
        self.assertIn("note_assets", table_names)
        self.assertIn("asset_parse_artifacts", table_names)
        self.assertIn("asset_document_blocks", table_names)
        self.assertIn("idx_assets_kind", index_names)
        self.assertIn("idx_assets_content_hash", index_names)
        self.assertIn("idx_paper_assets_asset_id", index_names)
        self.assertIn("idx_note_assets_asset_id", index_names)
        self.assertIn("idx_asset_document_blocks_asset_page", index_names)
        self.assertIn("idx_asset_parse_artifacts_asset_kind", index_names)
        columns = {
            row["name"]
            for row in self.conn.execute("PRAGMA table_info(assets)").fetchall()
        }
        self.assertIn("display_name", columns)
        note_asset_columns = {
            row["name"]
            for row in self.conn.execute("PRAGMA table_info(note_assets)").fetchall()
        }
        self.assertIn("status", note_asset_columns)
        chunk_columns = {
            row["name"]
            for row in self.conn.execute("PRAGMA table_info(asset_text_chunks)").fetchall()
        }
        self.assertIn("block_type", chunk_columns)
        self.assertIn("section_path", chunk_columns)
        self.assertIn("bbox_json", chunk_columns)
        self.assertIn("block_ids", chunk_columns)

    def test_note_assets_status_migration_defaults_existing_rows(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "old-note-assets.sqlite"
            conn = make_conn(str(path))
            try:
                conn.executescript("""
                    CREATE TABLE note_assets (
                        note_id    INTEGER NOT NULL,
                        asset_id   INTEGER NOT NULL,
                        created_at TEXT NOT NULL,
                        PRIMARY KEY (note_id, asset_id)
                    );
                    INSERT INTO note_assets (note_id, asset_id, created_at)
                    VALUES (1, 2, '2026-06-03T00:00:00');
                """)

                init_db(conn)

                row = conn.execute(
                    "SELECT status FROM note_assets WHERE note_id=1 AND asset_id=2"
                ).fetchone()
                self.assertIsNotNone(row)
                self.assertEqual(row["status"], "committed")
            finally:
                conn.close()

    def test_structured_parse_rows_round_trip(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = make_pdf_asset(self.conn, paper_id, "structured.pdf")

        artifact = create_asset_parse_artifact(
            self.conn,
            asset_id=asset.id or 0,
            artifact_kind="normalized_json",
            parser_name="pymupdf",
            parser_version="test-v1",
            managed_path="derived/pdf-parse/1/normalized.json",
            mime_type="application/json",
            size_bytes=42,
            content_hash="hash",
        )
        block = insert_asset_document_block(
            self.conn,
            asset_id=asset.id or 0,
            block_index=0,
            page_number=1,
            block_type="paragraph",
            section_path=["Results"],
            text="Structured paragraph text.",
            bbox=[1, 2, 3, 4],
            metadata={"parser_ref": "p1"},
        )
        chunk = insert_asset_text_chunk(
            self.conn,
            asset_id=asset.id or 0,
            chunk_index=0,
            page_number=1,
            text="Structured paragraph text.",
            block_type=block.block_type,
            section_path=block.section_path,
            bbox=block.bbox,
            block_ids=[block.id or 0],
        )

        artifacts = list_asset_parse_artifacts(self.conn, asset.id or 0)
        blocks = list_asset_document_blocks(self.conn, asset.id or 0)
        chunks = list_asset_text_chunks(self.conn, asset.id or 0)

        self.assertEqual(artifacts[0].id, artifact.id)
        self.assertEqual(artifacts[0].artifact_kind, "normalized_json")
        self.assertEqual(blocks[0].id, block.id)
        self.assertEqual(blocks[0].section_path, ["Results"])
        self.assertEqual(blocks[0].bbox, [1.0, 2.0, 3.0, 4.0])
        self.assertEqual(blocks[0].metadata, {"parser_ref": "p1"})
        self.assertEqual(chunks[0].id, chunk.id)
        self.assertEqual(chunks[0].section_path, ["Results"])
        self.assertEqual(chunks[0].block_ids, [block.id])
        self.assertEqual(count_asset_parse_artifacts(self.conn, asset.id or 0), 1)
        self.assertEqual(count_asset_document_blocks(self.conn, asset.id or 0), 1)

    def test_migration_backfills_asset_display_name(self) -> None:
        self.conn.close()
        legacy_path = os.path.join(self.tmpdir.name, "legacy.db")
        legacy = make_conn(legacy_path)
        legacy.executescript("""
            CREATE TABLE schema_version (
                version INTEGER PRIMARY KEY
            );
            INSERT INTO schema_version (version) VALUES (16);
            CREATE TABLE assets (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                kind              TEXT NOT NULL,
                source            TEXT NOT NULL DEFAULT 'manual',
                managed_path      TEXT,
                original_filename TEXT NOT NULL,
                mime_type         TEXT NOT NULL DEFAULT '',
                size_bytes        INTEGER NOT NULL DEFAULT 0,
                content_hash      TEXT NOT NULL DEFAULT '',
                parse_status      TEXT NOT NULL DEFAULT 'not_parsed',
                parser_name       TEXT,
                parser_version    TEXT,
                source_asset_id   INTEGER,
                parsed_text       TEXT,
                parse_error       TEXT,
                parsed_at         TEXT,
                created_at        TEXT NOT NULL,
                updated_at        TEXT NOT NULL
            );
            INSERT INTO assets (
                kind, source, managed_path, original_filename, mime_type,
                size_bytes, content_hash, parse_status, created_at, updated_at
            )
            VALUES (
                'pdf', 'manual', 'papers/1/legacy.pdf', 'legacy.pdf',
                'application/pdf', 10, 'abc', 'not_parsed',
                '2026-04-30T00:00:00', '2026-04-30T00:00:00'
            );
        """)

        init_db(legacy)

        version = legacy.execute(
            "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
        ).fetchone()[0]
        row = legacy.execute("SELECT original_filename, display_name FROM assets").fetchone()
        self.assertEqual(version, SCHEMA_VERSION)
        self.assertEqual(row["display_name"], row["original_filename"])
        legacy.close()
        self.conn = make_conn(self.db_path)

    def test_paper_can_link_multiple_pdf_assets(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        first = make_pdf_asset(self.conn, paper_id, "first.pdf")
        second = make_pdf_asset(self.conn, paper_id, "second.pdf")
        self.conn.commit()

        assets = list_paper_assets(self.conn, paper_id)

        self.assertEqual([asset.id for asset in assets], [second.id, first.id])
        self.assertEqual([asset.kind for asset in assets], [AssetKind.PDF, AssetKind.PDF])
        self.assertEqual([asset.parse_status for asset in assets], [AssetParseStatus.NOT_PARSED, AssetParseStatus.NOT_PARSED])

    def test_paper_list_hydrates_pdf_status_summary(self) -> None:
        no_pdf_id = upsert_paper(
            self.conn,
            make_paper(external_id="10.1234/no-pdf", title="No PDF"),
        )
        available_id = upsert_paper(
            self.conn,
            make_paper(external_id="10.1234/available-pdf", title="Available PDF"),
        )
        make_pdf_asset(self.conn, available_id, "available.pdf")
        queued_id = upsert_paper(
            self.conn,
            make_paper(external_id="10.1234/queued-pdf", title="Queued PDF"),
        )
        queued_asset = make_pdf_asset(self.conn, queued_id, "queued.pdf")
        update_asset_parse_state(
            self.conn,
            queued_asset.id or 0,
            parse_status=AssetParseStatus.QUEUED,
        )
        failed_id = upsert_paper(
            self.conn,
            make_paper(external_id="10.1234/failed-pdf", title="Failed PDF"),
        )
        failed_asset = make_pdf_asset(self.conn, failed_id, "failed.pdf")
        update_asset_parse_state(
            self.conn,
            failed_asset.id or 0,
            parse_status=AssetParseStatus.FAILED,
        )
        mixed_id = upsert_paper(
            self.conn,
            make_paper(external_id="10.1234/mixed-pdf", title="Mixed PDF"),
        )
        make_pdf_asset(self.conn, mixed_id, "mixed-available.pdf")
        mixed_failed = make_pdf_asset(self.conn, mixed_id, "mixed-failed.pdf")
        update_asset_parse_state(
            self.conn,
            mixed_failed.id or 0,
            parse_status=AssetParseStatus.FAILED,
        )
        mixed_parsed = make_pdf_asset(self.conn, mixed_id, "mixed-parsed.pdf")
        update_asset_parse_state(
            self.conn,
            mixed_parsed.id or 0,
            parse_status=AssetParseStatus.PARSED,
            parser_name="pymupdf",
            parser_version="test-parser",
        )
        self.conn.commit()

        statuses = {paper.id: paper.pdf_status for paper in list_papers(self.conn)}

        self.assertEqual(statuses[no_pdf_id], "none")
        self.assertEqual(statuses[available_id], "available")
        self.assertEqual(statuses[queued_id], "queued")
        self.assertEqual(statuses[failed_id], "failed")
        self.assertEqual(statuses[mixed_id], "parsed")

    def test_assets_persist_after_reopening_database(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        created = make_pdf_asset(self.conn, paper_id, "persist.pdf")
        self.conn.commit()
        self.conn.close()

        self.conn = make_conn(self.db_path)
        init_db(self.conn)
        assets = list_paper_assets(self.conn, paper_id)

        self.assertEqual(len(assets), 1)
        self.assertEqual(assets[0].id, created.id)
        self.assertEqual(assets[0].original_filename, "persist.pdf")
        self.assertEqual(assets[0].display_name, "persist.pdf")
        self.assertEqual(assets[0].managed_path, f"papers/{paper_id}/persist.pdf")

    def test_update_paper_asset_display_name_preserves_file_metadata(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = make_pdf_asset(self.conn, paper_id, "rename.pdf")
        self.conn.commit()
        time.sleep(0.001)

        renamed = update_paper_asset_display_name(
            self.conn,
            paper_id,
            asset.id or 0,
            "  Display title.pdf  ",
        )

        self.assertEqual(renamed.display_name, "Display title.pdf")
        self.assertEqual(renamed.original_filename, "rename.pdf")
        self.assertEqual(renamed.managed_path, asset.managed_path)
        self.assertGreater(renamed.updated_at, asset.updated_at)

    def test_delete_paper_asset_removes_join_rows_and_orphan_metadata(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = make_pdf_asset(self.conn, paper_id, "delete.pdf")
        self.conn.commit()

        deleted, removed_metadata = delete_paper_asset(self.conn, paper_id, asset.id or 0)
        self.conn.commit()

        self.assertEqual(deleted.id, asset.id)
        self.assertTrue(removed_metadata)
        self.assertIsNone(get_paper_asset(self.conn, paper_id, asset.id or 0))
        self.assertIsNone(get_asset(self.conn, asset.id or 0))
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM paper_assets").fetchone()[0],
            0,
        )

    def test_delete_paper_removes_asset_links_and_orphan_metadata(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = make_pdf_asset(self.conn, paper_id, "paper-delete.pdf")
        self.conn.commit()

        delete_paper(self.conn, paper_id)
        self.conn.commit()

        self.assertIsNone(get_asset(self.conn, asset.id or 0))
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM paper_assets WHERE paper_id=?", (paper_id,)).fetchone()[0],
            0,
        )


class PaperAssetStorageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.data_dir_ctx = patched_data_dir(self.tmpdir.name)
        self.data_dir_ctx.__enter__()
        self.cfg = Config()

    def tearDown(self) -> None:
        self.data_dir_ctx.__exit__(None, None, None)
        self.tmpdir.cleanup()

    def test_store_managed_pdf_asset_writes_file_and_metadata(self) -> None:
        payload = b"%PDF-1.4\nexample\n%%EOF\n"

        stored = store_managed_pdf_asset(
            paper_id=42,
            paper_title="Example Title: α/β Cells",
            file_obj=io.BytesIO(payload),
            filename="example.pdf",
            mime_type="application/pdf",
            cfg=self.cfg,
        )

        path = resolve_managed_asset_path(stored.managed_path, cfg=self.cfg)
        self.assertTrue(path.exists())
        self.assertEqual(path.read_bytes(), payload)
        self.assertEqual(stored.size_bytes, len(payload))
        self.assertEqual(stored.content_hash, hashlib.sha256(payload).hexdigest())
        self.assertEqual(stored.original_filename, "example.pdf")
        self.assertEqual(Path(stored.managed_path).parts[:2], ("papers", "42-example-title-cells"))
        self.assertFalse(Path(stored.managed_path).is_absolute())

    def test_store_managed_pdf_asset_uses_vault_asset_root(self) -> None:
        payload = b"%PDF-1.4\nrelative\n%%EOF\n"
        with patched_data_dir(self.tmpdir.name):
            cfg = Config()
            stored = store_managed_pdf_asset(
                paper_id=42,
                paper_title="Portable Root",
                file_obj=io.BytesIO(payload),
                filename="portable.pdf",
                mime_type="application/pdf",
                cfg=cfg,
            )
            path = resolve_managed_asset_path(stored.managed_path, cfg=cfg)

        self.assertTrue(path.exists())
        self.assertEqual(path.read_bytes(), payload)
        self.assertEqual(path.parts[: len(Path(self.tmpdir.name).resolve().parts) + 1], (*Path(self.tmpdir.name).resolve().parts, "assets"))

    def test_store_managed_pdf_asset_sanitizes_unsafe_filename(self) -> None:
        stored = store_managed_pdf_asset(
            paper_id=7,
            paper_title="Unsafe / Paper: Title?",
            file_obj=io.BytesIO(b"%PDF-1.4\n"),
            filename="../../unsafe name?.PDF",
            mime_type="application/pdf",
            cfg=self.cfg,
        )

        filename = Path(stored.managed_path).name
        self.assertNotIn("..", filename)
        self.assertNotIn("?", filename)
        self.assertTrue(filename.endswith(".pdf"))
        self.assertEqual(stored.original_filename, "unsafe name?.PDF")

    def test_safe_asset_filename_has_pdf_extension(self) -> None:
        self.assertEqual(safe_asset_filename("../../a b?.PDF"), "a-b.pdf")
        self.assertEqual(safe_asset_filename(""), "paper.pdf")

    def test_safe_paper_folder_name_uses_id_and_sanitized_title(self) -> None:
        self.assertEqual(
            safe_paper_folder_name(12, "A New PDF: Local Assets / Storage"),
            "12-a-new-pdf-local-assets-storage",
        )
        self.assertEqual(safe_paper_folder_name(12, "αβ"), "12-untitled")

    def test_store_managed_pdf_asset_rejects_non_pdf_uploads(self) -> None:
        with self.assertRaisesRegex(InvalidPaperAssetFile, "Only PDF"):
            store_managed_pdf_asset(
                paper_id=1,
                file_obj=io.BytesIO(b"text"),
                filename="notes.txt",
                mime_type="application/pdf",
                cfg=self.cfg,
            )
        with self.assertRaisesRegex(InvalidPaperAssetFile, "Only PDF"):
            store_managed_pdf_asset(
                paper_id=1,
                file_obj=io.BytesIO(b"text"),
                filename="paper.pdf",
                mime_type="text/plain",
                cfg=self.cfg,
            )

    def test_delete_managed_asset_file_removes_file_and_allows_missing_file(self) -> None:
        stored = store_managed_pdf_asset(
            paper_id=3,
            file_obj=io.BytesIO(b"%PDF-1.4\n"),
            filename="delete.pdf",
            mime_type="application/pdf",
            cfg=self.cfg,
        )
        path = resolve_managed_asset_path(stored.managed_path, cfg=self.cfg)
        paper_folder = path.parent
        self.assertTrue(path.exists())

        delete_managed_asset_file(stored.managed_path, cfg=self.cfg)
        self.assertFalse(path.exists())
        self.assertFalse(paper_folder.exists())
        delete_managed_asset_file(stored.managed_path, cfg=self.cfg)

    def test_asset_file_health_reports_present_relative_file(self) -> None:
        stored = store_managed_pdf_asset(
            paper_id=4,
            file_obj=io.BytesIO(b"%PDF-1.4\n"),
            filename="present.pdf",
            mime_type="application/pdf",
            cfg=self.cfg,
        )

        health = asset_file_health(stored.managed_path, cfg=self.cfg)

        self.assertEqual(health.status, AssetFileStatus.PRESENT)
        self.assertTrue(health.file_exists)
        self.assertEqual(health.resolved_path, resolve_managed_asset_path(stored.managed_path, cfg=self.cfg))
        self.assertIsNone(health.error)

    def test_asset_file_health_reports_missing_relative_file(self) -> None:
        health = asset_file_health("papers/1/missing.pdf", cfg=self.cfg)

        self.assertEqual(health.status, AssetFileStatus.MISSING)
        self.assertFalse(health.file_exists)
        self.assertEqual(health.resolved_path, resolve_managed_asset_path("papers/1/missing.pdf", cfg=self.cfg))
        self.assertIsNone(health.error)

    def test_asset_file_health_does_not_create_missing_asset_root(self) -> None:
        asset_root = paper_assets_root(self.cfg, create=False)
        self.assertFalse(asset_root.exists())

        health = asset_file_health("papers/1/missing.pdf", cfg=self.cfg)

        self.assertEqual(health.status, AssetFileStatus.MISSING)
        self.assertFalse(health.file_exists)
        self.assertFalse(asset_root.exists())

    def test_asset_file_health_reports_invalid_absolute_or_escaping_path(self) -> None:
        absolute = asset_file_health("/tmp/not-managed.pdf", cfg=self.cfg)
        escaping = asset_file_health("../outside.pdf", cfg=self.cfg)

        self.assertEqual(absolute.status, AssetFileStatus.INVALID_PATH)
        self.assertFalse(absolute.file_exists)
        self.assertIsNotNone(absolute.error)
        self.assertEqual(escaping.status, AssetFileStatus.INVALID_PATH)
        self.assertFalse(escaping.file_exists)
        self.assertIsNotNone(escaping.error)

    def test_asset_file_health_reports_null_managed_path(self) -> None:
        health = asset_file_health(None, cfg=self.cfg)

        self.assertEqual(health.status, AssetFileStatus.NOT_MANAGED)
        self.assertFalse(health.file_exists)
        self.assertIsNone(health.resolved_path)
        self.assertIsNone(health.error)


class PaperAssetApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmpdir.name, "claudesk.db")
        self.conn = make_conn(self.db_path)
        init_db(self.conn)
        self.env_patcher = patch.dict(os.environ, {"CLAUDESK_DATA_DIR": self.tmpdir.name}, clear=False)
        self.env_patcher.start()
        clear_vault_location_cache()
        load_config.cache_clear()
        with papers_api._parse_job_lock:
            papers_api._parse_threads.clear()

    def tearDown(self) -> None:
        with papers_api._parse_job_lock:
            papers_api._parse_threads.clear()
        self.conn.close()
        self.env_patcher.stop()
        clear_vault_location_cache()
        load_config.cache_clear()
        self.tmpdir.cleanup()

    def _write_pdf_cache_files(self, asset_id: int) -> tuple[Path, Path]:
        image_managed_path = f"derived/pdf-pages/{asset_id}/page-0001-dpi144.png"
        artifact_managed_path = f"derived/pdf-parse/{asset_id}/pymupdf-normalized_json.json"
        image_path = resolve_managed_asset_path(image_managed_path, cfg=load_config())
        image_path.parent.mkdir(parents=True, exist_ok=True)
        image_path.write_bytes(b"png")
        artifact_body = b"{\"ok\": true}"
        artifact_path = resolve_managed_asset_path(artifact_managed_path, cfg=load_config())
        artifact_path.parent.mkdir(parents=True, exist_ok=True)
        artifact_path.write_bytes(artifact_body)
        upsert_asset_pdf_page(
            self.conn,
            asset_id=asset_id,
            page_number=1,
            text="Cached page text.",
            page_width=100,
            page_height=200,
            image_managed_path=image_managed_path,
            image_width=100,
            image_height=200,
            render_dpi=144,
        )
        create_asset_parse_artifact(
            self.conn,
            asset_id=asset_id,
            artifact_kind="normalized_json",
            parser_name="pymupdf",
            parser_version="test-parser",
            managed_path=artifact_managed_path,
            mime_type="application/json",
            size_bytes=len(artifact_body),
            content_hash=hashlib.sha256(artifact_body).hexdigest(),
        )
        self.conn.commit()
        return image_path, artifact_path

    def test_asset_api_lists_empty_and_uploads_pdf(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        self.conn.commit()

        self.assertEqual(papers_api.get_paper_assets(paper_id, conn=self.conn), [])

        payload = b"%PDF-1.4\napi\n%%EOF\n"
        asset = papers_api.upload_paper_asset(
            paper_id,
            file=FakeUpload(
                filename="api-paper.pdf",
                content_type="application/pdf",
                content=payload,
            ),
            conn=self.conn,
        )

        self.assertEqual(asset["kind"], "pdf")
        self.assertEqual(asset["parse_status"], "not_parsed")
        self.assertEqual(asset["original_filename"], "api-paper.pdf")
        self.assertEqual(asset["display_name"], "api-paper.pdf")
        self.assertEqual(asset["size_bytes"], len(payload))
        self.assertEqual(asset["content_hash"], hashlib.sha256(payload).hexdigest())
        self.assertEqual(Path(asset["managed_path"]).parts[:2], ("papers", f"{paper_id}-asset-paper"))
        self.assertEqual(asset["file_status"], "present")
        self.assertTrue(asset["file_exists"])

        listed = papers_api.get_paper_assets(paper_id, conn=self.conn)
        self.assertEqual([row["id"] for row in listed], [asset["id"]])
        self.assertEqual(listed[0]["file_status"], "present")
        self.assertTrue(listed[0]["file_exists"])
        path = resolve_managed_asset_path(asset["managed_path"], cfg=load_config())
        self.assertTrue(path.exists())

    def test_asset_api_marks_missing_managed_files(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = make_pdf_asset(self.conn, paper_id, "missing-api.pdf")
        self.conn.commit()

        listed = papers_api.get_paper_assets(paper_id, conn=self.conn)

        self.assertEqual([row["id"] for row in listed], [asset.id])
        self.assertEqual(listed[0]["file_status"], "missing")
        self.assertFalse(listed[0]["file_exists"])

    def test_asset_parse_endpoint_queues_background_job(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = make_pdf_asset(self.conn, paper_id, "parse-api.pdf")
        self.conn.commit()

        def fake_ensure(conn, *, paper_id: int, asset_id: int, cfg):
            update_asset_parse_state(
                conn,
                asset_id,
                parse_status=AssetParseStatus.PARSED,
                parser_name="pymupdf",
                parser_version="test-parser",
                parse_error=None,
            )
            return None

        with patch.object(papers_api, "ensure_pdf_ingested", side_effect=fake_ensure):
            result = papers_api.parse_paper_asset(paper_id, asset.id or 0, conn=self.conn)
            self.assertTrue(result["ok"])
            self.assertEqual(result["launch_state"], "started")
            self.assertEqual(result["asset"]["parse_status"], "queued")
            job = get_latest_job_by_kind(self.conn, papers_api.PDF_PARSE_JOB_KIND)
            self.assertIsNotNone(job)
            self.assertEqual(job.resource_kind if job else None, "asset")
            self.assertEqual(job.resource_id if job else None, str(asset.id or 0))
            self.assertEqual(
                job.dedupe_key if job else None,
                f"pdf_parse:{asset.id or 0}",
            )

            deadline = time.time() + 2
            latest = None
            latest_job = job
            while time.time() < deadline:
                latest = get_asset(self.conn, asset.id or 0)
                latest_job = get_job(self.conn, job.id if job else 0)
                if (
                    latest is not None
                    and latest.parse_status == AssetParseStatus.PARSED
                    and latest_job is not None
                    and latest_job.status == "succeeded"
                ):
                    break
                time.sleep(0.05)

        self.assertIsNotNone(latest)
        self.assertEqual(latest.parse_status, AssetParseStatus.PARSED)  # type: ignore[union-attr]
        self.assertIsNotNone(latest_job)
        self.assertEqual(latest_job.status, "succeeded")  # type: ignore[union-attr]
        self.assertEqual(latest_job.result["asset_id"], asset.id)  # type: ignore[union-attr]
        events = list_job_events(self.conn, latest_job.id)  # type: ignore[union-attr]
        self.assertIn("running", [event.event_type for event in events])
        self.assertIn("succeeded", [event.event_type for event in events])
        listed = papers_api.get_paper_assets(paper_id, conn=self.conn)
        self.assertEqual(listed[0]["parser_name"], "pymupdf")
        self.assertEqual(listed[0]["block_count"], 0)

    def test_asset_parse_endpoint_dedupes_active_durable_job(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = make_pdf_asset(self.conn, paper_id, "dedupe-parse-api.pdf")
        self.conn.commit()
        started_threads = []

        class FakeThread:
            def __init__(self, *, target, args, daemon) -> None:
                self.target = target
                self.args = args
                self.daemon = daemon

            def start(self) -> None:
                started_threads.append(self)

        with patch.object(papers_api.threading, "Thread", FakeThread):
            first = papers_api.parse_paper_asset(paper_id, asset.id or 0, conn=self.conn)
            second = papers_api.parse_paper_asset(paper_id, asset.id or 0, conn=self.conn)

        active = get_active_job_by_kind_dedupe_key(
            self.conn,
            papers_api.PDF_PARSE_JOB_KIND,
            f"pdf_parse:{asset.id or 0}",
        )
        self.assertEqual(first["launch_state"], "started")
        self.assertEqual(second["launch_state"], "already_running")
        self.assertEqual(second["asset"]["parse_status"], "queued")
        self.assertIsNotNone(active)
        self.assertEqual(active.status if active else None, "queued")
        self.assertEqual(len(started_threads), 1)

    def test_asset_parse_worker_records_failure_job(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = make_pdf_asset(self.conn, paper_id, "failed-parse-api.pdf")
        self.conn.commit()

        def fake_ensure(conn, *, paper_id: int, asset_id: int, cfg):
            update_asset_parse_state(
                conn,
                asset_id,
                parse_status=AssetParseStatus.FAILED,
                parser_name="pymupdf",
                parser_version="test-parser",
                parse_error="parse boom",
            )
            raise PdfIngestError("parse boom")

        with patch.object(papers_api, "ensure_pdf_ingested", side_effect=fake_ensure):
            result = papers_api.parse_paper_asset(paper_id, asset.id or 0, conn=self.conn)
            self.assertEqual(result["launch_state"], "started")
            job = get_latest_job_by_kind(self.conn, papers_api.PDF_PARSE_JOB_KIND)
            self.assertIsNotNone(job)

            deadline = time.time() + 2
            latest = None
            latest_job = job
            while time.time() < deadline:
                latest = get_asset(self.conn, asset.id or 0)
                latest_job = get_job(self.conn, job.id if job else 0)
                if (
                    latest is not None
                    and latest.parse_status == AssetParseStatus.FAILED
                    and latest_job is not None
                    and latest_job.status == "failed"
                ):
                    break
                time.sleep(0.05)

        self.assertIsNotNone(latest)
        self.assertEqual(latest.parse_status, AssetParseStatus.FAILED)  # type: ignore[union-attr]
        self.assertEqual(latest.parse_error, "parse boom")  # type: ignore[union-attr]
        self.assertIsNotNone(latest_job)
        self.assertEqual(latest_job.status, "failed")  # type: ignore[union-attr]
        failures = list_job_failures(self.conn, latest_job.id)  # type: ignore[union-attr]
        self.assertEqual(failures[-1].error_type, "PdfIngestError")
        self.assertEqual(failures[-1].message, "parse boom")

    def test_asset_parse_worker_failure_before_ingest_marks_asset_failed(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = make_pdf_asset(self.conn, paper_id, "pre-ingest-failed-parse-api.pdf")
        self.conn.commit()

        with patch.object(
            papers_api,
            "ensure_pdf_ingested",
            side_effect=PdfIngestError("paper asset link disappeared"),
        ):
            result = papers_api.parse_paper_asset(paper_id, asset.id or 0, conn=self.conn)
            self.assertEqual(result["launch_state"], "started")
            job = get_latest_job_by_kind(self.conn, papers_api.PDF_PARSE_JOB_KIND)
            self.assertIsNotNone(job)

            deadline = time.time() + 2
            latest = None
            latest_job = job
            while time.time() < deadline:
                latest = get_asset(self.conn, asset.id or 0)
                latest_job = get_job(self.conn, job.id if job else 0)
                if (
                    latest is not None
                    and latest.parse_status == AssetParseStatus.FAILED
                    and latest_job is not None
                    and latest_job.status == "failed"
                ):
                    break
                time.sleep(0.05)

        self.assertIsNotNone(latest)
        self.assertEqual(latest.parse_status, AssetParseStatus.FAILED)  # type: ignore[union-attr]
        self.assertEqual(latest.parse_error, "paper asset link disappeared")  # type: ignore[union-attr]
        self.assertIsNotNone(latest_job)
        self.assertEqual(latest_job.status, "failed")  # type: ignore[union-attr]
        failures = list_job_failures(self.conn, latest_job.id)  # type: ignore[union-attr]
        self.assertEqual(failures[-1].message, "paper asset link disappeared")

    def test_asset_parse_endpoint_marks_failed_when_thread_start_fails(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = make_pdf_asset(self.conn, paper_id, "thread-start-failed-api.pdf")
        self.conn.commit()

        class FailingThread:
            def __init__(self, *, target, args, daemon) -> None:
                self.target = target
                self.args = args
                self.daemon = daemon

            def start(self) -> None:
                raise RuntimeError("thread unavailable")

        with (
            patch.object(papers_api.threading, "Thread", FailingThread),
            self.assertRaises(HTTPException) as ctx,
        ):
            papers_api.parse_paper_asset(paper_id, asset.id or 0, conn=self.conn)

        latest = get_asset(self.conn, asset.id or 0)
        job = get_latest_job_by_kind(self.conn, papers_api.PDF_PARSE_JOB_KIND)
        active = get_active_job_by_kind_dedupe_key(
            self.conn,
            papers_api.PDF_PARSE_JOB_KIND,
            f"pdf_parse:{asset.id or 0}",
        )
        self.assertEqual(ctx.exception.status_code, 500)
        self.assertEqual(latest.parse_status, AssetParseStatus.FAILED)  # type: ignore[union-attr]
        self.assertIn("Failed to start PDF parse worker", latest.parse_error or "")  # type: ignore[union-attr]
        self.assertIsNotNone(job)
        self.assertEqual(job.status, "failed")  # type: ignore[union-attr]
        self.assertIsNone(active)
        self.assertNotIn(job.id, papers_api._parse_threads)  # type: ignore[union-attr]

    def test_stale_pdf_parse_reconciliation_fails_queued_asset_and_clears_cache(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = make_pdf_asset(self.conn, paper_id, "stale-parse-api.pdf")
        asset_id = asset.id or 0
        update_asset_parse_state(
            self.conn,
            asset_id,
            parse_status=AssetParseStatus.QUEUED,
            parser_name="pymupdf",
            parser_version="test-parser",
            parse_error=None,
        )
        image_path, artifact_path = self._write_pdf_cache_files(asset_id)
        job = create_job(
            self.conn,
            kind=papers_api.PDF_PARSE_JOB_KIND,
            request={"paper_id": paper_id, "asset_id": asset_id},
            resource_kind="asset",
            resource_id=asset_id,
            dedupe_key=f"pdf_parse:{asset_id}",
            machine_id="machine-a",
            executor_kind="thread",
        )
        mark_job_running(self.conn, job.id, machine_id="machine-a", executor_kind="thread")
        self.conn.commit()

        reconciled = papers_api.reconcile_stale_pdf_parse_jobs(
            self.conn,
            machine_id="machine-a",
            cfg=load_config(),
        )
        self.conn.commit()

        latest = get_asset(self.conn, asset_id)
        latest_job = get_job(self.conn, job.id)
        failures = list_job_failures(self.conn, job.id)
        self.assertEqual([row.id for row in reconciled], [job.id])
        self.assertEqual(latest.parse_status, AssetParseStatus.FAILED)  # type: ignore[union-attr]
        self.assertIn("stopped before completion", latest.parse_error or "")  # type: ignore[union-attr]
        self.assertEqual(latest_job.status, "failed")  # type: ignore[union-attr]
        self.assertEqual(failures[-1].error_type, "StaleBackgroundJob")
        self.assertEqual(count_asset_pdf_pages(self.conn, asset_id), 0)
        self.assertEqual(count_asset_parse_artifacts(self.conn, asset_id), 0)
        self.assertFalse(image_path.exists())
        self.assertFalse(artifact_path.exists())

    def test_stale_pdf_parse_reconciliation_fails_legacy_queued_asset_without_job(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = make_pdf_asset(self.conn, paper_id, "legacy-stale-parse-api.pdf")
        asset_id = asset.id or 0
        update_asset_parse_state(
            self.conn,
            asset_id,
            parse_status=AssetParseStatus.QUEUED,
            parser_name="pymupdf",
            parser_version="test-parser",
            parse_error=None,
        )
        image_path, artifact_path = self._write_pdf_cache_files(asset_id)
        self.conn.commit()

        reconciled = papers_api.reconcile_stale_pdf_parse_jobs(
            self.conn,
            machine_id="machine-a",
            cfg=load_config(),
        )
        self.conn.commit()

        latest = get_asset(self.conn, asset_id)
        self.assertEqual(reconciled, [])
        self.assertEqual(latest.parse_status, AssetParseStatus.FAILED)  # type: ignore[union-attr]
        self.assertIn("without a durable background job", latest.parse_error or "")  # type: ignore[union-attr]
        self.assertEqual(count_asset_pdf_pages(self.conn, asset_id), 0)
        self.assertEqual(count_asset_parse_artifacts(self.conn, asset_id), 0)
        self.assertFalse(image_path.exists())
        self.assertFalse(artifact_path.exists())

    def test_stale_pdf_parse_reconciliation_preserves_parsed_asset_as_success(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = make_pdf_asset(self.conn, paper_id, "stale-parsed-api.pdf")
        asset_id = asset.id or 0
        update_asset_parse_state(
            self.conn,
            asset_id,
            parse_status=AssetParseStatus.PARSED,
            parser_name="pymupdf",
            parser_version="test-parser",
            parse_error=None,
        )
        job = create_job(
            self.conn,
            kind=papers_api.PDF_PARSE_JOB_KIND,
            request={"paper_id": paper_id, "asset_id": asset_id},
            resource_kind="asset",
            resource_id=asset_id,
            dedupe_key=f"pdf_parse:{asset_id}",
            machine_id="machine-a",
            executor_kind="thread",
        )
        mark_job_running(self.conn, job.id, machine_id="machine-a", executor_kind="thread")
        self.conn.commit()

        papers_api.reconcile_stale_pdf_parse_jobs(
            self.conn,
            machine_id="machine-a",
            cfg=load_config(),
        )
        self.conn.commit()

        latest = get_asset(self.conn, asset_id)
        latest_job = get_job(self.conn, job.id)
        self.assertEqual(latest.parse_status, AssetParseStatus.PARSED)  # type: ignore[union-attr]
        self.assertEqual(latest_job.status, "succeeded")  # type: ignore[union-attr]
        self.assertEqual(latest_job.result["parse_status"], "parsed")  # type: ignore[union-attr]

    def test_asset_api_upload_rejects_non_pdf(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        self.conn.commit()

        with self.assertRaises(HTTPException) as ctx:
            papers_api.upload_paper_asset(
                paper_id,
                file=FakeUpload(
                    filename="notes.txt",
                    content_type="text/plain",
                    content=b"not pdf",
                ),
                conn=self.conn,
            )

        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(papers_api.get_paper_assets(paper_id, conn=self.conn), [])

    def test_asset_api_renames_display_name_only(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        self.conn.commit()
        asset = papers_api.upload_paper_asset(
            paper_id,
            file=FakeUpload(
                filename="original.pdf",
                content_type="application/pdf",
                content=b"%PDF-1.4\n",
            ),
            conn=self.conn,
        )

        renamed = papers_api.rename_paper_asset(
            paper_id,
            asset["id"],
            body=papers_api.PaperAssetRenameRequest(display_name="  Figure set.pdf  "),
            conn=self.conn,
        )

        self.assertEqual(renamed["display_name"], "Figure set.pdf")
        self.assertEqual(renamed["original_filename"], asset["original_filename"])
        self.assertEqual(renamed["managed_path"], asset["managed_path"])
        self.assertEqual(renamed["file_status"], "present")
        self.assertTrue(renamed["file_exists"])

    def test_asset_api_rejects_empty_display_name(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        self.conn.commit()
        asset = make_pdf_asset(self.conn, paper_id, "empty.pdf")
        self.conn.commit()

        with self.assertRaises(HTTPException) as ctx:
            papers_api.rename_paper_asset(
                paper_id,
                asset.id or 0,
                body=papers_api.PaperAssetRenameRequest(display_name="  "),
                conn=self.conn,
            )

        self.assertEqual(ctx.exception.status_code, 400)

    def test_asset_file_endpoint_serves_managed_pdf_inline(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        self.conn.commit()
        payload = b"%PDF-1.4\nviewer\n%%EOF\n"
        asset = papers_api.upload_paper_asset(
            paper_id,
            file=FakeUpload(
                filename="viewer.pdf",
                content_type="application/pdf",
                content=payload,
            ),
            conn=self.conn,
        )
        papers_api.rename_paper_asset(
            paper_id,
            asset["id"],
            body=papers_api.PaperAssetRenameRequest(display_name="Readable copy"),
            conn=self.conn,
        )

        response = papers_api.get_paper_asset_file(paper_id, asset["id"], conn=self.conn)

        self.assertEqual(response.media_type, "application/pdf")
        self.assertEqual(Path(response.path).read_bytes(), payload)
        self.assertIn("inline", response.headers["content-disposition"])
        self.assertIn("Readable%20copy.pdf", response.headers["content-disposition"])

    def test_asset_file_route_supports_inline_range_requests(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        self.conn.commit()
        payload = b"%PDF-1.4\nrange-response-body\n%%EOF\n"
        asset = papers_api.upload_paper_asset(
            paper_id,
            file=FakeUpload(
                filename="range.pdf",
                content_type="application/pdf",
                content=payload,
            ),
            conn=self.conn,
        )

        client = TestClient(app, base_url="http://127.0.0.1:8765")
        path = f"/api/papers/{paper_id}/assets/{asset['id']}/file"
        full = client.get(path)
        partial = client.get(path, headers={"Range": "bytes=5-16"})

        self.assertEqual(full.status_code, 200)
        self.assertEqual(full.headers["content-type"], "application/pdf")
        self.assertIn("inline", full.headers["content-disposition"])
        self.assertEqual(full.content, payload)
        self.assertEqual(partial.status_code, 206)
        self.assertEqual(partial.headers["accept-ranges"], "bytes")
        self.assertEqual(partial.headers["content-range"], f"bytes 5-16/{len(payload)}")
        self.assertEqual(partial.content, payload[5:17])

    def test_asset_file_endpoint_rejects_missing_or_invalid_files(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        missing = make_pdf_asset(self.conn, paper_id, "missing-viewer.pdf")
        invalid = create_paper_asset(
            self.conn,
            paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path="../outside.pdf",
            original_filename="invalid.pdf",
            display_name="invalid.pdf",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-invalid-viewer",
            parse_status=AssetParseStatus.NOT_PARSED,
        )
        text_asset = create_paper_asset(
            self.conn,
            paper_id,
            kind=AssetKind.TEXT,
            source="parser",
            managed_path=None,
            original_filename="text.txt",
            display_name="text.txt",
            mime_type="text/plain",
            size_bytes=10,
            content_hash="sha256-text-viewer",
            parse_status=AssetParseStatus.NOT_PARSED,
        )
        directory_asset = make_pdf_asset(self.conn, paper_id, "directory-viewer.pdf")
        self.conn.commit()
        directory_path = resolve_managed_asset_path(directory_asset.managed_path, cfg=load_config())
        directory_path.mkdir(parents=True)

        with self.assertRaises(HTTPException) as missing_ctx:
            papers_api.get_paper_asset_file(paper_id, missing.id or 0, conn=self.conn)
        self.assertEqual(missing_ctx.exception.status_code, 404)

        with self.assertRaises(HTTPException) as invalid_ctx:
            papers_api.get_paper_asset_file(paper_id, invalid.id or 0, conn=self.conn)
        self.assertEqual(invalid_ctx.exception.status_code, 400)

        with self.assertRaises(HTTPException) as text_ctx:
            papers_api.get_paper_asset_file(paper_id, text_asset.id or 0, conn=self.conn)
        self.assertEqual(text_ctx.exception.status_code, 400)

        with self.assertRaises(HTTPException) as directory_ctx:
            papers_api.get_paper_asset_file(paper_id, directory_asset.id or 0, conn=self.conn)
        self.assertEqual(directory_ctx.exception.status_code, 400)

    def test_asset_api_delete_removes_metadata_and_file(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        self.conn.commit()
        asset = papers_api.upload_paper_asset(
            paper_id,
            file=FakeUpload(
                filename="remove.pdf",
                content_type="application/pdf",
                content=b"%PDF-1.4\n",
            ),
            conn=self.conn,
        )
        path = resolve_managed_asset_path(asset["managed_path"], cfg=load_config())
        paper_folder = path.parent
        self.assertTrue(path.exists())

        result = papers_api.remove_paper_asset(paper_id, asset["id"], conn=self.conn)

        self.assertEqual(result, {"ok": True})
        self.assertFalse(path.exists())
        self.assertFalse(paper_folder.exists())
        self.assertEqual(papers_api.get_paper_assets(paper_id, conn=self.conn), [])

    def test_asset_api_delete_removes_parsed_files_and_empty_cache_dirs(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        self.conn.commit()
        asset = papers_api.upload_paper_asset(
            paper_id,
            file=FakeUpload(
                filename="parsed-remove.pdf",
                content_type="application/pdf",
                content=b"%PDF-1.4\n",
            ),
            conn=self.conn,
        )
        asset_id = int(asset["id"])
        image_path, artifact_path = self._write_pdf_cache_files(asset_id)
        image_dir = image_path.parent
        artifact_dir = artifact_path.parent

        result = papers_api.remove_paper_asset(paper_id, asset_id, conn=self.conn)

        self.assertEqual(result, {"ok": True})
        self.assertFalse(image_path.exists())
        self.assertFalse(artifact_path.exists())
        self.assertFalse(image_dir.exists())
        self.assertFalse(artifact_dir.exists())
        self.assertEqual(count_asset_pdf_pages(self.conn, asset_id), 0)
        self.assertEqual(count_asset_parse_artifacts(self.conn, asset_id), 0)

    def test_asset_api_delete_tolerates_missing_managed_files(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = make_pdf_asset(self.conn, paper_id, "already-missing.pdf")
        self.conn.commit()

        result = papers_api.remove_paper_asset(paper_id, asset.id or 0, conn=self.conn)

        self.assertEqual(result, {"ok": True})
        self.assertIsNone(get_asset(self.conn, asset.id or 0))

    def test_asset_api_delete_tolerates_invalid_managed_path_metadata(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = create_paper_asset(
            self.conn,
            paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path="/tmp/not-managed.pdf",
            original_filename="invalid.pdf",
            display_name="invalid.pdf",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-invalid",
            parse_status=AssetParseStatus.NOT_PARSED,
        )
        self.conn.commit()

        result = papers_api.remove_paper_asset(paper_id, asset.id or 0, conn=self.conn)

        self.assertEqual(result, {"ok": True})
        self.assertIsNone(get_asset(self.conn, asset.id or 0))
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM paper_assets WHERE asset_id=?", (asset.id,)).fetchone()[0],
            0,
        )

    def test_paper_api_delete_removes_orphan_asset_files_and_cache_dirs(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        self.conn.commit()
        asset = papers_api.upload_paper_asset(
            paper_id,
            file=FakeUpload(
                filename="paper-delete.pdf",
                content_type="application/pdf",
                content=b"%PDF-1.4\n",
            ),
            conn=self.conn,
        )
        asset_id = int(asset["id"])
        pdf_path = resolve_managed_asset_path(asset["managed_path"], cfg=load_config())
        paper_folder = pdf_path.parent
        image_path, artifact_path = self._write_pdf_cache_files(asset_id)

        result = papers_api.remove_paper(paper_id, conn=self.conn)

        self.assertEqual(result, {"ok": True})
        self.assertFalse(pdf_path.exists())
        self.assertFalse(paper_folder.exists())
        self.assertFalse(image_path.exists())
        self.assertFalse(artifact_path.exists())
        self.assertFalse(image_path.parent.exists())
        self.assertFalse(artifact_path.parent.exists())
        self.assertIsNone(get_asset(self.conn, asset_id))

    def test_paper_api_delete_tolerates_escaping_asset_path_metadata(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = create_paper_asset(
            self.conn,
            paper_id,
            kind=AssetKind.PDF,
            source="manual",
            managed_path="../outside.pdf",
            original_filename="escaping.pdf",
            display_name="escaping.pdf",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-escaping",
            parse_status=AssetParseStatus.NOT_PARSED,
        )
        self.conn.commit()

        result = papers_api.remove_paper(paper_id, conn=self.conn)

        self.assertEqual(result, {"ok": True})
        self.assertIsNone(get_asset(self.conn, asset.id or 0))
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM papers WHERE id=?", (paper_id,)).fetchone()[0],
            0,
        )

    def test_paper_api_delete_preserves_shared_asset_files(self) -> None:
        first_paper_id = upsert_paper(self.conn, make_paper())
        second = make_paper(external_id="10.1234/shared-asset", title="Shared asset paper")
        second_paper_id = upsert_paper(self.conn, second)
        self.conn.commit()
        asset = papers_api.upload_paper_asset(
            first_paper_id,
            file=FakeUpload(
                filename="shared.pdf",
                content_type="application/pdf",
                content=b"%PDF-1.4\n",
            ),
            conn=self.conn,
        )
        asset_id = int(asset["id"])
        self.conn.execute(
            "INSERT INTO paper_assets (paper_id, asset_id, created_at) VALUES (?, ?, ?)",
            (second_paper_id, asset_id, "2026-05-03T00:00:00"),
        )
        self.conn.commit()
        pdf_path = resolve_managed_asset_path(asset["managed_path"], cfg=load_config())
        image_path, artifact_path = self._write_pdf_cache_files(asset_id)

        result = papers_api.remove_paper(first_paper_id, conn=self.conn)

        self.assertEqual(result, {"ok": True})
        self.assertTrue(pdf_path.exists())
        self.assertTrue(image_path.exists())
        self.assertTrue(artifact_path.exists())
        self.assertIsNotNone(get_asset(self.conn, asset_id))
        self.assertEqual([row.id for row in list_paper_assets(self.conn, second_paper_id)], [asset_id])

    def test_asset_api_reports_missing_paper_and_asset(self) -> None:
        with self.assertRaises(HTTPException) as missing_paper:
            papers_api.get_paper_assets(999, conn=self.conn)
        self.assertEqual(missing_paper.exception.status_code, 404)

        paper_id = upsert_paper(self.conn, make_paper())
        self.conn.commit()
        with self.assertRaises(HTTPException) as missing_asset:
            papers_api.remove_paper_asset(paper_id, 999, conn=self.conn)
        self.assertEqual(missing_asset.exception.status_code, 404)

        with self.assertRaises(HTTPException) as missing_rename:
            papers_api.rename_paper_asset(
                paper_id,
                999,
                body=papers_api.PaperAssetRenameRequest(display_name="Missing.pdf"),
                conn=self.conn,
            )
        self.assertEqual(missing_rename.exception.status_code, 404)


class VaultAssetCliAuditTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmpdir.name, "claudesk.db")
        self.conn = make_conn(self.db_path)
        init_db(self.conn)
        self.env = {"CLAUDESK_DATA_DIR": self.tmpdir.name}
        clear_vault_location_cache()
        load_config.cache_clear()

    def tearDown(self) -> None:
        self.conn.close()
        clear_vault_location_cache()
        load_config.cache_clear()
        self.tmpdir.cleanup()

    def _create_assets(self) -> tuple[int, int]:
        paper_id = upsert_paper(self.conn, make_paper())
        present = make_pdf_asset(self.conn, paper_id, "present.pdf")
        missing = make_pdf_asset(self.conn, paper_id, "missing.pdf")
        self.conn.commit()
        with patched_data_dir(self.tmpdir.name):
            cfg = Config()
            path = resolve_managed_asset_path(present.managed_path or "", cfg=cfg)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"%PDF-1.4\npresent\n")
        return present.id or 0, missing.id or 0

    def test_vault_assets_audit_json_reports_file_health_counts(self) -> None:
        from claudesk.cli import app

        present_id, missing_id = self._create_assets()
        result = CliRunner().invoke(
            app,
            ["vault", "assets", "audit", "--json"],
            env=self.env,
        )

        self.assertEqual(result.exit_code, 0, result.output)
        payload = json.loads(result.output)
        self.assertEqual(payload["counts"]["total"], 2)
        self.assertEqual(payload["counts"]["present"], 1)
        self.assertEqual(payload["counts"]["missing"], 1)
        self.assertEqual(payload["problem_asset_ids"], [missing_id])
        by_id = {row["asset_id"]: row for row in payload["assets"]}
        self.assertEqual(by_id[present_id]["file_status"], "present")
        self.assertEqual(by_id[missing_id]["file_status"], "missing")

    def test_vault_assets_audit_check_exits_nonzero_for_missing_files(self) -> None:
        from claudesk.cli import app

        self._create_assets()
        result = CliRunner().invoke(
            app,
            ["vault", "assets", "audit", "--check"],
            env=self.env,
        )

        self.assertEqual(result.exit_code, 1, result.output)
        self.assertIn("missing", result.output)

    def test_vault_assets_audit_check_does_not_create_asset_root(self) -> None:
        from claudesk.cli import app

        asset_root = Path(self.tmpdir.name) / "assets"
        self.assertFalse(asset_root.exists())
        result = CliRunner().invoke(
            app,
            ["vault", "assets", "audit", "--check", "--json"],
            env=self.env,
        )

        self.assertEqual(result.exit_code, 0, result.output)
        self.assertFalse(asset_root.exists())

    def test_vault_assets_prune_missing_preview_does_not_modify_database(self) -> None:
        from claudesk.cli import app

        _, missing_id = self._create_assets()
        result = CliRunner().invoke(
            app,
            ["vault", "assets", "prune-missing", "--json"],
            env=self.env,
        )

        self.assertEqual(result.exit_code, 0, result.output)
        payload = json.loads(result.output)
        self.assertFalse(payload["applied"])
        self.assertEqual(payload["pruned_asset_ids"], [missing_id])
        self.assertIsNotNone(get_asset(self.conn, missing_id))
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM paper_assets WHERE asset_id=?", (missing_id,)).fetchone()[0],
            1,
        )

    def test_vault_assets_prune_missing_apply_removes_orphan_asset_metadata(self) -> None:
        from claudesk.cli import app

        present_id, missing_id = self._create_assets()
        result = CliRunner().invoke(
            app,
            ["vault", "assets", "prune-missing", "--apply", "--json"],
            env=self.env,
        )

        self.assertEqual(result.exit_code, 0, result.output)
        payload = json.loads(result.output)
        self.assertTrue(payload["applied"])
        self.assertEqual(payload["pruned_asset_ids"], [missing_id])
        self.assertIsNotNone(get_asset(self.conn, present_id))
        self.assertIsNone(get_asset(self.conn, missing_id))
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM paper_assets WHERE asset_id=?", (missing_id,)).fetchone()[0],
            0,
        )
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0], 1)

    def test_vault_assets_prune_missing_apply_removes_shared_links_and_pdf_cache(self) -> None:
        from claudesk.cli import app

        _, missing_id = self._create_assets()
        second_paper_id = upsert_paper(
            self.conn,
            make_paper(
                source="arxiv",
                external_id="2601.12345",
                title="Second paper",
            ),
        )
        self.conn.execute(
            "INSERT INTO paper_assets (paper_id, asset_id, created_at) VALUES (?, ?, ?)",
            (second_paper_id, missing_id, "2026-05-01T00:00:00"),
        )
        upsert_asset_pdf_page(
            self.conn,
            asset_id=missing_id,
            page_number=1,
            text="cached page",
            image_managed_path="derived/pdf-pages/missing/page-0001.png",
        )
        insert_asset_text_chunk(
            self.conn,
            asset_id=missing_id,
            chunk_index=0,
            page_number=1,
            text="cached chunk",
        )
        self.conn.commit()

        result = CliRunner().invoke(
            app,
            ["vault", "assets", "prune-missing", "--apply", "--json"],
            env=self.env,
        )

        self.assertEqual(result.exit_code, 0, result.output)
        payload = json.loads(result.output)
        self.assertEqual(payload["pruned_asset_ids"], [missing_id])
        self.assertCountEqual(payload["affected_paper_ids"], [1, second_paper_id])
        self.assertIsNone(get_asset(self.conn, missing_id))
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM paper_assets WHERE asset_id=?", (missing_id,)).fetchone()[0],
            0,
        )
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM asset_pdf_pages WHERE asset_id=?", (missing_id,)).fetchone()[0],
            0,
        )
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM asset_text_chunks WHERE asset_id=?", (missing_id,)).fetchone()[0],
            0,
        )
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0], 2)

if __name__ == "__main__":
    unittest.main()
