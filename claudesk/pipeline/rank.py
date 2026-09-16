from __future__ import annotations

import logging
from typing import Optional

import numpy as np

from claudesk.core.config import Config, load_config
from claudesk.core.models import Paper

logger = logging.getLogger(__name__)


def rank(papers: list[Paper], cfg: Optional[Config] = None) -> list[Paper]:
    """Hard-filter then rank by embedding similarity to configured topics.

    Returns up to cfg.digest.top_n papers, each with relevance_score and
    embedding set. Falls back to date-sorted order when no topics are
    configured so the digest job still works before interests.yaml is set up.
    """
    if not papers:
        return []

    if cfg is None:
        cfg = load_config()

    top_n = cfg.digest.top_n

    # --- Stage 1: hard filter ---
    filtered = _hard_filter(papers, cfg)
    logger.info(
        "rank: %d → %d papers after hard filter", len(papers), len(filtered)
    )

    if not filtered:
        return []

    # --- Stage 2: embedding similarity ---
    if not cfg.topics:
        logger.warning(
            "No topics in config — returning %d most-recent papers unranked", top_n
        )
        return sorted(filtered, key=lambda p: p.published_date, reverse=True)[:top_n]

    from claudesk.core.embeddings import embed

    topic_embeddings = embed(cfg.topics)                          # (n_topics, 384)
    paper_texts = [f"{p.title}. {p.abstract}" for p in filtered]
    paper_embeddings = embed(paper_texts)                         # (n_papers, 384)

    # Cosine similarity: unit-norm embeddings → dot product
    sims = paper_embeddings @ topic_embeddings.T                  # (n_papers, n_topics)
    scores: np.ndarray = sims.max(axis=1)                        # (n_papers,)

    # Take a larger shortlist for LLM rescoring, then trim to top_n
    shortlist_n = min(len(filtered), cfg.llm.score_shortlist_n if cfg.llm.api_key else top_n)
    top_indices = np.argsort(scores)[::-1][:shortlist_n]

    shortlist: list[Paper] = [
        filtered[idx].model_copy(
            update={
                "relevance_score": float(scores[idx]),
                "embedding": paper_embeddings[idx].tolist(),
            }
        )
        for idx in top_indices
    ]

    # --- Stage 3: LLM rescoring (opt-in, requires OPENAI_API_KEY) ---
    if cfg.llm.api_key and shortlist:
        try:
            from claudesk.core.llm import score_papers
            profile_str = cfg.profile.context_text()
            interests_context = _format_interests_context(cfg, profile_str)
            shortlist = score_papers(
                shortlist,
                cfg.llm,
                profile=profile_str,
                interests_context=interests_context,
            )
            shortlist = sorted(shortlist, key=lambda p: p.relevance_score or 0, reverse=True)
            logger.info(
                "rank: LLM rescoring done, top score %.3f", shortlist[0].relevance_score or 0
            )
        except Exception as exc:
            logger.warning("rank: LLM scoring failed (%s), keeping embedding order", exc)

    result = shortlist[:top_n]

    if result:
        logger.info(
            "rank: top-%d score range %.3f – %.3f",
            len(result),
            result[0].relevance_score,
            result[-1].relevance_score,
        )

    return result


def _format_interests_context(cfg: Config, profile: str) -> str:
    parts = [f"Profile: {profile or 'researcher'}"]
    if cfg.topics:
        parts.append("Topics: " + "; ".join(cfg.topics))
    if cfg.keywords.include:
        parts.append("Include keywords: " + "; ".join(cfg.keywords.include))
    if cfg.tracked_authors:
        parts.append("Tracked authors: " + "; ".join(cfg.tracked_authors))
    return "\n".join(parts)


def _hard_filter(papers: list[Paper], cfg: Config) -> list[Paper]:
    """Keep papers that pass keyword and/or author checks.

    A paper is kept when:
      - (matches ≥1 include keyword OR is by a tracked author)
      - AND matches zero exclude keywords

    If include list is empty, all papers pass the include check.
    Tracked-author papers still respect the exclude list.
    Author matching is case-insensitive substring: "Lipfert" matches
    "Jan Lipfert", "Lipfert J", etc.
    """
    include  = [k.lower() for k in cfg.keywords.include]
    exclude  = [k.lower() for k in cfg.keywords.exclude]
    authors  = [a.lower() for a in cfg.tracked_authors]

    if not include and not exclude and not authors:
        return papers

    result = []
    for paper in papers:
        text = f"{paper.title} {paper.abstract}".lower()

        # Exclude veto always applies.
        if exclude and any(term in text for term in exclude):
            continue

        # Include: keyword match OR tracked-author match.
        by_tracked = authors and any(
            tracked in author.lower()
            for tracked in authors
            for author in paper.authors
        )
        if include and not by_tracked and not any(term in text for term in include):
            continue

        result.append(paper)
    return result
