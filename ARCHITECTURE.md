# claudesk Architecture Reference

**Last reviewed:** 2026-06-05
**Purpose:** current app structure, important boundaries, data model shape, and agent runtime design.

## System Overview
Claudesk is a local-first research workspace built from:

- React + Vite frontend in `frontend/src/`.
- FastAPI backend in `claudesk/api/`.
- Shared Python library code in `claudesk/core/`, `claudesk/pipeline/`, `claudesk/sources/`, and `claudesk/agent/`.
- SQLite database under the active Claudesk vault, defaulting to `data/claudesk.db`.
- Durable managed assets under `<vault>/assets`.
- Durable local background job records for digest, rubric scoring, and PDF parse/reparse, with short-lived child processes or background threads for execution.

Runtime shape:

```text
React frontend
  -> FastAPI /api/*
  -> core workflow services and domain helpers
  -> SQLite + vault files
```

The key boundary: `claudesk/core/` is reusable library/domain code. It must not import from `claudesk/api/` or `claudesk/cli.py`.

## Runtime Entry Points
- Main app: `(cd frontend && npm run build)` then `claudesk up --no-browser`.
- Backend dev: `uvicorn claudesk.api.main:app --host 127.0.0.1 --port 8765 --reload`.
- Frontend dev: `(cd frontend && npm run dev)`, with Vite proxying `/api/*` to the backend.
- Digest job: `python -m claudesk.jobs.run_digest`.
- Manual rubric scoring: launched from Settings through `POST /api/settings/rubric/run`, which creates a durable background job and spawns `claudesk.jobs.run_rubric_scoring::run_rubric_scoring_once` via `claudesk/api/process_jobs.py`.
- CLI: `claudesk papers`, `claudesk todo`, `claudesk log`, `claudesk vault`, and `claudesk up`.

API-triggered digest, rubric-scoring, and PDF parse/reparse runs use durable SQLite `background_jobs`, `background_job_events`, and `background_job_failures` records for lifecycle/progress/failure state. Digest and rubric scoring still use `claudesk/api/process_jobs.py` to spawn short-lived child processes so embedding/model memory is released after each run; PDF parse/reparse keeps its existing background-thread parser/cache path.

## Package Map
### Frontend
`frontend/src/` owns the tabbed shell, workspace panes, Settings page, persistent Chat panel, local UI state, API client, markdown rendering, PDF viewer, and frontend tests.

State split:
- TanStack Query for server data.
- Zustand for app/UI state: active tab, workspace tabs, selected ids, layout, mobile pane, theme, and browser-local preferences.
- Search pane server queries include active backend and result-type filters in TanStack Query keys. Normal frontend search is unnamed fast local text by default. Each surface stores its own `Include semantic matches` preference; enabled surfaces use hybrid retrieval and show semantic index readiness/model-cost copy, while disabled surfaces stay lexical and do not poll index status.
- Pane-local search in Digest, Notes, Tasks, Log, and Projects uses a shared result-mode contract. A non-empty query switches the pane to retrieval results, leaves browse controls visible but paused, and ignores active browse filters, sorts, date ranges, grouping, task status, project filters, and similar browse constraints until the query is cleared.

Styling:
- Tailwind CSS v4 is configured CSS-first in `frontend/src/index.css`.
- Theme-sensitive UI uses semantic tokens, not Tailwind built-in color utilities.
- Markdown + KaTeX + callouts + lazy Shiki highlighting are rendered through shared components.

### API
`claudesk/api/` contains route groups for papers, notes, todos, progress, projects, search, digest/process jobs, settings, and chat.

Responsibilities:
- Request/response validation.
- Transaction boundaries and `conn.commit()`.
- Thin input/output mapping over core workflow services and persistence helpers.
- Settings registry over `GET/PATCH /api/settings`.
- Safe managed asset upload/open endpoints.
- Chat streaming through SSE.
- Serving the built frontend bundle in production.

FastAPI routes use `claudesk/api/deps.py::get_conn()`, not the CLI/job connection helper.

### Core, Pipeline, And Sources
- `claudesk/core/config.py`: vault resolution, config loading, env overrides, settings models, asset root resolution.
- `claudesk/core/errors.py`: small domain error taxonomy for expected not-found and validation failures at transport boundaries.
- `claudesk/core/db/`: schema, migrations, focused persistence modules, relationship queries, and CRUD helpers. The package entrypoint exports only infrastructure symbols: `SCHEMA_VERSION`, `db_path`, `get_connection`, and `init_db`.
- `claudesk/core/models.py`: Pydantic domain models.
- `claudesk/core/paper_ingest.py`: DOI add/merge service shared by API and agent tools.
- `claudesk/core/paper_status.py`: paper lifecycle status/feedback workflow shared by API, agent tools, and CLI.
- `claudesk/core/task_log_workflows.py`: shared task/manual-log creation and update workflows, including paper-mention normalization.
- `claudesk/core/paper_assets.py` and `paper_asset_ops.py`: managed asset storage and shared paper-asset operations.
- `claudesk/core/pdf_ingest*.py`: PDF ingest service, parser adapters, normalized blocks, chunks, pages, artifacts, cache cleanup, and page rendering helpers.
- `claudesk/core/pdf_context.py`: reusable PDF asset selection, bounded evidence payload assembly, image metadata, and resource-read context.
- `claudesk/core/retrieval/`: shared retrieval boundary for query parsing, source/project/paper/asset scoping, SQLite FTS5 lexical search, LanceDB semantic search, rank-based fusion, snippets, score metadata, and stable evidence locators.
- `claudesk/core/chat_workflows.py`: reusable chat attachment preparation/cleanup, linked-paper prompt helpers, message normalization, title derivation, and context-id extraction.
- `claudesk/core/paper_mentions.py`: `paper://` parsing/rendering and task/log mention normalization.
- `claudesk/sources/`: arXiv, bioRxiv, PubMed, and OpenAlex adapters.
- `claudesk/pipeline/`: fetch, dedupe, rank, digest write/format.

### Agent
- `claudesk/agent/capabilities/`: canonical registry, Pydantic schemas, gates, policy metadata, and execution.
- `claudesk/agent/exports/`: OpenAI/Pydantic-AI and MCP exports derived from the registry.
- `claudesk/agent/runtime.py`: provider runtime contracts and Pydantic AI API-provider adapter.
- `claudesk/agent/codex_runtime.py`: Codex app-server research runtime orchestration, config/session state, and MCP guardrails.
- `claudesk/agent/codex_transport.py`: JSONL RPC app-server transport client and approval-default handling.
- `claudesk/agent/codex_events.py`: Codex app-server notification normalization, transcript parsing/tailing, and text coalescing.
- `claudesk/agent/controller.py`: deterministic preflight for structured context and required capabilities.
- `claudesk/agent/context.py`: context resolution and resource-read recording support.
- `claudesk/agent/prompts.py`: system prompt assembly.
- `claudesk/agent/mcp_server.py`: official MCP Python SDK stdio server over the registry.
- `claudesk/agent/web.py`: public web search, page fetch, and source-specific full-text helpers.

## Data Model
Current schema version: `SCHEMA_VERSION = 37`.

Main entities:
- `papers`: source metadata, abstract, authors, journal/source abbreviation, ranking fields, lifecycle flags, digest marker, and legacy compatibility `note`.
- `digest_runs`: successful non-dry-run digest executions.
- `background_jobs`, `background_job_events`, and `background_job_failures`: durable local job lifecycle, progress, result, cancellation, retry, and failure history for API-triggered background work.
- `notes`, `note_papers`, `note_assets`, and `note_links`: first-class markdown notes plus manual and mention-derived paper links, derived note-to-note wikilink metadata, and durable managed images stored under `<vault>/assets/images` and referenced from Markdown as `asset://<id>`.
- `projects`: lightweight project anchors with metadata, status, tags, and optional `obsidian_note_path`.
- `project_milestones` and `project_milestone_todos`: structured project progress records and optional same-project task links.
- `todos`: UI Tasks, including one-level subtasks.
- `log_entries`: UI Log, including manual entries and completed-task ledger rows. Manual entries store markdown and linked paper ids; task rows point at completed root tasks and derive display/project/paper context from the current task tree.
- `chat_sessions` and `chat_messages`: persisted sessions with required `runtime_settings` JSON, visible turns, context snapshots, and Activity trace entries. Provider thread state stays private in `provider_state`.
- `chat_resource_reads`: read ledger for local resources provided to model turns.
- `chat_attachments`: chat-owned managed assets attached to user messages during the app lifetime.
- `assets` and `paper_assets`: shared managed asset records and paper links.
- `asset_pdf_pages`, `asset_parse_artifacts`, `asset_document_blocks`, `asset_text_chunks`: structured PDF parse/cache tables.
- Project join tables: `project_papers`, `project_todos`, `project_milestone_todos`, `project_log_entries`, `project_chat_sessions`.
- FTS tables: `papers_fts`, `notes_fts`, `todos_fts`, `projects_fts`, `log_entries_fts`, `asset_text_chunks_fts`.

Derived retrieval index:
- SQLite remains canonical for all search result payloads and evidence locators.
- The LanceDB semantic index is rebuildable local cache state under the machine-local retrieval-index path, outside Dropbox-synced vault content.
- Semantic rows cover papers, notes, projects, tasks, log entries, and parsed PDF chunks, store stable Claudesk locators, embedding model name/dimension/version, content hashes, and normalized `all-MiniLM-L6-v2` vectors.

Relationship rules:
- Project membership is many-to-many through join tables.
- Legacy task/log/chat project columns are read only by the schema migration, then removed; live project membership is join-table only.
- Legacy progress-log tables, progress FTS, and old task completion-log columns are migration-only and not live product state.
- `papers.note` is compatibility/migration state only; note content lives in `notes`.
- Managed files are resolved from relative paths under `<vault>/assets`; arbitrary absolute paths are not part of normal operation.

## Key Data Flows
### Digest
```text
enabled sources -> fetch_all -> dedupe -> rank -> write_digest -> SQLite -> Digest UI
```

Source failures are isolated. A successful zero-result source is allowed; if every selected source fails, the digest run fails before DB writes.

### UI Mutations
```text
React component -> frontend/src/api.ts -> FastAPI route -> core/domain helper -> commit -> query invalidation
```

Reusable business logic belongs in `claudesk/core/` or a focused service module when both UI routes and agent capabilities need it.

### Notes And Mentions
`paper://<id>` links are stable local references across notes, tasks, log entries, chat, and markdown-rendered UI. Note create/update parses mentions into `note_papers.mentioned` while preserving explicit manual links.

### Managed PDF Access
```text
PDF upload -> managed asset row/file -> optional parse -> normalized blocks/pages/chunks/images -> local PDF tools -> bounded text/image evidence
```

Agent tools never expose managed paths or dump whole PDFs into prompts.

PDF search result click-through is locator-based: PDF results that include paper and asset ids can open or focus the in-app PDF viewer, jump to the matched page, seed PDF.js text find from the original query, and draw parsed bbox evidence when available.

### Retrieval
```text
API/agent caller -> core retrieval request -> SQLite FTS5 and/or LanceDB -> SQLite hydration -> fused hits with snippets and locators
```

Lexical retrieval remains the API, agent, and frontend default backend. It uses SQLite FTS5/BM25 over papers, notes, projects, tasks, log entries, and PDF chunks, preserves exact matches first, then applies safe prefix matching, relaxed multi-term fallback, and RapidFuzz typo-tolerant reranking over bounded FTS candidate pools. Snippets are derived from the actual matched text. API and agent callers can explicitly request `semantic` or `hybrid`; frontend users opt into hybrid per surface with `Include semantic matches`. Semantic hits are always hydrated from live SQLite rows before leaving core retrieval. Semantic-only hits must pass conservative absolute and relative relevance thresholds, and hybrid keeps lexical hits while admitting semantic-only hits only after thresholding. Project, paper, source-type, and PDF asset scopes are enforced in core retrieval, not in API/UI glue.

The public Search route keeps lexical all-search backward compatible while accepting additive `backend=lexical|semantic|hybrid` and `type=all|papers|notes|projects|tasks|log|pdfs` query parameters. PDF results use bounded snippets plus stable paper, asset, chunk, page, section, block, and bbox locators. Semantic index maintenance is explicit through `/api/search/semantic-index/status`, `/rebuild`, and `/update`; the frontend exposes maintenance in Settings > Storage and there is no automatic scheduler.

## Chat And Agent Architecture
Each session stores a complete validated runtime configuration: backend, model, and the options applicable to that backend. Session creation copies global runtime defaults once. Session PATCH replaces runtime settings atomically and returns the updated detail. Global Settings changes affect future sessions; global instructions and permissions still apply to every new turn.

`ChatRuntimeSettings` and the backend catalog live in core config and supply validation plus `chat_runtime_catalog` in the existing Settings payload. The chat footer updates session state, and Settings updates creation defaults. Before streaming, core chat workflows build a fresh effective config from saved runtime settings plus global policy. Active-turn reservations prevent concurrent runtime changes or overlapping sends for the same session and are released on completion, failure, or cancellation.

`GET /api/chat/models` delegates model discovery to the existing provider runtimes. OpenAI uses the authenticated Models API and a core compatibility policy because that API does not provide request capabilities. Codex uses paginated app-server `model/list` metadata without starting a thread or turn. The process cache lasts 15 minutes, coalesces concurrent requests, and separates credential/runtime identities. Refresh failures may return same-identity cached results marked stale. Gemini and Claude use their built-in catalogs through this contract.

Chat and Settings reuse one local combobox with independent search and confirmed selection. Each discovered choice supplies generation fields and defaults; selecting a model replaces incompatible options in one atomic update. Saved unlisted models remain visible, but free-text submission is removed. Shared pending session creation prevents first-upload and runtime-save races.

OpenAI research chat uses `OpenAIResponsesModel` with `openai_store=False`. The existing Pydantic AI agent retains tool rounds, image inputs, activity normalization, and resource reads. Model capability profiles suppress unsupported sampling parameters and enable reasoning for supported families newer than the installed SDK's profile catalog.

Changing effective session settings clears only that session's provider state. Codex process identity depends on launch/global policy configuration; individual thread identity includes session settings. Switching between differently configured sessions therefore reuses the shared app-server process.

Chat tool execution lives in the backend. The React client sends a message, receives SSE events, and renders text plus Activity trace entries. It does not implement provider-specific tool-calling protocols.

Provider paths:
- API providers: Pydantic AI runtime adapter executes enabled Claudesk capabilities.
- Codex research chat: Codex app-server runtime receives registry-derived MCP tools from the local MCP server.

The Codex runtime keeps transport I/O, event/transcript normalization, and turn orchestration in separate modules so transcript/resource-read semantics can evolve without duplicating MCP or session setup.

Agent capabilities are thin adapters over core services and focused DB helpers. They do not call FastAPI routes or execute SQL directly. API-provider and MCP tool boundaries convert registry/domain exceptions into tool error payloads and roll back any pending transaction after failed capability execution.

SSE event types surfaced to the frontend:
- `text`: append assistant-visible text.
- `trace`: append a compact Activity entry for context/progress/tool/warning/error.
- `done`: finish the turn.

Current capability registry count: 50.

Read/context coverage includes public web, full-text fetch, paper search, recent papers, paper ids, project context with milestones and progress summary, note context, task/log list/search, `search_notes`, chat attachment context, and local PDF asset/RAG/page tools.

Write coverage is intentionally narrow: add/update tasks/logs/projects/notes, link/unlink project or note papers, create/update/link/unlink project milestones and milestone tasks, save/to-read papers, DOI ingest, and managed PDF attach/rename/parse. There are no agent delete, task completion/reopen, project-status, or broad paper-status tools.

## Architecture Constraints
- SQLite uses DELETE journal mode, not WAL, for Dropbox-safe syncing.
- API and CLI/jobs use separate connection paths.
- `claudesk/core/db/__init__.py` remains an infrastructure entrypoint, not a domain-helper barrel.
- DB migrations import only low-level connection/schema/utility helpers, not live domain CRUD modules.
- Agent capabilities call core services or focused DB helpers instead of executing SQL directly.
- Config and vault resolution are cached per process.
- Production frontend serving requires `frontend/dist`.
- Query keys must include all active filters.
- Theme-sensitive UI must use semantic tokens.
- New agent capabilities should execute core/domain logic directly, not call FastAPI over localhost.

## Current Gaps
- `seed_papers` is persisted but unused by ranking.
- Feedback is stored but not used for personalization.
- LanceDB index maintenance is explicit and user-triggered; there is no automatic background rebuild scheduler.
- Incremental semantic-index update currently uses the full rebuild fallback for stale/deleted-row correctness.
- OCR, figure/table crop extraction, PDF annotations, and direct PDF download remain future work.
- Browser coverage is focused, not exhaustive.
