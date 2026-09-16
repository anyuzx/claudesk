# Agent Access To Paper Assets

**Last reviewed:** 2026-05-11

This document describes how managed paper PDFs and chat-uploaded files become available to Claudesk chat agents. The design is local-first: Claudesk stores managed copies, parses PDFs locally, derives bounded retrieval/page evidence, and exposes that evidence through capability tools.

## Scope
Implemented:
- list PDF assets attached to a paper
- manually or lazily parse managed PDFs
- normalize parser output into blocks, pages, chunks, artifacts, and FTS rows
- render whole PDF pages as managed PNG cache files
- search cached PDF chunks
- list document structure and read named sections
- return bounded text and selected page images through API-provider chat and Codex/MCP chat
- expose chat attachments, including text, images, and PDFs, through `get_chat_attachment_context`
- record local resource reads in the backend read ledger

Not implemented:
- OCR for scanned PDFs
- embedded figure/table crop extraction
- semantic vector search
- provider-native whole-PDF upload as the default access path
- persistent PDF annotations or viewer-to-agent marks

## Data Flow
Paper PDF path:

```text
ASSETS upload
  -> managed PDF under <vault>/assets
  -> assets + paper_assets rows
  -> optional/manual parse or lazy tool parse
  -> normalized blocks/pages/chunks/images
  -> PDF capability tool call
  -> bounded JSON text + optional image content
  -> Activity trace + read-ledger rows
```

Chat attachment path:

```text
composer paste/drop/file picker
  -> managed chat-owned asset
  -> chat_attachments row
  -> context item on user message
  -> get_chat_attachment_context
  -> bounded text/image/PDF evidence
  -> Activity trace + read-ledger rows
```

Agents see paper ids, asset ids, display names, page numbers, section paths, chunk/block ids, image labels, parser metadata, and cache status. They do not see arbitrary filesystem paths.

## Storage Layers
### Managed Source Files
Paper PDFs are copied under the fixed vault asset root:

```text
<vault>/assets/papers/<paper-id>-<title-slug>/<uuid>-<safe-name>.pdf
```

SQLite stores a relative `managed_path`. `resolve_managed_asset_path` rejects absolute paths and traversal. Renaming an asset changes `assets.display_name` only.

Chat-owned files are stored as managed app-lifetime assets and cleaned up on startup/shutdown, message clear, or session delete as appropriate. Persisted context snapshots can show expired attachment references after cleanup.

### Parsed Blocks, Pages, And Chunks
PDF access uses structured cache tables:
- `asset_pdf_pages`
- `asset_parse_artifacts`
- `asset_document_blocks`
- `asset_text_chunks`
- `asset_text_chunks_fts`

Parser-native JSON/markdown is internal. Normalized blocks are Claudesk's canonical parse. Chunks are derived retrieval material.

### Rendered Page Images
Rendered pages are managed derived files:

```text
<vault>/assets/derived/pdf-pages/<asset-id>/page-0001-dpi144.png
```

Whole pages preserve layout, equations, tables, captions, and coordinates for visual questions and future annotation work.

## Parser Backends
`paper_assets.pdf_parser` selects:
- `pymupdf`: default built-in path
- `pymupdf4llm`: optional LLM/RAG-oriented parser
- `docling`: optional local parser
- `mineru`: optional local CLI/package

All backends must normalize to the same block/page/chunk model. Missing optional backends fail clearly and mark the asset `failed`.

## Lazy Ingestion
Before parsing, Claudesk verifies:
- paper exists
- asset is linked to the paper
- asset kind is `pdf`
- managed path is relative and resolves inside `<vault>/assets`
- managed file exists

Cache is reused only when parse status, parser name/version, schema version, page rows, block rows, rendered images, and render DPI match current expectations.

When parsing is needed:
1. Mark the asset queued and commit.
2. Release the write lock before expensive parser/render work.
3. Clear old parse/cache rows and derived files.
4. Dispatch parser and normalize output.
5. Render page images into a temp managed directory.
6. Store artifacts, pages, blocks, chunks, and FTS rows.
7. Mark parsed and commit.

Failures clear partial cache, mark failed, store `parse_error`, and return a structured tool error.

## Manual Parse API
The ASSETS tab uses:

```text
POST /api/papers/{paper_id}/assets/{asset_id}/parse
```

The route queues promptly, then runs ingestion in a background thread with a fresh SQLite connection. Asset payloads include parser metadata, parse errors, file-health status, and page/chunk/block/artifact/image counts so the UI does not need a separate parser state model.

## Capability Tools
PDF read tools are gated by `chat.tools.paper_pdf`.

Paper PDF tools:
- `list_paper_assets`: list assets and cache/file status without parsing.
- `list_paper_structure`: parse if needed and return outline, sections, block counts, parser/cache metadata.
- `retrieve_paper_context`: query FTS chunks for targeted full-text evidence.
- `read_paper_section`: read ordered normalized blocks from a section path.
- `read_paper_pdf`: read ordered chunks with optional page images.
- `search_paper_pdf`: FTS search over cached chunks with optional page images.
- `inspect_paper_pdf_pages`: return selected page text and/or page images.

Attachment tool:
- `get_chat_attachment_context`: read bounded chat-owned text, image, or PDF evidence.

Asset write tools:
- `rename_paper_asset`
- `parse_paper_asset`
- `attach_pdf_from_url`

Tool results include enough provenance for citations and Activity/read-ledger UI: paper, asset, page, section, chunk, block, image label, parser, and cache state.

## Runtime Behavior
### API Providers
FastAPI chat delegates deterministic context/capability preflight to `TurnController`. API-provider turns run through Pydantic AI in `claudesk/agent/runtime.py`; enabled capabilities execute through the registry.

Structured context determines required capabilities. Disabled required capabilities fail closed before provider execution. Ambiguous natural language reaches the model, which should use tools or ask for clarification.

### Codex And MCP
The MCP server is a transport over the same registry. The official MCP SDK owns protocol/framing; `tools/list` and `tools/call` use registry exports and gates.

Codex research chat runs from `<vault>/codex-chat-workspace`. Native shell/file tools are read-only by default and, when enabled, are scoped to the chat workspace. Claudesk-managed PDFs and notes remain accessible through MCP capabilities, not filesystem fallback.

Codex app-server tool inventory diagnostics compare registry-enabled tools, MCP manifest tools, and app-server registered tools before required turns.

## Prompt Expectations
Agents should:
- use local PDF tools for uploaded or attached PDFs
- call `list_paper_assets` when asset choice is unclear
- call `list_paper_structure` before targeted section reads
- use `retrieve_paper_context` or `search_paper_pdf` for targeted evidence
- use `read_paper_pdf` for bounded sequential reading and continue with `next_chunk_index` only when needed
- use `inspect_paper_pdf_pages` for visual/layout questions
- cite section paths, page numbers, chunk/block ids or indexes, and image labels
- avoid calling abstract-only metadata full text

For title-only paper references, agents should use `search_papers` and ask for clarification when matches are ambiguous.

## Safety Boundaries
- no arbitrary filesystem reads
- no absolute paths in model-visible output
- no path traversal outside the asset root
- no whole-PDF prompt dumps
- no unbounded chunk reads
- capped page image attachments
- clear errors for missing or invalid managed files

## Current Limitations
- Default extraction can miss OCR-only scanned content.
- Optional parser backends are not bundled production dependencies.
- Page images are whole pages, not cropped figures or tables.
- Search is lexical FTS5, not semantic search.
- Provider-native PDF upload is not the default path.
- Persistent annotation and agent-authored mark workflows are not implemented.
