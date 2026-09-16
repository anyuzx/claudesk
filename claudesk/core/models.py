from __future__ import annotations

from dataclasses import dataclass, field as dataclass_field
from datetime import date, datetime, timezone
from enum import Enum
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

from claudesk.core.config import ChatRuntimeSettings


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class PaperStatus(str, Enum):
    NEW = "new"
    READ = "read"
    SAVED = "saved"
    DISMISSED = "dismissed"


class PaperSignal(str, Enum):
    NEW = "new"
    READ = "read"
    SAVED = "saved"
    UNSAVED = "unsaved"
    TO_READ = "to_read"
    REMOVE_TO_READ = "remove_to_read"
    DISMISSED = "dismissed"
    UNDISMISSED = "undismissed"


class AssetKind(str, Enum):
    PDF = "pdf"
    MARKDOWN = "markdown"
    TEXT = "text"
    HTML = "html"
    ATTACHMENT = "attachment"


class AssetParseStatus(str, Enum):
    NOT_PARSED = "not_parsed"
    QUEUED = "queued"
    PARSED = "parsed"
    FAILED = "failed"


PaperPdfStatus = Literal["none", "available", "queued", "parsed", "failed"]
ChatAttachmentKind = Literal["clipboard_text", "screenshot", "file"]


class PaperAsset(BaseModel):
    id: Optional[int] = None
    kind: AssetKind = AssetKind.PDF
    source: str = "manual"
    managed_path: Optional[str] = None
    original_filename: str
    display_name: str
    mime_type: str = "application/pdf"
    size_bytes: int = 0
    content_hash: str = ""
    parse_status: AssetParseStatus = AssetParseStatus.NOT_PARSED
    parser_name: Optional[str] = None
    parser_version: Optional[str] = None
    source_asset_id: Optional[int] = None
    parsed_text: Optional[str] = None
    parse_error: Optional[str] = None
    parsed_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)


class ChatAttachment(BaseModel):
    session_id: int
    asset: PaperAsset
    context_kind: ChatAttachmentKind
    user_message_id: Optional[int] = None
    created_at: datetime = Field(default_factory=_utcnow)


class AssetPdfPage(BaseModel):
    asset_id: int
    page_number: int
    text: str = ""
    page_width: float = 0
    page_height: float = 0
    image_managed_path: Optional[str] = None
    image_width: int = 0
    image_height: int = 0
    render_dpi: int = 0
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)


class AssetTextChunk(BaseModel):
    id: Optional[int] = None
    asset_id: int
    chunk_index: int
    page_number: int
    text: str
    char_count: int = 0
    block_type: str = "paragraph"
    section_path: list[str] = Field(default_factory=list)
    bbox: Optional[list[float]] = None
    block_ids: list[int] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)


class AssetParseArtifact(BaseModel):
    id: Optional[int] = None
    asset_id: int
    artifact_kind: str
    parser_name: str
    parser_version: str
    managed_path: Optional[str] = None
    mime_type: str = ""
    size_bytes: int = 0
    content_hash: str = ""
    created_at: datetime = Field(default_factory=_utcnow)


class AssetDocumentBlock(BaseModel):
    id: Optional[int] = None
    asset_id: int
    block_index: int
    page_number: int
    block_type: str = "paragraph"
    section_path: list[str] = Field(default_factory=list)
    text: str = ""
    bbox: Optional[list[float]] = None
    image_managed_path: Optional[str] = None
    metadata: dict[str, object] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)


class PaperScoreRubric(BaseModel):
    topic_match: int = Field(ge=0, le=3)
    method_match: int = Field(ge=0, le=3)
    usefulness: int = Field(ge=0, le=3)
    novelty: int = Field(ge=0, le=3)
    confidence: int = Field(ge=0, le=3)
    evidence: list[str] = Field(default_factory=list)
    reason: str = ""


class Paper(BaseModel):
    id: Optional[int] = None
    source: str                        # "arxiv" | "biorxiv" | "pubmed" | "openalex"
    external_id: str                   # arXiv ID, DOI, or PubMed ID
    title: str
    abstract: str
    authors: list[str] = Field(default_factory=list)
    published_date: date
    journal_abbrev: Optional[str] = None
    url: str
    embedding: Optional[list[float]] = None
    relevance_score: Optional[float] = None
    score_rubric: Optional[PaperScoreRubric] = None
    note_count: int = 0
    latest_note_preview: Optional[str] = None
    status: PaperStatus = PaperStatus.NEW
    is_saved: bool = False
    is_read: bool = False
    is_to_read: bool = False
    to_read_at: Optional[datetime] = None
    is_new_digest: bool = False
    pdf_status: PaperPdfStatus = "none"
    project_ids: list[int] = Field(default_factory=list)
    fetched_at: datetime = Field(default_factory=_utcnow)


class Note(BaseModel):
    id: Optional[int] = None
    title: str
    body: str = ""
    search_body: str = Field(default="", exclude=True)
    linked_paper_ids: list[int] = Field(default_factory=list)
    mentioned_paper_ids: list[int] = Field(default_factory=list)
    manual_paper_ids: list[int] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)


class NoteWikilinkStatus(str, Enum):
    RESOLVED = "resolved"
    UNRESOLVED = "unresolved"
    AMBIGUOUS = "ambiguous"
    MISSING_HEADING = "missing_heading"
    MISSING_TARGET = "missing_target"


class NoteOutgoingLink(BaseModel):
    id: int
    target_note_id: Optional[int] = None
    target_title: Optional[str] = None
    raw_target_title: str
    normalized_target_title: str
    heading_fragment: Optional[str] = None
    alias: Optional[str] = None
    status: NoteWikilinkStatus
    created_at: datetime
    updated_at: datetime


class NoteBacklink(BaseModel):
    id: int
    source_note_id: int
    source_title: str
    source_preview: str
    heading_fragment: Optional[str] = None
    alias: Optional[str] = None
    status: NoteWikilinkStatus
    created_at: datetime
    updated_at: datetime


class NoteReferences(BaseModel):
    outgoing: list[NoteOutgoingLink] = Field(default_factory=list)
    backlinks: list[NoteBacklink] = Field(default_factory=list)


class TodoStatus(str, Enum):
    OPEN = "open"
    DONE = "done"


class TodoPriority(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class ProjectStatus(str, Enum):
    ACTIVE = "active"
    PAUSED = "paused"
    INCUBATING = "incubating"
    DONE = "done"


class ProjectPaperRole(str, Enum):
    SEED = "seed"
    RELEVANT = "relevant"
    BACKGROUND = "background"
    METHOD = "method"
    RESULT = "result"
    TO_READ = "to_read"


class ProjectMilestoneStatus(str, Enum):
    NOT_STARTED = "not_started"
    IN_PROGRESS = "in_progress"
    BLOCKED = "blocked"
    READY_FOR_REVIEW = "ready_for_review"
    DONE = "done"
    DROPPED = "dropped"


class ProjectMilestoneKind(str, Enum):
    CONCEPTUAL = "conceptual"
    LITERATURE = "literature"
    DATA = "data"
    ANALYSIS = "analysis"
    WRITING = "writing"
    SUBMISSION = "submission"
    COLLABORATION = "collaboration"
    ADMIN = "admin"


class Project(BaseModel):
    id: Optional[int] = None
    slug: str
    name: str
    status: ProjectStatus = ProjectStatus.ACTIVE
    description: Optional[str] = None
    obsidian_note_path: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)


class ProjectMilestone(BaseModel):
    id: Optional[int] = None
    project_id: int
    title: str
    description: Optional[str] = None
    kind: ProjectMilestoneKind = ProjectMilestoneKind.ANALYSIS
    status: ProjectMilestoneStatus = ProjectMilestoneStatus.NOT_STARTED
    order_index: int = 0
    acceptance_criteria: Optional[str] = None
    target_date: Optional[date] = None
    completed_at: Optional[datetime] = None
    linked_todo_ids: list[int] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)


class ProjectProgressSummary(BaseModel):
    project_id: int
    milestone_count: int = 0
    active_milestone_count: int = 0
    not_started_milestone_count: int = 0
    in_progress_milestone_count: int = 0
    blocked_milestone_count: int = 0
    ready_for_review_count: int = 0
    done_milestone_count: int = 0
    dropped_milestone_count: int = 0
    open_linked_task_count: int = 0
    done_linked_task_count: int = 0
    next_milestone_id: Optional[int] = None


class ProjectListMetric(BaseModel):
    project_id: int
    milestone_count: int = 0
    active_milestone_count: int = 0
    blocked_milestone_count: int = 0
    ready_for_review_count: int = 0
    done_milestone_count: int = 0
    open_task_count: int = 0


class Todo(BaseModel):
    id: Optional[int] = None
    title: str
    description: str = ""
    status: TodoStatus = TodoStatus.OPEN
    priority: TodoPriority = TodoPriority.MEDIUM
    due_date: Optional[date] = None
    project_ids: list[int] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=_utcnow)
    completed_at: Optional[datetime] = None
    parent_id: Optional[int] = None
    sort_order: int = 0
    updated_at: Optional[datetime] = None
    subtasks: list["Todo"] = Field(default_factory=list)


class ManualLogEntry(BaseModel):
    id: Optional[int] = None
    entry_date: date = Field(default_factory=date.today)
    project_ids: list[int] = Field(default_factory=list)
    entry: str
    linked_paper_ids: list[int] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=_utcnow)


class LogTaskSubtask(BaseModel):
    id: int
    title: str
    status: TodoStatus
    completed_at: Optional[datetime] = None


class LogEntry(BaseModel):
    id: int
    entry_type: Literal["manual", "task"]
    entry_date: date
    created_at: datetime
    project_ids: list[int] = Field(default_factory=list)
    linked_paper_ids: list[int] = Field(default_factory=list)
    title: str
    body_markdown: str = ""
    raw_markdown: str = ""
    task_id: Optional[int] = None
    subtasks: list[LogTaskSubtask] = Field(default_factory=list)


ChatContextKind = Literal["paper", "project", "note", "pdf_asset", "clipboard_text", "screenshot", "file"]
ChatContextSource = Literal["active_ui", "user_attached", "paste", "screenshot"]
ChatContextStatus = Literal["ready", "missing", "unsupported", "expired"]
ChatTraceType = Literal["context", "progress", "tool_start", "tool_result", "warning", "error"]
ChatTraceStatus = Literal["running", "done", "warning", "error"]
ChatResourceReadSource = Literal["prompt_context", "capability_result"]


class ChatContextRef(BaseModel):
    paper_id: Optional[int] = None
    project_id: Optional[int] = None
    note_id: Optional[int] = None
    asset_id: Optional[int] = None


class ChatContextItem(BaseModel):
    client_id: Optional[str] = None
    kind: ChatContextKind
    source: ChatContextSource
    ref: Optional[ChatContextRef] = None
    label: Optional[str] = None
    preview: Optional[str] = None
    mime_type: Optional[str] = None
    size_bytes: Optional[int] = None
    status: ChatContextStatus = "ready"


class ChatTraceEntry(BaseModel):
    type: ChatTraceType
    status: ChatTraceStatus = "done"
    label: str = ""
    detail: str = ""
    name: Optional[str] = None
    summary: str = ""
    ref: Optional[ChatContextRef] = None
    context_items: list[ChatContextItem] = Field(default_factory=list)


class ChatMessage(BaseModel):
    id: Optional[int] = None
    session_id: int
    role: Literal["user", "assistant"]
    content: str
    trace_entries: list[ChatTraceEntry] = Field(default_factory=list)
    context_items: list[ChatContextItem] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=_utcnow)


@dataclass(frozen=True)
class ChatResourceReadInput:
    resource_kind: str
    resource_id: Optional[str] = None
    label: str = ""
    summary: str = ""
    locator: dict[str, Any] = dataclass_field(default_factory=dict)


def resource_read(
    resource_kind: str,
    resource_id: object | None = None,
    *,
    label: str = "",
    summary: str = "",
    locator: dict[str, Any] | None = None,
) -> ChatResourceReadInput:
    return ChatResourceReadInput(
        resource_kind=resource_kind,
        resource_id=None if resource_id is None else str(resource_id),
        label=label,
        summary=summary,
        locator=dict(locator or {}),
    )


class ChatResourceRead(BaseModel):
    id: Optional[int] = None
    session_id: int
    assistant_message_id: Optional[int] = None
    turn_id: str
    provider: str
    source: ChatResourceReadSource
    capability_name: Optional[str] = None
    resource_kind: str
    resource_id: Optional[str] = None
    label: str = ""
    summary: str = ""
    locator: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=_utcnow)


class ChatSessionSummary(BaseModel):
    id: Optional[int] = None
    runtime_settings: ChatRuntimeSettings
    title: str = ""
    project_ids: list[int] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)
    linked_paper_ids: list[int] = Field(default_factory=list)
    linked_todo_ids: list[int] = Field(default_factory=list)
    linked_progress_ids: list[int] = Field(default_factory=list)


class ChatSessionDetail(ChatSessionSummary):
    messages: list[ChatMessage] = Field(default_factory=list)
