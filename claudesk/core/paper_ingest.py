from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from claudesk.core.doi import normalize_doi
from claudesk.core.db.papers import (
    get_paper,
    get_paper_by_doi,
    insert_feedback,
    update_paper_status,
    upsert_paper,
)
from claudesk.core.models import Paper, PaperSignal
from claudesk.sources.doi import (
    WARNING_NO_ABSTRACT,
    fetch_openalex_metadata_for_doi,
    resolve_doi_metadata_with_warnings,
)


@dataclass(frozen=True)
class PaperByDoiResult:
    paper: Paper
    status: str
    warnings: list[str]


def _final_doi_warnings(warnings: list[str], paper: Paper) -> list[str]:
    final = [warning for warning in warnings if warning != WARNING_NO_ABSTRACT]
    if not paper.abstract.strip():
        final.append(WARNING_NO_ABSTRACT)
    return list(dict.fromkeys(final))


def add_paper_by_doi(
    conn: sqlite3.Connection,
    doi_input: str,
    *,
    save: bool = False,
) -> PaperByDoiResult:
    doi = normalize_doi(doi_input)

    existing = get_paper_by_doi(conn, doi)
    if existing is not None:
        stored = existing
        warnings: list[str] = []
        if not existing.abstract.strip():
            enrichment = fetch_openalex_metadata_for_doi(doi)
            warnings.extend(enrichment.warnings)
            if enrichment.paper is not None:
                incoming = enrichment.paper.model_copy(update={"external_id": existing.external_id})
                paper_id = upsert_paper(conn, incoming)
                stored = get_paper(conn, paper_id)
                if stored is None:
                    raise RuntimeError("Existing paper could not be loaded.")
        return PaperByDoiResult(
            paper=stored,
            status="existing",
            warnings=_final_doi_warnings(warnings, stored),
        )

    before_ids = {
        int(row["id"])
        for row in conn.execute("SELECT id FROM papers").fetchall()
    }
    resolution = resolve_doi_metadata_with_warnings(doi)
    paper_id = upsert_paper(conn, resolution.paper)
    created = paper_id not in before_ids
    status = "created" if created else "duplicate"
    if created and save:
        update_paper_status(conn, paper_id, PaperSignal.SAVED)
        insert_feedback(conn, paper_id, PaperSignal.SAVED.value)

    stored = get_paper(conn, paper_id)
    if stored is None:
        raise RuntimeError("Added paper could not be loaded.")
    return PaperByDoiResult(
        paper=stored,
        status=status,
        warnings=_final_doi_warnings(list(resolution.warnings), stored),
    )
