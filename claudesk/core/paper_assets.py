from __future__ import annotations

import hashlib
import json
import re
import shutil
import sqlite3
import unicodedata
import uuid
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import BinaryIO, Optional

from claudesk.core.config import (
    Config,
    data_dir,
    paper_assets_root,
)

PDF_MIME_TYPES = {"application/pdf", "application/x-pdf"}
TEXT_ATTACHMENT_MIME_TYPES = {
    "application/json",
    "application/xml",
    "application/x-yaml",
    "text/csv",
    "text/markdown",
    "text/plain",
    "text/tab-separated-values",
    "text/x-markdown",
    "text/xml",
    "text/yaml",
}
IMAGE_ATTACHMENT_MIME_TYPES = {"image/gif", "image/jpeg", "image/png", "image/webp"}
CHAT_ATTACHMENT_MAX_TEXT_BYTES = 1024 * 1024
CHAT_ATTACHMENT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
CHAT_ATTACHMENT_MAX_PDF_BYTES = 50 * 1024 * 1024
MARKDOWN_IMAGE_MIME_TYPES = IMAGE_ATTACHMENT_MIME_TYPES
MARKDOWN_IMAGE_MAX_BYTES = CHAT_ATTACHMENT_MAX_IMAGE_BYTES
EXCALIDRAW_ASSET_SOURCE = "note_excalidraw"
EXCALIDRAW_ASSET_MIME_TYPE = "application/json"
EXCALIDRAW_DRAWING_MAX_BYTES = 5 * 1024 * 1024
CHUNK_SIZE = 1024 * 1024

_MARKDOWN_IMAGE_SUFFIX_MIME_TYPES = {
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}
_MARKDOWN_ASSET_URL_RE = re.compile(r"(?<![A-Za-z0-9_])asset://(?P<asset_id>\d+)(?![A-Za-z0-9_])")
_MARKDOWN_ASSET_FILE_URL_RE = re.compile(r"(?<![A-Za-z0-9_])/api/assets/(?P<asset_id>\d+)/file(?![A-Za-z0-9_])")
_EXCALIDRAW_FENCE_RE = re.compile(
    r"^(?P<indent> {0,3})(?P<fence>`{3,}|~{3,})(?P<info>.*)$"
)
_EXCALIDRAW_FENCE_CLOSE_RE = re.compile(
    r"^(?P<indent> {0,3})(?P<fence>`{3,}|~{3,})[ \t]*$"
)
_EXCALIDRAW_FENCE_ASSET_INFO_RE = re.compile(
    r"^[ \t]*excalidraw[ \t]+asset://(?P<asset_id>\d+)(?:[ \t].*)?$",
    re.IGNORECASE,
)
_MARKDOWN_LIST_MARKER_RE = re.compile(r"^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+")

_MIME_EXTENSIONS = {
    "application/json": ".json",
    "application/pdf": ".pdf",
    "application/x-pdf": ".pdf",
    "application/xml": ".xml",
    "application/x-yaml": ".yaml",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "text/csv": ".csv",
    "text/markdown": ".md",
    "text/plain": ".txt",
    "text/tab-separated-values": ".tsv",
    "text/x-markdown": ".md",
    "text/xml": ".xml",
    "text/yaml": ".yaml",
}


class InvalidPaperAssetFile(ValueError):
    """Raised when an uploaded paper asset file is not acceptable."""


class AssetFileStatus(str, Enum):
    PRESENT = "present"
    MISSING = "missing"
    INVALID_PATH = "invalid_path"
    NOT_MANAGED = "not_managed"


@dataclass(frozen=True)
class StoredPaperAssetFile:
    managed_path: str
    original_filename: str
    mime_type: str
    size_bytes: int
    content_hash: str


@dataclass(frozen=True)
class StoredChatAttachmentFile:
    managed_path: str
    original_filename: str
    mime_type: str
    size_bytes: int
    content_hash: str


@dataclass(frozen=True)
class StoredMarkdownImageFile:
    managed_path: str
    original_filename: str
    mime_type: str
    size_bytes: int
    content_hash: str


@dataclass(frozen=True)
class StoredExcalidrawDrawingFile:
    managed_path: str
    original_filename: str
    mime_type: str
    size_bytes: int
    content_hash: str


@dataclass(frozen=True)
class AssetFileHealth:
    status: AssetFileStatus
    file_exists: bool
    resolved_path: Optional[Path] = None
    error: Optional[str] = None


@dataclass(frozen=True)
class AssetFileHealthRecord:
    asset_id: int
    kind: str
    managed_path: Optional[str]
    display_name: str
    original_filename: str
    paper_ids: tuple[int, ...]
    health: AssetFileHealth


def _basename(filename: str | None) -> str:
    raw = (filename or "paper.pdf").replace("\\", "/").split("/")[-1].strip()
    return raw or "paper.pdf"


def _basename_or_default(filename: str | None, default: str) -> str:
    raw = (filename or default).replace("\\", "/").split("/")[-1].strip()
    return raw or default


def safe_asset_filename(filename: str | None) -> str:
    base = _basename(filename)
    stem = Path(base).stem.strip() or "paper"
    safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip(".-_") or "paper"
    return f"{safe_stem[:96]}.pdf"


def safe_chat_attachment_filename(
    filename: str | None,
    *,
    mime_type: str | None,
    default_filename: str = "attachment",
) -> str:
    base = _basename_or_default(filename, default_filename)
    stem = Path(base).stem.strip() or Path(default_filename).stem or "attachment"
    safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip(".-_") or "attachment"
    suffix = Path(base).suffix.lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,10}", suffix or ""):
        suffix = ""
    inferred_suffix = _MIME_EXTENSIONS.get((mime_type or "").casefold(), "")
    extension = suffix or inferred_suffix or ".bin"
    return f"{safe_stem[:96]}{extension}"


def safe_paper_folder_name(paper_id: int, paper_title: str | None) -> str:
    normalized = unicodedata.normalize("NFKD", paper_title or "").encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-z0-9]+", "-", normalized.casefold()).strip("-") or "untitled"
    slug = slug[:80].strip("-") or "untitled"
    return f"{paper_id}-{slug}"


def validate_pdf_upload(filename: str | None, mime_type: str | None) -> None:
    if Path(_basename(filename)).suffix.casefold() != ".pdf":
        raise InvalidPaperAssetFile("Only PDF files can be attached.")
    if mime_type and mime_type.casefold() not in PDF_MIME_TYPES:
        raise InvalidPaperAssetFile("Only PDF files can be attached.")


def _markdown_image_mime_type(filename: str | None, mime_type: str | None) -> str:
    normalized_mime = (mime_type or "").casefold().strip()
    if normalized_mime in MARKDOWN_IMAGE_MIME_TYPES:
        return normalized_mime

    suffix = Path(_basename_or_default(filename, "image")).suffix.casefold()
    inferred = _MARKDOWN_IMAGE_SUFFIX_MIME_TYPES.get(suffix)
    if inferred:
        return inferred

    raise InvalidPaperAssetFile("Only PNG, JPEG, WebP, and GIF images can be attached.")


def safe_markdown_image_filename(filename: str | None, *, mime_type: str | None) -> str:
    effective_mime_type = _markdown_image_mime_type(filename, mime_type)
    base = _basename_or_default(filename, "image")
    stem = Path(base).stem.strip() or "image"
    safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip(".-_") or "image"
    extension = _MIME_EXTENSIONS.get(effective_mime_type, ".bin")
    return f"{safe_stem[:96]}{extension}"


def safe_excalidraw_drawing_filename(filename: str | None) -> str:
    base = _basename_or_default(filename, "drawing")
    stem = Path(base).stem.strip() or "drawing"
    if stem.casefold().endswith(".excalidraw"):
        stem = stem[: -len(".excalidraw")] or "drawing"
    safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip(".-_") or "drawing"
    return f"{safe_stem[:96]}.excalidraw.json"


def extract_markdown_asset_ids(text: str) -> list[int]:
    seen: set[int] = set()
    ordered: list[int] = []
    for pattern in (_MARKDOWN_ASSET_URL_RE, _MARKDOWN_ASSET_FILE_URL_RE):
        for match in pattern.finditer(text or ""):
            asset_id = int(match.group("asset_id"))
            if asset_id <= 0 or asset_id in seen:
                continue
            seen.add(asset_id)
            ordered.append(asset_id)
    return ordered


def extract_excalidraw_asset_ids(text: str) -> list[int]:
    seen: set[int] = set()
    ordered: list[int] = []

    open_fence_char = ""
    open_fence_len = 0
    list_continuation_indent: int | None = None

    for line in (text or "").splitlines():
        raw = line.rstrip("\r\n")
        if not raw.strip():
            continue

        indent = len(raw) - len(raw.lstrip(" "))
        list_match = _MARKDOWN_LIST_MARKER_RE.match(raw)
        in_list = list_continuation_indent is not None and indent >= list_continuation_indent
        if list_match is not None:
            in_list = True
            list_continuation_indent = list_match.end()
        elif list_continuation_indent is not None and indent < list_continuation_indent:
            list_continuation_indent = None
            in_list = False

        if open_fence_char:
            close_match = _EXCALIDRAW_FENCE_CLOSE_RE.match(raw)
            if (
                close_match is not None
                and close_match.group("fence").startswith(open_fence_char)
                and len(close_match.group("fence")) >= open_fence_len
            ):
                open_fence_char = ""
                open_fence_len = 0
            continue

        if in_list or re.match(r"^ {0,3}>", raw):
            continue
        fence_match = _EXCALIDRAW_FENCE_RE.match(raw)
        if fence_match is None:
            continue
        fence = fence_match.group("fence")
        info = fence_match.group("info") or ""
        open_fence_char = fence[0]
        open_fence_len = len(fence)
        asset_match = _EXCALIDRAW_FENCE_ASSET_INFO_RE.match(info)
        if asset_match is None:
            continue
        asset_id = int(asset_match.group("asset_id"))
        if asset_id > 0 and asset_id not in seen:
            seen.add(asset_id)
            ordered.append(asset_id)
    return ordered


def extract_excalidraw_scene_text(scene: object) -> str:
    if not isinstance(scene, dict):
        return ""
    elements = scene.get("elements")
    if not isinstance(elements, list):
        return ""

    values: list[str] = []
    seen: set[str] = set()

    def add_text(value: object) -> None:
        if not isinstance(value, str):
            return
        text = re.sub(r"\s+", " ", value).strip()
        if not text:
            return
        key = text.casefold()
        if key in seen:
            return
        seen.add(key)
        values.append(text)

    def collect(value: object) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                if key in {"text", "originalText", "rawText"}:
                    add_text(child)
                elif isinstance(child, (dict, list)):
                    collect(child)
        elif isinstance(value, list):
            for item in value:
                collect(item)

    for element in elements:
        if not isinstance(element, dict) or element.get("isDeleted"):
            continue
        collect(element)

    return "\n".join(values)


def _asset_root(cfg: Optional[Config], *, create: bool = True) -> Path:
    return paper_assets_root(cfg, create=create)


def chat_attachments_root(cfg: Optional[Config] = None, *, create: bool = True) -> Path:
    """Return the process-lifetime chat attachment file root."""
    _ = cfg
    root = (data_dir() / ".claudesk" / "tmp" / "chat-attachments").resolve()
    if create:
        root.mkdir(parents=True, exist_ok=True)
    return root


def resolve_managed_asset_path(
    managed_path: str,
    *,
    cfg: Optional[Config] = None,
    create_root: bool = True,
) -> Path:
    if not managed_path or Path(managed_path).is_absolute():
        raise InvalidPaperAssetFile("Invalid managed asset path.")
    root = _asset_root(cfg, create=create_root).resolve()
    path = (root / managed_path).resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise InvalidPaperAssetFile("Managed asset path escapes asset root.") from exc
    return path


def resolve_chat_attachment_path(
    managed_path: str,
    *,
    cfg: Optional[Config] = None,
    create_root: bool = True,
) -> Path:
    if not managed_path or Path(managed_path).is_absolute():
        raise InvalidPaperAssetFile("Invalid managed chat attachment path.")
    root = chat_attachments_root(cfg, create=create_root).resolve()
    path = (root / managed_path).resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise InvalidPaperAssetFile("Managed chat attachment path escapes attachment root.") from exc
    return path


def asset_file_health(
    managed_path: str | None,
    *,
    cfg: Optional[Config] = None,
) -> AssetFileHealth:
    if not managed_path:
        return AssetFileHealth(
            status=AssetFileStatus.NOT_MANAGED,
            file_exists=False,
        )
    try:
        resolved = resolve_managed_asset_path(managed_path, cfg=cfg, create_root=False)
    except InvalidPaperAssetFile as exc:
        return AssetFileHealth(
            status=AssetFileStatus.INVALID_PATH,
            file_exists=False,
            error=str(exc),
        )
    file_exists = resolved.exists()
    return AssetFileHealth(
        status=AssetFileStatus.PRESENT if file_exists else AssetFileStatus.MISSING,
        file_exists=file_exists,
        resolved_path=resolved,
    )


def chat_attachment_file_health(
    managed_path: str | None,
    *,
    cfg: Optional[Config] = None,
) -> AssetFileHealth:
    if not managed_path:
        return AssetFileHealth(
            status=AssetFileStatus.NOT_MANAGED,
            file_exists=False,
        )
    try:
        resolved = resolve_chat_attachment_path(managed_path, cfg=cfg, create_root=False)
    except InvalidPaperAssetFile as exc:
        return AssetFileHealth(
            status=AssetFileStatus.INVALID_PATH,
            file_exists=False,
            error=str(exc),
        )
    file_exists = resolved.exists()
    return AssetFileHealth(
        status=AssetFileStatus.PRESENT if file_exists else AssetFileStatus.MISSING,
        file_exists=file_exists,
        resolved_path=resolved,
    )


def list_asset_file_health(
    conn: sqlite3.Connection,
    *,
    cfg: Optional[Config] = None,
) -> list[AssetFileHealthRecord]:
    paper_ids_by_asset: dict[int, list[int]] = {}
    for row in conn.execute(
        """
        SELECT asset_id, paper_id
        FROM paper_assets
        ORDER BY asset_id ASC, paper_id ASC
        """
    ).fetchall():
        paper_ids_by_asset.setdefault(int(row["asset_id"]), []).append(int(row["paper_id"]))

    records: list[AssetFileHealthRecord] = []
    for row in conn.execute(
        """
        SELECT id, kind, managed_path, display_name, original_filename
        FROM assets
        WHERE NOT EXISTS (
            SELECT 1
            FROM chat_attachments ca
            WHERE ca.asset_id=assets.id
        )
        ORDER BY id ASC
        """
    ).fetchall():
        asset_id = int(row["id"])
        records.append(
            AssetFileHealthRecord(
                asset_id=asset_id,
                kind=str(row["kind"]),
                managed_path=row["managed_path"],
                display_name=str(row["display_name"]),
                original_filename=str(row["original_filename"]),
                paper_ids=tuple(paper_ids_by_asset.get(asset_id, [])),
                health=asset_file_health(row["managed_path"], cfg=cfg),
            )
        )
    return records


def store_managed_pdf_asset(
    *,
    paper_id: int,
    paper_title: str | None = None,
    file_obj: BinaryIO,
    filename: str | None,
    mime_type: str | None,
    cfg: Optional[Config] = None,
) -> StoredPaperAssetFile:
    validate_pdf_upload(filename, mime_type)
    original_filename = _basename(filename)
    safe_filename = safe_asset_filename(original_filename)
    paper_folder = safe_paper_folder_name(paper_id, paper_title)
    relative_path = f"papers/{paper_folder}/{uuid.uuid4().hex}-{safe_filename}"
    destination = resolve_managed_asset_path(relative_path, cfg=cfg)
    destination.parent.mkdir(parents=True, exist_ok=True)

    hasher = hashlib.sha256()
    size = 0
    try:
        file_obj.seek(0)
    except (AttributeError, OSError):
        pass

    temp_path = destination.with_name(f".{destination.name}.tmp")
    with open(temp_path, "wb") as out:
        while True:
            chunk = file_obj.read(CHUNK_SIZE)
            if not chunk:
                break
            hasher.update(chunk)
            size += len(chunk)
            out.write(chunk)
    shutil.move(str(temp_path), str(destination))

    return StoredPaperAssetFile(
        managed_path=relative_path,
        original_filename=original_filename,
        mime_type=mime_type or "application/pdf",
        size_bytes=size,
        content_hash=hasher.hexdigest(),
    )


def store_managed_chat_attachment(
    *,
    session_id: int,
    file_obj: BinaryIO,
    filename: str | None,
    mime_type: str | None,
    max_bytes: int,
    default_filename: str = "attachment",
    cfg: Optional[Config] = None,
) -> StoredChatAttachmentFile:
    if session_id <= 0:
        raise InvalidPaperAssetFile("Chat session id is required.")
    if max_bytes <= 0:
        raise InvalidPaperAssetFile("Attachment size limit must be positive.")
    effective_mime_type = mime_type or "application/octet-stream"
    original_filename = _basename_or_default(filename, default_filename)
    safe_filename = safe_chat_attachment_filename(
        original_filename,
        mime_type=effective_mime_type,
        default_filename=default_filename,
    )
    relative_path = f"sessions/{session_id}/{uuid.uuid4().hex}-{safe_filename}"
    destination = resolve_chat_attachment_path(relative_path, cfg=cfg)
    destination.parent.mkdir(parents=True, exist_ok=True)

    hasher = hashlib.sha256()
    size = 0
    try:
        file_obj.seek(0)
    except (AttributeError, OSError):
        pass

    temp_path = destination.with_name(f".{destination.name}.tmp")
    try:
        with open(temp_path, "wb") as out:
            while True:
                chunk = file_obj.read(CHUNK_SIZE)
                if not chunk:
                    break
                hasher.update(chunk)
                size += len(chunk)
                if size > max_bytes:
                    raise InvalidPaperAssetFile(
                        f"Attachment exceeds the {max_bytes} byte size limit."
                    )
                out.write(chunk)
        shutil.move(str(temp_path), str(destination))
    except Exception:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass
        try:
            destination.unlink()
        except FileNotFoundError:
            pass
        raise

    return StoredChatAttachmentFile(
        managed_path=relative_path,
        original_filename=original_filename,
        mime_type=effective_mime_type,
        size_bytes=size,
        content_hash=hasher.hexdigest(),
    )


def store_managed_markdown_image_asset(
    *,
    file_obj: BinaryIO,
    filename: str | None,
    mime_type: str | None,
    cfg: Optional[Config] = None,
    max_bytes: int = MARKDOWN_IMAGE_MAX_BYTES,
) -> StoredMarkdownImageFile:
    if max_bytes <= 0:
        raise InvalidPaperAssetFile("Image size limit must be positive.")
    effective_mime_type = _markdown_image_mime_type(filename, mime_type)
    original_filename = _basename_or_default(filename, "image")
    safe_filename = safe_markdown_image_filename(original_filename, mime_type=effective_mime_type)
    relative_path = f"images/{uuid.uuid4().hex}-{safe_filename}"
    destination = resolve_managed_asset_path(relative_path, cfg=cfg)
    destination.parent.mkdir(parents=True, exist_ok=True)

    hasher = hashlib.sha256()
    size = 0
    try:
        file_obj.seek(0)
    except (AttributeError, OSError):
        pass

    temp_path = destination.with_name(f".{destination.name}.tmp")
    try:
        with open(temp_path, "wb") as out:
            while True:
                chunk = file_obj.read(CHUNK_SIZE)
                if not chunk:
                    break
                hasher.update(chunk)
                size += len(chunk)
                if size > max_bytes:
                    raise InvalidPaperAssetFile(f"Image exceeds the {max_bytes} byte size limit.")
                out.write(chunk)
        shutil.move(str(temp_path), str(destination))
    except Exception:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass
        try:
            destination.unlink()
        except FileNotFoundError:
            pass
        raise

    return StoredMarkdownImageFile(
        managed_path=relative_path,
        original_filename=original_filename,
        mime_type=effective_mime_type,
        size_bytes=size,
        content_hash=hasher.hexdigest(),
    )


def _encode_excalidraw_scene(scene: dict[str, object], *, max_bytes: int) -> tuple[bytes, str]:
    if max_bytes <= 0:
        raise InvalidPaperAssetFile("Drawing size limit must be positive.")
    try:
        payload = json.dumps(scene, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise InvalidPaperAssetFile("Drawing data must be JSON serializable.") from exc
    if len(payload) > max_bytes:
        raise InvalidPaperAssetFile(f"Drawing exceeds the {max_bytes} byte size limit.")
    return payload, hashlib.sha256(payload).hexdigest()


def _write_excalidraw_scene_file(
    *,
    managed_path: str,
    scene: dict[str, object],
    cfg: Optional[Config],
    max_bytes: int,
    original_filename: str | None = None,
) -> StoredExcalidrawDrawingFile:
    payload, content_hash = _encode_excalidraw_scene(scene, max_bytes=max_bytes)
    destination = resolve_managed_asset_path(managed_path, cfg=cfg)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp_path = destination.with_name(f".{destination.name}.tmp")
    try:
        temp_path.write_bytes(payload)
        shutil.move(str(temp_path), str(destination))
    except Exception:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass
        raise

    return StoredExcalidrawDrawingFile(
        managed_path=managed_path,
        original_filename=original_filename or Path(managed_path).name,
        mime_type=EXCALIDRAW_ASSET_MIME_TYPE,
        size_bytes=len(payload),
        content_hash=content_hash,
    )


def store_managed_excalidraw_drawing_asset(
    *,
    scene: dict[str, object],
    filename: str | None,
    cfg: Optional[Config] = None,
    max_bytes: int = EXCALIDRAW_DRAWING_MAX_BYTES,
) -> StoredExcalidrawDrawingFile:
    safe_filename = safe_excalidraw_drawing_filename(filename)
    relative_path = f"drawings/{uuid.uuid4().hex}-{safe_filename}"
    return _write_excalidraw_scene_file(
        managed_path=relative_path,
        scene=scene,
        cfg=cfg,
        max_bytes=max_bytes,
        original_filename=safe_filename,
    )


def update_managed_excalidraw_drawing_asset(
    *,
    managed_path: str,
    scene: dict[str, object],
    cfg: Optional[Config] = None,
    max_bytes: int = EXCALIDRAW_DRAWING_MAX_BYTES,
) -> StoredExcalidrawDrawingFile:
    if not managed_path.startswith("drawings/"):
        raise InvalidPaperAssetFile("Drawing file is not in managed drawing storage.")
    return _write_excalidraw_scene_file(
        managed_path=managed_path,
        scene=scene,
        cfg=cfg,
        max_bytes=max_bytes,
    )


def read_managed_excalidraw_drawing_asset(
    managed_path: str,
    *,
    cfg: Optional[Config] = None,
) -> dict[str, object]:
    if not managed_path.startswith("drawings/"):
        raise InvalidPaperAssetFile("Drawing file is not in managed drawing storage.")
    path = resolve_managed_asset_path(managed_path, cfg=cfg, create_root=False)
    try:
        payload = path.read_bytes()
    except FileNotFoundError as exc:
        raise InvalidPaperAssetFile("Managed drawing file was not found.") from exc
    try:
        data = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise InvalidPaperAssetFile("Managed drawing file is not valid JSON.") from exc
    if not isinstance(data, dict):
        raise InvalidPaperAssetFile("Managed drawing file must contain a JSON object.")
    return data


def prune_empty_managed_directory(managed_path: str | None, *, cfg: Optional[Config] = None) -> None:
    if not managed_path:
        return
    root = _asset_root(cfg, create=False).resolve()
    path = resolve_managed_asset_path(managed_path, cfg=cfg, create_root=False)
    current = (path if path.exists() and path.is_dir() else path.parent).resolve()
    try:
        current.relative_to(root)
    except ValueError:
        return

    while current != root:
        try:
            current.rmdir()
        except FileNotFoundError:
            current = current.parent
            continue
        except OSError:
            break
        current = current.parent


def prune_empty_chat_attachment_directory(managed_path: str | None, *, cfg: Optional[Config] = None) -> None:
    if not managed_path:
        return
    root = chat_attachments_root(cfg, create=False).resolve()
    path = resolve_chat_attachment_path(managed_path, cfg=cfg, create_root=False)
    current = (path if path.exists() and path.is_dir() else path.parent).resolve()
    try:
        current.relative_to(root)
    except ValueError:
        return

    while current != root:
        try:
            current.rmdir()
        except FileNotFoundError:
            current = current.parent
            continue
        except OSError:
            break
        current = current.parent


def delete_managed_asset_file(managed_path: str | None, *, cfg: Optional[Config] = None) -> None:
    if not managed_path:
        return
    path = resolve_managed_asset_path(managed_path, cfg=cfg, create_root=False)
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    prune_empty_managed_directory(str(Path(managed_path).parent), cfg=cfg)


def delete_chat_attachment_file(managed_path: str | None, *, cfg: Optional[Config] = None) -> None:
    if not managed_path:
        return
    path = resolve_chat_attachment_path(managed_path, cfg=cfg, create_root=False)
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    prune_empty_chat_attachment_directory(str(Path(managed_path).parent), cfg=cfg)
