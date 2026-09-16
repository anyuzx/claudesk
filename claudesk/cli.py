"""claudesk CLI — quick terminal access to papers, todos, and logs.

Usage:
    claudesk papers list [--days N] [--status STATUS]
    claudesk papers status <id> <new|read|saved|unsaved|to_read|remove_to_read|dismissed|undismissed>
    claudesk todo add "title" [--description TEXT] [--priority high|medium|low] [--project ID] [--due YYYY-MM-DD]
    claudesk todo list [--project ID] [--done]
    claudesk todo done <id>
    claudesk log add "text" [--project ID]
    claudesk log list [--days N] [--project ID]
    claudesk vault set PATH
    claudesk vault show
"""
from __future__ import annotations

from datetime import date, timedelta
import json
import os
from pathlib import Path
from typing import Optional

import typer
from rich.console import Console
from rich.table import Table

from claudesk.core.config import (
    config_path,
    load_config,
    local_config_path,
    paper_assets_root,
    set_local_vault_path,
    vault_location,
)
from claudesk.core.db.tasks import (
    complete_todo,
    format_log_entry_display_text,
    list_log_entries,
    list_todos,
)
from claudesk.core.db.assets import clear_asset_pdf_cache
from claudesk.core.db import (
    db_path,
    get_connection,
    init_db,
)
from claudesk.core.db.papers import (
    find_title_duplicate_groups,
    list_papers,
    merge_title_duplicate_groups,
)
from claudesk.core.models import (
    Paper,
    PaperSignal,
    PaperStatus,
    TodoPriority,
    TodoStatus,
)
from claudesk.core.paper_assets import (
    AssetFileHealthRecord,
    AssetFileStatus,
    list_asset_file_health,
)
from claudesk.core.paper_status import apply_paper_signal
from claudesk.core.task_log_workflows import create_manual_log_from_text, create_task

app = typer.Typer(
    name="claudesk",
    help="Personal research assistant — papers, todos, and logs.",
    add_completion=False,
    no_args_is_help=True,
)
papers_app  = typer.Typer(help="Manage paper digest.",    no_args_is_help=True)
todo_app    = typer.Typer(help="Manage todos.",            no_args_is_help=True)
log_app = typer.Typer(help="Manage research log entries.", no_args_is_help=True)
vault_app = typer.Typer(help="Manage the machine-local Claudesk vault pointer.", no_args_is_help=True)
vault_assets_app = typer.Typer(help="Audit and migrate managed vault assets.", no_args_is_help=True)

app.add_typer(papers_app,   name="papers")
app.add_typer(todo_app,     name="todo")
app.add_typer(log_app, name="log")
app.add_typer(vault_app, name="vault")
vault_app.add_typer(vault_assets_app, name="assets")

console = Console()

_STATUS_LABEL = {
    PaperStatus.NEW:       "[blue]new[/blue]",
    PaperStatus.READ:      "[green]read[/green]",
    PaperStatus.SAVED:     "[yellow]saved[/yellow]",
    PaperStatus.DISMISSED: "[dim]dismissed[/dim]",
}

_PRIORITY_COLOR = {
    "high":   "red",
    "medium": "yellow",
    "low":    "white",
}


def _get_conn():
    conn = get_connection()
    init_db(conn)
    return conn


# ---------------------------------------------------------------------------
# vault
# ---------------------------------------------------------------------------

@vault_app.command("set")
def vault_set(
    path: str = typer.Argument(..., help="Absolute or user-relative path to the synced Claudesk vault."),
) -> None:
    """Set the machine-local pointer to the synced Claudesk vault."""
    target = set_local_vault_path(path)
    load_config.cache_clear()
    console.print(f"Vault path saved: [cyan]{target}[/cyan]")
    console.print(f"Local config: [dim]{local_config_path()}[/dim]")
    if os.environ.get("CLAUDESK_DATA_DIR"):
        console.print("[yellow]CLAUDESK_DATA_DIR is set and currently overrides this local config.[/yellow]")
    console.print("[dim]Restart any running Claudesk server to use this vault.[/dim]")


@vault_app.command("show")
def vault_show() -> None:
    """Show the effective Claudesk vault and derived storage paths."""
    location = vault_location()
    cfg = load_config()
    table = Table(show_lines=False, expand=True)
    table.add_column("Item", width=18, no_wrap=True, style="dim")
    table.add_column("Value")
    table.add_row("Vault path", str(location.path))
    table.add_row("Source", location.source)
    table.add_row("Local config", str(location.local_config_path))
    table.add_row("Settings file", str(config_path()))
    table.add_row("Database", str(db_path()))
    table.add_row("Asset root", str(paper_assets_root(cfg)))
    console.print(table)


def _problem_asset_records(records: list[AssetFileHealthRecord]) -> list[AssetFileHealthRecord]:
    return [
        record
        for record in records
        if record.health.status in {AssetFileStatus.MISSING, AssetFileStatus.INVALID_PATH}
    ]


def _asset_record_payload(record: AssetFileHealthRecord) -> dict[str, object]:
    return {
        "asset_id": record.asset_id,
        "kind": record.kind,
        "display_name": record.display_name,
        "original_filename": record.original_filename,
        "managed_path": record.managed_path,
        "paper_ids": list(record.paper_ids),
        "file_status": record.health.status.value,
        "file_exists": record.health.file_exists,
        "resolved_path": str(record.health.resolved_path) if record.health.resolved_path else None,
        "error": record.health.error,
    }


def _asset_audit_payload(
    records: list[AssetFileHealthRecord],
    cfg,
    *,
    problem_records: list[AssetFileHealthRecord],
) -> dict[str, object]:
    affected_paper_ids = sorted({
        paper_id
        for record in problem_records
        for paper_id in record.paper_ids
    })
    counts = {status.value: 0 for status in AssetFileStatus}
    for record in records:
        counts[record.health.status.value] += 1
    counts["total"] = len(records)
    return {
        "vault_path": str(vault_location().path),
        "settings_file": str(config_path()),
        "database": str(db_path()),
        "asset_root": str(paper_assets_root(cfg, create=False)),
        "counts": counts,
        "problem_asset_ids": [record.asset_id for record in problem_records],
        "affected_paper_ids": affected_paper_ids,
        "assets": [_asset_record_payload(record) for record in records],
    }


def _print_asset_audit(payload: dict[str, object]) -> None:
    path_table = Table(title="Vault asset audit", show_lines=False, expand=True)
    path_table.add_column("Item", width=18, no_wrap=True, style="dim")
    path_table.add_column("Value")
    path_table.add_row("Vault path", str(payload["vault_path"]))
    path_table.add_row("Settings file", str(payload["settings_file"]))
    path_table.add_row("Database", str(payload["database"]))
    path_table.add_row("Asset root", str(payload["asset_root"]))
    console.print(path_table)

    counts = payload["counts"]
    assert isinstance(counts, dict)
    count_table = Table(show_lines=False)
    count_table.add_column("Status", style="dim")
    count_table.add_column("Count", justify="right")
    for key in ("total", "present", "missing", "invalid_path", "not_managed"):
        count_table.add_row(key, str(counts.get(key, 0)))
    console.print(count_table)

    assets = payload["assets"]
    assert isinstance(assets, list)
    problem_assets = [
        asset for asset in assets
        if isinstance(asset, dict) and asset.get("file_status") in {"missing", "invalid_path"}
    ]
    if not problem_assets:
        console.print("[green]No missing or invalid managed asset files found.[/green]")
        return

    table = Table(title="Missing or invalid assets", show_lines=True)
    table.add_column("Asset", justify="right")
    table.add_column("Status")
    table.add_column("Papers")
    table.add_column("Path")
    for asset in problem_assets:
        table.add_row(
            str(asset["asset_id"]),
            str(asset["file_status"]),
            ", ".join(str(paper_id) for paper_id in asset["paper_ids"]),
            str(asset["managed_path"]),
        )
    console.print(table)


def _delete_asset_metadata(conn, asset_id: int) -> None:
    clear_asset_pdf_cache(conn, asset_id)
    conn.execute("DELETE FROM paper_assets WHERE asset_id=?", (asset_id,))
    conn.execute("DELETE FROM assets WHERE id=?", (asset_id,))


@vault_assets_app.command("audit")
def vault_assets_audit(
    json_output: bool = typer.Option(False, "--json", help="Print machine-readable JSON."),
    check: bool = typer.Option(False, "--check", help="Exit nonzero when missing or invalid assets are found."),
) -> None:
    """Inspect managed paper asset file health for the active vault."""
    cfg = load_config()
    conn = _get_conn()
    try:
        records = list_asset_file_health(conn, cfg=cfg)
    finally:
        conn.close()

    problem_records = _problem_asset_records(records)
    payload = _asset_audit_payload(records, cfg, problem_records=problem_records)
    if json_output:
        typer.echo(json.dumps(payload, indent=2, sort_keys=True))
    else:
        _print_asset_audit(payload)

    if check and payload["problem_asset_ids"]:
        raise typer.Exit(1)


@vault_assets_app.command("prune-missing")
def vault_assets_prune_missing(
    apply: bool = typer.Option(False, "--apply", help="Actually remove stale asset metadata."),
    json_output: bool = typer.Option(False, "--json", help="Print machine-readable JSON."),
) -> None:
    """Remove metadata for missing or invalid managed asset files."""
    cfg = load_config()
    conn = _get_conn()
    try:
        records = list_asset_file_health(conn, cfg=cfg)
        problem_records = _problem_asset_records(records)
        payload = _asset_audit_payload(records, cfg, problem_records=problem_records)
        pruned_asset_ids = [int(asset_id) for asset_id in payload["problem_asset_ids"]]
        affected_paper_ids = [int(paper_id) for paper_id in payload["affected_paper_ids"]]
        if apply:
            for record in problem_records:
                _delete_asset_metadata(conn, record.asset_id)
            conn.commit()
    finally:
        conn.close()

    result = {
        **payload,
        "applied": apply,
        "pruned_asset_ids": pruned_asset_ids,
        "affected_paper_ids": affected_paper_ids,
    }
    if json_output:
        typer.echo(json.dumps(result, indent=2, sort_keys=True))
        return

    _print_asset_audit(payload)
    if not pruned_asset_ids:
        console.print("[green]No stale asset metadata to prune.[/green]")
    elif apply:
        console.print(f"[green]Pruned {len(pruned_asset_ids)} stale asset record(s).[/green]")
    else:
        console.print(
            f"[yellow]Would prune {len(pruned_asset_ids)} stale asset record(s). "
            "Run again with --apply to modify the database.[/yellow]"
        )


# ---------------------------------------------------------------------------
# papers
# ---------------------------------------------------------------------------

@papers_app.command("list")
def papers_list(
    days: int = typer.Option(7, "--days", "-d", help="Look-back window in days."),
    status: Optional[str] = typer.Option(
        None, "--status", "-s",
        help="Filter by status: new | read | saved | dismissed",
    ),
    limit: int = typer.Option(20, "--limit", "-n", help="Max papers to show."),
) -> None:
    """List papers from the digest."""
    conn = _get_conn()
    since = date.today() - timedelta(days=days)
    ps = PaperStatus(status) if status else None
    papers = list_papers(conn, since=since, status=ps, limit=limit)
    conn.close()

    if not papers:
        console.print("[dim]No papers found.[/dim]")
        raise typer.Exit(0)

    table = Table(show_lines=False, expand=True)
    table.add_column("ID",     width=4,  no_wrap=True, style="dim")
    table.add_column("Score",  width=6,  no_wrap=True)
    table.add_column("Status", width=10, no_wrap=True)
    table.add_column("Date",   width=11, no_wrap=True)
    table.add_column("Title")

    for p in papers:
        score = f"{p.relevance_score:.3f}" if p.relevance_score is not None else "—"
        table.add_row(
            str(p.id),
            score,
            _STATUS_LABEL.get(p.status, p.status.value),
            str(p.published_date),
            p.title[:80],
        )

    console.print(table)
    console.print(f"[dim]{len(papers)} paper(s) · last {days} day(s)[/dim]")


@papers_app.command("status")
def papers_status(
    paper_id: int  = typer.Argument(..., help="Paper ID (see papers list)."),
    new_status: str = typer.Argument(..., help="new | read | saved | unsaved | to_read | remove_to_read | dismissed | undismissed"),
) -> None:
    """Update a paper's paper-state signal."""
    try:
        signal = PaperSignal(new_status)
    except ValueError:
        console.print(f"[red]Unknown status '{new_status}'. Choose: new, read, saved, unsaved, to_read, remove_to_read, dismissed, undismissed[/red]")
        raise typer.Exit(1)

    conn = _get_conn()
    status_update = apply_paper_signal(conn, paper_id, signal, record_feedback=False)
    conn.commit()
    conn.close()
    console.print(f"Paper {paper_id} → {_STATUS_LABEL[status_update.effective_status]}")


@papers_app.command("dedupe")
def papers_dedupe(
    apply: bool = typer.Option(False, "--apply", help="Merge duplicate title groups. Defaults to dry-run."),
    dry_run: bool = typer.Option(False, "--dry-run", help="List duplicate groups without changing the DB."),
) -> None:
    """Find or merge exact normalized-title duplicate papers."""
    if apply and dry_run:
        console.print("[red]Choose either --dry-run or --apply, not both.[/red]")
        raise typer.Exit(1)

    conn = _get_conn()
    if apply:
        groups = merge_title_duplicate_groups(conn)
        conn.commit()
    else:
        groups = find_title_duplicate_groups(conn)
    conn.close()

    if not groups:
        console.print("[dim]No title duplicate groups found.[/dim]")
        return

    table = Table(show_lines=True, expand=True)
    table.add_column("Group", width=5, no_wrap=True, style="dim")
    table.add_column("Canonical", width=9, no_wrap=True)
    table.add_column("Paper", width=8, no_wrap=True)
    table.add_column("Source", width=9, no_wrap=True)
    table.add_column("Date", width=11, no_wrap=True)
    table.add_column("Title")

    for index, group in enumerate(groups, start=1):
        canonical_id = int(group["canonical_id"])
        papers = group["papers"]
        if not isinstance(papers, list):
            continue
        for paper in papers:
            if not isinstance(paper, dict):
                continue
            paper_id = int(paper["id"])
            table.add_row(
                str(index),
                "yes" if paper_id == canonical_id else "",
                str(paper_id),
                str(paper["source"]),
                str(paper["published_date"]),
                str(paper["title"])[:100],
            )

    console.print(table)
    if apply:
        console.print(f"[dim]{len(groups)} duplicate group(s) merged.[/dim]")
    else:
        console.print(f"[dim]{len(groups)} duplicate group(s) would merge. Use --apply to mutate the database.[/dim]")


# ---------------------------------------------------------------------------
# todo
# ---------------------------------------------------------------------------

@todo_app.command("add")
def todo_add(
    title: str = typer.Argument(..., help="Task title."),
    description: str = typer.Option("", "--description", "-d", help="Task description."),
    priority: str = typer.Option("medium", "--priority", "-p", help="high | medium | low"),
    project: Optional[int] = typer.Option(None, "--project", help="Project ID."),
    due: Optional[str] = typer.Option(None, "--due", help="Due date YYYY-MM-DD."),
) -> None:
    """Add a new todo."""
    try:
        prio = TodoPriority(priority)
    except ValueError:
        console.print(f"[red]Unknown priority '{priority}'. Choose: high, medium, low[/red]")
        raise typer.Exit(1)

    due_date: Optional[date] = None
    if due:
        try:
            due_date = date.fromisoformat(due)
        except ValueError:
            console.print(f"[red]Invalid date '{due}'. Use YYYY-MM-DD.[/red]")
            raise typer.Exit(1)

    conn = _get_conn()
    result = create_task(
        conn,
        title=title,
        description=description,
        priority=prio.value,
        project_ids=[project] if project is not None else [],
        due_date=due_date,
    )
    conn.commit()
    conn.close()
    console.print(f"[green]✓[/green] Todo #{result.task_id} added.")


@todo_app.command("list")
def todo_list(
    project: Optional[int] = typer.Option(None, "--project", help="Filter by project ID."),
    done: bool = typer.Option(False, "--done", help="Show completed todos instead."),
) -> None:
    """List open (or completed) todos."""
    conn = _get_conn()
    status = TodoStatus.DONE if done else TodoStatus.OPEN
    todos = list_todos(conn, status=status, project_id=project)
    conn.close()

    if not todos:
        console.print("[dim]No todos found.[/dim]")
        raise typer.Exit(0)

    table = Table(show_lines=False, expand=True)
    table.add_column("ID",       width=4,  no_wrap=True, style="dim")
    table.add_column("Priority", width=8,  no_wrap=True)
    table.add_column("Project",  width=12, no_wrap=True)
    table.add_column("Due",      width=11, no_wrap=True)
    table.add_column("Task")

    for t in todos:
        color = _PRIORITY_COLOR.get(t.priority.value, "white")
        due_str = ""
        if t.due_date:
            overdue = t.due_date < date.today() and status == TodoStatus.OPEN
            due_str = f"[red]{t.due_date}[/red]" if overdue else str(t.due_date)
        task_str = f"~~{t.title}~~" if done else t.title
        table.add_row(
            str(t.id),
            f"[{color}]{t.priority.value}[/{color}]",
            ",".join(str(project_id) for project_id in t.project_ids),
            due_str,
            task_str,
        )

    console.print(table)


@todo_app.command("done")
def todo_done(
    todo_id: int = typer.Argument(..., help="Todo ID (see todo list)."),
) -> None:
    """Mark a todo as completed."""
    conn = _get_conn()
    complete_todo(conn, todo_id)
    conn.commit()
    conn.close()
    console.print(f"[green]✓[/green] Todo #{todo_id} marked done.")


# ---------------------------------------------------------------------------
# log
# ---------------------------------------------------------------------------

@log_app.command("add")
def log_add(
    entry: str = typer.Argument(..., help="What did you work on?"),
    project: Optional[int] = typer.Option(None, "--project", help="Project ID."),
) -> None:
    """Add a manual log entry for today."""
    conn = _get_conn()
    result = create_manual_log_from_text(
        conn,
        entry=entry,
        project_ids=[project] if project is not None else [],
        derive_linked_paper_ids=False,
    )
    conn.commit()
    conn.close()
    console.print(f"[green]✓[/green] Log entry #{result.entry_id} added.")


@log_app.command("list")
def log_list(
    days: int = typer.Option(7, "--days", "-d", help="Look-back window in days."),
    project: Optional[int] = typer.Option(None, "--project", help="Filter by project ID."),
) -> None:
    """List recent log entries."""
    conn = _get_conn()
    entries = list_log_entries(conn, days=days, project_id=project)
    conn.close()

    if not entries:
        console.print("[dim]No log entries found.[/dim]")
        raise typer.Exit(0)

    current_date = None
    for e in entries:
        if e.entry_date != current_date:
            current_date = e.entry_date
            console.rule(f"[bold]{current_date.strftime('%B %d, %Y')}[/bold]")
        tag = f"  [dim]{','.join(str(project_id) for project_id in e.project_ids)}[/dim]" if e.project_ids else ""
        console.print(f"  [dim]#{e.id}[/dim]  {format_log_entry_display_text(e)}{tag}")

    console.print()
    console.print(f"[dim]{len(entries)} entry(ies) · last {days} day(s)[/dim]")


@app.command()
def up(
    port: int = typer.Option(8765, "--port", "-p", help="Port to listen on."),
    no_browser: bool = typer.Option(False, "--no-browser", help="Skip opening the browser."),
) -> None:
    """Start the claudesk web server (FastAPI + React UI)."""
    import threading
    import time
    import webbrowser

    import uvicorn

    url = f"http://localhost:{port}"
    console.print(f"[bold]claudesk[/bold] starting at [cyan]{url}[/cyan]")

    if not no_browser:
        def _open():
            time.sleep(1.5)
            webbrowser.open(url)
        threading.Thread(target=_open, daemon=True).start()

    uvicorn.run("claudesk.api.main:app", host="127.0.0.1", port=port, reload=False)


if __name__ == "__main__":
    app()
