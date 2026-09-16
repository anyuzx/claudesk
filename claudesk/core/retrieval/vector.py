from __future__ import annotations

import hashlib
import json
import math
import sqlite3
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from claudesk.core.config import retrieval_index_root
from claudesk.core.db.assets import get_asset, list_asset_text_chunks
from claudesk.core.db.notes import list_notes
from claudesk.core.db.papers import list_papers
from claudesk.core.db.projects import list_projects
from claudesk.core.db.tasks import format_log_entry_display_text, list_log_entries, list_todos
from claudesk.core.embeddings import MODEL_NAME, embed
from claudesk.core.models import AssetKind, AssetTextChunk, LogEntry, Note, Paper, Project, Todo

from .models import RetrievalSourceType

TABLE_NAME = "retrieval_documents"
EMBEDDING_DIMENSION = 384
EMBEDDING_MODEL_VERSION = f"{MODEL_NAME}:normalized-{EMBEDDING_DIMENSION}:v1"

Embedder = Callable[[list[str]], np.ndarray]


class SemanticIndexUnavailable(RuntimeError):
    """Raised when the local semantic index dependency or table is unavailable."""


@dataclass(frozen=True)
class SemanticDocument:
    row_id: str
    source_type: RetrievalSourceType
    source_id: str
    title: str
    text: str
    locator: dict[str, Any]
    updated_at: str
    content_hash: str


@dataclass(frozen=True)
class SemanticIndexStatus:
    index_path: Path
    table_name: str
    source_count: int
    indexed_count: int
    missing_count: int
    stale_count: int
    incompatible_count: int

    @property
    def fresh(self) -> bool:
        return self.missing_count == 0 and self.stale_count == 0 and self.incompatible_count == 0


@dataclass(frozen=True)
class SemanticSearchHit:
    document: SemanticDocument
    distance: float | None = None
    score: float = 0.0


def semantic_index_path() -> Path:
    return retrieval_index_root() / "lancedb"


def rebuild_semantic_index(
    conn: sqlite3.Connection,
    *,
    index_path: Path | None = None,
    embedder: Embedder = embed,
) -> SemanticIndexStatus:
    documents = collect_semantic_documents(conn)
    path = index_path or semantic_index_path()
    db = _connect(path)
    if not documents:
        _drop_table_if_exists(db, TABLE_NAME)
        return SemanticIndexStatus(
            index_path=path,
            table_name=TABLE_NAME,
            source_count=0,
            indexed_count=0,
            missing_count=0,
            stale_count=0,
            incompatible_count=0,
        )

    vectors = _embed_texts([document.text for document in documents], embedder=embedder)
    rows = [
        _document_row(document, vector)
        for document, vector in zip(documents, vectors, strict=True)
    ]
    db.create_table(TABLE_NAME, data=rows, mode="overwrite")
    return semantic_index_status(conn, index_path=path)


def update_semantic_index(
    conn: sqlite3.Connection,
    *,
    index_path: Path | None = None,
    embedder: Embedder = embed,
) -> SemanticIndexStatus:
    """Update semantic rows.

    The current implementation intentionally falls back to a full rebuild so
    missing, stale, and deleted SQLite rows all converge to the same derived
    LanceDB state.
    """
    return rebuild_semantic_index(conn, index_path=index_path, embedder=embedder)


def semantic_index_status(
    conn: sqlite3.Connection,
    *,
    index_path: Path | None = None,
) -> SemanticIndexStatus:
    path = index_path or semantic_index_path()
    documents = collect_semantic_documents(conn)
    expected = {document.row_id: document for document in documents}
    rows = _read_index_rows(path)
    indexed_count = len(rows)
    if not expected:
        return SemanticIndexStatus(
            index_path=path,
            table_name=TABLE_NAME,
            source_count=0,
            indexed_count=indexed_count,
            missing_count=0,
            stale_count=indexed_count,
            incompatible_count=0,
        )

    indexed_by_id = {
        str(row.get("row_id") or ""): row
        for row in rows
        if row.get("row_id")
    }
    missing = 0
    stale = 0
    incompatible = 0
    for row_id, document in expected.items():
        row = indexed_by_id.get(row_id)
        if row is None:
            missing += 1
            continue
        if row.get("embedding_model_name") != MODEL_NAME:
            incompatible += 1
        elif int(row.get("embedding_dimension") or 0) != EMBEDDING_DIMENSION:
            incompatible += 1
        elif row.get("embedding_model_version") != EMBEDDING_MODEL_VERSION:
            incompatible += 1
        elif row.get("content_hash") != document.content_hash:
            stale += 1

    stale += sum(1 for row_id in indexed_by_id if row_id not in expected)
    return SemanticIndexStatus(
        index_path=path,
        table_name=TABLE_NAME,
        source_count=len(documents),
        indexed_count=indexed_count,
        missing_count=missing,
        stale_count=stale,
        incompatible_count=incompatible,
    )


def search_semantic_index(
    conn: sqlite3.Connection,
    query: str,
    *,
    index_path: Path | None = None,
    limit: int = 10,
    source_types: Sequence[RetrievalSourceType] | None = None,
    embedder: Embedder = embed,
) -> list[SemanticSearchHit]:
    if not query.strip():
        return []
    path = index_path or semantic_index_path()
    table = _open_table(path)
    query_vector = _embed_texts([query], embedder=embedder)[0]
    search = table.search(query_vector.tolist())
    source_filter = _source_type_filter(source_types)
    if source_filter:
        search = search.where(source_filter, prefilter=True)
    result = search.limit(max(1, limit)).to_list()
    allowed_sources = set(source_types or ())
    hits: list[SemanticSearchHit] = []
    for row in result:
        document = _document_from_row(row)
        if allowed_sources and document.source_type not in allowed_sources:
            continue
        hits.append(
            SemanticSearchHit(
                document=document,
                distance=_optional_float(row.get("_distance")),
                score=_distance_to_score(row.get("_distance")),
            )
        )
        if len(hits) >= limit:
            break
    return hits


def _source_type_filter(source_types: Sequence[RetrievalSourceType] | None) -> str | None:
    values = sorted({source_type.value for source_type in source_types or ()})
    if not values:
        return None
    quoted = [_quote_filter_value(value) for value in values]
    if len(quoted) == 1:
        return f"source_type = {quoted[0]}"
    return f"source_type IN ({', '.join(quoted)})"


def _quote_filter_value(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def collect_semantic_documents(conn: sqlite3.Connection) -> list[SemanticDocument]:
    documents: list[SemanticDocument] = []
    documents.extend(_paper_documents(conn))
    documents.extend(_note_documents(conn))
    documents.extend(_project_documents(conn))
    documents.extend(_task_documents(conn))
    documents.extend(_log_documents(conn))
    documents.extend(_pdf_chunk_documents(conn))
    return documents


def _paper_documents(conn: sqlite3.Connection) -> list[SemanticDocument]:
    documents: list[SemanticDocument] = []
    for paper in list_papers(conn, include_dismissed=True, limit=None):
        if paper.id is None:
            continue
        text = "\n\n".join([
            paper.title,
            ", ".join(paper.authors),
            paper.abstract,
        ]).strip()
        if not text:
            continue
        documents.append(_document(
            source_type=RetrievalSourceType.PAPER,
            source_id=paper.id,
            title=paper.title,
            text=text,
            locator={"paper_id": paper.id},
            updated_at=paper.fetched_at.isoformat(),
        ))
    return documents


def _note_documents(conn: sqlite3.Connection) -> list[SemanticDocument]:
    documents: list[SemanticDocument] = []
    offset = 0
    while True:
        notes = list_notes(conn, limit=500, offset=offset)
        if not notes:
            break
        for note in notes:
            if note.id is not None:
                documents.append(_note_document(note))
        offset += len(notes)
    return documents


def _note_document(note: Note) -> SemanticDocument:
    assert note.id is not None
    return _document(
        source_type=RetrievalSourceType.NOTE,
        source_id=note.id,
        title=note.title,
        text="\n\n".join([note.title, note.search_body or note.body]).strip(),
        locator={"note_id": note.id},
        updated_at=note.updated_at.isoformat(),
    )


def _project_documents(conn: sqlite3.Connection) -> list[SemanticDocument]:
    documents: list[SemanticDocument] = []
    for project in list_projects(conn, include_done=True):
        if project.id is not None:
            documents.append(_project_document(project))
    return documents


def _project_document(project: Project) -> SemanticDocument:
    assert project.id is not None
    text = "\n\n".join([
        project.name,
        project.status.value,
        " ".join(project.tags),
        project.description or "",
        project.obsidian_note_path or "",
    ]).strip()
    return _document(
        source_type=RetrievalSourceType.PROJECT,
        source_id=project.id,
        title=project.name,
        text=text,
        locator={"project_id": project.id},
        updated_at=project.updated_at.isoformat(),
    )


def _task_documents(conn: sqlite3.Connection) -> list[SemanticDocument]:
    documents: list[SemanticDocument] = []
    for task in list_todos(conn):
        if task.id is not None:
            documents.append(_task_document(task))
    return documents


def _task_document(task: Todo) -> SemanticDocument:
    assert task.id is not None
    text = "\n\n".join([
        task.title,
        task.description,
        task.status.value,
        task.priority.value,
    ]).strip()
    updated_at = task.updated_at or task.completed_at or task.created_at
    return _document(
        source_type=RetrievalSourceType.TASK,
        source_id=task.id,
        title=task.title,
        text=text,
        locator={"task_id": task.id},
        updated_at=updated_at.isoformat(),
    )


def _log_documents(conn: sqlite3.Connection) -> list[SemanticDocument]:
    documents: list[SemanticDocument] = []
    for entry in list_log_entries(conn, days=None):
        documents.append(_log_document(entry))
    return documents


def _log_document(entry: LogEntry) -> SemanticDocument:
    text = format_log_entry_display_text(entry)
    return _document(
        source_type=RetrievalSourceType.LOG,
        source_id=entry.id,
        title=entry.title,
        text=text,
        locator={"log_entry_id": entry.id},
        updated_at=entry.created_at.isoformat(),
    )


def _pdf_chunk_documents(conn: sqlite3.Connection) -> list[SemanticDocument]:
    rows = conn.execute(
        """
        SELECT DISTINCT pa.paper_id, pa.asset_id
        FROM paper_assets pa
        JOIN assets a ON a.id = pa.asset_id
        WHERE a.kind = ?
        ORDER BY pa.paper_id ASC, pa.asset_id ASC
        """,
        (AssetKind.PDF.value,),
    ).fetchall()
    documents: list[SemanticDocument] = []
    for row in rows:
        paper_id = int(row["paper_id"])
        asset_id = int(row["asset_id"])
        asset = get_asset(conn, asset_id)
        if asset is None:
            continue
        for chunk in list_asset_text_chunks(conn, asset_id, start_chunk=0, limit=1_000_000):
            if chunk.id is not None:
                documents.append(_pdf_chunk_document(chunk, paper_id=paper_id, asset_name=asset.display_name))
    return documents


def _pdf_chunk_document(
    chunk: AssetTextChunk,
    *,
    paper_id: int,
    asset_name: str,
) -> SemanticDocument:
    assert chunk.id is not None
    section = " > ".join(chunk.section_path)
    title_parts = [asset_name, f"page {chunk.page_number}", section]
    title = " - ".join(part for part in title_parts if part)
    return _document(
        source_type=RetrievalSourceType.PDF_CHUNK,
        source_id=f"{paper_id}:{chunk.asset_id}:{chunk.id}",
        title=title,
        text=chunk.text,
        locator={
            "paper_id": paper_id,
            "asset_id": chunk.asset_id,
            "chunk_id": chunk.id,
            "chunk_index": chunk.chunk_index,
            "page_number": chunk.page_number,
            "section_path": list(chunk.section_path),
        },
        updated_at=chunk.updated_at.isoformat(),
    )


def _document(
    *,
    source_type: RetrievalSourceType,
    source_id: int | str,
    title: str,
    text: str,
    locator: dict[str, Any],
    updated_at: str,
) -> SemanticDocument:
    row_id = f"{source_type.value}:{source_id}"
    return SemanticDocument(
        row_id=row_id,
        source_type=source_type,
        source_id=str(source_id),
        title=title,
        text=text,
        locator=locator,
        updated_at=updated_at,
        content_hash=_content_hash(
            source_type=source_type.value,
            source_id=str(source_id),
            title=title,
            text=text,
            locator=locator,
            updated_at=updated_at,
        ),
    )


def _content_hash(**payload: Any) -> str:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _document_row(document: SemanticDocument, vector: np.ndarray) -> dict[str, Any]:
    row = {
        "row_id": document.row_id,
        "source_type": document.source_type.value,
        "source_id": document.source_id,
        "title": document.title,
        "text": document.text,
        "locator_json": json.dumps(document.locator, sort_keys=True, ensure_ascii=False),
        "updated_at": document.updated_at,
        "content_hash": document.content_hash,
        "embedding_model_name": MODEL_NAME,
        "embedding_model_version": EMBEDDING_MODEL_VERSION,
        "embedding_dimension": EMBEDDING_DIMENSION,
        "vector": vector.astype(np.float32).tolist(),
    }
    row.update(_locator_columns(document.locator))
    return row


def _locator_columns(locator: dict[str, Any]) -> dict[str, Any]:
    return {
        "paper_id": _optional_int(locator.get("paper_id")),
        "note_id": _optional_int(locator.get("note_id")),
        "project_id": _optional_int(locator.get("project_id")),
        "task_id": _optional_int(locator.get("task_id")),
        "log_entry_id": _optional_int(locator.get("log_entry_id")),
        "asset_id": _optional_int(locator.get("asset_id")),
        "chunk_id": _optional_int(locator.get("chunk_id")),
        "chunk_index": _optional_int(locator.get("chunk_index")),
        "page_number": _optional_int(locator.get("page_number")),
    }


def _document_from_row(row: dict[str, Any]) -> SemanticDocument:
    locator = json.loads(str(row.get("locator_json") or "{}"))
    source_type = RetrievalSourceType(str(row["source_type"]))
    return SemanticDocument(
        row_id=str(row["row_id"]),
        source_type=source_type,
        source_id=str(row["source_id"]),
        title=str(row.get("title") or ""),
        text=str(row.get("text") or ""),
        locator=locator if isinstance(locator, dict) else {},
        updated_at=str(row.get("updated_at") or ""),
        content_hash=str(row.get("content_hash") or ""),
    )


def _embed_texts(texts: list[str], *, embedder: Embedder) -> np.ndarray:
    vectors = embedder(texts)
    array = np.asarray(vectors, dtype=np.float32)
    if array.shape != (len(texts), EMBEDDING_DIMENSION):
        raise ValueError(
            f"Expected embeddings with shape {(len(texts), EMBEDDING_DIMENSION)}, got {array.shape}."
        )
    return array


def _connect(index_path: Path):
    try:
        import lancedb
    except ModuleNotFoundError as exc:  # pragma: no cover - exercised with fake connector tests.
        raise SemanticIndexUnavailable(
            "lancedb is required for the local semantic retrieval index."
        ) from exc
    index_path.mkdir(parents=True, exist_ok=True)
    return lancedb.connect(str(index_path))


def _open_table(index_path: Path):
    try:
        return _connect(index_path).open_table(TABLE_NAME)
    except Exception as exc:
        raise SemanticIndexUnavailable(
            f"Semantic retrieval index table {TABLE_NAME!r} is not available; rebuild it first."
        ) from exc


def _drop_table_if_exists(db: Any, table_name: str) -> None:
    try:
        db.drop_table(table_name)
    except Exception:
        return


def _read_index_rows(index_path: Path) -> list[dict[str, Any]]:
    try:
        table = _open_table(index_path)
        count = int(table.count_rows())
        if count <= 0:
            return []
        return list(table.search().limit(count).to_list())
    except SemanticIndexUnavailable:
        return []


def _optional_int(value: object) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _optional_float(value: object) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _distance_to_score(value: object) -> float:
    distance = _optional_float(value)
    if distance is None or not math.isfinite(distance):
        return 0.0
    return 1.0 / (1.0 + max(0.0, distance))
