from __future__ import annotations

import re

PAPER_PDF_CAPABILITY_NAMES: tuple[str, ...] = (
    "list_paper_assets",
    "list_paper_structure",
    "retrieve_paper_context",
    "read_paper_section",
    "read_paper_pdf",
    "search_paper_pdf",
    "inspect_paper_pdf_pages",
)

NOTE_WRITE_CAPABILITY_NAMES: tuple[str, ...] = (
    "create_note",
    "create_paper_note",
    "update_note",
    "link_note_paper",
    "unlink_note_paper",
)

MANAGED_PDF_POLICY = (
    "Managed paper PDFs must be accessed only through Claudesk PDF capabilities. "
    "Do not use shell, filesystem, pdftotext, arbitrary local paths, web search, "
    "or paper abstracts as a fallback when the user asks for local PDF content."
)

NOTE_WRITE_POLICY = (
    "Paper-linked notes must be written only through first-class Claudesk note capabilities. "
    "Do not create loose Markdown files or use shell/filesystem writes as a substitute."
)

_NOTE_WRITE_RE = re.compile(
    r"\b(write|save|create|add|append|replace|revise|edit|update|clear|delete)\b.*\b(note|notes)\b"
    r"|\b(note|notes)\b.*\b(write|save|create|add|append|replace|revise|edit|update|clear|delete)\b",
    re.IGNORECASE | re.DOTALL,
)


def note_write_requested(text: str) -> bool:
    return bool(_NOTE_WRITE_RE.search(text or ""))


def disabled_pdf_capability_response(missing: set[str]) -> str:
    names = ", ".join(sorted(missing))
    return (
        "I cannot read local PDFs because the required Claudesk PDF capabilities are disabled "
        f"or unavailable: {names}. I did not use shell, filesystem, web, abstract, or "
        "pdftotext fallback."
    )


def disabled_note_capability_response(missing: set[str]) -> str:
    names = ", ".join(sorted(missing))
    return (
        "I cannot write Claudesk notes because the required first-class note capabilities are "
        f"disabled or unavailable: {names}. I did not create a loose Markdown file or use "
        "filesystem fallback."
    )
