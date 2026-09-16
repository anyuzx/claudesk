from __future__ import annotations

import os
import tempfile
import textwrap
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import httpx
import yaml

from claudesk.core.config import Config, clear_vault_location_cache, load_config
from claudesk.sources import get_enabled_sources
from claudesk.sources import openalex
from tests.helpers import patched_data_dir


def make_json_response(url: str, payload: dict) -> httpx.Response:
    request = httpx.Request("GET", url)
    return httpx.Response(200, json=payload, request=request)


class OpenAlexAndSettingsTests(unittest.TestCase):
    def setUp(self) -> None:
        clear_vault_location_cache()
        load_config.cache_clear()

    def tearDown(self) -> None:
        clear_vault_location_cache()
        load_config.cache_clear()

    def test_load_config_reads_openalex_api_key_from_env(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            interests_path = Path(tmpdir) / "interests.yaml"
            interests_path.write_text("sources:\n  openalex:\n    enabled: true\n", encoding="utf-8")

            with (
                patched_data_dir(tmpdir),
                patch.dict(os.environ, {"OPENALEX_API_KEY": "openalex-secret"}, clear=False),
            ):
                load_config.cache_clear()
                cfg = load_config()

            self.assertEqual(cfg.sources.openalex.api_key, "openalex-secret")
            self.assertTrue(cfg.sources.openalex.enabled)

    def test_get_enabled_sources_includes_openalex_last(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            interests_path = Path(tmpdir) / "interests.yaml"
            interests_path.write_text(
                textwrap.dedent(
                    """
                    sources:
                      arxiv:
                        enabled: true
                      biorxiv:
                        enabled: false
                      pubmed:
                        enabled: true
                      openalex:
                        enabled: true
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )

            with patched_data_dir(tmpdir):
                load_config.cache_clear()
                names = [source.name for source in get_enabled_sources()]

            self.assertEqual(names, ["arxiv", "pubmed", "openalex"])

    def test_openalex_fetch_queries_keywords_and_tracked_authors(self) -> None:
        cfg = Config()
        cfg.digest.max_per_source = 2

        def fake_get(url: str, *, params: dict, headers: dict, timeout: float) -> httpx.Response:
            self.assertEqual(headers, openalex._HEADERS)
            self.assertEqual(params["api_key"], "openalex-key")

            if url == openalex.AUTHORS_API:
                self.assertEqual(params["search"], "Jan Lipfert")
                return make_json_response(
                    url,
                    {
                        "results": [
                            {
                                "id": "https://openalex.org/A1234567890",
                                "display_name": "Jan Lipfert",
                            }
                        ]
                    },
                )

            if url == openalex.WORKS_API and params.get("search") == "single molecule":
                self.assertEqual(params["filter"], "from_publication_date:2026-04-20,type:article|preprint,has_abstract:true")
                return make_json_response(
                    url,
                    {
                        "results": [
                            {
                                "id": "https://openalex.org/W999",
                                "doi": "https://doi.org/10.1234/example-doi",
                                "display_name": "Single molecule biophysics paper",
                                "publication_date": "2026-04-23",
                                "abstract_inverted_index": {
                                    "Single": [0],
                                    "molecule": [1],
                                    "study": [2],
                                },
                                "authorships": [
                                    {"author": {"display_name": "Alice Example"}},
                                    {"author": {"display_name": "Bob Example"}},
                                ],
                                "primary_location": {
                                    "landing_page_url": "https://example.org/paper",
                                    "source": {
                                        "id": "https://openalex.org/S123",
                                        "display_name": "Proceedings of the National Academy of Sciences",
                                    },
                                },
                            }
                        ]
                    },
                )

            if url == openalex.WORKS_API and "authorships.author.id:A1234567890" in params.get("filter", ""):
                return make_json_response(
                    url,
                    {
                        "results": [
                            {
                                "id": "https://openalex.org/W555",
                                "doi": None,
                                "display_name": "Tracked author recent work",
                                "publication_date": "2026-04-21",
                                "abstract_inverted_index": {
                                    "Tracked": [0],
                                    "author": [1],
                                    "result.": [2],
                                },
                                "authorships": [
                                    {"author": {"display_name": "Jan Lipfert"}},
                                ],
                                "primary_location": {
                                    "source": {
                                        "id": "https://openalex.org/S456",
                                        "display_name": "bioRxiv",
                                    },
                                },
                            }
                        ]
                    },
                )

            if url == f"{openalex.SOURCES_API}/S123":
                self.assertEqual(params["select"], "id,display_name,abbreviated_title")
                return make_json_response(
                    url,
                    {
                        "id": "https://openalex.org/S123",
                        "display_name": "Proceedings of the National Academy of Sciences",
                        "abbreviated_title": "Proc Natl Acad Sci U S A",
                    },
                )

            if url == f"{openalex.SOURCES_API}/S456":
                self.assertEqual(params["select"], "id,display_name,abbreviated_title")
                return make_json_response(
                    url,
                    {
                        "id": "https://openalex.org/S456",
                        "display_name": "bioRxiv",
                        "abbreviated_title": None,
                    },
                )

            raise AssertionError(f"Unexpected OpenAlex request: {url} {params}")

        with (
            patch.object(openalex, "load_config", return_value=cfg),
            patch.object(openalex.httpx, "get", side_effect=fake_get),
        ):
            papers = openalex.fetch(
                datetime(2026, 4, 20),
                keywords=["single molecule"],
                tracked_authors=["Jan Lipfert"],
                api_key="openalex-key",
            )

        self.assertEqual(len(papers), 2)
        self.assertEqual(papers[0].source, "openalex")
        self.assertEqual(papers[0].external_id, "10.1234/example-doi")
        self.assertEqual(papers[0].url, "https://example.org/paper")
        self.assertEqual(papers[0].abstract, "Single molecule study")
        self.assertEqual(papers[0].journal_abbrev, "Proc Natl Acad Sci U S A")
        self.assertEqual(papers[1].external_id, "W555")
        self.assertEqual(papers[1].authors, ["Jan Lipfert"])
        self.assertEqual(papers[1].abstract, "Tracked author result.")
        self.assertEqual(papers[1].journal_abbrev, "bioRxiv")

    def test_openalex_fetch_work_by_doi_does_not_require_source_api_key(self) -> None:
        def fake_get(url: str, *, headers: dict, timeout: float) -> httpx.Response:
            self.assertEqual(url, f"{openalex.WORKS_API}/doi:10.48550%2Farxiv.2604.08316")
            self.assertEqual(headers, openalex._HEADERS)
            self.assertEqual(timeout, 30.0)
            return make_json_response(
                url,
                {
                    "id": "https://openalex.org/W123",
                    "doi": "https://doi.org/10.48550/arXiv.2604.08316",
                    "display_name": "OpenAlex DOI lookup",
                    "publication_date": "2026-04-08",
                    "abstract_inverted_index": {
                        "Direct": [0],
                        "lookup": [1],
                    },
                    "authorships": [
                        {"author": {"display_name": "Alice Example"}},
                    ],
                    "primary_location": {
                        "landing_page_url": "https://example.org/openalex-doi",
                        "source": {
                            "id": "https://openalex.org/S999",
                            "display_name": "arXiv",
                        },
                    },
                },
            )

        with patch.object(openalex.httpx, "get", side_effect=fake_get):
            paper = openalex.fetch_work_by_doi("10.48550/arXiv.2604.08316")

        self.assertIsNotNone(paper)
        assert paper is not None
        self.assertEqual(paper.source, "openalex")
        self.assertEqual(paper.external_id, "10.48550/arxiv.2604.08316")
        self.assertEqual(paper.title, "OpenAlex DOI lookup")
        self.assertEqual(paper.abstract, "Direct lookup")
        self.assertEqual(paper.journal_abbrev, "arXiv")

    def test_openalex_fetch_requires_api_key(self) -> None:
        with patch.object(openalex, "load_config", return_value=Config()):
            with self.assertRaisesRegex(ValueError, "OPENALEX_API_KEY"):
                openalex.fetch(
                    datetime(2026, 4, 20),
                    keywords=["biophysics"],
                    tracked_authors=[],
                )

    # Legacy /api/settings/{sources,digest} routes were removed in the
    # settings-registry refactor. Equivalent round-trip + missing-file coverage
    # now lives in tests.test_settings_registry. The four tests that exercised
    # those endpoints were deleted with the routes themselves.


if __name__ == "__main__":
    unittest.main()
