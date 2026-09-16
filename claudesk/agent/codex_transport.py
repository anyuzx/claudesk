from __future__ import annotations

import asyncio
import contextlib
import errno
import json
import os
from pathlib import Path
from typing import Any, Mapping

from claudesk.core.config import project_root

CODEX_STDIO_LIMIT_BYTES = 8 * 1024 * 1024
CODEX_APP_SERVER_START_RETRIES = 3
CODEX_APP_SERVER_START_RETRY_DELAY_SECONDS = 0.25
TRANSIENT_SUBPROCESS_ERRNOS = {errno.EAGAIN, errno.EWOULDBLOCK, 35}


class CodexAppServerError(RuntimeError):
    pass


def _jsonrpc_request(request_id: int, method: str, params: dict | None = None) -> dict:
    payload: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        payload["params"] = params
    return payload


def _jsonrpc_notification(method: str, params: dict | None = None) -> dict:
    payload: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        payload["params"] = params
    return payload


class JsonlRpcTransport:
    def __init__(
        self,
        command: list[str],
        cwd: str | Path | None = None,
        env: Mapping[str, str] | None = None,
    ) -> None:
        self.command = command
        self.cwd = Path(cwd).resolve() if cwd is not None else project_root()
        self.env = {**os.environ, **env} if env is not None else None
        self.process: asyncio.subprocess.Process | None = None
        self._next_id = 1
        self._pending: dict[int, asyncio.Future] = {}
        self.notifications: asyncio.Queue[dict] = asyncio.Queue()
        self.stderr_lines: list[str] = []
        self.recent_messages: list[str] = []
        self._reader_task: asyncio.Task | None = None
        self._stderr_task: asyncio.Task | None = None
        self._write_lock = asyncio.Lock()

    async def start(self) -> None:
        for attempt in range(CODEX_APP_SERVER_START_RETRIES):
            try:
                self.process = await asyncio.create_subprocess_exec(
                    *self.command,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=str(self.cwd),
                    env=self.env,
                    limit=CODEX_STDIO_LIMIT_BYTES,
                )
                self._reader_task = asyncio.create_task(self._read_stdout())
                self._stderr_task = asyncio.create_task(self._read_stderr())
                return
            except BlockingIOError as exc:
                self.process = None
                if exc.errno not in TRANSIENT_SUBPROCESS_ERRNOS:
                    raise
                if attempt == CODEX_APP_SERVER_START_RETRIES - 1:
                    raise CodexAppServerError(
                        "Codex app-server could not start because the OS temporarily refused "
                        "to create a subprocess (errno 35 / EAGAIN). This usually means local "
                        "process resources are exhausted; close stale Codex, Ghostty, or "
                        "Claudesk processes, then restart Claudesk and try again."
                    ) from exc
                await asyncio.sleep(CODEX_APP_SERVER_START_RETRY_DELAY_SECONDS * (attempt + 1))

    @property
    def alive(self) -> bool:
        reader_alive = self._reader_task is None or not self._reader_task.done()
        return self.process is not None and self.process.returncode is None and reader_alive

    async def request(self, method: str, params: dict | None = None, *, timeout: float = 120.0) -> dict:
        if self.process is None or self.process.stdin is None or not self.alive:
            raise CodexAppServerError("Codex app-server is not running.")
        request_id = self._next_id
        self._next_id += 1
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self._pending[request_id] = future
        await self._write(_jsonrpc_request(request_id, method, params))
        try:
            response = await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError as exc:
            detail = f"Codex app-server request timed out: {method}."
            if self.stderr_lines:
                detail += "\nRecent stderr:\n" + "\n".join(self.stderr_lines[-20:])
            if self.recent_messages:
                detail += "\nRecent app-server messages:\n" + "\n".join(self.recent_messages[-20:])
            raise CodexAppServerError(detail) from exc
        finally:
            self._pending.pop(request_id, None)
        if "error" in response:
            raise CodexAppServerError(str(response["error"]))
        result = response.get("result")
        return result if isinstance(result, dict) else {}

    async def notify(self, method: str, params: dict | None = None) -> None:
        if self.process is None or self.process.stdin is None or not self.alive:
            raise CodexAppServerError("Codex app-server is not running.")
        await self._write(_jsonrpc_notification(method, params))

    async def _write(self, payload: dict) -> None:
        assert self.process is not None
        assert self.process.stdin is not None
        line = json.dumps(payload, separators=(",", ":")).encode("utf-8") + b"\n"
        async with self._write_lock:
            self.process.stdin.write(line)
            await self.process.stdin.drain()

    async def _read_stdout(self) -> None:
        assert self.process is not None
        assert self.process.stdout is not None
        try:
            while True:
                raw_line = await self.process.stdout.readuntil(b"\n")
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    await self.notifications.put({"method": "error", "params": {"message": line}})
                    continue
                rendered = json.dumps(message, ensure_ascii=False)[:1000]
                self.recent_messages.append(rendered)
                self.recent_messages[:] = self.recent_messages[-20:]

                if "id" in message and "method" not in message:
                    future = self._pending.get(message["id"])
                    if future and not future.done():
                        future.set_result(message)
                    continue

                if "id" in message and "method" in message:
                    await self.notifications.put(message)
                    await self._respond_to_server_request(message)
                    continue

                if "method" in message:
                    await self.notifications.put(message)
        except asyncio.IncompleteReadError as exc:
            if exc.partial:
                detail = "Codex app-server stdout ended with a partial JSONL message."
            else:
                detail = "\n".join(self.stderr_lines[-3:]) or f"process exited with code {self.process.returncode}"
            for future in list(self._pending.values()):
                if not future.done():
                    future.set_exception(CodexAppServerError(detail))
            await self.notifications.put({"method": "error", "params": {"message": detail}})
            await self.notifications.put({"method": "turn/completed", "params": {"threadId": None, "turn": {}}})
        except Exception as exc:
            if isinstance(exc, asyncio.LimitOverrunError):
                detail = f"Codex stdio line exceeded {CODEX_STDIO_LIMIT_BYTES} bytes before newline."
            else:
                detail = str(exc)
            for future in list(self._pending.values()):
                if not future.done():
                    future.set_exception(CodexAppServerError(detail))
            await self.notifications.put({"method": "error", "params": {"message": detail}})
            await self.notifications.put({"method": "turn/completed", "params": {"threadId": None, "turn": {}}})
        else:
            detail = "\n".join(self.stderr_lines[-3:]) or f"process exited with code {self.process.returncode}"
            for future in list(self._pending.values()):
                if not future.done():
                    future.set_exception(CodexAppServerError(detail))
            await self.notifications.put({"method": "error", "params": {"message": detail}})
            await self.notifications.put({"method": "turn/completed", "params": {"threadId": None, "turn": {}}})

    async def _read_stderr(self) -> None:
        assert self.process is not None
        assert self.process.stderr is not None
        async for raw_line in self.process.stderr:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if line:
                self.stderr_lines.append(line)
                self.stderr_lines[:] = self.stderr_lines[-20:]

    async def _respond_to_server_request(self, message: dict) -> None:
        request_id = message.get("id")
        if request_id is None or self.process is None or self.process.stdin is None:
            return
        method = str(message.get("method") or "")
        if method == "item/commandExecution/requestApproval":
            result: dict[str, Any] = {"decision": "decline"}
        elif method == "item/fileChange/requestApproval":
            result = {"decision": "decline"}
        elif method == "item/permissions/requestApproval":
            result = {
                "permissions": {"fileSystem": None, "network": None},
                "scope": "turn",
            }
        else:
            await self._write({
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32601, "message": f"Unsupported app-server request: {method}"},
            })
            return
        await self._write({"jsonrpc": "2.0", "id": request_id, "result": result})

    async def close(self) -> None:
        process = self.process
        if process is not None and process.stdin is not None:
            with contextlib.suppress(Exception):
                process.stdin.close()
                await process.stdin.wait_closed()
        if process is not None and process.returncode is None:
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(process.wait(), timeout=3)
            if process.returncode is None:
                process.terminate()
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(process.wait(), timeout=3)
        for task in (self._reader_task, self._stderr_task):
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
