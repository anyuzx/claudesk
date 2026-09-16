from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, AsyncGenerator

if TYPE_CHECKING:
    from claudesk.core.config import LlmConfig
    from claudesk.core.models import Paper

logger = logging.getLogger(__name__)

RUBRIC_FIELDS = (
    "topic_match",
    "method_match",
    "usefulness",
    "novelty",
    "confidence",
)


def score_papers(
    papers: list["Paper"],
    cfg: "LlmConfig",
    profile: str = "",
    interests_context: str = "",
) -> list["Paper"]:
    """LLM-score papers for relevance. Returns papers with updated relevance_score and rubric.

    Papers are sent in one JSON-mode batch to the configured OpenAI model. The
    model returns integer rubric scores; claudesk normalizes their average to a
    0.0–1.0 relevance score. Falls back to the original embedding-based scores
    on any error.
    """
    if not papers or not cfg.api_key:
        return papers

    from openai import OpenAI
    client = OpenAI(api_key=cfg.api_key)

    items = []
    for i, p in enumerate(papers, 1):
        abstract = p.abstract or ""
        items.append(f"{i}. {p.title}\n   {abstract}")

    system = _build_scoring_system_prompt(cfg)
    context = interests_context.strip() or profile.strip() or "researcher"

    try:
        resp = client.chat.completions.create(
            model=cfg.model,
            messages=[
                {"role": "system", "content": system},
                {
                    "role": "user",
                    "content": (
                        "User interest context:\n"
                        f"{context}\n\n"
                        "Rate these candidate papers:\n\n"
                        + "\n\n".join(items)
                    ),
                },
            ],
            response_format={"type": "json_object"},
            temperature=0,
            timeout=90,
        )
        data = json.loads(resp.choices[0].message.content)
        ratings = _parse_rubric_ratings(data)

        result = []
        for i, paper in enumerate(papers, 1):
            rubric = ratings.get(i)
            if rubric is not None:
                score = _normalised_rubric_score(rubric)
                paper = paper.model_copy(update={
                    "relevance_score": score,
                    "score_rubric": rubric,
                })
            result.append(paper)
        return result

    except Exception as exc:
        logger.warning("LLM scoring failed: %s", exc)
        return papers


def _build_scoring_system_prompt(cfg: "LlmConfig") -> str:
    rubric_prompt = (cfg.scoring_system_prompt or "").strip()
    return "\n\n".join(
        part for part in (
            rubric_prompt,
            "Return JSON only. Include one object per candidate paper index under a top-level "
            '"papers" array. Each object must include: index, topic_match, method_match, '
            "usefulness, novelty, confidence, evidence, and reason. Aspect scores must be "
            "integers from 0 to 3. Do not omit papers.",
            'Required shape: {"papers": [{"index": 1, "topic_match": 0, "method_match": 0, '
            '"usefulness": 0, "novelty": 0, "confidence": 0, '
            '"evidence": ["brief evidence 1"], "reason": "one short paragraph"}]}.',
        )
        if part
    )


def _parse_rubric_ratings(data: object) -> dict[int, "PaperScoreRubric"]:
    from claudesk.core.models import PaperScoreRubric

    if not isinstance(data, dict):
        return {}
    raw_items = data.get("papers")
    if not isinstance(raw_items, list):
        return {}
    ratings: dict[int, PaperScoreRubric] = {}
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        index = _coerce_index(item.get("index"))
        if index is None:
            continue
        scores = {field: _coerce_score(item.get(field)) for field in RUBRIC_FIELDS}
        if any(value is None for value in scores.values()):
            continue
        evidence_raw = item.get("evidence")
        evidence = [
            str(value).strip()
            for value in evidence_raw
            if str(value).strip()
        ] if isinstance(evidence_raw, list) else []
        ratings[index] = PaperScoreRubric(
            **{field: int(scores[field]) for field in RUBRIC_FIELDS},
            evidence=evidence[:5],
            reason=str(item.get("reason") or "").strip(),
        )
    return ratings


def _coerce_index(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value >= 1:
        return value
    if isinstance(value, str) and value.strip().isdigit():
        parsed = int(value.strip())
        return parsed if parsed >= 1 else None
    return None


def _coerce_score(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and 0 <= value <= 3:
        return value
    if isinstance(value, str) and value.strip().isdigit():
        parsed = int(value.strip())
        return parsed if 0 <= parsed <= 3 else None
    return None


def _normalised_rubric_score(rubric: "PaperScoreRubric") -> float:
    total = sum(getattr(rubric, field) for field in RUBRIC_FIELDS)
    return total / (len(RUBRIC_FIELDS) * 3)


async def chat_stream(
    messages: list[dict],
    tools: list[dict],
    cfg: "LlmConfig",
    *,
    model_override: str | None = None,
    temperature: float | None = None,
) -> AsyncGenerator[dict, None]:
    """Stream a chat response from OpenAI.

    Yields dicts:
      {"type": "text",      "content": "..."}
      {"type": "tool_call", "id": "...", "name": "...", "args": {...}}
      {"type": "done",      "finish_reason": "stop" | "tool_calls"}
    """
    if not cfg.api_key:
        yield {"type": "text", "content": "LLM not configured — set the OPENAI_API_KEY environment variable."}
        yield {"type": "done", "finish_reason": "stop"}
        return

    from openai import AsyncOpenAI
    client = AsyncOpenAI(api_key=cfg.api_key)

    kwargs: dict = {
        "model": (model_override or cfg.model),
        "messages": messages,
        "stream": True,
        "temperature": 0.7 if temperature is None else temperature,
    }
    if tools:
        kwargs["tools"] = tools
        kwargs["tool_choice"] = "auto"

    # Accumulate partial tool-call deltas by stream index
    _pending: dict[int, dict] = {}
    finish_reason = "stop"

    try:
        stream = await client.chat.completions.create(**kwargs)
        async for chunk in stream:
            choice = chunk.choices[0]
            delta = choice.delta

            if delta.content:
                yield {"type": "text", "content": delta.content}

            if delta.tool_calls:
                for tc in delta.tool_calls:
                    idx = tc.index
                    if idx not in _pending:
                        _pending[idx] = {"id": "", "name": "", "args": ""}
                    if tc.id:
                        _pending[idx]["id"] = tc.id
                    if tc.function:
                        if tc.function.name:
                            _pending[idx]["name"] += tc.function.name
                        if tc.function.arguments:
                            _pending[idx]["args"] += tc.function.arguments

            if choice.finish_reason:
                finish_reason = choice.finish_reason

        for tc in _pending.values():
            try:
                args = json.loads(tc["args"]) if tc["args"] else {}
            except json.JSONDecodeError:
                args = {}
            yield {"type": "tool_call", "id": tc["id"], "name": tc["name"], "args": args}

    except Exception as exc:
        logger.error("Chat stream error: %s", exc)
        yield {"type": "text", "content": f"\n\n[Error: {exc}]"}

    yield {"type": "done", "finish_reason": finish_reason}
