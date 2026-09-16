from __future__ import annotations

import sqlite3
from typing import Callable, Literal, Optional

import numpy as np

from claudesk.core.config import Config, load_config
from claudesk.core.db import (
    get_connection,
    init_db,
)
from claudesk.core.db.papers import (
    list_papers,
    update_paper_ranking,
)
from claudesk.core.llm import score_papers
from claudesk.core.models import Paper, PaperStatus

RubricScope = Literal["all", "saved"]
RubricProgressCallback = Callable[[dict[str, object]], None]


def _emit_progress(
    progress_cb: Optional[RubricProgressCallback],
    **progress: object,
) -> None:
    if progress_cb is not None:
        progress_cb(progress)


def _profile_text(cfg: Config) -> str:
    return cfg.profile.context_text()


def _interests_context(cfg: Config, profile: str) -> str:
    parts = [f"Profile: {profile or 'researcher'}"]
    if cfg.topics:
        parts.append("Topics: " + "; ".join(cfg.topics))
    if cfg.keywords.include:
        parts.append("Include keywords: " + "; ".join(cfg.keywords.include))
    if cfg.tracked_authors:
        parts.append("Tracked authors: " + "; ".join(cfg.tracked_authors))
    return "\n".join(parts)


def _list_target_papers(
    conn: sqlite3.Connection,
    scope: RubricScope,
    refresh_existing: bool,
) -> list[Paper]:
    if scope == "saved":
        papers = list_papers(conn, status=PaperStatus.SAVED, sort="date")
    else:
        papers = list_papers(conn, sort="date")

    if refresh_existing:
        return papers
    return [paper for paper in papers if paper.score_rubric is None]


def _with_embedding_fallback_scores(papers: list[Paper], cfg: Config) -> list[Paper]:
    if not papers or not cfg.topics:
        return papers

    from claudesk.core.embeddings import embed

    topic_embeddings = embed(cfg.topics)
    paper_texts = [f"{paper.title}. {paper.abstract}" for paper in papers]
    paper_embeddings = embed(paper_texts)
    sims = paper_embeddings @ topic_embeddings.T
    scores: np.ndarray = sims.max(axis=1)

    return [
        paper.model_copy(
            update={
                "embedding": paper_embeddings[index].tolist(),
                "relevance_score": float(scores[index]),
                "score_rubric": None,
            }
        )
        for index, paper in enumerate(papers)
    ]


def run_rubric_scoring_once(
    *,
    scope: RubricScope,
    refresh_existing: bool = False,
    conn: Optional[sqlite3.Connection] = None,
    progress_cb: Optional[RubricProgressCallback] = None,
) -> dict[str, object]:
    cfg = load_config()
    if not cfg.llm.api_key:
        raise ValueError(
            "LLM not configured — set the OPENAI_API_KEY environment variable."
        )

    db_conn = conn
    should_close = False
    if db_conn is None:
        db_conn = get_connection()
        init_db(db_conn)
        should_close = True

    try:
        papers = _list_target_papers(db_conn, scope, refresh_existing)
        total_papers = len(papers)
        batch_size = max(1, min(cfg.llm.score_shortlist_n, 20))
        processed_papers = 0
        changed_papers = 0
        profile = _profile_text(cfg)
        interests_context = _interests_context(cfg, profile)

        _emit_progress(
            progress_cb,
            scope=scope,
            refresh_existing=refresh_existing,
            message=(
                (
                    f"Preparing rubric scoring for {total_papers} paper(s)…"
                    if refresh_existing
                    else f"Preparing rubric scoring for {total_papers} paper(s) missing rubric data…"
                )
                if total_papers
                else (
                    "No papers matched the selected scope."
                    if refresh_existing
                    else "No papers without rubric data matched the selected scope."
                )
            ),
            total_papers=total_papers,
            processed_papers=0,
            changed_papers=0,
            current_title=None,
            batch_size=batch_size,
        )

        if not papers:
            return {
                "scope": scope,
                "refresh_existing": refresh_existing,
                "total_papers": 0,
                "processed_papers": 0,
                "changed_papers": 0,
            }

        for batch_start in range(0, total_papers, batch_size):
            batch = papers[batch_start : batch_start + batch_size]
            first_index = batch_start + 1
            last_index = batch_start + len(batch)

            _emit_progress(
                progress_cb,
                scope=scope,
                refresh_existing=refresh_existing,
                message=(
                    f"Requesting rubric scores for papers {first_index}-{last_index} "
                    f"of {total_papers}…"
                ),
                total_papers=total_papers,
                processed_papers=processed_papers,
                changed_papers=changed_papers,
                current_title=batch[0].title if batch else None,
                batch_size=batch_size,
            )

            fallback_batch = _with_embedding_fallback_scores(batch, cfg)
            scored_batch = score_papers(
                fallback_batch,
                cfg.llm,
                profile=profile,
                interests_context=interests_context,
            )

            for original, updated in zip(batch, scored_batch):
                paper_id = original.id
                if paper_id is None or updated.embedding is None or updated.relevance_score is None:
                    continue
                update_paper_ranking(
                    db_conn,
                    paper_id,
                    updated.embedding,
                    updated.relevance_score,
                    score_rubric=updated.score_rubric,
                )
                if (
                    updated.relevance_score != original.relevance_score
                    or updated.score_rubric != original.score_rubric
                ):
                    changed_papers += 1

            processed_papers += len(batch)
            db_conn.commit()

            _emit_progress(
                progress_cb,
                scope=scope,
                refresh_existing=refresh_existing,
                message=(
                    f"Processed {processed_papers} of {total_papers} papers."
                ),
                total_papers=total_papers,
                processed_papers=processed_papers,
                changed_papers=changed_papers,
                current_title=None,
                batch_size=batch_size,
            )

        return {
            "scope": scope,
            "refresh_existing": refresh_existing,
            "total_papers": total_papers,
            "processed_papers": processed_papers,
            "changed_papers": changed_papers,
        }
    finally:
        if should_close:
            db_conn.close()
