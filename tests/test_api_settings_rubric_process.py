from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from claudesk.api import settings
from claudesk.api.process_jobs import ProcessJobError
from claudesk.core.db import init_db
from claudesk.core.db.jobs import create_job, get_job, list_job_failures, mark_job_running


def make_conn(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


class _FakeProcess:
    pid = 12345


class _FakeHandle:
    def __init__(self) -> None:
        self.process = _FakeProcess()
        self.terminated = False

    def terminate(self) -> None:
        self.terminated = True


def _reset_rubric_state() -> None:
    with settings._rubric_active_lock:
        settings._active_rubric_jobs.clear()


def _create_rubric_job(
    conn: sqlite3.Connection,
    *,
    scope: str = "saved",
    refresh_existing: bool = False,
) -> int:
    job = create_job(
        conn,
        kind=settings.RUBRIC_JOB_KIND,
        request={"scope": scope, "refresh_existing": refresh_existing},
        dedupe_key=settings.RUBRIC_DEDUPE_KEY,
        machine_id="test-machine",
        executor_kind="process",
    )
    settings._record_rubric_progress(
        conn,
        job.id,
        settings._initial_rubric_progress(scope, refresh_existing),
    )
    conn.commit()
    return job.id


def _worker_conn(path: str):
    conn = make_conn(path)
    init_db(conn)
    return conn


class RubricProcessJobTests(unittest.TestCase):
    def setUp(self) -> None:
        self.enterContext(patch.object(
            settings, "_open_job_conn",
            side_effect=AssertionError("Tests must supply a temporary job database."),
        ))
        _reset_rubric_state()

    def tearDown(self) -> None:
        # Handles are fakes; shutdown is tested while its temporary DB is patched.
        _reset_rubric_state()

    def test_rubric_job_collects_progress_and_result(self) -> None:
        tmpdir = tempfile.TemporaryDirectory()
        db_file = os.path.join(tmpdir.name, "claudesk.db")
        conn = make_conn(db_file)
        init_db(conn)
        job_id = _create_rubric_job(conn)
        handle = _FakeHandle()
        result = {
            "scope": "saved",
            "refresh_existing": False,
            "total_papers": 3,
            "processed_papers": 3,
            "changed_papers": 2,
        }

        def fake_collect(_handle, *, on_progress):
            on_progress(
                {
                    "scope": "saved",
                    "refresh_existing": False,
                    "message": "Processed 3 of 3 papers.",
                    "total_papers": 3,
                    "processed_papers": 3,
                    "changed_papers": 2,
                    "current_title": None,
                    "batch_size": 3,
                }
            )
            return result

        with (
            patch.object(settings, "default_machine_id", return_value="test-machine"),
            patch.object(settings, "_open_job_conn", side_effect=lambda: _worker_conn(db_file)),
            patch.object(settings, "start_process_job", return_value=handle) as start_mock,
            patch.object(settings, "collect_process_job", side_effect=fake_collect),
        ):
            settings._run_rubric_job(job_id, "saved", False)

        start_mock.assert_called_once_with(
            module_name="claudesk.jobs.run_rubric_scoring",
            function_name="run_rubric_scoring_once",
            kwargs={
                "scope": "saved",
                "refresh_existing": False,
            },
        )
        try:
            state = settings._snapshot_state(conn)
            self.assertFalse(state.running)
            self.assertIsNone(state.last_error)
            self.assertEqual(state.last_result.changed_papers if state.last_result else None, 2)
            self.assertEqual(state.progress.processed_papers if state.progress else None, 3)
            self.assertEqual(get_job(conn, job_id).status, "succeeded")  # type: ignore[union-attr]
            self.assertNotIn(job_id, settings._active_rubric_jobs)
        finally:
            conn.close()
            tmpdir.cleanup()

    def test_rubric_job_records_process_errors(self) -> None:
        tmpdir = tempfile.TemporaryDirectory()
        db_file = os.path.join(tmpdir.name, "claudesk.db")
        conn = make_conn(db_file)
        init_db(conn)
        job_id = _create_rubric_job(conn, scope="all", refresh_existing=True)
        handle = _FakeHandle()

        def fake_collect(_handle, *, on_progress):
            on_progress(
                {
                    "scope": "all",
                    "refresh_existing": True,
                    "message": "Requesting scores...",
                }
            )
            raise ProcessJobError("Process-backed job exited with code 5.")

        with (
            patch.object(settings, "default_machine_id", return_value="test-machine"),
            patch.object(settings, "_open_job_conn", side_effect=lambda: _worker_conn(db_file)),
            patch.object(settings, "start_process_job", return_value=handle),
            patch.object(settings, "collect_process_job", side_effect=fake_collect),
        ):
            settings._run_rubric_job(job_id, "all", True)

        try:
            state = settings._snapshot_state(conn)
            self.assertFalse(state.running)
            self.assertEqual(state.last_error, "Process-backed job exited with code 5.")
            self.assertEqual(state.progress.message if state.progress else None, state.last_error)
            self.assertEqual(get_job(conn, job_id).status, "failed")  # type: ignore[union-attr]
            self.assertNotIn(job_id, settings._active_rubric_jobs)
        finally:
            conn.close()
            tmpdir.cleanup()

    def test_rubric_job_records_process_start_failures_as_first_attempt(self) -> None:
        tmpdir = tempfile.TemporaryDirectory()
        db_file = os.path.join(tmpdir.name, "claudesk.db")
        conn = make_conn(db_file)
        init_db(conn)
        job_id = _create_rubric_job(conn, scope="all", refresh_existing=True)

        with (
            patch.object(settings, "_open_job_conn", side_effect=lambda: _worker_conn(db_file)),
            patch.object(settings, "start_process_job", side_effect=RuntimeError("spawn failed")),
        ):
            settings._run_rubric_job(job_id, "all", True)

        try:
            job = get_job(conn, job_id)
            failures = list_job_failures(conn, job_id)
            self.assertEqual(job.status if job else None, "failed")
            self.assertEqual(job.attempt_count if job else None, 1)
            self.assertEqual(failures[0].attempt, 1)
            self.assertEqual(failures[0].message, "spawn failed")
        finally:
            conn.close()
            tmpdir.cleanup()

    def test_rubric_job_terminates_process_when_parent_persistence_fails(self) -> None:
        tmpdir = tempfile.TemporaryDirectory()
        db_file = os.path.join(tmpdir.name, "claudesk.db")
        conn = make_conn(db_file)
        init_db(conn)
        job_id = _create_rubric_job(conn, scope="all", refresh_existing=True)
        handle = _FakeHandle()

        with (
            patch.object(settings, "_open_job_conn", side_effect=lambda: _worker_conn(db_file)),
            patch.object(settings, "start_process_job", return_value=handle),
            patch.object(settings, "mark_job_running", side_effect=RuntimeError("db write failed")),
        ):
            settings._run_rubric_job(job_id, "all", True)

        try:
            job = get_job(conn, job_id)
            failures = list_job_failures(conn, job_id)
            self.assertTrue(handle.terminated)
            self.assertEqual(job.status if job else None, "failed")
            self.assertEqual(failures[0].message, "db write failed")
            self.assertNotIn(job_id, settings._active_rubric_jobs)
        finally:
            conn.close()
            tmpdir.cleanup()

    def test_run_rubric_preserves_already_running_response(self) -> None:
        tmpdir = tempfile.TemporaryDirectory()
        conn = make_conn(os.path.join(tmpdir.name, "claudesk.db"))
        init_db(conn)
        job_id = _create_rubric_job(conn, scope="all", refresh_existing=True)
        mark_job_running(
            conn,
            job_id,
            machine_id="test-machine",
            executor_kind="process",
        )
        conn.commit()
        cfg = SimpleNamespace(llm=SimpleNamespace(api_key="test-key"))

        try:
            with patch.object(settings, "load_config", return_value=cfg):
                state = settings.run_rubric_scoring(
                    settings.RubricRunRequest(scope="all", refresh_existing=True),
                    conn=conn,
                )

            self.assertTrue(state.running)
            self.assertEqual(state.launch_state, "already_running")
        finally:
            conn.close()
            tmpdir.cleanup()

    def test_shutdown_rubric_job_terminates_active_process(self) -> None:
        tmpdir = tempfile.TemporaryDirectory()
        db_file = os.path.join(tmpdir.name, "claudesk.db")
        conn = make_conn(db_file)
        init_db(conn)
        job_id = _create_rubric_job(conn)
        handle = _FakeHandle()
        with settings._rubric_active_lock:
            settings._active_rubric_jobs[job_id] = handle

        try:
            with patch.object(settings, "_open_job_conn", side_effect=lambda: _worker_conn(db_file)):
                settings.shutdown_rubric_job()

            self.assertTrue(handle.terminated)
        finally:
            conn.close()
            tmpdir.cleanup()


    def test_shutdown_terminates_remaining_processes_after_bookkeeping_or_handle_failure(self) -> None:
        for stage in ("open", "lookup", "commit", "close", "terminate"):
            with self.subTest(stage=stage):
                conn = MagicMock()
                first, second = _FakeHandle(), _FakeHandle()
                with (
                    patch.dict(settings._active_rubric_jobs, {1: first, 2: second}, clear=True),
                    patch.object(settings, "_open_job_conn", return_value=conn) as open_conn,
                    patch.object(settings, "get_job", return_value=None) as lookup,
                    patch.object(first, "terminate", wraps=first.terminate) as terminate,
                ):
                    actions = {"open": open_conn, "lookup": lookup, "commit": conn.commit, "close": conn.close, "terminate": terminate}
                    actions[stage].side_effect = RuntimeError(f"{stage} failed")
                    with self.assertRaisesRegex(RuntimeError, f"{stage} failed"):
                        settings.shutdown_rubric_job()
                    terminate.assert_called_once()
                self.assertTrue(second.terminated)
                if stage != "terminate":
                    self.assertTrue(first.terminated)


if __name__ == "__main__":
    unittest.main()
