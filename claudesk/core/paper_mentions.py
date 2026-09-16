from __future__ import annotations

import re
import sqlite3

PAPER_MENTION_RE = re.compile(r"\[(?P<label>[^\]]+)\]\(paper://(?P<paper_id>\d+)\)")
BARE_PAPER_URI_RE = re.compile(r"(?<!\]\()paper://(?P<paper_id>\d+)(?![A-Za-z0-9_])")
MARKDOWN_LINK_RE = re.compile(r"\[[^\]]+\]\([^)]+\)")


def extract_paper_ids(text: str) -> list[int]:
    seen: set[int] = set()
    ordered: list[int] = []
    for match in PAPER_MENTION_RE.finditer(text):
        paper_id = int(match.group("paper_id"))
        if paper_id in seen:
            continue
        seen.add(paper_id)
        ordered.append(paper_id)
    return ordered


def sanitize_paper_mention_label(title: str) -> str:
    return re.sub(r"\s+", " ", (title or "").replace("[", "").replace("]", "")).strip()


def build_paper_mention(paper_id: int, title: str) -> str:
    label = sanitize_paper_mention_label(title) or f"Paper {paper_id}"
    return f"[@{label}](paper://{paper_id})"


def normalize_text_paper_mentions(
    conn: sqlite3.Connection,
    text: str,
    *,
    paper_ids: list[int] | tuple[int, ...] | None = None,
) -> str:
    """Convert explicit paper refs in task/log text into clickable markdown links."""
    current_text = text or ""
    explicit_ids = _normalize_ids(paper_ids or [])
    bare_ids = _extract_bare_paper_uri_ids(current_text)
    markdown_ids = extract_paper_ids(current_text)
    paper_titles = _paper_titles_by_id(conn, [*explicit_ids, *bare_ids, *markdown_ids])

    def replace_bare_uri(match: re.Match[str]) -> str:
        paper_id = int(match.group("paper_id"))
        return build_paper_mention(paper_id, paper_titles[paper_id])

    normalized = BARE_PAPER_URI_RE.sub(replace_bare_uri, current_text)
    present_ids = set(extract_paper_ids(normalized))
    for paper_id in explicit_ids:
        if paper_id in present_ids:
            continue
        normalized, replaced = _replace_title_reference(
            normalized,
            paper_titles[paper_id],
            build_paper_mention(paper_id, paper_titles[paper_id]),
        )
        if replaced:
            present_ids.add(paper_id)
    missing_mentions = [
        build_paper_mention(paper_id, paper_titles[paper_id])
        for paper_id in explicit_ids
        if paper_id not in present_ids
    ]
    if not missing_mentions:
        return normalized
    suffix = " ".join(missing_mentions)
    stripped = normalized.rstrip()
    return f"{stripped} {suffix}" if stripped else suffix


def _normalize_ids(raw_ids: list[int] | tuple[int, ...]) -> list[int]:
    seen: set[int] = set()
    ordered: list[int] = []
    for raw_id in raw_ids:
        paper_id = int(raw_id)
        if paper_id <= 0:
            raise ValueError(f"Paper {paper_id} not found.")
        if paper_id in seen:
            continue
        seen.add(paper_id)
        ordered.append(paper_id)
    return ordered


def _extract_bare_paper_uri_ids(text: str) -> list[int]:
    seen: set[int] = set()
    ordered: list[int] = []
    for match in BARE_PAPER_URI_RE.finditer(text or ""):
        paper_id = int(match.group("paper_id"))
        if paper_id in seen:
            continue
        seen.add(paper_id)
        ordered.append(paper_id)
    return ordered


def _replace_title_reference(text: str, title: str, mention: str) -> tuple[str, bool]:
    pattern = _title_reference_pattern(title)
    if pattern is None:
        return text, False
    protected_ranges = [match.span() for match in MARKDOWN_LINK_RE.finditer(text)]
    chunks: list[str] = []
    cursor = 0
    replaced = False
    removed_duplicate = False
    for match in pattern.finditer(text):
        start, end = match.start(), match.end()
        if any(start >= range_start and end <= range_end for range_start, range_end in protected_ranges):
            continue
        if not replaced:
            chunks.append(text[cursor:start])
            chunks.append(mention)
            replaced = True
            cursor = end
        elif match.group(0).startswith("@"):
            chunks.append(text[cursor:start])
            cursor = end
            removed_duplicate = True
    if not replaced:
        return text, False
    chunks.append(text[cursor:])
    normalized = "".join(chunks)
    if removed_duplicate:
        normalized = re.sub(r"[ \t]{2,}", " ", normalized).strip()
    return normalized, True


def _title_reference_pattern(title: str) -> re.Pattern[str] | None:
    parts = [part for part in re.split(r"\s+", title or "") if part]
    if not parts:
        return None
    body = r"\s+".join(re.escape(part) for part in parts)
    return re.compile(rf"(?<![\w])@?{body}(?![\w])", re.IGNORECASE)


def _paper_titles_by_id(conn: sqlite3.Connection, paper_ids: list[int]) -> dict[int, str]:
    unique_ids = _normalize_ids(paper_ids)
    if not unique_ids:
        return {}
    placeholders = ",".join("?" for _ in unique_ids)
    rows = conn.execute(
        f"SELECT id, title FROM papers WHERE id IN ({placeholders})",
        unique_ids,
    ).fetchall()
    titles = {int(row[0]): str(row[1] or "") for row in rows}
    missing_ids = [paper_id for paper_id in unique_ids if paper_id not in titles]
    if missing_ids:
        raise ValueError(f"Paper {missing_ids[0]} not found.")
    return titles
