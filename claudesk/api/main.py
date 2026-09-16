from __future__ import annotations

import fcntl
import logging
import re
from collections.abc import Iterator
from contextlib import AsyncExitStack, asynccontextmanager, contextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import Headers
from starlette.types import ASGIApp, Receive, Scope, Send

from claudesk.api import chat, digest, log, notes, papers, projects, search, settings, todos
from claudesk.core.config import data_dir
from claudesk.core.db import get_connection, init_db
from claudesk.core.db.jobs import default_machine_id, reconcile_stale_jobs

logger = logging.getLogger(__name__)

LOCAL_ORIGIN_PATTERN = r"https?://(?:localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?"


def _is_local_origin(value: str) -> bool:
    match = re.fullmatch(LOCAL_ORIGIN_PATTERN, value)
    return bool(match and (match[1] is None or 0 < int(match[1]) <= 65535))


class LocalRequestMiddleware:
    """Keep browser requests inside the single-user loopback boundary.

    Local development ports are trusted; remote and opaque origins are not.
    Native local clients may omit Origin. Pure ASGI preserves chat streaming.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        hosts = headers.getlist("host")
        origins = headers.getlist("origin")
        if len(hosts) != 1 or not _is_local_origin(f"http://{hosts[0].lower()}"):
            response = JSONResponse({"detail": "A local Host header is required."}, status_code=400)
        elif origins and (len(origins) != 1 or not _is_local_origin(origins[0])):
            response = JSONResponse({"detail": "Requests from this origin are not allowed."}, status_code=403)
        elif (
            scope["method"] not in {"GET", "HEAD", "OPTIONS"}
            and not origins
            and headers.get("sec-fetch-site") in {"cross-site", "same-site"}
        ):
            response = JSONResponse({"detail": "A local Origin header is required."}, status_code=403)
        else:
            await self.app(scope, receive, send)
            return
        await response(scope, receive, send)

DIST = Path(__file__).parent.parent.parent / "frontend" / "dist"
FRONTEND_ROOT_STATIC_FILES = frozenset(
    {
        "apple-touch-icon.png",
        "favicon.svg",
        "icon-192.png",
        "icon-512.png",
        "site.webmanifest",
    }
)


def frontend_not_built_response() -> HTMLResponse:
    return HTMLResponse(
        "<p>Frontend not built yet. Run: <code>cd frontend && npm install && npm run build</code></p>",
        status_code=503,
    )


def frontend_root_static_response(file_name: str) -> FileResponse | HTMLResponse:
    index = DIST / "index.html"
    if not index.exists():
        return frontend_not_built_response()
    if file_name not in FRONTEND_ROOT_STATIC_FILES:
        raise HTTPException(status_code=404)

    file_path = DIST / file_name
    if not file_path.is_file():
        raise HTTPException(status_code=404)
    return FileResponse(str(file_path))


@contextmanager
def _app_vault_lock() -> Iterator[None]:
    """Exclude other app processes on this machine without locking worker DB access."""
    vault = data_dir().resolve()
    # Keep this inode in place: unlinking lets a second process lock a new file.
    with (vault / ".claudesk-app.lock").open("a") as lock_file:
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError(
                f"Another Claudesk app is already using vault {vault}. "
                "Close it before starting another instance."
            ) from exc
        yield


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ARG001
    with _app_vault_lock():
        conn = get_connection()
        try:
            init_db(conn)
            papers.reconcile_stale_pdf_parse_jobs(conn, machine_id=default_machine_id())
            reconcile_stale_jobs(conn, machine_id=default_machine_id())
            conn.commit()
        finally:
            conn.close()
        try:
            chat.cleanup_app_lifetime_chat_attachments()
        except Exception:
            logger.exception("Failed to run chat attachment startup cleanup")
        try:
            async with AsyncExitStack() as shutdown:
                # Exit stacks attempt every callback, including after cancellation.
                shutdown.push_async_callback(chat.shutdown_chat_provider_runtimes)
                shutdown.callback(search.shutdown_semantic_index_job)
                shutdown.callback(settings.shutdown_rubric_job)
                shutdown.callback(digest.shutdown_digest_job)
                yield
        finally:
            try:
                chat.cleanup_app_lifetime_chat_attachments()
            except Exception:
                logger.exception("Failed to run chat attachment shutdown cleanup")


app = FastAPI(title="claudesk", docs_url="/api/docs", redoc_url=None, lifespan=lifespan)

# Vite and Electron development use local ports; origin validation also covers
# ordinary form posts, which CORS alone does not block.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=LOCAL_ORIGIN_PATTERN,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(LocalRequestMiddleware)

app.include_router(papers.router, prefix="/api")
app.include_router(notes.router, prefix="/api")
app.include_router(digest.router, prefix="/api")
app.include_router(settings.router, prefix="/api")
app.include_router(todos.router, prefix="/api")
app.include_router(log.router, prefix="/api")
app.include_router(projects.router, prefix="/api")
app.include_router(search.router, prefix="/api")
app.include_router(chat.router, prefix="/api")

# Serve built React frontend — mounted after API routes so /api/* is unaffected
if (DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=str(DIST / "assets")), name="assets")
if (DIST / "fonts").exists():
    app.mount("/fonts", StaticFiles(directory=str(DIST / "fonts")), name="fonts")


@app.get("/apple-touch-icon.png", include_in_schema=False)
@app.get("/favicon.svg", include_in_schema=False)
@app.get("/icon-192.png", include_in_schema=False)
@app.get("/icon-512.png", include_in_schema=False)
@app.get("/site.webmanifest", include_in_schema=False)
async def serve_frontend_root_static(request: Request):
    file_name = request.url.path.rsplit("/", 1)[-1]
    return frontend_root_static_response(file_name)


@app.get("/{full_path:path}", include_in_schema=False)
async def serve_spa(full_path: str = ""):  # noqa: ARG001
    index = DIST / "index.html"
    if index.exists():
        return FileResponse(str(index))
    return frontend_not_built_response()
