from __future__ import annotations

import json

from claudesk.agent.capabilities.registry import CapabilitySpec
from claudesk.agent.context import CapabilityContext
from claudesk.agent.schemas import (
    CapabilityInput,
    CapabilityResult,
    CreateNoteInput,
    CreatePaperNoteInput,
    GetNoteContextInput,
    LinkNotePaperInput,
    SearchNotesInput,
    UnlinkNotePaperInput,
    UpdateNoteInput,
    mutation_result,
)
from claudesk.core.db.notes import (
    create_note,
    get_note,
    link_note_paper,
    unlink_note_paper,
    update_note,
)
from claudesk.core.db.papers import get_paper
from claudesk.core.models import resource_read
from claudesk.core.retrieval import (
    RetrievalRequest,
    RetrievalSourceType,
    retrieve,
    retrieval_backends_from_mode,
)


def _note_payload(note) -> dict:
    return {
        "id": note.id,
        "title": note.title,
        "body": note.body,
        "linked_paper_ids": note.linked_paper_ids,
        "mentioned_paper_ids": note.mentioned_paper_ids,
        "manual_paper_ids": note.manual_paper_ids,
        "created_at": note.created_at.isoformat(),
        "updated_at": note.updated_at.isoformat(),
    }


def _create_note(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = CreateNoteInput.model_validate(args)
    note = create_note(
        context.conn,
        title=data.title,
        body=data.body,
        manual_paper_ids=[],
    )
    context.conn.commit()
    return mutation_result(
        action="create_note",
        resource="note",
        id=note.id,
        after=_note_payload(note),
    )


def _paper_or_error(context: CapabilityContext, paper_id: int):
    paper = get_paper(context.conn, paper_id)
    if paper is None:
        return None, CapabilityResult(text=json.dumps({"ok": False, "error": f"Paper {paper_id} not found."}))
    return paper, None


def _create_paper_note(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = CreatePaperNoteInput.model_validate(args)
    paper, error = _paper_or_error(context, data.paper_id)
    if error is not None:
        return error
    note = create_note(
        context.conn,
        title=data.title or f"Note on: {paper.title}",
        body=data.note,
        manual_paper_ids=[data.paper_id],
    )
    context.conn.commit()
    return CapabilityResult(text=json.dumps({
        "ok": True,
        "paper_id": data.paper_id,
        "created": True,
        "note": _note_payload(note),
    }))


def _update_note(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = UpdateNoteInput.model_validate(args)
    existing = get_note(context.conn, data.note_id)
    if existing is None:
        return CapabilityResult(text=json.dumps({"ok": False, "error": f"Note {data.note_id} not found."}))
    payload = {
        key: value
        for key, value in {
            "title": data.title,
            "body": data.body,
        }.items()
        if key in data.model_fields_set
    }
    if not payload:
        return CapabilityResult(text=json.dumps({"ok": False, "error": "At least one note field is required."}))
    note = update_note(context.conn, data.note_id, **payload)
    context.conn.commit()
    return mutation_result(
        action="update_note",
        resource="note",
        id=data.note_id,
        before=_note_payload(existing),
        after=_note_payload(note),
    )


def _link_note_paper(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = LinkNotePaperInput.model_validate(args)
    existing = get_note(context.conn, data.note_id)
    if existing is None:
        return CapabilityResult(text=json.dumps({"ok": False, "error": f"Note {data.note_id} not found."}))
    note = link_note_paper(context.conn, data.note_id, data.paper_id)
    context.conn.commit()
    return mutation_result(
        action="link_note_paper",
        resource="note_paper",
        id=f"{data.note_id}:{data.paper_id}",
        before=_note_payload(existing),
        after=_note_payload(note),
    )


def _unlink_note_paper(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = UnlinkNotePaperInput.model_validate(args)
    existing = get_note(context.conn, data.note_id)
    if existing is None:
        return CapabilityResult(text=json.dumps({"ok": False, "error": f"Note {data.note_id} not found."}))
    note = unlink_note_paper(context.conn, data.note_id, data.paper_id)
    context.conn.commit()
    return mutation_result(
        action="unlink_note_paper",
        resource="note_paper",
        id=f"{data.note_id}:{data.paper_id}",
        before=_note_payload(existing),
        after=_note_payload(note),
    )


def _get_note_context(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = GetNoteContextInput.model_validate(args)
    note = get_note(context.conn, data.note_id)
    if note is None:
        return CapabilityResult(text=json.dumps({
            "ok": False,
            "error": f"Note {data.note_id} not found.",
        }))
    return CapabilityResult(
        text=json.dumps({
            "ok": True,
            "note": _note_payload(note),
        }),
        resource_reads=(
            resource_read(
                "note",
                note.id,
                label=note.title,
                summary="Full note context returned.",
                locator={"note_id": note.id},
            ),
        ),
    )


def _search_notes(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = SearchNotesInput.model_validate(args)
    try:
        backends = retrieval_backends_from_mode(data.backend)
    except ValueError as exc:
        return CapabilityResult(text=json.dumps({"ok": False, "error": str(exc)}))
    results = retrieve(
        context.conn,
        RetrievalRequest.from_text(
            data.query,
            source_types=(RetrievalSourceType.NOTE,),
            limit_per_source=data.limit,
            backends=backends,
        ),
    )
    notes = [hit.payload for hit in results.hits_for(RetrievalSourceType.NOTE)]
    return CapabilityResult(text=json.dumps({
        "ok": True,
        "query": data.query,
        "notes": [_note_payload(note) for note in notes],
    }))


def capabilities() -> list[CapabilitySpec]:
    return [
        CapabilitySpec(
            name="get_note_context",
            description="Fetch a first-class Claudesk note by id, including full body text and linked paper ids.",
            input_model=GetNoteContextInput,
            handler=_get_note_context,
            domain="note",
            access="read",
            risk="low",
        ),
        CapabilitySpec(
            name="create_note",
            description="Create a standalone first-class markdown note. Use create_paper_note when the new note should be linked to a specific paper at creation time.",
            input_model=CreateNoteInput,
            handler=_create_note,
            domain="note",
            access="create",
            risk="medium",
            gate="note_write",
        ),
        CapabilitySpec(
            name="create_paper_note",
            description="Create a new first-class markdown note linked to a paper. Use this when the user asks for a new paper-linked note rather than editing an existing one.",
            input_model=CreatePaperNoteInput,
            handler=_create_paper_note,
            domain="note",
            access="create",
            risk="medium",
            gate="note_write",
        ),
        CapabilitySpec(
            name="update_note",
            description="Edit a first-class note by explicit note id. This can update title and body, but cannot delete notes.",
            input_model=UpdateNoteInput,
            handler=_update_note,
            domain="note",
            access="update",
            risk="medium",
            gate="note_write",
        ),
        CapabilitySpec(
            name="link_note_paper",
            description="Link an existing first-class note to a paper by explicit ids.",
            input_model=LinkNotePaperInput,
            handler=_link_note_paper,
            domain="note",
            access="link",
            risk="medium",
            gate="note_write",
        ),
        CapabilitySpec(
            name="unlink_note_paper",
            description="Unlink a first-class note from a paper by explicit ids. This does not delete the note or paper.",
            input_model=UnlinkNotePaperInput,
            handler=_unlink_note_paper,
            domain="note",
            access="link",
            risk="medium",
            gate="note_write",
        ),
        CapabilitySpec(
            name="search_notes",
            description="Search first-class note titles and bodies. Returns linked paper ids for each note.",
            input_model=SearchNotesInput,
            handler=_search_notes,
            domain="note",
            access="read",
            risk="low",
        ),
    ]
