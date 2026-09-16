from __future__ import annotations

import os
import unittest

from claudesk.api.process_jobs import (
    ProcessJobError,
    collect_process_job,
    start_process_job,
)


def _fake_success_worker(
    *,
    value: int,
    progress_cb,
) -> dict[str, object]:
    progress_cb({"phase": "starting", "value": value})
    progress_cb({"phase": "done", "value": value + 1})
    return {"value": value + 2}


def _fake_error_worker(
    *,
    progress_cb,
) -> dict[str, object]:
    progress_cb({"phase": "before-error"})
    raise RuntimeError("worker failed")


def _fake_exit_worker(
    *,
    progress_cb,
) -> dict[str, object]:
    progress_cb({"phase": "before-exit"})
    os._exit(5)


class ProcessJobTests(unittest.TestCase):
    def test_collect_process_job_returns_result_and_progress(self) -> None:
        progress: list[dict[str, object]] = []
        handle = start_process_job(
            module_name=__name__,
            function_name="_fake_success_worker",
            kwargs={"value": 40},
        )

        result = collect_process_job(
            handle,
            on_progress=progress.append,
            poll_interval=0.01,
        )

        self.assertEqual(result, {"value": 42})
        self.assertEqual(
            progress,
            [
                {"phase": "starting", "value": 40},
                {"phase": "done", "value": 41},
            ],
        )

    def test_collect_process_job_raises_worker_errors(self) -> None:
        progress: list[dict[str, object]] = []
        handle = start_process_job(
            module_name=__name__,
            function_name="_fake_error_worker",
        )

        with self.assertRaisesRegex(ProcessJobError, "worker failed"):
            collect_process_job(
                handle,
                on_progress=progress.append,
                poll_interval=0.01,
            )

        self.assertEqual(progress, [{"phase": "before-error"}])

    def test_collect_process_job_raises_nonzero_exit_without_error_message(self) -> None:
        progress: list[dict[str, object]] = []
        handle = start_process_job(
            module_name=__name__,
            function_name="_fake_exit_worker",
        )

        with self.assertRaisesRegex(ProcessJobError, "exited with code 5"):
            collect_process_job(
                handle,
                on_progress=progress.append,
                poll_interval=0.01,
            )
        self.assertEqual(progress, [])


if __name__ == "__main__":
    unittest.main()
