from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from datetime import date
from types import SimpleNamespace
from unittest.mock import patch

from claudesk.agent.capabilities import execute_capability, execute_capability_text
from claudesk.agent.capabilities import pdf as pdf_capabilities
from claudesk.agent.exports.openai import openai_tool_schemas
from claudesk.core.config import ChatToolsConfig, Config
from claudesk.core.db.assets import (
    create_paper_asset,
    insert_asset_document_block,
    insert_asset_text_chunk,
    update_asset_parse_state,
    upsert_asset_pdf_page,
)
from claudesk.core.db import init_db
from claudesk.core.db.papers import upsert_paper
from claudesk.core.models import AssetKind, AssetParseStatus, Paper
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
    external_id: str = "10.1234/agent-pdf",
    title: str = "Agent PDF paper",
) -> Paper:
    return Paper(
        source="biorxiv",
        external_id=external_id,
        title=title,
        abstract="Agent PDF abstract",
        authors=["Alice Example"],
        published_date=date(2026, 4, 30),
        url="https://example.com/agent-pdf",
    )


class AgentPdfToolTests(unittest.TestCase):
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

    def _create_pdf_asset(self, paper_id: int, filename: str = "agent.pdf", *, write_file: bool = True):
        asset = create_paper_asset(
            self.conn,
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
        if write_file:
            self._write_pdf(asset.managed_path or "", [
                "Alpha opening section with local PDF context.",
                "Beta figure caption describes microscopy panels.",
            ])
        return asset

    def test_list_paper_assets_shows_cache_metadata(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        self._create_pdf_asset(paper_id)

        result = execute_capability(
            "list_paper_assets",
            {"paper_id": paper_id},
            self.conn,
            cfg=self.cfg,
        )
        payload = json.loads(result.text)

        self.assertTrue(payload["ok"])
        self.assertEqual(len(payload["assets"]), 1)
        asset = payload["assets"][0]
        self.assertEqual(asset["kind"], "pdf")
        self.assertEqual(asset["parse_status"], "not_parsed")
        self.assertEqual(asset["page_count"], 0)
        self.assertTrue(asset["file_exists"])
        self.assertEqual(
            [(read.resource_kind, read.resource_id) for read in result.resource_reads],
            [("paper", str(paper_id)), ("asset", str(asset["id"]))],
        )

    def test_read_paper_pdf_parses_chunks_and_attaches_page_images(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = self._create_pdf_asset(paper_id)

        result = execute_capability(
            "read_paper_pdf",
            {
                "paper_id": paper_id,
                "asset_id": asset.id,
                "include_page_images": True,
            },
            self.conn,
            cfg=self.cfg,
        )
        payload = json.loads(result.text)

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["asset"]["parse_status"], "parsed")
        self.assertGreaterEqual(len(payload["chunks"]), 1)
        self.assertGreaterEqual(len(result.images), 1)
        self.assertEqual(result.images[0].asset_id, asset.id)
        read_kinds = [read.resource_kind for read in result.resource_reads]
        self.assertIn("pdf_chunk", read_kinds)
        self.assertIn("pdf_page", read_kinds)
        chunk_read = next(read for read in result.resource_reads if read.resource_kind == "pdf_chunk")
        page_read = next(read for read in result.resource_reads if read.resource_kind == "pdf_page")
        self.assertEqual(chunk_read.locator["asset_id"], asset.id)
        self.assertEqual(chunk_read.locator["chunk_index"], payload["chunks"][0]["chunk_index"])
        self.assertEqual(page_read.locator["page_number"], result.images[0].page_number)

    def test_search_paper_pdf_returns_matching_chunks_and_hit_page_images(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = self._create_pdf_asset(paper_id)

        result = execute_capability(
            "search_paper_pdf",
            {
                "paper_id": paper_id,
                "asset_id": asset.id,
                "query": "microscopy",
                "backend": "hybrid",
            },
            self.conn,
            cfg=self.cfg,
        )
        payload = json.loads(result.text)

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["query"], "microscopy")
        self.assertEqual(len(payload["matches"]), 1)
        self.assertIn("microscopy", payload["matches"][0]["text"])
        self.assertEqual(len(result.images), 1)
        self.assertEqual(result.images[0].page_number, payload["matches"][0]["page_number"])
        chunk_read = next(read for read in result.resource_reads if read.resource_kind == "pdf_chunk")
        page_read = next(read for read in result.resource_reads if read.resource_kind == "pdf_page")
        self.assertEqual(chunk_read.locator["chunk_id"], payload["matches"][0]["chunk_id"])
        self.assertEqual(page_read.locator["page_number"], payload["matches"][0]["page_number"])

    def test_inspect_paper_pdf_pages_returns_page_text_and_images(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = self._create_pdf_asset(paper_id)

        result = execute_capability(
            "inspect_paper_pdf_pages",
            {
                "paper_id": paper_id,
                "asset_id": asset.id,
                "pages": [2],
                "include_text": True,
                "include_images": True,
            },
            self.conn,
            cfg=self.cfg,
        )
        payload = json.loads(result.text)

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["pages"][0]["page_number"], 2)
        self.assertIn("Beta figure", payload["pages"][0]["text"])
        self.assertEqual(len(result.images), 1)
        self.assertEqual(result.images[0].page_number, 2)
        page_read = next(read for read in result.resource_reads if read.resource_kind == "pdf_page")
        self.assertEqual(page_read.locator, {
            "paper_id": paper_id,
            "asset_id": asset.id,
            "page_number": 2,
        })

    def test_rag_pdf_tools_return_structure_retrieval_and_section_blocks(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = self._create_pdf_asset(paper_id, write_file=False)
        asset_id = asset.id or 0
        upsert_asset_pdf_page(
            self.conn,
            asset_id=asset_id,
            page_number=1,
            text="Results page text.",
            image_managed_path="derived/pdf-pages/1/page-0001-dpi144.png",
        )
        block = insert_asset_document_block(
            self.conn,
            asset_id=asset_id,
            block_index=0,
            page_number=1,
            block_type="paragraph",
            section_path=["Results"],
            text="Microscopy evidence appears in the results section.",
            bbox=[1, 2, 3, 4],
        )
        chunk = insert_asset_text_chunk(
            self.conn,
            asset_id=asset_id,
            chunk_index=0,
            page_number=1,
            text="Microscopy evidence appears in the results section.",
            block_type="paragraph",
            section_path=["Results"],
            bbox=[1, 2, 3, 4],
            block_ids=[block.id or 0],
        )
        insert_asset_text_chunk(
            self.conn,
            asset_id=asset_id,
            chunk_index=1,
            page_number=1,
            text="Additional background without the retrieval target.",
            block_type="paragraph",
            section_path=["Results"],
            block_ids=[block.id or 0],
        )
        parsed = update_asset_parse_state(
            self.conn,
            asset_id,
            parse_status=AssetParseStatus.PARSED,
            parser_name="pymupdf",
            parser_version="claudesk-normalized-v1",
        )
        fake_result = SimpleNamespace(asset=parsed, cache_hit=True)

        with patch.object(pdf_capabilities, "ensure_pdf_ingested", return_value=fake_result):
            structure_result = execute_capability(
                "list_paper_structure",
                {"paper_id": paper_id, "asset_id": asset_id},
                self.conn,
                cfg=self.cfg,
            )
            retrieval_result = execute_capability(
                "retrieve_paper_context",
                {"paper_id": paper_id, "asset_id": asset_id, "query": "microscopy"},
                self.conn,
                cfg=self.cfg,
            )
            no_match = json.loads(execute_capability_text(
                "retrieve_paper_context",
                {"paper_id": paper_id, "asset_id": asset_id, "query": "unmatchedterm"},
                self.conn,
                cfg=self.cfg,
            ))
            section_result = execute_capability(
                "read_paper_section",
                {"paper_id": paper_id, "asset_id": asset_id, "section_path": ["Results"]},
                self.conn,
                cfg=self.cfg,
            )
            read_page_result = execute_capability(
                "read_paper_pdf",
                {"paper_id": paper_id, "asset_id": asset_id, "start_chunk": 0, "limit": 1},
                self.conn,
                cfg=self.cfg,
            )

        structure = json.loads(structure_result.text)
        retrieval = json.loads(retrieval_result.text)
        section = json.loads(section_result.text)
        read_page = json.loads(read_page_result.text)

        self.assertTrue(structure["ok"])
        self.assertEqual(structure["sections"][0]["section_path"], ["Results"])
        self.assertEqual(structure["block_type_counts"]["paragraph"], 1)
        self.assertTrue(retrieval["ok"])
        self.assertEqual(retrieval["evidence"][0]["chunk_id"], chunk.id)
        self.assertEqual(retrieval["evidence"][0]["asset_id"], asset_id)
        self.assertEqual(retrieval["evidence"][0]["section_path"], ["Results"])
        self.assertEqual(retrieval["evidence"][0]["block_ids"], [block.id])
        self.assertEqual(retrieval["evidence"][0]["source"], "parsed_full_text")
        self.assertTrue(no_match["ok"])
        self.assertEqual(no_match["evidence"], [])
        self.assertEqual(no_match["warning"], "no_matching_chunks")
        self.assertEqual(no_match["next_step"]["tool"], "read_paper_pdf")
        self.assertEqual(no_match["next_step"]["paper_id"], paper_id)
        self.assertEqual(no_match["next_step"]["asset_id"], asset_id)
        self.assertEqual(no_match["next_step"]["start_chunk"], 0)
        self.assertEqual(no_match["next_step"]["limit"], 12)
        self.assertTrue(section["ok"])
        self.assertEqual(section["blocks"][0]["asset_id"], asset_id)
        self.assertIn("Microscopy evidence", section["blocks"][0]["text"])
        self.assertTrue(read_page["ok"])
        self.assertEqual(read_page["next_chunk_index"], 1)
        self.assertEqual(read_page["next_step"]["tool"], "read_paper_pdf")
        self.assertEqual(read_page["next_step"]["asset_id"], asset_id)
        self.assertEqual(read_page["next_step"]["start_chunk"], 1)
        self.assertEqual(read_page["next_step"]["limit"], 1)
        self.assertTrue(read_page["next_step"]["optional"])
        self.assertIn("current chunks are insufficient", read_page["next_step"]["use_when"])
        structure_section_read = next(
            read for read in structure_result.resource_reads if read.resource_kind == "pdf_section"
        )
        retrieval_chunk_read = next(
            read for read in retrieval_result.resource_reads if read.resource_kind == "pdf_chunk"
        )
        section_read = next(
            read for read in section_result.resource_reads if read.resource_kind == "pdf_section"
        )
        read_chunk = next(read for read in read_page_result.resource_reads if read.resource_kind == "pdf_chunk")
        self.assertEqual(structure_section_read.locator["section_path"], ["Results"])
        self.assertEqual(retrieval_chunk_read.locator["chunk_id"], chunk.id)
        self.assertEqual(section_read.locator["section_path"], ["Results"])
        self.assertEqual(read_chunk.locator["chunk_index"], 0)

    def test_pdf_tool_descriptions_route_summary_and_targeted_queries(self) -> None:
        descriptions = {
            schema["function"]["name"]: schema["function"]["description"]
            for schema in openai_tool_schemas()
        }

        self.assertIn("targeted", descriptions["retrieve_paper_context"])
        self.assertIn("not broad whole-paper summaries", descriptions["retrieve_paper_context"])
        self.assertIn("discovery step for whether a tagged paper has managed local PDFs", descriptions["list_paper_assets"])
        self.assertIn("before using internet full-text", descriptions["list_paper_assets"])
        self.assertIn("primary tool for broad local-PDF summaries", descriptions["read_paper_pdf"])
        self.assertIn("when a managed paper PDF exists", descriptions["read_paper_pdf"])
        self.assertIn("limit 8-12", descriptions["read_paper_pdf"])
        self.assertIn("do not exhaustively follow next_chunk_index", descriptions["read_paper_pdf"])

    def test_multiple_pdfs_without_asset_id_asks_for_selection(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        self._create_pdf_asset(paper_id, "first.pdf")
        self._create_pdf_asset(paper_id, "second.pdf")

        payload = json.loads(execute_capability_text(
            "read_paper_pdf",
            {"paper_id": paper_id},
            self.conn,
            cfg=self.cfg,
        ))

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"], "multiple_pdf_assets")
        self.assertEqual(len(payload["assets"]), 2)

    def test_missing_deleted_pdf_returns_clear_error(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        asset = self._create_pdf_asset(paper_id, write_file=False)

        payload = json.loads(execute_capability_text(
            "read_paper_pdf",
            {"paper_id": paper_id, "asset_id": asset.id},
            self.conn,
            cfg=self.cfg,
        ))

        self.assertFalse(payload["ok"])
        self.assertIn("not found", payload["error"])

    def test_missing_paper_or_unlinked_asset_returns_clear_error(self) -> None:
        paper_id = upsert_paper(self.conn, make_paper())
        other_paper_id = upsert_paper(self.conn, make_paper(
            external_id="10.1234/other-agent-pdf",
            title="Other agent PDF paper",
        ))
        asset = self._create_pdf_asset(paper_id)

        missing_paper = json.loads(execute_capability_text(
            "list_paper_assets",
            {"paper_id": 999},
            self.conn,
            cfg=self.cfg,
        ))
        unlinked = json.loads(execute_capability_text(
            "read_paper_pdf",
            {"paper_id": other_paper_id, "asset_id": asset.id},
            self.conn,
            cfg=self.cfg,
        ))

        self.assertFalse(missing_paper["ok"])
        self.assertFalse(unlinked["ok"])
        self.assertIn("not found", unlinked["error"])

    def test_paper_pdf_tool_gate_filters_all_pdf_tools(self) -> None:
        filtered = openai_tool_schemas(ChatToolsConfig(paper_pdf=False))
        names = {schema["function"]["name"] for schema in filtered}

        self.assertNotIn("list_paper_assets", names)
        self.assertNotIn("list_paper_structure", names)
        self.assertNotIn("retrieve_paper_context", names)
        self.assertNotIn("read_paper_section", names)
        self.assertNotIn("read_paper_pdf", names)
        self.assertNotIn("search_paper_pdf", names)
        self.assertNotIn("inspect_paper_pdf_pages", names)


if __name__ == "__main__":
    unittest.main()
