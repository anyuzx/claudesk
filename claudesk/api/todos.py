from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from claudesk.api.deps import get_conn
from claudesk.core.db.tasks import (
    complete_todo,
    delete_todo,
    list_root_todos_with_subtasks,
    list_todos,
    reopen_todo,
)
from claudesk.core.models import TodoStatus
from claudesk.core.retrieval import (
    RetrievalRequest,
    RetrievalSourceType,
    retrieve,
    retrieval_backends_from_mode,
)
from claudesk.core.task_log_workflows import UNSET, create_task, update_task_fields

router = APIRouter()


class CreateTodo(BaseModel):
    title: str
    description: str = ""
    priority: str = "medium"
    project_ids: list[int] = Field(default_factory=list)
    due_date: Optional[str] = None
    parent_id: Optional[int] = None
    sort_order: Optional[int] = None


class UpdateTodo(BaseModel):
    title: str
    description: str = ""
    priority: str
    project_ids: Optional[list[int]] = None
    due_date: Optional[str] = None


def _matched_task_ids(
    conn,
    *,
    query: str | None,
    backend: str,
    project_id: int | None,
) -> set[int] | None:
    if not query or not query.strip():
        return None
    try:
        backends = retrieval_backends_from_mode(backend)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    request = RetrievalRequest.from_text(
        query,
        source_types=(RetrievalSourceType.TASK,),
        project_id=project_id,
        limit_per_source=500,
        backends=backends,
    )
    if request.query.is_empty:
        return None
    results = retrieve(conn, request)
    return {
        hit.locator.task_id
        for hit in results.hits_for(RetrievalSourceType.TASK)
        if hit.locator.task_id is not None
    }


@router.get("/tasks")
def get_todos(
    status: Optional[str] = None,
    project_id: Optional[int] = None,
    nested: bool = False,
    q: Optional[str] = None,
    backend: str = "lexical",
    conn=Depends(get_conn),
):
    ts = TodoStatus(status) if status else None
    matched_ids = _matched_task_ids(conn, query=q, backend=backend, project_id=project_id)
    if nested:
        tasks = list_root_todos_with_subtasks(conn, status=ts, project_id=project_id)
        if matched_ids is not None:
            tasks = [
                task
                for task in tasks
                if task.id in matched_ids
                or any(subtask.id in matched_ids for subtask in task.subtasks)
            ]
        return [
            t.model_dump()
            for t in tasks
        ]
    tasks = list_todos(conn, status=ts, project_id=project_id)
    if matched_ids is not None:
        tasks = [task for task in tasks if task.id in matched_ids]
    return [t.model_dump() for t in tasks]


@router.post("/tasks")
def create_todo(body: CreateTodo, conn=Depends(get_conn)):
    result = create_task(
        conn,
        title=body.title.strip(),
        description=body.description.strip(),
        priority=body.priority,
        project_ids=body.project_ids,
        due_date=body.due_date,
        parent_id=body.parent_id,
        sort_order=body.sort_order or 0,
    )
    conn.commit()
    return result.task.model_dump() if result.task is not None else {"id": result.task_id}


@router.patch("/tasks/{todo_id}")
def update_todo_endpoint(todo_id: int, body: UpdateTodo, conn=Depends(get_conn)):
    update_task_fields(
        conn,
        todo_id,
        title=body.title,
        description=body.description if "description" in body.model_fields_set else UNSET,
        priority=body.priority,
        project_ids=body.project_ids,
        due_date=body.due_date,
    )
    conn.commit()
    return {"ok": True}


@router.post("/tasks/{todo_id}/complete")
def complete_todo_endpoint(todo_id: int, conn=Depends(get_conn)):
    result = complete_todo(conn, todo_id)
    conn.commit()
    return {"ok": True, **result}


@router.post("/tasks/{todo_id}/reopen")
def reopen_todo_endpoint(todo_id: int, conn=Depends(get_conn)):
    result = reopen_todo(conn, todo_id)
    conn.commit()
    return {"ok": True, **result}


@router.delete("/tasks/{todo_id}")
def delete_todo_endpoint(todo_id: int, conn=Depends(get_conn)):
    delete_todo(conn, todo_id)
    conn.commit()
    return {"ok": True}
