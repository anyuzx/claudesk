from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from difflib import SequenceMatcher
from typing import Callable, Iterable, Optional, Sequence

import numpy as np

from claudesk.core.models import PaperScoreRubric

try:
    from rapidfuzz import fuzz as _rapidfuzz_fuzz
except Exception:  # pragma: no cover - exercised only when optional dependency is absent.
    _rapidfuzz_fuzz = None

_UNSET = object()


def _parse_datetime_text(value: object) -> Optional[datetime]:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _encode_embedding(embedding: list[float]) -> bytes:
    return np.array(embedding, dtype=np.float32).tobytes()


def _decode_embedding(blob: bytes) -> list[float]:
    return np.frombuffer(blob, dtype=np.float32).tolist()


def _encode_score_rubric(rubric: Optional[PaperScoreRubric]) -> Optional[str]:
    if rubric is None:
        return None
    return json.dumps(rubric.model_dump(mode="python"), ensure_ascii=False)


def _decode_score_rubric(value: object) -> Optional[PaperScoreRubric]:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        payload = json.loads(value)
        return PaperScoreRubric.model_validate(payload)
    except Exception:
        return None


def _decode_json_list(value: object) -> list:
    if not isinstance(value, str) or not value.strip():
        return []
    try:
        payload = json.loads(value)
    except json.JSONDecodeError:
        return []
    return payload if isinstance(payload, list) else []


def _decode_json_dict(value: object) -> dict[str, object]:
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        payload = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def _decode_bbox(value: object) -> Optional[list[float]]:
    payload = _decode_json_list(value)
    if len(payload) != 4:
        return None
    try:
        return [float(item) for item in payload]
    except (TypeError, ValueError):
        return None


def _encode_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False)


def _normalize_linked_ids(values: Optional[list[int]]) -> list[int]:
    if not values:
        return []

    ordered: list[int] = []
    seen: set[int] = set()
    for value in values:
        try:
            normalized = int(value)
        except (TypeError, ValueError):
            continue
        if normalized <= 0 or normalized in seen:
            continue
        seen.add(normalized)
        ordered.append(normalized)
    return ordered


def _search_terms(query: str) -> list[str]:
    terms = re.findall(r"\w+", query.casefold(), flags=re.UNICODE)
    return terms


def _fts_query(query: str) -> Optional[str]:
    terms = _search_terms(query)
    if not terms:
        return None
    return " AND ".join(f'"{term}"' for term in terms)


_MAX_FTS_TERMS = 8
_PREFIX_MIN_CHARS = 3
_FUZZY_PREFIX_MIN_CHARS = 4
_FUZZY_TERM_MIN_CHARS = 4
_FUZZY_MATCH_THRESHOLD = 0.78
_MAX_FUZZY_TOKENS = 512
_RELAXED_MIN_FIELD_SCORE = 0.50


@dataclass(frozen=True)
class _FtsQueryVariant:
    match: str
    phase: int


@dataclass(frozen=True)
class _RankedFtsRow:
    row: sqlite3.Row
    phase: int
    score: float
    rank: int
    key: str


def _fts_query_variants(query: str) -> list[_FtsQueryVariant]:
    terms = _unique_terms(_search_terms(query))[:_MAX_FTS_TERMS]
    if not terms:
        return []

    variants: list[_FtsQueryVariant] = []
    exact = " AND ".join(_fts_term(term) for term in terms)
    variants.append(_FtsQueryVariant(match=exact, phase=0))

    final = terms[-1]
    if len(final) >= _PREFIX_MIN_CHARS:
        prefix_terms = [_fts_term(term) for term in terms[:-1]]
        prefix_terms.append(_fts_prefix(final))
        prefix = " AND ".join(prefix_terms)
        if prefix != exact:
            variants.append(_FtsQueryVariant(match=prefix, phase=1))

    relaxed_parts = [_fts_term(term) for term in terms]
    for term in terms:
        if len(term) > _FUZZY_PREFIX_MIN_CHARS:
            relaxed_parts.append(_fts_prefix(term[:_FUZZY_PREFIX_MIN_CHARS]))
    relaxed = " OR ".join(_unique_strings(relaxed_parts))
    if relaxed != exact:
        variants.append(_FtsQueryVariant(match=relaxed, phase=2))

    return variants


def _rank_fts_rows(
    query: str,
    *,
    limit: int,
    fetch_rows: Callable[[str, int], Sequence[sqlite3.Row]],
    fields: Callable[[sqlite3.Row], Sequence[tuple[str, float]]],
    relaxed_fields: Callable[[sqlite3.Row], Sequence[tuple[str, float]]] | None = None,
    key: Callable[[sqlite3.Row], object] | None = None,
) -> list[sqlite3.Row]:
    variants = _fts_query_variants(query)
    if not variants:
        return []

    result_limit = max(1, limit)
    pool_limit = _fts_candidate_limit(result_limit)
    terms = _unique_terms(_search_terms(query))[:_MAX_FTS_TERMS]
    key_fn = key or (lambda row: row["id"])
    best_by_key: dict[object, _RankedFtsRow] = {}

    for variant in variants:
        rows = fetch_rows(variant.match, pool_limit)
        for rank, row in enumerate(rows, start=1):
            row_key = key_fn(row)
            candidate_fields = fields(row)
            field_score = _lexical_candidate_field_score(terms, candidate_fields)
            if variant.phase >= 2:
                relaxed_candidate_fields = (
                    relaxed_fields(row) if relaxed_fields is not None else candidate_fields
                )
                if not _fields_match_required_short_terms(terms, relaxed_candidate_fields):
                    continue
                if (
                    _lexical_candidate_best_field_score(terms, relaxed_candidate_fields)
                    < _RELAXED_MIN_FIELD_SCORE
                ):
                    continue
            ranked = _RankedFtsRow(
                row=row,
                phase=variant.phase,
                score=_lexical_candidate_score(field_score, rank=rank),
                rank=rank,
                key=str(row_key),
            )
            current = best_by_key.get(row_key)
            if current is None or _ranked_fts_sort_key(ranked) < _ranked_fts_sort_key(current):
                best_by_key[row_key] = ranked

    ranked_rows = sorted(best_by_key.values(), key=_ranked_fts_sort_key)
    return [candidate.row for candidate in ranked_rows[:result_limit]]


def _lexical_term_match_score(term: str, text: str) -> float:
    normalized = term.casefold()
    if not normalized:
        return 0.0
    lowered = (text or "").casefold()
    tokens = _search_terms(lowered)
    if normalized in tokens:
        return 1.0

    if len(normalized) >= _PREFIX_MIN_CHARS and any(
        token.startswith(normalized) for token in tokens
    ):
        return 0.92
    if len(normalized) < _FUZZY_TERM_MIN_CHARS:
        return 0.0

    best = 0.0
    for token in tokens[:_MAX_FUZZY_TOKENS]:
        if abs(len(token) - len(normalized)) > max(2, len(normalized) // 2):
            continue
        best = max(best, _term_similarity(normalized, token))
        if best >= 0.98:
            break
    return best if best >= _FUZZY_MATCH_THRESHOLD else 0.0


def _fts_term(term: str) -> str:
    return f'"{term}"'


def _fts_prefix(term: str) -> str:
    return f'"{term}"*'


def _unique_terms(terms: Sequence[str]) -> list[str]:
    return _unique_strings(term for term in terms if term)


def _unique_strings(values: Iterable[str]) -> list[str]:
    ordered: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not isinstance(value, str) or value in seen:
            continue
        seen.add(value)
        ordered.append(value)
    return ordered


def _fts_candidate_limit(limit: int) -> int:
    bounded_pool = min(max(limit * 4, 50), 200)
    return max(limit, bounded_pool)


def _lexical_candidate_score(
    field_score: float,
    *,
    rank: int,
) -> float:
    bm25_rank_score = 1.0 / (60 + max(1, rank))
    return round((field_score * 0.82) + (bm25_rank_score * 0.18), 9)


def _lexical_candidate_field_score(
    terms: Sequence[str],
    fields: Sequence[tuple[str, float]],
) -> float:
    total_weight = sum(max(0.0, weight) for _text, weight in fields) or 1.0
    weighted_score = 0.0
    for text, weight in fields:
        if weight <= 0:
            continue
        weighted_score += weight * _field_query_score(terms, text)
    return min(1.0, weighted_score / total_weight)


def _lexical_candidate_best_field_score(
    terms: Sequence[str],
    fields: Sequence[tuple[str, float]],
) -> float:
    return max((_field_query_score(terms, text) for text, _weight in fields), default=0.0)


def _fields_match_required_short_terms(
    terms: Sequence[str],
    fields: Sequence[tuple[str, float]],
) -> bool:
    required_terms = [term for term in terms if len(term) < _FUZZY_TERM_MIN_CHARS]
    if not required_terms:
        return True
    field_tokens: set[str] = set()
    for text, _weight in fields:
        field_tokens.update(_search_terms(text or ""))
    return all(term in field_tokens for term in required_terms)


def _field_query_score(terms: Sequence[str], text: str) -> float:
    if not terms:
        return 0.0
    scores = [_lexical_term_match_score(term, text) for term in terms]
    return sum(scores) / len(terms)


def _term_similarity(left: str, right: str) -> float:
    if _rapidfuzz_fuzz is not None:
        return float(_rapidfuzz_fuzz.ratio(left, right)) / 100.0
    return SequenceMatcher(None, left, right).ratio()


def _ranked_fts_sort_key(candidate: _RankedFtsRow) -> tuple[int, float, int, str]:
    return (candidate.phase, -candidate.score, candidate.rank, candidate.key)
