from __future__ import annotations

import logging
import inspect
from datetime import datetime
from typing import Callable, Optional

from claudesk.core.models import Paper
from claudesk.sources import get_enabled_sources
from claudesk.sources.base import Source

logger = logging.getLogger(__name__)

FetchProgressCallback = Callable[[dict[str, object]], None]


def _accepts_progress_callback(source: Source) -> bool:
    try:
        parameters = inspect.signature(source.fetch).parameters
    except (TypeError, ValueError):
        return False
    return "progress_cb" in parameters or any(
        parameter.kind == inspect.Parameter.VAR_KEYWORD
        for parameter in parameters.values()
    )


def fetch_all(
    since: datetime,
    sources: list[Source] | None = None,
    progress_cb: Optional[FetchProgressCallback] = None,
) -> list[Paper]:
    """Fetch papers from every enabled source since `since`.

    Pass `sources` to override the config-driven source list (used by the
    digest job's --source flag). Source failures are logged and skipped.
    """
    if sources is None:
        sources = get_enabled_sources()
    if not sources:
        logger.warning("No sources enabled — check interests.yaml")
        return []

    all_papers: list[Paper] = []
    for source in sources:
        try:
            if progress_cb is not None:
                progress_cb({"event": "source_start", "source": source.name})
            if progress_cb is not None and _accepts_progress_callback(source):
                def source_progress(event: dict[str, object]) -> None:
                    progress_cb({**event, "source": source.name})

                papers = source.fetch(since, progress_cb=source_progress)
            else:
                papers = source.fetch(since)
            logger.info("%s: fetched %d papers", source.name, len(papers))
            all_papers.extend(papers)
            if progress_cb is not None:
                progress_cb(
                    {"event": "source_done", "source": source.name, "count": len(papers)}
                )
        except Exception as exc:
            logger.error("%s: fetch failed — %s", source.name, exc)
            if progress_cb is not None:
                progress_cb(
                    {"event": "source_error", "source": source.name, "error": str(exc)}
                )

    return all_papers
