from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timezone
from typing import Optional, Sequence

from claudesk.core.paper_mentions import extract_paper_ids
from claudesk.core.paper_assets import (
    EXCALIDRAW_ASSET_MIME_TYPE,
    EXCALIDRAW_ASSET_SOURCE,
    InvalidPaperAssetFile,
    MARKDOWN_IMAGE_MIME_TYPES,
    extract_excalidraw_asset_ids,
    extract_excalidraw_scene_text,
    extract_markdown_asset_ids,
    read_managed_excalidraw_drawing_asset,
)
from claudesk.core.note_wikilinks import (
    WikilinkMatch,
    extract_markdown_heading_keys,
    extract_wikilinks,
    format_canonical_note_link,
    normalize_heading_key,
    normalize_note_title_key,
    rewrite_note_link_targets,
)

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
    NoteBacklink,
    NoteOutgoingLink,
    NoteReferences,
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
from .utils import _UNSET, _rank_fts_rows


def _normalize_note_title(value: Optional[str]) -> str:
    normalized = re.sub(r"\s+", " ", value or "").strip()
    return normalized or "Untitled note"


def _normalize_existing_note_title_key(conn: sqlite3.Connection, note_id: int, title: str) -> str:
    title_key = normalize_note_title_key(title)
    conn.execute(
        "UPDATE notes SET normalized_title=? WHERE id=? AND normalized_title != ?",
        (title_key, note_id, title_key),
    )
    return title_key


def _ensure_unique_note_title(
    conn: sqlite3.Connection,
    *,
    title: str,
    exclude_note_id: Optional[int] = None,
) -> str:
    title_key = normalize_note_title_key(title)
    rows = conn.execute(
        """
        SELECT id, title, normalized_title
        FROM notes
        WHERE normalized_title=? OR normalized_title=''
        ORDER BY id ASC
        """,
        (title_key,),
    ).fetchall()
    for row in rows:
        row_id = int(row["id"])
        if exclude_note_id is not None and row_id == exclude_note_id:
            continue
        row_key = row["normalized_title"] or normalize_note_title_key(row["title"])
        if row_key == title_key:
            raise ValueError(f"Note title already exists: {title}.")
    return title_key


def _normalize_note_body(value: Optional[str]) -> str:
    return value or ""


def _normalize_paper_ids(values: Optional[list[int]]) -> list[int]:
    if not values:
        return []
    ordered: list[int] = []
    seen: set[int] = set()
    for value in values:
        try:
            paper_id = int(value)
        except (TypeError, ValueError):
            continue
        if paper_id <= 0 or paper_id in seen:
            continue
        seen.add(paper_id)
        ordered.append(paper_id)
    return ordered


def _validate_paper_ids(conn: sqlite3.Connection, paper_ids: list[int]) -> None:
    if not paper_ids:
        return
    found = set(_existing_paper_ids(conn, paper_ids))
    missing = [paper_id for paper_id in paper_ids if paper_id not in found]
    if missing:
        raise ValueError(f"Paper {missing[0]} not found.")


def _existing_paper_ids(conn: sqlite3.Connection, paper_ids: list[int]) -> list[int]:
    if not paper_ids:
        return []
    placeholders = ",".join("?" for _ in paper_ids)
    rows = conn.execute(
        f"SELECT id FROM papers WHERE id IN ({placeholders})",
        paper_ids,
    ).fetchall()
    found = {int(row["id"]) for row in rows}
    return [paper_id for paper_id in paper_ids if paper_id in found]


def _existing_note_markdown_asset_ids(conn: sqlite3.Connection, body: str) -> list[int]:
    image_ids = extract_markdown_asset_ids(body)
    drawing_ids = extract_excalidraw_asset_ids(body)
    normalized = _normalize_paper_ids([*image_ids, *drawing_ids])
    if not normalized:
        return []
    drawing_id_set = set(drawing_ids)
    placeholders = ",".join("?" for _ in normalized)
    mime_placeholders = ",".join("?" for _ in MARKDOWN_IMAGE_MIME_TYPES)
    rows = conn.execute(
        f"""
        SELECT id
        FROM assets
        WHERE id IN ({placeholders})
          AND kind=?
          AND (
            mime_type IN ({mime_placeholders})
            OR (
              id IN ({",".join("?" for _ in drawing_id_set) or "NULL"})
              AND source=?
              AND mime_type=?
              AND managed_path LIKE 'drawings/%'
            )
          )
        """,
        (
            *normalized,
            AssetKind.ATTACHMENT.value,
            *sorted(MARKDOWN_IMAGE_MIME_TYPES),
            *sorted(drawing_id_set),
            EXCALIDRAW_ASSET_SOURCE,
            EXCALIDRAW_ASSET_MIME_TYPE,
        ),
    ).fetchall()
    found = {int(row["id"]) for row in rows}
    return [asset_id for asset_id in normalized if asset_id in found]


def _drawing_search_texts_for_note_body(conn: sqlite3.Connection, body: str) -> list[str]:
    drawing_ids = extract_excalidraw_asset_ids(body)
    if not drawing_ids:
        return []
    placeholders = ",".join("?" for _ in drawing_ids)
    rows = conn.execute(
        f"""
        SELECT id, managed_path
        FROM assets
        WHERE id IN ({placeholders})
          AND source=?
          AND mime_type=?
          AND managed_path LIKE 'drawings/%'
        """,
        (*drawing_ids, EXCALIDRAW_ASSET_SOURCE, EXCALIDRAW_ASSET_MIME_TYPE),
    ).fetchall()
    paths_by_id = {int(row["id"]): row["managed_path"] for row in rows}
    texts: list[str] = []
    for asset_id in drawing_ids:
        managed_path = paths_by_id.get(asset_id)
        if not managed_path:
            continue
        try:
            scene = read_managed_excalidraw_drawing_asset(managed_path)
        except InvalidPaperAssetFile:
            continue
        text = extract_excalidraw_scene_text(scene)
        if text:
            texts.append(text)
    return texts


def _note_search_body(conn: sqlite3.Connection, body: str) -> str:
    canonical = _normalize_note_body(body)
    return "\n\n".join(
        part
        for part in [canonical, *_drawing_search_texts_for_note_body(conn, canonical)]
        if part
    )


def _set_note_paper_flag(
    conn: sqlite3.Connection,
    *,
    note_id: int,
    paper_id: int,
    flag: str,
    enabled: bool,
    timestamp: str,
) -> None:
    if flag not in {"manual", "mentioned"}:
        raise ValueError(f"Invalid note-paper flag {flag}.")
    existing = conn.execute(
        "SELECT manual, mentioned, created_at FROM note_papers WHERE note_id=? AND paper_id=?",
        (note_id, paper_id),
    ).fetchone()
    if existing is None:
        manual = int(enabled) if flag == "manual" else 0
        mentioned = int(enabled) if flag == "mentioned" else 0
        if manual == 0 and mentioned == 0:
            return
        conn.execute(
            """
            INSERT INTO note_papers (note_id, paper_id, manual, mentioned, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (note_id, paper_id, manual, mentioned, timestamp, timestamp),
        )
        return

    manual = bool(existing["manual"])
    mentioned = bool(existing["mentioned"])
    if flag == "manual":
        manual = enabled
    else:
        mentioned = enabled
    if not manual and not mentioned:
        conn.execute(
            "DELETE FROM note_papers WHERE note_id=? AND paper_id=?",
            (note_id, paper_id),
        )
        return
    conn.execute(
        "UPDATE note_papers SET manual=?, mentioned=?, updated_at=? WHERE note_id=? AND paper_id=?",
        (int(manual), int(mentioned), timestamp, note_id, paper_id),
    )


def _sync_note_links(
    conn: sqlite3.Connection,
    *,
    note_id: int,
    body: str,
    manual_paper_ids: Optional[list[int]] | object = _UNSET,
    sync_assets: bool = True,
    timestamp: Optional[str] = None,
) -> None:
    now = timestamp or datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
    if manual_paper_ids is not _UNSET:
        manual_ids = _normalize_paper_ids(manual_paper_ids)
        _validate_paper_ids(conn, manual_ids)
        current_manual_rows = conn.execute(
            "SELECT paper_id FROM note_papers WHERE note_id=? AND manual=1",
            (note_id,),
        ).fetchall()
        current_manual_ids = {int(row["paper_id"]) for row in current_manual_rows}
        next_manual_ids = set(manual_ids)
        for paper_id in sorted(current_manual_ids - next_manual_ids):
            _set_note_paper_flag(
                conn,
                note_id=note_id,
                paper_id=paper_id,
                flag="manual",
                enabled=False,
                timestamp=now,
            )
        for paper_id in manual_ids:
            _set_note_paper_flag(
                conn,
                note_id=note_id,
                paper_id=paper_id,
                flag="manual",
                enabled=True,
                timestamp=now,
            )

    mentioned_ids = _existing_paper_ids(conn, _normalize_paper_ids(extract_paper_ids(body)))
    current_mentioned_rows = conn.execute(
        "SELECT paper_id FROM note_papers WHERE note_id=? AND mentioned=1",
        (note_id,),
    ).fetchall()
    current_mentioned_ids = {int(row["paper_id"]) for row in current_mentioned_rows}
    next_mentioned_ids = set(mentioned_ids)
    for paper_id in sorted(current_mentioned_ids - next_mentioned_ids):
        _set_note_paper_flag(
            conn,
            note_id=note_id,
            paper_id=paper_id,
            flag="mentioned",
            enabled=False,
            timestamp=now,
        )
    for paper_id in mentioned_ids:
        _set_note_paper_flag(
            conn,
            note_id=note_id,
            paper_id=paper_id,
            flag="mentioned",
            enabled=True,
            timestamp=now,
        )

    if sync_assets:
        _sync_note_asset_links(conn, note_id=note_id, body=body, timestamp=now)
    _sync_note_wikilinks(conn, note_id=note_id, body=body, timestamp=now)


def _sync_note_wikilinks(
    conn: sqlite3.Connection,
    *,
    note_id: int,
    body: str,
    timestamp: str,
) -> None:
    matches = extract_wikilinks(body)
    target_keys = {
        normalize_note_title_key(match.target_title)
        for match in matches
        if match.target_note_id is None
    }
    target_ids = {
        match.target_note_id
        for match in matches
        if match.target_note_id is not None
    }
    candidates = _load_note_wikilink_candidates(conn, target_keys)
    targets_by_id = _load_note_wikilink_targets_by_id(conn, target_ids)
    conn.execute("DELETE FROM note_links WHERE source_note_id=?", (note_id,))
    for position, match in enumerate(matches):
        target_key = normalize_note_title_key(match.target_title)
        target_note_id, status, target = _resolve_wikilink_target(
            match,
            candidates.get(target_key, []),
            targets_by_id=targets_by_id,
            source_note_id=note_id,
        )
        if status == "self":
            continue
        raw_target_title = target["title"] if target is not None else match.target_title
        normalized_target_title = (
            target["normalized_title"] or normalize_note_title_key(target["title"])
            if target is not None
            else target_key
        )
        alias = _note_link_alias_for_match(match, target)
        conn.execute(
            """
            INSERT INTO note_links (
                source_note_id, target_note_id, position, raw_target_title,
                normalized_target_title, heading_fragment, alias, status,
                created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                note_id,
                target_note_id,
                position,
                raw_target_title,
                normalized_target_title,
                match.heading_fragment,
                alias,
                status,
                timestamp,
                timestamp,
            ),
        )


def _load_note_wikilink_candidates(
    conn: sqlite3.Connection,
    title_keys: set[str],
) -> dict[str, list[sqlite3.Row]]:
    if not title_keys:
        return {}
    placeholders = ",".join("?" for _ in title_keys)
    rows = conn.execute(
        f"""
        SELECT id, title, normalized_title, body
        FROM notes
        WHERE normalized_title IN ({placeholders})
        ORDER BY id ASC
        """,
        sorted(title_keys),
    ).fetchall()
    out: dict[str, list[sqlite3.Row]] = {}
    for row in rows:
        title_key = row["normalized_title"] or normalize_note_title_key(row["title"])
        out.setdefault(title_key, []).append(row)
    return out


def _load_note_wikilink_targets_by_id(
    conn: sqlite3.Connection,
    note_ids: set[int | None],
) -> dict[int, sqlite3.Row]:
    ids = sorted(note_id for note_id in note_ids if note_id is not None)
    if not ids:
        return {}
    placeholders = ",".join("?" for _ in ids)
    rows = conn.execute(
        f"""
        SELECT id, title, normalized_title, body
        FROM notes
        WHERE id IN ({placeholders})
        ORDER BY id ASC
        """,
        ids,
    ).fetchall()
    return {int(row["id"]): row for row in rows}


def _resolve_wikilink_target(
    match: WikilinkMatch,
    candidates: list[sqlite3.Row],
    *,
    targets_by_id: dict[int, sqlite3.Row],
    source_note_id: int,
) -> tuple[Optional[int], str, sqlite3.Row | None]:
    if match.target_note_id is not None:
        if match.target_note_id == source_note_id:
            return None, "self", None
        target = targets_by_id.get(match.target_note_id)
        if target is None:
            return None, "missing_target", None
        status = _note_link_status_for_heading(match, target)
        return int(target["id"]), status, target

    had_self_candidate = any(int(row["id"]) == source_note_id for row in candidates)
    candidates = [row for row in candidates if int(row["id"]) != source_note_id]
    if had_self_candidate and not candidates:
        return None, "self", None
    if not candidates:
        return None, "unresolved", None
    if len(candidates) > 1:
        return None, "ambiguous", None
    target = candidates[0]
    status = _note_link_status_for_heading(match, target)
    return int(target["id"]), status, target


def _note_link_status_for_heading(match: WikilinkMatch, target: sqlite3.Row) -> str:
    if match.heading_fragment:
        heading_keys = extract_markdown_heading_keys(target["body"])
        if normalize_heading_key(match.heading_fragment) not in heading_keys:
            return "missing_heading"
    return "resolved"


def _note_link_alias_for_match(match: WikilinkMatch, target: sqlite3.Row | None) -> str | None:
    if match.link_kind == "wikilink":
        return match.alias
    if target is None:
        return match.alias
    clean_alias = re.sub(r"\s+", " ", match.alias or "").strip()
    if not clean_alias:
        return None
    clean_target = re.sub(r"\s+", " ", target["title"] or "").strip()
    if normalize_note_title_key(clean_alias) == normalize_note_title_key(clean_target):
        return None
    return clean_alias


def _canonicalize_note_body_links(
    conn: sqlite3.Connection,
    *,
    note_id: int,
    body: str,
) -> str:
    matches = extract_wikilinks(body)
    if not matches:
        return body
    target_keys = {
        normalize_note_title_key(match.target_title)
        for match in matches
        if match.target_note_id is None
    }
    target_ids = {
        match.target_note_id
        for match in matches
        if match.target_note_id is not None
    }
    candidates = _load_note_wikilink_candidates(conn, target_keys)
    targets_by_id = _load_note_wikilink_targets_by_id(conn, target_ids)
    replacements: dict[tuple[int, int], str] = {}
    for match in matches:
        target_key = normalize_note_title_key(match.target_title)
        target_note_id, status, target = _resolve_wikilink_target(
            match,
            candidates.get(target_key, []),
            targets_by_id=targets_by_id,
            source_note_id=note_id,
        )
        if target_note_id is None or target is None or status in {"self", "ambiguous", "unresolved", "missing_target"}:
            continue
        replacement = format_canonical_note_link(
            target_note_id=target_note_id,
            target_title=target["title"],
            heading_fragment=match.heading_fragment,
            alias=_note_link_alias_for_match(match, target),
        )
        if replacement != match.text:
            replacements[(match.start, match.end)] = replacement
    return rewrite_note_link_targets(body, replacements=replacements)


def _sync_note_wikilinks_for_sources(
    conn: sqlite3.Connection,
    source_note_ids: set[int],
    *,
    timestamp: str,
) -> None:
    if not source_note_ids:
        return
    placeholders = ",".join("?" for _ in source_note_ids)
    rows = conn.execute(
        f"SELECT id, body FROM notes WHERE id IN ({placeholders})",
        sorted(source_note_ids),
    ).fetchall()
    for row in rows:
        _sync_note_wikilinks(
            conn,
            note_id=int(row["id"]),
            body=row["body"] or "",
            timestamp=timestamp,
        )


def _refresh_wikilinks_for_title_keys(
    conn: sqlite3.Connection,
    title_keys: set[str],
    *,
    timestamp: str,
) -> None:
    keys = {key for key in title_keys if key}
    if not keys:
        return
    placeholders = ",".join("?" for _ in keys)
    rows = conn.execute(
        f"""
        SELECT DISTINCT source_note_id
        FROM note_links
        WHERE normalized_target_title IN ({placeholders})
        """,
        sorted(keys),
    ).fetchall()
    _sync_note_wikilinks_for_sources(
        conn,
        {int(row["source_note_id"]) for row in rows},
        timestamp=timestamp,
    )


def _refresh_inbound_wikilinks_to_note(
    conn: sqlite3.Connection,
    note_id: int,
    *,
    timestamp: str,
) -> None:
    rows = conn.execute(
        "SELECT DISTINCT source_note_id FROM note_links WHERE target_note_id=?",
        (note_id,),
    ).fetchall()
    _sync_note_wikilinks_for_sources(
        conn,
        {int(row["source_note_id"]) for row in rows},
        timestamp=timestamp,
    )


def _rewrite_wikilinks_to_renamed_note(
    conn: sqlite3.Connection,
    *,
    target_note_id: int,
    old_title_key: str,
    new_title: str,
    timestamp: str,
) -> None:
    rows = conn.execute(
        """
        SELECT DISTINCT n.id, n.body
        FROM note_links nl
        JOIN notes n ON n.id = nl.source_note_id
        WHERE nl.target_note_id=?
        ORDER BY n.id ASC
        """,
        (target_note_id,),
    ).fetchall()
    for row in rows:
        source_note_id = int(row["id"])
        body = row["body"] or ""
        rewritten = _canonicalize_note_body_links(
            conn,
            note_id=source_note_id,
            body=body,
        )
        if rewritten == body:
            continue
        conn.execute(
            "UPDATE notes SET body=?, search_body=?, updated_at=? WHERE id=?",
            (rewritten, _note_search_body(conn, rewritten), timestamp, source_note_id),
        )
        _sync_note_links(
            conn,
            note_id=source_note_id,
            body=rewritten,
            timestamp=timestamp,
        )


def _sync_note_asset_links(
    conn: sqlite3.Connection,
    *,
    note_id: int,
    body: str,
    timestamp: str,
) -> None:
    current_rows = conn.execute(
        "SELECT asset_id, status FROM note_assets WHERE note_id=?",
        (note_id,),
    ).fetchall()
    current_committed_asset_ids = {
        int(row["asset_id"])
        for row in current_rows
        if row["status"] == "committed"
    }
    referenced_ids = _existing_note_markdown_asset_ids(conn, body)
    next_asset_ids = set(referenced_ids)

    removed_asset_ids = sorted(current_committed_asset_ids - next_asset_ids)
    for asset_id in removed_asset_ids:
        conn.execute(
            "DELETE FROM note_assets WHERE note_id=? AND asset_id=?",
            (note_id, asset_id),
        )
    for asset_id in referenced_ids:
        conn.execute(
            """
            INSERT INTO note_assets (note_id, asset_id, status, created_at)
            VALUES (?, ?, 'committed', ?)
            ON CONFLICT(note_id, asset_id) DO UPDATE SET status='committed'
            """,
            (note_id, asset_id, timestamp),
        )
    for asset_id in removed_asset_ids:
        _delete_asset_if_unowned(conn, asset_id)


def _load_note_link_map(
    conn: sqlite3.Connection,
    note_ids: list[int],
) -> dict[int, tuple[list[int], list[int], list[int]]]:
    if not note_ids:
        return {}
    placeholders = ",".join("?" for _ in note_ids)
    rows = conn.execute(
        f"""
        SELECT note_id, paper_id, manual, mentioned, created_at
        FROM note_papers
        WHERE note_id IN ({placeholders})
        ORDER BY created_at ASC, paper_id ASC
        """,
        note_ids,
    ).fetchall()
    out: dict[int, tuple[list[int], list[int], list[int]]] = {
        note_id: ([], [], [])
        for note_id in note_ids
    }
    for row in rows:
        note_id = int(row["note_id"])
        linked, mentioned, manual = out.setdefault(note_id, ([], [], []))
        paper_id = int(row["paper_id"])
        if (row["manual"] or row["mentioned"]) and paper_id not in linked:
            linked.append(paper_id)
        if row["mentioned"] and paper_id not in mentioned:
            mentioned.append(paper_id)
        if row["manual"] and paper_id not in manual:
            manual.append(paper_id)
    return out


def _row_to_note(
    row: sqlite3.Row,
    link_map: Optional[dict[int, tuple[list[int], list[int], list[int]]]] = None,
) -> Note:
    linked, mentioned, manual = ([], [], [])
    if link_map is not None:
        linked, mentioned, manual = link_map.get(int(row["id"]), ([], [], []))
    return Note(
        id=row["id"],
        title=row["title"],
        body=row["body"],
        search_body=row["search_body"] if "search_body" in row.keys() else row["body"],
        linked_paper_ids=list(linked),
        mentioned_paper_ids=list(mentioned),
        manual_paper_ids=list(manual),
        created_at=datetime.fromisoformat(row["created_at"]),
        updated_at=datetime.fromisoformat(row["updated_at"]),
    )


def _hydrate_notes(conn: sqlite3.Connection, rows: Sequence[sqlite3.Row]) -> list[Note]:
    if not rows:
        return []
    note_ids = [int(row["id"]) for row in rows]
    link_map = _load_note_link_map(conn, note_ids)
    return [_row_to_note(row, link_map) for row in rows]


def _note_reference_preview(body: str | None, limit: int = 180) -> str:
    compact = re.sub(r"\s+", " ", body or "").strip()
    return compact[:limit]


def _row_to_outgoing_note_link(row: sqlite3.Row) -> NoteOutgoingLink:
    return NoteOutgoingLink(
        id=int(row["id"]),
        target_note_id=int(row["target_note_id"]) if row["target_note_id"] is not None else None,
        target_title=row["target_title"],
        raw_target_title=row["raw_target_title"],
        normalized_target_title=row["normalized_target_title"],
        heading_fragment=row["heading_fragment"],
        alias=row["alias"],
        status=row["status"],
        created_at=datetime.fromisoformat(row["created_at"]),
        updated_at=datetime.fromisoformat(row["updated_at"]),
    )


def _row_to_note_backlink(row: sqlite3.Row) -> NoteBacklink:
    return NoteBacklink(
        id=int(row["id"]),
        source_note_id=int(row["source_note_id"]),
        source_title=row["source_title"],
        source_preview=_note_reference_preview(row["source_body"]),
        heading_fragment=row["heading_fragment"],
        alias=row["alias"],
        status=row["status"],
        created_at=datetime.fromisoformat(row["created_at"]),
        updated_at=datetime.fromisoformat(row["updated_at"]),
    )


def _load_note_summary_map(
    conn: sqlite3.Connection,
    paper_ids: list[int],
) -> dict[int, tuple[int, Optional[str]]]:
    normalized = _normalize_paper_ids(paper_ids)
    if not normalized:
        return {}
    placeholders = ",".join("?" for _ in normalized)
    count_rows = conn.execute(
        f"""
        SELECT paper_id, COUNT(DISTINCT note_id) AS note_count
        FROM note_papers
        WHERE paper_id IN ({placeholders})
        GROUP BY paper_id
        """,
        normalized,
    ).fetchall()
    counts = {int(row["paper_id"]): int(row["note_count"]) for row in count_rows}
    latest_rows = conn.execute(
        f"""
        SELECT np.paper_id, n.title, n.body
        FROM note_papers np
        JOIN notes n ON n.id = np.note_id
        WHERE np.paper_id IN ({placeholders})
          AND n.id = (
              SELECT np2.note_id
              FROM note_papers np2
              JOIN notes n2 ON n2.id = np2.note_id
              WHERE np2.paper_id = np.paper_id
              ORDER BY n2.updated_at DESC, n2.id DESC
              LIMIT 1
          )
        """,
        normalized,
    ).fetchall()
    previews: dict[int, Optional[str]] = {}
    for row in latest_rows:
        raw = row["body"] or row["title"] or ""
        compact = re.sub(r"\s+", " ", raw).strip()
        previews[int(row["paper_id"])] = compact[:240] if compact else None
    return {
        paper_id: (counts.get(paper_id, 0), previews.get(paper_id))
        for paper_id in normalized
    }


def _load_paper_pdf_status_map(
    conn: sqlite3.Connection,
    paper_ids: list[int],
) -> dict[int, PaperPdfStatus]:
    normalized = _normalize_paper_ids(paper_ids)
    if not normalized:
        return {}
    placeholders = ",".join("?" for _ in normalized)
    rows = conn.execute(
        f"""
        SELECT pa.paper_id, a.parse_status
        FROM paper_assets pa
        JOIN assets a ON a.id = pa.asset_id
        WHERE pa.paper_id IN ({placeholders})
          AND a.kind=?
        """,
        (*normalized, AssetKind.PDF.value),
    ).fetchall()
    priorities: dict[PaperPdfStatus, int] = {
        "none": 0,
        "available": 1,
        "failed": 2,
        "queued": 3,
        "parsed": 4,
    }
    status_by_paper: dict[int, PaperPdfStatus] = {
        paper_id: "none" for paper_id in normalized
    }
    for row in rows:
        paper_id = int(row["paper_id"])
        parse_status = row["parse_status"]
        if parse_status == AssetParseStatus.PARSED.value:
            pdf_status: PaperPdfStatus = "parsed"
        elif parse_status == AssetParseStatus.QUEUED.value:
            pdf_status = "queued"
        elif parse_status == AssetParseStatus.FAILED.value:
            pdf_status = "failed"
        else:
            pdf_status = "available"
        if priorities[pdf_status] > priorities[status_by_paper.get(paper_id, "none")]:
            status_by_paper[paper_id] = pdf_status
    return status_by_paper


def create_note(
    conn: sqlite3.Connection,
    *,
    title: str,
    body: str = "",
    manual_paper_ids: Optional[list[int]] = None,
    created_at: Optional[datetime] = None,
) -> Note:
    now = created_at or datetime.now(timezone.utc).replace(tzinfo=None)
    timestamp = now.isoformat()
    normalized_title = _normalize_note_title(title)
    title_key = _ensure_unique_note_title(conn, title=normalized_title)
    normalized_body = _normalize_note_body(body)
    cur = conn.execute(
        """
        INSERT INTO notes (title, normalized_title, body, search_body, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            normalized_title,
            title_key,
            normalized_body,
            _note_search_body(conn, normalized_body),
            timestamp,
            timestamp,
        ),
    )
    note_id = int(cur.lastrowid)  # type: ignore[arg-type]
    canonical_body = _canonicalize_note_body_links(
        conn,
        note_id=note_id,
        body=normalized_body,
    )
    if canonical_body != normalized_body:
        normalized_body = canonical_body
        conn.execute(
            "UPDATE notes SET body=?, search_body=? WHERE id=?",
            (normalized_body, _note_search_body(conn, normalized_body), note_id),
        )
    _sync_note_links(
        conn,
        note_id=note_id,
        body=normalized_body,
        manual_paper_ids=manual_paper_ids or [],
        timestamp=timestamp,
    )
    _refresh_wikilinks_for_title_keys(conn, {title_key}, timestamp=timestamp)
    note = get_note(conn, note_id)
    if note is None:
        raise ValueError(f"Note {note_id} not found.")
    return note


def get_note(conn: sqlite3.Connection, note_id: int) -> Optional[Note]:
    row = conn.execute("SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()
    if row is None:
        return None
    return _hydrate_notes(conn, [row])[0]


def get_note_references(conn: sqlite3.Connection, note_id: int) -> NoteReferences:
    note_row = conn.execute(
        "SELECT id FROM notes WHERE id=?",
        (note_id,),
    ).fetchone()
    if note_row is None:
        raise ValueError(f"Note {note_id} not found.")
    outgoing_rows = conn.execute(
        """
        SELECT nl.*, target.title AS target_title
        FROM note_links nl
        JOIN notes target ON target.id = nl.target_note_id
        WHERE nl.source_note_id=?
        ORDER BY nl.position ASC, nl.id ASC
        """,
        (note_id,),
    ).fetchall()
    backlink_rows = conn.execute(
        """
        SELECT nl.*, source.title AS source_title, source.body AS source_body
        FROM note_links nl
        JOIN notes source ON source.id = nl.source_note_id
        WHERE nl.target_note_id=?
          AND nl.source_note_id != ?
        ORDER BY source.updated_at DESC, source.id DESC, nl.position ASC
        """,
        (note_id, note_id),
    ).fetchall()
    return NoteReferences(
        outgoing=[_row_to_outgoing_note_link(row) for row in outgoing_rows],
        backlinks=[_row_to_note_backlink(row) for row in backlink_rows],
    )


def list_notes(
    conn: sqlite3.Connection,
    *,
    paper_id: Optional[int] = None,
    standalone: Optional[bool] = None,
    limit: int = 100,
    offset: int = 0,
) -> list[Note]:
    params: list[object] = []
    query = "SELECT DISTINCT n.* FROM notes n"
    if paper_id is not None:
        query += " JOIN note_papers np_filter ON np_filter.note_id = n.id AND np_filter.paper_id = ?"
        params.append(paper_id)
    elif standalone is True:
        query += " LEFT JOIN note_papers np_filter ON np_filter.note_id = n.id"
    if standalone is True:
        query += " WHERE np_filter.note_id IS NULL"
    elif standalone is False:
        query += " WHERE EXISTS (SELECT 1 FROM note_papers np WHERE np.note_id = n.id)"
    query += " ORDER BY n.updated_at DESC, n.id DESC LIMIT ? OFFSET ?"
    params.append(max(1, min(int(limit), 500)))
    params.append(max(0, int(offset)))
    rows = conn.execute(query, params).fetchall()
    return _hydrate_notes(conn, rows)


def update_note(
    conn: sqlite3.Connection,
    note_id: int,
    *,
    title: Optional[str] | object = _UNSET,
    body: Optional[str] | object = _UNSET,
    manual_paper_ids: Optional[list[int]] | object = _UNSET,
) -> Note:
    existing = get_note(conn, note_id)
    if existing is None:
        raise ValueError(f"Note {note_id} not found.")

    assignments: list[str] = []
    params: list[object] = []
    next_body = existing.body
    old_title_key = _normalize_existing_note_title_key(conn, note_id, existing.title)
    next_title_key = old_title_key
    next_title_for_rewrite = existing.title
    title_was_renamed = False
    if title is not _UNSET:
        next_title = _normalize_note_title(title)
        next_title_for_rewrite = next_title
        next_title_key = normalize_note_title_key(next_title)
        if next_title_key != old_title_key:
            _ensure_unique_note_title(conn, title=next_title, exclude_note_id=note_id)
            title_was_renamed = True
        elif next_title != existing.title:
            title_was_renamed = True
        assignments.append("title=?")
        params.append(next_title)
        assignments.append("normalized_title=?")
        params.append(next_title_key)
    if body is not _UNSET:
        next_body = _normalize_note_body(body)
        next_body = _canonicalize_note_body_links(
            conn,
            note_id=note_id,
            body=next_body,
        )
        assignments.append("body=?")
        params.append(next_body)
        assignments.append("search_body=?")
        params.append(_note_search_body(conn, next_body))

    now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
    if assignments or manual_paper_ids is not _UNSET:
        assignments.append("updated_at=?")
        params.append(now)
        params.append(note_id)
        conn.execute(
            f"UPDATE notes SET {', '.join(assignments)} WHERE id=?",
            params,
        )
    if title_was_renamed:
        _rewrite_wikilinks_to_renamed_note(
            conn,
            target_note_id=note_id,
            old_title_key=old_title_key,
            new_title=next_title_for_rewrite,
            timestamp=now,
        )
    if body is not _UNSET or manual_paper_ids is not _UNSET:
        current_body = conn.execute("SELECT body FROM notes WHERE id=?", (note_id,)).fetchone()["body"]
        _sync_note_links(
            conn,
            note_id=note_id,
            body=current_body or "",
            manual_paper_ids=manual_paper_ids,
            sync_assets=body is not _UNSET,
            timestamp=now,
        )
    if title_was_renamed:
        _refresh_wikilinks_for_title_keys(conn, {old_title_key, next_title_key}, timestamp=now)
    elif body is not _UNSET:
        _refresh_inbound_wikilinks_to_note(conn, note_id, timestamp=now)

    note = get_note(conn, note_id)
    if note is None:
        raise ValueError(f"Note {note_id} not found.")
    return note


def refresh_note_search_text_for_drawing_asset(
    conn: sqlite3.Connection,
    asset_id: int,
    *,
    updated_at: Optional[datetime] = None,
) -> list[int]:
    timestamp = (updated_at or datetime.now(timezone.utc).replace(tzinfo=None)).isoformat()
    rows = conn.execute(
        """
        SELECT DISTINCT n.id, n.body
        FROM notes n
        JOIN note_assets na ON na.note_id = n.id
        WHERE na.asset_id=?
          AND na.status='committed'
        ORDER BY n.id ASC
        """,
        (asset_id,),
    ).fetchall()
    refreshed: list[int] = []
    for row in rows:
        note_id = int(row["id"])
        conn.execute(
            "UPDATE notes SET search_body=?, updated_at=? WHERE id=?",
            (_note_search_body(conn, row["body"] or ""), timestamp, note_id),
        )
        refreshed.append(note_id)
    return refreshed


def delete_note(conn: sqlite3.Connection, note_id: int) -> None:
    existing = get_note(conn, note_id)
    if existing is None:
        raise ValueError(f"Note {note_id} not found.")
    title_key = _normalize_existing_note_title_key(conn, note_id, existing.title)
    inbound_rows = conn.execute(
        """
        SELECT DISTINCT source_note_id
        FROM note_links
        WHERE target_note_id=? OR normalized_target_title=?
        """,
        (note_id, title_key),
    ).fetchall()
    affected_source_note_ids = {int(row["source_note_id"]) for row in inbound_rows}
    affected_source_note_ids.discard(note_id)
    asset_ids = [
        int(asset_row["asset_id"])
        for asset_row in conn.execute(
            "SELECT asset_id FROM note_assets WHERE note_id=?",
            (note_id,),
        ).fetchall()
    ]
    cur = conn.execute("DELETE FROM notes WHERE id=?", (note_id,))
    if cur.rowcount == 0:
        raise ValueError(f"Note {note_id} not found.")
    for asset_id in asset_ids:
        _delete_asset_if_unowned(conn, asset_id)
    deleted_at = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
    _sync_note_wikilinks_for_sources(conn, affected_source_note_ids, timestamp=deleted_at)


def link_note_paper(conn: sqlite3.Connection, note_id: int, paper_id: int) -> Note:
    if get_note(conn, note_id) is None:
        raise ValueError(f"Note {note_id} not found.")
    _validate_paper_ids(conn, [paper_id])
    now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
    _set_note_paper_flag(
        conn,
        note_id=note_id,
        paper_id=paper_id,
        flag="manual",
        enabled=True,
        timestamp=now,
    )
    conn.execute("UPDATE notes SET updated_at=? WHERE id=?", (now, note_id))
    note = get_note(conn, note_id)
    if note is None:
        raise ValueError(f"Note {note_id} not found.")
    return note


def unlink_note_paper(conn: sqlite3.Connection, note_id: int, paper_id: int) -> Note:
    if get_note(conn, note_id) is None:
        raise ValueError(f"Note {note_id} not found.")
    now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
    _set_note_paper_flag(
        conn,
        note_id=note_id,
        paper_id=paper_id,
        flag="manual",
        enabled=False,
        timestamp=now,
    )
    conn.execute("UPDATE notes SET updated_at=? WHERE id=?", (now, note_id))
    note = get_note(conn, note_id)
    if note is None:
        raise ValueError(f"Note {note_id} not found.")
    return note


def search_notes(
    conn: sqlite3.Connection,
    query: str,
    *,
    limit: int = 50,
) -> list[Note]:
    rows = _rank_fts_rows(
        query,
        limit=limit,
        fetch_rows=lambda fts_query, pool_limit: conn.execute(
            """
            SELECT n.*
            FROM notes_fts
            JOIN notes n ON n.id = notes_fts.rowid
            WHERE notes_fts MATCH ?
            ORDER BY
                bm25(notes_fts, 8.0, 3.0),
                n.updated_at DESC,
                n.id DESC
            LIMIT ?
            """,
            (fts_query, pool_limit),
        ).fetchall(),
        fields=lambda row: (
            (row["title"] or "", 8.0),
            (row["search_body"] or row["body"] or "", 3.0),
        ),
    )
    return _hydrate_notes(conn, rows)
