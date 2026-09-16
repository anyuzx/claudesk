from __future__ import annotations

import json
import logging
import sqlite3
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Optional, Sequence

from claudesk.core.config import Config, load_config
from claudesk.core.db.papers import (
    update_paper_ranking,
    upsert_paper,
)
from claudesk.core.models import Paper

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DigestWriteResult:
    markdown: str
    total_new_papers: int
    created_at: str


def write_digest(
    ranked_papers: list[Paper],
    conn: sqlite3.Connection,
    *,
    days_back: int,
    sources: Sequence[str],
    total_fetched: int = 0,
    total_after_dedup: Optional[int] = None,
    cfg: Optional[Config] = None,
) -> DigestWriteResult:
    """Persist ranked papers to DB, format a markdown digest, and export to
    Obsidian if configured. Returns the markdown and write summary.

    `total_fetched` is the raw count before filtering/ranking — used only
    in the digest header for context ("47 papers fetched · 10 in digest").
    """
    if cfg is None:
        cfg = load_config()

    today = date.today()
    effective_after_dedup = (
        total_after_dedup if total_after_dedup is not None else len(ranked_papers)
    )
    source_names = [str(source) for source in sources]

    # --- 1. Write to DB ---
    created_at = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
    cur = conn.execute(
        """
        INSERT INTO digest_runs
            (
                created_at,
                days_back,
                sources_json,
                total_fetched,
                total_after_dedup,
                total_in_digest,
                total_new_papers
            )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            created_at,
            max(0, days_back),
            json.dumps(source_names),
            max(0, total_fetched),
            max(0, effective_after_dedup),
            max(0, len(ranked_papers)),
            0,
        ),
    )
    digest_run_id = int(cur.lastrowid)  # type: ignore[arg-type]
    existing_ids = {
        int(row["id"])
        for row in conn.execute("SELECT id FROM papers").fetchall()
    }
    new_paper_ids: set[int] = set()
    for paper in ranked_papers:
        paper_id = upsert_paper(conn, paper)
        if paper_id not in existing_ids:
            new_paper_ids.add(paper_id)
            existing_ids.add(paper_id)
            conn.execute(
                "UPDATE papers SET new_digest_run_id=? WHERE id=?",
                (digest_run_id, paper_id),
            )
        if paper.embedding is not None and paper.relevance_score is not None:
            ranking_kwargs = {}
            if paper.score_rubric is not None:
                ranking_kwargs["score_rubric"] = paper.score_rubric
            update_paper_ranking(
                conn,
                paper_id,
                paper.embedding,
                paper.relevance_score,
                **ranking_kwargs,
            )
    conn.execute(
        "UPDATE digest_runs SET total_new_papers=? WHERE id=?",
        (len(new_paper_ids), digest_run_id),
    )
    conn.commit()
    logger.info("digest: persisted %d papers to DB", len(ranked_papers))

    # --- 2. Format markdown ---
    md = _format_markdown(ranked_papers, today, total_fetched=total_fetched)

    # --- 3. Obsidian export (non-fatal if it fails) ---
    if cfg.obsidian.enabled and cfg.obsidian.vault_path:
        _write_obsidian(md, today, cfg)

    return DigestWriteResult(
        markdown=md,
        total_new_papers=len(new_paper_ids),
        created_at=created_at,
    )


# ---------------------------------------------------------------------------
# Markdown formatting
# ---------------------------------------------------------------------------

def _format_markdown(
    papers: list[Paper],
    today: date,
    *,
    total_fetched: int,
) -> str:
    sources = sorted({p.source for p in papers})
    display_fetched = total_fetched if total_fetched > 0 else len(papers)

    lines: list[str] = [
        "---",
        f"date: {today.isoformat()}",
        "tags: [research-digest, claudesk]",
        f"sources: [{', '.join(sources)}]",
        f"total_fetched: {display_fetched}",
        "---",
        "",
        f"# Research Digest — {today.strftime('%B %d, %Y')}",
        "",
        f"*{display_fetched} papers fetched · {len(papers)} in digest*",
        "",
        "---",
        "",
    ]

    for i, paper in enumerate(papers, 1):
        authors_str = _format_authors(paper.authors)
        score_str = f"{paper.relevance_score:.3f}" if paper.relevance_score is not None else "—"

        lines += [
            f"## {i}. [{paper.title}]({paper.url})",
            "",
            f"**Score:** {score_str} · **Source:** {paper.source} · **Date:** {paper.published_date}",
            f"**Authors:** {authors_str}",
            "",
            f"> {paper.abstract.strip()}" if paper.abstract.strip() else "",
            "",
            "---",
            "",
        ]

    return "\n".join(lines)


def _format_authors(authors: list[str]) -> str:
    if not authors:
        return "—"
    if len(authors) <= 4:
        return ", ".join(authors)
    return ", ".join(authors[:4]) + f" +{len(authors) - 4} more"


# ---------------------------------------------------------------------------
# Obsidian export
# ---------------------------------------------------------------------------

def _write_obsidian(md: str, today: date, cfg: Config) -> None:
    try:
        folder = Path(cfg.obsidian.vault_path) / cfg.obsidian.folder  # type: ignore[arg-type]
        folder.mkdir(parents=True, exist_ok=True)
        out = folder / f"{today.isoformat()}.md"
        out.write_text(md, encoding="utf-8")
        logger.info("digest: Obsidian note written to %s", out)
    except Exception as exc:
        logger.error("digest: failed to write Obsidian note — %s", exc)
