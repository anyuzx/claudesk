from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest

from claudesk.core.db import SCHEMA_VERSION, init_db
from claudesk.core.db.jobs import (
    create_job,
    get_active_job_by_kind_dedupe_key,
    get_job,
    list_active_jobs_by_kind,
    list_job_events,
    list_job_failures,
    mark_job_cancelled,
    mark_job_failed,
    mark_job_running,
    mark_job_succeeded,
    reconcile_stale_jobs,
    request_job_cancel,
    reserve_job_attempt,
    retry_job,
)


def make_conn(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


class BackgroundJobPersistenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.conn = make_conn(os.path.join(self.tmpdir.name, "claudesk.db"))
        init_db(self.conn)

    def tearDown(self) -> None:
        self.conn.close()
        self.tmpdir.cleanup()

    def test_schema_migrates_from_version_35_without_losing_existing_rows(self) -> None:
        self.conn.execute(
            """
            INSERT INTO digest_runs (
                created_at, days_back, sources_json, total_fetched,
                total_after_dedup, total_in_digest, total_new_papers
            )
            VALUES ('2026-06-01T12:00:00', 7, '["arxiv"]', 4, 3, 2, 1)
            """
        )
        self.conn.executescript("""
            DROP TABLE background_job_events;
            DROP TABLE background_job_failures;
            DROP TABLE background_jobs;
            DELETE FROM schema_version;
            INSERT INTO schema_version (version) VALUES (35);
        """)
        self.conn.commit()

        init_db(self.conn)

        version = int(
            self.conn.execute(
                "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
            ).fetchone()[0]
        )
        digest_count = int(
            self.conn.execute("SELECT COUNT(*) FROM digest_runs").fetchone()[0]
        )
        jobs_table = self.conn.execute(
            """
            SELECT 1
            FROM sqlite_master
            WHERE type='table' AND name='background_jobs'
            """
        ).fetchone()
        self.assertEqual(version, SCHEMA_VERSION)
        self.assertEqual(digest_count, 1)
        self.assertIsNotNone(jobs_table)

    def test_lifecycle_events_failures_and_retry_preserve_history(self) -> None:
        job = create_job(
            self.conn,
            kind="digest_run",
            request={"source": "arxiv"},
            dedupe_key="digest",
            machine_id="machine-a",
        )
        self.conn.commit()

        active = get_active_job_by_kind_dedupe_key(self.conn, "digest_run", "digest")
        self.assertIsNotNone(active)
        self.assertEqual(active.id if active else None, job.id)

        running = mark_job_running(
            self.conn,
            job.id,
            machine_id="machine-a",
            pid=123,
            executor_kind="process",
        )
        self.assertEqual(running.attempt_count, 1)

        failed = mark_job_failed(
            self.conn,
            job.id,
            error_type="RuntimeError",
            message="fetch failed",
            details={"source": "arxiv"},
            retryable=True,
            progress={"phase": "error", "message": "fetch failed"},
        )
        self.assertEqual(failed.status, "failed")
        self.assertEqual(failed.latest_progress, {"phase": "error", "message": "fetch failed"})

        retry = retry_job(self.conn, job.id)
        self.assertEqual(retry.status, "queued")
        self.assertEqual(retry.attempt_count, 1)

        running_again = mark_job_running(
            self.conn,
            job.id,
            machine_id="machine-a",
            pid=456,
            executor_kind="process",
        )
        self.assertEqual(running_again.attempt_count, 2)

        succeeded = mark_job_succeeded(
            self.conn,
            job.id,
            result={"total_in_digest": 3},
            progress={"phase": "done", "message": "done"},
        )
        self.conn.commit()

        failures = list_job_failures(self.conn, job.id)
        events = list_job_events(self.conn, job.id)
        self.assertEqual(succeeded.status, "succeeded")
        self.assertEqual(succeeded.result, {"total_in_digest": 3})
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0].message, "fetch failed")
        self.assertTrue(failures[0].retryable)
        self.assertIn("queued", [event.event_type for event in events])
        self.assertIn("failed", [event.event_type for event in events])
        self.assertIn("retry_queued", [event.event_type for event in events])
        self.assertIn("succeeded", [event.event_type for event in events])

    def test_failed_before_running_records_first_attempt_and_terminal_stays_terminal(self) -> None:
        job = create_job(self.conn, kind="digest_run", dedupe_key="digest")
        failed = mark_job_failed(
            self.conn,
            job.id,
            error_type="RuntimeError",
            message="could not start process",
            retryable=True,
        )
        self.conn.commit()

        failures = list_job_failures(self.conn, job.id)
        self.assertEqual(failed.status, "failed")
        self.assertEqual(failed.attempt_count, 1)
        self.assertEqual(failures[0].attempt, 1)
        with self.assertRaisesRegex(ValueError, "terminal"):
            mark_job_running(self.conn, job.id, machine_id="machine-a")

    def test_retried_launch_failures_advance_attempt_history(self) -> None:
        job = create_job(self.conn, kind="digest_run", dedupe_key="digest")
        reserve_job_attempt(self.conn, job.id)
        first = mark_job_failed(
            self.conn,
            job.id,
            error_type="RuntimeError",
            message="first spawn failed",
            retryable=True,
        )

        retry = retry_job(self.conn, job.id)
        reserve_job_attempt(self.conn, job.id)
        second = mark_job_failed(
            self.conn,
            job.id,
            error_type="RuntimeError",
            message="second spawn failed",
            retryable=True,
        )
        self.conn.commit()

        failures = list_job_failures(self.conn, job.id)
        self.assertEqual(first.attempt_count, 1)
        self.assertEqual(retry.attempt_count, 1)
        self.assertEqual(second.attempt_count, 2)
        self.assertEqual([failure.attempt for failure in failures], [1, 2])

    def test_cancel_request_and_cancelled_terminal_state_do_not_record_failure(self) -> None:
        job = create_job(self.conn, kind="digest_run", dedupe_key="digest")
        mark_job_running(self.conn, job.id, machine_id="machine-a", executor_kind="process")

        cancelling = request_job_cancel(
            self.conn,
            job.id,
            progress={"phase": "cancelling", "message": "Stopping digest fetch..."},
        )
        cancelled = mark_job_cancelled(
            self.conn,
            job.id,
            progress={"phase": "cancelled", "message": "Digest fetch stopped."},
        )
        self.conn.commit()

        self.assertEqual(cancelling.status, "cancelling")
        self.assertIsNotNone(cancelling.cancel_requested_at)
        self.assertEqual(cancelled.status, "cancelled")
        self.assertEqual(list_job_failures(self.conn, job.id), [])

    def test_reconcile_stale_jobs_only_touches_same_machine_active_jobs(self) -> None:
        queued = create_job(
            self.conn,
            kind="digest_run",
            dedupe_key="digest-queued",
            machine_id="machine-a",
        )

        running = create_job(self.conn, kind="digest_run", dedupe_key="digest-running")
        mark_job_running(self.conn, running.id, machine_id="machine-a", executor_kind="process")

        cancelling = create_job(self.conn, kind="rubric_scoring", dedupe_key="rubric")
        mark_job_running(self.conn, cancelling.id, machine_id="machine-a", executor_kind="process")
        request_job_cancel(self.conn, cancelling.id)

        other = create_job(self.conn, kind="pdf_parse", dedupe_key="asset:1")
        mark_job_running(self.conn, other.id, machine_id="machine-b", executor_kind="thread")
        self.conn.commit()

        same_machine = list_active_jobs_by_kind(self.conn, "digest_run", machine_id="machine-a")
        self.assertEqual([job.id for job in same_machine], [queued.id, running.id])

        reconciled = reconcile_stale_jobs(self.conn, machine_id="machine-a")
        self.conn.commit()

        self.assertEqual([job.id for job in reconciled], [queued.id, running.id, cancelling.id])
        self.assertEqual(get_job(self.conn, queued.id).status, "failed")  # type: ignore[union-attr]
        self.assertEqual(get_job(self.conn, running.id).status, "failed")  # type: ignore[union-attr]
        self.assertEqual(get_job(self.conn, cancelling.id).status, "cancelled")  # type: ignore[union-attr]
        self.assertEqual(get_job(self.conn, other.id).status, "running")  # type: ignore[union-attr]
        self.assertEqual(
            list_job_failures(self.conn, queued.id)[0].message,
            "Job was queued when the app stopped before its worker could start.",
        )
        self.assertEqual(list_job_failures(self.conn, running.id)[0].error_type, "StaleBackgroundJob")


if __name__ == "__main__":
    unittest.main()
