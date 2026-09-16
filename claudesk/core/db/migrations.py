from __future__ import annotations

import re
import sqlite3
from datetime import datetime, timezone
from typing import Optional

from claudesk.core.config import load_config
from claudesk.core.note_wikilinks import (
    extract_markdown_heading_keys,
    extract_wikilinks,
    normalize_heading_key,
    normalize_note_title_key,
)
from claudesk.core.paper_assets import (
    EXCALIDRAW_ASSET_MIME_TYPE,
    EXCALIDRAW_ASSET_SOURCE,
    InvalidPaperAssetFile,
    extract_excalidraw_asset_ids,
    extract_excalidraw_scene_text,
    read_managed_excalidraw_drawing_asset,
)

from .connection import SCHEMA_VERSION
from .schema import (
    _create_background_job_schema,
    _create_fts_triggers,
    _create_notes_fts,
    _create_project_milestone_schema,
    _create_relationship_indexes,
    _create_todos_fts,
    _drop_notes_fts,
    _drop_todos_and_legacy_progress_fts,
    _rebuild_fts_indexes,
    _table_columns,
    _table_exists,
)
from .utils import _parse_datetime_text


def _migration_slugify_project_name(name: str) -> str:
    normalized = re.sub(r"\s+", " ", name or "").strip() or "project"
    slug = re.sub(r"[^a-z0-9]+", "-", normalized.casefold()).strip("-")
    return slug or "project"


def _migration_unique_project_slug(conn: sqlite3.Connection, desired: str) -> str:
    slug = _migration_slugify_project_name(desired)
    candidate = slug
    suffix = 2
    while True:
        row = conn.execute("SELECT id FROM projects WHERE slug=?", (candidate,)).fetchone()
        if row is None:
            return candidate
        candidate = f"{slug}-{suffix}"
        suffix += 1


def _migration_note_title(value: object) -> str:
    normalized = re.sub(r"\s+", " ", str(value or "")).strip()
    return normalized or "Untitled note"


def _migration_note_body(value: object) -> str:
    return str(value or "")


def _migration_insert_note_for_legacy_paper(
    conn: sqlite3.Connection,
    *,
    paper_id: int,
    paper_title: object,
    paper_note: object,
    created_at: datetime,
) -> int:
    timestamp = created_at.isoformat()
    cur = conn.execute(
        """
        INSERT INTO notes (title, normalized_title, body, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            _migration_note_title(f"Note on: {paper_title}"),
            normalize_note_title_key(_migration_note_title(f"Note on: {paper_title}")),
            _migration_note_body(paper_note),
            timestamp,
            timestamp,
        ),
    )
    note_id = int(cur.lastrowid)  # type: ignore[arg-type]
    conn.execute(
        """
        INSERT INTO note_papers (note_id, paper_id, manual, mentioned, created_at, updated_at)
        VALUES (?, ?, 1, 0, ?, ?)
        """,
        (note_id, paper_id, timestamp, timestamp),
    )
    return note_id


def _migrate_rebuild_todos_fts_and_drop_legacy_progress_fts(conn: sqlite3.Connection) -> None:
    _drop_todos_and_legacy_progress_fts(conn)
    _create_todos_fts(conn)


def _migrate_project_milestones(conn: sqlite3.Connection) -> None:
    _create_project_milestone_schema(conn)


def _migrate_project_log_fts(conn: sqlite3.Connection) -> None:
    _rebuild_fts_indexes(conn)


def _migrate_background_jobs(conn: sqlite3.Connection) -> None:
    _create_background_job_schema(conn)


def _migrate_note_wikilinks(conn: sqlite3.Connection) -> None:
    columns = _table_columns(conn, "notes")
    if "normalized_title" not in columns:
        conn.execute("ALTER TABLE notes ADD COLUMN normalized_title TEXT NOT NULL DEFAULT ''")
    if "search_body" not in columns:
        conn.execute("ALTER TABLE notes ADD COLUMN search_body TEXT NOT NULL DEFAULT ''")
    conn.execute("DROP TRIGGER IF EXISTS notes_au")
    conn.execute(
        """
        UPDATE notes
        SET normalized_title = lower(title)
        WHERE normalized_title = ''
        """
    )
    rows = conn.execute("SELECT id, title FROM notes ORDER BY id ASC").fetchall()
    for row in rows:
        conn.execute(
            "UPDATE notes SET normalized_title=? WHERE id=?",
            (normalize_note_title_key(row["title"]), int(row["id"])),
        )

    conn.executescript("""
        CREATE TABLE IF NOT EXISTS note_links (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            source_note_id          INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            target_note_id          INTEGER REFERENCES notes(id) ON DELETE SET NULL,
            position                INTEGER NOT NULL DEFAULT 0,
            raw_target_title        TEXT NOT NULL,
            normalized_target_title TEXT NOT NULL,
            heading_fragment        TEXT,
            alias                   TEXT,
            status                  TEXT NOT NULL CHECK (
                status IN ('resolved', 'unresolved', 'ambiguous', 'missing_heading', 'missing_target')
            ),
            created_at              TEXT NOT NULL,
            updated_at              TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_notes_normalized_title
        ON notes(normalized_title);

        CREATE INDEX IF NOT EXISTS idx_note_links_source
        ON note_links(source_note_id, position, id);

        CREATE INDEX IF NOT EXISTS idx_note_links_target
        ON note_links(target_note_id);

        CREATE INDEX IF NOT EXISTS idx_note_links_normalized_target
        ON note_links(normalized_target_title);
    """)
    _backfill_note_search_body(conn)
    _drop_notes_fts(conn)
    _create_notes_fts(conn)
    _backfill_note_wikilinks(conn)


def _backfill_note_wikilinks(conn: sqlite3.Connection) -> None:
    notes = conn.execute("SELECT id, title, normalized_title, body, created_at FROM notes ORDER BY id ASC").fetchall()
    candidates: dict[str, list[sqlite3.Row]] = {}
    notes_by_id: dict[int, sqlite3.Row] = {}
    heading_keys: dict[int, set[str]] = {}
    for row in notes:
        note_id = int(row["id"])
        title_key = row["normalized_title"] or normalize_note_title_key(row["title"])
        candidates.setdefault(title_key, []).append(row)
        notes_by_id[note_id] = row
        heading_keys[note_id] = extract_markdown_heading_keys(row["body"])

    conn.execute("DELETE FROM note_links")
    for source in notes:
        source_note_id = int(source["id"])
        timestamp = source["created_at"] or datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
        for position, match in enumerate(extract_wikilinks(source["body"])):
            target_key = normalize_note_title_key(match.target_title)
            target_note_id: int | None = None
            raw_target_title = match.target_title
            if match.target_note_id is not None:
                if match.target_note_id == source_note_id:
                    continue
                target_row = notes_by_id.get(match.target_note_id)
                if target_row is None:
                    status = "missing_target"
                else:
                    target_note_id = int(target_row["id"])
                    raw_target_title = target_row["title"]
                    target_key = target_row["normalized_title"] or normalize_note_title_key(target_row["title"])
                    if match.heading_fragment and normalize_heading_key(match.heading_fragment) not in heading_keys[target_note_id]:
                        status = "missing_heading"
                    else:
                        status = "resolved"
            else:
                original_target_rows = candidates.get(target_key, [])
                target_rows = [
                    row for row in candidates.get(target_key, [])
                    if int(row["id"]) != source_note_id
                ]
                if original_target_rows and not target_rows:
                    continue
                if not target_rows:
                    status = "unresolved"
                elif len(target_rows) > 1:
                    status = "ambiguous"
                else:
                    target_note_id = int(target_rows[0]["id"])
                    raw_target_title = target_rows[0]["title"]
                    target_key = target_rows[0]["normalized_title"] or normalize_note_title_key(target_rows[0]["title"])
                    if match.heading_fragment and normalize_heading_key(match.heading_fragment) not in heading_keys[target_note_id]:
                        status = "missing_heading"
                    else:
                        status = "resolved"
            conn.execute(
                """
                INSERT INTO note_links (
                    source_note_id, target_note_id, position, raw_target_title,
                    normalized_target_title, heading_fragment, alias, status,
                    created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    source_note_id,
                    target_note_id,
                    position,
                    raw_target_title,
                    target_key,
                    match.heading_fragment,
                    match.alias,
                    status,
                    timestamp,
                    timestamp,
                ),
            )


def _note_links_allow_missing_target_status(conn: sqlite3.Connection) -> bool:
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='note_links'"
    ).fetchone()
    sql = row["sql"] if row is not None else ""
    return "missing_target" in (sql or "")


def _migrate_note_link_missing_target_status(conn: sqlite3.Connection) -> None:
    if not _table_exists(conn, "note_links"):
        return
    if _note_links_allow_missing_target_status(conn):
        return
    conn.executescript("""
        ALTER TABLE note_links RENAME TO note_links_old;

        CREATE TABLE note_links (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            source_note_id          INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            target_note_id          INTEGER REFERENCES notes(id) ON DELETE SET NULL,
            position                INTEGER NOT NULL DEFAULT 0,
            raw_target_title        TEXT NOT NULL,
            normalized_target_title TEXT NOT NULL,
            heading_fragment        TEXT,
            alias                   TEXT,
            status                  TEXT NOT NULL CHECK (
                status IN ('resolved', 'unresolved', 'ambiguous', 'missing_heading', 'missing_target')
            ),
            created_at              TEXT NOT NULL,
            updated_at              TEXT NOT NULL
        );

        INSERT INTO note_links (
            id, source_note_id, target_note_id, position, raw_target_title,
            normalized_target_title, heading_fragment, alias, status,
            created_at, updated_at
        )
        SELECT
            id, source_note_id, target_note_id, position, raw_target_title,
            normalized_target_title, heading_fragment, alias, status,
            created_at, updated_at
        FROM note_links_old;

        DROP TABLE note_links_old;

        CREATE INDEX IF NOT EXISTS idx_note_links_source
        ON note_links(source_note_id, position, id);

        CREATE INDEX IF NOT EXISTS idx_note_links_target
        ON note_links(target_note_id);

        CREATE INDEX IF NOT EXISTS idx_note_links_normalized_target
        ON note_links(normalized_target_title);
    """)


def _drawing_text_for_note_body(conn: sqlite3.Connection, body: str) -> str:
    asset_ids = extract_excalidraw_asset_ids(body)
    if not asset_ids:
        return ""
    placeholders = ",".join("?" for _ in asset_ids)
    rows = conn.execute(
        f"""
        SELECT id, managed_path
        FROM assets
        WHERE id IN ({placeholders})
          AND source=?
          AND mime_type=?
          AND managed_path LIKE 'drawings/%'
        """,
        (*asset_ids, EXCALIDRAW_ASSET_SOURCE, EXCALIDRAW_ASSET_MIME_TYPE),
    ).fetchall()
    paths_by_id = {int(row["id"]): row["managed_path"] for row in rows}
    texts: list[str] = []
    for asset_id in asset_ids:
        managed_path = paths_by_id.get(asset_id)
        if not managed_path:
            continue
        try:
            scene = read_managed_excalidraw_drawing_asset(managed_path)
        except InvalidPaperAssetFile:
            continue
        text = extract_excalidraw_scene_text(scene)
        if text:
            texts.append(text)
    return "\n\n".join(texts)


def _note_search_body_for_migration(conn: sqlite3.Connection, body: str) -> str:
    canonical = _migration_note_body(body)
    drawing_text = _drawing_text_for_note_body(conn, canonical)
    return "\n\n".join(part for part in (canonical, drawing_text) if part)


def _backfill_note_search_body(conn: sqlite3.Connection) -> None:
    rows = conn.execute("SELECT id, body FROM notes ORDER BY id ASC").fetchall()
    for row in rows:
        conn.execute(
            "UPDATE notes SET search_body=? WHERE id=?",
            (_note_search_body_for_migration(conn, row["body"]), int(row["id"])),
        )


def _migrate_note_search_body(conn: sqlite3.Connection) -> None:
    if "search_body" not in _table_columns(conn, "notes"):
        conn.execute("ALTER TABLE notes ADD COLUMN search_body TEXT NOT NULL DEFAULT ''")
    _backfill_note_search_body(conn)
    _drop_notes_fts(conn)
    _create_notes_fts(conn)


def _repair_note_schema_drift(conn: sqlite3.Connection) -> None:
    columns = _table_columns(conn, "notes")
    if "normalized_title" not in columns or not _table_exists(conn, "note_links"):
        _migrate_note_wikilinks(conn)
        columns = _table_columns(conn, "notes")
    if "search_body" not in columns:
        _migrate_note_search_body(conn)
    _migrate_note_link_missing_target_status(conn)


def _migrate_canonical_project_storage(conn: sqlite3.Connection) -> None:
    _create_project_milestone_schema(conn)
    _create_relationship_indexes(conn)

    todo_columns = _table_columns(conn, "todos")
    progress_columns = _table_columns(conn, "progress_log")
    chat_columns = _table_columns(conn, "chat_sessions")
    legacy_columns = {
        "todos": {"project_id", "project_tag"} & todo_columns,
        "progress_log": {"project_id", "project_tag"} & progress_columns,
        "chat_sessions": {"project_id"} & chat_columns,
    }
    if not any(legacy_columns.values()):
        return

    now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()

    def linked_project_id_for_tag(raw_tag: object) -> Optional[int]:
        if not isinstance(raw_tag, str):
            return None
        tag = raw_tag.strip()
        if not tag:
            return None
        existing = conn.execute(
            "SELECT id FROM projects WHERE lower(name)=? ORDER BY id ASC LIMIT 1",
            (tag.casefold(),),
        ).fetchone()
        if existing is not None:
            return int(existing["id"])
        cur = conn.execute(
            """
            INSERT INTO projects (slug, name, status, description, obsidian_note_path, tags, created_at, updated_at)
            VALUES (?, ?, ?, NULL, NULL, '[]', ?, ?)
            """,
            (
                _migration_unique_project_slug(conn, tag),
                tag,
                "active",
                now,
                now,
            ),
        )
        return int(cur.lastrowid)  # type: ignore[arg-type]

    tag_to_project_id: dict[str, int] = {}
    for table_name, columns in (
        ("todos", todo_columns),
        ("progress_log", progress_columns),
    ):
        if "project_tag" not in columns:
            continue
        rows = conn.execute(
            f"""
            SELECT DISTINCT trim(project_tag) AS tag
            FROM {table_name}
            WHERE project_tag IS NOT NULL AND trim(project_tag) != ''
            ORDER BY lower(trim(project_tag)), trim(project_tag)
            """
        ).fetchall()
        for row in rows:
            tag = row["tag"]
            if tag not in tag_to_project_id:
                project_id = linked_project_id_for_tag(tag)
                if project_id is not None:
                    tag_to_project_id[tag] = project_id

    for table_name, columns, join_table, item_column in (
        ("todos", todo_columns, "project_todos", "todo_id"),
        ("progress_log", progress_columns, "project_progress_entries", "progress_entry_id"),
    ):
        if "project_tag" in columns:
            rows = conn.execute(
                f"""
                SELECT id, trim(project_tag) AS tag, created_at
                FROM {table_name}
                WHERE project_tag IS NOT NULL AND trim(project_tag) != ''
                ORDER BY id ASC
                """
            ).fetchall()
            for row in rows:
                project_id = tag_to_project_id.get(row["tag"])
                if project_id is None:
                    continue
                conn.execute(
                    f"""
                    INSERT OR IGNORE INTO {join_table} (project_id, {item_column}, created_at)
                    VALUES (?, ?, ?)
                    """,
                    (project_id, int(row["id"]), row["created_at"] or now),
                )
        if "project_id" in columns:
            conn.execute(
                f"""
                INSERT OR IGNORE INTO {join_table} (project_id, {item_column}, created_at)
                SELECT source.project_id, source.id, COALESCE(source.created_at, ?)
                FROM {table_name} source
                JOIN projects p ON p.id = source.project_id
                WHERE source.project_id IS NOT NULL
                """,
                (now,),
            )

    if "project_id" in chat_columns:
        conn.execute(
            """
            INSERT OR IGNORE INTO project_chat_sessions (project_id, chat_session_id, created_at)
            SELECT source.project_id, source.id, COALESCE(source.created_at, ?)
            FROM chat_sessions source
            JOIN projects p ON p.id = source.project_id
            WHERE source.project_id IS NOT NULL
            """,
            (now,),
        )

    def sql_value(columns: set[str], column_name: str, fallback: str) -> str:
        return column_name if column_name in columns else fallback

    def rebuild_todos() -> None:
        conn.execute(
            """
            CREATE TABLE todos_new (
                id                      INTEGER PRIMARY KEY AUTOINCREMENT,
                text                    TEXT NOT NULL,
                status                  TEXT NOT NULL DEFAULT 'open',
                priority                TEXT NOT NULL DEFAULT 'medium',
                due_date                TEXT,
                created_at              TEXT NOT NULL,
                completed_at            TEXT,
                parent_id               INTEGER REFERENCES todos(id) ON DELETE CASCADE,
                sort_order              INTEGER NOT NULL DEFAULT 0,
                updated_at              TEXT,
                completion_log_entry_id INTEGER
            )
            """
        )
        conn.execute(
            f"""
            INSERT INTO todos_new (
                id, text, status, priority, due_date, created_at, completed_at,
                parent_id, sort_order, updated_at, completion_log_entry_id
            )
            SELECT
                id,
                text,
                COALESCE(NULLIF({sql_value(todo_columns, "status", "'open'")}, ''), 'open'),
                COALESCE(NULLIF({sql_value(todo_columns, "priority", "'medium'")}, ''), 'medium'),
                {sql_value(todo_columns, "due_date", "NULL")},
                COALESCE({sql_value(todo_columns, "created_at", "NULL")}, ?),
                {sql_value(todo_columns, "completed_at", "NULL")},
                {sql_value(todo_columns, "parent_id", "NULL")},
                COALESCE({sql_value(todo_columns, "sort_order", "0")}, 0),
                COALESCE({sql_value(todo_columns, "updated_at", "NULL")}, {sql_value(todo_columns, "created_at", "NULL")}),
                {sql_value(todo_columns, "completion_log_entry_id", "NULL")}
            FROM todos
            """,
            (now,),
        )
        conn.execute("DROP TABLE todos")
        conn.execute("ALTER TABLE todos_new RENAME TO todos")

    def rebuild_progress_log() -> None:
        conn.execute(
            """
            CREATE TABLE progress_log_new (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                entry_date       TEXT NOT NULL,
                entry            TEXT NOT NULL,
                linked_paper_ids TEXT NOT NULL DEFAULT '[]',
                created_at       TEXT NOT NULL
            )
            """
        )
        conn.execute(
            f"""
            INSERT INTO progress_log_new (id, entry_date, entry, linked_paper_ids, created_at)
            SELECT
                id,
                COALESCE({sql_value(progress_columns, "entry_date", "NULL")}, date('now')),
                entry,
                COALESCE({sql_value(progress_columns, "linked_paper_ids", "'[]'")}, '[]'),
                COALESCE({sql_value(progress_columns, "created_at", "NULL")}, ?)
            FROM progress_log
            """,
            (now,),
        )
        conn.execute("DROP TABLE progress_log")
        conn.execute("ALTER TABLE progress_log_new RENAME TO progress_log")

    def rebuild_chat_sessions() -> None:
        conn.execute(
            """
            CREATE TABLE chat_sessions_new (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                title               TEXT NOT NULL DEFAULT '',
                created_at          TEXT NOT NULL,
                updated_at          TEXT NOT NULL,
                linked_paper_ids    TEXT NOT NULL DEFAULT '[]',
                linked_todo_ids     TEXT NOT NULL DEFAULT '[]',
                linked_progress_ids TEXT NOT NULL DEFAULT '[]',
                provider_state      TEXT NOT NULL DEFAULT '{}'
            )
            """
        )
        conn.execute(
            f"""
            INSERT INTO chat_sessions_new (
                id, title, created_at, updated_at, linked_paper_ids,
                linked_todo_ids, linked_progress_ids, provider_state
            )
            SELECT
                id,
                COALESCE({sql_value(chat_columns, "title", "''")}, ''),
                COALESCE({sql_value(chat_columns, "created_at", "NULL")}, ?),
                COALESCE({sql_value(chat_columns, "updated_at", "NULL")}, {sql_value(chat_columns, "created_at", "NULL")}, ?),
                COALESCE({sql_value(chat_columns, "linked_paper_ids", "'[]'")}, '[]'),
                COALESCE({sql_value(chat_columns, "linked_todo_ids", "'[]'")}, '[]'),
                COALESCE({sql_value(chat_columns, "linked_progress_ids", "'[]'")}, '[]'),
                COALESCE({sql_value(chat_columns, "provider_state", "'{}'")}, '{{}}')
            FROM chat_sessions
            """,
            (now, now),
        )
        conn.execute("DROP TABLE chat_sessions")
        conn.execute("ALTER TABLE chat_sessions_new RENAME TO chat_sessions")

    rebuilds_task_or_log = bool(legacy_columns["todos"] or legacy_columns["progress_log"])
    conn.commit()
    conn.execute("PRAGMA foreign_keys=OFF")
    try:
        if rebuilds_task_or_log:
            _drop_todos_and_legacy_progress_fts(conn)
        if legacy_columns["todos"]:
            rebuild_todos()
        if legacy_columns["progress_log"]:
            rebuild_progress_log()
        if legacy_columns["chat_sessions"]:
            rebuild_chat_sessions()
        if rebuilds_task_or_log:
            _create_todos_fts(conn)
        _create_relationship_indexes(conn)
        conn.commit()
    finally:
        conn.execute("PRAGMA foreign_keys=ON")
    violations = conn.execute("PRAGMA foreign_key_check").fetchall()
    if violations:
        raise RuntimeError("Project storage migration left foreign key violations.")


def _migrate(conn: sqlite3.Connection) -> None:
    cur = conn.execute(
        "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
    )
    row = cur.fetchone()
    current = row[0] if row else 0
    if current < 2:
        _rebuild_fts_indexes(conn)
    if current < 3:
        _migrate_paper_state(conn)
    if current < 4:
        _migrate_paper_notes(conn)
    if current < 5:
        _migrate_paper_to_read(conn)
    if current < 7:
        _migrate_paper_journal_abbrev(conn)
    if current < 8:
        _migrate_project_layer(conn)
    if current < 9:
        _migrate_multi_project_links(conn)
    if current < 10:
        _migrate_task_subtasks(conn)
    if current < 11:
        _migrate_chat_provider_state(conn)
    if current < 13:
        _migrate_paper_score_rubric(conn)
    if current < 14:
        _migrate_remove_paper_justification(conn)
    if current < 15:
        _migrate_first_class_notes(conn)
    if current < 16:
        _migrate_paper_assets(conn)
    if current < 17:
        _migrate_asset_display_name(conn)
    if current < 18:
        _migrate_pdf_asset_cache(conn)
    if current < 19:
        _migrate_structured_pdf_parse(conn)
    if current < 20:
        _migrate_digest_runs(conn)
    if current < 21:
        _migrate_chat_message_context_items(conn)
    if current < 22:
        _migrate_chat_message_trace_entries(conn)
    if current < 24:
        _migrate_chat_attachments(conn)
    if current < 25:
        _migrate_rebuild_todos_fts_and_drop_legacy_progress_fts(conn)
    if current < 26:
        _migrate_project_milestones(conn)
    if current < 27:
        _migrate_canonical_project_storage(conn)
    if current < 28:
        _migrate_paper_to_read_at(conn)
    if current < 29:
        _migrate_task_title_description(conn)
    if current < 30:
        _migrate_digest_run_summary_fields(conn)
    if current < 31:
        _migrate_remove_task_completion_log_coupling(conn)
    if current < 32:
        _migrate_first_class_log_entries(conn)
    if current < 33:
        _migrate_note_assets(conn)
    if current < 34:
        _migrate_note_assets(conn)
    if current < 35:
        _migrate_project_log_fts(conn)
    if current < 36:
        _migrate_background_jobs(conn)
    if current < 37:
        _migrate_note_wikilinks(conn)
    if current < 38:
        _migrate_note_search_body(conn)
    if current < 41:
        _migrate_note_link_missing_target_status(conn)
    if current < 42:
        _migrate_chat_runtime_settings(conn)
    _repair_note_schema_drift(conn)
    if current < SCHEMA_VERSION:
        conn.execute(
            "INSERT OR REPLACE INTO schema_version (version) VALUES (?)",
            (SCHEMA_VERSION,),
        )


def _migrate_chat_runtime_settings(conn: sqlite3.Connection) -> None:
    if "runtime_settings" not in _table_columns(conn, "chat_sessions"):
        runtime_settings = load_config().chat.runtime_settings().model_dump_json()
        quoted_settings = conn.execute("SELECT quote(?)", (runtime_settings,)).fetchone()[0]
        conn.execute(
            "ALTER TABLE chat_sessions ADD COLUMN runtime_settings "
            f"TEXT NOT NULL DEFAULT {quoted_settings}"
        )
    conn.execute("UPDATE chat_sessions SET provider_state='{}'")


def _migrate_paper_state(conn: sqlite3.Connection) -> None:
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(papers)").fetchall()
    }
    needs_saved = "is_saved" not in columns
    needs_read = "is_read" not in columns
    if not needs_saved and not needs_read:
        return

    conn.executescript("""
        DROP TRIGGER IF EXISTS papers_ai;
        DROP TRIGGER IF EXISTS papers_ad;
        DROP TRIGGER IF EXISTS papers_au;
        DROP TABLE IF EXISTS papers_fts;
    """)

    if needs_saved:
        conn.execute(
            "ALTER TABLE papers ADD COLUMN is_saved INTEGER NOT NULL DEFAULT 0"
        )
    if needs_read:
        conn.execute(
            "ALTER TABLE papers ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0"
        )

    conn.execute(
        """
        UPDATE papers
        SET
            is_saved = CASE WHEN status = 'saved' THEN 1 ELSE 0 END,
            is_read = CASE WHEN status = 'read' THEN 1 ELSE 0 END
        """
    )

    conn.execute(
        """
        CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
            title,
            abstract,
            authors,
            content='papers',
            content_rowid='id',
            tokenize='porter unicode61'
        )
        """
    )
    _create_fts_triggers(conn)
    conn.execute("INSERT INTO papers_fts(papers_fts) VALUES ('rebuild')")


def _migrate_paper_notes(conn: sqlite3.Connection) -> None:
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(papers)").fetchall()
    }
    if "note" not in columns:
        conn.execute("ALTER TABLE papers ADD COLUMN note TEXT")

    conn.executescript("""
        DROP TRIGGER IF EXISTS papers_ai;
        DROP TRIGGER IF EXISTS papers_ad;
        DROP TRIGGER IF EXISTS papers_au;
        DROP TABLE IF EXISTS papers_fts;
    """)
    conn.execute(
        """
        CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
            title,
            abstract,
            authors,
            content='papers',
            content_rowid='id',
            tokenize='porter unicode61'
        )
        """
    )
    _create_fts_triggers(conn)
    conn.execute("INSERT INTO papers_fts(papers_fts) VALUES ('rebuild')")


def _migrate_paper_to_read(conn: sqlite3.Connection) -> None:
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(papers)").fetchall()
    }
    if "is_to_read" not in columns:
        conn.execute(
            "ALTER TABLE papers ADD COLUMN is_to_read INTEGER NOT NULL DEFAULT 0"
        )


def _migrate_paper_to_read_at(conn: sqlite3.Connection) -> None:
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(papers)").fetchall()
    }
    conn.executescript("""
        DROP TRIGGER IF EXISTS papers_ai;
        DROP TRIGGER IF EXISTS papers_ad;
        DROP TRIGGER IF EXISTS papers_au;
    """)
    if "to_read_at" not in columns:
        conn.execute("ALTER TABLE papers ADD COLUMN to_read_at TEXT")
    conn.execute(
        """
        UPDATE papers
        SET to_read_at = fetched_at
        WHERE is_to_read = 1
          AND status != 'dismissed'
          AND (to_read_at IS NULL OR trim(to_read_at) = '')
        """
    )
    _create_fts_triggers(conn)


def _migrate_paper_journal_abbrev(conn: sqlite3.Connection) -> None:
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(papers)").fetchall()
    }
    if "journal_abbrev" not in columns:
        conn.execute("ALTER TABLE papers ADD COLUMN journal_abbrev TEXT")


def _migrate_paper_score_rubric(conn: sqlite3.Connection) -> None:
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(papers)").fetchall()
    }
    if "score_rubric" not in columns:
        conn.execute("ALTER TABLE papers ADD COLUMN score_rubric TEXT")


def _migrate_digest_runs(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS digest_runs (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at        TEXT NOT NULL,
            days_back         INTEGER NOT NULL DEFAULT 0,
            sources_json      TEXT NOT NULL DEFAULT '[]',
            total_fetched     INTEGER NOT NULL DEFAULT 0,
            total_after_dedup INTEGER NOT NULL DEFAULT 0,
            total_in_digest   INTEGER NOT NULL DEFAULT 0,
            total_new_papers  INTEGER NOT NULL DEFAULT 0
        );
    """)
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(papers)").fetchall()
    }
    if "new_digest_run_id" not in columns:
        conn.execute(
            "ALTER TABLE papers ADD COLUMN new_digest_run_id INTEGER "
            "REFERENCES digest_runs(id) ON DELETE SET NULL"
        )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_papers_new_digest_run_id "
        "ON papers(new_digest_run_id)"
    )


def _migrate_digest_run_summary_fields(conn: sqlite3.Connection) -> None:
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(digest_runs)").fetchall()
    }
    if "days_back" not in columns:
        conn.execute(
            "ALTER TABLE digest_runs ADD COLUMN days_back INTEGER NOT NULL DEFAULT 0"
        )
    if "sources_json" not in columns:
        conn.execute(
            "ALTER TABLE digest_runs ADD COLUMN sources_json TEXT NOT NULL DEFAULT '[]'"
        )
    if "total_new_papers" not in columns:
        conn.execute(
            "ALTER TABLE digest_runs ADD COLUMN total_new_papers INTEGER NOT NULL DEFAULT 0"
        )
        paper_columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(papers)").fetchall()
        }
        if "new_digest_run_id" in paper_columns:
            conn.execute(
                """
                UPDATE digest_runs
                SET total_new_papers = (
                    SELECT COUNT(*)
                    FROM papers
                    WHERE papers.new_digest_run_id = digest_runs.id
                )
                """
            )


def _drop_papers_fts(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        DROP TRIGGER IF EXISTS papers_ai;
        DROP TRIGGER IF EXISTS papers_ad;
        DROP TRIGGER IF EXISTS papers_au;
        DROP TABLE IF EXISTS papers_fts;
    """)


def _create_papers_fts(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
            title,
            abstract,
            authors,
            content='papers',
            content_rowid='id',
            tokenize='porter unicode61'
        )
        """
    )
    _create_fts_triggers(conn)
    conn.execute("INSERT INTO papers_fts(papers_fts) VALUES ('rebuild')")


def _migrate_remove_paper_justification(conn: sqlite3.Connection) -> None:
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(papers)").fetchall()
    }
    _drop_papers_fts(conn)
    if "justification" in columns:
        conn.execute("ALTER TABLE papers DROP COLUMN justification")
    _create_papers_fts(conn)


def _migrate_first_class_notes(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS notes (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            title      TEXT NOT NULL,
            normalized_title TEXT NOT NULL DEFAULT '',
            body       TEXT NOT NULL DEFAULT '',
            search_body TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS note_papers (
            note_id    INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            paper_id   INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
            manual     INTEGER NOT NULL DEFAULT 0,
            mentioned  INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (note_id, paper_id)
        );

        CREATE INDEX IF NOT EXISTS idx_note_papers_paper_id
        ON note_papers(paper_id);

        CREATE INDEX IF NOT EXISTS idx_notes_updated_at
        ON notes(updated_at DESC, id DESC);

        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
            title,
            search_body,
            content='notes',
            content_rowid='id',
            tokenize='porter unicode61'
        );
    """)
    _create_fts_triggers(conn)

    paper_columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(papers)").fetchall()
    }
    if "note" in paper_columns:
        rows = conn.execute(
            """
            SELECT id, title, note, fetched_at
            FROM papers
            WHERE note IS NOT NULL AND trim(note) != ''
            ORDER BY id ASC
            """
        ).fetchall()
        for row in rows:
            created_at = _parse_datetime_text(row["fetched_at"]) or datetime.now(timezone.utc).replace(tzinfo=None)
            _migration_insert_note_for_legacy_paper(
                conn,
                paper_id=int(row["id"]),
                paper_title=row["title"],
                paper_note=row["note"],
                created_at=created_at,
            )
        conn.execute("UPDATE papers SET note=NULL WHERE note IS NOT NULL AND trim(note) != ''")

    _drop_papers_fts(conn)
    _create_papers_fts(conn)
    _backfill_note_search_body(conn)
    _drop_notes_fts(conn)
    _create_notes_fts(conn)


def _migrate_paper_assets(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS assets (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            kind              TEXT NOT NULL CHECK (kind IN ('pdf', 'markdown', 'text', 'html', 'attachment')),
            source            TEXT NOT NULL DEFAULT 'manual',
            managed_path      TEXT,
            original_filename TEXT NOT NULL,
            display_name      TEXT NOT NULL,
            mime_type         TEXT NOT NULL DEFAULT '',
            size_bytes        INTEGER NOT NULL DEFAULT 0,
            content_hash      TEXT NOT NULL DEFAULT '',
            parse_status      TEXT NOT NULL DEFAULT 'not_parsed'
                              CHECK (parse_status IN ('not_parsed', 'queued', 'parsed', 'failed')),
            parser_name       TEXT,
            parser_version    TEXT,
            source_asset_id   INTEGER REFERENCES assets(id) ON DELETE SET NULL,
            parsed_text       TEXT,
            parse_error       TEXT,
            parsed_at         TEXT,
            created_at        TEXT NOT NULL,
            updated_at        TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS paper_assets (
            paper_id   INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
            asset_id   INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            PRIMARY KEY (paper_id, asset_id)
        );

        CREATE INDEX IF NOT EXISTS idx_assets_kind
        ON assets(kind);

        CREATE INDEX IF NOT EXISTS idx_assets_content_hash
        ON assets(content_hash);

        CREATE INDEX IF NOT EXISTS idx_paper_assets_asset_id
        ON paper_assets(asset_id);
    """)
    _migrate_asset_display_name(conn)


def _migrate_chat_attachments(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS chat_attachments (
            session_id      INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
            asset_id        INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            user_message_id INTEGER REFERENCES chat_messages(id) ON DELETE CASCADE,
            context_kind    TEXT NOT NULL CHECK (context_kind IN ('clipboard_text', 'screenshot', 'file')),
            created_at      TEXT NOT NULL,
            PRIMARY KEY (session_id, asset_id)
        );

        CREATE INDEX IF NOT EXISTS idx_chat_attachments_session_message
        ON chat_attachments(session_id, user_message_id, asset_id);
    """)


def _migrate_note_assets(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS note_assets (
            note_id    INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            asset_id   INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            status     TEXT NOT NULL DEFAULT 'committed' CHECK(status IN ('staged', 'committed')),
            created_at TEXT NOT NULL,
            PRIMARY KEY (note_id, asset_id)
        );

        CREATE INDEX IF NOT EXISTS idx_note_assets_asset_id
        ON note_assets(asset_id);
    """)
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(note_assets)").fetchall()
    }
    if "status" not in columns:
        conn.execute(
            "ALTER TABLE note_assets ADD COLUMN status TEXT NOT NULL DEFAULT 'committed'"
        )


def _migrate_asset_display_name(conn: sqlite3.Connection) -> None:
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(assets)").fetchall()
    }
    if "display_name" not in columns:
        conn.execute("ALTER TABLE assets ADD COLUMN display_name TEXT NOT NULL DEFAULT ''")
    conn.execute(
        """
        UPDATE assets
        SET display_name=original_filename
        WHERE trim(display_name) = ''
        """
    )


def _migrate_pdf_asset_cache(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS asset_pdf_pages (
            asset_id           INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            page_number        INTEGER NOT NULL CHECK (page_number >= 1),
            text               TEXT NOT NULL DEFAULT '',
            page_width         REAL NOT NULL DEFAULT 0,
            page_height        REAL NOT NULL DEFAULT 0,
            image_managed_path TEXT,
            image_width        INTEGER NOT NULL DEFAULT 0,
            image_height       INTEGER NOT NULL DEFAULT 0,
            render_dpi         INTEGER NOT NULL DEFAULT 0,
            created_at         TEXT NOT NULL,
            updated_at         TEXT NOT NULL,
            PRIMARY KEY (asset_id, page_number)
        );

        CREATE TABLE IF NOT EXISTS asset_text_chunks (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            asset_id    INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            chunk_index INTEGER NOT NULL,
            page_number INTEGER NOT NULL CHECK (page_number >= 1),
            text        TEXT NOT NULL,
            char_count  INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL,
            UNIQUE(asset_id, chunk_index)
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS asset_text_chunks_fts USING fts5(
            text,
            content='asset_text_chunks',
            content_rowid='id',
            tokenize='porter unicode61'
        );

        CREATE TRIGGER IF NOT EXISTS asset_text_chunks_ai
        AFTER INSERT ON asset_text_chunks BEGIN
            INSERT INTO asset_text_chunks_fts(rowid, text)
            VALUES (new.id, new.text);
        END;

        CREATE TRIGGER IF NOT EXISTS asset_text_chunks_ad
        AFTER DELETE ON asset_text_chunks BEGIN
            INSERT INTO asset_text_chunks_fts(asset_text_chunks_fts, rowid, text)
            VALUES ('delete', old.id, old.text);
        END;

        CREATE TRIGGER IF NOT EXISTS asset_text_chunks_au
        AFTER UPDATE ON asset_text_chunks BEGIN
            INSERT INTO asset_text_chunks_fts(asset_text_chunks_fts, rowid, text)
            VALUES ('delete', old.id, old.text);
            INSERT INTO asset_text_chunks_fts(rowid, text)
            VALUES (new.id, new.text);
        END;

        CREATE INDEX IF NOT EXISTS idx_asset_text_chunks_asset_page
        ON asset_text_chunks(asset_id, page_number, chunk_index);
    """)


def _migrate_structured_pdf_parse(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS asset_parse_artifacts (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            asset_id       INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            artifact_kind  TEXT NOT NULL,
            parser_name    TEXT NOT NULL,
            parser_version TEXT NOT NULL,
            managed_path   TEXT,
            mime_type      TEXT NOT NULL DEFAULT '',
            size_bytes     INTEGER NOT NULL DEFAULT 0,
            content_hash   TEXT NOT NULL DEFAULT '',
            created_at     TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS asset_document_blocks (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            asset_id           INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            block_index        INTEGER NOT NULL,
            page_number        INTEGER NOT NULL CHECK (page_number >= 1),
            block_type         TEXT NOT NULL DEFAULT 'paragraph',
            section_path       TEXT NOT NULL DEFAULT '[]',
            text               TEXT NOT NULL DEFAULT '',
            bbox_json          TEXT,
            image_managed_path TEXT,
            metadata_json      TEXT NOT NULL DEFAULT '{}',
            created_at         TEXT NOT NULL,
            updated_at         TEXT NOT NULL,
            UNIQUE(asset_id, block_index)
        );

        CREATE INDEX IF NOT EXISTS idx_asset_document_blocks_asset_page
        ON asset_document_blocks(asset_id, page_number, block_index);

        CREATE INDEX IF NOT EXISTS idx_asset_parse_artifacts_asset_kind
        ON asset_parse_artifacts(asset_id, artifact_kind);
    """)
    chunk_columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(asset_text_chunks)").fetchall()
    }
    if "block_type" not in chunk_columns:
        conn.execute(
            "ALTER TABLE asset_text_chunks ADD COLUMN block_type TEXT NOT NULL DEFAULT 'paragraph'"
        )
    if "section_path" not in chunk_columns:
        conn.execute(
            "ALTER TABLE asset_text_chunks ADD COLUMN section_path TEXT NOT NULL DEFAULT '[]'"
        )
    if "bbox_json" not in chunk_columns:
        conn.execute("ALTER TABLE asset_text_chunks ADD COLUMN bbox_json TEXT")
    if "block_ids" not in chunk_columns:
        conn.execute(
            "ALTER TABLE asset_text_chunks ADD COLUMN block_ids TEXT NOT NULL DEFAULT '[]'"
        )


def _migrate_project_layer(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS projects (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            slug               TEXT NOT NULL UNIQUE,
            name               TEXT NOT NULL,
            status             TEXT NOT NULL DEFAULT 'active',
            description        TEXT,
            obsidian_note_path TEXT,
            tags               TEXT NOT NULL DEFAULT '[]',
            created_at         TEXT NOT NULL,
            updated_at         TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS project_papers (
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            paper_id   INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
            role       TEXT NOT NULL DEFAULT 'relevant',
            created_at TEXT NOT NULL,
            PRIMARY KEY (project_id, paper_id)
        );

        CREATE INDEX IF NOT EXISTS idx_projects_status_updated_at
        ON projects(status, updated_at DESC, id DESC);

        CREATE INDEX IF NOT EXISTS idx_project_papers_paper_id
        ON project_papers(paper_id);
    """)

    _rebuild_fts_indexes(conn)


def _migrate_multi_project_links(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS project_todos (
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            todo_id    INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            PRIMARY KEY (project_id, todo_id)
        );

        CREATE TABLE IF NOT EXISTS project_progress_entries (
            project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            progress_entry_id  INTEGER NOT NULL REFERENCES progress_log(id) ON DELETE CASCADE,
            created_at         TEXT NOT NULL,
            PRIMARY KEY (project_id, progress_entry_id)
        );

        CREATE TABLE IF NOT EXISTS project_chat_sessions (
            project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            chat_session_id  INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
            created_at       TEXT NOT NULL,
            PRIMARY KEY (project_id, chat_session_id)
        );

        CREATE INDEX IF NOT EXISTS idx_project_todos_todo_id
        ON project_todos(todo_id);

        CREATE INDEX IF NOT EXISTS idx_project_progress_entries_progress_entry_id
        ON project_progress_entries(progress_entry_id);

        CREATE INDEX IF NOT EXISTS idx_project_chat_sessions_chat_session_id
        ON project_chat_sessions(chat_session_id);
    """)


def _migrate_task_subtasks(conn: sqlite3.Connection) -> None:
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(todos)").fetchall()
    }
    if "parent_id" not in columns:
        conn.execute(
            "ALTER TABLE todos ADD COLUMN parent_id INTEGER REFERENCES todos(id) ON DELETE CASCADE"
        )
    if "sort_order" not in columns:
        conn.execute(
            "ALTER TABLE todos ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0"
        )
    if "updated_at" not in columns:
        conn.execute("ALTER TABLE todos ADD COLUMN updated_at TEXT")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_todos_parent_id ON todos(parent_id)"
    )


def _legacy_generated_completion_log_body(title: str, subtask_titles: list[str]) -> str:
    task_title = (title or "").strip() or "(untitled task)"
    if not subtask_titles:
        return f"Completed task: **{task_title}**"
    lines = [f"Completed task: **{task_title}**", "", "Subtasks:"]
    for subtask_title in subtask_titles:
        sub_text = (subtask_title or "").strip().replace("\n", " ") or "(untitled)"
        lines.append(f"- [x] {sub_text}")
    return "\n".join(lines)


def _legacy_generated_completion_log_ids(conn: sqlite3.Connection) -> list[int]:
    task_rows = conn.execute(
        """
        SELECT id, title, completion_log_entry_id
        FROM todos
        WHERE completion_log_entry_id IS NOT NULL
        """
    ).fetchall()
    delete_ids: set[int] = set()
    preserve_ids: set[int] = set()
    for task_row in task_rows:
        log_id = int(task_row["completion_log_entry_id"])
        log_row = conn.execute(
            "SELECT entry FROM progress_log WHERE id=?",
            (log_id,),
        ).fetchone()
        if log_row is None:
            continue
        subtask_rows = conn.execute(
            "SELECT title FROM todos WHERE parent_id=? ORDER BY sort_order ASC, id ASC",
            (int(task_row["id"]),),
        ).fetchall()
        expected = _legacy_generated_completion_log_body(
            task_row["title"],
            [row["title"] for row in subtask_rows],
        )
        if log_row["entry"] == expected:
            delete_ids.add(log_id)
        else:
            preserve_ids.add(log_id)
    return sorted(delete_ids - preserve_ids)


def _migrate_remove_task_completion_log_coupling(conn: sqlite3.Connection) -> None:
    columns = _table_columns(conn, "todos")
    if "completion_log_entry_id" not in columns:
        _migrate_rebuild_todos_fts_and_drop_legacy_progress_fts(conn)
        _create_relationship_indexes(conn)
        return

    _drop_todos_and_legacy_progress_fts(conn)
    generated_log_ids = _legacy_generated_completion_log_ids(conn)
    if generated_log_ids:
        placeholders = ",".join("?" for _ in generated_log_ids)
        conn.execute(
            f"DELETE FROM progress_log WHERE id IN ({placeholders})",
            generated_log_ids,
        )

    conn.commit()
    conn.execute("PRAGMA foreign_keys=OFF")
    conn.executescript("""
        CREATE TABLE todos_new (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            title        TEXT NOT NULL,
            description  TEXT NOT NULL DEFAULT '',
            status       TEXT NOT NULL DEFAULT 'open',
            priority     TEXT NOT NULL DEFAULT 'medium',
            due_date     TEXT,
            created_at   TEXT NOT NULL,
            completed_at TEXT,
            parent_id    INTEGER REFERENCES todos(id) ON DELETE CASCADE,
            sort_order   INTEGER NOT NULL DEFAULT 0,
            updated_at   TEXT
        );

        INSERT INTO todos_new (
            id, title, description, status, priority, due_date, created_at,
            completed_at, parent_id, sort_order, updated_at
        )
        SELECT
            id, title, description, status, priority, due_date, created_at,
            completed_at, parent_id, sort_order, updated_at
        FROM todos;

        DROP TABLE todos;
        ALTER TABLE todos_new RENAME TO todos;
    """)
    conn.execute("PRAGMA foreign_keys=ON")
    violations = conn.execute("PRAGMA foreign_key_check").fetchall()
    if violations:
        raise RuntimeError("Task completion-log migration left foreign key violations.")
    _create_relationship_indexes(conn)
    _create_todos_fts(conn)


def _migrate_first_class_log_entries(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS log_entries (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_type       TEXT NOT NULL CHECK (entry_type IN ('manual', 'task')),
            entry_date       TEXT NOT NULL,
            entry_markdown   TEXT NOT NULL DEFAULT '',
            linked_paper_ids TEXT NOT NULL DEFAULT '[]',
            task_id          INTEGER REFERENCES todos(id) ON DELETE CASCADE,
            created_at       TEXT NOT NULL,
            UNIQUE(entry_type, task_id)
        );

        CREATE TABLE IF NOT EXISTS project_log_entries (
            project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            log_entry_id  INTEGER NOT NULL REFERENCES log_entries(id) ON DELETE CASCADE,
            created_at    TEXT NOT NULL,
            PRIMARY KEY (project_id, log_entry_id)
        );

        CREATE INDEX IF NOT EXISTS idx_log_entries_task_id
        ON log_entries(task_id);

        CREATE INDEX IF NOT EXISTS idx_log_entries_type_date
        ON log_entries(entry_type, entry_date DESC, id DESC);

        CREATE INDEX IF NOT EXISTS idx_project_log_entries_log_entry_id
        ON project_log_entries(log_entry_id);
    """)

    if _table_exists(conn, "progress_log"):
        progress_columns = _table_columns(conn, "progress_log")
        entry_date_sql = "entry_date" if "entry_date" in progress_columns else "date('now')"
        linked_paper_ids_sql = "linked_paper_ids" if "linked_paper_ids" in progress_columns else "'[]'"
        created_at_sql = "created_at" if "created_at" in progress_columns else "datetime('now')"
        conn.execute(
            f"""
            INSERT OR IGNORE INTO log_entries (
                id, entry_type, entry_date, entry_markdown, linked_paper_ids, task_id, created_at
            )
            SELECT
                id,
                'manual',
                COALESCE({entry_date_sql}, date('now')),
                entry,
                COALESCE({linked_paper_ids_sql}, '[]'),
                NULL,
                COALESCE({created_at_sql}, datetime('now'))
            FROM progress_log
            """
        )

    if _table_exists(conn, "project_progress_entries"):
        conn.execute(
            """
            INSERT OR IGNORE INTO project_log_entries (project_id, log_entry_id, created_at)
            SELECT project_id, progress_entry_id, created_at
            FROM project_progress_entries
            WHERE progress_entry_id IN (SELECT id FROM log_entries WHERE entry_type='manual')
            """
        )

    if _table_exists(conn, "todos"):
        conn.execute(
            """
            INSERT OR IGNORE INTO log_entries (
                entry_type, entry_date, task_id, created_at
            )
            SELECT
                'task',
                substr(completed_at, 1, 10),
                id,
                completed_at
            FROM todos
            WHERE parent_id IS NULL
              AND status='done'
              AND completed_at IS NOT NULL
            """
        )

    conn.commit()
    conn.execute("PRAGMA foreign_keys=OFF")
    try:
        conn.executescript("""
            DROP TRIGGER IF EXISTS progress_ai;
            DROP TRIGGER IF EXISTS progress_ad;
            DROP TRIGGER IF EXISTS progress_au;
            DROP TABLE IF EXISTS progress_fts;
            DROP TABLE IF EXISTS project_progress_entries;
            DROP TABLE IF EXISTS progress_log;
        """)
        conn.commit()
    finally:
        conn.execute("PRAGMA foreign_keys=ON")
    violations = conn.execute("PRAGMA foreign_key_check").fetchall()
    if violations:
        raise RuntimeError("Log entry migration left foreign key violations.")


def _migrate_task_title_description(conn: sqlite3.Connection) -> None:
    columns = _table_columns(conn, "todos")
    if "title" in columns and "description" in columns and "text" not in columns:
        _migrate_rebuild_todos_fts_and_drop_legacy_progress_fts(conn)
        _create_relationship_indexes(conn)
        return
    if "text" not in columns:
        raise RuntimeError("Cannot migrate tasks: todos table has neither text nor title/description columns.")

    conn.commit()
    conn.execute("PRAGMA foreign_keys=OFF")
    _drop_todos_and_legacy_progress_fts(conn)
    completion_log_value = "completion_log_entry_id" if "completion_log_entry_id" in columns else "NULL"
    conn.executescript(f"""
        CREATE TABLE todos_new (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            title                   TEXT NOT NULL,
            description             TEXT NOT NULL DEFAULT '',
            status                  TEXT NOT NULL DEFAULT 'open',
            priority                TEXT NOT NULL DEFAULT 'medium',
            due_date                TEXT,
            created_at              TEXT NOT NULL,
            completed_at            TEXT,
            parent_id               INTEGER REFERENCES todos(id) ON DELETE CASCADE,
            sort_order              INTEGER NOT NULL DEFAULT 0,
            updated_at              TEXT,
            completion_log_entry_id INTEGER
        );

        INSERT INTO todos_new (
            id, title, description, status, priority, due_date, created_at,
            completed_at, parent_id, sort_order, updated_at, completion_log_entry_id
        )
        SELECT
            id,
            COALESCE(NULLIF(TRIM(text), ''), '(untitled task)'),
            '',
            status,
            priority,
            due_date,
            created_at,
            completed_at,
            parent_id,
            sort_order,
            updated_at,
            {completion_log_value}
        FROM todos;

        DROP TABLE todos;
        ALTER TABLE todos_new RENAME TO todos;
    """)
    conn.execute("PRAGMA foreign_keys=ON")
    _create_relationship_indexes(conn)
    _create_todos_fts(conn)


def _migrate_chat_provider_state(conn: sqlite3.Connection) -> None:
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(chat_sessions)").fetchall()
    }
    if "provider_state" not in columns:
        conn.execute(
            "ALTER TABLE chat_sessions ADD COLUMN provider_state TEXT NOT NULL DEFAULT '{}'"
        )


def _migrate_chat_message_context_items(conn: sqlite3.Connection) -> None:
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(chat_messages)").fetchall()
    }
    if "context_items" not in columns:
        conn.execute(
            "ALTER TABLE chat_messages ADD COLUMN context_items TEXT NOT NULL DEFAULT '[]'"
        )


def _migrate_chat_message_trace_entries(conn: sqlite3.Connection) -> None:
    columns = [
        row["name"]
        for row in conn.execute("PRAGMA table_info(chat_messages)").fetchall()
    ]
    expected_columns = [
        "id",
        "session_id",
        "role",
        "content",
        "trace_entries",
        "context_items",
        "created_at",
    ]
    if columns == expected_columns:
        return

    conn.execute(
        """
        CREATE TABLE chat_messages_new (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id    INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
            role          TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
            content       TEXT NOT NULL,
            trace_entries TEXT NOT NULL DEFAULT '[]',
            context_items TEXT NOT NULL DEFAULT '[]',
            created_at    TEXT NOT NULL
        )
        """
    )

    selected_columns = ", ".join(columns)
    rows = conn.execute(f"SELECT {selected_columns} FROM chat_messages").fetchall()
    for row in rows:
        keys = set(row.keys())
        trace_entries = row["trace_entries"] if "trace_entries" in keys else "[]"
        context_items = row["context_items"] if "context_items" in keys else "[]"
        conn.execute(
            """
            INSERT INTO chat_messages_new
                (id, session_id, role, content, trace_entries, context_items, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["id"],
                row["session_id"],
                row["role"],
                row["content"],
                trace_entries,
                context_items or "[]",
                row["created_at"],
            ),
        )

    conn.execute("DROP TABLE chat_messages")
    conn.execute("ALTER TABLE chat_messages_new RENAME TO chat_messages")
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created_at
        ON chat_messages(session_id, created_at, id)
        """
    )
