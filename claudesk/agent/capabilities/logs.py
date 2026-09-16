from __future__ import annotations

import json

from claudesk.agent.capabilities.registry import CapabilitySpec
from claudesk.agent.context import CapabilityContext
from claudesk.agent.schemas import (
    AddLogEntryInput,
    CapabilityInput,
    CapabilityResult,
    ListLogInput,
    UpdateLogEntryInput,
    mutation_result,
)
from claudesk.core.db.tasks import (
    format_log_entry_display_text,
    list_log_entries,
)
from claudesk.core.task_log_workflows import (
    create_manual_log_from_text,
    update_manual_log_from_text,
)


def _list_log(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = ListLogInput.model_validate(args)
    entries = list_log_entries(context.conn, days=data.days)
    return CapabilityResult(text=json.dumps([_log_entry_payload(entry) for entry in entries]))


def _log_entry_payload(entry) -> dict:
    payload = entry.model_dump(mode="json", exclude={"created_at", "raw_markdown"})
    payload["entry"] = format_log_entry_display_text(entry)
    return payload


def _add_log_entry(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = AddLogEntryInput.model_validate(args)
    result = create_manual_log_from_text(
        context.conn,
        entry=data.entry,
        project_ids=data.project_ids,
        paper_ids=data.paper_ids,
    )
    context.conn.commit()
    return mutation_result(
        action="add_log_entry",
        resource="log",
        id=result.entry_id,
        after=(
            _manual_log_payload(result.entry)
            if result.entry is not None
            else {"id": result.entry_id, "entry": data.entry}
        ),
    )


def _manual_log_payload(entry) -> dict:
    return {
        "id": entry.id,
        "entry_date": str(entry.entry_date),
        "entry": entry.entry,
        "project_ids": entry.project_ids,
        "linked_paper_ids": entry.linked_paper_ids,
    }


def _update_log_entry(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = UpdateLogEntryInput.model_validate(args)
    try:
        result = update_manual_log_from_text(
            context.conn,
            data.entry_id,
            entry=data.entry,
            project_ids=data.project_ids,
            paper_ids=data.paper_ids,
        )
    except ValueError as exc:
        error = str(exc)
        if error.startswith("Paper ") and error.endswith(" not found."):
            raise
        if "not a manual log entry" in error:
            error = f"{error} Task log entries are edited through task tools."
        return CapabilityResult(text=json.dumps({"ok": False, "error": error}))
    context.conn.commit()
    return mutation_result(
        action="update_log_entry",
        resource="log",
        id=data.entry_id,
        before=_manual_log_payload(result.before),
        after=_manual_log_payload(result.after) if result.after is not None else None,
    )


def capabilities() -> list[CapabilitySpec]:
    return [
        CapabilitySpec(
            name="list_log",
            description="List recent log entries - date-stamped research memory. Includes manual entries and completed task activity.",
            input_model=ListLogInput,
            handler=_list_log,
            domain="log",
            access="read",
            risk="low",
        ),
        CapabilitySpec(
            name="add_log_entry",
            description="Add a new manual log entry for today - durable research memory. When log text references local papers, pass paper_ids so the saved entry uses clickable paper links.",
            input_model=AddLogEntryInput,
            handler=_add_log_entry,
            domain="log",
            access="create",
            risk="medium",
            gate="log_write",
        ),
        CapabilitySpec(
            name="update_log_entry",
            description="Update an existing manual log entry by explicit id. Task log entries are edited through task tools. When log text references local papers, pass paper_ids so the saved entry uses clickable paper links. Returns before/after content because logs are durable research memory.",
            input_model=UpdateLogEntryInput,
            handler=_update_log_entry,
            domain="log",
            access="update",
            risk="medium",
            gate="log_write",
        ),
    ]
