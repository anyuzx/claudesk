from __future__ import annotations

import sqlite3
import threading
from typing import Generator

from claudesk.core.db import (
    db_path,
    init_db,
)

_init_lock = threading.Lock()
_initialized = False


def _ensure_initialized() -> None:
    global _initialized
    if _initialized:
        return
    with _init_lock:
        if _initialized:
            return
        conn = sqlite3.connect(str(db_path()))
        try:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=DELETE")
            conn.execute("PRAGMA foreign_keys=ON")
            init_db(conn)
            conn.commit()
        finally:
            conn.close()
        _initialized = True


def get_conn() -> Generator[sqlite3.Connection, None, None]:
    """FastAPI dependency: yield a fresh SQLite connection per request.

    A shared, process-global connection (the previous design) is unsafe under
    concurrent FastAPI thread-pool execution: SQLite serializes statements but
    not implicit cursor state, so two threads racing on `conn.execute(...)` can
    surface as `sqlite3.InterfaceError: bad parameter or other API misuse`.
    """
    _ensure_initialized()
    # check_same_thread=False is required because FastAPI's threadpool can run
    # the dependency setup, the route handler, and the dependency teardown on
    # different threads from its pool. The connection is still per-request,
    # so there is no concurrent-cursor race — the flag just relaxes SQLite's
    # creation-thread check across the request lifecycle.
    conn = sqlite3.connect(str(db_path()), check_same_thread=False)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=3000")
        yield conn
    finally:
        conn.close()
