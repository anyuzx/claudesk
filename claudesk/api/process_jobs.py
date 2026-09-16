from __future__ import annotations

import importlib
import multiprocessing
import queue
from dataclasses import dataclass
from multiprocessing.process import BaseProcess
from typing import Any, Callable

ProgressCallback = Callable[[dict[str, object]], None]


class ProcessJobError(RuntimeError):
    """Raised when a process-backed API job fails."""


@dataclass
class ProcessJobHandle:
    process: BaseProcess
    messages: Any

    def terminate(self, *, timeout: float = 5.0) -> None:
        if self.process.is_alive():
            self.process.terminate()
            self.process.join(timeout)
        if self.process.is_alive():
            self.process.kill()
            self.process.join(timeout)
        self.close()

    def close(self) -> None:
        close = getattr(self.messages, "close", None)
        if close is not None:
            close()
        join_thread = getattr(self.messages, "join_thread", None)
        if join_thread is not None:
            join_thread()


def _process_job_child(
    messages: Any,
    module_name: str,
    function_name: str,
    kwargs: dict[str, object],
) -> None:
    def progress_cb(progress: dict[str, object]) -> None:
        messages.put({"type": "progress", "payload": progress})

    try:
        module = importlib.import_module(module_name)
        function = getattr(module, function_name)
        result = function(**kwargs, progress_cb=progress_cb)
        messages.put({"type": "result", "payload": result})
    except BaseException as exc:
        messages.put(
            {
                "type": "error",
                "error": str(exc),
            }
        )


def start_process_job(
    *,
    module_name: str,
    function_name: str,
    kwargs: dict[str, object] | None = None,
) -> ProcessJobHandle:
    ctx = multiprocessing.get_context("spawn")
    messages = ctx.Queue()
    process = ctx.Process(
        target=_process_job_child,
        args=(messages, module_name, function_name, dict(kwargs or {})),
    )
    process.start()
    return ProcessJobHandle(process=process, messages=messages)


def collect_process_job(
    handle: ProcessJobHandle,
    *,
    on_progress: ProgressCallback,
    poll_interval: float = 0.1,
) -> dict[str, object]:
    result: dict[str, object] | None = None
    error: str | None = None

    def handle_message(message: object) -> None:
        nonlocal result, error
        message_type = message.get("type") if isinstance(message, dict) else None
        if message_type == "progress":
            payload = message.get("payload")
            if isinstance(payload, dict):
                on_progress(payload)
        elif message_type == "result":
            payload = message.get("payload")
            result = payload if isinstance(payload, dict) else {}
        elif message_type == "error":
            error = str(message.get("error") or "Process-backed job failed.")

    try:
        while True:
            try:
                message = handle.messages.get(timeout=poll_interval)
            except queue.Empty:
                if not handle.process.is_alive():
                    break
                continue

            handle_message(message)

        handle.process.join()

        while True:
            try:
                message = handle.messages.get_nowait()
            except queue.Empty:
                break
            handle_message(message)

        if error is not None:
            raise ProcessJobError(error)
        if handle.process.exitcode not in (0, None):
            raise ProcessJobError(
                f"Process-backed job exited with code {handle.process.exitcode}."
            )
        if result is None:
            raise ProcessJobError("Process-backed job finished without a result.")
        return result
    finally:
        handle.close()
