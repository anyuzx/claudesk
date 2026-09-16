from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import date
from types import SimpleNamespace
from unittest.mock import patch

from claudesk.core.config import ChatRuntimeSettings, Config, PaperAssetsConfig
from claudesk.core.db import (
    SCHEMA_VERSION,
    init_db,
)
from claudesk.core.db.assets import (
    count_asset_document_blocks,
    count_asset_page_images,
    count_asset_pdf_pages,
    count_asset_parse_artifacts,
    count_asset_text_chunks,
    create_paper_asset,
    delete_paper_asset,
    get_asset,
    insert_asset_text_chunk,
    list_asset_document_blocks,
    list_asset_parse_artifacts,
    list_asset_pdf_pages,
    list_asset_text_chunks,
    search_asset_text_chunks,
    upsert_asset_pdf_page,
)
from claudesk.core.db.chat import (
    create_chat_attachment,
    create_chat_session,
)
from claudesk.core.db.papers import upsert_paper
from claudesk.core.pdf_ingest import (
    DEFAULT_RENDER_DPI,
    PARSER_NAME,
    PARSER_VERSION,
    NormalizedParseOutput,
    NormalizedPdfBlock,
    NormalizedPdfDocument,
    ParseArtifactContent,
    PdfIngestError,
    clear_pdf_ingest_cache,
    ensure_asset_pdf_ingested,
    ensure_pdf_ingested,
)
from claudesk.core.models import AssetKind, AssetParseStatus, Paper
from claudesk.core.paper_assets import resolve_chat_attachment_path, resolve_managed_asset_path
from tests.helpers import patched_data_dir


def make_conn(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def make_paper() -> Paper:
    return Paper(
        source="biorxiv",
        external_id="10.1234/pdf-ingest",
        title="PDF ingest paper",
        abstract="PDF ingest abstract",
        authors=["Alice Example"],
        published_date=date(2026, 4, 30),
        url="https://example.com/pdf-ingest",
    )


def make_pdf_asset(conn: sqlite3.Connection, paper_id: int, filename: str = "paper.pdf"):
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


class PdfIngestSchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmpdir.name, "claudesk.db")
        self.conn = make_conn(self.db_path)
        init_db(self.conn)

    def tearDown(self) -> None:
        self.conn.close()
        self.tmpdir.cleanup()

    def test_schema_creates_pdf_page_chunk_and_fts_tables(self) -> None:
        version = self.conn.execute(
            "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
        ).fetchone()[0]
        table_names = {
            row["name"]
            for row in self.conn.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table')"
            ).fetchall()
        }
        index_names = {
            row["name"]
            for row in self.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='index'"
            ).fetchall()
        }

        self.assertEqual(version, SCHEMA_VERSION)
        self.assertIn("asset_pdf_pages", table_names)
        self.assertIn("asset_text_chunks", table_names)
        self.assertIn("asset_parse_artifacts", table_names)
        self.assertIn("asset_document_blocks", table_names)
        self.assertIn("asset_text_chunks_fts", table_names)
        self.assertIn("idx_asset_text_chunks_asset_page", index_names)
        self.assertIn("idx_asset_document_blocks_asset_page", index_names)
        self.assertIn("idx_asset_parse_artifacts_asset_kind", index_names)
        self.assertEqual(count_asset_document_blocks(self.conn, 999), 0)

    def test_pages_and_chunks_round_trip_in_order(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = make_pdf_asset(self.conn, paper_id)

        upsert_asset_pdf_page(
            self.conn,
            asset_id=asset.id or 0,
            page_number=2,
            text="Second page",
            page_width=612,
            page_height=792,
            image_managed_path="derived/pdf-pages/1/page-0002-dpi144.png",
            image_width=1224,
            image_height=1584,
            render_dpi=144,
        )
        upsert_asset_pdf_page(
            self.conn,
            asset_id=asset.id or 0,
            page_number=1,
            text="First page",
            page_width=612,
            page_height=792,
            image_managed_path="derived/pdf-pages/1/page-0001-dpi144.png",
            image_width=1224,
            image_height=1584,
            render_dpi=144,
        )
        insert_asset_text_chunk(
            self.conn,
            asset_id=asset.id or 0,
            chunk_index=1,
            page_number=2,
            text="second beta chunk",
        )
        insert_asset_text_chunk(
            self.conn,
            asset_id=asset.id or 0,
            chunk_index=0,
            page_number=1,
            text="first alpha chunk",
        )

        pages = list_asset_pdf_pages(self.conn, asset.id or 0)
        chunks = list_asset_text_chunks(self.conn, asset.id or 0)

        self.assertEqual([page.page_number for page in pages], [1, 2])
        self.assertEqual([chunk.chunk_index for chunk in chunks], [0, 1])
        self.assertEqual(count_asset_pdf_pages(self.conn, asset.id or 0), 2)
        self.assertEqual(count_asset_text_chunks(self.conn, asset.id or 0), 2)
        self.assertEqual(count_asset_page_images(self.conn, asset.id or 0), 2)

    def test_fts_search_returns_matching_chunks(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = make_pdf_asset(self.conn, paper_id)
        insert_asset_text_chunk(
            self.conn,
            asset_id=asset.id or 0,
            chunk_index=0,
            page_number=1,
            text="alpha signaling pathway",
        )
        insert_asset_text_chunk(
            self.conn,
            asset_id=asset.id or 0,
            chunk_index=1,
            page_number=2,
            text="beta microscopy figure",
        )

        results = search_asset_text_chunks(self.conn, asset.id or 0, "microscopy", limit=5)

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].chunk_index, 1)
        self.assertIn("microscopy", results[0].text)

    def test_deleting_asset_cascades_pdf_cache(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = make_pdf_asset(self.conn, paper_id)
        upsert_asset_pdf_page(
            self.conn,
            asset_id=asset.id or 0,
            page_number=1,
            text="Page text",
            image_managed_path="derived/pdf-pages/1/page-0001-dpi144.png",
        )
        insert_asset_text_chunk(
            self.conn,
            asset_id=asset.id or 0,
            chunk_index=0,
            page_number=1,
            text="chunk text",
        )

        delete_paper_asset(self.conn, paper_id, asset.id or 0)

        self.assertEqual(count_asset_pdf_pages(self.conn, asset.id or 0), 0)
        self.assertEqual(count_asset_text_chunks(self.conn, asset.id or 0), 0)
        self.assertEqual(search_asset_text_chunks(self.conn, asset.id or 0, "chunk"), [])


class PdfIngestServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmpdir.name, "claudesk.db")
        self.data_dir_ctx = patched_data_dir(self.tmpdir.name)
        self.data_dir_ctx.__enter__()
        self.cfg = Config()
        self.conn = make_conn(self.db_path)
        init_db(self.conn)

    def tearDown(self) -> None:
        self.conn.close()
        self.data_dir_ctx.__exit__(None, None, None)
        self.tmpdir.cleanup()

    def _write_pdf(self, managed_path: str, page_texts: list[str]) -> None:
        import fitz

        path = resolve_managed_asset_path(managed_path, cfg=self.cfg)
        path.parent.mkdir(parents=True, exist_ok=True)
        doc = fitz.open()
        try:
            for text in page_texts:
                page = doc.new_page(width=300, height=200)
                page.insert_text((36, 72), text, fontsize=12)
            doc.save(str(path))
        finally:
            doc.close()

    def test_lazy_ingestion_stores_pages_chunks_and_rendered_images(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = make_pdf_asset(self.conn, paper_id)
        self._write_pdf(asset.managed_path or "", [
            "Alpha introduction with microscopy evidence.",
            "Beta results with figure caption.",
        ])

        result = ensure_pdf_ingested(
            self.conn,
            paper_id=paper_id,
            asset_id=asset.id or 0,
            cfg=self.cfg,
        )
        parsed = get_asset(self.conn, asset.id or 0)
        pages = list_asset_pdf_pages(self.conn, asset.id or 0)
        chunks = list_asset_text_chunks(self.conn, asset.id or 0)
        blocks = list_asset_document_blocks(self.conn, asset.id or 0)

        self.assertFalse(result.cache_hit)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed.parse_status, AssetParseStatus.PARSED)
        self.assertEqual(parsed.parser_name, PARSER_NAME)
        self.assertEqual(parsed.parser_version, PARSER_VERSION)
        self.assertEqual([page.page_number for page in pages], [1, 2])
        self.assertEqual(count_asset_document_blocks(self.conn, asset.id or 0), 2)
        self.assertEqual([block.page_number for block in blocks], [1, 2])
        self.assertEqual(blocks[0].block_type, "paragraph")
        self.assertGreaterEqual(len(chunks), 2)
        self.assertEqual(chunks[0].block_type, "paragraph")
        self.assertEqual(chunks[0].block_ids, [blocks[0].id])
        self.assertEqual(count_asset_page_images(self.conn, asset.id or 0), 2)
        for page in pages:
            self.assertEqual(page.render_dpi, DEFAULT_RENDER_DPI)
            self.assertGreater(page.page_width, 0)
            self.assertGreater(page.image_width, 0)
            image_path = resolve_managed_asset_path(page.image_managed_path or "", cfg=self.cfg)
            self.assertTrue(image_path.exists())

        artifacts = list_asset_parse_artifacts(self.conn, asset.id or 0)
        self.assertEqual(count_asset_parse_artifacts(self.conn, asset.id or 0), 1)
        self.assertEqual(artifacts[0].artifact_kind, "normalized_json")
        normalized_path = resolve_managed_asset_path(artifacts[0].managed_path or "", cfg=self.cfg)
        payload = json.loads(normalized_path.read_text(encoding="utf-8"))
        self.assertEqual(payload["schema_version"], "claudesk-normalized-v1")
        self.assertEqual(len(payload["blocks"]), 2)

    def test_lazy_ingestion_accepts_chat_owned_pdf_asset(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        attachment = create_chat_attachment(
            self.conn,
            session.id or 0,
            context_kind="file",
            kind=AssetKind.PDF,
            source="chat",
            managed_path=f"sessions/{session.id}/attachment.pdf",
            original_filename="attachment.pdf",
            display_name="attachment.pdf",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-chat-pdf",
        )
        pdf_path = resolve_chat_attachment_path(attachment.asset.managed_path or "", cfg=self.cfg)
        write_pdf_path = pdf_path
        write_pdf_path.parent.mkdir(parents=True, exist_ok=True)
        import fitz

        doc = fitz.open()
        try:
            page = doc.new_page(width=300, height=200)
            page.insert_text((36, 72), "Chat-owned PDF text.", fontsize=12)
            doc.save(str(write_pdf_path))
        finally:
            doc.close()

        result = ensure_asset_pdf_ingested(
            self.conn,
            asset_id=attachment.asset.id or 0,
            cfg=self.cfg,
        )

        self.assertFalse(result.cache_hit)
        self.assertEqual(result.asset.parse_status, AssetParseStatus.PARSED)
        self.assertEqual([page.page_number for page in result.pages], [1])
        self.assertEqual(result.chunks[0].text, "Chat-owned PDF text.")
        self.assertEqual(
            self.conn.execute(
                "SELECT COUNT(*) FROM paper_assets WHERE asset_id=?",
                (attachment.asset.id,),
            ).fetchone()[0],
            0,
        )

    def test_asset_pdf_ingestion_rejects_missing_non_pdf_and_unmanaged_assets(self) -> None:
        session = create_chat_session(self.conn, runtime_settings=ChatRuntimeSettings())
        text_attachment = create_chat_attachment(
            self.conn,
            session.id or 0,
            context_kind="file",
            kind=AssetKind.TEXT,
            source="chat",
            managed_path=f"sessions/{session.id}/notes.txt",
            original_filename="notes.txt",
            display_name="notes.txt",
            mime_type="text/plain",
            size_bytes=12,
            content_hash="sha256-text",
            parsed_text="notes",
        )
        unmanaged_pdf = create_chat_attachment(
            self.conn,
            session.id or 0,
            context_kind="file",
            kind=AssetKind.PDF,
            source="chat",
            managed_path=None,
            original_filename="unmanaged.pdf",
            display_name="unmanaged.pdf",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-unmanaged",
        )
        missing_pdf = create_chat_attachment(
            self.conn,
            session.id or 0,
            context_kind="file",
            kind=AssetKind.PDF,
            source="chat",
            managed_path=f"sessions/{session.id}/missing.pdf",
            original_filename="missing.pdf",
            display_name="missing.pdf",
            mime_type="application/pdf",
            size_bytes=128,
            content_hash="sha256-missing",
        )

        with self.assertRaisesRegex(PdfIngestError, "not found"):
            ensure_asset_pdf_ingested(self.conn, asset_id=999, cfg=self.cfg)
        with self.assertRaisesRegex(PdfIngestError, "not a PDF"):
            ensure_asset_pdf_ingested(
                self.conn,
                asset_id=text_attachment.asset.id or 0,
                cfg=self.cfg,
            )
        with self.assertRaisesRegex(PdfIngestError, "no managed file path"):
            ensure_asset_pdf_ingested(
                self.conn,
                asset_id=unmanaged_pdf.asset.id or 0,
                cfg=self.cfg,
            )
        with self.assertRaisesRegex(PdfIngestError, "not found"):
            ensure_asset_pdf_ingested(
                self.conn,
                asset_id=missing_pdf.asset.id or 0,
                cfg=self.cfg,
            )

        parsed = get_asset(self.conn, missing_pdf.asset.id or 0)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed.parse_status, AssetParseStatus.FAILED)

    def test_queued_parse_commits_before_expensive_parser_work(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = make_pdf_asset(self.conn, paper_id, filename="unlocked-parse.pdf")
        self._write_pdf(asset.managed_path or "", ["Unlocked parser page."])
        self.conn.commit()

        def fake_normalize(_path, _parser_name):
            self.assertFalse(self.conn.in_transaction)
            other_conn = make_conn(self.db_path)
            other_conn.execute("PRAGMA busy_timeout=100")
            try:
                queued = get_asset(other_conn, asset.id or 0)
                self.assertIsNotNone(queued)
                self.assertEqual(queued.parse_status, AssetParseStatus.QUEUED)  # type: ignore[union-attr]
                other_conn.execute("UPDATE papers SET title=title WHERE id=?", (paper_id,))
                other_conn.commit()
            finally:
                other_conn.close()
            return NormalizedParseOutput(
                document=NormalizedPdfDocument(
                    page_texts={1: "Unlocked parser page."},
                    blocks=[
                        NormalizedPdfBlock(
                            block_index=0,
                            page_number=1,
                            block_type="paragraph",
                            section_path=(),
                            text="Unlocked parser page.",
                        )
                    ],
                ),
                artifacts=[],
            )

        with patch("claudesk.core.pdf_ingest_parsers.normalize_pdf_document", side_effect=fake_normalize):
            result = ensure_pdf_ingested(
                self.conn,
                paper_id=paper_id,
                asset_id=asset.id or 0,
                cfg=self.cfg,
            )

        parsed = get_asset(self.conn, asset.id or 0)
        self.assertFalse(result.cache_hit)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed.parse_status, AssetParseStatus.PARSED)

    def test_missing_pymupdf4llm_package_marks_parse_failed(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = make_pdf_asset(self.conn, paper_id, filename="pymupdf4llm-missing.pdf")
        self._write_pdf(asset.managed_path or "", ["PyMuPDF4LLM text."])
        cfg = Config(
            paper_assets=PaperAssetsConfig(
                pdf_parser="pymupdf4llm",
            )
        )

        with patch.dict(sys.modules, {"pymupdf4llm": None}):
            with self.assertRaisesRegex(PdfIngestError, "PyMuPDF4LLM parser selected"):
                ensure_pdf_ingested(
                    self.conn,
                    paper_id=paper_id,
                    asset_id=asset.id or 0,
                    cfg=cfg,
                )

        parsed = get_asset(self.conn, asset.id or 0)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed.parse_status, AssetParseStatus.FAILED)
        self.assertEqual(parsed.parser_name, "pymupdf4llm")
        self.assertIn("PyMuPDF4LLM parser selected", parsed.parse_error or "")

    def test_pymupdf4llm_parser_writes_artifacts_and_page_box_blocks(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = make_pdf_asset(self.conn, paper_id, filename="pymupdf4llm.pdf")
        self._write_pdf(asset.managed_path or "", ["Fallback page one.", "Fallback page two."])
        cfg = Config(
            paper_assets=PaperAssetsConfig(
                pdf_parser="pymupdf4llm",
            )
        )
        calls: dict[str, dict] = {}

        def fake_to_markdown(path: str, **kwargs) -> list[dict]:  # noqa: ARG001
            calls["markdown"] = kwargs
            return [
                {
                    "metadata": {"page_number": 1},
                    "text": "Intro text.\nTable value.",
                    "page_boxes": [
                        {"index": 0, "class": "heading", "bbox": [1, 2, 3, 4], "pos": [0, 11]},
                        {"index": 1, "class": "table", "bbox": [5, 6, 7, 8], "pos": [12, 24]},
                    ],
                },
                {
                    "metadata": {"page_number": 2},
                    "text": "",
                    "page_boxes": [],
                },
            ]

        def fake_to_json(path: str, **kwargs) -> str:  # noqa: ARG001
            calls["json"] = kwargs
            return '{"pymupdf4llm": true}'

        fake_module = SimpleNamespace(to_markdown=fake_to_markdown, to_json=fake_to_json)

        with patch.dict(sys.modules, {"pymupdf4llm": fake_module}):
            ensure_pdf_ingested(
                self.conn,
                paper_id=paper_id,
                asset_id=asset.id or 0,
                cfg=cfg,
            )

        parsed = get_asset(self.conn, asset.id or 0)
        artifacts = list_asset_parse_artifacts(self.conn, asset.id or 0)
        blocks = list_asset_document_blocks(self.conn, asset.id or 0)

        self.assertIsNotNone(parsed)
        self.assertEqual(parsed.parser_name, "pymupdf4llm")
        self.assertIn("claudesk-normalized-v1", parsed.parser_version or "")
        self.assertEqual(
            sorted(artifact.artifact_kind for artifact in artifacts),
            ["markdown", "normalized_json", "parser_json"],
        )
        self.assertEqual(calls["markdown"]["use_ocr"], False)
        self.assertEqual(calls["markdown"]["write_images"], False)
        self.assertEqual(calls["markdown"]["embed_images"], False)
        self.assertEqual(calls["json"]["use_ocr"], False)
        self.assertEqual([block.block_type for block in blocks], ["heading", "table", "paragraph"])
        self.assertEqual(blocks[0].bbox, [1.0, 2.0, 3.0, 4.0])
        self.assertEqual(blocks[0].metadata["source"], "pymupdf4llm_page_box")
        self.assertEqual(blocks[2].metadata["source"], "pymupdf4llm_page_markdown")

    def test_pymupdf4llm_parser_continues_when_json_export_fails(self) -> None:
        def fake_to_markdown(path: str, **kwargs) -> list[dict]:  # noqa: ARG001
            return [{"metadata": {"page_number": 1}, "text": "Markdown only.", "page_boxes": []}]

        def fake_to_json(path: str, **kwargs) -> str:  # noqa: ARG001
            raise RuntimeError("json failed")

        fake_module = SimpleNamespace(to_markdown=fake_to_markdown, to_json=fake_to_json)
        with (
            patch.dict(sys.modules, {"pymupdf4llm": fake_module}),
            patch("claudesk.core.pdf_ingest_parsers.load_page_texts", return_value={1: "Fallback text."}),
            patch("claudesk.core.pdf_ingest_parsers.pdf_page_numbers", return_value=[1]),
        ):
            output = __import__(
                "claudesk.core.pdf_ingest_parsers",
                fromlist=["normalize_pymupdf4llm_document"],
            ).normalize_pymupdf4llm_document(os.path.join(self.tmpdir.name, "fake.pdf"))

        self.assertEqual([artifact.artifact_kind for artifact in output.artifacts], ["markdown"])
        self.assertEqual(output.document.blocks[0].text, "Markdown only.")

    def test_docling_parser_dispatch_writes_native_and_normalized_artifacts(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = make_pdf_asset(self.conn, paper_id, filename="docling.pdf")
        self._write_pdf(asset.managed_path or "", ["Docling parsed text."])
        cfg = Config(
            paper_assets=PaperAssetsConfig(
                pdf_parser="docling",
            )
        )
        output = NormalizedParseOutput(
            document=NormalizedPdfDocument(
                page_texts={1: "Docling normalized page text."},
                blocks=[
                    NormalizedPdfBlock(
                        block_index=0,
                        page_number=1,
                        block_type="paragraph",
                        section_path=("Methods",),
                        text="Docling normalized page text.",
                    )
                ],
            ),
            artifacts=[
                ParseArtifactContent(
                    artifact_kind="parser_json",
                    content=b'{"docling": true}',
                    mime_type="application/json",
                    extension="json",
                ),
                ParseArtifactContent(
                    artifact_kind="markdown",
                    content=b"# Docling",
                    mime_type="text/markdown",
                    extension="md",
                ),
            ],
        )

        with patch("claudesk.core.pdf_ingest_parsers.normalize_docling_document", return_value=output):
            ensure_pdf_ingested(
                self.conn,
                paper_id=paper_id,
                asset_id=asset.id or 0,
                cfg=cfg,
            )

        parsed = get_asset(self.conn, asset.id or 0)
        artifacts = list_asset_parse_artifacts(self.conn, asset.id or 0)
        chunks = list_asset_text_chunks(self.conn, asset.id or 0)

        self.assertIsNotNone(parsed)
        self.assertEqual(parsed.parser_name, "docling")
        self.assertIn("claudesk-normalized-v1", parsed.parser_version or "")
        self.assertEqual(
            sorted(artifact.artifact_kind for artifact in artifacts),
            ["markdown", "normalized_json", "parser_json"],
        )
        self.assertEqual(chunks[0].section_path, ["Methods"])

    def test_docling_parser_disables_ocr_pipeline_by_default(self) -> None:
        class FakePdfPipelineOptions:
            def __init__(self, *, do_ocr: bool = True) -> None:
                self.do_ocr = do_ocr

        class FakePdfFormatOption:
            def __init__(self, *, pipeline_options) -> None:
                self.pipeline_options = pipeline_options

        class FakeDocument:
            def export_to_markdown(self, page_no: int | None = None) -> str:  # noqa: ARG002
                return "Docling text."

            def export_to_dict(self) -> dict:
                return {"docling": True}

        captured: dict[str, object] = {}

        class FakeDocumentConverter:
            def __init__(self, *, format_options) -> None:
                captured["format_options"] = format_options

            def convert(self, path):  # noqa: ARG002
                return SimpleNamespace(document=FakeDocument())

        fake_input_format = SimpleNamespace(PDF="pdf")
        modules = {
            "docling": SimpleNamespace(),
            "docling.datamodel": SimpleNamespace(),
            "docling.datamodel.base_models": SimpleNamespace(InputFormat=fake_input_format),
            "docling.datamodel.pipeline_options": SimpleNamespace(PdfPipelineOptions=FakePdfPipelineOptions),
            "docling.document_converter": SimpleNamespace(
                DocumentConverter=FakeDocumentConverter,
                PdfFormatOption=FakePdfFormatOption,
            ),
        }

        with (
            patch.dict(sys.modules, modules),
            patch("claudesk.core.pdf_ingest_parsers.load_page_texts", return_value={1: "Fallback text."}),
            patch("claudesk.core.pdf_ingest_parsers.pdf_page_numbers", return_value=[1]),
        ):
            output = __import__(
                "claudesk.core.pdf_ingest_parsers",
                fromlist=["normalize_docling_document"],
            ).normalize_docling_document(os.path.join(self.tmpdir.name, "fake.pdf"))

        format_option = captured["format_options"]["pdf"]
        self.assertFalse(format_option.pipeline_options.do_ocr)
        self.assertEqual(output.document.page_texts[1], "Docling text.")

    def test_docling_placeholder_only_page_uses_pymupdf_fallback_text(self) -> None:
        class FakePdfPipelineOptions:
            def __init__(self, *, do_ocr: bool = True) -> None:
                self.do_ocr = do_ocr

        class FakePdfFormatOption:
            def __init__(self, *, pipeline_options) -> None:
                self.pipeline_options = pipeline_options

        class FakeDocument:
            def export_to_markdown(self, page_no: int | None = None) -> str:
                if page_no == 1:
                    return "\n<!-- image -->\n"
                if page_no == 2:
                    return "Real Docling text.\n\n<!-- image -->"
                return "Full Docling markdown with <!-- image --> placeholder."

            def export_to_dict(self) -> dict:
                return {"docling": True}

        class FakeDocumentConverter:
            def __init__(self, *, format_options) -> None:  # noqa: ARG002
                pass

            def convert(self, path):  # noqa: ARG002
                return SimpleNamespace(document=FakeDocument())

        fake_input_format = SimpleNamespace(PDF="pdf")
        modules = {
            "docling": SimpleNamespace(),
            "docling.datamodel": SimpleNamespace(),
            "docling.datamodel.base_models": SimpleNamespace(InputFormat=fake_input_format),
            "docling.datamodel.pipeline_options": SimpleNamespace(PdfPipelineOptions=FakePdfPipelineOptions),
            "docling.document_converter": SimpleNamespace(
                DocumentConverter=FakeDocumentConverter,
                PdfFormatOption=FakePdfFormatOption,
            ),
        }

        with (
            patch.dict(sys.modules, modules),
            patch("claudesk.core.pdf_ingest_parsers.load_page_texts", return_value={
                1: "Fallback page one text.",
                2: "Fallback page two text.",
            }),
            patch("claudesk.core.pdf_ingest_parsers.pdf_page_numbers", return_value=[1, 2]),
        ):
            output = __import__(
                "claudesk.core.pdf_ingest_parsers",
                fromlist=["normalize_docling_document"],
            ).normalize_docling_document(os.path.join(self.tmpdir.name, "fake.pdf"))

        self.assertEqual(output.document.page_texts[1], "Fallback page one text.")
        self.assertEqual(output.document.blocks[0].text, "Fallback page one text.")
        self.assertEqual(output.document.page_texts[2], "Real Docling text.\n\n<!-- image -->")
        self.assertEqual(output.document.blocks[1].text, "Real Docling text.\n\n<!-- image -->")
        markdown_artifact = next(
            artifact for artifact in output.artifacts if artifact.artifact_kind == "markdown"
        )
        self.assertEqual(
            markdown_artifact.content.decode("utf-8"),
            "Full Docling markdown with <!-- image --> placeholder.",
        )

    def test_missing_mineru_cli_marks_parse_failed(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = make_pdf_asset(self.conn, paper_id, filename="mineru.pdf")
        self._write_pdf(asset.managed_path or "", ["MinerU text."])
        cfg = Config(
            paper_assets=PaperAssetsConfig(
                pdf_parser="mineru",
            )
        )

        with patch("claudesk.core.pdf_ingest_parsers.shutil.which", return_value=None):
            with self.assertRaisesRegex(PdfIngestError, "MinerU parser selected"):
                ensure_pdf_ingested(
                    self.conn,
                    paper_id=paper_id,
                    asset_id=asset.id or 0,
                    cfg=cfg,
                )

        parsed = get_asset(self.conn, asset.id or 0)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed.parse_status, AssetParseStatus.FAILED)
        self.assertEqual(parsed.parser_name, "mineru")
        self.assertIn("MinerU parser selected", parsed.parse_error or "")

    def test_lazy_ingestion_uses_vault_asset_root(self) -> None:
        with patched_data_dir(self.tmpdir.name):
            cfg = Config()
            paper_id = upsert_paper(self.conn, make_paper())
            asset = make_pdf_asset(self.conn, paper_id, filename="relative-root.pdf")
            path = resolve_managed_asset_path(asset.managed_path or "", cfg=cfg)
            path.parent.mkdir(parents=True, exist_ok=True)

            import fitz

            doc = fitz.open()
            try:
                page = doc.new_page(width=300, height=200)
                page.insert_text((36, 72), "Relative root PDF text.", fontsize=12)
                doc.save(str(path))
            finally:
                doc.close()

            ensure_pdf_ingested(
                self.conn,
                paper_id=paper_id,
                asset_id=asset.id or 0,
                cfg=cfg,
            )
            pages = list_asset_pdf_pages(self.conn, asset.id or 0)
            image_exists = resolve_managed_asset_path(pages[0].image_managed_path or "", cfg=cfg).exists()

        self.assertEqual(len(pages), 1)
        self.assertTrue(image_exists)

    def test_lazy_ingestion_reuses_current_cache(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = make_pdf_asset(self.conn, paper_id)
        self._write_pdf(asset.managed_path or "", ["Cache hit page text."])
        first = ensure_pdf_ingested(
            self.conn,
            paper_id=paper_id,
            asset_id=asset.id or 0,
            cfg=self.cfg,
        )
        second = ensure_pdf_ingested(
            self.conn,
            paper_id=paper_id,
            asset_id=asset.id or 0,
            cfg=self.cfg,
        )

        self.assertFalse(first.cache_hit)
        self.assertTrue(second.cache_hit)
        self.assertEqual(count_asset_pdf_pages(self.conn, asset.id or 0), 1)

    def test_missing_pdf_marks_parse_failed(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = make_pdf_asset(self.conn, paper_id)

        with self.assertRaisesRegex(PdfIngestError, "not found"):
            ensure_pdf_ingested(
                self.conn,
                paper_id=paper_id,
                asset_id=asset.id or 0,
                cfg=self.cfg,
            )

        parsed = get_asset(self.conn, asset.id or 0)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed.parse_status, AssetParseStatus.FAILED)
        self.assertIn("not found", parsed.parse_error or "")

    def test_rejects_non_pdf_and_unlinked_assets(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        other_paper = make_paper()
        other_paper.external_id = "10.1234/other-pdf-ingest"
        other_paper_id = upsert_paper(self.conn, other_paper)
        pdf_asset = make_pdf_asset(self.conn, paper_id)
        text_asset = create_paper_asset(
            self.conn,
            paper_id,
            kind=AssetKind.TEXT,
            source="manual",
            managed_path="papers/text.txt",
            original_filename="text.txt",
            mime_type="text/plain",
            size_bytes=10,
            content_hash="sha256-text",
            parse_status=AssetParseStatus.NOT_PARSED,
        )

        with self.assertRaisesRegex(PdfIngestError, "not a PDF"):
            ensure_pdf_ingested(
                self.conn,
                paper_id=paper_id,
                asset_id=text_asset.id or 0,
                cfg=self.cfg,
            )
        with self.assertRaisesRegex(PdfIngestError, "not found"):
            ensure_pdf_ingested(
                self.conn,
                paper_id=other_paper_id,
                asset_id=pdf_asset.id or 0,
                cfg=self.cfg,
            )

    def test_cleanup_removes_rendered_page_files(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = make_pdf_asset(self.conn, paper_id)
        self._write_pdf(asset.managed_path or "", ["Cleanup page text."])
        ensure_pdf_ingested(
            self.conn,
            paper_id=paper_id,
            asset_id=asset.id or 0,
            cfg=self.cfg,
        )
        pages = list_asset_pdf_pages(self.conn, asset.id or 0)
        image_paths = [
            resolve_managed_asset_path(page.image_managed_path or "", cfg=self.cfg)
            for page in pages
        ]
        self.assertTrue(all(path.exists() for path in image_paths))

        clear_pdf_ingest_cache(self.conn, asset.id or 0, cfg=self.cfg)

        self.assertEqual(count_asset_pdf_pages(self.conn, asset.id or 0), 0)
        self.assertEqual(count_asset_text_chunks(self.conn, asset.id or 0), 0)
        self.assertEqual(count_asset_document_blocks(self.conn, asset.id or 0), 0)
        self.assertTrue(all(not path.exists() for path in image_paths))


if __name__ == "__main__":
    unittest.main()
