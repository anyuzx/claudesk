from __future__ import annotations

import unittest
from datetime import date, datetime
from unittest.mock import patch

import httpx

from claudesk.core.config import Config
from claudesk.sources import pubmed


def make_json_response(url: str, payload: dict, *, method: str = "GET") -> httpx.Response:
    request = httpx.Request(method, url)
    return httpx.Response(200, json=payload, request=request)


def make_status_response(url: str, status_code: int, *, method: str = "GET") -> httpx.Response:
    request = httpx.Request(method, url)
    return httpx.Response(status_code, request=request)


class PubmedSourceTests(unittest.TestCase):
    def test_raw_legacy_search_terms_generate_parenthesized_or_query(self) -> None:
        cfg = Config()
        cfg.sources.pubmed.query_mode = "raw"
        cfg.sources.pubmed.search_terms = [
            "biophysics[MeSH]",
            " chromatin[Title/Abstract] ",
            "biophysics[MeSH]",
            "",
        ]

        self.assertEqual(
            pubmed.build_pubmed_query(cfg),
            "(biophysics[MeSH]) OR (chromatin[Title/Abstract])",
        )
        self.assertEqual(
            pubmed.build_pubmed_query(cfg, search_terms=["raw[MeSH]", "raw[MeSH]"]),
            "(raw[MeSH])",
        )

    def test_auto_query_uses_topics_keywords_profile_and_exclusions(self) -> None:
        cfg = Config()
        cfg.topics = ["single molecule", "chromatin"]
        cfg.keywords.include = ["optical tweezers", "Chromatin"]
        cfg.keywords.exclude = ["clinical trial", "case report"]
        cfg.profile.field = ["Biophysics", "chromatin"]

        self.assertEqual(
            pubmed.build_pubmed_query(cfg),
            (
                '(("single molecule"[Title/Abstract] OR "single molecule"[MeSH Terms]) OR '
                '("chromatin"[Title/Abstract] OR "chromatin"[MeSH Terms]) OR '
                '("optical tweezers"[Title/Abstract] OR "optical tweezers"[MeSH Terms]) OR '
                '("Biophysics"[Title/Abstract] OR "Biophysics"[MeSH Terms])) '
                'AND NOT (("clinical trial"[Title/Abstract] OR "clinical trial"[MeSH Terms]) OR '
                '("case report"[Title/Abstract] OR "case report"[MeSH Terms]))'
            ),
        )

    def test_builder_query_generation_for_each_scope(self) -> None:
        self.assertEqual(
            pubmed.build_literal_pubmed_query(
                concepts=["chromatin organization"],
                exclude_terms=[],
                scope="title_abstract",
            ),
            '"chromatin organization"[Title/Abstract]',
        )
        self.assertEqual(
            pubmed.build_literal_pubmed_query(
                concepts=["chromatin organization"],
                exclude_terms=[],
                scope="mesh",
            ),
            '"chromatin organization"[MeSH Terms]',
        )
        self.assertEqual(
            pubmed.build_literal_pubmed_query(
                concepts=["chromatin organization"],
                exclude_terms=[],
                scope="title_abstract_or_mesh",
            ),
            '("chromatin organization"[Title/Abstract] OR "chromatin organization"[MeSH Terms])',
        )

    def test_builder_exclusions_use_same_scope(self) -> None:
        self.assertEqual(
            pubmed.build_literal_pubmed_query(
                concepts=["chromatin", "nucleosome"],
                exclude_terms=["clinical trial"],
                scope="title_abstract",
            ),
            (
                '("chromatin"[Title/Abstract] OR "nucleosome"[Title/Abstract]) '
                'AND NOT "clinical trial"[Title/Abstract]'
            ),
        )

    def test_generated_query_plan_warns_and_splits_with_exclusions(self) -> None:
        cfg = Config()
        cfg.digest.max_per_source = 25
        cfg.topics = [
            "chromatin remodeling mechanics",
            "single molecule force spectroscopy",
            "polymer condensate rheology",
            "active chromatin microrheology",
        ]
        cfg.keywords.include = ["optical tweezer nucleosome mechanics"]
        cfg.keywords.exclude = ["clinical trial", "case report"]

        with patch.object(pubmed, "ESEARCH_SAFE_URL_LENGTH", 430):
            plan = pubmed.build_pubmed_query_plan(cfg)

        self.assertEqual(plan.query_mode, "auto")
        self.assertEqual(plan.length_status, "too_long")
        self.assertIsNotNone(plan.warning)
        self.assertIn("split", plan.warning or "")
        self.assertGreater(len(plan.queries), 1)
        self.assertEqual(plan.encoded_request_length, pubmed._encoded_esearch_request_length(
            plan.query,
            date(2000, 1, 1),
            date(2000, 1, 1),
            cfg.digest.max_per_source,
            cfg.sources.pubmed.api_key,
        ))
        for query in plan.queries:
            self.assertIn('AND NOT (("clinical trial"[Title/Abstract]', query)
            self.assertIn('"case report"[MeSH Terms])', query)

    def test_fetch_splits_queries_dedupes_pmids_and_applies_total_source_cap(self) -> None:
        cfg = Config()
        cfg.digest.max_per_source = 3
        cfg.sources.pubmed.query_mode = "builder"
        cfg.sources.pubmed.concepts = [
            "alpha chromatin remodeling mechanics",
            "beta chromatin remodeling mechanics",
            "gamma chromatin remodeling mechanics",
        ]
        cfg.sources.pubmed.exclude_terms = ["clinical trial"]
        cfg.sources.pubmed.concept_scope = "title_abstract"

        with patch.object(pubmed, "ESEARCH_SAFE_URL_LENGTH", 330):
            plan = pubmed.build_pubmed_query_plan(cfg)
            self.assertGreater(len(plan.queries), 1)
            self.assertTrue(
                all(
                    pubmed._encoded_esearch_request_length(
                        query,
                        date(2026, 4, 20),
                        date(2026, 4, 21),
                        cfg.digest.max_per_source,
                        cfg.sources.pubmed.api_key,
                    ) <= pubmed.ESEARCH_SAFE_URL_LENGTH
                    for query in plan.queries
                )
            )
            later_chunk_pmids = {
                query: str(100 + index)
                for index, query in enumerate(plan.queries)
                if index > 0
            }
            ids_by_query = {
                query: (
                    ["1", "2", "3"]
                    if index == 0
                    else ["2", later_chunk_pmids[query]]
                )
                for index, query in enumerate(plan.queries)
            }
            seen_params: list[dict] = []
            efetch_pmids: list[str] = []

            def fake_get(url: str, *, params: dict, timeout: float) -> httpx.Response:
                self.assertEqual(url, pubmed.ESEARCH_URL)
                self.assertEqual(timeout, 30.0)
                seen_params.append(params)
                self.assertIn('AND NOT "clinical trial"[Title/Abstract]', params["term"])
                return make_json_response(
                    url,
                    {"esearchresult": {"idlist": ids_by_query[params["term"]]}},
                )

            def fake_efetch_all(pmids, api_key, *, progress_cb=None, target=None):
                efetch_pmids.extend(pmids)
                self.assertIsNone(api_key)
                self.assertIsNone(progress_cb)
                self.assertEqual(target, 3)
                return []

            with (
                patch.object(pubmed, "load_config", return_value=cfg),
                patch.object(pubmed.httpx, "get", side_effect=fake_get),
                patch.object(pubmed.httpx, "post") as post_mock,
                patch.object(pubmed.time, "sleep") as sleep_mock,
                patch.object(pubmed, "_efetch_all", side_effect=fake_efetch_all),
            ):
                self.assertEqual(pubmed.fetch(datetime(2026, 4, 20)), [])

        self.assertEqual(len(seen_params), len(plan.queries))
        self.assertEqual([params["retmax"] for params in seen_params], [3] * len(plan.queries))
        self.assertEqual(len(efetch_pmids), 3)
        self.assertEqual(len(efetch_pmids), len(set(efetch_pmids)))
        self.assertEqual(efetch_pmids[0], "1")
        self.assertNotEqual(efetch_pmids, ["1", "2", "3"])
        self.assertTrue(set(efetch_pmids) & set(later_chunk_pmids.values()))
        self.assertEqual(sleep_mock.call_count, len(plan.queries) - 1)
        sleep_mock.assert_called_with(pubmed.REQUEST_DELAY)
        post_mock.assert_not_called()

    def test_request_too_long_errors_are_normalized(self) -> None:
        def fake_get(url: str, *, params: dict, timeout: float) -> httpx.Response:
            return make_status_response(url, 414)

        with patch.object(pubmed.httpx, "get", side_effect=fake_get):
            with self.assertRaises(pubmed.PubmedQueryTooLongError) as raised:
                pubmed._esearch("chromatin", date(2026, 4, 20), date(2026, 4, 21), 10, None)

        self.assertIn("PubMed ESearch request is too long", str(raised.exception))

    def test_esearch_uses_post_request_body_for_overlong_request(self) -> None:
        seen_data: dict = {}

        def fake_post(url: str, *, data: dict, timeout: float) -> httpx.Response:
            self.assertEqual(url, pubmed.ESEARCH_URL)
            self.assertEqual(timeout, 30.0)
            seen_data.update(data)
            return make_json_response(
                url,
                {"esearchresult": {"idlist": ["9"]}},
                method="POST",
            )

        with (
            patch.object(pubmed, "ESEARCH_SAFE_URL_LENGTH", 100),
            patch.object(pubmed.httpx, "get") as get_mock,
            patch.object(pubmed.httpx, "post", side_effect=fake_post),
        ):
            ids = pubmed._esearch(
                "chromatin mechanics",
                date(2026, 4, 20),
                date(2026, 4, 21),
                10,
                None,
            )

        self.assertEqual(ids, ["9"])
        self.assertEqual(seen_data["term"], "chromatin mechanics")
        get_mock.assert_not_called()

    def test_raw_query_plan_remains_single_query_when_overlong(self) -> None:
        cfg = Config()
        cfg.sources.pubmed.query_mode = "raw"
        cfg.sources.pubmed.search_terms = [
            "chromatin[Title/Abstract]",
            "nucleosome[Title/Abstract]",
            "single molecule[Title/Abstract]",
        ]

        with patch.object(pubmed, "ESEARCH_SAFE_URL_LENGTH", 100):
            plan = pubmed.build_pubmed_query_plan(cfg)

        self.assertEqual(plan.query_mode, "raw")
        self.assertEqual(plan.length_status, "too_long")
        self.assertEqual(plan.queries, (plan.query,))
        self.assertEqual(
            plan.query,
            (
                "(chromatin[Title/Abstract]) OR (nucleosome[Title/Abstract]) "
                "OR (single molecule[Title/Abstract])"
            ),
        )

    def test_empty_builder_and_auto_configs_return_no_query_or_fetch(self) -> None:
        builder_cfg = Config()
        builder_cfg.sources.pubmed.query_mode = "builder"
        builder_cfg.sources.pubmed.concepts = []
        self.assertEqual(pubmed.build_pubmed_query(builder_cfg), "")

        auto_cfg = Config()
        auto_cfg.topics = []
        auto_cfg.keywords.include = []
        auto_cfg.profile.field = []
        self.assertEqual(pubmed.build_pubmed_query(auto_cfg), "")

        with (
            patch.object(pubmed, "load_config", return_value=builder_cfg),
            patch.object(pubmed.httpx, "get") as get_mock,
        ):
            self.assertEqual(pubmed.fetch(datetime(2026, 4, 20)), [])
            get_mock.assert_not_called()

    def test_existing_raw_yaml_loads_as_raw_mode_without_losing_terms(self) -> None:
        cfg = Config.model_validate(
            {
                "sources": {
                    "pubmed": {
                        "enabled": True,
                        "search_terms": [
                            " biophysics[MeSH] ",
                            "biophysics[MeSH]",
                            "chromatin[Title/Abstract]",
                        ],
                    }
                }
            }
        )

        self.assertEqual(cfg.sources.pubmed.query_mode, "raw")
        self.assertEqual(
            cfg.sources.pubmed.search_terms,
            ["biophysics[MeSH]", "chromatin[Title/Abstract]"],
        )

    def test_existing_empty_raw_yaml_loads_as_raw_mode(self) -> None:
        cfg = Config.model_validate(
            {
                "sources": {
                    "pubmed": {
                        "enabled": True,
                        "search_terms": [],
                    }
                }
            }
        )

        self.assertEqual(cfg.sources.pubmed.query_mode, "raw")
        self.assertEqual(cfg.sources.pubmed.search_terms, [])
        self.assertEqual(pubmed.build_pubmed_query(cfg), "")

    def test_explicit_query_mode_overrides_legacy_search_terms_key(self) -> None:
        cfg = Config.model_validate(
            {
                "sources": {
                    "pubmed": {
                        "query_mode": "auto",
                        "search_terms": ["biophysics[MeSH]"],
                    }
                }
            }
        )

        self.assertEqual(cfg.sources.pubmed.query_mode, "auto")
        self.assertEqual(cfg.sources.pubmed.search_terms, ["biophysics[MeSH]"])

    def test_empty_raw_config_returns_no_query_or_fetch(self) -> None:
        cfg = Config()
        cfg.sources.pubmed.query_mode = "raw"
        cfg.sources.pubmed.search_terms = []

        self.assertEqual(pubmed.build_pubmed_query(cfg), "")

        with (
            patch.object(pubmed, "load_config", return_value=cfg),
            patch.object(pubmed.httpx, "get") as get_mock,
        ):
            self.assertEqual(pubmed.fetch(datetime(2026, 4, 20)), [])
            get_mock.assert_not_called()

    def test_fetch_sends_generated_query_with_date_and_retmax_params(self) -> None:
        cfg = Config()
        cfg.digest.max_per_source = 7
        cfg.sources.pubmed.query_mode = "builder"
        cfg.sources.pubmed.concepts = ["chromatin mechanics"]
        cfg.sources.pubmed.exclude_terms = ["clinical trial"]
        cfg.sources.pubmed.concept_scope = "title_abstract"

        seen_params: list[dict] = []

        def fake_get(url: str, *, params: dict, timeout: float) -> httpx.Response:
            self.assertEqual(url, pubmed.ESEARCH_URL)
            self.assertEqual(timeout, 30.0)
            seen_params.append(params)
            return make_json_response(url, {"esearchresult": {"idlist": []}})

        with (
            patch.object(pubmed, "load_config", return_value=cfg),
            patch.object(pubmed.httpx, "get", side_effect=fake_get),
        ):
            self.assertEqual(pubmed.fetch(datetime(2026, 4, 20)), [])

        self.assertEqual(len(seen_params), 1)
        params = seen_params[0]
        self.assertEqual(
            params["term"],
            '"chromatin mechanics"[Title/Abstract] AND NOT "clinical trial"[Title/Abstract]',
        )
        self.assertEqual(params["mindate"], "2026/04/20")
        self.assertEqual(params["datetype"], "pdat")
        self.assertEqual(params["retmax"], 7)
        self.assertEqual(params["db"], "pubmed")
        self.assertEqual(params["retmode"], "json")
        self.assertIn("maxdate", params)


if __name__ == "__main__":
    unittest.main()
