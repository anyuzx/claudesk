from __future__ import annotations

import importlib
from typing import TYPE_CHECKING, Any

from .models import (
    RetrievalBackend,
    RetrievalEvidenceLocator,
    RetrievalFieldScore,
    RetrievalHit,
    RetrievalQuery,
    RetrievalRequest,
    RetrievalResults,
    RetrievalScope,
    RetrievalScoreMetadata,
    RetrievalSnippet,
    RetrievalSourceType,
    retrieval_backends_from_mode,
)
from .service import GLOBAL_SEARCH_SOURCE_TYPES, fuse_hits, retrieve, search, search_pdf_chunks

if TYPE_CHECKING:
    from .vector import (
        EMBEDDING_DIMENSION,
        EMBEDDING_MODEL_VERSION,
        TABLE_NAME,
        SemanticIndexStatus,
        SemanticIndexUnavailable,
        SemanticSearchHit,
        collect_semantic_documents,
        rebuild_semantic_index,
        search_semantic_index,
        semantic_index_path,
        semantic_index_status,
        update_semantic_index,
    )

_VECTOR_EXPORTS = {
    "EMBEDDING_DIMENSION",
    "EMBEDDING_MODEL_VERSION",
    "TABLE_NAME",
    "SemanticIndexStatus",
    "SemanticIndexUnavailable",
    "SemanticSearchHit",
    "collect_semantic_documents",
    "rebuild_semantic_index",
    "search_semantic_index",
    "semantic_index_path",
    "semantic_index_status",
    "update_semantic_index",
}


def __getattr__(name: str) -> Any:
    if name not in _VECTOR_EXPORTS:
        raise AttributeError(name)
    vector = importlib.import_module(f"{__name__}.vector")
    return getattr(vector, name)

__all__ = [
    "GLOBAL_SEARCH_SOURCE_TYPES",
    "EMBEDDING_DIMENSION",
    "EMBEDDING_MODEL_VERSION",
    "RetrievalBackend",
    "RetrievalEvidenceLocator",
    "RetrievalFieldScore",
    "RetrievalHit",
    "RetrievalQuery",
    "RetrievalRequest",
    "RetrievalResults",
    "RetrievalScope",
    "RetrievalScoreMetadata",
    "RetrievalSnippet",
    "RetrievalSourceType",
    "SemanticIndexStatus",
    "SemanticIndexUnavailable",
    "SemanticSearchHit",
    "TABLE_NAME",
    "collect_semantic_documents",
    "fuse_hits",
    "rebuild_semantic_index",
    "retrieve",
    "retrieval_backends_from_mode",
    "search",
    "search_pdf_chunks",
    "search_semantic_index",
    "semantic_index_path",
    "semantic_index_status",
    "update_semantic_index",
]
