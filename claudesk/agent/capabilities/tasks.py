from __future__ import annotations

import json

from claudesk.agent.capabilities.registry import CapabilitySpec
from claudesk.agent.context import CapabilityContext
from claudesk.agent.schemas import (
    AddSubtaskInput,
    AddTaskInput,
    CapabilityInput,
    CapabilityResult,
    ListTasksInput,
    SearchTasksInput,
    UpdateTaskInput,
    mutation_result,
)
from claudesk.core.db.tasks import (
    get_todo,
    list_todos,
)
from claudesk.core.models import TodoStatus
from claudesk.core.retrieval import (
    RetrievalRequest,
    RetrievalSourceType,
    retrieve,
)
from claudesk.core.task_log_workflows import (
    UNSET,
    create_subtask,
    create_task,
    update_task_fields,
)


def _todo_payload(todo) -> dict:
    return {
        "id": todo.id,
        "title": todo.title,
        "description": todo.description,
        "status": todo.status.value,
        "priority": todo.priority.value,
        "project_ids": todo.project_ids,
        "due_date": str(todo.due_date) if todo.due_date else None,
        "parent_id": todo.parent_id,
    }


def _list_tasks(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = ListTasksInput.model_validate(args)
    todos = list_todos(context.conn, status=TodoStatus(data.status))
    return CapabilityResult(text=json.dumps([_todo_payload(todo) for todo in todos]))


def _search_tasks(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = SearchTasksInput.model_validate(args)
    results = retrieve(
        context.conn,
        RetrievalRequest.from_text(
            data.query,
            source_types=(RetrievalSourceType.TASK,),
            limit_per_source=10,
        ),
    )
    todos = [hit.payload for hit in results.hits_for(RetrievalSourceType.TASK)]
    return CapabilityResult(text=json.dumps([
        {
            "id": todo.id,
            "title": todo.title,
            "description": todo.description,
            "priority": todo.priority.value,
            "project_ids": todo.project_ids,
        }
        for todo in todos
    ]))


def _add_task(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = AddTaskInput.model_validate(args)
    result = create_task(
        context.conn,
        title=data.title,
        description=data.description,
        priority=data.priority,
        project_ids=data.project_ids,
        due_date=data.due_date,
        paper_ids=data.paper_ids,
    )
    context.conn.commit()
    return mutation_result(
        action="add_task",
        resource="task",
        id=result.task_id,
        after=_todo_payload(result.task) if result.task is not None else {
            "id": result.task_id,
            "title": data.title.strip(),
            "description": data.description.strip(),
        },
    )


def _add_subtask(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = AddSubtaskInput.model_validate(args)
    try:
        result = create_subtask(
            context.conn,
            parent_id=data.parent_id,
            title=data.title,
            description=data.description,
            priority=data.priority,
            project_ids=data.project_ids,
            due_date=data.due_date,
            paper_ids=data.paper_ids,
        )
    except ValueError as exc:
        error = str(exc)
        if error == "Subtasks can only be added to root tasks." or error == f"Task {data.parent_id} not found.":
            return CapabilityResult(text=json.dumps({"ok": False, "error": error}))
        raise
    context.conn.commit()
    return mutation_result(
        action="add_subtask",
        resource="task",
        id=result.task_id,
        after=_todo_payload(result.task) if result.task is not None else {
            "id": result.task_id,
            "title": data.title.strip(),
            "description": data.description.strip(),
        },
        extra={"parent_id": data.parent_id},
    )


def _update_task(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = UpdateTaskInput.model_validate(args)
    existing = get_todo(context.conn, data.task_id)
    if existing is None:
        return CapabilityResult(text=json.dumps({"ok": False, "error": f"Task {data.task_id} not found."}))

    fields = data.model_fields_set
    paper_ids = (
        data.paper_ids
        if "paper_ids" in fields
        else ([] if "description" in fields and data.description is not None else UNSET)
    )
    result = update_task_fields(
        context.conn,
        data.task_id,
        title=data.title if "title" in fields else UNSET,
        description=data.description if "description" in fields else UNSET,
        priority=data.priority if "priority" in fields else UNSET,
        project_ids=data.project_ids if "project_ids" in fields else UNSET,
        due_date=data.due_date if "due_date" in fields else UNSET,
        paper_ids=paper_ids,
    )
    context.conn.commit()
    return mutation_result(
        action="update_task",
        resource="task",
        id=data.task_id,
        before=_todo_payload(result.before),
        after=_todo_payload(result.after) if result.after is not None else None,
    )


def capabilities() -> list[CapabilitySpec]:
    return [
        CapabilitySpec(
            name="list_todos",
            description="List tasks (actionable work items). Tasks can have one level of subtasks; this returns a flat view including subtasks. Alias: list_tasks.",
            input_model=ListTasksInput,
            handler=_list_tasks,
            domain="task",
            access="read",
            risk="low",
        ),
        CapabilitySpec(
            name="list_tasks",
            description="List tasks (actionable work items) as a flat view including any subtasks. Same data as list_todos.",
            input_model=ListTasksInput,
            handler=_list_tasks,
            domain="task",
            access="read",
            risk="low",
        ),
        CapabilitySpec(
            name="search_todos",
            description="Search task titles and descriptions. Alias: search_tasks.",
            input_model=SearchTasksInput,
            handler=_search_tasks,
            domain="task",
            access="read",
            risk="low",
        ),
        CapabilitySpec(
            name="search_tasks",
            description="Search task titles and descriptions. Same data as search_todos.",
            input_model=SearchTasksInput,
            handler=_search_tasks,
            domain="task",
            access="read",
            risk="low",
        ),
        CapabilitySpec(
            name="add_todo",
            description="Add a new task (actionable work item). Tasks are mutable and future-oriented; use add_log_entry instead to record what you did or observed. When the task description references local papers, pass paper_ids so the saved task uses clickable paper links. Alias: add_task.",
            input_model=AddTaskInput,
            handler=_add_task,
            domain="task",
            access="create",
            risk="medium",
            gate="task_write",
        ),
        CapabilitySpec(
            name="add_task",
            description="Add a new task (actionable work item). When the task description references local papers, pass paper_ids so the saved task uses clickable paper links. Same data as add_todo.",
            input_model=AddTaskInput,
            handler=_add_task,
            domain="task",
            access="create",
            risk="medium",
            gate="task_write",
        ),
        CapabilitySpec(
            name="add_subtask",
            description="Add a one-level subtask under an existing root task. Inherits the parent task's project links unless project_ids are provided. When the subtask description references local papers, pass paper_ids so the saved subtask uses clickable paper links.",
            input_model=AddSubtaskInput,
            handler=_add_subtask,
            domain="task",
            access="create",
            risk="medium",
            gate="task_write",
        ),
        CapabilitySpec(
            name="update_task",
            description="Update task title, description, priority, due date, and project links by explicit task id. When the task description references local papers, pass paper_ids so the saved task uses clickable paper links. This cannot complete, reopen, change status, or delete tasks.",
            input_model=UpdateTaskInput,
            handler=_update_task,
            domain="task",
            access="update",
            risk="medium",
            gate="task_write",
        ),
    ]
