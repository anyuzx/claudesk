from __future__ import annotations

from claudesk.core.config import load_config
from claudesk.sources import arxiv, biorxiv, openalex, pubmed
from claudesk.sources.base import Source


def get_enabled_sources() -> list[Source]:
    """Return the sources enabled in interests.yaml, in fetch order."""
    cfg = load_config()
    sources = []
    if cfg.sources.arxiv.enabled:
        sources.append(Source(name="arxiv", fetch=arxiv.fetch))
    if cfg.sources.biorxiv.enabled:
        sources.append(Source(name="biorxiv", fetch=biorxiv.fetch))
    if cfg.sources.pubmed.enabled:
        sources.append(Source(name="pubmed", fetch=pubmed.fetch))
    # Keep OpenAlex last so source-specific records win when title dedupe drops duplicates.
    if cfg.sources.openalex.enabled:
        sources.append(Source(name="openalex", fetch=openalex.fetch))
    return sources
