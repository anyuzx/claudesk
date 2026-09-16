from __future__ import annotations

import json
import re
import sqlite3
from datetime import date, datetime, timezone
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

from .utils import _UNSET, _rank_fts_rows


def _normalize_project_text(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    normalized = re.sub(r"\s+", " ", value).strip()
    return normalized or None


def _normalize_text_block(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    normalized = value.strip()
    return normalized or None


def _slugify_project_name(name: str) -> str:
    normalized = _normalize_project_text(name) or "project"
    slug = re.sub(r"[^a-z0-9]+", "-", normalized.casefold()).strip("-")
    return slug or "project"


def _unique_project_slug(
    conn: sqlite3.Connection,
    desired: str,
    *,
    exclude_project_id: Optional[int] = None,
) -> str:
    slug = _slugify_project_name(desired)
    candidate = slug
    suffix = 2
    while True:
        params: list[object] = [candidate]
        query = "SELECT id FROM projects WHERE slug=?"
        if exclude_project_id is not None:
            query += " AND id != ?"
            params.append(exclude_project_id)
        row = conn.execute(query, params).fetchone()
        if row is None:
            return candidate
        candidate = f"{slug}-{suffix}"
        suffix += 1


def _normalize_project_tags(tags: Optional[list[str]]) -> list[str]:
    if not tags:
        return []
    ordered: list[str] = []
    seen: set[str] = set()
    for raw_tag in tags:
        normalized = _normalize_project_text(raw_tag)
        if normalized is None:
            continue
        key = normalized.casefold()
        if key in seen:
            continue
        seen.add(key)
        ordered.append(normalized)
    return ordered


def _row_to_project(row: sqlite3.Row) -> Project:
    return Project(
        id=row["id"],
        slug=row["slug"],
        name=row["name"],
        status=ProjectStatus(row["status"]),
        description=row["description"],
        obsidian_note_path=row["obsidian_note_path"],
        tags=_normalize_project_tags(json.loads(row["tags"])),
        created_at=datetime.fromisoformat(row["created_at"]),
        updated_at=datetime.fromisoformat(row["updated_at"]),
    )


def _normalize_project_ids(values: Optional[list[int]]) -> list[int]:
    if not values:
        return []
    ordered: list[int] = []
    seen: set[int] = set()
    for value in values:
        try:
            normalized = int(value)
        except (TypeError, ValueError):
            continue
        if normalized <= 0 or normalized in seen:
            continue
        seen.add(normalized)
        ordered.append(normalized)
    return ordered


def _resolve_project_links(
    conn: sqlite3.Connection,
    *,
    project_ids: Optional[list[int]],
) -> list[int]:
    resolved_ids = _normalize_project_ids(project_ids)
    for project_id in resolved_ids:
        if get_project(conn, project_id) is None:
            raise ValueError(f"Project {project_id} not found.")
    return resolved_ids


def _touch_project(
    conn: sqlite3.Connection,
    project_id: int,
    *,
    timestamp: Optional[str] = None,
) -> None:
    now = timestamp or datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
    conn.execute("UPDATE projects SET updated_at=? WHERE id=?", (now, project_id))


def _load_project_link_map(
    conn: sqlite3.Connection,
    *,
    join_table: str,
    item_column: str,
    item_ids: list[int],
) -> dict[int, list[int]]:
    normalized_item_ids = _normalize_project_ids(item_ids)
    if not normalized_item_ids:
        return {}

    placeholders = ",".join("?" for _ in normalized_item_ids)
    rows = conn.execute(
        f"""
        SELECT {item_column} AS item_id, project_id
        FROM {join_table}
        WHERE {item_column} IN ({placeholders})
        ORDER BY created_at ASC, project_id ASC
        """,
        normalized_item_ids,
    ).fetchall()

    mapping: dict[int, list[int]] = {item_id: [] for item_id in normalized_item_ids}
    for row in rows:
        mapping[int(row["item_id"])].append(int(row["project_id"]))
    return mapping


def _replace_project_links(
    conn: sqlite3.Connection,
    *,
    join_table: str,
    item_column: str,
    item_id: int,
    project_ids: list[int],
    created_at: Optional[str] = None,
) -> None:
    normalized_ids = _normalize_project_ids(project_ids)
    conn.execute(
        f"DELETE FROM {join_table} WHERE {item_column}=?",
        (item_id,),
    )
    if not normalized_ids:
        return

    timestamp = created_at or datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
    conn.executemany(
        f"""
        INSERT INTO {join_table} (project_id, {item_column}, created_at)
        VALUES (?, ?, ?)
        """,
        [(project_id, item_id, timestamp) for project_id in normalized_ids],
    )


def _list_linked_projects(
    conn: sqlite3.Connection,
    *,
    join_table: str,
    item_column: str,
    item_id: int,
) -> list[Project]:
    rows = conn.execute(
        f"""
        SELECT p.*
        FROM {join_table} link
        JOIN projects p ON p.id = link.project_id
        WHERE link.{item_column}=?
        ORDER BY link.created_at ASC, p.name COLLATE NOCASE ASC, p.id ASC
        """,
        (item_id,),
    ).fetchall()
    return [_row_to_project(row) for row in rows]


def list_todo_projects(conn: sqlite3.Connection, todo_id: int) -> list[Project]:
    return _list_linked_projects(
        conn,
        join_table="project_todos",
        item_column="todo_id",
        item_id=todo_id,
    )


def list_chat_session_projects(conn: sqlite3.Connection, session_id: int) -> list[Project]:
    return _list_linked_projects(
        conn,
        join_table="project_chat_sessions",
        item_column="chat_session_id",
        item_id=session_id,
    )


def create_project(
    conn: sqlite3.Connection,
    *,
    name: str,
    status: ProjectStatus = ProjectStatus.ACTIVE,
    description: Optional[str] = None,
    obsidian_note_path: Optional[str] = None,
    tags: Optional[list[str]] = None,
    slug: Optional[str] = None,
    created_at: Optional[datetime] = None,
) -> Project:
    normalized_name = _normalize_project_text(name)
    if normalized_name is None:
        raise ValueError("Project name cannot be empty.")

    now = created_at or datetime.now(timezone.utc).replace(tzinfo=None)
    unique_slug = _unique_project_slug(conn, slug or normalized_name)
    cur = conn.execute(
        """
        INSERT INTO projects (slug, name, status, description, obsidian_note_path, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            unique_slug,
            normalized_name,
            status.value,
            _normalize_text_block(description),
            _normalize_project_text(obsidian_note_path),
            json.dumps(_normalize_project_tags(tags)),
            now.isoformat(),
            now.isoformat(),
        ),
    )
    project_id = int(cur.lastrowid)  # type: ignore[arg-type]
    project = get_project(conn, project_id)
    if project is None:
        raise ValueError(f"Project {project_id} not found.")
    return project


def get_project(conn: sqlite3.Connection, project_id: int) -> Optional[Project]:
    row = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
    return _row_to_project(row) if row else None


def list_projects(
    conn: sqlite3.Connection,
    *,
    include_done: bool = True,
) -> list[Project]:
    query = "SELECT * FROM projects"
    params: list[object] = []
    if not include_done:
        query += " WHERE status != ?"
        params.append(ProjectStatus.DONE.value)
    query += " ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'incubating' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END, updated_at DESC, id DESC"
    cur = conn.execute(query, params)
    return [_row_to_project(row) for row in cur.fetchall()]


def search_projects(
    conn: sqlite3.Connection,
    query: str,
    *,
    include_done: bool = True,
    project_id: Optional[int] = None,
    limit: int = 50,
) -> list[Project]:
    where = ["projects_fts MATCH ?"]
    params: list[object] = []
    if not include_done:
        where.append("p.status != ?")
        params.append(ProjectStatus.DONE.value)
    if project_id is not None:
        where.append("p.id = ?")
        params.append(project_id)
    rows = _rank_fts_rows(
        query,
        limit=limit,
        fetch_rows=lambda fts_query, pool_limit: conn.execute(
            f"""
            SELECT p.*
            FROM projects_fts
            JOIN projects p ON p.id = projects_fts.rowid
            WHERE {' AND '.join(where)}
            ORDER BY
                bm25(projects_fts, 8.0, 3.0, 2.0, 1.0, 2.0),
                CASE p.status WHEN 'active' THEN 0 WHEN 'incubating' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
                p.updated_at DESC,
                p.id DESC
            LIMIT ?
            """,
            [fts_query, *params, max(1, pool_limit)],
        ).fetchall(),
        fields=lambda row: (
            (row["name"] or "", 8.0),
            (row["description"] or "", 3.0),
            (row["tags"] or "", 2.0),
            (row["status"] or "", 1.0),
            (row["obsidian_note_path"] or "", 2.0),
        ),
    )
    return [_row_to_project(row) for row in rows]


def list_project_metrics(
    conn: sqlite3.Connection,
    *,
    include_done: bool = True,
) -> list[ProjectListMetric]:
    project_filter = "" if include_done else "WHERE projects.status != ?"
    params: list[object] = []
    if not include_done:
        params.append(ProjectStatus.DONE.value)

    rows = conn.execute(
        f"""
        SELECT
            projects.id AS project_id,
            COALESCE(milestones.milestone_count, 0) AS milestone_count,
            COALESCE(milestones.active_milestone_count, 0) AS active_milestone_count,
            COALESCE(milestones.blocked_milestone_count, 0) AS blocked_milestone_count,
            COALESCE(milestones.ready_for_review_count, 0) AS ready_for_review_count,
            COALESCE(milestones.done_milestone_count, 0) AS done_milestone_count,
            COALESCE(tasks.open_task_count, 0) AS open_task_count
        FROM projects
        LEFT JOIN (
            SELECT
                project_id,
                COUNT(*) AS milestone_count,
                SUM(CASE WHEN status != ? THEN 1 ELSE 0 END) AS active_milestone_count,
                SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS blocked_milestone_count,
                SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS ready_for_review_count,
                SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS done_milestone_count
            FROM project_milestones
            GROUP BY project_id
        ) AS milestones ON milestones.project_id = projects.id
        LEFT JOIN (
            SELECT
                project_todos.project_id AS project_id,
                COUNT(DISTINCT todos.id) AS open_task_count
            FROM project_todos
            JOIN todos ON todos.id = project_todos.todo_id
            WHERE todos.status = ?
            GROUP BY project_todos.project_id
        ) AS tasks ON tasks.project_id = projects.id
        {project_filter}
        ORDER BY CASE projects.status WHEN 'active' THEN 0 WHEN 'incubating' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
                 projects.updated_at DESC,
                 projects.id DESC
        """,
        [
            ProjectMilestoneStatus.DROPPED.value,
            ProjectMilestoneStatus.BLOCKED.value,
            ProjectMilestoneStatus.READY_FOR_REVIEW.value,
            ProjectMilestoneStatus.DONE.value,
            TodoStatus.OPEN.value,
            *params,
        ],
    ).fetchall()

    return [
        ProjectListMetric(
            project_id=int(row["project_id"]),
            milestone_count=int(row["milestone_count"]),
            active_milestone_count=int(row["active_milestone_count"]),
            blocked_milestone_count=int(row["blocked_milestone_count"]),
            ready_for_review_count=int(row["ready_for_review_count"]),
            done_milestone_count=int(row["done_milestone_count"]),
            open_task_count=int(row["open_task_count"]),
        )
        for row in rows
    ]


def update_project(
    conn: sqlite3.Connection,
    project_id: int,
    *,
    name: Optional[str] | object = _UNSET,
    status: Optional[ProjectStatus] | object = _UNSET,
    description: Optional[str] | object = _UNSET,
    obsidian_note_path: Optional[str] | object = _UNSET,
    tags: Optional[list[str]] | object = _UNSET,
) -> Project:
    existing = get_project(conn, project_id)
    if existing is None:
        raise ValueError(f"Project {project_id} not found.")

    assignments: list[str] = []
    params: list[object] = []
    new_name = existing.name

    if name is not _UNSET:
        normalized_name = _normalize_project_text(name)
        if normalized_name is None:
            raise ValueError("Project name cannot be empty.")
        assignments.append("name=?")
        params.append(normalized_name)
        new_name = normalized_name
    if status is not _UNSET:
        assignments.append("status=?")
        params.append(status.value)
    if description is not _UNSET:
        assignments.append("description=?")
        params.append(_normalize_text_block(description))
    if obsidian_note_path is not _UNSET:
        assignments.append("obsidian_note_path=?")
        params.append(_normalize_project_text(obsidian_note_path))
    if tags is not _UNSET:
        assignments.append("tags=?")
        params.append(json.dumps(_normalize_project_tags(tags)))

    if assignments:
        assignments.append("updated_at=?")
        params.append(datetime.now(timezone.utc).replace(tzinfo=None).isoformat())
        params.append(project_id)
        conn.execute(
            f"UPDATE projects SET {', '.join(assignments)} WHERE id=?",
            params,
        )

    project = get_project(conn, project_id)
    if project is None:
        raise ValueError(f"Project {project_id} not found.")
    return project


def delete_project(conn: sqlite3.Connection, project_id: int) -> None:
    cur = conn.execute("DELETE FROM projects WHERE id=?", (project_id,))
    if cur.rowcount == 0:
        raise ValueError(f"Project {project_id} not found.")


def link_project_paper(
    conn: sqlite3.Connection,
    project_id: int,
    paper_id: int,
    *,
    role: ProjectPaperRole = ProjectPaperRole.RELEVANT,
    created_at: Optional[datetime] = None,
) -> None:
    if get_project(conn, project_id) is None:
        raise ValueError(f"Project {project_id} not found.")
    from .papers import get_paper

    if get_paper(conn, paper_id) is None:
        raise ValueError(f"Paper {paper_id} not found.")
    now = created_at or datetime.now(timezone.utc).replace(tzinfo=None)
    conn.execute(
        """
        INSERT INTO project_papers (project_id, paper_id, role, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(project_id, paper_id) DO UPDATE SET role=excluded.role
        """,
        (project_id, paper_id, role.value, now.isoformat()),
    )
    conn.execute(
        "UPDATE projects SET updated_at=? WHERE id=?",
        (now.isoformat(), project_id),
    )


def unlink_project_paper(conn: sqlite3.Connection, project_id: int, paper_id: int) -> None:
    cur = conn.execute(
        "DELETE FROM project_papers WHERE project_id=? AND paper_id=?",
        (project_id, paper_id),
    )
    if cur.rowcount == 0:
        raise ValueError(f"Paper {paper_id} is not linked to project {project_id}.")
    conn.execute(
        "UPDATE projects SET updated_at=? WHERE id=?",
        (datetime.now(timezone.utc).replace(tzinfo=None).isoformat(), project_id),
    )


def list_project_papers(conn: sqlite3.Connection, project_id: int) -> list[Paper]:
    if get_project(conn, project_id) is None:
        raise ValueError(f"Project {project_id} not found.")
    cur = conn.execute(
        """
        SELECT p.*
        FROM project_papers pp
        JOIN papers p ON p.id = pp.paper_id
        WHERE pp.project_id=?
        ORDER BY pp.created_at DESC, p.relevance_score DESC NULLS LAST, p.published_date DESC
        """,
        (project_id,),
    )
    rows = cur.fetchall()
    from .papers import _hydrate_papers_with_projects

    return _hydrate_papers_with_projects(conn, rows)


def list_project_paper_roles(
    conn: sqlite3.Connection,
    project_id: int,
) -> dict[int, ProjectPaperRole]:
    if get_project(conn, project_id) is None:
        raise ValueError(f"Project {project_id} not found.")
    rows = conn.execute(
        """
        SELECT paper_id, role
        FROM project_papers
        WHERE project_id=?
        """,
        (project_id,),
    ).fetchall()
    return {
        int(row["paper_id"]): ProjectPaperRole(row["role"])
        for row in rows
    }


def list_project_notes(conn: sqlite3.Connection, project_id: int) -> list[Note]:
    if get_project(conn, project_id) is None:
        raise ValueError(f"Project {project_id} not found.")
    rows = conn.execute(
        """
        SELECT DISTINCT n.*
        FROM project_papers pp
        JOIN note_papers np ON np.paper_id = pp.paper_id
        JOIN notes n ON n.id = np.note_id
        WHERE pp.project_id=?
        ORDER BY n.updated_at DESC, n.id DESC
        """,
        (project_id,),
    ).fetchall()
    from .notes import _hydrate_notes

    return _hydrate_notes(conn, rows)


def list_project_assets(conn: sqlite3.Connection, project_id: int) -> list[tuple[int, str, PaperAsset]]:
    if get_project(conn, project_id) is None:
        raise ValueError(f"Project {project_id} not found.")
    rows = conn.execute(
        """
        SELECT pp.paper_id, p.title AS paper_title, a.*
        FROM project_papers pp
        JOIN papers p ON p.id = pp.paper_id
        JOIN paper_assets pa ON pa.paper_id = pp.paper_id
        JOIN assets a ON a.id = pa.asset_id
        WHERE pp.project_id=?
        ORDER BY a.created_at DESC, a.id DESC
        """,
        (project_id,),
    ).fetchall()
    from .assets import _row_to_paper_asset

    return [
        (int(row["paper_id"]), row["paper_title"], _row_to_paper_asset(row))
        for row in rows
    ]


def _load_milestone_todo_link_map(
    conn: sqlite3.Connection,
    milestone_ids: list[int],
) -> dict[int, list[int]]:
    normalized_ids = _normalize_project_ids(milestone_ids)
    if not normalized_ids:
        return {}

    placeholders = ",".join("?" for _ in normalized_ids)
    rows = conn.execute(
        f"""
        SELECT milestone_id, todo_id
        FROM project_milestone_todos
        WHERE milestone_id IN ({placeholders})
        ORDER BY created_at ASC, todo_id ASC
        """,
        normalized_ids,
    ).fetchall()

    mapping: dict[int, list[int]] = {milestone_id: [] for milestone_id in normalized_ids}
    for row in rows:
        mapping[int(row["milestone_id"])].append(int(row["todo_id"]))
    return mapping


def _row_to_project_milestone(
    row: sqlite3.Row,
    linked_todo_ids: Optional[list[int]] = None,
) -> ProjectMilestone:
    return ProjectMilestone(
        id=row["id"],
        project_id=row["project_id"],
        title=row["title"],
        description=row["description"],
        kind=ProjectMilestoneKind(row["kind"]),
        status=ProjectMilestoneStatus(row["status"]),
        order_index=row["order_index"],
        acceptance_criteria=row["acceptance_criteria"],
        target_date=date.fromisoformat(row["target_date"]) if row["target_date"] else None,
        completed_at=(
            datetime.fromisoformat(row["completed_at"]) if row["completed_at"] else None
        ),
        linked_todo_ids=linked_todo_ids or [],
        created_at=datetime.fromisoformat(row["created_at"]),
        updated_at=datetime.fromisoformat(row["updated_at"]),
    )


def get_project_milestone(
    conn: sqlite3.Connection,
    project_id: int,
    milestone_id: int,
) -> Optional[ProjectMilestone]:
    row = conn.execute(
        "SELECT * FROM project_milestones WHERE project_id=? AND id=?",
        (project_id, milestone_id),
    ).fetchone()
    if row is None:
        return None
    link_map = _load_milestone_todo_link_map(conn, [milestone_id])
    return _row_to_project_milestone(row, link_map.get(milestone_id, []))


def _get_project_milestone_or_raise(
    conn: sqlite3.Connection,
    project_id: int,
    milestone_id: int,
) -> ProjectMilestone:
    milestone = get_project_milestone(conn, project_id, milestone_id)
    if milestone is None:
        raise ValueError(f"Milestone {milestone_id} not found in project {project_id}.")
    return milestone


def create_project_milestone(
    conn: sqlite3.Connection,
    *,
    project_id: int,
    title: str,
    description: Optional[str] = None,
    kind: ProjectMilestoneKind = ProjectMilestoneKind.ANALYSIS,
    status: ProjectMilestoneStatus = ProjectMilestoneStatus.NOT_STARTED,
    order_index: int = 0,
    acceptance_criteria: Optional[str] = None,
    target_date: Optional[date] = None,
    created_at: Optional[datetime] = None,
) -> ProjectMilestone:
    if get_project(conn, project_id) is None:
        raise ValueError(f"Project {project_id} not found.")
    normalized_title = _normalize_project_text(title)
    if normalized_title is None:
        raise ValueError("Milestone title cannot be empty.")
    if kind is None:
        raise ValueError("Milestone kind is required.")
    if status is None:
        raise ValueError("Milestone status is required.")

    now = created_at or datetime.now(timezone.utc).replace(tzinfo=None)
    completed_at = now if status == ProjectMilestoneStatus.DONE else None
    cur = conn.execute(
        """
        INSERT INTO project_milestones (
            project_id, title, description, kind, status, order_index,
            acceptance_criteria, target_date, completed_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            project_id,
            normalized_title,
            _normalize_text_block(description),
            kind.value,
            status.value,
            int(order_index),
            _normalize_text_block(acceptance_criteria),
            target_date.isoformat() if target_date else None,
            completed_at.isoformat() if completed_at else None,
            now.isoformat(),
            now.isoformat(),
        ),
    )
    milestone_id = int(cur.lastrowid)  # type: ignore[arg-type]
    _touch_project(conn, project_id, timestamp=now.isoformat())
    milestone = get_project_milestone(conn, project_id, milestone_id)
    if milestone is None:
        raise ValueError(f"Milestone {milestone_id} not found in project {project_id}.")
    return milestone


def list_project_milestones(
    conn: sqlite3.Connection,
    project_id: int,
    *,
    status: Optional[ProjectMilestoneStatus] = None,
) -> list[ProjectMilestone]:
    if get_project(conn, project_id) is None:
        raise ValueError(f"Project {project_id} not found.")
    params: list[object] = [project_id]
    query = "SELECT * FROM project_milestones WHERE project_id=?"
    if status is not None:
        query += " AND status=?"
        params.append(status.value)
    query += " ORDER BY order_index ASC, id ASC"
    rows = conn.execute(query, params).fetchall()
    link_map = _load_milestone_todo_link_map(
        conn,
        [int(row["id"]) for row in rows],
    )
    return [
        _row_to_project_milestone(row, link_map.get(int(row["id"]), []))
        for row in rows
    ]


def update_project_milestone(
    conn: sqlite3.Connection,
    project_id: int,
    milestone_id: int,
    *,
    title: Optional[str] | object = _UNSET,
    description: Optional[str] | object = _UNSET,
    kind: Optional[ProjectMilestoneKind] | object = _UNSET,
    status: Optional[ProjectMilestoneStatus] | object = _UNSET,
    order_index: Optional[int] | object = _UNSET,
    acceptance_criteria: Optional[str] | object = _UNSET,
    target_date: Optional[date] | object = _UNSET,
) -> ProjectMilestone:
    existing = _get_project_milestone_or_raise(conn, project_id, milestone_id)
    assignments: list[str] = []
    params: list[object] = []
    now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()

    if title is not _UNSET:
        normalized_title = _normalize_project_text(title)
        if normalized_title is None:
            raise ValueError("Milestone title cannot be empty.")
        assignments.append("title=?")
        params.append(normalized_title)
    if description is not _UNSET:
        assignments.append("description=?")
        params.append(_normalize_text_block(description))
    if kind is not _UNSET:
        if kind is None:
            raise ValueError("Milestone kind is required.")
        assignments.append("kind=?")
        params.append(kind.value)
    if status is not _UNSET:
        if status is None:
            raise ValueError("Milestone status is required.")
        assignments.append("status=?")
        params.append(status.value)
        if status == ProjectMilestoneStatus.DONE:
            if existing.completed_at is None:
                assignments.append("completed_at=?")
                params.append(now)
        else:
            assignments.append("completed_at=NULL")
    if order_index is not _UNSET:
        assignments.append("order_index=?")
        params.append(int(order_index) if order_index is not None else 0)
    if acceptance_criteria is not _UNSET:
        assignments.append("acceptance_criteria=?")
        params.append(_normalize_text_block(acceptance_criteria))
    if target_date is not _UNSET:
        assignments.append("target_date=?")
        params.append(target_date.isoformat() if target_date else None)

    if assignments:
        assignments.append("updated_at=?")
        params.append(now)
        params.append(milestone_id)
        conn.execute(
            f"UPDATE project_milestones SET {', '.join(assignments)} WHERE id=?",
            params,
        )
        _touch_project(conn, existing.project_id, timestamp=now)

    updated = get_project_milestone(conn, project_id, milestone_id)
    if updated is None:
        raise ValueError(f"Milestone {milestone_id} not found in project {project_id}.")
    return updated


def delete_project_milestone(
    conn: sqlite3.Connection,
    project_id: int,
    milestone_id: int,
) -> None:
    milestone = _get_project_milestone_or_raise(conn, project_id, milestone_id)
    cur = conn.execute(
        "DELETE FROM project_milestones WHERE project_id=? AND id=?",
        (project_id, milestone_id),
    )
    if cur.rowcount == 0:
        raise ValueError(f"Milestone {milestone_id} not found in project {project_id}.")
    _touch_project(conn, milestone.project_id)


def _validate_milestone_todo_link(
    conn: sqlite3.Connection,
    milestone: ProjectMilestone,
    todo_id: int,
) -> None:
    from .tasks import get_todo

    todo = get_todo(conn, todo_id)
    if todo is None:
        raise ValueError(f"Todo {todo_id} not found.")
    if milestone.project_id not in todo.project_ids:
        raise ValueError(
            f"Todo {todo_id} is not linked to project {milestone.project_id}."
        )


def _normalize_milestone_todo_ids(todo_ids: Optional[list[int]]) -> list[int]:
    if not todo_ids:
        return []
    ordered: list[int] = []
    seen: set[int] = set()
    for value in todo_ids:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError(f"Todo id {value!r} is invalid.")
        if value <= 0:
            raise ValueError(f"Todo id {value} is invalid.")
        if value in seen:
            continue
        seen.add(value)
        ordered.append(value)
    return ordered


def _prune_milestone_todos_for_task_projects(
    conn: sqlite3.Connection,
    todo_id: int,
    project_ids: list[int],
    *,
    timestamp: Optional[str] = None,
) -> None:
    normalized_project_ids = _normalize_project_ids(project_ids)
    if normalized_project_ids:
        placeholders = ",".join("?" for _ in normalized_project_ids)
        affected_rows = conn.execute(
            f"""
            SELECT DISTINCT pm.project_id
            FROM project_milestone_todos pmt
            JOIN project_milestones pm ON pm.id = pmt.milestone_id
            WHERE pmt.todo_id=? AND pm.project_id NOT IN ({placeholders})
            """,
            [todo_id, *normalized_project_ids],
        ).fetchall()
        conn.execute(
            f"""
            DELETE FROM project_milestone_todos
            WHERE todo_id=?
              AND milestone_id IN (
                  SELECT id
                  FROM project_milestones
                  WHERE project_id NOT IN ({placeholders})
              )
            """,
            [todo_id, *normalized_project_ids],
        )
    else:
        affected_rows = conn.execute(
            """
            SELECT DISTINCT pm.project_id
            FROM project_milestone_todos pmt
            JOIN project_milestones pm ON pm.id = pmt.milestone_id
            WHERE pmt.todo_id=?
            """,
            (todo_id,),
        ).fetchall()
        conn.execute(
            "DELETE FROM project_milestone_todos WHERE todo_id=?",
            (todo_id,),
        )

    if not affected_rows:
        return
    now = timestamp or datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
    for row in affected_rows:
        _touch_project(conn, int(row["project_id"]), timestamp=now)


def link_milestone_todo(
    conn: sqlite3.Connection,
    project_id: int,
    milestone_id: int,
    todo_id: int,
    *,
    created_at: Optional[datetime] = None,
) -> None:
    milestone = _get_project_milestone_or_raise(conn, project_id, milestone_id)
    _validate_milestone_todo_link(conn, milestone, todo_id)
    now = created_at or datetime.now(timezone.utc).replace(tzinfo=None)
    conn.execute(
        """
        INSERT OR IGNORE INTO project_milestone_todos (milestone_id, todo_id, created_at)
        VALUES (?, ?, ?)
        """,
        (milestone_id, todo_id, now.isoformat()),
    )
    _touch_project(conn, milestone.project_id, timestamp=now.isoformat())


def unlink_milestone_todo(
    conn: sqlite3.Connection,
    project_id: int,
    milestone_id: int,
    todo_id: int,
) -> None:
    milestone = _get_project_milestone_or_raise(conn, project_id, milestone_id)
    cur = conn.execute(
        "DELETE FROM project_milestone_todos WHERE milestone_id=? AND todo_id=?",
        (milestone_id, todo_id),
    )
    if cur.rowcount == 0:
        raise ValueError(f"Todo {todo_id} is not linked to milestone {milestone_id}.")
    _touch_project(conn, milestone.project_id)


def replace_milestone_todos(
    conn: sqlite3.Connection,
    project_id: int,
    milestone_id: int,
    todo_ids: list[int],
) -> None:
    milestone = _get_project_milestone_or_raise(conn, project_id, milestone_id)
    normalized_ids = _normalize_milestone_todo_ids(todo_ids)
    for todo_id in normalized_ids:
        _validate_milestone_todo_link(conn, milestone, todo_id)

    now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
    conn.execute(
        "DELETE FROM project_milestone_todos WHERE milestone_id=?",
        (milestone_id,),
    )
    if normalized_ids:
        conn.executemany(
            """
            INSERT INTO project_milestone_todos (milestone_id, todo_id, created_at)
            VALUES (?, ?, ?)
            """,
            [(milestone_id, todo_id, now) for todo_id in normalized_ids],
        )
    _touch_project(conn, milestone.project_id, timestamp=now)


def list_milestone_todos(
    conn: sqlite3.Connection,
    project_id: int,
    milestone_id: int,
) -> list[Todo]:
    _get_project_milestone_or_raise(conn, project_id, milestone_id)
    from .tasks import _row_to_todo

    rows = conn.execute(
        """
        SELECT todos.*
        FROM project_milestone_todos pmt
        JOIN todos ON todos.id = pmt.todo_id
        WHERE pmt.milestone_id=?
        ORDER BY pmt.created_at ASC, todos.id ASC
        """,
        (milestone_id,),
    ).fetchall()
    project_map = _load_project_link_map(
        conn,
        join_table="project_todos",
        item_column="todo_id",
        item_ids=[int(row["id"]) for row in rows],
    )
    return [
        _row_to_todo(row, project_map.get(int(row["id"]), []))
        for row in rows
    ]


def get_project_progress_summary(
    conn: sqlite3.Connection,
    project_id: int,
) -> ProjectProgressSummary:
    if get_project(conn, project_id) is None:
        raise ValueError(f"Project {project_id} not found.")

    status_counts = {
        status: 0
        for status in ProjectMilestoneStatus
    }
    rows = conn.execute(
        """
        SELECT status, COUNT(*) AS count
        FROM project_milestones
        WHERE project_id=?
        GROUP BY status
        """,
        (project_id,),
    ).fetchall()
    for row in rows:
        status_counts[ProjectMilestoneStatus(row["status"])] = int(row["count"])

    task_rows = conn.execute(
        """
        SELECT todos.status AS status, COUNT(DISTINCT todos.id) AS count
        FROM project_milestones pm
        JOIN project_milestone_todos pmt ON pmt.milestone_id = pm.id
        JOIN todos ON todos.id = pmt.todo_id
        WHERE pm.project_id=? AND pm.status != ?
        GROUP BY todos.status
        """,
        (project_id, ProjectMilestoneStatus.DROPPED.value),
    ).fetchall()
    task_counts = {TodoStatus.OPEN: 0, TodoStatus.DONE: 0}
    for row in task_rows:
        task_counts[TodoStatus(row["status"])] = int(row["count"])

    next_row = conn.execute(
        """
        SELECT id
        FROM project_milestones
        WHERE project_id=? AND status NOT IN (?, ?)
        ORDER BY order_index ASC, id ASC
        LIMIT 1
        """,
        (
            project_id,
            ProjectMilestoneStatus.DONE.value,
            ProjectMilestoneStatus.DROPPED.value,
        ),
    ).fetchone()

    milestone_count = sum(status_counts.values())
    dropped_count = status_counts[ProjectMilestoneStatus.DROPPED]
    return ProjectProgressSummary(
        project_id=project_id,
        milestone_count=milestone_count,
        active_milestone_count=milestone_count - dropped_count,
        not_started_milestone_count=status_counts[ProjectMilestoneStatus.NOT_STARTED],
        in_progress_milestone_count=status_counts[ProjectMilestoneStatus.IN_PROGRESS],
        blocked_milestone_count=status_counts[ProjectMilestoneStatus.BLOCKED],
        ready_for_review_count=status_counts[ProjectMilestoneStatus.READY_FOR_REVIEW],
        done_milestone_count=status_counts[ProjectMilestoneStatus.DONE],
        dropped_milestone_count=dropped_count,
        open_linked_task_count=task_counts[TodoStatus.OPEN],
        done_linked_task_count=task_counts[TodoStatus.DONE],
        next_milestone_id=int(next_row["id"]) if next_row else None,
    )
