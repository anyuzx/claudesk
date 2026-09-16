from __future__ import annotations

import json
import sqlite3
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from claudesk.core.models import (
    AssetKind,
    AssetDocumentBlock,
    AssetParseArtifact,
    AssetPdfPage,
    AssetParseStatus,
    AssetTextChunk,
    ChatAttachment,
    ChatAttachmentKind,
    ChatContextItem,
    ChatMessage,
    ChatResourceRead,
    ChatResourceReadInput,
    ChatResourceReadSource,
    ChatSessionDetail,
    ChatSessionSummary,
    ChatTraceEntry,
    LogEntry,
    LogTaskSubtask,
    ManualLogEntry,
    Note,
    Paper,
    PaperAsset,
    PaperPdfStatus,
    PaperScoreRubric,
    PaperSignal,
    PaperStatus,
    Project,
    ProjectListMetric,
    ProjectMilestone,
    ProjectMilestoneKind,
    ProjectMilestoneStatus,
    ProjectPaperRole,
    ProjectProgressSummary,
    ProjectStatus,
    Todo,
    TodoPriority,
    TodoStatus,
)

from .projects import (
    _load_project_link_map,
    _prune_milestone_todos_for_task_projects,
    _replace_project_links,
    _resolve_project_links,
    get_project,
)
from .utils import _rank_fts_rows


def search_todos(
    conn: sqlite3.Connection,
    query: str,
    *,
    limit: int = 50,
) -> list[Todo]:
    rows = _rank_fts_rows(
        query,
        limit=limit,
        fetch_rows=lambda fts_query, pool_limit: conn.execute(
            """
            SELECT t.*
            FROM todos_fts
            JOIN todos t ON t.id = todos_fts.rowid
            WHERE todos_fts MATCH ?
            ORDER BY
                bm25(todos_fts, 8.0, 2.0),
                CASE WHEN t.status = 'open' THEN 0 ELSE 1 END,
                t.created_at DESC
            LIMIT ?
            """,
            (fts_query, pool_limit),
        ).fetchall(),
        fields=lambda row: (
            (row["title"] or "", 8.0),
            (row["description"] or "", 2.0),
        ),
    )
    return [_row_to_todo(r) for r in rows]


def _normalize_task_title(value: str) -> str:
    title = (value or "").strip()
    if not title:
        raise ValueError("Task title is required.")
    return title


def insert_todo(conn: sqlite3.Connection, todo: Todo) -> int:
    project_ids = _resolve_project_links(
        conn,
        project_ids=todo.project_ids,
    )
    title = _normalize_task_title(todo.title)
    description = (todo.description or "").strip()
    completed_at = todo.completed_at.isoformat() if todo.completed_at else None
    sort_order = todo.sort_order
    if sort_order == 0 and todo.parent_id is not None:
        row = conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM todos WHERE parent_id = ?",
            (todo.parent_id,),
        ).fetchone()
        sort_order = int(row["next"]) if row is not None else 0
    cur = conn.execute(
        """
        INSERT INTO todos (
            title, description, status, priority, due_date, created_at, completed_at,
            parent_id, sort_order, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            title,
            description,
            todo.status.value,
            todo.priority.value,
            todo.due_date.isoformat() if todo.due_date else None,
            todo.created_at.isoformat(),
            completed_at,
            todo.parent_id,
            sort_order,
            todo.created_at.isoformat(),
        ),
    )
    todo_id = int(cur.lastrowid)  # type: ignore[arg-type]
    _replace_project_links(
        conn,
        join_table="project_todos",
        item_column="todo_id",
        item_id=todo_id,
        project_ids=project_ids,
        created_at=todo.created_at.isoformat(),
    )
    if todo.parent_id is None and todo.status == TodoStatus.DONE and completed_at is not None:
        _ensure_task_log_entry(
            conn,
            todo_id,
            completed_at=completed_at,
            update_existing=False,
        )
    return todo_id


def _row_to_todo(
    row: sqlite3.Row,
    project_ids: Optional[list[int]] = None,
    subtasks: Optional[list[Todo]] = None,
) -> Todo:
    return Todo(
        id=row["id"],
        title=row["title"],
        description=row["description"] or "",
        status=TodoStatus(row["status"]),
        priority=TodoPriority(row["priority"]),
        due_date=date.fromisoformat(row["due_date"]) if row["due_date"] else None,
        project_ids=project_ids or [],
        created_at=datetime.fromisoformat(row["created_at"]),
        completed_at=(
            datetime.fromisoformat(row["completed_at"]) if row["completed_at"] else None
        ),
        parent_id=row["parent_id"],
        sort_order=row["sort_order"] if row["sort_order"] is not None else 0,
        updated_at=(
            datetime.fromisoformat(row["updated_at"]) if row["updated_at"] else None
        ),
        subtasks=subtasks or [],
    )


def get_todo(conn: sqlite3.Connection, todo_id: int) -> Optional[Todo]:
    cur = conn.execute("SELECT * FROM todos WHERE id=?", (todo_id,))
    row = cur.fetchone()
    if row is None:
        return None
    project_map = _load_project_link_map(
        conn,
        join_table="project_todos",
        item_column="todo_id",
        item_ids=[todo_id],
    )
    return _row_to_todo(row, project_map.get(todo_id, []))


def list_todos(
    conn: sqlite3.Connection,
    *,
    status: Optional[TodoStatus] = None,
    project_id: Optional[int] = None,
) -> list[Todo]:
    query = "SELECT DISTINCT todos.* FROM todos"
    params: list[object] = []
    joins: list[str] = []
    where = ["1=1"]
    if status:
        where.append("todos.status=?")
        params.append(status.value)
    if project_id is not None:
        joins.append("JOIN project_todos ON project_todos.todo_id = todos.id")
        where.append("project_todos.project_id=?")
        params.append(project_id)
    if joins:
        query += " " + " ".join(joins)
    query += " WHERE " + " AND ".join(where)
    query += " ORDER BY todos.priority DESC, todos.created_at ASC"
    cur = conn.execute(query, params)
    rows = cur.fetchall()
    project_map = _load_project_link_map(
        conn,
        join_table="project_todos",
        item_column="todo_id",
        item_ids=[int(row["id"]) for row in rows],
    )
    return [_row_to_todo(row, project_map.get(int(row["id"]), [])) for row in rows]


def list_subtasks(conn: sqlite3.Connection, parent_id: int) -> list[Todo]:
    rows = conn.execute(
        "SELECT * FROM todos WHERE parent_id=? ORDER BY sort_order ASC, id ASC",
        (parent_id,),
    ).fetchall()
    if not rows:
        return []
    project_map = _load_project_link_map(
        conn,
        join_table="project_todos",
        item_column="todo_id",
        item_ids=[int(row["id"]) for row in rows],
    )
    return [
        _row_to_todo(row, project_map.get(int(row["id"]), [])) for row in rows
    ]


def _load_subtasks_for_roots(
    conn: sqlite3.Connection, root_ids: list[int]
) -> dict[int, list[Todo]]:
    if not root_ids:
        return {}
    placeholders = ",".join("?" for _ in root_ids)
    rows = conn.execute(
        f"SELECT * FROM todos WHERE parent_id IN ({placeholders}) "
        f"ORDER BY parent_id, sort_order ASC, id ASC",
        root_ids,
    ).fetchall()
    if not rows:
        return {}
    project_map = _load_project_link_map(
        conn,
        join_table="project_todos",
        item_column="todo_id",
        item_ids=[int(row["id"]) for row in rows],
    )
    grouped: dict[int, list[Todo]] = {}
    for row in rows:
        sub = _row_to_todo(row, project_map.get(int(row["id"]), []))
        grouped.setdefault(int(row["parent_id"]), []).append(sub)
    return grouped


def list_root_todos_with_subtasks(
    conn: sqlite3.Connection,
    *,
    status: Optional[TodoStatus] = None,
    project_id: Optional[int] = None,
) -> list[Todo]:
    """Return root tasks (parent_id IS NULL) with their subtasks attached.

    Subtasks are returned regardless of their own status — the UI can show
    `2/4 done` even when the root filter is `open`.
    """
    query = "SELECT DISTINCT todos.* FROM todos"
    params: list[object] = []
    joins: list[str] = []
    where = ["todos.parent_id IS NULL"]
    if status:
        where.append("todos.status=?")
        params.append(status.value)
    if project_id is not None:
        joins.append("JOIN project_todos ON project_todos.todo_id = todos.id")
        where.append("project_todos.project_id=?")
        params.append(project_id)
    if joins:
        query += " " + " ".join(joins)
    query += " WHERE " + " AND ".join(where)
    query += " ORDER BY todos.priority DESC, todos.created_at ASC"
    rows = conn.execute(query, params).fetchall()
    if not rows:
        return []
    root_ids = [int(row["id"]) for row in rows]
    project_map = _load_project_link_map(
        conn,
        join_table="project_todos",
        item_column="todo_id",
        item_ids=root_ids,
    )
    subtasks_by_parent = _load_subtasks_for_roots(conn, root_ids)
    return [
        _row_to_todo(
            row,
            project_map.get(int(row["id"]), []),
            subtasks_by_parent.get(int(row["id"]), []),
        )
        for row in rows
    ]


def _mark_todo_done(conn: sqlite3.Connection, todo_id: int, *, now: str) -> None:
    conn.execute(
        "UPDATE todos SET status='done', completed_at=?, updated_at=? WHERE id=?",
        (now, now, todo_id),
    )


def _mark_todo_open(conn: sqlite3.Connection, todo_id: int, *, now: str) -> None:
    conn.execute(
        "UPDATE todos SET status='open', completed_at=NULL, updated_at=? WHERE id=?",
        (now, todo_id),
    )


def _extract_paper_ids_from_task_tree(root: Todo, subtasks: list[Todo]) -> list[int]:
    from claudesk.core.paper_mentions import extract_paper_ids

    seen: set[int] = set()
    ordered: list[int] = []
    for source_text in (
        root.title,
        root.description,
        *(value for subtask in subtasks for value in (subtask.title, subtask.description)),
    ):
        if not source_text:
            continue
        for paper_id in extract_paper_ids(source_text):
            if paper_id in seen:
                continue
            seen.add(paper_id)
            ordered.append(paper_id)
    return ordered


def _ensure_task_log_entry(
    conn: sqlite3.Connection,
    root_id: int,
    *,
    completed_at: str,
    update_existing: bool,
) -> None:
    entry_date = completed_at[:10]
    conn.execute(
        """
        INSERT OR IGNORE INTO log_entries (
            entry_type, entry_date, task_id, created_at
        )
        VALUES ('task', ?, ?, ?)
        """,
        (entry_date, root_id, completed_at),
    )
    if update_existing:
        conn.execute(
            """
            UPDATE log_entries
            SET entry_date=?, created_at=?
            WHERE entry_type='task' AND task_id=?
            """,
            (entry_date, completed_at, root_id),
        )


def _complete_root_with_cascade(
    conn: sqlite3.Connection,
    root_id: int,
    subtasks: list[Todo],
    completed_ids: list[int],
    *,
    now: str,
) -> dict:
    for sub in subtasks:
        if sub.status != TodoStatus.DONE:
            _mark_todo_done(conn, int(sub.id), now=now)
            completed_ids.append(int(sub.id))
    root = get_todo(conn, root_id)
    if root is None:
        raise ValueError(f"Todo {root_id} not found.")
    root_was_done = root.status == TodoStatus.DONE
    if root.status != TodoStatus.DONE:
        _mark_todo_done(conn, int(root.id), now=now)
        completed_ids.append(int(root.id))
    completed_at = (
        root.completed_at.isoformat()
        if root_was_done and root.completed_at is not None
        else now
    )
    _ensure_task_log_entry(
        conn,
        root_id,
        completed_at=completed_at,
        update_existing=not root_was_done,
    )
    return {
        "completed_ids": completed_ids,
        "root_id": root_id,
    }


def complete_todo(conn: sqlite3.Connection, todo_id: int) -> dict:
    """Complete a task, cascading per spec.

    - Root with no subtasks: mark done.
    - Root with subtasks: cascade-complete all open subtasks, mark root done,
      and expose the completed root task through the unified log query.
    - Subtask: mark done. If all sibling subtasks are now done, cascade up
      to complete the parent.

    Returns ``{completed_ids, root_id}``. Idempotent re-completion returns the
    existing root without creating duplicate task activity.
    """
    todo = get_todo(conn, todo_id)
    if todo is None:
        raise ValueError(f"Todo {todo_id} not found.")
    now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
    completed_ids: list[int] = []

    if todo.parent_id is not None:
        if todo.status != TodoStatus.DONE:
            _mark_todo_done(conn, int(todo.id), now=now)
            completed_ids.append(int(todo.id))
        siblings = list_subtasks(conn, int(todo.parent_id))
        if siblings and all(s.status == TodoStatus.DONE for s in siblings):
            return _complete_root_with_cascade(
                conn,
                int(todo.parent_id),
                siblings,
                completed_ids,
                now=now,
            )
        return {
            "completed_ids": completed_ids,
            "root_id": int(todo.parent_id),
        }

    subtasks = list_subtasks(conn, int(todo.id))
    return _complete_root_with_cascade(
        conn,
        int(todo.id),
        subtasks,
        completed_ids,
        now=now,
    )


def update_todo(
    conn: sqlite3.Connection,
    todo_id: int,
    title: str,
    description: str,
    priority: str,
    project_ids: Optional[list[int]],
    due_date: Optional[date],
) -> None:
    existing = get_todo(conn, todo_id)
    if existing is None:
        raise ValueError(f"Todo {todo_id} not found.")
    normalized_title = _normalize_task_title(title)
    normalized_description = (description or "").strip()

    if project_ids is None:
        resolved_project_ids = existing.project_ids
    else:
        resolved_project_ids = _resolve_project_links(
            conn,
            project_ids=project_ids,
        )
    now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
    conn.execute(
        "UPDATE todos SET title=?, description=?, priority=?, due_date=?, updated_at=? WHERE id=?",
        (
            normalized_title,
            normalized_description,
            priority,
            due_date.isoformat() if due_date else None,
            now,
            todo_id,
        ),
    )
    _replace_project_links(
        conn,
        join_table="project_todos",
        item_column="todo_id",
        item_id=todo_id,
        project_ids=resolved_project_ids,
        created_at=existing.created_at.isoformat(),
    )
    _prune_milestone_todos_for_task_projects(
        conn,
        todo_id,
        resolved_project_ids,
        timestamp=now,
    )


def reopen_todo(conn: sqlite3.Connection, todo_id: int) -> dict:
    """Reopen a task.

    - Subtask: reopen the subtask. If its parent is currently done, also reopen
      the parent (parent is "done" only when every subtask is done).
    - Root task: reopen the root only. Subtasks stay in their existing state.

    Reopened tasks disappear from the task-activity log until completed again.
    """
    todo = get_todo(conn, todo_id)
    if todo is None:
        raise ValueError(f"Todo {todo_id} not found.")
    now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
    reopened_ids: list[int] = []
    if todo.status == TodoStatus.DONE:
        _mark_todo_open(conn, int(todo.id), now=now)
        reopened_ids.append(int(todo.id))
    if todo.parent_id is not None:
        parent = get_todo(conn, int(todo.parent_id))
        if parent is not None and parent.status == TodoStatus.DONE:
            _mark_todo_open(conn, int(parent.id), now=now)
            reopened_ids.append(int(parent.id))
    return {"reopened_ids": reopened_ids}


def create_manual_log_entry(conn: sqlite3.Connection, entry: ManualLogEntry) -> int:
    project_ids = _resolve_project_links(
        conn,
        project_ids=entry.project_ids,
    )
    cur = conn.execute(
        """
        INSERT INTO log_entries (
            entry_type, entry_date, entry_markdown, linked_paper_ids, task_id, created_at
        )
        VALUES ('manual', ?, ?, ?, NULL, ?)
        """,
        (
            entry.entry_date.isoformat(),
            entry.entry,
            json.dumps(entry.linked_paper_ids),
            entry.created_at.isoformat(),
        ),
    )
    entry_id = int(cur.lastrowid)  # type: ignore[arg-type]
    _replace_project_links(
        conn,
        join_table="project_log_entries",
        item_column="log_entry_id",
        item_id=entry_id,
        project_ids=project_ids,
        created_at=entry.created_at.isoformat(),
    )
    return entry_id


def _row_to_manual_log_entry(
    row: sqlite3.Row,
    project_ids: Optional[list[int]] = None,
) -> ManualLogEntry:
    return ManualLogEntry(
        id=row["id"],
        entry_date=date.fromisoformat(row["entry_date"]),
        project_ids=project_ids or [],
        entry=row["entry_markdown"],
        linked_paper_ids=json.loads(row["linked_paper_ids"]),
        created_at=datetime.fromisoformat(row["created_at"]),
    )


def require_manual_log_entry(conn: sqlite3.Connection, entry_id: int) -> ManualLogEntry:
    row = conn.execute("SELECT * FROM log_entries WHERE id=?", (entry_id,)).fetchone()
    if row is None:
        raise ValueError(f"Log entry {entry_id} not found.")
    if row["entry_type"] != "manual":
        raise ValueError(f"Log entry {entry_id} is not a manual log entry.")
    project_map = _load_project_link_map(
        conn,
        join_table="project_log_entries",
        item_column="log_entry_id",
        item_ids=[entry_id],
    )
    return _row_to_manual_log_entry(row, project_map.get(entry_id, []))


def get_manual_log_entry(conn: sqlite3.Connection, entry_id: int) -> Optional[ManualLogEntry]:
    try:
        return require_manual_log_entry(conn, entry_id)
    except ValueError:
        return None


def update_manual_log_entry(
    conn: sqlite3.Connection,
    entry_id: int,
    entry: str,
    project_ids: Optional[list[int]],
    linked_paper_ids: Optional[list[int]] = None,
    entry_date: Optional[date] = None,
) -> None:
    existing = require_manual_log_entry(conn, entry_id)
    next_entry_date = entry_date or existing.entry_date
    if project_ids is None:
        resolved_project_ids = existing.project_ids
    else:
        resolved_project_ids = _resolve_project_links(
            conn,
            project_ids=project_ids,
        )
    conn.execute(
        """
        UPDATE log_entries
        SET entry_markdown=?, linked_paper_ids=?, entry_date=?
        WHERE id=? AND entry_type='manual'
        """,
        (
            entry,
            json.dumps(linked_paper_ids or []),
            next_entry_date.isoformat(),
            entry_id,
        ),
    )
    _replace_project_links(
        conn,
        join_table="project_log_entries",
        item_column="log_entry_id",
        item_id=entry_id,
        project_ids=resolved_project_ids,
        created_at=existing.created_at.isoformat(),
    )


def delete_manual_log_entry(conn: sqlite3.Connection, entry_id: int) -> None:
    require_manual_log_entry(conn, entry_id)
    conn.execute("DELETE FROM log_entries WHERE id=? AND entry_type='manual'", (entry_id,))


def list_manual_log_entries(
    conn: sqlite3.Connection,
    *,
    project_id: Optional[int] = None,
    days: Optional[int] = 30,
) -> list[ManualLogEntry]:
    query = "SELECT DISTINCT log_entries.* FROM log_entries"
    params: list[object] = []
    joins: list[str] = []
    where = ["log_entries.entry_type='manual'"]
    if days is not None:
        since = (datetime.now().date() - timedelta(days=days)).isoformat()
        where.append("log_entries.entry_date >= ?")
        params.append(since)
    if project_id is not None:
        joins.append(
            "JOIN project_log_entries ON project_log_entries.log_entry_id = log_entries.id"
        )
        where.append("project_log_entries.project_id=?")
        params.append(project_id)
    if joins:
        query += " " + " ".join(joins)
    query += " WHERE " + " AND ".join(where)
    query += " ORDER BY log_entries.entry_date DESC, log_entries.created_at DESC"
    rows = conn.execute(query, params).fetchall()
    project_map = _load_project_link_map(
        conn,
        join_table="project_log_entries",
        item_column="log_entry_id",
        item_ids=[int(row["id"]) for row in rows],
    )
    return [_row_to_manual_log_entry(row, project_map.get(int(row["id"]), [])) for row in rows]


def list_project_todos(
    conn: sqlite3.Connection,
    project_id: int,
    *,
    status: Optional[TodoStatus] = None,
) -> list[Todo]:
    if get_project(conn, project_id) is None:
        raise ValueError(f"Project {project_id} not found.")
    return list_todos(conn, status=status, project_id=project_id)


def _split_manual_log_markdown(markdown: str) -> tuple[str, str]:
    lines = markdown.splitlines()
    title_index: Optional[int] = None
    for index, line in enumerate(lines):
        if line.strip():
            title_index = index
            break
    if title_index is None:
        return "(untitled log entry)", ""

    title = lines[title_index].strip()
    body = "\n".join(lines[title_index + 1:]).strip()
    return title, body


def _manual_log_to_log_entry(entry: ManualLogEntry) -> LogEntry:
    title, body = _split_manual_log_markdown(entry.entry)
    assert entry.id is not None
    return LogEntry(
        id=entry.id,
        entry_type="manual",
        entry_date=entry.entry_date,
        created_at=entry.created_at,
        project_ids=entry.project_ids,
        linked_paper_ids=entry.linked_paper_ids,
        title=title,
        body_markdown=body,
        raw_markdown=entry.entry,
    )


def _task_to_log_entry(row: sqlite3.Row, root: Todo, subtasks: list[Todo]) -> LogEntry:
    assert root.id is not None
    # Task log rows are completion ledger pointers; display fields stay task-backed.
    return LogEntry(
        id=int(row["id"]),
        entry_type="task",
        task_id=root.id,
        entry_date=date.fromisoformat(row["entry_date"]),
        created_at=datetime.fromisoformat(row["created_at"]),
        project_ids=root.project_ids,
        linked_paper_ids=_extract_paper_ids_from_task_tree(root, subtasks),
        title=root.title,
        body_markdown=root.description,
        raw_markdown=root.description,
        subtasks=[
            LogTaskSubtask(
                id=int(subtask.id),
                title=subtask.title,
                status=subtask.status,
                completed_at=subtask.completed_at,
            )
            for subtask in subtasks
            if subtask.id is not None
        ],
    )


def _list_task_log_entries(
    conn: sqlite3.Connection,
    *,
    project_id: Optional[int] = None,
    days: Optional[int] = 30,
) -> list[LogEntry]:
    query = """
        SELECT DISTINCT log_entries.*
        FROM log_entries
        JOIN todos root ON root.id = log_entries.task_id
    """
    params: list[object] = []
    joins: list[str] = []
    where = [
        "log_entries.entry_type='task'",
        "root.parent_id IS NULL",
        "root.status='done'",
    ]
    if days is not None:
        since = (datetime.now().date() - timedelta(days=days)).isoformat()
        where.append("log_entries.entry_date >= ?")
        params.append(since)
    if project_id is not None:
        joins.append("JOIN project_todos ON project_todos.todo_id = root.id")
        where.append("project_todos.project_id=?")
        params.append(project_id)
    if joins:
        query += " " + " ".join(joins)
    query += " WHERE " + " AND ".join(where)
    query += " ORDER BY log_entries.entry_date DESC, log_entries.created_at DESC"
    rows = conn.execute(query, params).fetchall()
    return _task_log_entries_from_rows(conn, rows)


def _manual_log_entries_from_rows(
    conn: sqlite3.Connection,
    rows: list[sqlite3.Row],
) -> list[LogEntry]:
    if not rows:
        return []
    entry_ids = [int(row["id"]) for row in rows]
    project_map = _load_project_link_map(
        conn,
        join_table="project_log_entries",
        item_column="log_entry_id",
        item_ids=entry_ids,
    )
    return [
        _manual_log_to_log_entry(
            _row_to_manual_log_entry(row, project_map.get(int(row["id"]), []))
        )
        for row in rows
    ]


def _task_log_entries_from_rows(
    conn: sqlite3.Connection,
    rows: list[sqlite3.Row],
) -> list[LogEntry]:
    if not rows:
        return []
    root_ids = [int(row["task_id"]) for row in rows if row["task_id"] is not None]
    if not root_ids:
        return []
    placeholders = ",".join("?" for _ in root_ids)
    root_rows = conn.execute(
        f"SELECT * FROM todos WHERE id IN ({placeholders})",
        root_ids,
    ).fetchall()
    project_map = _load_project_link_map(
        conn,
        join_table="project_todos",
        item_column="todo_id",
        item_ids=root_ids,
    )
    subtasks_by_parent = _load_subtasks_for_roots(conn, root_ids)
    roots_by_id = {
        int(root_row["id"]): _row_to_todo(
            root_row,
            project_map.get(int(root_row["id"]), []),
            subtasks_by_parent.get(int(root_row["id"]), []),
        )
        for root_row in root_rows
    }
    entries: list[LogEntry] = []
    for row in rows:
        root = roots_by_id.get(int(row["task_id"]))
        if root is None:
            continue
        entries.append(_task_to_log_entry(row, root, root.subtasks))
    return entries


def format_log_entry_display_text(entry: LogEntry) -> str:
    if entry.entry_type == "manual":
        return entry.raw_markdown

    lines = [f"Completed task: {entry.title}"]
    if entry.body_markdown:
        lines.extend(["", entry.body_markdown])
    if entry.subtasks:
        lines.extend(["", "Subtasks completed:"])
        lines.extend(f"- {subtask.title}" for subtask in entry.subtasks)
    return "\n".join(lines)


def search_log_entries(
    conn: sqlite3.Connection,
    query: str,
    *,
    days: Optional[int] = None,
    project_id: Optional[int] = None,
    entry_type: Optional[str] = None,
    limit: Optional[int] = None,
) -> list[LogEntry]:
    if entry_type not in (None, "manual", "task"):
        raise ValueError(f"Unsupported log entry type: {entry_type}")

    joins = [
        "LEFT JOIN todos root ON root.id = log_entries.task_id",
        "LEFT JOIN project_log_entries ple ON ple.log_entry_id = log_entries.id",
        "LEFT JOIN project_todos pt ON pt.todo_id = root.id",
    ]
    where = ["log_entries_fts MATCH ?"]
    params: list[object] = []
    if days is not None:
        since = (datetime.now().date() - timedelta(days=days)).isoformat()
        where.append("log_entries.entry_date >= ?")
        params.append(since)
    if entry_type is not None:
        where.append("log_entries.entry_type = ?")
        params.append(entry_type)
    if project_id is not None:
        where.append("(ple.project_id = ? OR pt.project_id = ?)")
        params.extend([project_id, project_id])
    where.append(
        """
        (
            log_entries.entry_type = 'manual'
            OR (
                log_entries.entry_type = 'task'
                AND root.parent_id IS NULL
                AND root.status = 'done'
            )
        )
        """
    )
    result_limit = limit if limit is not None else 500
    rows = _rank_fts_rows(
        query,
        limit=result_limit,
        fetch_rows=lambda fts_query, pool_limit: conn.execute(
            f"""
            SELECT DISTINCT
                log_entries.*,
                log_entries_fts.title AS _fts_title,
                log_entries_fts.body AS _fts_body,
                log_entries_fts.entry AS _fts_entry
            FROM log_entries_fts
            JOIN log_entries ON log_entries.id = log_entries_fts.rowid
            {' '.join(joins)}
            WHERE {' AND '.join(where)}
            ORDER BY
                bm25(log_entries_fts, 5.0, 2.0, 1.0),
                log_entries.entry_date DESC,
                log_entries.created_at DESC,
                log_entries.id DESC
            LIMIT ?
            """,
            [fts_query, *params, pool_limit],
        ).fetchall(),
        fields=lambda row: (
            (row["_fts_title"] or "", 5.0),
            (row["_fts_body"] or "", 2.0),
            (row["_fts_entry"] or "", 1.0),
        ),
        relaxed_fields=lambda row: (
            (row["_fts_title"] or "", 5.0),
            (row["_fts_body"] or "", 2.0),
        ),
    )
    manual_rows = [row for row in rows if row["entry_type"] == "manual"]
    task_rows = [row for row in rows if row["entry_type"] == "task"]
    entries_by_id = {
        entry.id: entry
        for entry in (
            _manual_log_entries_from_rows(conn, manual_rows)
            + _task_log_entries_from_rows(conn, task_rows)
        )
    }
    return [
        entries_by_id[int(row["id"])]
        for row in rows
        if int(row["id"]) in entries_by_id
    ]


def list_log_entries(
    conn: sqlite3.Connection,
    *,
    days: Optional[int] = 30,
    project_id: Optional[int] = None,
    entry_type: Optional[str] = None,
    query: Optional[str] = None,
) -> list[LogEntry]:
    if entry_type not in (None, "manual", "task"):
        raise ValueError(f"Unsupported log entry type: {entry_type}")
    if query:
        return search_log_entries(
            conn,
            query,
            days=days,
            project_id=project_id,
            entry_type=entry_type,
        )

    entries: list[LogEntry] = []
    if entry_type in (None, "manual"):
        entries.extend(
            _manual_log_to_log_entry(entry)
            for entry in list_manual_log_entries(conn, project_id=project_id, days=days)
        )

    if entry_type in (None, "task"):
        entries.extend(_list_task_log_entries(conn, project_id=project_id, days=days))

    entries.sort(key=lambda entry: (entry.entry_date, entry.created_at, entry.id), reverse=True)
    return entries


def delete_todo(conn: sqlite3.Connection, todo_id: int) -> None:
    conn.execute("DELETE FROM todos WHERE id=?", (todo_id,))
