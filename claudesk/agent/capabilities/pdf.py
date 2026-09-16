from __future__ import annotations

import json

from claudesk.agent.capabilities.registry import CapabilitySpec
from claudesk.agent.context import CapabilityContext
from claudesk.agent.schemas import (
    AttachPdfFromUrlInput,
    CapabilityInput,
    CapabilityResult,
    InspectPaperPdfPagesInput,
    ListPaperAssetsInput,
    ListPaperStructureInput,
    ParsePaperAssetInput,
    ReadPaperPdfInput,
    ReadPaperSectionInput,
    RenamePaperAssetInput,
    RetrievePaperContextInput,
    SearchPaperPdfInput,
    ToolImageAttachment,
    mutation_result,
)
from claudesk.core.db.assets import (
    get_paper_asset,
    list_paper_assets as db_list_paper_assets,
    update_paper_asset_display_name,
)
from claudesk.core.db.papers import get_paper
from claudesk.core.models import AssetKind, resource_read
from claudesk.core.paper_asset_ops import attach_pdf_from_url
from claudesk.core.pdf_context import (
    PdfContextResult,
    PdfImageAttachment,
    asset_resource_read,
    asset_summary,
    build_paper_structure_context,
    inspect_paper_pdf_pages_context,
    read_paper_pdf_chunks_context,
    read_paper_section_context,
    retrieve_paper_context,
    search_paper_pdf_context,
    select_paper_pdf_asset,
)
from claudesk.core.pdf_ingest import PdfIngestError, clear_pdf_ingest_cache, ensure_pdf_ingested
from claudesk.core.retrieval import retrieval_backends_from_mode


def _tool_image_attachment(image: PdfImageAttachment) -> ToolImageAttachment:
    return ToolImageAttachment(
        label=image.label,
        mime_type=image.mime_type,
        managed_path=image.managed_path,
        asset_id=image.asset_id,
        page_number=image.page_number,
        width=image.width,
        height=image.height,
        temporary=image.temporary,
    )


def _context_result(result: PdfContextResult) -> CapabilityResult:
    images = tuple(_tool_image_attachment(image) for image in result.images)
    return CapabilityResult(
        text=json.dumps(result.payload),
        images=images,
        resource_reads=result.resource_reads,
    )


def _ingest_selected_pdf(context: CapabilityContext, paper_id: int, asset_id: int):
    try:
        result = ensure_pdf_ingested(
            context.conn,
            paper_id=paper_id,
            asset_id=asset_id,
            cfg=context.cfg,
        )
        context.conn.commit()
        return result, None
    except PdfIngestError as exc:
        context.conn.commit()
        return None, {"ok": False, "error": str(exc)}


def _section_path_arg(value: object) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str):
        cleaned = value.strip()
        if not cleaned:
            return []
        return [part.strip() for part in cleaned.split(">") if part.strip()]
    return []


def _list_paper_assets(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = ListPaperAssetsInput.model_validate(args)
    paper = get_paper(context.conn, data.paper_id)
    if paper is None:
        return CapabilityResult(text=json.dumps({"ok": False, "error": f"Paper {data.paper_id} not found."}))
    assets = db_list_paper_assets(context.conn, data.paper_id)
    if data.kind:
        try:
            target_kind = AssetKind(str(data.kind))
        except ValueError:
            return CapabilityResult(text=json.dumps({"ok": False, "error": f"Unknown asset kind: {data.kind}"}))
        assets = [asset for asset in assets if asset.kind == target_kind]
    reads = [
        resource_read(
            "paper",
            paper.id,
            label=paper.title,
            summary="Paper asset list returned.",
            locator={"paper_id": paper.id},
        )
    ]
    reads.extend(asset_resource_read(data.paper_id, asset) for asset in assets)
    return CapabilityResult(
        text=json.dumps({
            "ok": True,
            "paper_id": data.paper_id,
            "paper_title": paper.title,
            "assets": [asset_summary(context.conn, asset, cfg=context.cfg) for asset in assets],
        }),
        resource_reads=tuple(reads),
    )


def _rename_paper_asset(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = RenamePaperAssetInput.model_validate(args)
    before = get_paper_asset(context.conn, data.paper_id, data.asset_id)
    if before is None:
        raise ValueError(f"Paper asset {data.asset_id} not found for paper {data.paper_id}.")
    if before.kind != AssetKind.PDF:
        raise ValueError(f"Asset {data.asset_id} is not a PDF.")

    after = update_paper_asset_display_name(
        context.conn,
        data.paper_id,
        data.asset_id,
        data.display_name,
    )
    context.conn.commit()
    return mutation_result(
        action="rename_paper_asset",
        resource="asset",
        id=data.asset_id,
        before=asset_summary(context.conn, before, cfg=context.cfg),
        after=asset_summary(context.conn, after, cfg=context.cfg),
    )


def _parse_paper_asset(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = ParsePaperAssetInput.model_validate(args)
    before = get_paper_asset(context.conn, data.paper_id, data.asset_id)
    if before is None:
        raise ValueError(f"Paper asset {data.asset_id} not found for paper {data.paper_id}.")
    if before.kind != AssetKind.PDF:
        raise ValueError(f"Asset {data.asset_id} is not a PDF.")
    if data.force:
        clear_pdf_ingest_cache(context.conn, data.asset_id, cfg=context.cfg)

    result, ingest_error = _ingest_selected_pdf(context, data.paper_id, data.asset_id)
    if ingest_error is not None:
        return CapabilityResult(text=json.dumps(ingest_error))
    after = result.asset if result is not None else get_paper_asset(context.conn, data.paper_id, data.asset_id)
    return mutation_result(
        action="parse_paper_asset",
        resource="asset",
        id=data.asset_id,
        before=asset_summary(context.conn, before, cfg=context.cfg),
        after=asset_summary(context.conn, after, cfg=context.cfg),
        extra={"cache_hit": bool(result.cache_hit) if result else False},
    )


def _attach_pdf_from_url(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = AttachPdfFromUrlInput.model_validate(args)
    asset = attach_pdf_from_url(context.conn, data.paper_id, data.url, cfg=context.cfg)
    context.conn.commit()
    return mutation_result(
        action="attach_pdf_from_url",
        resource="asset",
        id=asset.id,
        after=asset_summary(context.conn, asset, cfg=context.cfg),
    )


def _select_and_ingest_pdf(data, context: CapabilityContext):
    asset, selection_error = select_paper_pdf_asset(
        context.conn,
        paper_id=data.paper_id,
        asset_id=data.asset_id,
        cfg=context.cfg,
    )
    if selection_error is not None:
        return None, None, selection_error
    asset_id = asset.id or 0
    result, ingest_error = _ingest_selected_pdf(context, data.paper_id, asset_id)
    if ingest_error is not None:
        return None, None, ingest_error
    if result is not None:
        asset = result.asset
    return asset, result, None


def _list_paper_structure(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = ListPaperStructureInput.model_validate(args)
    asset, result, error = _select_and_ingest_pdf(data, context)
    if error is not None:
        return CapabilityResult(text=json.dumps(error))

    return _context_result(build_paper_structure_context(
        context.conn,
        paper_id=data.paper_id,
        asset=asset,
        cache_hit=bool(result.cache_hit) if result else False,
        cfg=context.cfg,
    ))


def _retrieve_paper_context(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = RetrievePaperContextInput.model_validate(args)
    query = data.query.strip()
    if not query:
        return CapabilityResult(text=json.dumps({"ok": False, "error": "query is required."}))
    try:
        backends = retrieval_backends_from_mode(data.backend)
    except ValueError as exc:
        return CapabilityResult(text=json.dumps({"ok": False, "error": str(exc)}))
    asset, result, error = _select_and_ingest_pdf(data, context)
    if error is not None:
        return CapabilityResult(text=json.dumps(error))

    return _context_result(retrieve_paper_context(
        context.conn,
        paper_id=data.paper_id,
        asset=asset,
        query=query,
        limit=data.limit,
        max_chars=data.max_chars,
        cache_hit=bool(result.cache_hit) if result else False,
        cfg=context.cfg,
        backends=backends,
    ))


def _read_paper_section(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = ReadPaperSectionInput.model_validate(args)
    section_path = _section_path_arg(data.section_path)
    if not section_path:
        return CapabilityResult(text=json.dumps({"ok": False, "error": "section_path is required."}))
    asset, result, error = _select_and_ingest_pdf(data, context)
    if error is not None:
        return CapabilityResult(text=json.dumps(error))

    return _context_result(read_paper_section_context(
        context.conn,
        paper_id=data.paper_id,
        asset=asset,
        section_path=section_path,
        limit=data.limit,
        max_chars=data.max_chars,
        cache_hit=bool(result.cache_hit) if result else False,
        cfg=context.cfg,
    ))


def _read_paper_pdf(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = ReadPaperPdfInput.model_validate(args)
    asset, result, error = _select_and_ingest_pdf(data, context)
    if error is not None:
        return CapabilityResult(text=json.dumps(error))

    return _context_result(read_paper_pdf_chunks_context(
        context.conn,
        paper_id=data.paper_id,
        asset=asset,
        start_chunk=data.start_chunk,
        limit=data.limit,
        max_chars=data.max_chars,
        include_page_images=data.include_page_images,
        cache_hit=bool(result.cache_hit) if result else False,
        cfg=context.cfg,
    ))


def _search_paper_pdf(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = SearchPaperPdfInput.model_validate(args)
    query = data.query.strip()
    if not query:
        return CapabilityResult(text=json.dumps({"ok": False, "error": "query is required."}))
    try:
        backends = retrieval_backends_from_mode(data.backend)
    except ValueError as exc:
        return CapabilityResult(text=json.dumps({"ok": False, "error": str(exc)}))
    asset, result, error = _select_and_ingest_pdf(data, context)
    if error is not None:
        return CapabilityResult(text=json.dumps(error))

    return _context_result(search_paper_pdf_context(
        context.conn,
        paper_id=data.paper_id,
        asset=asset,
        query=query,
        limit=data.limit,
        max_chars=data.max_chars,
        include_page_images=data.include_page_images,
        cache_hit=bool(result.cache_hit) if result else False,
        cfg=context.cfg,
        backends=backends,
    ))


def _inspect_paper_pdf_pages(args: CapabilityInput, context: CapabilityContext) -> CapabilityResult:
    data = InspectPaperPdfPagesInput.model_validate(args)
    page_numbers: list[int] = []
    for page_number in data.pages:
        if page_number >= 1 and page_number not in page_numbers:
            page_numbers.append(page_number)
        if len(page_numbers) >= 3:
            break
    if not page_numbers:
        return CapabilityResult(text=json.dumps({"ok": False, "error": "At least one page number is required."}))

    asset, result, error = _select_and_ingest_pdf(data, context)
    if error is not None:
        return CapabilityResult(text=json.dumps(error))

    return _context_result(inspect_paper_pdf_pages_context(
        context.conn,
        paper_id=data.paper_id,
        asset=asset,
        page_numbers=page_numbers,
        include_text=data.include_text,
        include_images=data.include_images,
        cache_hit=bool(result.cache_hit) if result else False,
        cfg=context.cfg,
    ))


def capabilities() -> list[CapabilitySpec]:
    return [
        CapabilitySpec(
            name="list_paper_assets",
            description="List managed local assets attached to a paper, including uploaded PDFs and their local parse/image cache status. This is the discovery step for whether a tagged paper has managed local PDFs before using internet full-text.",
            input_model=ListPaperAssetsInput,
            handler=_list_paper_assets,
            domain="asset",
            access="read",
            risk="low",
            gate="paper_pdf",
        ),
        CapabilitySpec(
            name="rename_paper_asset",
            description="Rename a managed PDF asset attached to a paper by exact paper_id and asset_id. This only changes the asset display name.",
            input_model=RenamePaperAssetInput,
            handler=_rename_paper_asset,
            domain="asset",
            access="update",
            risk="medium",
            gate="paper_asset_write",
        ),
        CapabilitySpec(
            name="parse_paper_asset",
            description="Parse or reparse a managed PDF asset attached to a paper by exact paper_id and asset_id, producing cached text, sections, chunks, and page images.",
            input_model=ParsePaperAssetInput,
            handler=_parse_paper_asset,
            domain="asset",
            access="update",
            risk="medium",
            gate="paper_asset_write",
        ),
        CapabilitySpec(
            name="attach_pdf_from_url",
            description="Fetch an https:// PDF URL and attach it as a managed PDF asset to an existing paper. This rejects local paths, non-HTTPS URLs, non-PDF content, and oversized downloads.",
            input_model=AttachPdfFromUrlInput,
            handler=_attach_pdf_from_url,
            domain="asset",
            access="external_ingest",
            risk="high",
            gate="paper_asset_write",
        ),
        CapabilitySpec(
            name="list_paper_structure",
            description="List the parsed full-text structure for a managed local PDF: sections, block counts, tables, figures, and parse provenance. Lazily parses on first use.",
            input_model=ListPaperStructureInput,
            handler=_list_paper_structure,
            domain="asset",
            access="read",
            risk="low",
            gate="paper_pdf",
        ),
        CapabilitySpec(
            name="retrieve_paper_context",
            description="Retrieve targeted query-matching evidence from a managed local paper PDF with section, page, block, and chunk provenance. Use this for specific factual questions, not broad whole-paper summaries; use read_paper_pdf for summaries or reviews.",
            input_model=RetrievePaperContextInput,
            handler=_retrieve_paper_context,
            domain="asset",
            access="read",
            risk="low",
            gate="paper_pdf",
        ),
        CapabilitySpec(
            name="read_paper_section",
            description="Read ordered parsed full-text blocks from a named section path in a managed local paper PDF. Use list_paper_structure first when section names are unclear.",
            input_model=ReadPaperSectionInput,
            handler=_read_paper_section,
            domain="asset",
            access="read",
            risk="low",
            gate="paper_pdf",
        ),
        CapabilitySpec(
            name="read_paper_pdf",
            description="Read cached text chunks from a managed local PDF attached to a paper. This is the primary tool for broad local-PDF summaries, reviews, and whole-paper reading when a managed paper PDF exists. For broad summaries, read an initial batch with limit 8-12 and answer from that evidence unless a specific gap requires another batch; do not exhaustively follow next_chunk_index by default.",
            input_model=ReadPaperPdfInput,
            handler=_read_paper_pdf,
            domain="asset",
            access="read",
            risk="low",
            gate="paper_pdf",
        ),
        CapabilitySpec(
            name="search_paper_pdf",
            description="Search cached chunks from a managed local paper PDF for targeted evidence. Lazily parses and renders the PDF on first use.",
            input_model=SearchPaperPdfInput,
            handler=_search_paper_pdf,
            domain="asset",
            access="read",
            risk="low",
            gate="paper_pdf",
        ),
        CapabilitySpec(
            name="inspect_paper_pdf_pages",
            description="Inspect selected pages from a managed local paper PDF, returning page text and rendered page images for visual figure/table/equation questions.",
            input_model=InspectPaperPdfPagesInput,
            handler=_inspect_paper_pdf_pages,
            domain="asset",
            access="read",
            risk="low",
            gate="paper_pdf",
        ),
    ]
