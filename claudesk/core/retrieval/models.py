from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class RetrievalSourceType(str, Enum):
    PAPER = "paper"
    NOTE = "note"
    PROJECT = "project"
    TASK = "task"
    LOG = "log"
    PDF_CHUNK = "pdf_chunk"


class RetrievalBackend(str, Enum):
    LEXICAL = "lexical"
    SEMANTIC = "semantic"


def retrieval_backends_from_mode(mode: str | None) -> tuple[RetrievalBackend, ...]:
    normalized = (mode or "lexical").strip().casefold()
    if normalized == "lexical":
        return (RetrievalBackend.LEXICAL,)
    if normalized == "semantic":
        return (RetrievalBackend.SEMANTIC,)
    if normalized == "hybrid":
        return (RetrievalBackend.LEXICAL, RetrievalBackend.SEMANTIC)
    raise ValueError("Retrieval backend must be 'lexical', 'semantic', or 'hybrid'.")


@dataclass(frozen=True)
class RetrievalQuery:
    text: str
    terms: tuple[str, ...] = ()

    @classmethod
    def parse(cls, query: str) -> "RetrievalQuery":
        text = (query or "").strip()
        terms = tuple(re.findall(r"\w+", text.casefold(), flags=re.UNICODE))
        return cls(text=text, terms=terms)

    @property
    def is_empty(self) -> bool:
        return not self.text or not self.terms


@dataclass(frozen=True)
class RetrievalScope:
    source_types: tuple[RetrievalSourceType, ...] = ()
    project_id: int | None = None
    paper_id: int | None = None
    asset_id: int | None = None
    include_dismissed: bool = False

    @classmethod
    def sources(
        cls,
        *source_types: RetrievalSourceType,
        project_id: int | None = None,
        paper_id: int | None = None,
        asset_id: int | None = None,
        include_dismissed: bool = False,
    ) -> "RetrievalScope":
        return cls(
            source_types=tuple(source_types),
            project_id=project_id,
            paper_id=paper_id,
            asset_id=asset_id,
            include_dismissed=include_dismissed,
        )


@dataclass(frozen=True)
class RetrievalRequest:
    query: RetrievalQuery
    scope: RetrievalScope = field(default_factory=RetrievalScope)
    limit_per_source: int = 50
    backends: tuple[RetrievalBackend, ...] = (RetrievalBackend.LEXICAL,)

    @classmethod
    def from_text(
        cls,
        query: str,
        *,
        source_types: tuple[RetrievalSourceType, ...] = (),
        project_id: int | None = None,
        paper_id: int | None = None,
        asset_id: int | None = None,
        include_dismissed: bool = False,
        limit_per_source: int = 50,
        backends: tuple[RetrievalBackend, ...] = (RetrievalBackend.LEXICAL,),
    ) -> "RetrievalRequest":
        return cls(
            query=RetrievalQuery.parse(query),
            scope=RetrievalScope(
                source_types=source_types,
                project_id=project_id,
                paper_id=paper_id,
                asset_id=asset_id,
                include_dismissed=include_dismissed,
            ),
            limit_per_source=limit_per_source,
            backends=tuple(dict.fromkeys(backends)) or (RetrievalBackend.LEXICAL,),
        )


@dataclass(frozen=True)
class RetrievalSnippet:
    text: str
    field: str
    start_char: int = 0
    end_char: int = 0
    truncated: bool = False


@dataclass(frozen=True)
class RetrievalFieldScore:
    field: str
    matched_terms: tuple[str, ...] = ()
    weight: float = 1.0
    rank_hint: float = 0.0


@dataclass(frozen=True)
class RetrievalScoreMetadata:
    backend: RetrievalBackend
    rank: int
    normalized_score: float = 0.0
    fusion_score: float = 0.0
    backend_score: float | None = None
    field_scores: tuple[RetrievalFieldScore, ...] = ()
    field_matches: tuple[str, ...] = ()
    contributing_backends: tuple[RetrievalBackend, ...] = ()


@dataclass(frozen=True)
class RetrievalEvidenceLocator:
    paper_id: int | None = None
    note_id: int | None = None
    project_id: int | None = None
    task_id: int | None = None
    log_entry_id: int | None = None
    asset_id: int | None = None
    chunk_id: int | None = None
    chunk_index: int | None = None
    page_number: int | None = None
    section_path: tuple[str, ...] = ()
    bbox: tuple[float, float, float, float] | None = None
    block_ids: tuple[int, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {}
        for key, value in {
            "paper_id": self.paper_id,
            "note_id": self.note_id,
            "project_id": self.project_id,
            "task_id": self.task_id,
            "log_entry_id": self.log_entry_id,
            "asset_id": self.asset_id,
            "chunk_id": self.chunk_id,
            "chunk_index": self.chunk_index,
            "page_number": self.page_number,
        }.items():
            if value is not None:
                payload[key] = value
        if self.section_path:
            payload["section_path"] = list(self.section_path)
        if self.bbox is not None:
            payload["bbox"] = list(self.bbox)
        if self.block_ids:
            payload["block_ids"] = list(self.block_ids)
        return payload


@dataclass(frozen=True)
class RetrievalHit:
    source_type: RetrievalSourceType
    source_id: str
    title: str
    snippet: RetrievalSnippet
    score: RetrievalScoreMetadata
    locator: RetrievalEvidenceLocator
    payload: Any


@dataclass(frozen=True)
class RetrievalResults:
    query: RetrievalQuery
    scope: RetrievalScope
    hits: tuple[RetrievalHit, ...]

    def hits_for(self, source_type: RetrievalSourceType) -> list[RetrievalHit]:
        return [hit for hit in self.hits if hit.source_type == source_type]
