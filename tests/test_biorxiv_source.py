from __future__ import annotations

import unittest
from datetime import date, datetime
from unittest.mock import patch

import httpx

from claudesk.core.config import Config
from claudesk.sources import biorxiv


def make_response(url: str, payload: dict) -> httpx.Response:
    request = httpx.Request("GET", url)
    return httpx.Response(200, json=payload, request=request)


def direct_payload(*items: dict, total: int | None = None) -> dict:
    count = len(items)
    return {
        "messages": [
            {
                "status": "ok",
                "count": count,
                "total": str(total if total is not None else count),
            }
        ],
        "collection": list(items),
    }


def api_item(
    doi: str,
    *,
    title: str = "Direct API paper",
    category: str = "biophysics",
    version: str = "1",
    date_value: str = "2026-04-23",
) -> dict:
    return {
        "doi": doi,
        "title": title,
        "authors": "Clark, N. M.; Evans, D. T.",
        "date": date_value,
        "version": version,
        "category": category,
        "abstract": "alpha &amp; beta <b>result</b>",
        "server": "bioRxiv",
    }


def crossref_payload(*items: dict) -> dict:
    return {
        "message": {
            "items": list(items),
            "total-results": len(items),
        }
    }


def crossref_item(doi: str) -> dict:
    return {
        "DOI": doi,
        "title": ["Crossref <i>paper</i>"],
        "abstract": "<jats:p>Hello &amp; goodbye</jats:p>",
        "author": [
            {"given": "Ada", "family": "Lovelace"},
            {"given": "Grace", "family": "Hopper"},
        ],
        "posted": {"date-parts": [[2026, 4, 23]]},
        "group-title": "Biophysics",
    }


class BiorxivSourceTests(unittest.TestCase):
    def _cfg(self) -> Config:
        cfg = Config()
        cfg.sources.biorxiv.enabled = True
        cfg.sources.biorxiv.categories = ["biophysics"]
        cfg.sources.biorxiv.provider = "api"
        cfg.sources.biorxiv.fallback_provider = "none"
        cfg.digest.max_per_source = 10
        return cfg

    def test_direct_api_maps_records_to_papers(self) -> None:
        cfg = self._cfg()
        seen_requests: list[tuple[str, dict | None]] = []

        def fake_get(url: str, *, params=None, headers=None, timeout=None) -> httpx.Response:
            seen_requests.append((url, params))
            return make_response(
                url,
                direct_payload(
                    api_item(
                        "10.64898/2026.04.21.719807",
                        title="A <i>direct</i> &amp; useful paper",
                        version="2",
                    )
                ),
            )

        with (
            patch.object(biorxiv, "load_config", return_value=cfg),
            patch.object(biorxiv.httpx, "get", side_effect=fake_get),
            patch.object(biorxiv.time, "sleep", return_value=None),
        ):
            papers = biorxiv.fetch(datetime(2026, 4, 20))

        self.assertEqual(len(papers), 1)
        self.assertEqual(seen_requests[0][1], {"category": "biophysics"})
        today = date.today().isoformat()
        self.assertIn(f"/biorxiv/{today}/{today}/0", seen_requests[0][0])
        self.assertEqual(papers[0].source, "biorxiv")
        self.assertEqual(papers[0].external_id, "10.64898/2026.04.21.719807")
        self.assertEqual(papers[0].title, "A direct & useful paper")
        self.assertEqual(papers[0].abstract, "alpha & beta result")
        self.assertEqual(papers[0].authors, ["Clark, N. M.", "Evans, D. T."])
        self.assertEqual(papers[0].published_date.isoformat(), "2026-04-23")
        self.assertEqual(papers[0].journal_abbrev, "bioRxiv")
        self.assertEqual(
            papers[0].url,
            "https://www.biorxiv.org/content/10.64898/2026.04.21.719807v2",
        )

    def test_direct_api_paginates_by_returned_collection_size(self) -> None:
        cfg = self._cfg()
        cfg.digest.max_per_source = 2
        seen_cursors: list[str] = []

        def fake_get(url: str, *, params=None, headers=None, timeout=None) -> httpx.Response:
            cursor = url.rsplit("/", 1)[-1]
            seen_cursors.append(cursor)
            if cursor == "0":
                return make_response(
                    url,
                    direct_payload(
                        api_item("10.64898/2026.04.20.000001"),
                        total=2,
                    ),
                )
            if cursor == "1":
                return make_response(
                    url,
                    direct_payload(
                        api_item("10.64898/2026.04.20.000002"),
                        total=2,
                    ),
                )
            raise AssertionError(f"Unexpected cursor {cursor}")

        with (
            patch.object(biorxiv, "load_config", return_value=cfg),
            patch.object(biorxiv.httpx, "get", side_effect=fake_get),
            patch.object(biorxiv.time, "sleep", return_value=None),
        ):
            papers = biorxiv.fetch(datetime(2026, 4, 20))

        self.assertEqual(seen_cursors, ["0", "1"])
        self.assertEqual([p.external_id for p in papers], [
            "10.64898/2026.04.20.000001",
            "10.64898/2026.04.20.000002",
        ])

    def test_direct_api_walks_dates_from_newest_to_oldest(self) -> None:
        seen_windows: list[tuple[str, str]] = []

        def fake_get(url: str, *, params=None, headers=None, timeout=None) -> httpx.Response:
            parts = url.split("/")
            from_date, to_date = parts[-3], parts[-2]
            seen_windows.append((from_date, to_date))
            if from_date == "2026-04-26":
                return make_response(url, direct_payload(total=0))
            if from_date == "2026-04-25":
                return make_response(
                    url,
                    direct_payload(
                        api_item(
                            "10.64898/2026.04.25.000001",
                            title="Newest retained",
                            date_value="2026-04-25",
                        ),
                    ),
                )
            raise AssertionError(f"Unexpected date window {from_date} {to_date}")

        with (
            patch.object(biorxiv.httpx, "get", side_effect=fake_get),
            patch.object(biorxiv.time, "sleep", return_value=None),
        ):
            papers = biorxiv._fetch_api(
                since_date=date(2026, 4, 20),
                until_date=date(2026, 4, 26),
                categories=["biophysics"],
                max_results=1,
            )

        self.assertEqual(seen_windows, [
            ("2026-04-26", "2026-04-26"),
            ("2026-04-25", "2026-04-25"),
        ])
        self.assertEqual(len(papers), 1)
        self.assertEqual(papers[0].published_date.isoformat(), "2026-04-25")
        self.assertEqual(papers[0].title, "Newest retained")

    def test_direct_api_keeps_highest_version_per_doi(self) -> None:
        cfg = self._cfg()

        def fake_get(url: str, *, params=None, headers=None, timeout=None) -> httpx.Response:
            return make_response(
                url,
                direct_payload(
                    api_item(
                        "10.64898/2026.04.20.000001",
                        title="Version one",
                        version="1",
                    ),
                    api_item(
                        "10.64898/2026.04.20.000001",
                        title="Version three",
                        version="3",
                    ),
                ),
            )

        with (
            patch.object(biorxiv, "load_config", return_value=cfg),
            patch.object(biorxiv.httpx, "get", side_effect=fake_get),
            patch.object(biorxiv.time, "sleep", return_value=None),
        ):
            papers = biorxiv.fetch(datetime(2026, 4, 20))

        self.assertEqual(len(papers), 1)
        self.assertEqual(papers[0].title, "Version three")
        self.assertTrue(papers[0].url.endswith("v3"))

    def test_direct_api_failure_falls_back_to_crossref(self) -> None:
        cfg = self._cfg()
        cfg.sources.biorxiv.fallback_provider = "crossref"
        seen_hosts: list[str] = []

        def fake_get(url: str, *, params=None, headers=None, timeout=None) -> httpx.Response:
            seen_hosts.append(url)
            if url.startswith(biorxiv.BIORXIV_API):
                raise httpx.ConnectError("api unavailable")
            if url == biorxiv.CROSSREF_API:
                return make_response(
                    url,
                    crossref_payload(crossref_item("10.64898/2026.04.20.000003")),
                )
            raise AssertionError(f"Unexpected URL {url}")

        with (
            patch.object(biorxiv, "load_config", return_value=cfg),
            patch.object(biorxiv.httpx, "get", side_effect=fake_get),
            patch.object(biorxiv.time, "sleep", return_value=None),
            patch.object(biorxiv.logger, "warning"),
        ):
            papers = biorxiv.fetch(datetime(2026, 4, 20))

        self.assertTrue(any(url.startswith(biorxiv.BIORXIV_API) for url in seen_hosts))
        self.assertIn(biorxiv.CROSSREF_API, seen_hosts)
        self.assertEqual(len(papers), 1)
        self.assertEqual(papers[0].title, "Crossref paper")
        self.assertEqual(papers[0].journal_abbrev, "bioRxiv")

    def test_crossref_provider_skips_direct_api(self) -> None:
        cfg = self._cfg()
        cfg.sources.biorxiv.provider = "crossref"
        cfg.sources.biorxiv.fallback_provider = "api"

        def fake_get(url: str, *, params=None, headers=None, timeout=None) -> httpx.Response:
            if url.startswith(biorxiv.BIORXIV_API):
                raise AssertionError("Direct API should not be called")
            return make_response(
                url,
                crossref_payload(crossref_item("10.64898/2026.04.20.000004")),
            )

        with (
            patch.object(biorxiv, "load_config", return_value=cfg),
            patch.object(biorxiv.httpx, "get", side_effect=fake_get),
            patch.object(biorxiv.time, "sleep", return_value=None),
        ):
            papers = biorxiv.fetch(datetime(2026, 4, 20))

        self.assertEqual(len(papers), 1)
        self.assertEqual(papers[0].external_id, "10.64898/2026.04.20.000004")


if __name__ == "__main__":
    unittest.main()
