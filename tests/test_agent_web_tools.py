from __future__ import annotations

import json
import sqlite3
import unittest
from datetime import date
from unittest.mock import patch

import httpx

from claudesk.agent import web
from claudesk.agent.capabilities import execute_capability, execute_capability_text
from claudesk.agent.capabilities import web as web_capabilities
from claudesk.agent.exports.openai import openai_tool_schemas
from claudesk.core import public_http
from claudesk.core.config import Config
from claudesk.core.models import Paper


def make_response(
    url: str,
    *,
    text: str,
    content_type: str = "text/html; charset=utf-8",
    status_code: int = 200,
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    request = httpx.Request("GET", url)
    response_headers = {"content-type": content_type}
    if headers:
        response_headers.update(headers)
    return httpx.Response(
        status_code,
        text=text,
        headers=response_headers,
        request=request,
    )


class AgentWebToolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.conn = sqlite3.connect(":memory:")
        self.cfg = Config()

    def tearDown(self) -> None:
        self.conn.close()

    def test_search_web_parses_results_and_decodes_redirects(self) -> None:
        html = """
        <html><body>
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle">
            Example Article
          </a>
          <div class="result__snippet">Fresh result snippet.</div>
          <a class="result__a" href="https://127.0.0.1/private">Blocked Result</a>
          <div class="result__snippet">Should not appear.</div>
        </body></html>
        """

        with (
            patch.object(httpx.HTTPTransport, "handle_request", return_value=make_response(web.SEARCH_URL, text=html)),
            patch.object(public_http.socket, "getaddrinfo", return_value=[(0, 0, 0, "", ("93.184.216.34", 0))]),
        ):
            payload = json.loads(web.search_web("latest biophysics", limit=5))

        self.assertEqual(payload["query"], "latest biophysics")
        self.assertEqual(len(payload["results"]), 1)
        self.assertEqual(payload["results"][0]["title"], "Example Article")
        self.assertEqual(payload["results"][0]["url"], "https://example.com/article")
        self.assertEqual(payload["results"][0]["snippet"], "Fresh result snippet.")

    def test_fetch_url_extracts_readable_text(self) -> None:
        html = """
        <html>
          <head><title>Paper News</title><style>.x { color: red; }</style></head>
          <body>
            <article>
              <h1>Headline</h1>
              <p>First paragraph.</p>
              <script>ignoreMe()</script>
              <p>Second paragraph.</p>
            </article>
          </body>
        </html>
        """

        with (
            patch.object(httpx.HTTPTransport, "handle_request", return_value=make_response("https://example.com/news", text=html)),
            patch.object(public_http.socket, "getaddrinfo", return_value=[(0, 0, 0, "", ("93.184.216.34", 0))]),
        ):
            payload = json.loads(web.fetch_url("https://example.com/news", max_chars=2000))

        self.assertEqual(payload["url"], "https://example.com/news")
        self.assertEqual(payload["title"], "Paper News")
        self.assertIn("Headline", payload["content"])
        self.assertIn("First paragraph.", payload["content"])
        self.assertIn("Second paragraph.", payload["content"])
        self.assertNotIn("ignoreMe", payload["content"])
        self.assertFalse(payload["truncated"])

    def test_fetch_url_blocks_private_addresses(self) -> None:
        with (
            patch.object(httpx.HTTPTransport, "handle_request") as transport,
            self.assertRaisesRegex(ValueError, "Local or (private|internal)"),
        ):
            web.fetch_url("http://127.0.0.1/private")
        transport.assert_not_called()

    def test_fetch_url_blocks_unresolved_initial_host_before_dispatch(self) -> None:
        for resolution in (public_http.socket.gaierror("DNS unavailable"), []):
            with self.subTest(resolution=resolution):
                with (
                    patch.object(httpx.HTTPTransport, "handle_request") as transport,
                    patch.object(public_http.socket, "getaddrinfo", side_effect=[resolution]),
                    self.assertRaisesRegex(ValueError, "resolve URL hostname|resolve to any IP addresses"),
                ):
                    web.fetch_url("https://unresolved.example/start")
                transport.assert_not_called()

    def test_fetch_url_blocks_unresolved_redirect_host_before_dispatch(self) -> None:
        url = "https://example.com/start"
        for resolution in (public_http.socket.gaierror("DNS unavailable"), []):
            with self.subTest(resolution=resolution):
                response = make_response(url, text="", status_code=302, headers={"location": "https://unresolved.example/end"})
                with (
                    patch.object(httpx.HTTPTransport, "handle_request", return_value=response) as transport,
                    patch.object(public_http.socket, "getaddrinfo", side_effect=[
                        [(0, 0, 0, "", ("93.184.216.34", 0))],
                        resolution,
                    ]),
                    self.assertRaisesRegex(ValueError, "resolve URL hostname|resolve to any IP addresses"),
                ):
                    web.fetch_url(url)
                transport.assert_called_once()
                self.assertEqual(str(transport.call_args.args[0].url), url)

    def test_fetch_url_follows_validated_relative_and_absolute_redirects(self) -> None:
        urls = [
            "https://example.com/start",
            "https://example.com/relative",
            "https://publisher.example/article",
            "https://publisher.example/article?view=full",
            "https://publisher.example/final",
            "https://publisher.example/final/",
        ]
        locations = ["/relative", urls[2], "?view=full", "/final", "/final/"]
        responses = [
            make_response(url, text="", status_code=status, headers={"location": location})
            for url, status, location in zip(urls, [301, 302, 303, 307, 308], locations)
        ]
        responses.append(make_response(urls[-1], text="<p>Final article.</p>"))

        with (
            patch.object(httpx.HTTPTransport, "handle_request", side_effect=responses) as transport,
            patch.object(public_http.socket, "getaddrinfo", return_value=[(0, 0, 0, "", ("93.184.216.34", 0))]) as resolve,
        ):
            payload = json.loads(web.fetch_url(urls[0]))

        self.assertEqual([str(call.args[0].url) for call in transport.call_args_list], urls)
        self.assertEqual(resolve.call_count, len(urls))
        self.assertEqual(payload["url"], urls[-1])
        self.assertEqual(payload["content"], "Final article.")

    def test_fetch_url_blocks_unsafe_redirect_before_dispatch(self) -> None:
        for destination in (
            "http://127.0.0.1/private",
            "http://10.1.2.3/private",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]/private",
            "http://localhost/private",
            "//machine.internal/private",
            "https://private.example/private",
            "file:///etc/passwd",
        ):
            with self.subTest(destination=destination):
                response = make_response("https://example.com/start", text="", status_code=302, headers={"location": destination})
                with (
                    patch.object(httpx.HTTPTransport, "handle_request", return_value=response) as transport,
                    patch.object(public_http.socket, "getaddrinfo", side_effect=lambda host, *args, **kwargs: [
                        (0, 0, 0, "", ("192.168.1.10" if host == "private.example" else "93.184.216.34", 0)),
                    ]),
                    self.assertRaisesRegex(ValueError, "Local or|Only http"),
                ):
                    web.fetch_url("https://example.com/start")
                transport.assert_called_once()
                self.assertEqual(str(transport.call_args.args[0].url), "https://example.com/start")

    def test_fetch_url_stops_redirect_loop_at_limit(self) -> None:
        url = "https://example.com/loop"
        responses = [
            make_response(url, text="", status_code=302, headers={"location": "/loop"})
            for _ in range(public_http.MAX_REDIRECTS + 1)
        ]
        with (
            patch.object(httpx.HTTPTransport, "handle_request", side_effect=responses) as transport,
            patch.object(public_http.socket, "getaddrinfo", return_value=[(0, 0, 0, "", ("93.184.216.34", 0))]),
            self.assertRaisesRegex(httpx.TooManyRedirects, "Too many redirects"),
        ):
            web.fetch_url(url)
        self.assertEqual(transport.call_count, public_http.MAX_REDIRECTS + 1)

    def test_fetch_url_reports_redirect_and_http_errors(self) -> None:
        for status, headers, error in (
            (302, {}, httpx.HTTPStatusError),
            (302, {"location": "https://example.com:invalid/path"}, httpx.RemoteProtocolError),
            (404, {}, httpx.HTTPStatusError),
        ):
            with self.subTest(status=status, headers=headers):
                response = make_response("https://example.com/start", text="", status_code=status, headers=headers)
                with (
                    patch.object(httpx.HTTPTransport, "handle_request", return_value=response) as transport,
                    patch.object(public_http.socket, "getaddrinfo", return_value=[(0, 0, 0, "", ("93.184.216.34", 0))]),
                    self.assertRaises(error),
                ):
                    web.fetch_url("https://example.com/start")
                transport.assert_called_once()

    def test_search_web_blocks_private_redirect_before_dispatch(self) -> None:
        response = make_response(web.SEARCH_URL, text="", status_code=302, headers={"location": "http://localhost/private"})
        with (
            patch.object(httpx.HTTPTransport, "handle_request", return_value=response) as transport,
            patch.object(public_http.socket, "getaddrinfo", return_value=[(0, 0, 0, "", ("93.184.216.34", 0))]),
            self.assertRaisesRegex(ValueError, "Local or internal"),
        ):
            web.search_web("research")
        transport.assert_called_once()
        self.assertEqual(transport.call_args.args[0].url.params["q"], "research")

    def test_full_text_blocks_private_redirects_from_doi_and_html_pages(self) -> None:
        for source in ("arxiv", "biorxiv"):
            for stage in ("doi", "full_text"):
                with self.subTest(source=source, stage=stage):
                    paper = Paper(
                        id=15,
                        source=source,
                        external_id="2604.16899",
                        title="Paper",
                        abstract="",
                        authors=[],
                        published_date=date(2026, 4, 23),
                        url="https://doi.org/10.1234/example",
                    )
                    responses = []
                    if stage == "full_text":
                        responses.append(make_response(paper.url, text='<a href="https://arxiv.org/html/2604.16899v1">HTML</a>'))
                    responses.append(make_response(paper.url, text="", status_code=302, headers={"location": "http://127.0.0.1/private"}))
                    with (
                        patch.object(httpx.HTTPTransport, "handle_request", side_effect=responses) as transport,
                        patch.object(public_http.socket, "getaddrinfo", return_value=[(0, 0, 0, "", ("93.184.216.34", 0))]),
                    ):
                        payload = json.loads(web.fetch_paper_full_text(paper))
                    self.assertFalse(payload["ok"])
                    self.assertIn("Local or internal", payload["error"])
                    self.assertEqual(transport.call_count, len(responses))
                    self.assertTrue(all(call.args[0].url.host != "127.0.0.1" for call in transport.call_args_list))

    def test_fetch_paper_full_text_uses_arxiv_html_link_from_abstract_page(self) -> None:
        paper = Paper(
            id=12,
            source="arxiv",
            external_id="2604.16899",
            title="arXiv Paper",
            abstract="",
            authors=[],
            published_date=date(2026, 4, 23),
            url="https://doi.org/10.48550/arXiv.2604.16899",
        )
        abstract_html = '<html><body><a href="/html/2604.16899v2">HTML</a></body></html>'
        full_text_html = "<html><head><title>arXiv Full Text</title></head><body><h1>Intro</h1><p>Main text.</p></body></html>"

        with (
            patch.object(
                httpx.HTTPTransport,
                "handle_request",
                side_effect=[
                    make_response(paper.url, text="", status_code=302, headers={"location": "https://arxiv.org/abs/2604.16899"}),
                    make_response("https://arxiv.org/abs/2604.16899", text=abstract_html),
                    make_response("https://arxiv.org/html/2604.16899v2", text=full_text_html),
                ],
            ),
            patch.object(public_http.socket, "getaddrinfo", return_value=[(0, 0, 0, "", ("93.184.216.34", 0))]),
        ):
            payload = json.loads(web.fetch_paper_full_text(paper, max_chars=2000))

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["full_text_url"], "https://arxiv.org/html/2604.16899v2")
        self.assertIn("https://arxiv.org/abs/2604.16899", payload["attempted_urls"])
        self.assertIn("Intro", payload["content"])
        self.assertIn("Main text.", payload["content"])

    def test_fetch_paper_full_text_derives_biorxiv_full_url_from_redirect(self) -> None:
        paper = Paper(
            id=13,
            source="biorxiv",
            external_id="10.64898/2026.04.08.717143",
            title="bioRxiv Paper",
            abstract="",
            authors=[],
            published_date=date(2026, 4, 23),
            url="https://doi.org/10.64898/2026.04.08.717143",
        )
        resolved_abstract_url = "https://www.biorxiv.org/content/10.64898/2026.04.08.717143v1"
        full_text_url = resolved_abstract_url + ".full"
        full_text_html = "<html><head><title>bioRxiv Full Text</title></head><body><p>Body text.</p></body></html>"

        with (
            patch.object(
                httpx.HTTPTransport,
                "handle_request",
                side_effect=[
                    make_response(paper.url, text="", status_code=302, headers={"location": resolved_abstract_url}),
                    make_response(resolved_abstract_url, text="<html><body>Abstract page</body></html>"),
                    make_response(full_text_url, text=full_text_html),
                ],
            ),
            patch.object(public_http.socket, "getaddrinfo", return_value=[(0, 0, 0, "", ("104.26.14.87", 0))]),
        ):
            payload = json.loads(web.fetch_paper_full_text(paper, max_chars=2000))

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["full_text_url"], full_text_url)
        self.assertIn(resolved_abstract_url, payload["attempted_urls"])
        self.assertIn(full_text_url, payload["attempted_urls"])
        self.assertIn("Body text.", payload["content"])

    def test_fetch_paper_full_text_reports_biorxiv_cloudflare_block_clearly(self) -> None:
        paper = Paper(
            id=14,
            source="biorxiv",
            external_id="10.64898/2026.04.08.717143",
            title="bioRxiv Paper",
            abstract="",
            authors=[],
            published_date=date(2026, 4, 23),
            url="https://www.biorxiv.org/content/10.64898/2026.04.08.717143v1",
        )
        blocked_response = make_response(
            paper.url,
            text="<html><body>Blocked</body></html>",
            status_code=403,
            headers={
                "cf-mitigated": "challenge",
                "server": "cloudflare",
            },
        )

        with (
            patch.object(httpx.HTTPTransport, "handle_request", return_value=blocked_response),
            patch.object(public_http.socket, "getaddrinfo", return_value=[(0, 0, 0, "", ("104.26.14.87", 0))]),
        ):
            payload = json.loads(web.fetch_paper_full_text(paper, max_chars=2000))

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["full_text_url"], paper.url)
        self.assertEqual(payload["attempted_urls"], [paper.url])
        self.assertIn("bioRxiv blocked automated fetch with Cloudflare challenge", payload["error"])

    def test_capability_registry_dispatches_web_branches(self) -> None:
        with (
            patch.object(web_capabilities.web_helpers, "search_web", return_value='{"ok": "search"}') as mock_search,
            patch.object(web_capabilities.web_helpers, "fetch_url", return_value='{"ok": "fetch"}') as mock_fetch,
            patch.object(web_capabilities, "get_paper", return_value=Paper(
                id=99,
                source="arxiv",
                external_id="2604.16899",
                title="Tagged Paper",
                abstract="",
                authors=[],
                published_date=date(2026, 4, 23),
                url="https://arxiv.org/abs/2604.16899",
            )),
            patch.object(web_capabilities.web_helpers, "fetch_paper_full_text", return_value='{"ok": true}') as mock_full_text,
        ):
            search_result = execute_capability_text("search_web", {"query": "rna", "limit": 3}, self.conn, cfg=self.cfg)
            fetch_result = execute_capability_text("fetch_url", {"url": "https://example.com", "max_chars": 800}, self.conn, cfg=self.cfg)
            full_text_result = execute_capability_text("fetch_paper_full_text", {"paper_id": 99, "max_chars": 900}, self.conn, cfg=self.cfg)

        self.assertEqual(search_result, '{"ok": "search"}')
        self.assertEqual(fetch_result, '{"ok": "fetch"}')
        self.assertEqual(full_text_result, '{"ok": true}')
        mock_search.assert_called_once_with("rna", limit=3)
        mock_fetch.assert_called_once_with("https://example.com", max_chars=800)
        mock_full_text.assert_called_once()

    def test_fetch_paper_full_text_description_is_local_pdf_first(self) -> None:
        descriptions = {
            schema["function"]["name"]: schema["function"]["description"]
            for schema in openai_tool_schemas()
        }

        description = descriptions["fetch_paper_full_text"]
        self.assertIn("remote/public HTML access", description)
        self.assertIn("not the first choice when a managed local paper PDF is available", description)
        self.assertIn("use list_paper_assets/read_paper_pdf first", description)
        self.assertIn("no usable PDF evidence is available", description)
        self.assertIn("explicitly asks for online, arXiv, or publisher HTML/full text", description)
        self.assertIn("Only fall back to general web search if this returns ok=false", description)

    def test_capability_text_api_matches_result_text(self) -> None:
        with patch.object(web_capabilities.web_helpers, "search_web", return_value='{"ok": true}'):
            plain = execute_capability_text("search_web", {"query": "rna"}, self.conn, cfg=self.cfg)
            rich = execute_capability("search_web", {"query": "rna"}, self.conn, cfg=self.cfg)

        self.assertEqual(plain, '{"ok": true}')
        self.assertEqual(rich.text, '{"ok": true}')
        self.assertEqual(rich.images, ())


if __name__ == "__main__":
    unittest.main()
