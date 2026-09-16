"""Daily digest job — fetch, dedupe, rank, write.

Run as:
    python -m claudesk.jobs.run_digest
    python -m claudesk.jobs.run_digest --source arxiv --days 1 --dry-run
"""
from __future__ import annotations

import logging
import sys
import sqlite3
from datetime import datetime, timedelta
from typing import Callable, Optional

import typer
from rich.console import Console
from rich.table import Table

from claudesk.core.config import Config, config_path, load_config
from claudesk.core.db import (
    get_connection,
    init_db,
)
from claudesk.pipeline.dedupe import dedupe
from claudesk.pipeline.digest import write_digest
from claudesk.pipeline.fetch import FetchProgressCallback, fetch_all
from claudesk.pipeline.rank import rank
from claudesk.sources import get_enabled_sources
from claudesk.sources import arxiv, biorxiv, openalex, pubmed
from claudesk.sources.base import Source

console = Console(stderr=True)   # progress/status to stderr, markdown to stdout
app = typer.Typer(add_completion=False)

_SOURCE_MAP: dict[str, Source] = {
    "arxiv":   Source(name="arxiv",   fetch=arxiv.fetch),
    "biorxiv": Source(name="biorxiv", fetch=biorxiv.fetch),
    "pubmed":  Source(name="pubmed",  fetch=pubmed.fetch),
    "openalex": Source(name="openalex", fetch=openalex.fetch),
}


def _setup_logging() -> None:
    logging.basicConfig(
        level=logging.WARNING,
        format="%(asctime)s  %(levelname)-8s  %(name)s: %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stderr,
    )
    logging.getLogger("claudesk").setLevel(logging.INFO)
    # Silence noisy third-party libraries.
    for name in ("httpx", "httpcore", "huggingface_hub", "sentence_transformers"):
        logging.getLogger(name).setLevel(logging.ERROR)
    try:
        import transformers
        transformers.logging.set_verbosity_error()
        transformers.logging.disable_progress_bar()
    except Exception:
        pass


def _resolve_sources(cfg: Config, source: Optional[str] = None) -> list[Source]:
    if source is not None:
        if source not in _SOURCE_MAP:
            raise ValueError(
                f"Unknown source '{source}'. Choose from: {list(_SOURCE_MAP)}"
            )
        return [_SOURCE_MAP[source]]
    return get_enabled_sources()


def _emit_progress(
    progress_cb: Optional[Callable[[dict[str, object]], None]],
    **progress: object,
) -> None:
    if progress_cb is not None:
        progress_cb(progress)


def _initial_source_statuses(
    sources: list[Source],
    *,
    target_per_source: int,
) -> list[dict[str, object]]:
    return [
        {
            "name": s.name,
            "status": "pending",
            "fetched": 0,
            "target": target_per_source,
            "error": None,
        }
        for s in sources
    ]


def _progress_totals(
    source_statuses: list[dict[str, object]],
) -> tuple[int, int, int]:
    total_fetched = sum(int(s.get("fetched") or 0) for s in source_statuses)
    total_target = sum(int(s.get("target") or 0) for s in source_statuses)
    sources_completed = sum(
        1
        for s in source_statuses
        if s.get("status") in {"done", "error"}
    )
    return total_fetched, total_target, sources_completed


def _apply_source_progress(
    source_statuses: list[dict[str, object]],
    event: dict[str, object],
) -> Optional[str]:
    event_type = str(event.get("event"))
    source_name = str(event.get("source"))
    match = next((s for s in source_statuses if s["name"] == source_name), None)
    if match is None:
        return None
    if event_type == "source_start":
        match["status"] = "fetching"
        match["fetched"] = int(match.get("fetched") or 0)
        match["error"] = None
    elif event_type == "source_progress":
        match["status"] = "fetching"
        match["fetched"] = max(0, int(event.get("count", 0)))
        if event.get("target") is not None:
            match["target"] = max(0, int(event.get("target", 0)))
        match["error"] = None
    elif event_type == "source_done":
        match["status"] = "done"
        match["fetched"] = int(event.get("count", 0))
        if event.get("target") is not None:
            match["target"] = max(0, int(event.get("target", 0)))
        match["error"] = None
    elif event_type == "source_error":
        match["status"] = "error"
        match["fetched"] = int(match.get("fetched") or 0)
        match["error"] = str(event.get("error", "fetch failed"))
    return source_name


def _has_successful_source(source_statuses: list[dict[str, object]]) -> bool:
    return any(s["status"] == "done" for s in source_statuses)


def _all_sources_failed_message(source_statuses: list[dict[str, object]]) -> str:
    details: list[str] = []
    for status in source_statuses:
        name = str(status.get("name", "source"))
        error = status.get("error")
        if error:
            details.append(f"{name}: {error}")
        else:
            details.append(f"{name}: {status.get('status', 'not completed')}")
    if not details:
        return "Digest fetch failed for all sources."
    return "Digest fetch failed for all sources. " + "; ".join(details)


def run_digest_once(
    *,
    source: Optional[str] = None,
    days: Optional[int] = None,
    conn: Optional[sqlite3.Connection] = None,
    progress_cb: Optional[Callable[[dict[str, object]], None]] = None,
) -> dict[str, object]:
    cfg = load_config()
    sources = _resolve_sources(cfg, source)
    if not sources:
        raise ValueError(
            "No sources enabled. Copy examples/interests.example.yaml to "
            f"{config_path()} and set sources.*.enabled = true."
        )

    days_back = days if days is not None else cfg.digest.days_back
    since = datetime.now() - timedelta(days=days_back)
    source_statuses = _initial_source_statuses(
        sources,
        target_per_source=cfg.digest.max_per_source,
    )

    def on_fetch_progress(event: dict[str, object]) -> None:
        source_name = _apply_source_progress(source_statuses, event)
        if source_name is None:
            return
        total_fetched, total_fetch_target, sources_completed = _progress_totals(source_statuses)
        _emit_progress(
            progress_cb,
            phase="fetching",
            message=f"Fetching {source_name}…",
            current_source=source_name,
            sources=source_statuses,
            source_count=len(sources),
            sources_completed=sources_completed,
            total_fetched=total_fetched,
            total_fetch_target=total_fetch_target,
            total_after_dedup=None,
            total_in_digest=None,
        )

    _, total_fetch_target, _ = _progress_totals(source_statuses)
    _emit_progress(
        progress_cb,
        phase="starting",
        message=f"Preparing digest run for {len(sources)} source(s)…",
        current_source=None,
        sources=source_statuses,
        source_count=len(sources),
        sources_completed=0,
        total_fetched=0,
        total_fetch_target=total_fetch_target,
        total_after_dedup=None,
        total_in_digest=None,
    )

    all_papers = fetch_all(since, sources=sources, progress_cb=on_fetch_progress)
    total_fetched = len(all_papers)
    if not _has_successful_source(source_statuses):
        raise RuntimeError(_all_sources_failed_message(source_statuses))

    _emit_progress(
        progress_cb,
        phase="deduplicating",
        message=f"{total_fetched} papers fetched. Deduplicating…",
        current_source=None,
        sources=source_statuses,
        source_count=len(sources),
        sources_completed=len(sources),
        total_fetched=total_fetched,
        total_fetch_target=total_fetch_target,
        total_after_dedup=None,
        total_in_digest=None,
    )

    deduped = dedupe(all_papers)
    total_after_dedup = len(deduped)

    _emit_progress(
        progress_cb,
        phase="ranking",
        message=f"{total_after_dedup} papers after dedup. Ranking…",
        current_source=None,
        sources=source_statuses,
        source_count=len(sources),
        sources_completed=len(sources),
        total_fetched=total_fetched,
        total_fetch_target=total_fetch_target,
        total_after_dedup=total_after_dedup,
        total_in_digest=None,
    )

    ranked = rank(deduped, cfg=cfg)
    total_in_digest = len(ranked)

    _emit_progress(
        progress_cb,
        phase="writing",
        message=(
            f"{total_in_digest} papers in digest. Writing to DB…"
            if ranked
            else "No papers survived ranking. Recording digest run…"
        ),
        current_source=None,
        sources=source_statuses,
        source_count=len(sources),
        sources_completed=len(sources),
        total_fetched=total_fetched,
        total_fetch_target=total_fetch_target,
        total_after_dedup=total_after_dedup,
        total_in_digest=total_in_digest,
    )

    wrote_to_db = False
    db_conn = conn
    should_close = False
    if db_conn is None:
        db_conn = get_connection()
        init_db(db_conn)
        should_close = True
    try:
        write_result = write_digest(
            ranked,
            db_conn,
            days_back=days_back,
            sources=[s.name for s in sources],
            total_fetched=total_fetched,
            total_after_dedup=total_after_dedup,
            cfg=cfg,
        )
        wrote_to_db = True
    finally:
        if should_close:
            db_conn.close()

    _emit_progress(
        progress_cb,
        phase="done",
        message=(
            f"Digest updated with {total_in_digest} papers."
            if wrote_to_db
            else f"Digest run completed with {total_in_digest} papers."
        ),
        current_source=None,
        sources=source_statuses,
        source_count=len(sources),
        sources_completed=len(sources),
        total_fetched=total_fetched,
        total_fetch_target=total_fetch_target,
        total_after_dedup=total_after_dedup,
        total_in_digest=total_in_digest,
    )

    return {
        "created_at": write_result.created_at,
        "sources": [s.name for s in sources],
        "days_back": days_back,
        "total_fetched": total_fetched,
        "total_after_dedup": total_after_dedup,
        "total_in_digest": total_in_digest,
        "total_new_papers": write_result.total_new_papers,
        "wrote_to_db": wrote_to_db,
    }


@app.command()
def main(
    source: Optional[str] = typer.Option(
        None, "--source",
        help="Fetch only from this source: arxiv | biorxiv | pubmed | openalex",
    ),
    days: Optional[int] = typer.Option(
        None, "--days",
        help="Override days_back from interests.yaml",
    ),
    dry_run: bool = typer.Option(
        False, "--dry-run",
        help="Fetch and rank but skip DB writes and Obsidian export; "
             "print the digest markdown to stdout instead.",
    ),
) -> None:
    _setup_logging()
    cfg = load_config()

    # --- Resolve sources ---
    try:
        sources = _resolve_sources(cfg, source)
    except ValueError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)

    if not sources:
        console.print(
            "[red]No sources enabled. "
            f"Copy examples/interests.example.yaml to {config_path()} "
            "and set sources.*.enabled = true.[/red]"
        )
        raise typer.Exit(1)

    # --- Resolve date window ---
    days_back = days if days is not None else cfg.digest.days_back
    since = datetime.now() - timedelta(days=days_back)

    console.rule("[bold]claudesk digest[/bold]")
    console.print(
        f"  Window : last {days_back} day(s) (since {since.date()})"
    )
    console.print(
        f"  Sources: {', '.join(s.name for s in sources)}"
    )
    if dry_run:
        console.print("  Mode   : [yellow]dry-run — nothing will be written[/yellow]")
    console.print()

    # --- Fetch ---
    console.print("[bold]1/4  Fetching …[/bold]")
    source_statuses = _initial_source_statuses(
        sources,
        target_per_source=cfg.digest.max_per_source,
    )

    def on_fetch_progress(event: dict[str, object]) -> None:
        _apply_source_progress(source_statuses, event)

    all_papers = fetch_all(since, sources=sources, progress_cb=on_fetch_progress)
    if not _has_successful_source(source_statuses):
        console.print(f"[red]{_all_sources_failed_message(source_statuses)}[/red]")
        raise typer.Exit(1)
    total_fetched = len(all_papers)
    console.print(f"     {total_fetched} papers fetched")

    # --- Dedupe ---
    console.print("[bold]2/4  Deduplicating …[/bold]")
    all_papers = dedupe(all_papers)
    console.print(f"     {len(all_papers)} papers after dedup")

    # --- Rank ---
    console.print("[bold]3/4  Ranking …[/bold]")
    ranked = rank(all_papers, cfg=cfg)
    console.print(f"     {len(ranked)} papers in digest (top_n={cfg.digest.top_n})")

    if not ranked:
        console.print(
            "\n[yellow]No papers survived ranking. "
            "Check that interests.yaml has topics and/or keywords.[/yellow]"
        )
        if dry_run:
            raise typer.Exit(0)

    # --- Write / dry-run ---
    console.print("[bold]4/4  Writing …[/bold]")

    if dry_run:
        from claudesk.pipeline.digest import _format_markdown
        import datetime as _dt
        md = _format_markdown(ranked, _dt.date.today(), total_fetched=total_fetched)
        console.print("     [yellow]dry-run: skipping DB and Obsidian writes[/yellow]")
        sys.stdout.write(md + "\n")
    else:
        conn = get_connection()
        init_db(conn)
        write_digest(
            ranked,
            conn,
            days_back=days_back,
            sources=[s.name for s in sources],
            total_fetched=total_fetched,
            total_after_dedup=len(all_papers),
            cfg=cfg,
        )
        conn.close()
        console.print("     DB updated")
        if cfg.obsidian.enabled and cfg.obsidian.vault_path:
            from datetime import date as _date
            console.print(
                f"     Obsidian note → "
                f"{cfg.obsidian.vault_path}/{cfg.obsidian.folder}/"
                f"{_date.today().isoformat()}.md"
            )

    # --- Summary table ---
    _print_summary(ranked)


def _print_summary(papers) -> None:
    console.print()
    table = Table(title="Digest summary", show_lines=True, expand=False)
    table.add_column("#",      style="dim", width=3, no_wrap=True)
    table.add_column("Score",  width=6,  no_wrap=True)
    table.add_column("Src",    width=8,  no_wrap=True)
    table.add_column("Date",   width=11, no_wrap=True)
    table.add_column("Title",  min_width=30)

    for i, p in enumerate(papers, 1):
        score = f"{p.relevance_score:.3f}" if p.relevance_score is not None else "—"
        table.add_row(str(i), score, p.source, str(p.published_date), p.title[:80])

    console.print(table)


if __name__ == "__main__":
    app()
