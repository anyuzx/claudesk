from __future__ import annotations

import sqlite3
import tempfile
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from claudesk.core.config import data_dir

SCHEMA_VERSION = 42


def db_path() -> Path:
    return data_dir() / "claudesk.db"


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path()))
    conn.row_factory = sqlite3.Row
    # DELETE journal mode (SQLite default) keeps a single .db file —
    # safer than WAL when the file lives in a Dropbox-synced folder.
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    """Back up existing file databases before migrating their schema."""
    from .migrations import _migrate
    from .schema import _create_tables

    tables = {
        row[0] for row in conn.execute("SELECT name FROM main.sqlite_master WHERE type='table'")
    }
    current = 0
    if "schema_version" in tables:
        row = conn.execute("SELECT MAX(version) FROM main.schema_version").fetchone()
        current = row[0] or 0
    if current > SCHEMA_VERSION:
        raise RuntimeError(
            f"Database schema version {current} is newer than supported version {SCHEMA_VERSION}. "
            "Use a newer Claudesk version to open this vault."
        )

    backup_path: Path | None = None
    if tables and current < SCHEMA_VERSION:
        source = next(row[2] for row in conn.execute("PRAGMA database_list") if row[1] == "main")
        if source:
            if conn.in_transaction:
                raise RuntimeError(
                    "Cannot back up a database with an active transaction; "
                    "commit or roll back before migrating."
                )
            source_path = Path(source)
            backup_dir = source_path.parent / "backups"
            timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            try:
                backup_dir.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(
                    dir=backup_dir,
                    prefix=f"{source_path.stem}-v{current}-before-v{SCHEMA_VERSION}-{timestamp}-",
                    suffix=".db",
                    delete=False,
                ) as backup_file:
                    backup_path = Path(backup_file.name)
                with closing(sqlite3.connect(str(backup_path))) as backup_conn:
                    conn.backup(backup_conn)
            except Exception as exc:
                if backup_path is not None:
                    backup_path.unlink(missing_ok=True)
                raise RuntimeError(f"Could not create database backup; migration was not started: {exc}") from exc

    try:
        _create_tables(conn)
        _migrate(conn)
        conn.commit()
    except Exception as exc:
        if backup_path is not None:
            raise RuntimeError(
                f"Database migration failed. Pre-migration backup retained at {backup_path}. Error: {exc}"
            ) from exc
        raise
