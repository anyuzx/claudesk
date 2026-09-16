from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from claudesk.core.models import AssetPdfPage, AssetTextChunk, PaperAsset


PARSER_NAME = "pymupdf"
NORMALIZED_SCHEMA_VERSION = "claudesk-normalized-v1"
PARSER_VERSION = NORMALIZED_SCHEMA_VERSION
DEFAULT_RENDER_DPI = 144
CHUNK_SIZE = 2000
CHUNK_OVERLAP = 200


class PdfIngestError(RuntimeError):
    """Raised when a managed PDF cannot be parsed into local cache artifacts."""


@dataclass(frozen=True)
class PdfIngestResult:
    asset: PaperAsset
    pages: list[AssetPdfPage]
    chunks: list[AssetTextChunk]
    cache_hit: bool


@dataclass(frozen=True)
class NormalizedPdfBlock:
    block_index: int
    page_number: int
    block_type: str
    section_path: tuple[str, ...]
    text: str
    bbox: tuple[float, float, float, float] | None = None
    metadata: dict[str, object] | None = None


@dataclass(frozen=True)
class NormalizedPdfDocument:
    page_texts: dict[int, str]
    blocks: list[NormalizedPdfBlock]


@dataclass(frozen=True)
class ParseArtifactContent:
    artifact_kind: str
    content: bytes
    mime_type: str
    extension: str


@dataclass(frozen=True)
class RenderedPdfPage:
    page_number: int
    text: str
    page_width: float
    page_height: float
    image_managed_path: str
    image_width: int
    image_height: int
    render_dpi: int
    temp_image_path: Path


@dataclass(frozen=True)
class NormalizedParseOutput:
    document: NormalizedPdfDocument
    artifacts: list[ParseArtifactContent]
