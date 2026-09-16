from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Sequence

from claudesk.core.config import Config
from claudesk.core.db.assets import (
    count_asset_document_blocks,
    count_asset_page_images,
    count_asset_parse_artifacts,
    count_asset_pdf_pages,
    count_asset_text_chunks,
    get_paper_asset,
    list_asset_document_blocks,
    list_asset_pdf_pages,
    list_asset_text_chunks,
    list_paper_assets as db_list_paper_assets,
)
from claudesk.core.db.papers import get_paper
from claudesk.core.models import (
    AssetDocumentBlock,
    AssetKind,
    AssetPdfPage,
    AssetTextChunk,
    ChatResourceReadInput,
    PaperAsset,
    resource_read,
)
from claudesk.core.paper_assets import resolve_managed_asset_path
from claudesk.core.retrieval import search_pdf_chunks
from claudesk.core.retrieval.models import RetrievalBackend


@dataclass(frozen=True)
class PdfImageAttachment:
    label: str
    mime_type: str
    managed_path: str
    asset_id: int
    page_number: int
    width: int = 0
    height: int = 0
    temporary: bool = False

    def metadata(self) -> dict:
        return {
            "label": self.label,
            "mime_type": self.mime_type,
            "asset_id": self.asset_id,
            "page_number": self.page_number,
            "width": self.width,
            "height": self.height,
        }


@dataclass(frozen=True)
class PdfContextResult:
    payload: dict
    images: tuple[PdfImageAttachment, ...] = ()
    resource_reads: tuple[ChatResourceReadInput, ...] = ()


def asset_file_exists(managed_path: str | None, *, cfg: Config | None) -> bool:
    if not managed_path:
        return False
    try:
        return resolve_managed_asset_path(managed_path, cfg=cfg).exists()
    except Exception:
        return False


def asset_summary(conn: sqlite3.Connection, asset: PaperAsset, *, cfg: Config | None) -> dict:
    asset_id = asset.id or 0
    return {
        "id": asset.id,
        "kind": asset.kind.value,
        "display_name": asset.display_name,
        "original_filename": asset.original_filename,
        "mime_type": asset.mime_type,
        "size_bytes": asset.size_bytes,
        "parse_status": asset.parse_status.value,
        "parser_name": asset.parser_name,
        "parser_version": asset.parser_version,
        "parse_error": asset.parse_error,
        "parsed_at": asset.parsed_at.isoformat() if asset.parsed_at else None,
        "page_count": count_asset_pdf_pages(conn, asset_id),
        "chunk_count": count_asset_text_chunks(conn, asset_id),
        "block_count": count_asset_document_blocks(conn, asset_id),
        "artifact_count": count_asset_parse_artifacts(conn, asset_id),
        "image_count": count_asset_page_images(conn, asset_id),
        "file_exists": asset_file_exists(asset.managed_path, cfg=cfg),
        "created_at": asset.created_at.isoformat(),
        "updated_at": asset.updated_at.isoformat(),
    }


def paper_pdf_assets(conn: sqlite3.Connection, paper_id: int) -> list[PaperAsset]:
    return [
        asset
        for asset in db_list_paper_assets(conn, paper_id)
        if asset.kind == AssetKind.PDF
    ]


def select_paper_pdf_asset(
    conn: sqlite3.Connection,
    *,
    paper_id: int,
    asset_id: int | None,
    cfg: Config | None,
) -> tuple[PaperAsset | None, dict | None]:
    paper = get_paper(conn, paper_id)
    if paper is None:
        return None, {"ok": False, "error": f"Paper {paper_id} not found."}
    if asset_id is not None:
        asset = get_paper_asset(conn, paper_id, asset_id)
        if asset is None:
            return None, {"ok": False, "error": f"Paper asset {asset_id} not found for paper {paper_id}."}
        if asset.kind != AssetKind.PDF:
            return None, {"ok": False, "error": f"Asset {asset_id} is not a PDF."}
        return asset, None

    pdf_assets = paper_pdf_assets(conn, paper_id)
    if not pdf_assets:
        return None, {"ok": False, "error": f"Paper {paper_id} has no attached PDF assets."}
    if len(pdf_assets) > 1:
        return None, {
            "ok": False,
            "error": "multiple_pdf_assets",
            "message": "Multiple PDF assets are attached. Ask the user which asset_id to read.",
            "assets": [asset_summary(conn, asset, cfg=cfg) for asset in pdf_assets],
        }
    return pdf_assets[0], None


def limit_chunks_by_chars(
    chunks: Sequence[AssetTextChunk],
    max_chars: int,
) -> list[AssetTextChunk]:
    selected: list[AssetTextChunk] = []
    total = 0
    for chunk in chunks:
        next_total = total + len(chunk.text)
        if selected and next_total > max_chars:
            break
        selected.append(chunk)
        total = next_total
        if total >= max_chars:
            break
    return selected


def chunk_payload(chunk: AssetTextChunk) -> dict:
    return {
        "chunk_id": chunk.id,
        "asset_id": chunk.asset_id,
        "chunk_index": chunk.chunk_index,
        "page_number": chunk.page_number,
        "block_type": chunk.block_type,
        "section_path": chunk.section_path,
        "bbox": chunk.bbox,
        "block_ids": chunk.block_ids,
        "char_count": chunk.char_count,
        "source": "parsed_full_text",
        "text": chunk.text,
    }


def block_payload(block: AssetDocumentBlock, *, include_text: bool = True) -> dict:
    return {
        "block_id": block.id,
        "asset_id": block.asset_id,
        "block_index": block.block_index,
        "page_number": block.page_number,
        "block_type": block.block_type,
        "section_path": block.section_path,
        "bbox": block.bbox,
        "image_label": f"PDF page {block.page_number} image region" if block.image_managed_path else None,
        "metadata": block.metadata,
        "source": "parsed_full_text",
        "text": block.text if include_text else None,
    }


def page_payload(page: AssetPdfPage, *, include_text: bool) -> dict:
    return {
        "page_number": page.page_number,
        "text": page.text if include_text else None,
        "page_width": page.page_width,
        "page_height": page.page_height,
        "image_label": f"PDF page {page.page_number}" if page.image_managed_path else None,
        "image_width": page.image_width,
        "image_height": page.image_height,
        "render_dpi": page.render_dpi,
    }


def image_attachments_for_pages(
    pages: Sequence[AssetPdfPage],
    *,
    asset_id: int,
    limit: int = 3,
) -> tuple[PdfImageAttachment, ...]:
    images: list[PdfImageAttachment] = []
    seen: set[int] = set()
    for page in pages:
        if page.page_number in seen or not page.image_managed_path:
            continue
        seen.add(page.page_number)
        images.append(
            PdfImageAttachment(
                label=f"PDF asset {asset_id} page {page.page_number}",
                mime_type="image/png",
                managed_path=page.image_managed_path,
                asset_id=asset_id,
                page_number=page.page_number,
                width=page.image_width,
                height=page.image_height,
            )
        )
        if len(images) >= limit:
            break
    return tuple(images)


def asset_resource_read(paper_id: int, asset: PaperAsset) -> ChatResourceReadInput:
    return resource_read(
        "asset",
        asset.id,
        label=asset.display_name,
        summary="Managed paper asset returned.",
        locator={
            "paper_id": paper_id,
            "asset_id": asset.id,
            "asset_kind": asset.kind.value,
        },
    )


def base_resource_reads(
    conn: sqlite3.Connection,
    paper_id: int,
    asset: PaperAsset,
) -> list[ChatResourceReadInput]:
    paper = get_paper(conn, paper_id)
    paper_label = paper.title if paper is not None else f"Paper {paper_id}"
    return [
        resource_read(
            "paper",
            paper_id,
            label=paper_label,
            summary="Paper PDF capability context returned.",
            locator={"paper_id": paper_id},
        ),
        asset_resource_read(paper_id, asset),
    ]


def section_resource_read(
    paper_id: int,
    asset_id: int,
    section_path: list[str],
    *,
    first_page: int | None = None,
    block_count: int | None = None,
) -> ChatResourceReadInput:
    locator = {
        "paper_id": paper_id,
        "asset_id": asset_id,
        "section_path": section_path,
    }
    if first_page is not None:
        locator["first_page"] = first_page
    if block_count is not None:
        locator["block_count"] = block_count
    return resource_read(
        "pdf_section",
        f"{asset_id}:{' > '.join(section_path)}",
        label=" > ".join(section_path),
        summary="PDF section evidence returned.",
        locator=locator,
    )


def chunk_resource_read(paper_id: int, chunk: AssetTextChunk) -> ChatResourceReadInput:
    return resource_read(
        "pdf_chunk",
        chunk.id,
        label=f"PDF chunk {chunk.chunk_index}",
        summary="PDF text chunk evidence returned.",
        locator={
            "paper_id": paper_id,
            "asset_id": chunk.asset_id,
            "chunk_id": chunk.id,
            "chunk_index": chunk.chunk_index,
            "page_number": chunk.page_number,
            "section_path": chunk.section_path,
            "block_ids": chunk.block_ids,
        },
    )


def page_resource_read(paper_id: int, asset_id: int, page_number: int) -> ChatResourceReadInput:
    return resource_read(
        "pdf_page",
        f"{asset_id}:{page_number}",
        label=f"PDF page {page_number}",
        summary="PDF page evidence returned.",
        locator={
            "paper_id": paper_id,
            "asset_id": asset_id,
            "page_number": page_number,
        },
    )


def image_page_resource_reads(
    paper_id: int,
    images: Sequence[PdfImageAttachment],
) -> list[ChatResourceReadInput]:
    return [
        page_resource_read(paper_id, image.asset_id, image.page_number)
        for image in images
    ]


def build_paper_structure_context(
    conn: sqlite3.Connection,
    *,
    paper_id: int,
    asset: PaperAsset,
    cache_hit: bool,
    cfg: Config | None,
) -> PdfContextResult:
    asset_id = asset.id or 0
    blocks = list_asset_document_blocks(conn, asset_id)
    sections: dict[str, dict[str, object]] = {}
    block_type_counts: dict[str, int] = {}
    figures = []
    tables = []
    for block in blocks:
        block_type_counts[block.block_type] = block_type_counts.get(block.block_type, 0) + 1
        if block.section_path:
            key = " > ".join(block.section_path)
            current = sections.setdefault(
                key,
                {
                    "section_path": block.section_path,
                    "first_page": block.page_number,
                    "block_count": 0,
                },
            )
            current["block_count"] = int(current["block_count"]) + 1
        if block.block_type in {"figure", "picture", "image"}:
            figures.append(block_payload(block, include_text=False))
        elif block.block_type in {"table"}:
            tables.append(block_payload(block, include_text=False))

    section_reads = [
        section_resource_read(
            paper_id,
            asset_id,
            item["section_path"],
            first_page=item["first_page"],
            block_count=item["block_count"],
        )
        for item in sections.values()
    ]
    payload = {
        "ok": True,
        "paper_id": paper_id,
        "asset": asset_summary(conn, asset, cfg=cfg),
        "access_mode": "parsed_pdf_structure",
        "cache_hit": cache_hit,
        "block_count": len(blocks),
        "block_type_counts": block_type_counts,
        "sections": list(sections.values()),
        "tables": tables[:20],
        "figures": figures[:20],
    }
    return PdfContextResult(
        payload=payload,
        resource_reads=tuple(base_resource_reads(conn, paper_id, asset) + section_reads),
    )


def retrieve_paper_context(
    conn: sqlite3.Connection,
    *,
    paper_id: int,
    asset: PaperAsset,
    query: str,
    limit: int,
    max_chars: int,
    cache_hit: bool,
    cfg: Config | None,
    backends: tuple[RetrievalBackend, ...] = (RetrievalBackend.LEXICAL,),
) -> PdfContextResult:
    asset_id = asset.id or 0
    retrieval = search_pdf_chunks(
        conn,
        query,
        paper_id=paper_id,
        asset_id=asset_id,
        limit=limit,
        backends=backends,
    )
    chunks = limit_chunks_by_chars(
        [hit.payload for hit in retrieval.hits],
        max_chars,
    )
    payload = {
        "ok": True,
        "paper_id": paper_id,
        "asset": asset_summary(conn, asset, cfg=cfg),
        "access_mode": "parsed_pdf_retrieval",
        "cache_hit": cache_hit,
        "query": query,
        "evidence": [chunk_payload(chunk) for chunk in chunks],
    }
    if not chunks:
        payload["warning"] = "no_matching_chunks"
        payload["next_step"] = {
            "tool": "read_paper_pdf",
            "paper_id": paper_id,
            "asset_id": asset_id,
            "start_chunk": 0,
            "limit": 12,
        }
    reads = base_resource_reads(conn, paper_id, asset)
    reads.extend(chunk_resource_read(paper_id, chunk) for chunk in chunks)
    return PdfContextResult(payload=payload, resource_reads=tuple(reads))


def read_paper_section_context(
    conn: sqlite3.Connection,
    *,
    paper_id: int,
    asset: PaperAsset,
    section_path: list[str],
    limit: int,
    max_chars: int,
    cache_hit: bool,
    cfg: Config | None,
) -> PdfContextResult:
    asset_id = asset.id or 0
    selected: list[AssetDocumentBlock] = []
    total_chars = 0
    for block in list_asset_document_blocks(conn, asset_id):
        if block.section_path[: len(section_path)] != section_path:
            continue
        next_total = total_chars + len(block.text)
        if selected and next_total > max_chars:
            break
        selected.append(block)
        total_chars = next_total
        if len(selected) >= limit or total_chars >= max_chars:
            break

    reads = base_resource_reads(conn, paper_id, asset)
    reads.append(section_resource_read(paper_id, asset_id, section_path, block_count=len(selected)))
    return PdfContextResult(
        payload={
            "ok": True,
            "paper_id": paper_id,
            "asset": asset_summary(conn, asset, cfg=cfg),
            "access_mode": "parsed_pdf_section",
            "cache_hit": cache_hit,
            "section_path": section_path,
            "blocks": [block_payload(block) for block in selected],
        },
        resource_reads=tuple(reads),
    )


def read_paper_pdf_chunks_context(
    conn: sqlite3.Connection,
    *,
    paper_id: int,
    asset: PaperAsset,
    start_chunk: int,
    limit: int,
    max_chars: int,
    include_page_images: bool,
    cache_hit: bool,
    cfg: Config | None,
) -> PdfContextResult:
    asset_id = asset.id or 0
    chunks = limit_chunks_by_chars(
        list_asset_text_chunks(conn, asset_id, start_chunk=start_chunk, limit=limit),
        max_chars,
    )
    total_chunks = count_asset_text_chunks(conn, asset_id)
    next_chunk_index = None
    if chunks and chunks[-1].chunk_index + 1 < total_chunks:
        next_chunk_index = chunks[-1].chunk_index + 1
    page_numbers = {chunk.page_number for chunk in chunks}
    pages = [page for page in list_asset_pdf_pages(conn, asset_id) if page.page_number in page_numbers]
    images = image_attachments_for_pages(
        pages,
        asset_id=asset_id,
    ) if include_page_images else ()
    payload = {
        "ok": True,
        "paper_id": paper_id,
        "asset": asset_summary(conn, asset, cfg=cfg),
        "access_mode": "cached_pdf_chunks",
        "cache_hit": cache_hit,
        "chunks": [chunk_payload(chunk) for chunk in chunks],
        "next_chunk_index": next_chunk_index,
        "attached_images": [image.metadata() for image in images],
    }
    if next_chunk_index is not None:
        payload["next_step"] = {
            "tool": "read_paper_pdf",
            "paper_id": paper_id,
            "asset_id": asset_id,
            "start_chunk": next_chunk_index,
            "limit": limit,
            "optional": True,
            "use_when": "Use only when the current chunks are insufficient for the requested answer; broad summaries should usually synthesize before exhausting every chunk.",
        }
    reads = base_resource_reads(conn, paper_id, asset)
    reads.extend(chunk_resource_read(paper_id, chunk) for chunk in chunks)
    reads.extend(image_page_resource_reads(paper_id, images))
    return PdfContextResult(payload=payload, images=images, resource_reads=tuple(reads))


def search_paper_pdf_context(
    conn: sqlite3.Connection,
    *,
    paper_id: int,
    asset: PaperAsset,
    query: str,
    limit: int,
    max_chars: int,
    include_page_images: bool,
    cache_hit: bool,
    cfg: Config | None,
    backends: tuple[RetrievalBackend, ...] = (RetrievalBackend.LEXICAL,),
) -> PdfContextResult:
    asset_id = asset.id or 0
    retrieval = search_pdf_chunks(
        conn,
        query,
        paper_id=paper_id,
        asset_id=asset_id,
        limit=limit,
        backends=backends,
    )
    chunks = limit_chunks_by_chars(
        [hit.payload for hit in retrieval.hits],
        max_chars,
    )
    page_numbers = {chunk.page_number for chunk in chunks}
    pages = [page for page in list_asset_pdf_pages(conn, asset_id) if page.page_number in page_numbers]
    images = image_attachments_for_pages(
        pages,
        asset_id=asset_id,
    ) if include_page_images else ()
    reads = base_resource_reads(conn, paper_id, asset)
    reads.extend(chunk_resource_read(paper_id, chunk) for chunk in chunks)
    reads.extend(image_page_resource_reads(paper_id, images))
    return PdfContextResult(
        payload={
            "ok": True,
            "paper_id": paper_id,
            "asset": asset_summary(conn, asset, cfg=cfg),
            "access_mode": "cached_pdf_search",
            "cache_hit": cache_hit,
            "query": query,
            "matches": [chunk_payload(chunk) for chunk in chunks],
            "attached_images": [image.metadata() for image in images],
        },
        images=images,
        resource_reads=tuple(reads),
    )


def inspect_paper_pdf_pages_context(
    conn: sqlite3.Connection,
    *,
    paper_id: int,
    asset: PaperAsset,
    page_numbers: list[int],
    include_text: bool,
    include_images: bool,
    cache_hit: bool,
    cfg: Config | None,
) -> PdfContextResult:
    asset_id = asset.id or 0
    available_pages = {page.page_number: page for page in list_asset_pdf_pages(conn, asset_id)}
    pages = [available_pages[page_number] for page_number in page_numbers if page_number in available_pages]
    missing_pages = [page_number for page_number in page_numbers if page_number not in available_pages]
    images = image_attachments_for_pages(
        pages,
        asset_id=asset_id,
    ) if include_images else ()
    reads = base_resource_reads(conn, paper_id, asset)
    reads.extend(page_resource_read(paper_id, asset_id, page.page_number) for page in pages)
    return PdfContextResult(
        payload={
            "ok": True,
            "paper_id": paper_id,
            "asset": asset_summary(conn, asset, cfg=cfg),
            "access_mode": "cached_pdf_pages",
            "cache_hit": cache_hit,
            "pages": [page_payload(page, include_text=include_text) for page in pages],
            "missing_pages": missing_pages,
            "attached_images": [image.metadata() for image in images],
        },
        images=images,
        resource_reads=tuple(reads),
    )
