# Paper Assets And Full-Text Model

**Last reviewed:** 2026-05-11

This document defines the current managed asset model for paper PDFs, parsed full text, derived page images, and chat attachments.

## Goals
- Store user-attached paper files as managed vault assets.
- Support multiple PDFs or full-text artifacts per paper.
- Parse PDFs into a normalized Claudesk document model.
- Give chat agents bounded text and page-image evidence through tools.
- Let users open managed PDFs in the app without exposing local paths.
- Keep asset storage portable across Dropbox-style vault moves.

## Asset Concepts
Assets are metadata rows plus optional managed files. Binary files are not embedded in SQLite.

Current asset kinds:
- `pdf`
- `markdown`
- `text`
- `html`
- `attachment`

Durable paper assets are linked through `paper_assets`. Chat-owned attachments are linked through `chat_attachments` and become part of user-message context snapshots during the app lifetime.

## Managed File Storage
Durable paper files live under:

```text
<vault>/assets/
```

SQLite stores managed relative paths. Claudesk resolves those paths under the vault asset root and rejects absolute paths or traversal. Browser and model-visible output uses ids, display names, labels, page numbers, chunks, sections, and other provenance rather than filesystem paths.

Deleting a managed paper asset removes orphaned managed files and derived parse/cache files. Deleting a paper applies the same cleanup only for assets no longer linked to any remaining paper. Claudesk must not delete arbitrary external filesystem paths.

## Data Model
Core tables:
- `assets`: shared metadata, managed path, display/original names, MIME type, size, content hash, parse status, parser metadata, parse error, and timestamps.
- `paper_assets`: many-to-many paper/asset links.
- `chat_attachments`: chat-session/message ownership for chat-uploaded managed assets.
- `asset_pdf_pages`: page text, PDF dimensions, rendered image path/dimensions, render DPI.
- `asset_parse_artifacts`: internal parser-native and normalized artifacts.
- `asset_document_blocks`: normalized headings, paragraphs, tables, figures, equations, captions, references, and related structures.
- `asset_text_chunks`: bounded chunks derived from normalized blocks.
- `asset_text_chunks_fts`: lexical FTS index over chunk text.

`assets.parsed_text` is used for bounded text-like chat attachments. PDF bodies use normalized blocks/chunks/pages instead.

## Full-Text Semantics
The paper abstract is not full text. Features that summarize or answer questions from full text must distinguish:
- abstract metadata on `papers.abstract`
- temporary public HTML from `fetch_paper_full_text`
- stored parsed PDF text in normalized block/chunk tables
- generated markdown/text artifacts
- chat attachment text/PDF context

For PDFs:
- source PDFs remain managed immutable files
- parser-native output is private evidence
- normalized blocks are the canonical Claudesk parse
- chunks are retrieval material
- page images preserve layout and coordinates for visual questions and future annotation

If a PDF is not parsed, the ASSETS tab or first agent access can trigger parsing. Failed parse state remains visible.

## Parser Backends
`paper_assets.pdf_parser` selects:
- `pymupdf`: built-in default
- `pymupdf4llm`: optional local package
- `docling`: optional local package
- `mineru`: optional local CLI/package

Optional backends are loaded only when selected. If missing or failing, the asset is marked failed with a clear parse error.

## Chat Attachment Semantics
Chat attachments use the same managed asset system:
- long pasted text at the configured threshold becomes `clipboard_text`
- selected/dropped text-like files are stored as managed text attachments
- pasted or uploaded images/screenshots are stored as managed image attachments
- uploaded PDFs are stored as managed assets and reuse the PDF parser/cache path

Chat attachments are not automatically linked to papers. A later workflow can attach or match them deliberately.

`get_chat_attachment_context` returns bounded text, image evidence, PDF chunks, or page images and records read-ledger metadata. It is available to API-provider chat and Codex/MCP chat through the same capability registry.

## Agent Access
Paper PDF tools:
- `list_paper_assets`
- `list_paper_structure`
- `retrieve_paper_context`
- `read_paper_section`
- `read_paper_pdf`
- `search_paper_pdf`
- `inspect_paper_pdf_pages`

Write/management tools:
- `rename_paper_asset`
- `parse_paper_asset`
- `attach_pdf_from_url`

Chat attachment tool:
- `get_chat_attachment_context`

Tool output is bounded and includes ids, display names, page numbers, chunk/block ids or indexes, section paths, bounding boxes, image labels, parser metadata, and cache state. Managed paths and raw parser artifacts are not exposed.

The `chat.tools.paper_pdf` setting gates local PDF read tools. Domain-scoped gates control mutating asset actions.

## UI
Paper workspace ASSETS owns:
- upload one or more PDFs
- list assets and parse/file-health status
- rename display names
- manually parse/reparse/retry stale queued parses
- remove assets with confirmation
- open PDFs in-app through `GET /api/papers/{paper_id}/assets/{asset_id}/file`

The PDF viewer supports page scrolling, current page/page count, previous/next, zoom, fit-width, and stable page overlay wrappers for future annotations.

## Portability And Vault Migration
The vault contains:

```text
<vault>/
  claudesk.db
  interests.yaml
  assets/
```

Managed paths stay relative under `<vault>/assets`. Normal vault migration should not rewrite DB asset paths.

Migration commands:

```bash
claudesk vault set /path/to/Claudesk_Vault
claudesk vault assets audit
claudesk vault assets prune-missing --apply
claudesk vault assets audit --check
```

Move `assets/` with `claudesk.db` and `interests.yaml` to keep managed PDFs. `prune-missing` removes stale metadata for missing active-vault assets; it does not delete papers, notes, or arbitrary files.

## Current Limitations
- OCR/scanned-PDF support is not implemented.
- Page images are whole pages, not cropped figure/table images.
- PDF retrieval is lexical FTS5, not semantic.
- Direct PDF download from sources is not implemented.
- Persistent PDF annotations are not implemented.
- Zotero/Paperpile asset sync is not implemented.
