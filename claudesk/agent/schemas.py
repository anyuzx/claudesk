from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from datetime import date
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from claudesk.core.config import Config
from claudesk.core.models import ChatResourceReadInput
from claudesk.core.paper_assets import resolve_chat_attachment_path, resolve_managed_asset_path


class CapabilityInput(BaseModel):
    model_config = ConfigDict(extra="ignore")


class CapabilityJsonOutput(BaseModel):
    ok: bool | None = None


class SearchWebInput(CapabilityInput):
    query: str = Field(..., description="Search query.")
    limit: int = Field(default=5, ge=1, le=8, description="Maximum number of results to return.")


class FetchUrlInput(CapabilityInput):
    url: str = Field(..., description="Public http(s) URL to fetch.")
    max_chars: int = Field(default=6000, ge=100, le=12000)


class FetchPaperFullTextInput(CapabilityInput):
    paper_id: int
    max_chars: int = Field(default=6000, ge=100, le=12000)


class ListPaperAssetsInput(CapabilityInput):
    paper_id: int
    kind: str | None = None


class RenamePaperAssetInput(CapabilityInput):
    model_config = ConfigDict(extra="forbid")

    paper_id: int
    asset_id: int
    display_name: str


class ParsePaperAssetInput(CapabilityInput):
    model_config = ConfigDict(extra="forbid")

    paper_id: int
    asset_id: int
    force: bool = False


class AttachPdfFromUrlInput(CapabilityInput):
    model_config = ConfigDict(extra="forbid")

    paper_id: int
    url: str


class ListPaperStructureInput(CapabilityInput):
    paper_id: int
    asset_id: int | None = None


class RetrievePaperContextInput(CapabilityInput):
    paper_id: int
    query: str
    asset_id: int | None = None
    limit: int = Field(default=6, ge=1, le=12)
    max_chars: int = Field(default=16000, ge=1000, le=24000)
    backend: str = Field(default="lexical", description="Retrieval backend: lexical, semantic, or hybrid.")


class ReadPaperSectionInput(CapabilityInput):
    paper_id: int
    section_path: list[str] | str
    asset_id: int | None = None
    limit: int = Field(default=12, ge=1, le=40)
    max_chars: int = Field(default=20000, ge=1000, le=30000)


class ReadPaperPdfInput(CapabilityInput):
    paper_id: int
    asset_id: int | None = None
    start_chunk: int = Field(default=0, ge=0)
    limit: int = Field(default=8, ge=1, le=12)
    max_chars: int = Field(default=12000, ge=1000, le=20000)
    include_page_images: bool = False


class SearchPaperPdfInput(CapabilityInput):
    paper_id: int
    query: str
    asset_id: int | None = None
    limit: int = Field(default=5, ge=1, le=10)
    max_chars: int = Field(default=12000, ge=1000, le=20000)
    include_page_images: bool = True
    backend: str = Field(default="lexical", description="Retrieval backend: lexical, semantic, or hybrid.")


class InspectPaperPdfPagesInput(CapabilityInput):
    paper_id: int
    asset_id: int | None = None
    pages: list[int]
    include_text: bool = True
    include_images: bool = True


class ListRecentPapersInput(CapabilityInput):
    days: int = Field(default=7, ge=1, le=3650)
    status: str | None = None


class SearchPapersInput(CapabilityInput):
    query: str
    backend: str = Field(default="lexical", description="Retrieval backend: lexical, semantic, or hybrid.")


class GetPapersByIdsInput(CapabilityInput):
    paper_ids: list[int] | int


class PaperCollectionActionInput(CapabilityInput):
    model_config = ConfigDict(extra="forbid")

    paper_id: int


class AddPaperByDoiInput(CapabilityInput):
    model_config = ConfigDict(extra="forbid")

    doi: str


class GetProjectContextInput(CapabilityInput):
    model_config = ConfigDict(extra="forbid")

    project_id: int
    max_items: int = Field(default=20, ge=1, le=50)
    log_days: int = Field(default=30, ge=1, le=3650)


class CreateProjectInput(CapabilityInput):
    name: str
    description: str | None = None
    obsidian_note_path: str | None = None
    tags: list[str] = Field(default_factory=list)


class UpdateProjectMetadataInput(CapabilityInput):
    model_config = ConfigDict(extra="forbid")

    project_id: int
    name: str | None = None
    description: str | None = None
    obsidian_note_path: str | None = None
    tags: list[str] | None = None


class LinkProjectPaperInput(CapabilityInput):
    project_id: int
    paper_id: int
    role: str = "relevant"


class UnlinkProjectPaperInput(CapabilityInput):
    project_id: int
    paper_id: int


class ListProjectMilestonesInput(CapabilityInput):
    model_config = ConfigDict(extra="forbid")

    project_id: int
    status: str | None = None
    max_items: int = Field(default=20, ge=1, le=50)
    max_linked_tasks: int = Field(default=20, ge=1, le=50)


class GetProjectMilestoneInput(CapabilityInput):
    model_config = ConfigDict(extra="forbid")

    project_id: int
    milestone_id: int
    max_linked_tasks: int = Field(default=20, ge=1, le=50)


class CreateProjectMilestoneInput(CapabilityInput):
    model_config = ConfigDict(extra="forbid")

    project_id: int
    title: str
    description: str | None = None
    kind: str = "analysis"
    status: str = "not_started"
    order_index: int = 0
    acceptance_criteria: str | None = None
    target_date: date | None = None


class UpdateProjectMilestoneInput(CapabilityInput):
    model_config = ConfigDict(extra="forbid")

    project_id: int
    milestone_id: int
    title: str | None = None
    description: str | None = None
    kind: str | None = None
    status: str | None = None
    order_index: int | None = None
    acceptance_criteria: str | None = None
    target_date: date | None = None


class LinkMilestoneTaskInput(CapabilityInput):
    model_config = ConfigDict(extra="forbid")

    project_id: int
    milestone_id: int
    task_id: int


class UnlinkMilestoneTaskInput(CapabilityInput):
    model_config = ConfigDict(extra="forbid")

    project_id: int
    milestone_id: int
    task_id: int


class CreateMilestoneTaskInput(CapabilityInput):
    model_config = ConfigDict(extra="forbid")

    project_id: int
    milestone_id: int
    title: str
    description: str = ""
    priority: str = "medium"
    due_date: str | None = None
    paper_ids: list[int] = Field(
        default_factory=list,
        description="Local paper ids mentioned by the task description; used to store clickable paper links.",
    )


class GetNoteContextInput(CapabilityInput):
    note_id: int


class GetChatAttachmentContextInput(CapabilityInput):
    asset_id: int
    max_chars: int = Field(default=12000, ge=1, le=24000)
    include_image: bool = True
    start_chunk: int = Field(default=0, ge=0)
    limit: int = Field(default=8, ge=1, le=12)


class ListTasksInput(CapabilityInput):
    status: str = "open"


class SearchTasksInput(CapabilityInput):
    query: str


class AddTaskInput(CapabilityInput):
    title: str
    description: str = ""
    priority: str = "medium"
    project_ids: list[int] = Field(default_factory=list)
    due_date: str | None = None
    paper_ids: list[int] = Field(
        default_factory=list,
        description="Local paper ids mentioned by the task description; used to store clickable paper links.",
    )


class AddSubtaskInput(CapabilityInput):
    parent_id: int
    title: str
    description: str = ""
    priority: str = "medium"
    project_ids: list[int] | None = None
    due_date: str | None = None
    paper_ids: list[int] = Field(
        default_factory=list,
        description="Local paper ids mentioned by the subtask description; used to store clickable paper links.",
    )


class UpdateTaskInput(CapabilityInput):
    model_config = ConfigDict(extra="forbid")

    task_id: int
    title: str | None = None
    description: str | None = None
    priority: str | None = None
    project_ids: list[int] | None = None
    due_date: str | None = None
    paper_ids: list[int] | None = Field(
        default=None,
        description="Local paper ids mentioned by the task description; used to append missing clickable paper links.",
    )


class ListLogInput(CapabilityInput):
    days: int = Field(default=7, ge=1, le=3650)


class AddLogEntryInput(CapabilityInput):
    entry: str
    project_ids: list[int] = Field(default_factory=list)
    paper_ids: list[int] = Field(
        default_factory=list,
        description="Local paper ids mentioned by the log entry; used to store clickable paper links.",
    )


class UpdateLogEntryInput(CapabilityInput):
    entry_id: int
    entry: str
    project_ids: list[int] | None = None
    paper_ids: list[int] = Field(
        default_factory=list,
        description="Local paper ids mentioned by the log entry; used to store clickable paper links.",
    )


class CreatePaperNoteInput(CapabilityInput):
    paper_id: int
    note: str
    title: str | None = None


class CreateNoteInput(CapabilityInput):
    title: str
    body: str = ""


class UpdateNoteInput(CapabilityInput):
    model_config = ConfigDict(extra="forbid")

    note_id: int
    title: str | None = None
    body: str | None = None


class LinkNotePaperInput(CapabilityInput):
    note_id: int
    paper_id: int


class UnlinkNotePaperInput(CapabilityInput):
    note_id: int
    paper_id: int


class SearchNotesInput(CapabilityInput):
    query: str
    limit: int = Field(default=10, ge=1, le=50)
    backend: str = Field(default="lexical", description="Retrieval backend: lexical, semantic, or hybrid.")


@dataclass(frozen=True)
class ToolImageAttachment:
    label: str
    mime_type: str
    managed_path: str
    asset_id: Optional[int] = None
    page_number: Optional[int] = None
    width: int = 0
    height: int = 0
    temporary: bool = False

    def data_base64(self, *, cfg: Optional[Config] = None) -> str:
        if self.temporary:
            path = resolve_chat_attachment_path(self.managed_path, cfg=cfg)
        else:
            path = resolve_managed_asset_path(self.managed_path, cfg=cfg)
        return base64.b64encode(path.read_bytes()).decode("ascii")

    def metadata(self) -> dict:
        return {
            "label": self.label,
            "mime_type": self.mime_type,
            "asset_id": self.asset_id,
            "page_number": self.page_number,
            "width": self.width,
            "height": self.height,
        }

    def openai_content_block(self, *, cfg: Optional[Config] = None) -> dict:
        return {
            "type": "image_url",
            "image_url": {
                "url": f"data:{self.mime_type};base64,{self.data_base64(cfg=cfg)}",
            },
        }


@dataclass(frozen=True)
class CapabilityResult:
    text: str
    images: tuple[ToolImageAttachment, ...] = ()
    resource_reads: tuple[ChatResourceReadInput, ...] = ()

    def image_evidence_content(self, *, capability_name: str, cfg: Optional[Config] = None) -> list[dict]:
        if not self.images:
            return []
        lines = [f"Image evidence returned by capability `{capability_name}`:"]
        for image in self.images:
            page = f", page {image.page_number}" if image.page_number is not None else ""
            size = f", {image.width}x{image.height}" if image.width and image.height else ""
            lines.append(f"- {image.label} (asset {image.asset_id}{page}{size})")
        content: list[dict] = [{"type": "text", "text": "\n".join(lines)}]
        content.extend(image.openai_content_block(cfg=cfg) for image in self.images)
        return content


def mutation_result(
    *,
    action: str,
    resource: str,
    id: int | str | None = None,
    before: dict | None = None,
    after: dict | None = None,
    warnings: list[str] | None = None,
    extra: dict | None = None,
) -> CapabilityResult:
    payload: dict = {
        "ok": True,
        "action": action,
        "resource": resource,
    }
    if id is not None:
        payload["id"] = id
    if before is not None:
        payload["before"] = before
    if after is not None:
        payload["after"] = after
    if warnings:
        payload["warnings"] = warnings
    if extra:
        payload.update(extra)
    return CapabilityResult(text=json.dumps(payload, ensure_ascii=False, default=str))
