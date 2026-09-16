from __future__ import annotations

import json
import re

from claudesk.agent.capabilities.registry import CapabilitySpec
from claudesk.agent.context import CapabilityContext
from claudesk.agent.schemas import CapabilityInput, CapabilityResult, GetProjectContextInput
from claudesk.agent.schemas import (
    CreateMilestoneTaskInput,
    CreateProjectInput,
    CreateProjectMilestoneInput,
    GetProjectMilestoneInput,
    LinkMilestoneTaskInput,
    LinkProjectPaperInput,
    ListProjectMilestonesInput,
    UnlinkMilestoneTaskInput,
    UnlinkProjectPaperInput,
    UpdateProjectMilestoneInput,
    UpdateProjectMetadataInput,
    mutation_result,
)
from claudesk.core.db.assets import (
    count_asset_document_blocks,
    count_asset_page_images,
    count_asset_parse_artifacts,
    count_asset_pdf_pages,
    count_asset_text_chunks,
)
from claudesk.core.db.projects import (
    create_project_milestone as db_create_project_milestone,
    create_project as db_create_project,
    get_project_milestone,
    get_project_progress_summary,
    get_project,
    link_milestone_todo,
    link_project_paper as db_link_project_paper,
    list_project_assets,
    list_milestone_todos,
    list_project_notes,
    list_project_milestones,
    list_project_paper_roles,
    list_project_papers,
    unlink_milestone_todo,
    unlink_project_paper as db_unlink_project_paper,
    update_project_milestone as db_update_project_milestone,
    update_project as db_update_project,
)
from claudesk.core.db.tasks import (
    format_log_entry_display_text,
    list_log_entries,
    list_project_todos,
)
from claudesk.core.db.chat import count_project_chat_sessions, list_project_chat_sessions
from claudesk.core.models import AssetKind, ProjectMilestoneKind, ProjectMilestoneStatus, ProjectPaperRole, TodoStatus, resource_read
from claudesk.core.paper_assets import asset_file_health
from claudesk.core.task_log_workflows import create_task


def _preview(text: str | None, *, limit: int = 240) -> str | None:
    normalized = re.sub(r"\s+", " ", text or "").strip()
    if not normalized:
        return None
    if len(normalized) <= limit:
        return normalized
    return normalized[: limit - 3].rstrip() + "..."


def _paper_payload(paper, *, role: ProjectPaperRole | str | None) -> dict:
    return {
        "id": paper.id,
        "title": paper.title,
        "role": role.value if isinstance(role, ProjectPaperRole) else role,
        "source": paper.source,
        "published_date": str(paper.published_date),
        "status": paper.status.value,
        "is_saved": paper.is_saved,
        "is_read": paper.is_read,
        "is_to_read": paper.is_to_read,
        "score": round(paper.relevance_score, 3) if paper.relevance_score else None,
        "journal_abbrev": paper.journal_abbrev,
        "note_count": paper.note_count,
        "latest_note_preview": paper.latest_note_preview,
        "pdf_status": paper.pdf_status,
        "url": paper.url,
    }


def _note_payload(note) -> dict:
    return {
        "id": note.id,
        "title": note.title,
        "preview": _preview(note.body),
        "linked_paper_ids": note.linked_paper_ids,
        "manual_paper_ids": note.manual_paper_ids,
        "mentioned_paper_ids": note.mentioned_paper_ids,
        "updated_at": note.updated_at.isoformat(),
    }


def _asset_payload(context: CapabilityContext, paper_id: int, paper_title: str, asset) -> dict:
    asset_id = asset.id or 0
    health = asset_file_health(asset.managed_path, cfg=context.cfg)
    return {
        "paper_id": paper_id,
        "paper_title": paper_title,
        "asset_id": asset.id,
        "display_name": asset.display_name,
        "original_filename": asset.original_filename,
        "mime_type": asset.mime_type,
        "size_bytes": asset.size_bytes,
        "parse_status": asset.parse_status.value,
        "parser_name": asset.parser_name,
        "parser_version": asset.parser_version,
        "parse_error": asset.parse_error,
        "parsed_at": asset.parsed_at.isoformat() if asset.parsed_at else None,
        "file_status": health.status.value,
        "file_exists": health.file_exists,
        "page_count": count_asset_pdf_pages(context.conn, asset_id),
        "chunk_count": count_asset_text_chunks(context.conn, asset_id),
        "block_count": count_asset_document_blocks(context.conn, asset_id),
        "artifact_count": count_asset_parse_artifacts(context.conn, asset_id),
        "image_count": count_asset_page_images(context.conn, asset_id),
    }


def _task_payload(todo) -> dict:
    return {
        "id": todo.id,
        "title": todo.title,
        "description": todo.description,
        "status": todo.status.value,
        "priority": todo.priority.value,
        "due_date": todo.due_date.isoformat() if todo.due_date else None,
        "created_at": todo.created_at.isoformat(),
        "project_ids": todo.project_ids,
    }


def _append_task_resource_reads(
    reads: list,
    todos,
    *,
    project_id: int,
    summary: str,
    seen_task_ids: set[int],
    milestone_id: int | None = None,
) -> None:
    for todo in todos:
        if todo.id is None or todo.id in seen_task_ids:
            continue
        seen_task_ids.add(todo.id)
        locator = {"project_id": project_id, "todo_id": todo.id}
        if milestone_id is not None:
            locator["milestone_id"] = milestone_id
        reads.append(
            resource_read(
                "todo",
                todo.id,
                label=todo.title,
                summary=summary,
                locator=locator,
            )
        )


def _milestone_payload(
    milestone,
    *,
    linked_tasks: list | None = None,
    max_linked_tasks: int = 20,
) -> dict:
    payload = {
        "id": milestone.id,
        "project_id": milestone.project_id,
        "title": milestone.title,
        "description": milestone.description,
        "kind": milestone.kind.value,
        "status": milestone.status.value,
        "order_index": milestone.order_index,
        "acceptance_criteria": milestone.acceptance_criteria,
        "target_date": milestone.target_date.isoformat() if milestone.target_date else None,
        "completed_at": milestone.completed_at.isoformat() if milestone.completed_at else None,
        "linked_task_count": len(milestone.linked_todo_ids),
        "linked_task_ids": milestone.linked_todo_ids[:max_linked_tasks],
        "created_at": milestone.created_at.isoformat(),
        "updated_at": milestone.updated_at.isoformat(),
    }
    if linked_tasks is not None:
        payload["linked_tasks"] = [
            _task_payload(todo)
            for todo in linked_tasks[:max_linked_tasks]
        ]
    return payload


def _progress_summary_payload(summary) -> dict:
    return summary.model_dump(mode="json")


def _error_result(message: str) -> CapabilityResult:
    return CapabilityResult(text=json.dumps({"ok": False, "error": message}))


def _milestone_status(value: str | None) -> ProjectMilestoneStatus | None:
    return ProjectMilestoneStatus(value) if value is not None else None


def _milestone_kind(value: str | None) -> ProjectMilestoneKind | None:
    return ProjectMilestoneKind(value) if value is not None else None


def _log_entry_payload(entry) -> dict:
    payload = entry.model_dump(mode="json", exclude={"raw_markdown"})
    payload["entry"] = _preview(format_log_entry_display_text(entry), limit=500)
    return payload


def _chat_payload(session) -> dict:
    return {
        "id": session.id,
        "title": session.title,
        "updated_at": session.updated_at.isoformat(),
        "created_at": session.created_at.isoformat(),
        "project_ids": session.project_ids,
        "linked_paper_ids": session.linked_paper_ids,
        "linked_todo_ids": session.linked_todo_ids,
        "linked_progress_ids": session.linked_progress_ids,
    }


def _project_payload(project) -> dict:
    return {
        "id": project.id,
        "slug": project.slug,
        "name": project.name,
        "status": project.status.value,
        "description": project.description,
        "obsidian_note_path": project.obsidian_note_path,
        "tags": project.tags,
        "created_at": project.created_at.isoformat(),
        "updated_at": project.updated_at.isoformat(),
    }


def _create_project(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = CreateProjectInput.model_validate(args)
    project = db_create_project(
        context.conn,
        name=data.name,
        description=data.description,
        obsidian_note_path=data.obsidian_note_path,
        tags=data.tags,
    )
    context.conn.commit()
    return mutation_result(
        action="create_project",
        resource="project",
        id=project.id,
        after=_project_payload(project),
    )


def _update_project_metadata(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = UpdateProjectMetadataInput.model_validate(args)
    existing = get_project(context.conn, data.project_id)
    if existing is None:
        return CapabilityResult(text=json.dumps({"ok": False, "error": f"Project {data.project_id} not found."}))
    payload = {
        key: value
        for key, value in {
            "name": data.name,
            "description": data.description,
            "obsidian_note_path": data.obsidian_note_path,
            "tags": data.tags,
        }.items()
        if key in data.model_fields_set
    }
    if not payload:
        return CapabilityResult(text=json.dumps({"ok": False, "error": "At least one project metadata field is required."}))
    project = db_update_project(context.conn, data.project_id, **payload)
    context.conn.commit()
    return mutation_result(
        action="update_project_metadata",
        resource="project",
        id=data.project_id,
        before=_project_payload(existing),
        after=_project_payload(project),
    )


def _link_project_paper(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = LinkProjectPaperInput.model_validate(args)
    existing = get_project(context.conn, data.project_id)
    if existing is None:
        return CapabilityResult(text=json.dumps({"ok": False, "error": f"Project {data.project_id} not found."}))
    role = ProjectPaperRole(data.role)
    db_link_project_paper(context.conn, data.project_id, data.paper_id, role=role)
    context.conn.commit()
    return mutation_result(
        action="link_project_paper",
        resource="project_paper",
        id=f"{data.project_id}:{data.paper_id}",
        after={"project_id": data.project_id, "paper_id": data.paper_id, "role": role.value},
    )


def _unlink_project_paper(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = UnlinkProjectPaperInput.model_validate(args)
    existing = get_project(context.conn, data.project_id)
    if existing is None:
        return CapabilityResult(text=json.dumps({"ok": False, "error": f"Project {data.project_id} not found."}))
    db_unlink_project_paper(context.conn, data.project_id, data.paper_id)
    context.conn.commit()
    return mutation_result(
        action="unlink_project_paper",
        resource="project_paper",
        id=f"{data.project_id}:{data.paper_id}",
        before={"project_id": data.project_id, "paper_id": data.paper_id},
    )


def _list_project_milestones(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = ListProjectMilestonesInput.model_validate(args)
    try:
        milestones = list_project_milestones(
            context.conn,
            data.project_id,
            status=_milestone_status(data.status),
        )
    except ValueError as exc:
        return _error_result(str(exc))
    returned = milestones[:data.max_items]
    milestone_rows = [
        (
            milestone,
            list_milestone_todos(context.conn, data.project_id, milestone.id or 0)[: data.max_linked_tasks],
        )
        for milestone in returned
    ]
    payload = {
        "ok": True,
        "project_id": data.project_id,
        "count": len(milestones),
        "milestones": [
            _milestone_payload(
                milestone,
                linked_tasks=linked_tasks,
                max_linked_tasks=data.max_linked_tasks,
            )
            for milestone, linked_tasks in milestone_rows
        ],
    }
    reads = [
        resource_read(
            "project_milestone",
            milestone.id,
            label=milestone.title,
            summary="Project milestone returned.",
            locator={"project_id": data.project_id, "milestone_id": milestone.id},
        )
        for milestone in returned
    ]
    seen_task_ids: set[int] = set()
    for milestone, linked_tasks in milestone_rows:
        _append_task_resource_reads(
            reads,
            linked_tasks,
            project_id=data.project_id,
            summary="Project milestone linked task returned.",
            seen_task_ids=seen_task_ids,
            milestone_id=milestone.id,
        )
    return CapabilityResult(text=json.dumps(payload), resource_reads=tuple(reads))


def _get_project_milestone(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = GetProjectMilestoneInput.model_validate(args)
    milestone = get_project_milestone(context.conn, data.project_id, data.milestone_id)
    if milestone is None:
        return _error_result(f"Milestone {data.milestone_id} not found in project {data.project_id}.")
    linked_tasks = list_milestone_todos(context.conn, data.project_id, data.milestone_id)[: data.max_linked_tasks]
    reads = [
        resource_read(
            "project_milestone",
            milestone.id,
            label=milestone.title,
            summary="Project milestone returned.",
            locator={"project_id": data.project_id, "milestone_id": milestone.id},
        )
    ]
    _append_task_resource_reads(
        reads,
        linked_tasks,
        project_id=data.project_id,
        summary="Project milestone linked task returned.",
        seen_task_ids=set(),
        milestone_id=milestone.id,
    )
    return CapabilityResult(
        text=json.dumps({
            "ok": True,
            "milestone": _milestone_payload(
                milestone,
                linked_tasks=linked_tasks,
                max_linked_tasks=data.max_linked_tasks,
            ),
        }),
        resource_reads=tuple(reads),
    )


def _create_project_milestone(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = CreateProjectMilestoneInput.model_validate(args)
    try:
        milestone = db_create_project_milestone(
            context.conn,
            project_id=data.project_id,
            title=data.title,
            description=data.description,
            kind=ProjectMilestoneKind(data.kind),
            status=ProjectMilestoneStatus(data.status),
            order_index=data.order_index,
            acceptance_criteria=data.acceptance_criteria,
            target_date=data.target_date,
        )
    except ValueError as exc:
        return _error_result(str(exc))
    context.conn.commit()
    return mutation_result(
        action="create_project_milestone",
        resource="project_milestone",
        id=milestone.id,
        after=_milestone_payload(milestone),
    )


def _update_project_milestone(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = UpdateProjectMilestoneInput.model_validate(args)
    existing = get_project_milestone(context.conn, data.project_id, data.milestone_id)
    if existing is None:
        return _error_result(f"Milestone {data.milestone_id} not found in project {data.project_id}.")
    fields = data.model_fields_set
    if fields <= {"project_id", "milestone_id"}:
        return _error_result("At least one milestone metadata field is required.")
    try:
        updates = {}
        if "title" in fields:
            updates["title"] = data.title
        if "description" in fields:
            updates["description"] = data.description
        if "kind" in fields:
            updates["kind"] = _milestone_kind(data.kind)
        if "status" in fields:
            updates["status"] = _milestone_status(data.status)
        if "order_index" in fields:
            updates["order_index"] = data.order_index
        if "acceptance_criteria" in fields:
            updates["acceptance_criteria"] = data.acceptance_criteria
        if "target_date" in fields:
            updates["target_date"] = data.target_date
        milestone = db_update_project_milestone(
            context.conn,
            data.project_id,
            data.milestone_id,
            **updates,
        )
    except ValueError as exc:
        return _error_result(str(exc))
    context.conn.commit()
    return mutation_result(
        action="update_project_milestone",
        resource="project_milestone",
        id=data.milestone_id,
        before=_milestone_payload(existing),
        after=_milestone_payload(milestone),
    )


def _link_milestone_task(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = LinkMilestoneTaskInput.model_validate(args)
    milestone = get_project_milestone(context.conn, data.project_id, data.milestone_id)
    if milestone is None:
        return _error_result(f"Milestone {data.milestone_id} not found in project {data.project_id}.")
    try:
        link_milestone_todo(context.conn, data.project_id, data.milestone_id, data.task_id)
    except ValueError as exc:
        return _error_result(str(exc))
    context.conn.commit()
    linked_tasks = list_milestone_todos(context.conn, data.project_id, data.milestone_id)
    updated = get_project_milestone(context.conn, data.project_id, data.milestone_id)
    return mutation_result(
        action="link_milestone_task",
        resource="project_milestone_task",
        id=f"{data.milestone_id}:{data.task_id}",
        after={
            "milestone": _milestone_payload(updated or milestone, linked_tasks=linked_tasks),
            "task_id": data.task_id,
        },
    )


def _unlink_milestone_task(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = UnlinkMilestoneTaskInput.model_validate(args)
    milestone = get_project_milestone(context.conn, data.project_id, data.milestone_id)
    if milestone is None:
        return _error_result(f"Milestone {data.milestone_id} not found in project {data.project_id}.")
    try:
        unlink_milestone_todo(context.conn, data.project_id, data.milestone_id, data.task_id)
    except ValueError as exc:
        return _error_result(str(exc))
    context.conn.commit()
    updated = get_project_milestone(context.conn, data.project_id, data.milestone_id)
    linked_tasks = list_milestone_todos(context.conn, data.project_id, data.milestone_id)
    return mutation_result(
        action="unlink_milestone_task",
        resource="project_milestone_task",
        id=f"{data.milestone_id}:{data.task_id}",
        before={"milestone_id": data.milestone_id, "task_id": data.task_id},
        after={"milestone": _milestone_payload(updated or milestone, linked_tasks=linked_tasks)},
    )


def _create_milestone_task(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = CreateMilestoneTaskInput.model_validate(args)
    if not context.cfg.chat.tools.task_write:
        return _error_result("Capability disabled: task_write")
    milestone = get_project_milestone(context.conn, data.project_id, data.milestone_id)
    if milestone is None:
        return _error_result(f"Milestone {data.milestone_id} not found in project {data.project_id}.")
    try:
        task_result = create_task(
            context.conn,
            title=data.title,
            description=data.description,
            priority=data.priority,
            project_ids=[data.project_id],
            due_date=data.due_date,
            paper_ids=data.paper_ids,
        )
        link_milestone_todo(context.conn, data.project_id, data.milestone_id, task_result.task_id)
    except ValueError as exc:
        return _error_result(str(exc))
    context.conn.commit()
    updated = get_project_milestone(context.conn, data.project_id, data.milestone_id)
    linked_tasks = list_milestone_todos(context.conn, data.project_id, data.milestone_id)
    return mutation_result(
        action="create_milestone_task",
        resource="task",
        id=task_result.task_id,
        after=_task_payload(task_result.task) if task_result.task is not None else {"id": task_result.task_id},
        extra={"milestone": _milestone_payload(updated or milestone, linked_tasks=linked_tasks)},
    )


def _get_project_context(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = GetProjectContextInput.model_validate(args)
    project = get_project(context.conn, data.project_id)
    if project is None:
        return CapabilityResult(text=json.dumps({
            "ok": False,
            "error": f"Project {data.project_id} not found.",
        }))

    max_items = data.max_items
    paper_roles = list_project_paper_roles(context.conn, data.project_id)
    papers = list_project_papers(context.conn, data.project_id)
    notes = list_project_notes(context.conn, data.project_id)
    pdf_assets = [
        (paper_id, paper_title, asset)
        for paper_id, paper_title, asset in list_project_assets(context.conn, data.project_id)
        if asset.kind == AssetKind.PDF
    ]
    open_tasks = list_project_todos(context.conn, data.project_id, status=TodoStatus.OPEN)
    milestones = list_project_milestones(context.conn, data.project_id)
    progress_summary = get_project_progress_summary(context.conn, data.project_id)
    recent_log_entries = list_log_entries(context.conn, project_id=data.project_id, days=data.log_days)
    recent_chats = list_project_chat_sessions(context.conn, data.project_id, limit=max_items)
    returned_papers = papers[:max_items]
    returned_notes = notes[:max_items]
    returned_pdf_assets = pdf_assets[:max_items]
    returned_open_tasks = open_tasks[:max_items]
    returned_milestones = milestones[:max_items]
    returned_log_entries = recent_log_entries[:max_items]
    returned_chats = recent_chats[:max_items]
    milestone_rows = [
        (
            milestone,
            list_milestone_todos(context.conn, data.project_id, milestone.id or 0)[:max_items],
        )
        for milestone in returned_milestones
    ]

    payload = {
        "ok": True,
        "project": {
            "id": project.id,
            "slug": project.slug,
            "name": project.name,
            "status": project.status.value,
            "description": project.description,
            "obsidian_note_path": project.obsidian_note_path,
            "tags": project.tags,
            "created_at": project.created_at.isoformat(),
            "updated_at": project.updated_at.isoformat(),
        },
        "limits": {
            "max_items": max_items,
            "log_days": data.log_days,
        },
        "counts": {
            "linked_papers": len(papers),
            "linked_notes": len(notes),
            "pdf_assets": len(pdf_assets),
            "open_tasks": len(open_tasks),
            "milestones": len(milestones),
            "recent_log_entries": len(recent_log_entries),
            "recent_chats": count_project_chat_sessions(context.conn, data.project_id),
        },
        "progress_summary": _progress_summary_payload(progress_summary),
        "linked_papers": [
            _paper_payload(paper, role=paper_roles.get(paper.id or 0))
            for paper in returned_papers
        ],
        "linked_notes": [_note_payload(note) for note in returned_notes],
        "pdf_assets": [
            _asset_payload(context, paper_id, paper_title, asset)
            for paper_id, paper_title, asset in returned_pdf_assets
        ],
        "open_tasks": [_task_payload(todo) for todo in returned_open_tasks],
        "milestones": [
            _milestone_payload(
                milestone,
                linked_tasks=linked_tasks,
                max_linked_tasks=max_items,
            )
            for milestone, linked_tasks in milestone_rows
        ],
        "recent_log_entries": [_log_entry_payload(entry) for entry in returned_log_entries],
        "recent_chats": [_chat_payload(session) for session in returned_chats],
    }
    reads = [
        resource_read(
            "project",
            project.id,
            label=project.name,
            summary="Project metadata and bounded related resources returned.",
            locator={"project_id": project.id},
        )
    ]
    reads.extend(
        resource_read(
            "paper",
            paper.id,
            label=paper.title,
            summary="Project linked paper returned.",
            locator={"project_id": project.id, "paper_id": paper.id},
        )
        for paper in returned_papers
    )
    reads.extend(
        resource_read(
            "note",
            note.id,
            label=note.title,
            summary="Project linked note returned.",
            locator={"project_id": project.id, "note_id": note.id},
        )
        for note in returned_notes
    )
    reads.extend(
        resource_read(
            "asset",
            asset.id,
            label=asset.display_name,
            summary="Project linked PDF asset returned.",
            locator={"project_id": project.id, "paper_id": paper_id, "asset_id": asset.id},
        )
        for paper_id, _paper_title, asset in returned_pdf_assets
    )
    seen_task_ids: set[int] = set()
    _append_task_resource_reads(
        reads,
        returned_open_tasks,
        project_id=project.id or data.project_id,
        summary="Project open task returned.",
        seen_task_ids=seen_task_ids,
    )
    reads.append(
        resource_read(
            "project_progress_summary",
            project.id,
            label=project.name,
            summary="Project milestone progress summary returned.",
            locator={"project_id": project.id},
        )
    )
    reads.extend(
        resource_read(
            "project_milestone",
            milestone.id,
            label=milestone.title,
            summary="Project milestone returned.",
            locator={"project_id": project.id, "milestone_id": milestone.id},
        )
        for milestone in returned_milestones
    )
    for milestone, linked_tasks in milestone_rows:
        _append_task_resource_reads(
            reads,
            linked_tasks,
            project_id=project.id or data.project_id,
            summary="Project milestone linked task returned.",
            seen_task_ids=seen_task_ids,
            milestone_id=milestone.id,
        )
    reads.extend(
        resource_read(
            "log",
            entry.id,
            label=_preview(format_log_entry_display_text(entry), limit=80) or "",
            summary="Project recent log entry returned.",
            locator={
                "project_id": project.id,
                "log_entry_id": entry.id,
                "entry_type": entry.entry_type,
                "task_id": entry.task_id,
            },
        )
        for entry in returned_log_entries
    )
    reads.extend(
        resource_read(
            "chat_session",
            session.id,
            label=session.title,
            summary="Project related chat summary returned.",
            locator={"project_id": project.id, "chat_session_id": session.id},
        )
        for session in returned_chats
    )
    return CapabilityResult(text=json.dumps(payload), resource_reads=tuple(reads))


def capabilities() -> list[CapabilitySpec]:
    return [
        CapabilitySpec(
            name="get_project_context",
            description=(
                "Inspect a Claudesk project by id, including metadata, counts, linked papers, "
                "linked notes, managed PDF assets, milestones, progress summary, open tasks, recent progress, "
                "and related chat summaries."
            ),
            input_model=GetProjectContextInput,
            handler=_get_project_context,
            domain="project",
            access="read",
            risk="low",
        ),
        CapabilitySpec(
            name="list_project_milestones",
            description="List project milestones by project id, including linked task ids and bounded linked task summaries.",
            input_model=ListProjectMilestonesInput,
            handler=_list_project_milestones,
            domain="project",
            access="read",
            risk="low",
        ),
        CapabilitySpec(
            name="get_project_milestone",
            description="Retrieve one project milestone by project id and milestone id, including linked task summaries.",
            input_model=GetProjectMilestoneInput,
            handler=_get_project_milestone,
            domain="project",
            access="read",
            risk="low",
        ),
        CapabilitySpec(
            name="create_project",
            description="Create a Claudesk project with metadata only. The agent cannot mark projects done or delete projects.",
            input_model=CreateProjectInput,
            handler=_create_project,
            domain="project",
            access="create",
            risk="medium",
            gate="project_write",
        ),
        CapabilitySpec(
            name="update_project_metadata",
            description="Update project metadata by explicit project id: name, description, tags, and Obsidian note path only. This cannot change project status or delete projects.",
            input_model=UpdateProjectMetadataInput,
            handler=_update_project_metadata,
            domain="project",
            access="update",
            risk="medium",
            gate="project_write",
        ),
        CapabilitySpec(
            name="create_project_milestone",
            description="Create a project milestone with title, description, acceptance criteria, kind, status, order, and target date. This cannot delete milestones.",
            input_model=CreateProjectMilestoneInput,
            handler=_create_project_milestone,
            domain="project",
            access="create",
            risk="medium",
            gate="project_write",
        ),
        CapabilitySpec(
            name="update_project_milestone",
            description="Update project milestone metadata, status, kind, order, target date, description, or acceptance criteria by explicit ids. This cannot delete milestones.",
            input_model=UpdateProjectMilestoneInput,
            handler=_update_project_milestone,
            domain="project",
            access="update",
            risk="medium",
            gate="project_write",
        ),
        CapabilitySpec(
            name="link_milestone_task",
            description="Link an existing same-project task to a project milestone without changing or completing the task.",
            input_model=LinkMilestoneTaskInput,
            handler=_link_milestone_task,
            domain="project",
            access="link",
            risk="medium",
            gate="project_write",
        ),
        CapabilitySpec(
            name="unlink_milestone_task",
            description="Unlink a task from a project milestone without deleting the task.",
            input_model=UnlinkMilestoneTaskInput,
            handler=_unlink_milestone_task,
            domain="project",
            access="link",
            risk="medium",
            gate="project_write",
        ),
        CapabilitySpec(
            name="create_milestone_task",
            description="Create a new task linked to the project and milestone. Requires task writes to be enabled and does not complete, reopen, or delete tasks.",
            input_model=CreateMilestoneTaskInput,
            handler=_create_milestone_task,
            domain="project",
            access="create",
            risk="medium",
            gate=("project_write", "task_write"),
        ),
        CapabilitySpec(
            name="link_project_paper",
            description="Link a paper to a project by explicit ids, with an optional paper role.",
            input_model=LinkProjectPaperInput,
            handler=_link_project_paper,
            domain="project",
            access="link",
            risk="medium",
            gate="project_write",
        ),
        CapabilitySpec(
            name="unlink_project_paper",
            description="Unlink a paper from a project by explicit ids. This does not delete the paper or project.",
            input_model=UnlinkProjectPaperInput,
            handler=_unlink_project_paper,
            domain="project",
            access="link",
            risk="medium",
            gate="project_write",
        ),
    ]
