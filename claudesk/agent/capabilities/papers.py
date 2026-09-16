from __future__ import annotations

import json
from datetime import date, timedelta

from claudesk.agent.capabilities.registry import CapabilitySpec
from claudesk.agent.context import CapabilityContext
from claudesk.agent.schemas import (
    AddPaperByDoiInput,
    CapabilityInput,
    CapabilityResult,
    GetPapersByIdsInput,
    ListRecentPapersInput,
    PaperCollectionActionInput,
    SearchPapersInput,
    mutation_result,
)
from claudesk.core.db.papers import (
    get_paper,
    list_papers,
)
from claudesk.core.models import PaperSignal, PaperStatus, resource_read
from claudesk.core.paper_ingest import add_paper_by_doi
from claudesk.core.paper_status import apply_paper_signal
from claudesk.core.retrieval import (
    RetrievalRequest,
    RetrievalSourceType,
    retrieve,
    retrieval_backends_from_mode,
)


def _paper_payload(paper, *, include_authors: bool = False, include_status: bool = True) -> dict:
    payload = {
        "id": paper.id,
        "title": paper.title,
        "abstract": paper.abstract,
        "source": paper.source,
        "published_date": str(paper.published_date),
        "score": round(paper.relevance_score, 3) if paper.relevance_score else None,
        "score_rubric": paper.score_rubric.model_dump(mode="python") if paper.score_rubric else None,
        "note_count": paper.note_count,
        "latest_note_preview": paper.latest_note_preview,
        "url": paper.url,
    }
    if include_authors:
        payload["authors"] = paper.authors
    else:
        payload["authors"] = paper.authors[:3]
    if include_status:
        payload["status"] = paper.status.value
    return payload


def _list_recent_papers(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = ListRecentPapersInput.model_validate(args)
    status = PaperStatus(data.status) if data.status else None
    since = date.today() - timedelta(days=data.days)
    papers = list_papers(context.conn, since=since, status=status, limit=20)
    return CapabilityResult(text=json.dumps([
        _paper_payload(paper, include_authors=False, include_status=True)
        for paper in papers
    ]))


def _search_papers(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = SearchPapersInput.model_validate(args)
    try:
        backends = retrieval_backends_from_mode(data.backend)
    except ValueError as exc:
        return CapabilityResult(text=json.dumps({"ok": False, "error": str(exc)}))
    results = retrieve(
        context.conn,
        RetrievalRequest.from_text(
            data.query,
            source_types=(RetrievalSourceType.PAPER,),
            limit_per_source=10,
            backends=backends,
        ),
    )
    papers = [hit.payload for hit in results.hits_for(RetrievalSourceType.PAPER)]
    return CapabilityResult(text=json.dumps([
        _paper_payload(paper, include_authors=False, include_status=False)
        for paper in papers
    ]))


def _get_papers_by_ids(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = GetPapersByIdsInput.model_validate(args)
    raw_ids = data.paper_ids if isinstance(data.paper_ids, list) else [data.paper_ids]

    seen: set[int] = set()
    ordered_ids: list[int] = []
    for raw_id in raw_ids:
        try:
            paper_id = int(raw_id)
        except (TypeError, ValueError):
            continue
        if paper_id in seen:
            continue
        seen.add(paper_id)
        ordered_ids.append(paper_id)

    papers: list[dict] = []
    resource_reads = []
    missing_ids: list[int] = []
    for paper_id in ordered_ids:
        paper = get_paper(context.conn, paper_id)
        if paper is None:
            missing_ids.append(paper_id)
            continue
        papers.append(_paper_payload(paper, include_authors=True, include_status=True))
        resource_reads.append(
            resource_read(
                "paper",
                paper.id,
                label=paper.title,
                summary="Exact paper metadata returned.",
                locator={"paper_id": paper.id},
            )
        )

    return CapabilityResult(text=json.dumps({
        "papers": papers,
        "missing_ids": missing_ids,
    }), resource_reads=tuple(resource_reads))


def _save_paper(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = PaperCollectionActionInput.model_validate(args)
    status_update = apply_paper_signal(context.conn, data.paper_id, PaperSignal.SAVED)
    context.conn.commit()
    return mutation_result(
        action="save_paper",
        resource="paper",
        id=data.paper_id,
        before=_paper_payload(status_update.before, include_authors=False, include_status=True),
        after=_paper_payload(status_update.after, include_authors=False, include_status=True),
    )


def _add_paper_to_reading_queue(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = PaperCollectionActionInput.model_validate(args)
    status_update = apply_paper_signal(context.conn, data.paper_id, PaperSignal.TO_READ)
    context.conn.commit()
    return mutation_result(
        action="add_paper_to_reading_queue",
        resource="paper",
        id=data.paper_id,
        before=_paper_payload(status_update.before, include_authors=False, include_status=True),
        after=_paper_payload(status_update.after, include_authors=False, include_status=True),
    )


def _add_paper_by_doi(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = AddPaperByDoiInput.model_validate(args)
    result = add_paper_by_doi(context.conn, data.doi, save=False)
    context.conn.commit()
    return mutation_result(
        action="add_paper_by_doi",
        resource="paper",
        id=result.paper.id,
        after=_paper_payload(result.paper, include_authors=True, include_status=True),
        warnings=result.warnings,
        extra={"ingest_status": result.status},
    )


def capabilities() -> list[CapabilitySpec]:
    return [
        CapabilitySpec(
            name="list_recent_papers",
            description="List recent papers from the research digest, including linked-note counts when present, ordered by relevance score.",
            input_model=ListRecentPapersInput,
            handler=_list_recent_papers,
            domain="paper",
            access="read",
            risk="low",
        ),
        CapabilitySpec(
            name="search_papers",
            description="Full-text search across paper titles, abstracts, and authors. All terms must match (AND logic).",
            input_model=SearchPapersInput,
            handler=_search_papers,
            domain="paper",
            access="read",
            risk="low",
        ),
        CapabilitySpec(
            name="get_papers_by_ids",
            description="Fetch exact paper records by local paper id. Use this when the user tags one or more papers in chat or gives explicit paper ids.",
            input_model=GetPapersByIdsInput,
            handler=_get_papers_by_ids,
            domain="paper",
            access="read",
            risk="low",
        ),
        CapabilitySpec(
            name="save_paper",
            description="Save an existing local paper to the user's collection by exact paper id. This does not delete, dismiss, mark read, or mutate broader paper status.",
            input_model=PaperCollectionActionInput,
            handler=_save_paper,
            domain="paper",
            access="update",
            risk="medium",
            gate="paper_collection_write",
        ),
        CapabilitySpec(
            name="add_paper_to_reading_queue",
            description="Add an existing local paper to the reading queue by exact paper id. This does not mark the paper read or mutate other paper status fields.",
            input_model=PaperCollectionActionInput,
            handler=_add_paper_to_reading_queue,
            domain="paper",
            access="update",
            risk="medium",
            gate="paper_collection_write",
        ),
        CapabilitySpec(
            name="add_paper_by_doi",
            description="Fetch DOI metadata and add or merge the paper into the local library. This does not save the paper; call save_paper separately if the user asks to save it.",
            input_model=AddPaperByDoiInput,
            handler=_add_paper_by_doi,
            domain="paper",
            access="external_ingest",
            risk="medium",
            gate="paper_ingest",
        ),
    ]
