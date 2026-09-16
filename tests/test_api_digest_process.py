from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from claudesk.api import digest
from claudesk.core.config import Config
from claudesk.core.db import init_db
from claudesk.core.db.jobs import (
    create_job,
    get_job,
    list_job_failures,
    mark_job_failed,
    mark_job_running,
    request_job_cancel,
)
from claudesk.api.process_jobs import ProcessJobError
from claudesk.jobs import run_digest as digest_job
from claudesk.sources.base import Source


def make_conn(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


class _FakeProcess:
    def __init__(self, alive: bool = True) -> None:
        self.alive = alive
        self.pid = 12345

    def is_alive(self) -> bool:
        return self.alive


class _FakeHandle:
    def __init__(self, *, alive: bool = True) -> None:
        self.process = _FakeProcess(alive)
        self.terminated = False

    def terminate(self) -> None:
        self.terminated = True
        self.process.alive = False


def _reset_digest_state() -> None:
    with digest._active_lock:
        digest._active_jobs.clear()


def _create_digest_job(conn: sqlite3.Connection) -> int:
    job = create_job(
        conn,
        kind=digest.DIGEST_JOB_KIND,
        request={},
        dedupe_key=digest.DIGEST_DEDUPE_KEY,
        machine_id="test-machine",
        executor_kind="process",
    )
    digest._record_digest_progress(conn, job.id, digest._initial_digest_progress())
    conn.commit()
    return job.id


def _worker_conn(path: str):
    conn = make_conn(path)
    init_db(conn)
    return conn


class DigestProcessJobTests(unittest.TestCase):
    def setUp(self) -> None:
        self.enterContext(patch.object(
            digest, "_open_job_conn",
            side_effect=AssertionError("Tests must supply a temporary job database."),
        ))
        _reset_digest_state()

    def tearDown(self) -> None:
        # Handles are fakes; shutdown is tested while its temporary DB is patched.
        _reset_digest_state()

    def test_digest_job_collects_progress_and_result(self) -> None:
        tmpdir = tempfile.TemporaryDirectory()
        db_file = os.path.join(tmpdir.name, "claudesk.db")
        conn = make_conn(db_file)
        init_db(conn)
        job_id = _create_digest_job(conn)
        handle = _FakeHandle()
        result = {
            "created_at": "2026-05-16T12:30:00",
            "sources": ["arxiv"],
            "days_back": 1,
            "total_fetched": 3,
            "total_after_dedup": 2,
            "total_in_digest": 1,
            "total_new_papers": 1,
            "wrote_to_db": True,
        }

        def fake_collect(_handle, *, on_progress):
            on_progress(
                {
                    "phase": "ranking",
                    "message": "Ranking...",
                    "sources": [],
                    "source_count": 1,
                    "sources_completed": 0,
                    "total_fetched": 3,
                    "total_fetch_target": 200,
                    "total_after_dedup": 2,
                    "total_in_digest": None,
                }
            )
            return result

        with (
            patch.object(digest, "default_machine_id", return_value="test-machine"),
            patch.object(digest, "_open_job_conn", side_effect=lambda: _worker_conn(db_file)),
            patch.object(digest, "start_process_job", return_value=handle) as start_mock,
            patch.object(digest, "collect_process_job", side_effect=fake_collect),
        ):
            digest._run_digest_job(job_id)

        start_mock.assert_called_once_with(
            module_name="claudesk.jobs.run_digest",
            function_name="run_digest_once",
        )
        try:
            state = digest._snapshot_state(conn)
            self.assertFalse(state.running)
            self.assertIsNone(state.last_error)
            self.assertEqual(get_job(conn, job_id).status, "succeeded")  # type: ignore[union-attr]
            self.assertEqual(state.progress.phase if state.progress else None, "done")
            self.assertEqual(
                state.progress.message if state.progress else None,
                "Digest updated with 1 papers.",
            )
            self.assertEqual(state.progress.total_fetch_target if state.progress else None, 200)
            self.assertEqual(state.progress.sources_completed if state.progress else None, 1)
            self.assertNotIn(job_id, digest._active_jobs)
        finally:
            conn.close()
            tmpdir.cleanup()

    def test_digest_success_preserves_source_errors_in_progress(self) -> None:
        tmpdir = tempfile.TemporaryDirectory()
        db_file = os.path.join(tmpdir.name, "claudesk.db")
        conn = make_conn(db_file)
        init_db(conn)
        job_id = _create_digest_job(conn)
        handle = _FakeHandle()
        result = {
            "created_at": "2026-05-16T12:30:00",
            "sources": ["pubmed", "arxiv"],
            "days_back": 1,
            "total_fetched": 3,
            "total_after_dedup": 2,
            "total_in_digest": 1,
            "total_new_papers": 1,
            "wrote_to_db": True,
        }

        def fake_collect(_handle, *, on_progress):
            on_progress(
                {
                    "phase": "ranking",
                    "message": "Ranking...",
                    "sources": [
                        {
                            "name": "pubmed",
                            "status": "error",
                            "fetched": 0,
                            "target": 200,
                            "error": "414 Request-URI Too Long",
                        },
                        {
                            "name": "arxiv",
                            "status": "done",
                            "fetched": 3,
                            "target": 200,
                            "error": None,
                        },
                    ],
                    "source_count": 2,
                    "sources_completed": 2,
                    "total_fetched": 3,
                    "total_fetch_target": 400,
                    "total_after_dedup": 2,
                    "total_in_digest": None,
                }
            )
            return result

        with (
            patch.object(digest, "default_machine_id", return_value="test-machine"),
            patch.object(digest, "_open_job_conn", side_effect=lambda: _worker_conn(db_file)),
            patch.object(digest, "start_process_job", return_value=handle),
            patch.object(digest, "collect_process_job", side_effect=fake_collect),
        ):
            digest._run_digest_job(job_id)

        try:
            state = digest._snapshot_state(conn)
            self.assertEqual(state.progress.phase if state.progress else None, "done")
            self.assertEqual(state.progress.total_fetch_target if state.progress else None, 400)
            self.assertIsNotNone(state.progress)
            sources = state.progress.sources if state.progress else []
            self.assertEqual(len(sources), 2)
            self.assertEqual(sources[0].name, "pubmed")
            self.assertEqual(sources[0].status, "error")
            self.assertEqual(sources[0].error, "414 Request-URI Too Long")
        finally:
            conn.close()
            tmpdir.cleanup()

    def test_digest_job_records_process_errors(self) -> None:
        tmpdir = tempfile.TemporaryDirectory()
        db_file = os.path.join(tmpdir.name, "claudesk.db")
        conn = make_conn(db_file)
        init_db(conn)
        job_id = _create_digest_job(conn)
        handle = _FakeHandle()

        def fake_collect(_handle, *, on_progress):
            on_progress({"phase": "ranking", "message": "Ranking..."})
            raise ProcessJobError("Process-backed job exited with code 5.")

        with (
            patch.object(digest, "default_machine_id", return_value="test-machine"),
            patch.object(digest, "_open_job_conn", side_effect=lambda: _worker_conn(db_file)),
            patch.object(digest, "start_process_job", return_value=handle),
            patch.object(digest, "collect_process_job", side_effect=fake_collect),
        ):
            digest._run_digest_job(job_id)

        try:
            state = digest._snapshot_state(conn)
            self.assertFalse(state.running)
            self.assertEqual(state.last_error, "Process-backed job exited with code 5.")
            self.assertEqual(state.progress.phase if state.progress else None, "error")
            self.assertEqual(get_job(conn, job_id).status, "failed")  # type: ignore[union-attr]
            self.assertNotIn(job_id, digest._active_jobs)
        finally:
            conn.close()
            tmpdir.cleanup()

    def test_digest_job_records_process_start_failures_as_first_attempt(self) -> None:
        tmpdir = tempfile.TemporaryDirectory()
        db_file = os.path.join(tmpdir.name, "claudesk.db")
        conn = make_conn(db_file)
        init_db(conn)
        job_id = _create_digest_job(conn)

        with (
            patch.object(digest, "_open_job_conn", side_effect=lambda: _worker_conn(db_file)),
            patch.object(digest, "start_process_job", side_effect=RuntimeError("spawn failed")),
        ):
            digest._run_digest_job(job_id)

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

    def test_digest_job_terminates_process_when_parent_persistence_fails(self) -> None:
        tmpdir = tempfile.TemporaryDirectory()
        db_file = os.path.join(tmpdir.name, "claudesk.db")
        conn = make_conn(db_file)
        init_db(conn)
        job_id = _create_digest_job(conn)
        handle = _FakeHandle()

        with (
            patch.object(digest, "_open_job_conn", side_effect=lambda: _worker_conn(db_file)),
            patch.object(digest, "start_process_job", return_value=handle),
            patch.object(digest, "mark_job_running", side_effect=RuntimeError("db write failed")),
        ):
            digest._run_digest_job(job_id)

        try:
            job = get_job(conn, job_id)
            failures = list_job_failures(conn, job_id)
            self.assertTrue(handle.terminated)
            self.assertEqual(job.status if job else None, "failed")
            self.assertEqual(failures[0].message, "db write failed")
            self.assertNotIn(job_id, digest._active_jobs)
        finally:
            conn.close()
            tmpdir.cleanup()

    def test_run_digest_preserves_already_running_response(self) -> None:
        tmpdir = tempfile.TemporaryDirectory()
        conn = make_conn(os.path.join(tmpdir.name, "claudesk.db"))
        init_db(conn)
        try:
            job_id = _create_digest_job(conn)
            mark_job_running(
                conn,
                job_id,
                machine_id="test-machine",
                executor_kind="process",
            )
            conn.commit()

            state = digest.run_digest(conn=conn)

            self.assertTrue(state.running)
            self.assertEqual(state.launch_state, "already_running")
        finally:
            conn.close()
            tmpdir.cleanup()

    def test_shutdown_digest_job_terminates_active_process(self) -> None:
        tmpdir = tempfile.TemporaryDirectory()
        db_file = os.path.join(tmpdir.name, "claudesk.db")
        conn = make_conn(db_file)
        init_db(conn)
        job_id = _create_digest_job(conn)
        handle = _FakeHandle()
        with digest._active_lock:
            digest._active_jobs[job_id] = handle

        try:
            with patch.object(digest, "_open_job_conn", side_effect=lambda: _worker_conn(db_file)):
                digest.shutdown_digest_job()

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
                    patch.dict(digest._active_jobs, {1: first, 2: second}, clear=True),
                    patch.object(digest, "_open_job_conn", return_value=conn) as open_conn,
                    patch.object(digest, "get_job", return_value=None) as lookup,
                    patch.object(first, "terminate", wraps=first.terminate) as terminate,
                ):
                    actions = {"open": open_conn, "lookup": lookup, "commit": conn.commit, "close": conn.close, "terminate": terminate}
                    actions[stage].side_effect = RuntimeError(f"{stage} failed")
                    with self.assertRaisesRegex(RuntimeError, f"{stage} failed"):
                        digest.shutdown_digest_job()
                    terminate.assert_called_once()
                self.assertTrue(second.terminated)
                if stage != "terminate":
                    self.assertTrue(first.terminated)

    def test_cancel_digest_terminates_active_process(self) -> None:
        tmpdir = tempfile.TemporaryDirectory()
        conn = make_conn(os.path.join(tmpdir.name, "claudesk.db"))
        init_db(conn)
        job_id = _create_digest_job(conn)
        mark_job_running(conn, job_id, machine_id="test-machine", executor_kind="process")
        digest._record_digest_progress(
            conn,
            job_id,
            {"phase": "fetching", "message": "Fetching PubMed..."},
        )
        conn.commit()
        handle = _FakeHandle()
        with digest._active_lock:
            digest._active_jobs[job_id] = handle

        try:
            state = digest.cancel_digest(conn=conn)

            self.assertTrue(handle.terminated)
            self.assertTrue(state.running)
            self.assertIsNone(state.last_error)
            self.assertEqual(state.progress.phase if state.progress else None, "cancelling")
            self.assertEqual(
                state.progress.message if state.progress else None,
                "Stopping digest fetch...",
            )
            job = get_job(conn, job_id)
            self.assertEqual(job.status if job else None, "cancelling")
            self.assertIsNotNone(job.cancel_requested_at if job else None)
        finally:
            conn.close()
            tmpdir.cleanup()

    def test_cancel_digest_before_active_process_is_honored(self) -> None:
        tmpdir = tempfile.TemporaryDirectory()
        db_file = os.path.join(tmpdir.name, "claudesk.db")
        conn = make_conn(db_file)
        init_db(conn)
        job_id = _create_digest_job(conn)
        cancelling_state = digest.cancel_digest(conn=conn)

        try:
            with (
                patch.object(digest, "_open_job_conn", side_effect=lambda: _worker_conn(db_file)),
                patch.object(digest, "start_process_job") as start_mock,
            ):
                digest._run_digest_job(job_id)

            state = digest._snapshot_state(conn)
            self.assertTrue(cancelling_state.running)
            start_mock.assert_not_called()
            self.assertFalse(state.running)
            self.assertIsNone(state.last_error)
            self.assertEqual(state.progress.phase if state.progress else None, "cancelled")
            self.assertEqual(
                state.progress.message if state.progress else None,
                "Digest fetch stopped.",
            )
        finally:
            conn.close()
            tmpdir.cleanup()

    def test_digest_success_racing_with_cancel_preserves_result(self) -> None:
        tmpdir = tempfile.TemporaryDirectory()
        db_file = os.path.join(tmpdir.name, "claudesk.db")
        conn = make_conn(db_file)
        init_db(conn)
        job_id = _create_digest_job(conn)
        worker_conn: sqlite3.Connection | None = None
        handle = _FakeHandle(alive=False)
        result = {
            "created_at": "2026-05-16T12:30:00",
            "sources": ["arxiv"],
            "days_back": 1,
            "total_fetched": 3,
            "total_after_dedup": 2,
            "total_in_digest": 1,
            "total_new_papers": 1,
            "wrote_to_db": True,
        }

        def fake_open_job_conn():
            nonlocal worker_conn
            worker_conn = _worker_conn(db_file)
            return worker_conn

        def fake_collect(_handle, *, on_progress):
            self.assertIsNotNone(worker_conn)
            request_job_cancel(
                worker_conn,
                job_id,
                progress={"phase": "cancelling", "message": "Stopping digest fetch..."},
            )
            worker_conn.commit()
            return result

        try:
            with (
                patch.object(digest, "default_machine_id", return_value="test-machine"),
                patch.object(digest, "_open_job_conn", side_effect=fake_open_job_conn),
                patch.object(digest, "start_process_job", return_value=handle),
                patch.object(digest, "collect_process_job", side_effect=fake_collect),
            ):
                digest._run_digest_job(job_id)

            state = digest._snapshot_state(conn)
            self.assertFalse(handle.terminated)
            self.assertFalse(state.running)
            self.assertIsNone(state.last_error)
            self.assertEqual(get_job(conn, job_id).status, "succeeded")  # type: ignore[union-attr]
            self.assertEqual(state.progress.phase if state.progress else None, "done")
            self.assertEqual(
                state.progress.message if state.progress else None,
                "Digest updated with 1 papers.",
            )
        finally:
            conn.close()
            tmpdir.cleanup()

    def test_run_digest_once_records_zero_result_digest_run(self) -> None:
        tmpdir = tempfile.TemporaryDirectory()
        conn = make_conn(os.path.join(tmpdir.name, "claudesk.db"))
        init_db(conn)
        source = Source(name="arxiv", fetch=lambda _since: [])
        progress_events: list[dict[str, object]] = []

        try:
            with (
                patch.object(digest_job, "load_config", return_value=Config()),
                patch.object(digest_job, "_resolve_sources", return_value=[source]),
                patch.object(digest_job, "dedupe", return_value=[]),
                patch.object(digest_job, "rank", return_value=[]),
            ):
                result = digest_job.run_digest_once(
                    source="arxiv",
                    days=1,
                    conn=conn,
                    progress_cb=progress_events.append,
                )

            runs = conn.execute(
                """
                SELECT
                    days_back,
                    sources_json,
                    total_fetched,
                    total_after_dedup,
                    total_in_digest,
                    total_new_papers
                FROM digest_runs
                """
            ).fetchall()
            self.assertTrue(result["wrote_to_db"])
            self.assertEqual(result["total_in_digest"], 0)
            self.assertEqual(result["total_new_papers"], 0)
            self.assertEqual(len(runs), 1)
            self.assertEqual(
                (
                    runs[0]["days_back"],
                    runs[0]["sources_json"],
                    runs[0]["total_fetched"],
                    runs[0]["total_after_dedup"],
                    runs[0]["total_in_digest"],
                    runs[0]["total_new_papers"],
                ),
                (1, '["arxiv"]', 0, 0, 0, 0),
            )
            self.assertEqual(progress_events[-1]["phase"], "done")
        finally:
            conn.close()
            tmpdir.cleanup()

    def test_run_digest_once_emits_live_source_fetch_counts(self) -> None:
        tmpdir = tempfile.TemporaryDirectory()
        conn = make_conn(os.path.join(tmpdir.name, "claudesk.db"))
        init_db(conn)
        progress_events: list[dict[str, object]] = []

        def fetch_with_progress(_since, *, progress_cb=None):
            if progress_cb is not None:
                progress_cb({"event": "source_progress", "count": 2, "target": 200})
            return []

        source = Source(name="arxiv", fetch=fetch_with_progress)

        try:
            with (
                patch.object(digest_job, "load_config", return_value=Config()),
                patch.object(digest_job, "_resolve_sources", return_value=[source]),
                patch.object(digest_job, "dedupe", return_value=[]),
                patch.object(digest_job, "rank", return_value=[]),
            ):
                digest_job.run_digest_once(
                    source="arxiv",
                    days=1,
                    conn=conn,
                    progress_cb=progress_events.append,
                )

            live_events = [
                event
                for event in progress_events
                if event.get("phase") == "fetching"
                and event.get("total_fetched") == 2
            ]
            self.assertTrue(live_events)
            self.assertEqual(live_events[-1]["total_fetch_target"], 200)
            self.assertEqual(live_events[-1]["source_count"], 1)
        finally:
            conn.close()
            tmpdir.cleanup()

    def test_snapshot_hydrates_latest_persisted_digest_run(self) -> None:
        tmpdir = tempfile.TemporaryDirectory()
        conn = make_conn(os.path.join(tmpdir.name, "claudesk.db"))
        init_db(conn)
        conn.execute(
            """
            INSERT INTO digest_runs (
                created_at,
                days_back,
                sources_json,
                total_fetched,
                total_after_dedup,
                total_in_digest,
                total_new_papers
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            ("2026-05-16T12:30:00", 60, '["arxiv", "pubmed"]', 12, 10, 4, 3),
        )
        conn.commit()

        try:
            state = digest._snapshot_state(conn)

            self.assertFalse(state.running)
            self.assertEqual(state.finished_at, "2026-05-16T12:30:00")
            self.assertIsNotNone(state.last_result)
            self.assertEqual(state.last_result.days_back if state.last_result else None, 60)
            self.assertEqual(
                state.last_result.sources if state.last_result else None,
                ["arxiv", "pubmed"],
            )
            self.assertEqual(
                state.last_result.total_new_papers if state.last_result else None,
                3,
            )
            self.assertEqual(
                state.last_result.created_at if state.last_result else None,
                "2026-05-16T12:30:00",
            )
        finally:
            conn.close()
            tmpdir.cleanup()

    def test_snapshot_keeps_failed_attempt_separate_from_persisted_summary(self) -> None:
        tmpdir = tempfile.TemporaryDirectory()
        conn = make_conn(os.path.join(tmpdir.name, "claudesk.db"))
        init_db(conn)
        conn.execute(
            """
            INSERT INTO digest_runs (
                created_at,
                days_back,
                sources_json,
                total_fetched,
                total_after_dedup,
                total_in_digest,
                total_new_papers
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            ("2026-05-16T12:30:00", 60, '["arxiv"]', 12, 10, 4, 3),
        )
        conn.commit()
        job = create_job(
            conn,
            kind=digest.DIGEST_JOB_KIND,
            request={},
            dedupe_key=digest.DIGEST_DEDUPE_KEY,
        )
        mark_job_running(conn, job.id, machine_id="test-machine", executor_kind="process")
        mark_job_failed(
            conn,
            job.id,
            error_type="RuntimeError",
            message="Digest fetch failed for all sources.",
            progress={
                "phase": "error",
                "message": "Digest fetch failed for all sources.",
            },
            now="2026-05-17T08:00:00",
        )
        conn.commit()

        try:
            state = digest._snapshot_state(conn)

            self.assertFalse(state.running)
            self.assertEqual(state.finished_at, "2026-05-17T08:00:00")
            self.assertEqual(state.last_error, "Digest fetch failed for all sources.")
            self.assertEqual(state.progress.phase if state.progress else None, "error")
            self.assertIsNotNone(state.last_result)
            self.assertEqual(
                state.last_result.created_at if state.last_result else None,
                "2026-05-16T12:30:00",
            )
            self.assertEqual(
                state.last_result.total_new_papers if state.last_result else None,
                3,
            )
        finally:
            conn.close()
            tmpdir.cleanup()

    def test_run_digest_once_all_source_failures_do_not_record_digest_run(self) -> None:
        tmpdir = tempfile.TemporaryDirectory()
        conn = make_conn(os.path.join(tmpdir.name, "claudesk.db"))
        init_db(conn)

        def failing_fetch(message: str):
            def fetch(_since):
                raise RuntimeError(message)

            return fetch

        sources = [
            Source(name="arxiv", fetch=failing_fetch("arxiv unavailable")),
            Source(name="biorxiv", fetch=failing_fetch("biorxiv unavailable")),
        ]

        try:
            with (
                patch.object(digest_job, "load_config", return_value=Config()),
                patch.object(digest_job, "_resolve_sources", return_value=sources),
                patch.object(digest_job, "dedupe") as dedupe_mock,
                patch.object(digest_job, "rank") as rank_mock,
                patch.object(digest_job, "write_digest") as write_mock,
                patch("claudesk.pipeline.fetch.logger.error"),
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "Digest fetch failed for all sources.*"
                    "arxiv: arxiv unavailable.*"
                    "biorxiv: biorxiv unavailable",
                ):
                    digest_job.run_digest_once(
                        days=1,
                        conn=conn,
                        progress_cb=lambda _event: None,
                    )

            dedupe_mock.assert_not_called()
            rank_mock.assert_not_called()
            write_mock.assert_not_called()
            run_count = conn.execute("SELECT COUNT(*) FROM digest_runs").fetchone()[0]
            self.assertEqual(run_count, 0)
        finally:
            conn.close()
            tmpdir.cleanup()


if __name__ == "__main__":
    unittest.main()
