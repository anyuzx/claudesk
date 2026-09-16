from __future__ import annotations

import json
import re
from html import unescape
from html.parser import HTMLParser
from urllib.parse import parse_qs, unquote, urljoin, urlparse

import httpx

from claudesk.core.models import Paper
from claudesk.core.public_http import stream_public_response, validate_public_url

SEARCH_URL = "https://html.duckduckgo.com/html/"
DEFAULT_SEARCH_LIMIT = 5
MAX_SEARCH_LIMIT = 8
DEFAULT_FETCH_CHARS = 6000
MAX_FETCH_CHARS = 12000
REQUEST_HEADERS = {
    "User-Agent": "claudesk/0.1 (+https://localhost)",
}


class _HTMLTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._skip_depth = 0
        self._in_title = False
        self._title_parts: list[str] = []
        self._text_parts: list[str] = []

    @property
    def title(self) -> str:
        return _collapse_whitespace(" ".join(self._title_parts))

    @property
    def text(self) -> str:
        raw = "".join(self._text_parts)
        raw = re.sub(r"\n{3,}", "\n\n", raw)
        lines = [_collapse_whitespace(line) for line in raw.splitlines()]
        return "\n".join(line for line in lines if line)

    def handle_starttag(self, tag: str, attrs) -> None:  # noqa: ANN001
        if tag in {"script", "style", "noscript", "svg"}:
            self._skip_depth += 1
            return
        if tag == "title":
            self._in_title = True
        if tag in {"p", "div", "section", "article", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self._text_parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript", "svg"}:
            if self._skip_depth > 0:
                self._skip_depth -= 1
            return
        if tag == "title":
            self._in_title = False
        if tag in {"p", "div", "section", "article", "li"}:
            self._text_parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        text = data.strip()
        if not text:
            return
        if self._in_title:
            self._title_parts.append(text)
        else:
            self._text_parts.append(text + " ")


def _collapse_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", unescape(text)).strip()


def _decode_search_result_url(raw_url: str) -> str:
    if not raw_url:
        return ""
    if raw_url.startswith("//"):
        raw_url = "https:" + raw_url

    parsed = urlparse(raw_url)
    if "duckduckgo.com" in parsed.netloc:
        uddg = parse_qs(parsed.query).get("uddg")
        if uddg:
            return unquote(uddg[0])
    return raw_url


def _parse_search_results(html: str, limit: int) -> list[dict]:
    link_pattern = re.compile(
        r'<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>',
        flags=re.IGNORECASE | re.DOTALL,
    )
    snippet_pattern = re.compile(
        r'<(?:a|div)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>(.*?)</(?:a|div)>',
        flags=re.IGNORECASE | re.DOTALL,
    )

    links = link_pattern.findall(html)
    snippets = snippet_pattern.findall(html)
    results: list[dict] = []

    for index, (href, title_html) in enumerate(links[:limit]):
        title = _collapse_whitespace(re.sub(r"<[^>]+>", " ", title_html))
        url = _decode_search_result_url(unescape(href))
        try:
            url = validate_public_url(url)
        except ValueError:
            continue
        snippet_html = snippets[index] if index < len(snippets) else ""
        snippet = _collapse_whitespace(re.sub(r"<[^>]+>", " ", snippet_html))
        if not title:
            continue
        results.append({
            "title": title,
            "url": url,
            "snippet": snippet,
        })
    return results


def search_web(query: str, *, limit: int = DEFAULT_SEARCH_LIMIT) -> str:
    normalized_query = query.strip()
    if not normalized_query:
        raise ValueError("Search query cannot be empty.")

    bounded_limit = max(1, min(limit, MAX_SEARCH_LIMIT))
    with stream_public_response(SEARCH_URL, params={"q": normalized_query}, headers=REQUEST_HEADERS) as response:
        response.raise_for_status()
        response.read()
        results = _parse_search_results(response.text, bounded_limit)
    return json.dumps({
        "query": normalized_query,
        "results": results,
    })


def _html_to_text(html: str) -> tuple[str, str]:
    parser = _HTMLTextExtractor()
    parser.feed(html)
    parser.close()
    return parser.title, parser.text


def _normalize_fetched_text(content_type: str, body: str) -> tuple[str, str]:
    if "html" in content_type:
        return _html_to_text(body)
    if any(kind in content_type for kind in ("json", "xml", "text/plain", "markdown")):
        return "", body.strip()
    return "", body.strip()


def _blocked_fetch_message(response: httpx.Response) -> str | None:
    hostname = (response.url.host or "").lower()
    challenge = (response.headers.get("cf-mitigated") or "").strip().lower()
    server = (response.headers.get("server") or "").strip().lower()

    if response.status_code == 403 and challenge == "challenge" and "cloudflare" in server:
        if hostname.endswith("biorxiv.org"):
            return (
                "bioRxiv blocked automated fetch with Cloudflare challenge. "
                "Direct non-browser access to this page is currently unavailable."
            )
        site_name = hostname or "This site"
        return (
            f"{site_name} blocked automated fetch with Cloudflare challenge. "
            "Direct non-browser access to this page is currently unavailable."
        )

    return None


def _raise_for_public_response(response: httpx.Response) -> None:
    message = _blocked_fetch_message(response)
    if message:
        raise ValueError(message)
    response.raise_for_status()


def _fetch_public_document(url: str, *, max_chars: int = DEFAULT_FETCH_CHARS) -> dict:
    bounded_max_chars = max(500, min(max_chars, MAX_FETCH_CHARS))

    with stream_public_response(url, headers=REQUEST_HEADERS) as response:
        _raise_for_public_response(response)
        final_url = str(response.url)
        content_type = (response.headers.get("content-type") or "").lower()
        if "pdf" in content_type or "octet-stream" in content_type:
            raise ValueError("Binary documents are not supported by fetch_url.")
        response.read()
        title, text = _normalize_fetched_text(content_type, response.text)
    if not text:
        raise ValueError("No readable text content found at this URL.")

    truncated = len(text) > bounded_max_chars
    excerpt = text[:bounded_max_chars].rstrip()

    return {
        "url": final_url,
        "title": title or None,
        "content_type": content_type or None,
        "content": excerpt,
        "truncated": truncated,
    }


def fetch_url(url: str, *, max_chars: int = DEFAULT_FETCH_CHARS) -> str:
    return json.dumps(_fetch_public_document(url, max_chars=max_chars))


def _extract_arxiv_versioned_id(url: str) -> str:
    match = re.search(r"/(?:abs|html)/(?P<identifier>[^/?#]+)", url)
    if not match:
        return ""
    identifier = match.group("identifier")
    return identifier if re.search(r"v\d+$", identifier) else ""


def _resolve_arxiv_full_text_url(paper: Paper, attempted_urls: list[str]) -> str:
    abstract_url = validate_public_url(paper.url)
    if abstract_url not in attempted_urls:
        attempted_urls.append(abstract_url)

    with stream_public_response(abstract_url, headers=REQUEST_HEADERS) as response:
        _raise_for_public_response(response)
        final_abstract_url = str(response.url)
        response.read()
        abstract_text = response.text
    if final_abstract_url not in attempted_urls:
        attempted_urls.append(final_abstract_url)

    match = re.search(
        r'href="(?P<href>(?:https?://arxiv\.org)?/html/[^"#?]+)"',
        abstract_text,
        flags=re.IGNORECASE,
    )
    if match:
        href = match.group("href")
        resolved = urljoin("https://arxiv.org", href)
        return validate_public_url(resolved)

    versioned_id = _extract_arxiv_versioned_id(final_abstract_url)
    if not versioned_id:
        match = re.search(r'arXiv:(?P<identifier>\d{4}\.\d{4,5}v\d+)', abstract_text)
        versioned_id = match.group("identifier") if match else ""

    if versioned_id:
        return validate_public_url(f"https://arxiv.org/html/{versioned_id}")

    return validate_public_url(f"https://arxiv.org/html/{paper.external_id}v1")


def _resolve_biorxiv_full_text_url(paper: Paper, attempted_urls: list[str]) -> str:
    abstract_url = validate_public_url(paper.url)
    if abstract_url not in attempted_urls:
        attempted_urls.append(abstract_url)

    with stream_public_response(abstract_url, headers=REQUEST_HEADERS) as response:
        _raise_for_public_response(response)
        final_abstract_url = str(response.url)
    if final_abstract_url not in attempted_urls:
        attempted_urls.append(final_abstract_url)

    candidate = re.sub(r"\.abstract$", "", final_abstract_url.rstrip("/"))
    if not candidate.endswith(".full"):
        candidate = candidate + ".full"
    return validate_public_url(candidate)


def fetch_paper_full_text(paper: Paper, *, max_chars: int = DEFAULT_FETCH_CHARS) -> str:
    attempted_urls: list[str] = []

    if paper.source == "arxiv":
        resolver = _resolve_arxiv_full_text_url
    elif paper.source == "biorxiv":
        resolver = _resolve_biorxiv_full_text_url
    else:
        return json.dumps({
            "ok": False,
            "paper_id": paper.id,
            "source": paper.source,
            "title": paper.title,
            "abstract_url": paper.url,
            "full_text_url": None,
            "attempted_urls": attempted_urls,
            "error": f"No deterministic full-text HTML rule exists for source '{paper.source}'.",
        })

    try:
        full_text_url = resolver(paper, attempted_urls)
        if full_text_url not in attempted_urls:
            attempted_urls.append(full_text_url)
        fetched = _fetch_public_document(full_text_url, max_chars=max_chars)
    except Exception as exc:
        return json.dumps({
            "ok": False,
            "paper_id": paper.id,
            "source": paper.source,
            "title": paper.title,
            "abstract_url": paper.url,
            "full_text_url": attempted_urls[-1] if attempted_urls else None,
            "attempted_urls": attempted_urls,
            "error": str(exc),
        })

    return json.dumps({
        "ok": True,
        "paper_id": paper.id,
        "source": paper.source,
        "title": paper.title,
        "abstract_url": paper.url,
        "full_text_url": fetched["url"],
        "attempted_urls": attempted_urls,
        "content_type": fetched["content_type"],
        "content": fetched["content"],
        "truncated": fetched["truncated"],
    })
