from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from claudesk.core.config import Config
from claudesk.core.pdf_ingest_models import (
    NORMALIZED_SCHEMA_VERSION,
    PARSER_NAME,
    PARSER_VERSION,
    NormalizedParseOutput,
    NormalizedPdfBlock,
    NormalizedPdfDocument,
    ParseArtifactContent,
    PdfIngestError,
)


_DOCLING_PAGE_PLACEHOLDER_RE = re.compile(r"<!--\s*image\s*-->", re.IGNORECASE)


def load_page_texts(path: Path) -> dict[int, str]:
    import fitz

    page_texts: dict[int, str] = {}
    with fitz.open(str(path)) as doc:
        for page_number, page in enumerate(doc, start=1):
            page_texts[page_number] = page.get_text("text") or ""
    return page_texts


def normalize_pymupdf_document(path: Path) -> NormalizedPdfDocument:
    page_texts = load_page_texts(path)
    blocks: list[NormalizedPdfBlock] = []
    for page_number in sorted(page_texts):
        text = page_texts[page_number]
        blocks.append(
            NormalizedPdfBlock(
                block_index=len(blocks),
                page_number=page_number,
                block_type="paragraph",
                section_path=(),
                text=text,
                metadata={"source": "pymupdf_page_text"},
            )
        )
    return NormalizedPdfDocument(page_texts=page_texts, blocks=blocks)


def pdf_page_numbers(path: Path) -> list[int]:
    import fitz

    with fitz.open(str(path)) as doc:
        return list(range(1, len(doc) + 1))


def _docling_version() -> str:
    try:
        return version("docling")
    except PackageNotFoundError:
        return "unknown"


def _pymupdf4llm_version() -> str:
    try:
        return version("pymupdf4llm")
    except PackageNotFoundError:
        return "unknown"


def _mineru_version() -> str:
    executable = shutil.which("mineru") or shutil.which("magic-pdf")
    if executable is None:
        return "unavailable"
    try:
        completed = subprocess.run(
            [executable, "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception:
        return "cli"
    output = (completed.stdout or completed.stderr or "").strip().splitlines()
    return output[0][:80] if output else "cli"


def parser_metadata(parser_name: str) -> tuple[str, str]:
    if parser_name == "pymupdf4llm":
        return "pymupdf4llm", f"{_pymupdf4llm_version()}:{NORMALIZED_SCHEMA_VERSION}"
    if parser_name == "docling":
        return "docling", f"{_docling_version()}:{NORMALIZED_SCHEMA_VERSION}"
    if parser_name == "mineru":
        return "mineru", f"{_mineru_version()}:{NORMALIZED_SCHEMA_VERSION}"
    return PARSER_NAME, PARSER_VERSION


def selected_pdf_parser(cfg: Config | None) -> str:
    parser = ((cfg.paper_assets.pdf_parser if cfg else "") or PARSER_NAME).strip().casefold()
    if parser in {"pymupdf", "pymupdf4llm", "docling", "mineru"}:
        return parser
    return PARSER_NAME


def selected_pdf_parser_metadata(cfg: Config | None) -> tuple[str, str]:
    return parser_metadata(selected_pdf_parser(cfg))


def json_artifact(artifact_kind: str, payload: object) -> ParseArtifactContent:
    return ParseArtifactContent(
        artifact_kind=artifact_kind,
        content=json.dumps(payload, ensure_ascii=False, indent=2, default=str).encode("utf-8"),
        mime_type="application/json",
        extension="json",
    )


def text_artifact(artifact_kind: str, text: str, *, extension: str = "md") -> ParseArtifactContent:
    return ParseArtifactContent(
        artifact_kind=artifact_kind,
        content=text.encode("utf-8"),
        mime_type="text/markdown" if extension == "md" else "text/plain",
        extension=extension,
    )


def normalized_document_payload(document: NormalizedPdfDocument) -> dict[str, object]:
    return {
        "schema_version": NORMALIZED_SCHEMA_VERSION,
        "page_texts": {str(page): text for page, text in sorted(document.page_texts.items())},
        "blocks": [
            {
                "block_index": block.block_index,
                "page_number": block.page_number,
                "block_type": block.block_type,
                "section_path": list(block.section_path),
                "text": block.text,
                "bbox": list(block.bbox) if block.bbox else None,
                "metadata": block.metadata or {},
            }
            for block in document.blocks
        ],
    }


def _docling_page_has_meaningful_text(page_markdown: str) -> bool:
    return bool(_DOCLING_PAGE_PLACEHOLDER_RE.sub("", page_markdown).strip())


def normalize_docling_document(path: Path) -> NormalizedParseOutput:
    try:
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.document_converter import DocumentConverter, PdfFormatOption
    except ImportError as exc:
        raise PdfIngestError(
            "Docling parser selected, but the optional docling package is not installed."
        ) from exc

    pipeline_options = PdfPipelineOptions(do_ocr=False)
    converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options),
        }
    )
    result = converter.convert(path)
    document = result.document
    fallback_texts = load_page_texts(path)
    page_texts: dict[int, str] = {}
    blocks: list[NormalizedPdfBlock] = []
    for page_number in pdf_page_numbers(path):
        try:
            page_markdown = document.export_to_markdown(page_no=page_number)
        except Exception:
            page_markdown = ""
        text = (
            page_markdown.strip()
            if _docling_page_has_meaningful_text(page_markdown)
            else fallback_texts.get(page_number, "")
        )
        page_texts[page_number] = text
        blocks.append(
            NormalizedPdfBlock(
                block_index=len(blocks),
                page_number=page_number,
                block_type="paragraph",
                section_path=(),
                text=text,
                metadata={"source": "docling_page_markdown"},
            )
        )

    artifacts = [
        json_artifact("parser_json", document.export_to_dict()),
        text_artifact("markdown", document.export_to_markdown()),
    ]
    return NormalizedParseOutput(
        document=NormalizedPdfDocument(page_texts=page_texts, blocks=blocks),
        artifacts=artifacts,
    )


def _pymupdf4llm_page_number(chunk: dict[str, object], fallback: int) -> int:
    metadata = chunk.get("metadata") if isinstance(chunk.get("metadata"), dict) else {}
    for container in (chunk, metadata):
        for key in ("page_number", "page"):
            value = container.get(key) if isinstance(container, dict) else None
            if isinstance(value, int) and value >= 1:
                return value
            if isinstance(value, str):
                try:
                    parsed = int(value)
                except ValueError:
                    continue
                if parsed >= 1:
                    return parsed
    return fallback


def _pymupdf4llm_bbox(value: object) -> tuple[float, float, float, float] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        x0, y0, x1, y1 = (float(item) for item in value)
        return x0, y0, x1, y1
    except (TypeError, ValueError):
        return None


def _pymupdf4llm_box_text(page_text: str, box: dict[str, object]) -> str:
    value = box.get("text")
    if isinstance(value, str) and value.strip():
        return value.strip()
    pos = box.get("pos")
    if not isinstance(pos, (list, tuple)) or len(pos) != 2:
        return ""
    try:
        start, stop = int(pos[0]), int(pos[1])
    except (TypeError, ValueError):
        return ""
    if start < 0 or stop <= start or start >= len(page_text):
        return ""
    return page_text[start:min(stop, len(page_text))].strip()


def _pymupdf4llm_markdown_text(markdown_output: object) -> str:
    if isinstance(markdown_output, str):
        return markdown_output.strip()
    if not isinstance(markdown_output, list):
        return str(markdown_output or "").strip()
    parts = []
    for chunk in markdown_output:
        if isinstance(chunk, dict):
            text = str(chunk.get("text") or "").strip()
        else:
            text = str(chunk or "").strip()
        if text:
            parts.append(text)
    return "\n\n".join(parts)


def _pymupdf4llm_json_artifact(parser_json: object) -> ParseArtifactContent | None:
    if parser_json is None:
        return None
    if isinstance(parser_json, bytes):
        content = parser_json
    elif isinstance(parser_json, str):
        content = parser_json.encode("utf-8")
    else:
        return json_artifact("parser_json", parser_json)
    if not content.strip():
        return None
    return ParseArtifactContent(
        artifact_kind="parser_json",
        content=content,
        mime_type="application/json",
        extension="json",
    )


def normalize_pymupdf4llm_document(path: Path) -> NormalizedParseOutput:
    try:
        import pymupdf4llm
    except ImportError as exc:
        raise PdfIngestError(
            "PyMuPDF4LLM parser selected, but the optional pymupdf4llm package is not installed."
        ) from exc

    markdown_output = pymupdf4llm.to_markdown(
        str(path),
        page_chunks=True,
        use_ocr=False,
        write_images=False,
        embed_images=False,
    )
    parser_json = None
    try:
        parser_json = pymupdf4llm.to_json(str(path), use_ocr=False)
    except Exception:
        parser_json = None

    fallback_texts = load_page_texts(path)
    page_numbers = pdf_page_numbers(path)
    page_texts = {page_number: fallback_texts.get(page_number, "") for page_number in page_numbers}
    blocks: list[NormalizedPdfBlock] = []

    if isinstance(markdown_output, list):
        chunks = markdown_output
    else:
        chunks = [{"metadata": {"page_number": 1}, "text": str(markdown_output or ""), "page_boxes": []}]

    for fallback_index, raw_chunk in enumerate(chunks, start=1):
        if not isinstance(raw_chunk, dict):
            continue
        page_number = _pymupdf4llm_page_number(raw_chunk, fallback_index)
        page_text = str(raw_chunk.get("text") or "").strip() or fallback_texts.get(page_number, "")
        page_texts[page_number] = page_text
        page_boxes = raw_chunk.get("page_boxes")
        box_blocks_added = 0
        if isinstance(page_boxes, list):
            for box in sorted(
                [item for item in page_boxes if isinstance(item, dict)],
                key=lambda item: item.get("index") if isinstance(item.get("index"), int) else 0,
            ):
                text = _pymupdf4llm_box_text(page_text, box)
                if not text:
                    continue
                block_type = str(box.get("class") or "paragraph").strip() or "paragraph"
                blocks.append(
                    NormalizedPdfBlock(
                        block_index=len(blocks),
                        page_number=page_number,
                        block_type=block_type,
                        section_path=(),
                        text=text,
                        bbox=_pymupdf4llm_bbox(box.get("bbox")),
                        metadata={
                            "source": "pymupdf4llm_page_box",
                            "box_index": box.get("index"),
                        },
                    )
                )
                box_blocks_added += 1
        if box_blocks_added == 0 and page_text:
            blocks.append(
                NormalizedPdfBlock(
                    block_index=len(blocks),
                    page_number=page_number,
                    block_type="paragraph",
                    section_path=(),
                    text=page_text,
                    metadata={"source": "pymupdf4llm_page_markdown"},
                )
            )

    for page_number, fallback_text in fallback_texts.items():
        if not page_texts.get(page_number):
            page_texts[page_number] = fallback_text
        if fallback_text and not any(block.page_number == page_number for block in blocks):
            blocks.append(
                NormalizedPdfBlock(
                    block_index=len(blocks),
                    page_number=page_number,
                    block_type="paragraph",
                    section_path=(),
                    text=fallback_text,
                    metadata={"source": "pymupdf_fallback_after_pymupdf4llm"},
                )
            )

    artifacts = [text_artifact("markdown", _pymupdf4llm_markdown_text(markdown_output))]
    parser_json_artifact = _pymupdf4llm_json_artifact(parser_json)
    if parser_json_artifact is not None:
        artifacts.append(parser_json_artifact)
    return NormalizedParseOutput(
        document=NormalizedPdfDocument(page_texts=page_texts, blocks=blocks),
        artifacts=artifacts,
    )


def _mineru_text_from_item(item: dict[str, object]) -> str:
    parts: list[str] = []
    for key in ("text", "content", "table_body", "latex", "caption"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            parts.append(value.strip())
        elif isinstance(value, list):
            parts.extend(str(part).strip() for part in value if str(part).strip())
    return "\n".join(parts).strip()


def _mineru_page_number(item: dict[str, object], fallback: int) -> int:
    for key in ("page_idx", "page_index"):
        value = item.get(key)
        if isinstance(value, int):
            return value + 1
    value = item.get("page_number") or item.get("page")
    if isinstance(value, int) and value >= 1:
        return value
    return fallback


def _run_mineru_command(path: Path, output_dir: Path) -> None:
    executable = shutil.which("mineru") or shutil.which("magic-pdf")
    if executable is None:
        raise PdfIngestError(
            "MinerU parser selected, but neither the mineru nor magic-pdf CLI is installed."
        )
    completed = subprocess.run(
        [executable, "-p", str(path), "-o", str(output_dir)],
        check=False,
        capture_output=True,
        text=True,
        timeout=900,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "MinerU command failed.").strip()
        raise PdfIngestError(f"MinerU parser failed: {detail[:1000]}")


def normalize_mineru_document(path: Path) -> NormalizedParseOutput:
    with tempfile.TemporaryDirectory(prefix="claudesk-mineru-") as tmpdir:
        output_dir = Path(tmpdir)
        _run_mineru_command(path, output_dir)
        content_list_path = next(output_dir.rglob("*content_list*.json"), None)
        markdown_path = next(output_dir.rglob("*.md"), None)
        middle_json_path = next(output_dir.rglob("*middle*.json"), None)

        artifacts: list[ParseArtifactContent] = []
        content_items: list[dict[str, object]] = []
        if content_list_path is not None:
            content_bytes = content_list_path.read_bytes()
            artifacts.append(
                ParseArtifactContent(
                    artifact_kind="mineru_content_list_json",
                    content=content_bytes,
                    mime_type="application/json",
                    extension="json",
                )
            )
            try:
                parsed = json.loads(content_bytes.decode("utf-8"))
                if isinstance(parsed, list):
                    content_items = [item for item in parsed if isinstance(item, dict)]
            except json.JSONDecodeError:
                content_items = []
        if middle_json_path is not None:
            artifacts.append(
                ParseArtifactContent(
                    artifact_kind="mineru_middle_json",
                    content=middle_json_path.read_bytes(),
                    mime_type="application/json",
                    extension="json",
                )
            )
        markdown_text = ""
        if markdown_path is not None:
            markdown_text = markdown_path.read_text(encoding="utf-8")
            artifacts.append(text_artifact("markdown", markdown_text))

        fallback_texts = load_page_texts(path)
        page_texts = {page_number: "" for page_number in pdf_page_numbers(path)}
        blocks: list[NormalizedPdfBlock] = []
        for item in content_items:
            text = _mineru_text_from_item(item)
            page_number = _mineru_page_number(item, 1)
            block_type = str(item.get("type") or item.get("category") or "paragraph")
            page_texts[page_number] = (page_texts.get(page_number, "") + "\n\n" + text).strip()
            blocks.append(
                NormalizedPdfBlock(
                    block_index=len(blocks),
                    page_number=page_number,
                    block_type=block_type,
                    section_path=(),
                    text=text,
                    metadata={"source": "mineru_content_list"},
                )
            )

        if not blocks:
            if markdown_text.strip():
                page_texts[1] = markdown_text
                blocks.append(
                    NormalizedPdfBlock(
                        block_index=0,
                        page_number=1,
                        block_type="paragraph",
                        section_path=(),
                        text=markdown_text,
                        metadata={"source": "mineru_markdown"},
                    )
                )
            else:
                for page_number in sorted(fallback_texts):
                    page_texts[page_number] = fallback_texts[page_number]
                    blocks.append(
                        NormalizedPdfBlock(
                            block_index=len(blocks),
                            page_number=page_number,
                            block_type="paragraph",
                            section_path=(),
                            text=fallback_texts[page_number],
                            metadata={"source": "pymupdf_fallback_after_mineru"},
                        )
                    )
        for page_number, fallback_text in fallback_texts.items():
            if not page_texts.get(page_number):
                page_texts[page_number] = fallback_text

        return NormalizedParseOutput(
            document=NormalizedPdfDocument(page_texts=page_texts, blocks=blocks),
            artifacts=artifacts,
        )


def normalize_pdf_document(path: Path, parser_name: str) -> NormalizedParseOutput:
    if parser_name == "pymupdf4llm":
        return normalize_pymupdf4llm_document(path)
    if parser_name == "docling":
        return normalize_docling_document(path)
    if parser_name == "mineru":
        return normalize_mineru_document(path)
    return NormalizedParseOutput(document=normalize_pymupdf_document(path), artifacts=[])
