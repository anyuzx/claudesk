from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Iterable
from urllib.parse import quote, unquote


@dataclass(frozen=True)
class WikilinkMatch:
    start: int
    end: int
    text: str
    link_kind: str
    target_note_id: int | None
    raw_target: str
    target_title: str
    heading_fragment: str | None
    raw_heading_fragment: str | None
    alias: str | None
    raw_alias: str | None


def normalize_note_title_key(value: str | None) -> str:
    normalized = unicodedata.normalize("NFKC", value or "")
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized.casefold()


def normalize_heading_key(value: str | None) -> str:
    normalized = unicodedata.normalize("NFKC", value or "")
    normalized = re.sub(r"\s+", " ", normalized).strip().strip("#").strip()
    return normalized.casefold()


def extract_wikilinks(markdown: str | None) -> list[WikilinkMatch]:
    text = markdown or ""
    ignored = _ignored_intervals(text)
    matches = [
        *_extract_legacy_wikilinks(text, ignored),
        *_extract_canonical_note_links(text, ignored),
    ]
    return sorted(matches, key=lambda match: (match.start, match.end))


def format_canonical_note_link(
    *,
    target_note_id: int,
    target_title: str,
    heading_fragment: str | None = None,
    alias: str | None = None,
) -> str:
    label = _format_canonical_note_link_label(
        target_title=target_title,
        heading_fragment=heading_fragment,
        alias=alias,
    )
    label = _escape_markdown_link_label(label)
    href = f"note://{target_note_id}"
    if heading_fragment:
        href = f"{href}#{quote(heading_fragment, safe='')}"
    return f"[{label}]({href})"


def rewrite_note_link_targets(
    markdown: str,
    *,
    replacements: dict[tuple[int, int], str],
) -> str:
    if not replacements:
        return markdown
    out = markdown
    for (start, end), replacement in sorted(replacements.items(), reverse=True):
        out = f"{out[:start]}{replacement}{out[end:]}"
    return out


def _extract_legacy_wikilinks(text: str, ignored: list[tuple[int, int]]) -> list[WikilinkMatch]:
    matches: list[WikilinkMatch] = []
    index = 0
    ignored_index = 0
    while index < len(text):
        while ignored_index < len(ignored) and ignored[ignored_index][1] <= index:
            ignored_index += 1
        if ignored_index < len(ignored) and ignored[ignored_index][0] <= index < ignored[ignored_index][1]:
            index = ignored[ignored_index][1]
            continue
        start = text.find("[[", index)
        if start == -1:
            break
        if _point_in_intervals(start, ignored):
            index = start + 2
            continue
        end = text.find("]]", start + 2)
        if end == -1:
            break
        if _point_in_intervals(end, ignored):
            index = end + 2
            continue
        content = text[start + 2:end]
        parsed = _parse_wikilink_content(content)
        if parsed is not None:
            raw_target, target_title, raw_heading, heading, raw_alias, alias = parsed
            matches.append(
                WikilinkMatch(
                    start=start,
                    end=end + 2,
                    text=text[start:end + 2],
                    link_kind="wikilink",
                    target_note_id=None,
                    raw_target=raw_target,
                    target_title=target_title,
                    heading_fragment=heading,
                    raw_heading_fragment=raw_heading,
                    alias=alias,
                    raw_alias=raw_alias,
                )
            )
        index = end + 2
    return matches


def _extract_canonical_note_links(text: str, ignored: list[tuple[int, int]]) -> list[WikilinkMatch]:
    matches: list[WikilinkMatch] = []
    index = 0
    while index < len(text):
        start = text.find("[", index)
        if start == -1:
            break
        index = start + 1
        if start > 0 and text[start - 1] == "!":
            continue
        if _point_in_intervals(start, ignored):
            continue
        label_end = _find_markdown_link_label_end(text, start + 1)
        if label_end is None:
            continue
        destination_start = label_end + 2
        if label_end + 1 >= len(text) or text[label_end + 1] != "(":
            continue
        parsed_destination = _parse_canonical_note_destination(text, destination_start)
        if parsed_destination is None:
            continue
        end, target_note_id, raw_heading = parsed_destination
        label = _unescape_markdown_link_label(text[start + 1:label_end])
        parsed = _parse_canonical_note_label(label, raw_heading)
        if parsed is None:
            continue
        target_title, alias = parsed
        index = end
        matches.append(
            WikilinkMatch(
                start=start,
                end=end,
                text=text[start:end],
                link_kind="canonical",
                target_note_id=target_note_id,
                raw_target=target_title,
                target_title=target_title,
                heading_fragment=raw_heading,
                raw_heading_fragment=raw_heading,
                alias=alias,
                raw_alias=alias,
            )
        )
    return matches


def _find_markdown_link_label_end(text: str, start: int) -> int | None:
    index = start
    while index < len(text):
        char = text[index]
        if char == "\\" and index + 1 < len(text) and text[index + 1] in {"\\", "]"}:
            index += 2
            continue
        if char == "]":
            return index
        if char in "\r\n":
            return None
        index += 1
    return None


def _parse_canonical_note_destination(text: str, start: int) -> tuple[int, int, str | None] | None:
    prefix = "note://"
    if not text.startswith(prefix, start):
        return None
    index = start + len(prefix)
    id_start = index
    while index < len(text) and text[index].isdigit():
        index += 1
    if index == id_start:
        return None
    target_note_id = int(text[id_start:index])
    heading_fragment = None
    if index < len(text) and text[index] == "#":
        heading_start = index + 1
        index = heading_start
        while index < len(text) and text[index] not in ") \t\r\n":
            index += 1
        if index == heading_start:
            return None
        heading_fragment = unquote(text[heading_start:index])
    if index >= len(text) or text[index] != ")":
        return None
    return index + 1, target_note_id, heading_fragment


def _escape_markdown_link_label(value: str) -> str:
    return (
        re.sub(r"\s+", " ", value).strip()
        .replace("\\", "\\\\")
        .replace("]", "\\]")
    )


def _unescape_markdown_link_label(value: str) -> str:
    out: list[str] = []
    index = 0
    while index < len(value):
        char = value[index]
        if char == "\\" and index + 1 < len(value) and value[index + 1] in {"\\", "]"}:
            out.append(value[index + 1])
            index += 2
            continue
        out.append(char)
        index += 1
    return "".join(out)


def rewrite_wikilink_targets(markdown: str, *, old_title_key: str, new_title: str) -> str:
    if not old_title_key:
        return markdown
    out = markdown
    for match in reversed(extract_wikilinks(markdown)):
        if normalize_note_title_key(match.target_title) != old_title_key:
            continue
        target = new_title
        if match.raw_heading_fragment is not None:
            target = f"{target}#{match.raw_heading_fragment}"
        if match.raw_alias is not None:
            target = f"{target}|{match.raw_alias}"
        out = f"{out[:match.start]}[[{target}]]{out[match.end:]}"
    return out


def extract_markdown_heading_keys(markdown: str | None) -> set[str]:
    text = markdown or ""
    ignored = _ignored_intervals(text, include_inline=False)
    keys: set[str] = set()
    offset = 0
    for line in text.splitlines(keepends=True):
        line_end = offset + len(line)
        if _range_intersects(offset, line_end, ignored):
            offset = line_end
            continue
        raw = line.rstrip("\r\n")
        match = re.match(r"^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$", raw)
        if match is not None:
            heading = _strip_inline_markdown(match.group(1))
            key = normalize_heading_key(heading)
            if key:
                keys.add(key)
                slug = markdown_heading_slug(heading)
                if slug:
                    keys.add(slug)
        offset = line_end
    return keys


def markdown_heading_slug(value: str | None) -> str:
    normalized = unicodedata.normalize("NFKD", value or "").casefold()
    normalized = re.sub(r"[^\w\s-]", "", normalized)
    normalized = re.sub(r"[\s_]+", "-", normalized).strip("-")
    return normalized


def _parse_wikilink_content(
    content: str,
) -> tuple[str, str, str | None, str | None, str | None, str | None] | None:
    raw_target, separator, raw_alias = content.partition("|")
    raw_target = raw_target.strip()
    if not raw_target:
        return None
    raw_title, heading_separator, raw_heading = raw_target.partition("#")
    title = re.sub(r"\s+", " ", raw_title).strip()
    if not title:
        return None
    heading = re.sub(r"\s+", " ", raw_heading).strip() if heading_separator else None
    if heading == "":
        heading = None
    alias = re.sub(r"\s+", " ", raw_alias).strip() if separator else None
    if alias == "":
        alias = None
    return raw_target, title, raw_heading if heading_separator else None, heading, raw_alias if separator else None, alias


def _parse_canonical_note_label(label: str, heading_fragment: str | None) -> tuple[str, str | None] | None:
    clean_label = re.sub(r"\s+", " ", label).strip()
    if not clean_label:
        return None
    if not clean_label.startswith("@"):
        return clean_label, clean_label

    target_label = clean_label[1:].strip()
    if not target_label:
        return None
    if heading_fragment:
        delimiter = ">"
        raw_title, separator, raw_heading = target_label.rpartition(delimiter)
        if separator and normalize_heading_key(raw_heading) == normalize_heading_key(heading_fragment):
            target_label = raw_title.strip()
    return target_label, None


def _format_canonical_note_link_label(
    *,
    target_title: str,
    heading_fragment: str | None,
    alias: str | None,
) -> str:
    clean_alias = re.sub(r"\s+", " ", alias or "").strip()
    if clean_alias:
        return clean_alias
    clean_title = re.sub(r"\s+", " ", target_title).strip()
    clean_heading = re.sub(r"\s+", " ", heading_fragment or "").strip()
    if clean_heading:
        return f"@{clean_title} > {clean_heading}"
    return f"@{clean_title}"


def _ignored_intervals(text: str, *, include_inline: bool = True) -> list[tuple[int, int]]:
    intervals = _fenced_intervals(text)
    intervals.extend(_display_math_intervals(text, intervals))
    if include_inline:
        intervals = _merge_intervals(intervals)
        intervals.extend(_inline_code_intervals(text, intervals))
        intervals = _merge_intervals(intervals)
        intervals.extend(_latex_math_intervals(text, intervals))
        intervals = _merge_intervals(intervals)
        intervals.extend(_inline_math_intervals(text, intervals))
    return _merge_intervals(intervals)


def _fenced_intervals(text: str) -> list[tuple[int, int]]:
    intervals: list[tuple[int, int]] = []
    open_start: int | None = None
    fence_char = ""
    fence_len = 0
    offset = 0
    for line in text.splitlines(keepends=True):
        stripped = line.rstrip("\r\n")
        if open_start is None:
            match = re.match(r"^ {0,3}(`{3,}|~{3,})", stripped)
            if match is not None:
                marker = match.group(1)
                open_start = offset
                fence_char = marker[0]
                fence_len = len(marker)
        else:
            match = re.match(rf"^ {{0,3}}({re.escape(fence_char)}{{{fence_len},}})\s*$", stripped)
            if match is not None:
                intervals.append((open_start, offset + len(line)))
                open_start = None
                fence_char = ""
                fence_len = 0
        offset += len(line)
    if open_start is not None:
        intervals.append((open_start, len(text)))
    return intervals


def _display_math_intervals(text: str, ignored: Iterable[tuple[int, int]]) -> list[tuple[int, int]]:
    ignored_intervals = _merge_intervals(ignored)
    intervals: list[tuple[int, int]] = []
    open_start: int | None = None
    offset = 0
    for line in text.splitlines(keepends=True):
        line_end = offset + len(line)
        stripped = line.strip()
        if not _range_intersects(offset, line_end, ignored_intervals) and stripped == "$$":
            if open_start is None:
                open_start = offset
            else:
                intervals.append((open_start, line_end))
                open_start = None
        offset = line_end
    if open_start is not None:
        intervals.append((open_start, len(text)))
    return intervals


def _inline_code_intervals(text: str, ignored: list[tuple[int, int]]) -> list[tuple[int, int]]:
    intervals: list[tuple[int, int]] = []
    index = 0
    while index < len(text):
        skip_to = _containing_interval_end(index, ignored)
        if skip_to is not None:
            index = skip_to
            continue
        if text[index] != "`":
            index += 1
            continue
        tick_count = _run_length(text, index, "`")
        close = text.find("`" * tick_count, index + tick_count)
        if close == -1:
            index += tick_count
            continue
        intervals.append((index, close + tick_count))
        index = close + tick_count
    return intervals


def _inline_math_intervals(text: str, ignored: list[tuple[int, int]]) -> list[tuple[int, int]]:
    intervals: list[tuple[int, int]] = []
    index = 0
    while index < len(text):
        skip_to = _containing_interval_end(index, ignored)
        if skip_to is not None:
            index = skip_to
            continue
        if text[index] != "$" or _is_escaped(text, index):
            index += 1
            continue
        marker = "$$" if text.startswith("$$", index) else "$"
        close = _find_unescaped(text, marker, index + len(marker))
        if close == -1:
            index += len(marker)
            continue
        if marker == "$" and "\n" in text[index + 1:close]:
            index += 1
            continue
        intervals.append((index, close + len(marker)))
        index = close + len(marker)
    return intervals


def _latex_math_intervals(text: str, ignored: list[tuple[int, int]]) -> list[tuple[int, int]]:
    intervals: list[tuple[int, int]] = []
    index = 0
    while index < len(text):
        skip_to = _containing_interval_end(index, ignored)
        if skip_to is not None:
            index = skip_to
            continue
        if text.startswith(r"\(", index):
            close_marker = r"\)"
        elif text.startswith(r"\[", index):
            close_marker = r"\]"
        else:
            index += 1
            continue
        close = text.find(close_marker, index + 2)
        if close == -1:
            index += 2
            continue
        intervals.append((index, close + 2))
        index = close + 2
    return intervals


def _find_unescaped(text: str, marker: str, start: int) -> int:
    index = start
    while True:
        found = text.find(marker, index)
        if found == -1:
            return -1
        if not _is_escaped(text, found):
            return found
        index = found + len(marker)


def _is_escaped(text: str, index: int) -> bool:
    slash_count = 0
    cursor = index - 1
    while cursor >= 0 and text[cursor] == "\\":
        slash_count += 1
        cursor -= 1
    return slash_count % 2 == 1


def _run_length(text: str, start: int, char: str) -> int:
    index = start
    while index < len(text) and text[index] == char:
        index += 1
    return index - start


def _merge_intervals(intervals: Iterable[tuple[int, int]]) -> list[tuple[int, int]]:
    ordered = sorted((start, end) for start, end in intervals if end > start)
    if not ordered:
        return []
    merged = [ordered[0]]
    for start, end in ordered[1:]:
        last_start, last_end = merged[-1]
        if start <= last_end:
            merged[-1] = (last_start, max(last_end, end))
        else:
            merged.append((start, end))
    return merged


def _point_in_intervals(point: int, intervals: list[tuple[int, int]]) -> bool:
    return _containing_interval_end(point, intervals) is not None


def _containing_interval_end(point: int, intervals: list[tuple[int, int]]) -> int | None:
    for start, end in intervals:
        if point < start:
            return None
        if start <= point < end:
            return end
    return None


def _range_intersects(start: int, end: int, intervals: list[tuple[int, int]]) -> bool:
    for interval_start, interval_end in intervals:
        if interval_end <= start:
            continue
        if interval_start >= end:
            return False
        return True
    return False


def _strip_inline_markdown(value: str) -> str:
    stripped = re.sub(r"`([^`]*)`", r"\1", value)
    stripped = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", stripped)
    stripped = stripped.replace("*", "").replace("_", "").replace("~", "")
    return re.sub(r"\s+", " ", stripped).strip()
