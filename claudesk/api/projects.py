from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from claudesk.api.deps import get_conn
from claudesk.api.paper_asset_payloads import build_paper_asset_payload
from claudesk.core.config import load_config
from claudesk.core.db.projects import (
    create_project,
    create_project_milestone,
    delete_project,
    delete_project_milestone,
    get_project_milestone,
    get_project_progress_summary,
    get_project,
    link_milestone_todo,
    link_project_paper,
    list_milestone_todos,
    list_project_assets,
    list_project_metrics,
    list_project_milestones,
    list_project_notes,
    list_project_papers,
    list_projects,
    replace_milestone_todos,
    unlink_milestone_todo,
    unlink_project_paper,
    update_project_milestone,
    update_project,
)
from claudesk.core.db.chat import list_project_chat_sessions
from claudesk.core.db.tasks import (
    list_log_entries,
    list_project_todos,
)
from claudesk.core.models import (
    ProjectMilestoneKind,
    ProjectMilestoneStatus,
    ProjectPaperRole,
    ProjectStatus,
    TodoStatus,
)
from claudesk.core.retrieval import (
    RetrievalRequest,
    RetrievalSourceType,
    retrieve,
    retrieval_backends_from_mode,
)

router = APIRouter()


class CreateProjectRequest(BaseModel):
    name: str
    status: ProjectStatus = ProjectStatus.ACTIVE
    description: Optional[str] = None
    obsidian_note_path: Optional[str] = None
    tags: list[str] = Field(default_factory=list)


class UpdateProjectRequest(BaseModel):
    name: Optional[str] = None
    status: Optional[ProjectStatus] = None
    description: Optional[str] = None
    obsidian_note_path: Optional[str] = None
    tags: Optional[list[str]] = None


class LinkProjectPaperRequest(BaseModel):
    paper_id: int
    role: ProjectPaperRole = ProjectPaperRole.RELEVANT


class CreateProjectMilestoneRequest(BaseModel):
    title: str
    description: Optional[str] = None
    kind: ProjectMilestoneKind = ProjectMilestoneKind.ANALYSIS
    status: ProjectMilestoneStatus = ProjectMilestoneStatus.NOT_STARTED
    order_index: int = 0
    acceptance_criteria: Optional[str] = None
    target_date: Optional[date] = None


class UpdateProjectMilestoneRequest(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    kind: Optional[ProjectMilestoneKind] = None
    status: Optional[ProjectMilestoneStatus] = None
    order_index: Optional[int] = None
    acceptance_criteria: Optional[str] = None
    target_date: Optional[date] = None


class LinkMilestoneTodoRequest(BaseModel):
    todo_id: int


class ReplaceMilestoneTodosRequest(BaseModel):
    todo_ids: list[int] = Field(default_factory=list)


def _get_project_or_404(conn, project_id: int):
    project = get_project(conn, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"Project {project_id} not found.")
    return project


def _matched_projects(conn, *, query: str | None, backend: str, include_done: bool) -> list | None:
    if not query or not query.strip():
        return None
    try:
        backends = retrieval_backends_from_mode(backend)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    request = RetrievalRequest.from_text(
        query,
        source_types=(RetrievalSourceType.PROJECT,),
        limit_per_source=500,
        backends=backends,
    )
    if request.query.is_empty:
        return None
    results = retrieve(conn, request)
    projects = [
        hit.payload
        for hit in results.hits_for(RetrievalSourceType.PROJECT)
        if hit.locator.project_id is not None
    ]
    if not include_done:
        projects = [project for project in projects if project.status.value != "done"]
    return projects


@router.get("/projects")
def get_projects(
    include_done: bool = True,
    q: str | None = None,
    backend: str = "lexical",
    conn=Depends(get_conn),
):
    matched_projects = _matched_projects(
        conn,
        query=q,
        backend=backend,
        include_done=include_done,
    )
    projects = (
        matched_projects
        if matched_projects is not None
        else list_projects(conn, include_done=include_done)
    )
    return [project.model_dump() for project in projects]


@router.get("/projects/list-metrics")
def get_project_list_metrics(include_done: bool = True, conn=Depends(get_conn)):
    return [metric.model_dump() for metric in list_project_metrics(conn, include_done=include_done)]


@router.post("/projects")
def create_project_endpoint(body: CreateProjectRequest, conn=Depends(get_conn)):
    try:
        project = create_project(
            conn,
            name=body.name,
            status=body.status,
            description=body.description,
            obsidian_note_path=body.obsidian_note_path,
            tags=body.tags,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    conn.commit()
    return project.model_dump()


@router.get("/projects/{project_id}")
def get_project_endpoint(project_id: int, conn=Depends(get_conn)):
    project = _get_project_or_404(conn, project_id)
    return project.model_dump()


@router.patch("/projects/{project_id}")
def update_project_endpoint(project_id: int, body: UpdateProjectRequest, conn=Depends(get_conn)):
    payload = body.model_dump(exclude_unset=True)
    try:
        project = update_project(
            conn,
            project_id,
            **payload,
        )
    except ValueError as exc:
        detail = str(exc)
        status_code = 404 if "not found" in detail else 400
        raise HTTPException(status_code=status_code, detail=detail) from exc
    conn.commit()
    return project.model_dump()


@router.delete("/projects/{project_id}")
def delete_project_endpoint(project_id: int, conn=Depends(get_conn)):
    try:
        delete_project(conn, project_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    conn.commit()
    return {"ok": True}


@router.get("/projects/{project_id}/papers")
def get_project_papers_endpoint(project_id: int, conn=Depends(get_conn)):
    try:
        papers = list_project_papers(conn, project_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return [paper.model_dump(exclude={"embedding"}) for paper in papers]


@router.get("/projects/{project_id}/notes")
def get_project_notes_endpoint(project_id: int, conn=Depends(get_conn)):
    try:
        notes = list_project_notes(conn, project_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return [note.model_dump() for note in notes]


@router.get("/projects/{project_id}/assets")
def get_project_assets_endpoint(project_id: int, conn=Depends(get_conn)):
    try:
        rows = list_project_assets(conn, project_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    cfg = load_config()
    return [
        {
            **build_paper_asset_payload(asset, cfg=cfg, conn=conn),
            "paper_id": paper_id,
            "paper_title": paper_title,
        }
        for paper_id, paper_title, asset in rows
    ]


@router.post("/projects/{project_id}/papers")
def link_project_paper_endpoint(project_id: int, body: LinkProjectPaperRequest, conn=Depends(get_conn)):
    try:
        link_project_paper(conn, project_id, body.paper_id, role=body.role)
    except ValueError as exc:
        detail = str(exc)
        status_code = 404 if "not found" in detail else 400
        raise HTTPException(status_code=status_code, detail=detail) from exc
    conn.commit()
    return {"ok": True}


@router.delete("/projects/{project_id}/papers/{paper_id}")
def unlink_project_paper_endpoint(project_id: int, paper_id: int, conn=Depends(get_conn)):
    try:
        unlink_project_paper(conn, project_id, paper_id)
    except ValueError as exc:
        detail = str(exc)
        status_code = 404 if "not found" in detail or "not linked" in detail else 400
        raise HTTPException(status_code=status_code, detail=detail) from exc
    conn.commit()
    return {"ok": True}


@router.get("/projects/{project_id}/milestones")
def get_project_milestones_endpoint(project_id: int, conn=Depends(get_conn)):
    try:
        milestones = list_project_milestones(conn, project_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return [milestone.model_dump() for milestone in milestones]


@router.post("/projects/{project_id}/milestones")
def create_project_milestone_endpoint(
    project_id: int,
    body: CreateProjectMilestoneRequest,
    conn=Depends(get_conn),
):
    try:
        milestone = create_project_milestone(
            conn,
            project_id=project_id,
            title=body.title,
            description=body.description,
            kind=body.kind,
            status=body.status,
            order_index=body.order_index,
            acceptance_criteria=body.acceptance_criteria,
            target_date=body.target_date,
        )
    except ValueError as exc:
        detail = str(exc)
        status_code = 404 if "not found" in detail else 400
        raise HTTPException(status_code=status_code, detail=detail) from exc
    conn.commit()
    return milestone.model_dump()


@router.get("/projects/{project_id}/milestones/{milestone_id}")
def get_project_milestone_endpoint(
    project_id: int,
    milestone_id: int,
    conn=Depends(get_conn),
):
    _get_project_or_404(conn, project_id)
    milestone = get_project_milestone(conn, project_id, milestone_id)
    if milestone is None:
        raise HTTPException(
            status_code=404,
            detail=f"Milestone {milestone_id} not found in project {project_id}.",
        )
    return milestone.model_dump()


@router.patch("/projects/{project_id}/milestones/{milestone_id}")
def update_project_milestone_endpoint(
    project_id: int,
    milestone_id: int,
    body: UpdateProjectMilestoneRequest,
    conn=Depends(get_conn),
):
    payload = body.model_dump(exclude_unset=True)
    try:
        milestone = update_project_milestone(
            conn,
            project_id,
            milestone_id,
            **payload,
        )
    except ValueError as exc:
        detail = str(exc)
        status_code = 404 if "not found" in detail else 400
        raise HTTPException(status_code=status_code, detail=detail) from exc
    conn.commit()
    return milestone.model_dump()


@router.delete("/projects/{project_id}/milestones/{milestone_id}")
def delete_project_milestone_endpoint(
    project_id: int,
    milestone_id: int,
    conn=Depends(get_conn),
):
    try:
        delete_project_milestone(conn, project_id, milestone_id)
    except ValueError as exc:
        detail = str(exc)
        status_code = 404 if "not found" in detail else 400
        raise HTTPException(status_code=status_code, detail=detail) from exc
    conn.commit()
    return {"ok": True}


@router.get("/projects/{project_id}/milestones/{milestone_id}/tasks")
def get_milestone_todos_endpoint(
    project_id: int,
    milestone_id: int,
    conn=Depends(get_conn),
):
    try:
        todos = list_milestone_todos(conn, project_id, milestone_id)
    except ValueError as exc:
        detail = str(exc)
        status_code = 404 if "not found" in detail else 400
        raise HTTPException(status_code=status_code, detail=detail) from exc
    return [todo.model_dump() for todo in todos]


@router.post("/projects/{project_id}/milestones/{milestone_id}/tasks")
def link_milestone_todo_endpoint(
    project_id: int,
    milestone_id: int,
    body: LinkMilestoneTodoRequest,
    conn=Depends(get_conn),
):
    try:
        link_milestone_todo(
            conn,
            project_id,
            milestone_id,
            body.todo_id,
        )
    except ValueError as exc:
        detail = str(exc)
        status_code = 404 if "not found" in detail else 400
        raise HTTPException(status_code=status_code, detail=detail) from exc
    conn.commit()
    return {"ok": True}


@router.put("/projects/{project_id}/milestones/{milestone_id}/tasks")
def replace_milestone_todos_endpoint(
    project_id: int,
    milestone_id: int,
    body: ReplaceMilestoneTodosRequest,
    conn=Depends(get_conn),
):
    try:
        replace_milestone_todos(
            conn,
            project_id,
            milestone_id,
            body.todo_ids,
        )
    except ValueError as exc:
        detail = str(exc)
        status_code = 404 if "not found" in detail else 400
        raise HTTPException(status_code=status_code, detail=detail) from exc
    conn.commit()
    return {"ok": True}


@router.delete("/projects/{project_id}/milestones/{milestone_id}/tasks/{todo_id}")
def unlink_milestone_todo_endpoint(
    project_id: int,
    milestone_id: int,
    todo_id: int,
    conn=Depends(get_conn),
):
    try:
        unlink_milestone_todo(
            conn,
            project_id,
            milestone_id,
            todo_id,
        )
    except ValueError as exc:
        detail = str(exc)
        status_code = 404 if "not found" in detail else 400
        raise HTTPException(status_code=status_code, detail=detail) from exc
    conn.commit()
    return {"ok": True}


@router.get("/projects/{project_id}/progress-summary")
def get_project_progress_summary_endpoint(project_id: int, conn=Depends(get_conn)):
    try:
        summary = get_project_progress_summary(conn, project_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return summary.model_dump()


@router.get("/projects/{project_id}/tasks")
def get_project_todos_endpoint(
    project_id: int,
    status: Optional[str] = None,
    conn=Depends(get_conn),
):
    todo_status = TodoStatus(status) if status else None
    try:
        todos = list_project_todos(conn, project_id, status=todo_status)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return [todo.model_dump() for todo in todos]


@router.get("/projects/{project_id}/log")
def get_project_progress_endpoint(
    project_id: int,
    days: Optional[int] = 30,
    entry_type: Optional[str] = None,
    q: Optional[str] = None,
    conn=Depends(get_conn),
):
    if get_project(conn, project_id) is None:
        raise HTTPException(status_code=404, detail=f"Project {project_id} not found.")
    try:
        entries = list_log_entries(
            conn,
            project_id=project_id,
            days=days,
            entry_type=entry_type,
            query=q,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return [entry.model_dump() for entry in entries]


@router.get("/projects/{project_id}/chat-sessions")
def get_project_chat_sessions_endpoint(
    project_id: int,
    limit: int = 20,
    conn=Depends(get_conn),
):
    try:
        sessions = list_project_chat_sessions(conn, project_id, limit=limit)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return [session.model_dump() for session in sessions]
