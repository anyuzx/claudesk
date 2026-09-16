from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from claudesk.core.config import Config
from claudesk.core.pdf_ingest_cache import page_image_managed_path, resolve_asset_managed_path
from claudesk.core.pdf_ingest_models import RenderedPdfPage


def render_pdf_pages(
    *,
    asset_id: int,
    path: Path,
    page_texts: dict[int, str],
    render_dpi: int,
    chat_storage: bool,
    cfg: Config | None,
) -> tuple[Path, list[RenderedPdfPage]]:
    import fitz

    image_dir = resolve_asset_managed_path(
        f"derived/pdf-pages/{asset_id}",
        chat_storage=chat_storage,
        cfg=cfg,
    )
    image_dir.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(tempfile.mkdtemp(prefix=".render-", dir=str(image_dir)))
    pages: list[RenderedPdfPage] = []
    matrix = fitz.Matrix(render_dpi / 72, render_dpi / 72)
    try:
        with fitz.open(str(path)) as doc:
            for index, page in enumerate(doc, start=1):
                image_managed_path = page_image_managed_path(asset_id, index, render_dpi)
                temp_image_path = temp_dir / Path(image_managed_path).name
                pixmap = page.get_pixmap(matrix=matrix, alpha=False)
                pixmap.save(str(temp_image_path))
                rect = page.rect
                pages.append(
                    RenderedPdfPage(
                        page_number=index,
                        text=page_texts.get(index, ""),
                        page_width=float(rect.width),
                        page_height=float(rect.height),
                        image_managed_path=image_managed_path,
                        image_width=int(pixmap.width),
                        image_height=int(pixmap.height),
                        render_dpi=render_dpi,
                        temp_image_path=temp_image_path,
                    )
                )
        return temp_dir, pages
    except Exception:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise
