from __future__ import annotations

import json

from claudesk.agent import web as web_helpers
from claudesk.agent.capabilities.registry import CapabilitySpec
from claudesk.agent.context import CapabilityContext
from claudesk.agent.schemas import (
    CapabilityInput,
    CapabilityResult,
    FetchPaperFullTextInput,
    FetchUrlInput,
    SearchWebInput,
)
from claudesk.core.db.papers import get_paper


def _search_web(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = SearchWebInput.model_validate(args)
    return CapabilityResult(text=web_helpers.search_web(data.query, limit=data.limit))


def _fetch_url(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = FetchUrlInput.model_validate(args)
    return CapabilityResult(text=web_helpers.fetch_url(data.url, max_chars=data.max_chars))


def _fetch_paper_full_text(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = FetchPaperFullTextInput.model_validate(args)
    paper = get_paper(context.conn, data.paper_id)
    if paper is None:
        return CapabilityResult(text=json.dumps({"ok": False, "error": f"Paper {data.paper_id} not found."}))
    return CapabilityResult(text=web_helpers.fetch_paper_full_text(paper, max_chars=data.max_chars))


def capabilities() -> list[CapabilitySpec]:
    return [
        CapabilitySpec(
            name="search_web",
            description="Search the public web for current or general information. Returns result titles, URLs, and snippets.",
            input_model=SearchWebInput,
            handler=_search_web,
            domain="web",
            access="read",
            risk="medium",
            gate="search_web",
        ),
        CapabilitySpec(
            name="fetch_url",
            description="Fetch and extract readable text from a public webpage URL. Use this after search_web when you need details from a specific source.",
            input_model=FetchUrlInput,
            handler=_fetch_url,
            domain="web",
            access="read",
            risk="medium",
            gate="fetch_url",
        ),
        CapabilitySpec(
            name="fetch_paper_full_text",
            description="Fetch source-specific public full-text HTML for a local paper. This is remote/public HTML access, not the first choice when a managed local paper PDF is available; for tagged paper summaries or full-text questions, use list_paper_assets/read_paper_pdf first unless no usable PDF evidence is available or the user explicitly asks for online, arXiv, or publisher HTML/full text. Only fall back to general web search if this returns ok=false.",
            input_model=FetchPaperFullTextInput,
            handler=_fetch_paper_full_text,
            domain="paper",
            access="read",
            risk="medium",
            gate="fetch_paper_full_text",
        ),
    ]
