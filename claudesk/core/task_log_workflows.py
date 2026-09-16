from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import date

from claudesk.core.db.tasks import (
    create_manual_log_entry as db_create_manual_log_entry,
    get_manual_log_entry,
    get_todo,
    insert_todo,
    require_manual_log_entry,
    update_manual_log_entry as db_update_manual_log_entry,
    update_todo as db_update_todo,
)
from claudesk.core.models import ManualLogEntry, Todo, TodoPriority
from claudesk.core.paper_mentions import extract_paper_ids, normalize_text_paper_mentions

UNSET = object()


@dataclass(frozen=True)
class TaskCreateResult:
    task_id: int
    task: Todo | None


@dataclass(frozen=True)
class TaskUpdateResult:
    before: Todo
    after: Todo | None


@dataclass(frozen=True)
class ManualLogCreateResult:
    entry_id: int
    entry: ManualLogEntry | None


@dataclass(frozen=True)
class ManualLogUpdateResult:
    before: ManualLogEntry
    after: ManualLogEntry | None


def _parse_due_date(value: date | str | None) -> date | None:
    if value is None or isinstance(value, date):
        return value
    return date.fromisoformat(value)


def _maybe_normalize_paper_mentions(
    conn: sqlite3.Connection,
    text: str,
    *,
    paper_ids: list[int] | None,
) -> str:
    if paper_ids is None:
        return text
    return normalize_text_paper_mentions(conn, text, paper_ids=paper_ids)


def create_task(
    conn: sqlite3.Connection,
    *,
    title: str,
    description: str = "",
    priority: str = "medium",
    project_ids: list[int] | None = None,
    due_date: date | str | None = None,
    parent_id: int | None = None,
    sort_order: int = 0,
    paper_ids: list[int] | None = None,
) -> TaskCreateResult:
    normalized_description = _maybe_normalize_paper_mentions(
        conn,
        description,
        paper_ids=paper_ids,
    ).strip()
    task = Todo(
        title=title.strip(),
        description=normalized_description,
        priority=TodoPriority(priority),
        project_ids=list(project_ids or []),
        due_date=_parse_due_date(due_date),
        parent_id=parent_id,
        sort_order=sort_order,
    )
    task_id = insert_todo(conn, task)
    return TaskCreateResult(task_id=task_id, task=get_todo(conn, task_id))


def create_subtask(
    conn: sqlite3.Connection,
    *,
    parent_id: int,
    title: str,
    description: str = "",
    priority: str = "medium",
    project_ids: list[int] | None = None,
    due_date: date | str | None = None,
    paper_ids: list[int] | None = None,
) -> TaskCreateResult:
    parent = get_todo(conn, parent_id)
    if parent is None:
        raise ValueError(f"Task {parent_id} not found.")
    if parent.parent_id is not None:
        raise ValueError("Subtasks can only be added to root tasks.")
    return create_task(
        conn,
        title=title,
        description=description,
        priority=priority,
        project_ids=project_ids if project_ids is not None else parent.project_ids,
        due_date=due_date,
        parent_id=parent_id,
        paper_ids=paper_ids,
    )


def update_task_fields(
    conn: sqlite3.Connection,
    task_id: int,
    *,
    title: str | None | object = UNSET,
    description: str | None | object = UNSET,
    priority: str | None | object = UNSET,
    project_ids: list[int] | None | object = UNSET,
    due_date: date | str | None | object = UNSET,
    paper_ids: list[int] | None | object = UNSET,
) -> TaskUpdateResult:
    existing = get_todo(conn, task_id)
    if existing is None:
        raise ValueError(f"Task {task_id} not found.")

    next_title = (
        existing.title
        if title is UNSET or title is None
        else title.strip()
    )
    next_description = (
        existing.description
        if description is UNSET or description is None
        else description
    )
    if paper_ids is not UNSET:
        next_description = normalize_text_paper_mentions(
            conn,
            next_description,
            paper_ids=[] if paper_ids is None else paper_ids,
        )

    next_priority = (
        existing.priority.value
        if priority is UNSET or priority is None
        else TodoPriority(priority).value
    )
    next_due_date = (
        existing.due_date
        if due_date is UNSET
        else _parse_due_date(due_date)
    )
    next_project_ids = (
        existing.project_ids
        if project_ids is UNSET or project_ids is None
        else project_ids
    )

    db_update_todo(
        conn,
        task_id,
        next_title,
        next_description.strip(),
        next_priority,
        next_project_ids,
        next_due_date,
    )
    return TaskUpdateResult(before=existing, after=get_todo(conn, task_id))


def _entry_text(
    conn: sqlite3.Connection,
    entry: str,
    *,
    paper_ids: list[int] | None,
) -> str:
    return _maybe_normalize_paper_mentions(conn, entry, paper_ids=paper_ids)


def create_manual_log_from_text(
    conn: sqlite3.Connection,
    *,
    entry: str,
    project_ids: list[int] | None = None,
    entry_date: date | None = None,
    paper_ids: list[int] | None = None,
    derive_linked_paper_ids: bool = True,
) -> ManualLogCreateResult:
    text = _entry_text(conn, entry, paper_ids=paper_ids)
    log_entry = ManualLogEntry(
        entry_date=entry_date or date.today(),
        entry=text,
        project_ids=list(project_ids or []),
        linked_paper_ids=extract_paper_ids(text) if derive_linked_paper_ids else [],
    )
    entry_id = db_create_manual_log_entry(conn, log_entry)
    return ManualLogCreateResult(entry_id=entry_id, entry=get_manual_log_entry(conn, entry_id))


def update_manual_log_from_text(
    conn: sqlite3.Connection,
    entry_id: int,
    *,
    entry: str,
    project_ids: list[int] | None = None,
    entry_date: date | None = None,
    paper_ids: list[int] | None = None,
) -> ManualLogUpdateResult:
    before = require_manual_log_entry(conn, entry_id)
    text = _entry_text(conn, entry, paper_ids=paper_ids)
    db_update_manual_log_entry(
        conn,
        entry_id,
        text,
        project_ids,
        extract_paper_ids(text),
        entry_date=entry_date,
    )
    return ManualLogUpdateResult(before=before, after=get_manual_log_entry(conn, entry_id))
