from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field

from claudesk.agent.capabilities.registry import CapabilityRegistry, get_capability_registry
from claudesk.agent.policy import (
    NOTE_WRITE_CAPABILITY_NAMES,
    PAPER_PDF_CAPABILITY_NAMES,
    disabled_note_capability_response,
    disabled_pdf_capability_response,
    note_write_requested,
)
from claudesk.core.config import Config
from claudesk.core.paper_mentions import extract_paper_ids


@dataclass(frozen=True)
class TurnPlan:
    paper_ids: list[int]
    requires_note_write: bool
    required_capabilities: set[str] = field(default_factory=set)
    allowed_capabilities: set[str] = field(default_factory=set)
    fail_closed_response: str | None = None


def _library_listing_requested(user_content: str) -> bool:
    text = user_content.lower()
    subject = any(
        phrase in text
        for phrase in (
            "my library",
            "paper library",
            "library papers",
            "digest papers",
            "saved papers",
            "recent papers",
        )
    )
    action = any(
        phrase in text
        for phrase in (
            "list",
            "show",
            "give me",
            "what are",
            "which papers",
            "few papers",
        )
    )
    return subject and action


def _normalize_positive_ids(values: list[int] | None) -> list[int]:
    out: list[int] = []
    seen: set[int] = set()
    for value in values or []:
        try:
            normalized = int(value)
        except (TypeError, ValueError):
            continue
        if normalized <= 0 or normalized in seen:
            continue
        seen.add(normalized)
        out.append(normalized)
    return out


def _disabled_capability_response(missing: set[str]) -> str:
    names = ", ".join(sorted(missing))
    return f"I cannot continue because required Claudesk capabilities are disabled or unavailable: {names}."


class TurnController:
    def __init__(
        self,
        conn: sqlite3.Connection,
        cfg: Config,
        *,
        registry: CapabilityRegistry | None = None,
    ) -> None:
        self.conn = conn
        self.cfg = cfg
        self.registry = registry or get_capability_registry()

    def plan_turn(
        self,
        user_content: str,
        *,
        linked_paper_ids: list[int] | None = None,
        attached_paper_ids: list[int] | None = None,
        attached_project_ids: list[int] | None = None,
        attached_note_ids: list[int] | None = None,
        attached_attachment_ids: list[int] | None = None,
        attached_pdf_asset_ids: list[int] | None = None,
    ) -> TurnPlan:
        explicit_paper_ids = self._explicit_paper_ids(user_content)
        paper_ids = self._paper_ids(user_content, linked_paper_ids=linked_paper_ids)
        context_paper_ids = _normalize_positive_ids(attached_paper_ids)
        project_ids = _normalize_positive_ids(attached_project_ids)
        note_ids = _normalize_positive_ids(attached_note_ids)
        attachment_ids = _normalize_positive_ids(attached_attachment_ids)
        pdf_asset_ids = _normalize_positive_ids(attached_pdf_asset_ids)
        requires_note_write = note_write_requested(user_content)

        required: set[str] = set()
        if project_ids:
            required.add("get_project_context")
        if note_ids:
            required.add("get_note_context")
        if attachment_ids:
            required.add("get_chat_attachment_context")
        if pdf_asset_ids:
            required.update(PAPER_PDF_CAPABILITY_NAMES)
        if _library_listing_requested(user_content):
            required.add("list_recent_papers")
        if explicit_paper_ids or context_paper_ids:
            required.add("get_papers_by_ids")
        if requires_note_write:
            required.update(NOTE_WRITE_CAPABILITY_NAMES)

        allowed = self.registry.enabled_names(self.cfg.chat.tools)
        missing = required - allowed
        if missing:
            if missing & set(PAPER_PDF_CAPABILITY_NAMES):
                response = disabled_pdf_capability_response(missing & set(PAPER_PDF_CAPABILITY_NAMES))
            elif missing & set(NOTE_WRITE_CAPABILITY_NAMES):
                response = disabled_note_capability_response(missing & set(NOTE_WRITE_CAPABILITY_NAMES))
            else:
                response = _disabled_capability_response(missing)
            return TurnPlan(
                paper_ids=paper_ids,
                requires_note_write=requires_note_write,
                required_capabilities=required,
                allowed_capabilities=allowed,
                fail_closed_response=response,
            )

        return TurnPlan(
            paper_ids=paper_ids,
            requires_note_write=requires_note_write,
            required_capabilities=required,
            allowed_capabilities=allowed,
        )

    def _explicit_paper_ids(self, user_content: str) -> list[int]:
        out: list[int] = []
        seen: set[int] = set()
        for paper_id in extract_paper_ids(user_content):
            try:
                normalized = int(paper_id)
            except (TypeError, ValueError):
                continue
            if normalized in seen:
                continue
            seen.add(normalized)
            out.append(normalized)
        return out

    def _paper_ids(self, user_content: str, *, linked_paper_ids: list[int] | None) -> list[int]:
        ids = [*extract_paper_ids(user_content), *(linked_paper_ids or [])]
        out: list[int] = []
        seen: set[int] = set()
        for paper_id in ids:
            try:
                normalized = int(paper_id)
            except (TypeError, ValueError):
                continue
            if normalized in seen:
                continue
            seen.add(normalized)
            out.append(normalized)
        return out
