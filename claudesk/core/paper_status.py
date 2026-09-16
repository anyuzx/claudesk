from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from claudesk.core.db.papers import (
    get_paper,
    insert_feedback,
    update_paper_status,
)
from claudesk.core.models import Paper, PaperSignal, PaperStatus


@dataclass(frozen=True)
class PaperStatusUpdate:
    paper_id: int
    signal: PaperSignal
    effective_status: PaperStatus
    before: Paper
    after: Paper
    feedback_id: int | None = None


def apply_paper_signal(
    conn: sqlite3.Connection,
    paper_id: int,
    signal: PaperSignal,
    *,
    record_feedback: bool = True,
) -> PaperStatusUpdate:
    before = get_paper(conn, paper_id)
    if before is None:
        raise ValueError(f"Paper {paper_id} not found.")

    effective_status = update_paper_status(conn, paper_id, signal)
    feedback_id = (
        insert_feedback(conn, paper_id, signal.value)
        if record_feedback
        else None
    )
    after = get_paper(conn, paper_id)
    if after is None:
        raise RuntimeError(f"Paper {paper_id} could not be loaded after status update.")
    return PaperStatusUpdate(
        paper_id=paper_id,
        signal=signal,
        effective_status=effective_status,
        before=before,
        after=after,
        feedback_id=feedback_id,
    )
