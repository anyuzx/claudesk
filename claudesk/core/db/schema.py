from __future__ import annotations

import sqlite3


def _create_tables(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY
        );

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

        CREATE TABLE IF NOT EXISTS papers (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            source          TEXT NOT NULL,
            external_id     TEXT NOT NULL,
            title           TEXT NOT NULL,
            abstract        TEXT NOT NULL,
            authors         TEXT NOT NULL DEFAULT '[]',
            published_date  TEXT NOT NULL,
            journal_abbrev  TEXT,
            url             TEXT NOT NULL,
            embedding       BLOB,
            relevance_score REAL,
            score_rubric    TEXT,
            note            TEXT,
            status          TEXT NOT NULL DEFAULT 'new',
            is_saved        INTEGER NOT NULL DEFAULT 0,
            is_read         INTEGER NOT NULL DEFAULT 0,
            is_to_read      INTEGER NOT NULL DEFAULT 0,
            to_read_at      TEXT,
            new_digest_run_id INTEGER REFERENCES digest_runs(id) ON DELETE SET NULL,
            fetched_at      TEXT NOT NULL,
            UNIQUE(source, external_id)
        );

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

        CREATE TABLE IF NOT EXISTS note_assets (
            note_id    INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            asset_id   INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            status     TEXT NOT NULL DEFAULT 'committed' CHECK(status IN ('staged', 'committed')),
            created_at TEXT NOT NULL,
            PRIMARY KEY (note_id, asset_id)
        );

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

        CREATE TABLE IF NOT EXISTS todos (
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
            updated_at              TEXT
        );

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

        CREATE TABLE IF NOT EXISTS feedback (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            paper_id   INTEGER NOT NULL REFERENCES papers(id),
            signal     TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chat_sessions (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            title               TEXT NOT NULL DEFAULT '',
            created_at          TEXT NOT NULL,
            updated_at          TEXT NOT NULL,
            linked_paper_ids    TEXT NOT NULL DEFAULT '[]',
            linked_todo_ids     TEXT NOT NULL DEFAULT '[]',
            linked_progress_ids TEXT NOT NULL DEFAULT '[]',
            runtime_settings    TEXT NOT NULL,
            provider_state      TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS chat_messages (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id    INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
            role          TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
            content       TEXT NOT NULL,
            trace_entries TEXT NOT NULL DEFAULT '[]',
            context_items TEXT NOT NULL DEFAULT '[]',
            created_at    TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chat_resource_reads (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id           INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
            assistant_message_id INTEGER REFERENCES chat_messages(id) ON DELETE CASCADE,
            turn_id              TEXT NOT NULL,
            provider             TEXT NOT NULL,
            source               TEXT NOT NULL CHECK (source IN ('prompt_context', 'capability_result')),
            capability_name      TEXT,
            resource_kind        TEXT NOT NULL,
            resource_id          TEXT,
            label                TEXT NOT NULL DEFAULT '',
            summary              TEXT NOT NULL DEFAULT '',
            locator_json         TEXT NOT NULL DEFAULT '{}',
            created_at           TEXT NOT NULL
        );

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

        CREATE TABLE IF NOT EXISTS chat_attachments (
            session_id      INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
            asset_id        INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            user_message_id INTEGER REFERENCES chat_messages(id) ON DELETE CASCADE,
            context_kind    TEXT NOT NULL CHECK (context_kind IN ('clipboard_text', 'screenshot', 'file')),
            created_at      TEXT NOT NULL,
            PRIMARY KEY (session_id, asset_id)
        );

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

        CREATE TABLE IF NOT EXISTS asset_text_chunks (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            asset_id    INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            chunk_index INTEGER NOT NULL,
            page_number INTEGER NOT NULL CHECK (page_number >= 1),
            text        TEXT NOT NULL,
            char_count  INTEGER NOT NULL DEFAULT 0,
            block_type  TEXT NOT NULL DEFAULT 'paragraph',
            section_path TEXT NOT NULL DEFAULT '[]',
            bbox_json   TEXT,
            block_ids   TEXT NOT NULL DEFAULT '[]',
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

        CREATE TABLE IF NOT EXISTS project_papers (
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            paper_id   INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
            role       TEXT NOT NULL DEFAULT 'relevant',
            created_at TEXT NOT NULL,
            PRIMARY KEY (project_id, paper_id)
        );

        CREATE TABLE IF NOT EXISTS project_todos (
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            todo_id    INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            PRIMARY KEY (project_id, todo_id)
        );

        CREATE TABLE IF NOT EXISTS project_log_entries (
            project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            log_entry_id  INTEGER NOT NULL REFERENCES log_entries(id) ON DELETE CASCADE,
            created_at    TEXT NOT NULL,
            PRIMARY KEY (project_id, log_entry_id)
        );

        CREATE TABLE IF NOT EXISTS project_chat_sessions (
            project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            chat_session_id  INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
            created_at       TEXT NOT NULL,
            PRIMARY KEY (project_id, chat_session_id)
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
            title,
            abstract,
            authors,
            content='papers',
            content_rowid='id',
            tokenize='porter unicode61'
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
            title,
            search_body,
            content='notes',
            content_rowid='id',
            tokenize='porter unicode61'
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS projects_fts USING fts5(
            name,
            description,
            tags,
            status,
            obsidian_note_path,
            content='projects',
            content_rowid='id',
            tokenize='porter unicode61'
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS log_entries_fts USING fts5(
            title,
            body,
            entry,
            tokenize='porter unicode61'
        );

        CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated_at
        ON chat_sessions(updated_at DESC, id DESC);

        CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created_at
        ON chat_messages(session_id, created_at, id);

        CREATE INDEX IF NOT EXISTS idx_chat_resource_reads_session_message_created_at
        ON chat_resource_reads(session_id, assistant_message_id, created_at, id);

        CREATE INDEX IF NOT EXISTS idx_chat_resource_reads_session_turn
        ON chat_resource_reads(session_id, turn_id);

        CREATE INDEX IF NOT EXISTS idx_assets_kind
        ON assets(kind);

        CREATE INDEX IF NOT EXISTS idx_assets_content_hash
        ON assets(content_hash);

        CREATE INDEX IF NOT EXISTS idx_paper_assets_asset_id
        ON paper_assets(asset_id);

        CREATE INDEX IF NOT EXISTS idx_note_assets_asset_id
        ON note_assets(asset_id);

        CREATE INDEX IF NOT EXISTS idx_note_links_source
        ON note_links(source_note_id, position, id);

        CREATE INDEX IF NOT EXISTS idx_note_links_target
        ON note_links(target_note_id);

        CREATE INDEX IF NOT EXISTS idx_note_links_normalized_target
        ON note_links(normalized_target_title);

        CREATE INDEX IF NOT EXISTS idx_chat_attachments_session_message
        ON chat_attachments(session_id, user_message_id, asset_id);

        CREATE INDEX IF NOT EXISTS idx_asset_text_chunks_asset_page
        ON asset_text_chunks(asset_id, page_number, chunk_index);

        CREATE INDEX IF NOT EXISTS idx_asset_document_blocks_asset_page
        ON asset_document_blocks(asset_id, page_number, block_index);

        CREATE INDEX IF NOT EXISTS idx_asset_parse_artifacts_asset_kind
        ON asset_parse_artifacts(asset_id, artifact_kind);

        CREATE INDEX IF NOT EXISTS idx_projects_status_updated_at
        ON projects(status, updated_at DESC, id DESC);

        CREATE INDEX IF NOT EXISTS idx_project_papers_paper_id
        ON project_papers(paper_id);

        CREATE INDEX IF NOT EXISTS idx_note_papers_paper_id
        ON note_papers(paper_id);

        CREATE INDEX IF NOT EXISTS idx_notes_updated_at
        ON notes(updated_at DESC, id DESC);

        CREATE INDEX IF NOT EXISTS idx_project_todos_todo_id
        ON project_todos(todo_id);

        CREATE INDEX IF NOT EXISTS idx_log_entries_task_id
        ON log_entries(task_id);

        CREATE INDEX IF NOT EXISTS idx_log_entries_type_date
        ON log_entries(entry_type, entry_date DESC, id DESC);

        CREATE INDEX IF NOT EXISTS idx_project_log_entries_log_entry_id
        ON project_log_entries(log_entry_id);

        CREATE INDEX IF NOT EXISTS idx_project_chat_sessions_chat_session_id
        ON project_chat_sessions(chat_session_id);
    """)
    _create_background_job_schema(conn)
    _create_todos_fts_table(conn)
    _create_project_milestone_schema(conn)
    _create_fts_triggers(conn)
    _create_relationship_indexes(conn)
    _create_note_title_indexes(conn)


def _create_note_title_indexes(conn: sqlite3.Connection) -> None:
    if "normalized_title" not in _table_columns(conn, "notes"):
        return
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_notes_normalized_title
        ON notes(normalized_title)
        """
    )


def _drop_notes_fts(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        DROP TRIGGER IF EXISTS notes_ai;
        DROP TRIGGER IF EXISTS notes_ad;
        DROP TRIGGER IF EXISTS notes_au;
        DROP TABLE IF EXISTS notes_fts;
    """)


def _create_notes_fts(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
            title,
            search_body,
            content='notes',
            content_rowid='id',
            tokenize='porter unicode61'
        )
        """
    )
    _create_fts_triggers(conn)
    conn.execute("INSERT INTO notes_fts(notes_fts) VALUES ('rebuild')")


def _create_background_job_schema(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS background_jobs (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            kind                 TEXT NOT NULL,
            status               TEXT NOT NULL CHECK (
                status IN ('queued', 'running', 'cancelling', 'cancelled', 'succeeded', 'failed')
            ),
            resource_kind        TEXT,
            resource_id          TEXT,
            dedupe_key           TEXT,
            request_json         TEXT NOT NULL DEFAULT '{}',
            result_json          TEXT,
            latest_progress_json TEXT,
            attempt_count        INTEGER NOT NULL DEFAULT 0,
            max_attempts         INTEGER NOT NULL DEFAULT 1,
            next_attempt_at      TEXT,
            last_failure_id      INTEGER,
            cancel_requested_at  TEXT,
            machine_id           TEXT,
            pid                  INTEGER,
            executor_kind        TEXT,
            executor_meta_json   TEXT,
            created_at           TEXT NOT NULL,
            started_at           TEXT,
            finished_at          TEXT,
            updated_at           TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS background_job_events (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id           INTEGER NOT NULL REFERENCES background_jobs(id) ON DELETE CASCADE,
            event_type       TEXT NOT NULL,
            message          TEXT,
            progress_current REAL,
            progress_total   REAL,
            payload_json     TEXT NOT NULL DEFAULT '{}',
            created_at       TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS background_job_failures (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id       INTEGER NOT NULL REFERENCES background_jobs(id) ON DELETE CASCADE,
            attempt      INTEGER NOT NULL DEFAULT 0,
            error_type   TEXT NOT NULL,
            message      TEXT NOT NULL,
            details_json TEXT NOT NULL DEFAULT '{}',
            retryable    INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_background_jobs_kind_status_updated
        ON background_jobs(kind, status, updated_at DESC, id DESC);

        CREATE INDEX IF NOT EXISTS idx_background_jobs_resource
        ON background_jobs(resource_kind, resource_id, updated_at DESC, id DESC);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_background_jobs_active_dedupe
        ON background_jobs(kind, dedupe_key)
        WHERE dedupe_key IS NOT NULL
          AND status IN ('queued', 'running', 'cancelling');

        CREATE INDEX IF NOT EXISTS idx_background_job_events_job_created
        ON background_job_events(job_id, created_at, id);

        CREATE INDEX IF NOT EXISTS idx_background_job_failures_job_created
        ON background_job_failures(job_id, created_at, id);
    """)


def _create_fts_triggers(conn: sqlite3.Connection) -> None:
    todo_triggers = _todo_fts_trigger_sql(conn)
    conn.executescript(f"""
        CREATE TRIGGER IF NOT EXISTS papers_ai AFTER INSERT ON papers BEGIN
            INSERT INTO papers_fts(rowid, title, abstract, authors)
            VALUES (new.id, new.title, new.abstract, new.authors);
        END;

        CREATE TRIGGER IF NOT EXISTS papers_ad AFTER DELETE ON papers BEGIN
            INSERT INTO papers_fts(papers_fts, rowid, title, abstract, authors)
            VALUES ('delete', old.id, old.title, old.abstract, old.authors);
        END;

        CREATE TRIGGER IF NOT EXISTS papers_au AFTER UPDATE ON papers BEGIN
            INSERT INTO papers_fts(papers_fts, rowid, title, abstract, authors)
            VALUES ('delete', old.id, old.title, old.abstract, old.authors);
            INSERT INTO papers_fts(rowid, title, abstract, authors)
            VALUES (new.id, new.title, new.abstract, new.authors);
        END;

        CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
            INSERT INTO notes_fts(rowid, title, search_body)
            VALUES (new.id, new.title, new.search_body);
        END;

        CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, title, search_body)
            VALUES ('delete', old.id, old.title, old.search_body);
        END;

        CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE OF title, body, search_body ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, title, search_body)
            VALUES ('delete', old.id, old.title, old.search_body);
            INSERT INTO notes_fts(rowid, title, search_body)
            VALUES (new.id, new.title, new.search_body);
        END;

        CREATE TRIGGER IF NOT EXISTS projects_ai AFTER INSERT ON projects BEGIN
            INSERT INTO projects_fts(rowid, name, description, tags, status, obsidian_note_path)
            VALUES (
                new.id,
                new.name,
                COALESCE(new.description, ''),
                new.tags,
                new.status,
                COALESCE(new.obsidian_note_path, '')
            );
        END;

        CREATE TRIGGER IF NOT EXISTS projects_ad AFTER DELETE ON projects BEGIN
            INSERT INTO projects_fts(projects_fts, rowid, name, description, tags, status, obsidian_note_path)
            VALUES (
                'delete',
                old.id,
                old.name,
                COALESCE(old.description, ''),
                old.tags,
                old.status,
                COALESCE(old.obsidian_note_path, '')
            );
        END;

        CREATE TRIGGER IF NOT EXISTS projects_au AFTER UPDATE ON projects BEGIN
            INSERT INTO projects_fts(projects_fts, rowid, name, description, tags, status, obsidian_note_path)
            VALUES (
                'delete',
                old.id,
                old.name,
                COALESCE(old.description, ''),
                old.tags,
                old.status,
                COALESCE(old.obsidian_note_path, '')
            );
            INSERT INTO projects_fts(rowid, name, description, tags, status, obsidian_note_path)
            VALUES (
                new.id,
                new.name,
                COALESCE(new.description, ''),
                new.tags,
                new.status,
                COALESCE(new.obsidian_note_path, '')
            );
        END;

        CREATE TRIGGER IF NOT EXISTS log_entries_ai AFTER INSERT ON log_entries BEGIN
            INSERT INTO log_entries_fts(rowid, title, body, entry)
            SELECT
                new.id,
                {_log_fts_title_sql("new")},
                {_log_fts_body_sql("new")},
                {_log_fts_entry_sql("new")};
        END;

        CREATE TRIGGER IF NOT EXISTS log_entries_ad AFTER DELETE ON log_entries BEGIN
            DELETE FROM log_entries_fts WHERE rowid = old.id;
        END;

        CREATE TRIGGER IF NOT EXISTS log_entries_au AFTER UPDATE ON log_entries BEGIN
            DELETE FROM log_entries_fts WHERE rowid = old.id;
            INSERT INTO log_entries_fts(rowid, title, body, entry)
            SELECT
                new.id,
                {_log_fts_title_sql("new")},
                {_log_fts_body_sql("new")},
                {_log_fts_entry_sql("new")};
        END;

        {todo_triggers}
    """)


def _todo_fts_trigger_sql(conn: sqlite3.Connection) -> str:
    if _todos_use_title_description(conn):
        title_sql = _log_fts_title_sql("log_entries")
        body_sql = _log_fts_body_sql("log_entries")
        entry_sql = _log_fts_entry_sql("log_entries")
        return f"""
        CREATE TRIGGER IF NOT EXISTS todos_ai AFTER INSERT ON todos BEGIN
            INSERT INTO todos_fts(rowid, title, description)
            VALUES (new.id, new.title, new.description);
        END;

        CREATE TRIGGER IF NOT EXISTS todos_ad AFTER DELETE ON todos BEGIN
            INSERT INTO todos_fts(todos_fts, rowid, title, description)
            VALUES ('delete', old.id, old.title, old.description);
        END;

        CREATE TRIGGER IF NOT EXISTS todos_au AFTER UPDATE ON todos BEGIN
            INSERT INTO todos_fts(todos_fts, rowid, title, description)
            VALUES ('delete', old.id, old.title, old.description);
            INSERT INTO todos_fts(rowid, title, description)
            VALUES (new.id, new.title, new.description);
        END;

        CREATE TRIGGER IF NOT EXISTS todos_log_fts_ai AFTER INSERT ON todos BEGIN
            DELETE FROM log_entries_fts
            WHERE rowid IN (
                SELECT id
                FROM log_entries
                WHERE entry_type='task'
                  AND task_id IN (new.id, new.parent_id)
            );
            INSERT INTO log_entries_fts(rowid, title, body, entry)
            SELECT
                log_entries.id,
                {title_sql},
                {body_sql},
                {entry_sql}
            FROM log_entries
            WHERE entry_type='task'
              AND task_id IN (new.id, new.parent_id);
        END;

        CREATE TRIGGER IF NOT EXISTS todos_log_fts_ad AFTER DELETE ON todos BEGIN
            DELETE FROM log_entries_fts
            WHERE rowid IN (
                SELECT id
                FROM log_entries
                WHERE entry_type='task'
                  AND task_id IN (old.id, old.parent_id)
            );
            INSERT INTO log_entries_fts(rowid, title, body, entry)
            SELECT
                log_entries.id,
                {title_sql},
                {body_sql},
                {entry_sql}
            FROM log_entries
            WHERE entry_type='task'
              AND task_id IN (old.id, old.parent_id);
        END;

        CREATE TRIGGER IF NOT EXISTS todos_log_fts_au AFTER UPDATE ON todos BEGIN
            DELETE FROM log_entries_fts
            WHERE rowid IN (
                SELECT id
                FROM log_entries
                WHERE entry_type='task'
                  AND task_id IN (new.id, new.parent_id, old.id, old.parent_id)
            );
            INSERT INTO log_entries_fts(rowid, title, body, entry)
            SELECT
                log_entries.id,
                {title_sql},
                {body_sql},
                {entry_sql}
            FROM log_entries
            WHERE entry_type='task'
              AND task_id IN (new.id, new.parent_id, old.id, old.parent_id);
        END;
        """
    return """
        CREATE TRIGGER IF NOT EXISTS todos_ai AFTER INSERT ON todos BEGIN
            INSERT INTO todos_fts(rowid, text)
            VALUES (new.id, new.text);
        END;

        CREATE TRIGGER IF NOT EXISTS todos_ad AFTER DELETE ON todos BEGIN
            INSERT INTO todos_fts(todos_fts, rowid, text)
            VALUES ('delete', old.id, old.text);
        END;

        CREATE TRIGGER IF NOT EXISTS todos_au AFTER UPDATE ON todos BEGIN
            INSERT INTO todos_fts(todos_fts, rowid, text)
            VALUES ('delete', old.id, old.text);
            INSERT INTO todos_fts(rowid, text)
            VALUES (new.id, new.text);
        END;

        CREATE TRIGGER IF NOT EXISTS todos_log_fts_ai AFTER INSERT ON todos BEGIN
            DELETE FROM log_entries_fts
            WHERE rowid IN (
                SELECT id
                FROM log_entries
                WHERE entry_type='task'
                  AND task_id IN (new.id, new.parent_id)
            );
        END;

        CREATE TRIGGER IF NOT EXISTS todos_log_fts_ad AFTER DELETE ON todos BEGIN
            DELETE FROM log_entries_fts
            WHERE rowid IN (
                SELECT id
                FROM log_entries
                WHERE entry_type='task'
                  AND task_id IN (old.id, old.parent_id)
            );
        END;

        CREATE TRIGGER IF NOT EXISTS todos_log_fts_au AFTER UPDATE ON todos BEGIN
            DELETE FROM log_entries_fts
            WHERE rowid IN (
                SELECT id
                FROM log_entries
                WHERE entry_type='task'
                  AND task_id IN (new.id, new.parent_id, old.id, old.parent_id)
            );
        END;
        """


def _log_fts_title_sql(row_ref: str) -> str:
    return f"""
                CASE
                    WHEN {row_ref}.entry_type = 'manual'
                    THEN trim(substr({row_ref}.entry_markdown, 1, instr({row_ref}.entry_markdown || char(10), char(10)) - 1))
                    ELSE COALESCE((SELECT title FROM todos WHERE id = {row_ref}.task_id), '')
                END
    """.strip()


def _log_fts_body_sql(row_ref: str) -> str:
    return f"""
                CASE
                    WHEN {row_ref}.entry_type = 'manual'
                    THEN trim(substr({row_ref}.entry_markdown, instr({row_ref}.entry_markdown || char(10), char(10)) + 1))
                    ELSE COALESCE((SELECT description FROM todos WHERE id = {row_ref}.task_id), '')
                END
    """.strip()


def _log_fts_entry_sql(row_ref: str) -> str:
    return f"""
                CASE
                    WHEN {row_ref}.entry_type = 'manual'
                    THEN {row_ref}.entry_markdown
                    ELSE trim(
                        COALESCE((
                            SELECT 'Completed task: ' || title || char(10) || char(10) || description
                            FROM todos
                            WHERE id = {row_ref}.task_id
                        ), '')
                        || char(10) || char(10) ||
                        COALESCE((
                            SELECT 'Subtasks completed:' || char(10) || group_concat('- ' || title || ' ' || description, char(10))
                            FROM todos
                            WHERE parent_id = {row_ref}.task_id
                        ), '')
                    )
                END
    """.strip()


def _table_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    return {
        row["name"]
        for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    }


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (table_name,),
    ).fetchone()
    return row is not None


def _todos_use_title_description(conn: sqlite3.Connection) -> bool:
    columns = _table_columns(conn, "todos")
    return "title" in columns and "description" in columns


def _todo_fts_column_sql(conn: sqlite3.Connection) -> str:
    if _todos_use_title_description(conn):
        return """
            title,
            description,
        """
    return """
            text,
        """


def _create_todos_fts_table(conn: sqlite3.Connection, *, if_not_exists: bool = True) -> None:
    exists_clause = "IF NOT EXISTS " if if_not_exists else ""
    conn.executescript(f"""
        CREATE VIRTUAL TABLE {exists_clause}todos_fts USING fts5(
            {_todo_fts_column_sql(conn)}
            content='todos',
            content_rowid='id',
            tokenize='porter unicode61'
        );
    """)


def _create_project_milestone_schema(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS project_milestones (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            title               TEXT NOT NULL,
            description         TEXT,
            kind                TEXT NOT NULL DEFAULT 'analysis'
                                CHECK (kind IN (
                                    'conceptual', 'literature', 'data', 'analysis',
                                    'writing', 'submission', 'collaboration', 'admin'
                                )),
            status              TEXT NOT NULL DEFAULT 'not_started'
                                CHECK (status IN (
                                    'not_started', 'in_progress', 'blocked',
                                    'ready_for_review', 'done', 'dropped'
                                )),
            order_index         INTEGER NOT NULL DEFAULT 0,
            acceptance_criteria TEXT,
            target_date         TEXT,
            completed_at        TEXT,
            created_at          TEXT NOT NULL,
            updated_at          TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS project_milestone_todos (
            milestone_id INTEGER NOT NULL REFERENCES project_milestones(id) ON DELETE CASCADE,
            todo_id      INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
            created_at   TEXT NOT NULL,
            PRIMARY KEY (milestone_id, todo_id)
        );

        CREATE INDEX IF NOT EXISTS idx_project_milestones_project_order
        ON project_milestones(project_id, order_index, id);

        CREATE INDEX IF NOT EXISTS idx_project_milestones_project_status
        ON project_milestones(project_id, status, order_index, id);

        CREATE INDEX IF NOT EXISTS idx_project_milestone_todos_todo_id
        ON project_milestone_todos(todo_id);
    """)


def _create_relationship_indexes(conn: sqlite3.Connection) -> None:
    if "parent_id" in _table_columns(conn, "todos"):
        conn.execute("CREATE INDEX IF NOT EXISTS idx_todos_parent_id ON todos(parent_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_project_todos_todo_id ON project_todos(todo_id)")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_project_log_entries_log_entry_id "
        "ON project_log_entries(log_entry_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_project_chat_sessions_chat_session_id "
        "ON project_chat_sessions(chat_session_id)"
    )


def _rebuild_fts_indexes(conn: sqlite3.Connection) -> None:
    conn.execute("INSERT INTO papers_fts(papers_fts) VALUES ('rebuild')")
    conn.execute("INSERT INTO notes_fts(notes_fts) VALUES ('rebuild')")
    conn.execute("INSERT INTO projects_fts(projects_fts) VALUES ('rebuild')")
    conn.execute("INSERT INTO todos_fts(todos_fts) VALUES ('rebuild')")
    _rebuild_log_entries_fts(conn)


def _rebuild_log_entries_fts(conn: sqlite3.Connection) -> None:
    if not _table_exists(conn, "log_entries_fts") or not _todos_use_title_description(conn):
        return
    conn.execute("DELETE FROM log_entries_fts")
    conn.execute(
        f"""
        INSERT INTO log_entries_fts(rowid, title, body, entry)
        SELECT
            log_entries.id,
            {_log_fts_title_sql("log_entries")},
            {_log_fts_body_sql("log_entries")},
            {_log_fts_entry_sql("log_entries")}
        FROM log_entries
        """
    )


def _drop_todos_and_legacy_progress_fts(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        DROP TRIGGER IF EXISTS todos_ai;
        DROP TRIGGER IF EXISTS todos_ad;
        DROP TRIGGER IF EXISTS todos_au;
        DROP TRIGGER IF EXISTS todos_log_fts_ai;
        DROP TRIGGER IF EXISTS todos_log_fts_ad;
        DROP TRIGGER IF EXISTS todos_log_fts_au;
        DROP TRIGGER IF EXISTS log_entries_ai;
        DROP TRIGGER IF EXISTS log_entries_ad;
        DROP TRIGGER IF EXISTS log_entries_au;
        DROP TRIGGER IF EXISTS progress_ai;
        DROP TRIGGER IF EXISTS progress_ad;
        DROP TRIGGER IF EXISTS progress_au;
        DROP TABLE IF EXISTS todos_fts;
        DROP TABLE IF EXISTS progress_fts;
    """)


def _create_todos_fts(conn: sqlite3.Connection) -> None:
    _create_todos_fts_table(conn, if_not_exists=False)
    _create_fts_triggers(conn)
    conn.execute("INSERT INTO todos_fts(todos_fts) VALUES ('rebuild')")
