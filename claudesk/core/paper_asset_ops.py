from __future__ import annotations

import io
import sqlite3
from dataclasses import dataclass
from typing import BinaryIO
from urllib.parse import unquote, urlparse

import httpx

from claudesk.core.config import Config
from claudesk.core.db.assets import create_paper_asset
from claudesk.core.db.papers import get_paper
from claudesk.core.models import AssetKind, AssetParseStatus, PaperAsset
from claudesk.core.paper_assets import (
    CHUNK_SIZE,
    InvalidPaperAssetFile,
    delete_managed_asset_file,
    store_managed_pdf_asset,
)
from claudesk.core.public_http import stream_public_response

ATTACH_PDF_FROM_URL_MAX_BYTES = 50 * 1024 * 1024
URL_FETCH_TIMEOUT_SECONDS = 20
PDF_MAGIC = b"%PDF-"


@dataclass(frozen=True)
class DownloadedPdf:
    file_obj: BinaryIO
    filename: str | None
    mime_type: str


def attach_pdf_to_paper(
    conn: sqlite3.Connection,
    paper_id: int,
    *,
    file_obj: BinaryIO,
    filename: str | None,
    mime_type: str | None,
    source: str,
    cfg: Config | None = None,
) -> PaperAsset:
    paper = get_paper(conn, paper_id)
    if paper is None:
        raise ValueError(f"Paper {paper_id} not found.")

    effective_filename = filename
    if not (effective_filename or "").strip():
        title = (paper.title or "").replace("/", " ").replace("\\", " ").strip()
        effective_filename = f"{title or f'paper-{paper_id}'}.pdf"

    stored = store_managed_pdf_asset(
        paper_id=paper_id,
        paper_title=paper.title,
        file_obj=file_obj,
        filename=effective_filename,
        mime_type=mime_type,
        cfg=cfg,
    )
    try:
        return create_paper_asset(
            conn,
            paper_id,
            kind=AssetKind.PDF,
            source=source,
            managed_path=stored.managed_path,
            original_filename=stored.original_filename,
            display_name=stored.original_filename,
            mime_type=stored.mime_type,
            size_bytes=stored.size_bytes,
            content_hash=stored.content_hash,
            parse_status=AssetParseStatus.NOT_PARSED,
        )
    except Exception:
        delete_managed_asset_file(stored.managed_path, cfg=cfg)
        raise


def attach_pdf_from_url(
    conn: sqlite3.Connection,
    paper_id: int,
    url: str,
    *,
    cfg: Config | None = None,
    max_bytes: int | None = None,
) -> PaperAsset:
    downloaded = download_pdf_from_https_url(url, max_bytes=max_bytes)
    return attach_pdf_to_paper(
        conn,
        paper_id,
        file_obj=downloaded.file_obj,
        filename=downloaded.filename,
        mime_type=downloaded.mime_type,
        source="agent_url",
        cfg=cfg,
    )


def download_pdf_from_https_url(url: str, *, max_bytes: int | None = None) -> DownloadedPdf:
    cleaned_url = (url or "").strip()
    parsed = urlparse(cleaned_url)
    if parsed.scheme != "https" or not parsed.netloc:
        raise InvalidPaperAssetFile("PDF URL must be an https:// URL.")

    cap = max_bytes if max_bytes is not None else ATTACH_PDF_FROM_URL_MAX_BYTES
    if cap <= 0:
        raise InvalidPaperAssetFile("PDF download size limit must be positive.")

    try:
        with stream_public_response(
            cleaned_url,
            headers={"User-Agent": "Claudesk/agent-pdf-fetch"},
            timeout=URL_FETCH_TIMEOUT_SECONDS,
            https_only=True,
        ) as response:
            final_parsed = urlparse(str(response.url))
            status = response.status_code
            if status >= 400:
                raise InvalidPaperAssetFile(f"PDF download failed with HTTP {status}.")
            content_length = response.headers.get("Content-Length")
            if content_length:
                try:
                    declared_size = int(content_length)
                except ValueError:
                    declared_size = 0
                if declared_size > cap:
                    raise InvalidPaperAssetFile(f"PDF exceeds the {cap} byte size limit.")

            data = bytearray()
            for chunk in response.iter_bytes(chunk_size=min(CHUNK_SIZE, cap + 1)):
                if len(data) + len(chunk) > cap:
                    raise InvalidPaperAssetFile(f"PDF exceeds the {cap} byte size limit.")
                data.extend(chunk)
    except InvalidPaperAssetFile:
        raise
    except (httpx.HTTPError, httpx.InvalidURL, ValueError) as exc:
        raise InvalidPaperAssetFile(f"PDF download failed: {exc}") from exc

    content = bytes(data)
    if not content.startswith(PDF_MAGIC):
        raise InvalidPaperAssetFile("Downloaded content is not a PDF.")

    return DownloadedPdf(
        file_obj=io.BytesIO(content),
        filename=_filename_from_url(final_parsed.path) or _filename_from_url(parsed.path),
        mime_type="application/pdf",
    )


def _filename_from_url(path: str) -> str | None:
    filename = unquote(path.rsplit("/", 1)[-1] or "").strip()
    if not filename.casefold().endswith(".pdf"):
        return None
    return filename
