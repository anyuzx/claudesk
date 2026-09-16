from __future__ import annotations

import logging
from functools import lru_cache
from typing import TYPE_CHECKING

import numpy as np

logger = logging.getLogger(__name__)

MODEL_NAME = "all-MiniLM-L6-v2"

if TYPE_CHECKING:
    from sentence_transformers import SentenceTransformer


@lru_cache(maxsize=1)
def _get_model() -> "SentenceTransformer":
    from sentence_transformers import SentenceTransformer

    logger.info("Loading embedding model %s …", MODEL_NAME)
    return SentenceTransformer(MODEL_NAME)


def embed(texts: list[str]) -> np.ndarray:
    """Return unit-norm embeddings of shape (len(texts), 384).

    Embeddings are L2-normalised so cosine similarity == dot product,
    which is cheaper to compute for large batches.
    """
    if not texts:
        return np.empty((0, 384), dtype=np.float32)
    return _get_model().encode(
        texts,
        normalize_embeddings=True,
        show_progress_bar=False,
        batch_size=64,
    )
