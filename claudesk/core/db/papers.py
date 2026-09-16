from __future__ import annotations

import json
import re
import sqlite3
from datetime import date, datetime, timezone
from typing import Optional, Sequence

from claudesk.core.doi import doi_identity_key
from claudesk.core.paper_identity import normalize_paper_title_key, paper_source_priority

from claudesk.core.models import (
    AssetKind,
    AssetDocumentBlock,
    AssetParseArtifact,
    AssetPdfPage,
    AssetParseStatus,
    AssetTextChunk,
    ChatAttachment,
    ChatAttachmentKind,
    ChatContextItem,
    ChatMessage,
    ChatResourceRead,
    ChatResourceReadInput,
    ChatResourceReadSource,
    ChatSessionDetail,
    ChatSessionSummary,
    ChatTraceEntry,
    LogEntry,
    LogTaskSubtask,
    ManualLogEntry,
    Note,
    Paper,
    PaperAsset,
    PaperPdfStatus,
    PaperScoreRubric,
    PaperSignal,
    PaperStatus,
    Project,
    ProjectListMetric,
    ProjectMilestone,
    ProjectMilestoneKind,
    ProjectMilestoneStatus,
    ProjectPaperRole,
    ProjectProgressSummary,
    ProjectStatus,
    Todo,
    TodoPriority,
    TodoStatus,
)

from .assets import _delete_asset_if_unowned
from .notes import (
    _load_note_summary_map,
    _load_paper_pdf_status_map,
    _note_search_body,
    _sync_note_links,
    create_note,
)
from .projects import _load_project_link_map
from .utils import (
    _UNSET,
    _decode_embedding,
    _decode_score_rubric,
    _encode_embedding,
    _encode_score_rubric,
    _normalize_linked_ids,
    _parse_datetime_text,
    _rank_fts_rows,
)


def upsert_paper(conn: sqlite3.Connection, paper: Paper) -> int:
    """Insert a paper and return its id. Skips insert if (source, external_id) exists."""
    cur = conn.execute(
        "SELECT * FROM papers WHERE source=? AND external_id=?",
        (paper.source, paper.external_id),
    )
    row = cur.fetchone()
    if row:
        _backfill_existing_paper_metadata(conn, row, paper)
        return int(row["id"])

    doi_key = _normalise_doi_key(paper.external_id)
    if doi_key is not None:
        row = _find_existing_paper_by_doi(conn, doi_key)
        if row:
            _merge_incoming_duplicate_paper(conn, row, paper)
            return int(row["id"])

    title_key = normalize_paper_title_key(paper.title)
    if title_key:
        row = _find_existing_paper_by_title_key(conn, title_key)
        if row:
            _merge_incoming_duplicate_paper(conn, row, paper)
            return int(row["id"])

    embedding_blob = _encode_embedding(paper.embedding) if paper.embedding else None
    status_value, is_saved, is_read, is_to_read = _paper_state_from_model(paper)
    to_read_at = _paper_to_read_at_from_model(paper, is_to_read)
    cur = conn.execute(
        """
        INSERT INTO papers
            (source, external_id, title, abstract, authors, published_date, journal_abbrev,
             url, embedding, relevance_score, score_rubric, note, status, is_saved, is_read, is_to_read, to_read_at, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            paper.source,
            paper.external_id,
            paper.title,
            paper.abstract,
            json.dumps(paper.authors),
            paper.published_date.isoformat(),
            paper.journal_abbrev,
            paper.url,
            embedding_blob,
            paper.relevance_score,
            _encode_score_rubric(paper.score_rubric),
            None,
            status_value,
            int(is_saved),
            int(is_read),
            int(is_to_read),
            to_read_at,
            paper.fetched_at.isoformat(),
        ),
    )
    paper_id = int(cur.lastrowid)  # type: ignore[arg-type]
    return paper_id


def _normalise_doi_key(external_id: str) -> Optional[str]:
    return doi_identity_key(external_id)


def _find_existing_paper_by_doi(
    conn: sqlite3.Connection,
    doi_key: str,
) -> Optional[sqlite3.Row]:
    rows = conn.execute("SELECT * FROM papers").fetchall()
    matches = [
        row
        for row in rows
        if doi_identity_key(row["external_id"]) == doi_key
    ]
    if not matches:
        return None
    matches.sort(key=lambda row: (_source_priority(row["source"]), row["id"]))
    return matches[0]


def _source_priority(source: str) -> int:
    return paper_source_priority(source)


def _find_existing_paper_by_title_key(
    conn: sqlite3.Connection,
    title_key: str,
) -> Optional[sqlite3.Row]:
    rows = conn.execute("SELECT * FROM papers").fetchall()
    matches = [
        row
        for row in rows
        if normalize_paper_title_key(row["title"]) == title_key
    ]
    if not matches:
        return None
    matches.sort(key=lambda row: (_source_priority(row["source"]), row["id"]))
    return matches[0]


def find_title_duplicate_groups(conn: sqlite3.Connection) -> list[dict[str, object]]:
    """Find existing paper rows that share the same normalized title key."""
    groups: dict[str, list[sqlite3.Row]] = {}
    rows = conn.execute("SELECT * FROM papers ORDER BY id").fetchall()
    for row in rows:
        title_key = normalize_paper_title_key(row["title"])
        if not title_key:
            continue
        groups.setdefault(title_key, []).append(row)

    duplicate_groups: list[dict[str, object]] = []
    for title_key, group_rows in groups.items():
        if len(group_rows) < 2:
            continue
        ordered = sorted(group_rows, key=lambda row: (_source_priority(row["source"]), row["id"]))
        duplicate_groups.append({
            "title_key": title_key,
            "canonical_id": int(ordered[0]["id"]),
            "papers": [_paper_duplicate_summary(row) for row in ordered],
        })

    duplicate_groups.sort(key=lambda group: int(group["canonical_id"]))
    return duplicate_groups


def merge_title_duplicate_groups(conn: sqlite3.Connection) -> list[dict[str, object]]:
    """Merge all existing exact title-key duplicate groups into canonical rows."""
    groups = find_title_duplicate_groups(conn)
    for group in groups:
        paper_summaries = group["papers"]
        if not isinstance(paper_summaries, list) or len(paper_summaries) < 2:
            continue
        canonical_id = int(group["canonical_id"])
        duplicate_ids = [
            int(summary["id"])
            for summary in paper_summaries
            if isinstance(summary, dict) and int(summary["id"]) != canonical_id
        ]
        _merge_duplicate_papers(conn, canonical_id, duplicate_ids)
    return groups


def _paper_duplicate_summary(row: sqlite3.Row) -> dict[str, object]:
    return {
        "id": int(row["id"]),
        "source": row["source"],
        "external_id": row["external_id"],
        "published_date": row["published_date"],
        "title": row["title"],
    }


def _merge_duplicate_papers(
    conn: sqlite3.Connection,
    canonical_id: int,
    duplicate_ids: list[int],
) -> None:
    canonical = conn.execute("SELECT * FROM papers WHERE id=?", (canonical_id,)).fetchone()
    duplicates = [
        row
        for duplicate_id in duplicate_ids
        if (row := conn.execute("SELECT * FROM papers WHERE id=?", (duplicate_id,)).fetchone())
    ]
    if canonical is None or not duplicates:
        return

    _merge_duplicate_paper_content(conn, canonical, duplicates)
    for duplicate in duplicates:
        duplicate_id = int(duplicate["id"])
        _rewrite_paper_references(conn, duplicate_id, canonical_id)
        conn.execute("DELETE FROM papers WHERE id=?", (duplicate_id,))


def _merge_duplicate_paper_content(
    conn: sqlite3.Connection,
    canonical: sqlite3.Row,
    duplicates: list[sqlite3.Row],
) -> None:
    rows = [canonical, *duplicates]
    is_saved = any(bool(row["is_saved"]) for row in rows)
    is_read = any(bool(row["is_read"]) for row in rows)
    is_to_read = any(bool(row["is_to_read"]) for row in rows)
    dismissed = any(row["status"] == PaperStatus.DISMISSED.value for row in rows)
    status = _derive_paper_status(dismissed=dismissed, is_saved=is_saved, is_read=is_read)
    if dismissed or is_read:
        is_to_read = False

    updates: dict[str, object] = {
        "status": status.value,
        "is_saved": int(is_saved),
        "is_read": int(is_read),
        "is_to_read": int(is_to_read),
        "to_read_at": _merged_to_read_at(rows, is_to_read),
    }

    for column in ("abstract", "url", "published_date", "journal_abbrev"):
        if not _has_useful_text(canonical[column]):
            for duplicate in duplicates:
                if _has_useful_text(duplicate[column]):
                    updates[column] = duplicate[column]
                    break

    if not _has_useful_authors(canonical["authors"]):
        for duplicate in duplicates:
            if _has_useful_authors(duplicate["authors"]):
                updates["authors"] = duplicate["authors"]
                break

    _promote_duplicate_legacy_notes(conn, canonical, duplicates)
    updates["note"] = None

    assignments = ", ".join(f"{column}=?" for column in updates)
    conn.execute(
        f"UPDATE papers SET {assignments} WHERE id=?",
        (*updates.values(), canonical["id"]),
    )


def _promote_duplicate_legacy_notes(
    conn: sqlite3.Connection,
    canonical: sqlite3.Row,
    duplicates: list[sqlite3.Row],
) -> None:
    duplicate_to_canonical = {
        int(row["id"]): int(canonical["id"])
        for row in duplicates
    }
    canonical_note = _replace_paper_reference_text(
        canonical["note"] or "",
        duplicate_to_canonical=duplicate_to_canonical,
    ).strip()
    if canonical_note:
        create_note(
            conn,
            title=f"Note on: {canonical['title']}",
            body=canonical_note,
            manual_paper_ids=[int(canonical["id"])],
            created_at=_parse_datetime_text(canonical["fetched_at"]),
        )

    for duplicate in duplicates:
        note = _replace_paper_reference_text(
            duplicate["note"] or "",
            duplicate_to_canonical=duplicate_to_canonical,
        ).strip()
        if not note:
            continue
        create_note(
            conn,
            title=f"Note on: {duplicate['title']}",
            body=note,
            manual_paper_ids=[int(canonical["id"])],
            created_at=_parse_datetime_text(duplicate["fetched_at"]),
        )


def _rewrite_paper_references(
    conn: sqlite3.Connection,
    duplicate_id: int,
    canonical_id: int,
) -> None:
    conn.execute(
        """
        INSERT OR IGNORE INTO project_papers (project_id, paper_id, role, created_at)
        SELECT project_id, ?, role, created_at
        FROM project_papers
        WHERE paper_id=?
        """,
        (canonical_id, duplicate_id),
    )
    conn.execute("DELETE FROM project_papers WHERE paper_id=?", (duplicate_id,))
    conn.execute("UPDATE feedback SET paper_id=? WHERE paper_id=?", (canonical_id, duplicate_id))
    _rewrite_note_paper_references(conn, duplicate_id, canonical_id)

    _rewrite_json_paper_id_column(conn, "log_entries", "linked_paper_ids", duplicate_id, canonical_id)
    _rewrite_json_paper_id_column(conn, "chat_sessions", "linked_paper_ids", duplicate_id, canonical_id)

    _rewrite_text_paper_references(conn, "todos", "title", duplicate_id, canonical_id)
    _rewrite_text_paper_references(conn, "todos", "description", duplicate_id, canonical_id)
    _rewrite_text_paper_references(conn, "log_entries", "entry_markdown", duplicate_id, canonical_id)
    _rewrite_text_paper_references(conn, "chat_messages", "content", duplicate_id, canonical_id)


def _rewrite_note_paper_references(
    conn: sqlite3.Connection,
    duplicate_id: int,
    canonical_id: int,
) -> None:
    now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
    rows = conn.execute(
        """
        SELECT note_id, manual, mentioned, created_at
        FROM note_papers
        WHERE paper_id=?
        ORDER BY created_at ASC, note_id ASC
        """,
        (duplicate_id,),
    ).fetchall()
    for row in rows:
        existing = conn.execute(
            "SELECT manual, mentioned FROM note_papers WHERE note_id=? AND paper_id=?",
            (row["note_id"], canonical_id),
        ).fetchone()
        if existing is None:
            conn.execute(
                """
                INSERT INTO note_papers (note_id, paper_id, manual, mentioned, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    row["note_id"],
                    canonical_id,
                    int(bool(row["manual"])),
                    int(bool(row["mentioned"])),
                    row["created_at"],
                    now,
                ),
            )
        else:
            conn.execute(
                """
                UPDATE note_papers
                SET manual=?, mentioned=?, updated_at=?
                WHERE note_id=? AND paper_id=?
                """,
                (
                    int(bool(existing["manual"]) or bool(row["manual"])),
                    int(bool(existing["mentioned"]) or bool(row["mentioned"])),
                    now,
                    row["note_id"],
                    canonical_id,
                ),
            )
    conn.execute("DELETE FROM note_papers WHERE paper_id=?", (duplicate_id,))

    body_rows = conn.execute(
        "SELECT id, body FROM notes WHERE body LIKE ?",
        (f"%paper://{duplicate_id}%",),
    ).fetchall()
    for row in body_rows:
        current = row["body"] or ""
        updated = _replace_paper_reference_text(
            current,
            duplicate_to_canonical={duplicate_id: canonical_id},
        )
        if updated == current:
            continue
        conn.execute(
            "UPDATE notes SET body=?, search_body=?, updated_at=? WHERE id=?",
            (updated, _note_search_body(conn, updated), now, row["id"]),
        )
        _sync_note_links(conn, note_id=int(row["id"]), body=updated, timestamp=now)


def _rewrite_json_paper_id_column(
    conn: sqlite3.Connection,
    table: str,
    column: str,
    duplicate_id: int,
    canonical_id: int,
) -> None:
    rows = conn.execute(f"SELECT id, {column} FROM {table}").fetchall()
    for row in rows:
        try:
            values = json.loads(row[column] or "[]")
        except json.JSONDecodeError:
            values = []
        normalized_values: list[int] = []
        for value in values:
            try:
                normalized_values.append(int(value))
            except (TypeError, ValueError):
                continue
        if duplicate_id not in normalized_values:
            continue
        replaced = [
            canonical_id if paper_id == duplicate_id else paper_id
            for paper_id in normalized_values
        ]
        conn.execute(
            f"UPDATE {table} SET {column}=? WHERE id=?",
            (json.dumps(_normalize_linked_ids(replaced)), row["id"]),
        )


def _rewrite_text_paper_references(
    conn: sqlite3.Connection,
    table: str,
    column: str,
    duplicate_id: int,
    canonical_id: int,
) -> None:
    rows = conn.execute(f"SELECT id, {column} FROM {table} WHERE {column} LIKE ?", (f"%paper://{duplicate_id}%",)).fetchall()
    for row in rows:
        current = row[column] or ""
        updated = _replace_paper_reference_text(
            current,
            duplicate_to_canonical={duplicate_id: canonical_id},
        )
        if updated != current:
            conn.execute(f"UPDATE {table} SET {column}=? WHERE id=?", (updated, row["id"]))


def _replace_paper_reference_text(
    text: str,
    *,
    duplicate_to_canonical: dict[int, int],
) -> str:
    if not text or not duplicate_to_canonical:
        return text

    def repl(match: re.Match[str]) -> str:
        paper_id = int(match.group(1))
        return f"paper://{duplicate_to_canonical.get(paper_id, paper_id)}"

    pattern = r"paper://(" + "|".join(str(paper_id) for paper_id in duplicate_to_canonical) + r")(?!\d)"
    return re.sub(pattern, repl, text)


def _backfill_existing_paper_metadata(
    conn: sqlite3.Connection,
    existing: sqlite3.Row,
    incoming: Paper,
) -> None:
    updates: dict[str, object] = {}

    if incoming.journal_abbrev and not _has_useful_text(existing["journal_abbrev"]):
        updates["journal_abbrev"] = incoming.journal_abbrev
    if _has_useful_text(incoming.abstract) and not _has_useful_text(existing["abstract"]):
        updates["abstract"] = incoming.abstract
    if incoming.authors and not _has_useful_authors(existing["authors"]):
        updates["authors"] = json.dumps(incoming.authors)
    if _has_useful_text(incoming.url) and not _has_useful_text(existing["url"]):
        updates["url"] = incoming.url
    if not _has_useful_text(existing["published_date"]):
        updates["published_date"] = incoming.published_date.isoformat()
    updates.update(_incoming_queue_state_updates(existing, incoming))

    if not updates:
        return

    assignments = ", ".join(f"{column}=?" for column in updates)
    conn.execute(
        f"UPDATE papers SET {assignments} WHERE id=?",
        (*updates.values(), existing["id"]),
    )


def _merge_incoming_duplicate_paper(
    conn: sqlite3.Connection,
    existing: sqlite3.Row,
    incoming: Paper,
) -> None:
    if paper_source_priority(incoming.source) < paper_source_priority(existing["source"]):
        updates: dict[str, object] = {
            "source": incoming.source,
            "external_id": incoming.external_id,
            "title": incoming.title,
            "published_date": incoming.published_date.isoformat(),
        }
        if _has_useful_text(incoming.abstract):
            updates["abstract"] = incoming.abstract
        if incoming.authors:
            updates["authors"] = json.dumps(incoming.authors)
        if incoming.journal_abbrev:
            updates["journal_abbrev"] = incoming.journal_abbrev
        if _has_useful_text(incoming.url):
            updates["url"] = incoming.url
        updates.update(_incoming_queue_state_updates(existing, incoming))

        assignments = ", ".join(f"{column}=?" for column in updates)
        conn.execute(
            f"UPDATE papers SET {assignments} WHERE id=?",
            (*updates.values(), existing["id"]),
        )
        return

    _backfill_existing_paper_metadata(conn, existing, incoming)


def _has_useful_text(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _has_useful_authors(value: object) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        authors = json.loads(value)
    except json.JSONDecodeError:
        return False
    return isinstance(authors, list) and any(
        isinstance(author, str) and author.strip()
        for author in authors
    )


def _derive_paper_status(
    *,
    dismissed: bool,
    is_saved: bool,
    is_read: bool,
) -> PaperStatus:
    if dismissed:
        return PaperStatus.DISMISSED
    if is_saved:
        return PaperStatus.SAVED
    if is_read:
        return PaperStatus.READ
    return PaperStatus.NEW


def _paper_state_from_model(paper: Paper) -> tuple[str, bool, bool, bool]:
    dismissed = paper.status == PaperStatus.DISMISSED
    is_saved = paper.is_saved or paper.status == PaperStatus.SAVED
    is_read = paper.is_read or paper.status == PaperStatus.READ
    is_to_read = paper.is_to_read and not dismissed and not is_read
    status = _derive_paper_status(
        dismissed=dismissed,
        is_saved=is_saved,
        is_read=is_read,
    )
    return status.value, is_saved, is_read, is_to_read


def _paper_to_read_at_from_model(paper: Paper, is_to_read: bool) -> Optional[str]:
    if not is_to_read:
        return None
    return (paper.to_read_at or paper.fetched_at).isoformat()


def _row_to_read_at(row: sqlite3.Row) -> Optional[str]:
    if "to_read_at" in row.keys() and _has_useful_text(row["to_read_at"]):
        return row["to_read_at"]
    if bool(row["is_to_read"]) and _has_useful_text(row["fetched_at"]):
        return row["fetched_at"]
    return None


def _merged_to_read_at(rows: Sequence[sqlite3.Row], is_to_read: bool) -> Optional[str]:
    if not is_to_read:
        return None
    values = [
        value
        for row in rows
        if bool(row["is_to_read"])
        for value in [_row_to_read_at(row)]
        if value is not None
    ]
    if not values:
        return None
    return min(values)


def _incoming_queue_state_updates(existing: sqlite3.Row, incoming: Paper) -> dict[str, object]:
    existing_is_to_read = bool(existing["is_to_read"]) if "is_to_read" in existing.keys() else False
    existing_is_read = bool(existing["is_read"]) if "is_read" in existing.keys() else existing["status"] == "read"
    existing_dismissed = existing["status"] == "dismissed"
    if existing_is_to_read:
        existing_to_read_at = _row_to_read_at(existing)
        if existing_to_read_at and (
            "to_read_at" not in existing.keys()
            or not _has_useful_text(existing["to_read_at"])
        ):
            return {"to_read_at": existing_to_read_at}
        return {}
    incoming_status, _incoming_saved, _incoming_read, incoming_is_to_read = _paper_state_from_model(incoming)
    if not incoming_is_to_read or existing_is_read or existing_dismissed:
        return {}
    return {
        "status": incoming_status if existing["status"] == PaperStatus.NEW.value else existing["status"],
        "is_to_read": 1,
        "to_read_at": _paper_to_read_at_from_model(incoming, True),
    }


def _row_to_paper(
    row: sqlite3.Row,
    project_ids: Optional[list[int]] = None,
    note_summary: Optional[tuple[int, Optional[str]]] = None,
    pdf_status: PaperPdfStatus = "none",
    latest_digest_run_id: Optional[int] = None,
) -> Paper:
    is_saved = bool(row["is_saved"]) if "is_saved" in row.keys() else row["status"] == "saved"
    is_read = bool(row["is_read"]) if "is_read" in row.keys() else row["status"] == "read"
    is_to_read = bool(row["is_to_read"]) if "is_to_read" in row.keys() else False
    status = _derive_paper_status(
        dismissed=row["status"] == "dismissed",
        is_saved=is_saved,
        is_read=is_read,
    )
    new_digest_run_id = (
        int(row["new_digest_run_id"])
        if "new_digest_run_id" in row.keys() and row["new_digest_run_id"] is not None
        else None
    )
    return Paper(
        id=row["id"],
        source=row["source"],
        external_id=row["external_id"],
        title=row["title"],
        abstract=row["abstract"],
        authors=json.loads(row["authors"]),
        published_date=date.fromisoformat(row["published_date"]),
        journal_abbrev=row["journal_abbrev"] if "journal_abbrev" in row.keys() else None,
        url=row["url"],
        embedding=_decode_embedding(row["embedding"]) if row["embedding"] else None,
        relevance_score=row["relevance_score"],
        score_rubric=(
            _decode_score_rubric(row["score_rubric"])
            if "score_rubric" in row.keys()
            else None
        ),
        note_count=note_summary[0] if note_summary else 0,
        latest_note_preview=note_summary[1] if note_summary else None,
        status=status,
        is_saved=is_saved,
        is_read=is_read,
        is_to_read=is_to_read and status != PaperStatus.DISMISSED and not is_read,
        to_read_at=(
            _parse_datetime_text(_row_to_read_at(row))
            if is_to_read and status != PaperStatus.DISMISSED and not is_read
            else None
        ),
        is_new_digest=(
            status == PaperStatus.NEW
            and latest_digest_run_id is not None
            and new_digest_run_id == latest_digest_run_id
        ),
        pdf_status=pdf_status,
        project_ids=project_ids or [],
        fetched_at=datetime.fromisoformat(row["fetched_at"]),
    )


def _latest_digest_run_id(conn: sqlite3.Connection) -> Optional[int]:
    row = conn.execute(
        "SELECT id FROM digest_runs ORDER BY id DESC LIMIT 1"
    ).fetchone()
    return int(row["id"]) if row is not None else None


def _hydrate_papers_with_projects(
    conn: sqlite3.Connection,
    rows: Sequence[sqlite3.Row],
) -> list[Paper]:
    if not rows:
        return []
    paper_ids = [int(row["id"]) for row in rows]
    project_map = _load_project_link_map(
        conn,
        join_table="project_papers",
        item_column="paper_id",
        item_ids=paper_ids,
    )
    note_summary_map = _load_note_summary_map(conn, paper_ids)
    pdf_status_map = _load_paper_pdf_status_map(conn, paper_ids)
    latest_digest_run_id = _latest_digest_run_id(conn)
    return [
        _row_to_paper(
            row,
            project_map.get(int(row["id"]), []),
            note_summary_map.get(int(row["id"]), (0, None)),
            pdf_status_map.get(int(row["id"]), "none"),
            latest_digest_run_id,
        )
        for row in rows
    ]


def get_paper(conn: sqlite3.Connection, paper_id: int) -> Optional[Paper]:
    cur = conn.execute("SELECT * FROM papers WHERE id=?", (paper_id,))
    row = cur.fetchone()
    if row is None:
        return None
    papers = _hydrate_papers_with_projects(conn, [row])
    return papers[0] if papers else None


def delete_paper(conn: sqlite3.Connection, paper_id: int) -> None:
    row = conn.execute("SELECT id FROM papers WHERE id=?", (paper_id,)).fetchone()
    if row is None:
        raise ValueError(f"Paper {paper_id} not found.")
    asset_ids = [
        int(asset_row["asset_id"])
        for asset_row in conn.execute(
            "SELECT asset_id FROM paper_assets WHERE paper_id=?",
            (paper_id,),
        ).fetchall()
    ]
    conn.execute("DELETE FROM feedback WHERE paper_id=?", (paper_id,))
    conn.execute("DELETE FROM project_papers WHERE paper_id=?", (paper_id,))
    conn.execute("DELETE FROM note_papers WHERE paper_id=?", (paper_id,))
    conn.execute("DELETE FROM paper_assets WHERE paper_id=?", (paper_id,))
    for asset_id in asset_ids:
        _delete_asset_if_unowned(conn, asset_id)
    conn.execute("DELETE FROM papers WHERE id=?", (paper_id,))


def get_paper_by_doi(conn: sqlite3.Connection, doi_input: str) -> Optional[Paper]:
    doi_key = doi_identity_key(doi_input)
    if doi_key is None:
        return None
    row = _find_existing_paper_by_doi(conn, doi_key)
    if row is None:
        return None
    papers = _hydrate_papers_with_projects(conn, [row])
    return papers[0] if papers else None


def count_papers(
    conn: sqlite3.Connection,
    *,
    include_dismissed: bool = False,
) -> int:
    query = "SELECT COUNT(*) FROM papers"
    if not include_dismissed:
        query += " WHERE status != 'dismissed'"
    return int(conn.execute(query).fetchone()[0])


def list_papers(
    conn: sqlite3.Connection,
    *,
    status: Optional[PaperStatus] = None,
    since: Optional[date] = None,
    limit: Optional[int] = None,
    sort: str = "score",
    include_dismissed: bool = False,
) -> list[Paper]:
    query = "SELECT * FROM papers WHERE 1=1"
    params: list = []
    if status:
        if status == PaperStatus.SAVED:
            query += " AND is_saved=1"
            if not include_dismissed:
                query += " AND status != 'dismissed'"
        elif status == PaperStatus.READ:
            query += " AND is_saved=0 AND is_read=1"
            if not include_dismissed:
                query += " AND status != 'dismissed'"
        elif status == PaperStatus.DISMISSED:
            query += " AND status='dismissed'"
        else:
            query += " AND is_saved=0 AND is_read=0"
            if not include_dismissed:
                query += " AND status != 'dismissed'"
    elif not include_dismissed:
        query += " AND status != 'dismissed'"
    if since:
        query += " AND published_date >= ?"
        params.append(since.isoformat())
    if sort == "date":
        query += " ORDER BY published_date DESC, relevance_score DESC NULLS LAST"
    else:
        query += " ORDER BY relevance_score DESC NULLS LAST, published_date DESC"
    if limit:
        query += " LIMIT ?"
        params.append(limit)
    cur = conn.execute(query, params)
    rows = cur.fetchall()
    return _hydrate_papers_with_projects(conn, rows)


def list_to_read_papers(
    conn: sqlite3.Connection,
    *,
    limit: Optional[int] = None,
    sort: str = "score",
) -> list[Paper]:
    query = "SELECT * FROM papers WHERE is_to_read=1 AND status != 'dismissed'"
    params: list = []
    if sort == "queued":
        query += " ORDER BY to_read_at DESC NULLS LAST, published_date DESC, relevance_score DESC NULLS LAST"
    elif sort == "date":
        query += " ORDER BY is_saved DESC, published_date DESC, relevance_score DESC NULLS LAST"
    else:
        query += " ORDER BY is_saved DESC, relevance_score DESC NULLS LAST, published_date DESC"
    if limit:
        query += " LIMIT ?"
        params.append(limit)
    cur = conn.execute(query, params)
    rows = cur.fetchall()
    return _hydrate_papers_with_projects(conn, rows)


def suggest_papers(
    conn: sqlite3.Connection,
    query: str,
    *,
    limit: int = 8,
) -> list[Paper]:
    """Autocomplete-friendly paper suggestions for chat tagging."""
    normalized = query.strip().casefold()
    if not normalized:
        cur = conn.execute(
            """
            SELECT *
            FROM papers
            WHERE status != 'dismissed'
            ORDER BY is_saved DESC, published_date DESC, relevance_score DESC NULLS LAST
            LIMIT ?
            """,
            (limit,),
        )
        rows = cur.fetchall()
        return _hydrate_papers_with_projects(conn, rows)

    pattern = f"%{normalized}%"
    prefix = f"{normalized}%"
    cur = conn.execute(
        """
        SELECT *
        FROM papers
        WHERE status != 'dismissed'
          AND (
              lower(title) LIKE ?
              OR lower(authors) LIKE ?
          )
        ORDER BY
            CASE
                WHEN lower(title) LIKE ? THEN 0
                WHEN instr(lower(title), ?) > 0 THEN 1
                WHEN lower(authors) LIKE ? THEN 2
                WHEN instr(lower(authors), ?) > 0 THEN 3
                ELSE 4
            END,
            is_saved DESC,
            relevance_score DESC NULLS LAST,
            published_date DESC
        LIMIT ?
        """,
        (pattern, pattern, prefix, normalized, prefix, normalized, limit),
    )
    rows = cur.fetchall()
    return _hydrate_papers_with_projects(conn, rows)


def search_papers(
    conn: sqlite3.Connection,
    query: str,
    *,
    limit: int = 50,
    include_dismissed: bool = False,
) -> list[Paper]:
    visibility_filter = "" if include_dismissed else "AND p.status != 'dismissed'"
    rows = _rank_fts_rows(
        query,
        limit=limit,
        fetch_rows=lambda fts_query, pool_limit: conn.execute(
            f"""
            SELECT p.*
            FROM papers_fts
            JOIN papers p ON p.id = papers_fts.rowid
            WHERE papers_fts MATCH ?
              {visibility_filter}
            ORDER BY
                bm25(papers_fts, 10.0, 1.0, 4.0),
                p.relevance_score DESC NULLS LAST,
                p.published_date DESC
            LIMIT ?
            """,
            (fts_query, pool_limit),
        ).fetchall(),
        fields=lambda row: (
            (row["title"] or "", 10.0),
            (row["abstract"] or "", 4.0),
            (row["authors"] or "", 1.0),
        ),
    )
    return _hydrate_papers_with_projects(conn, rows)


def update_paper_status(
    conn: sqlite3.Connection, paper_id: int, signal: PaperSignal
) -> PaperStatus:
    cur = conn.execute(
        "SELECT status, is_saved, is_read, is_to_read, to_read_at FROM papers WHERE id=?",
        (paper_id,),
    )
    row = cur.fetchone()
    if row is None:
        raise ValueError(f"Paper {paper_id} not found.")

    dismissed = row["status"] == "dismissed"
    is_saved = bool(row["is_saved"]) if "is_saved" in row.keys() else row["status"] == "saved"
    is_read = bool(row["is_read"]) if "is_read" in row.keys() else row["status"] == "read"
    is_to_read = bool(row["is_to_read"]) if "is_to_read" in row.keys() else False
    was_to_read = is_to_read
    to_read_at = row["to_read_at"] if "to_read_at" in row.keys() else None

    if signal == PaperSignal.NEW:
        dismissed = False
        is_saved = False
        is_read = False
        is_to_read = False
    elif signal == PaperSignal.READ:
        dismissed = False
        is_read = True
        is_to_read = False
    elif signal == PaperSignal.SAVED:
        dismissed = False
        is_saved = True
    elif signal == PaperSignal.UNSAVED:
        dismissed = False
        is_saved = False
    elif signal == PaperSignal.TO_READ:
        dismissed = False
        is_read = False
        is_to_read = True
    elif signal == PaperSignal.REMOVE_TO_READ:
        dismissed = False
        is_to_read = False
    elif signal == PaperSignal.DISMISSED:
        dismissed = True
        is_saved = False
        is_to_read = False
    elif signal == PaperSignal.UNDISMISSED:
        dismissed = False

    status = _derive_paper_status(
        dismissed=dismissed,
        is_saved=is_saved,
        is_read=is_read,
    )
    if not is_to_read:
        to_read_at = None
    elif not was_to_read or not _has_useful_text(to_read_at):
        to_read_at = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
    assignments = ["status=?", "is_saved=?", "is_read=?", "is_to_read=?", "to_read_at=?"]
    values: list[object] = [status.value, int(is_saved), int(is_read), int(is_to_read), to_read_at]
    if status != PaperStatus.NEW:
        assignments.append("new_digest_run_id=NULL")
    values.append(paper_id)
    conn.execute(
        f"UPDATE papers SET {', '.join(assignments)} WHERE id=?",
        values,
    )
    return status


def insert_feedback(conn: sqlite3.Connection, paper_id: int, signal: str) -> int:
    created_at = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
    cur = conn.execute(
        """
        INSERT INTO feedback (paper_id, signal, created_at)
        VALUES (?, ?, ?)
        """,
        (paper_id, signal, created_at),
    )
    return int(cur.lastrowid)  # type: ignore[arg-type]


def update_paper_ranking(
    conn: sqlite3.Connection,
    paper_id: int,
    embedding: list[float],
    relevance_score: float,
    score_rubric: object = _UNSET,
) -> None:
    assignments = ["embedding=?", "relevance_score=?"]
    values: list[object] = [_encode_embedding(embedding), relevance_score]
    if score_rubric is not _UNSET:
        assignments.append("score_rubric=?")
        values.append(_encode_score_rubric(score_rubric if isinstance(score_rubric, PaperScoreRubric) else None))
    values.append(paper_id)
    conn.execute(
        f"UPDATE papers SET {', '.join(assignments)} WHERE id=?",
        values,
    )


def update_paper_abstract(
    conn: sqlite3.Connection,
    paper_id: int,
    abstract: str,
) -> None:
    row = conn.execute("SELECT id FROM papers WHERE id=?", (paper_id,)).fetchone()
    if row is None:
        raise ValueError(f"Paper {paper_id} not found.")
    conn.execute(
        "UPDATE papers SET abstract=? WHERE id=?",
        (abstract.strip(), paper_id),
    )
