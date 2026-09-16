from __future__ import annotations

from claudesk.core.db.assets import (
    count_asset_document_blocks,
    count_asset_page_images,
    count_asset_parse_artifacts,
    count_asset_pdf_pages,
    count_asset_text_chunks,
)
from claudesk.core.paper_assets import asset_file_health


def build_paper_asset_payload(asset, *, cfg, conn):
    asset_id = asset.id or 0
    health = asset_file_health(asset.managed_path, cfg=cfg)
    return {
        **asset.model_dump(mode="json"),
        "file_status": health.status.value,
        "file_exists": health.file_exists,
        "page_count": count_asset_pdf_pages(conn, asset_id),
        "chunk_count": count_asset_text_chunks(conn, asset_id),
        "block_count": count_asset_document_blocks(conn, asset_id),
        "artifact_count": count_asset_parse_artifacts(conn, asset_id),
        "image_count": count_asset_page_images(conn, asset_id),
    }
