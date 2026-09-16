# claudesk Architecture Decisions

These decisions should not be reversed casually. Update this file when a decision changes materially.

## 1. SQLite Uses DELETE Journal Mode
**Decision:** both `claudesk.core.db::get_connection()` and `claudesk.api.deps::get_conn()` set DELETE journal mode, not WAL.

**Why:** the vault may live in Dropbox. WAL creates `-wal` and `-shm` sidecars that can sync out of order with the main DB file. DELETE journal mode keeps the local-first sync model simpler and safer for single-user use.

**If changed:** update both connection paths and test vault sync behavior on every target machine.

## 2. API And CLI Use Different SQLite Connection Helpers
**Decision:** FastAPI routes use `claudesk.api.deps::get_conn()`. CLI and jobs use `claudesk.core.db::get_connection()`.

**Why:** the API needs `check_same_thread=False` and a busy timeout for threaded request handling. CLI/jobs do not need the same singleton dependency.

**Rule:** never import the API connection helper into CLI/job/domain code, and never import the CLI/job helper into FastAPI routes.

## 3. Core Code Must Stay UI-Agnostic
**Decision:** `claudesk/core/` must not import from `claudesk/api/` or `claudesk/cli.py`.

**Why:** core services are reused by API routes, CLI commands, jobs, and agent capabilities. Importing UI/transport layers into core creates cycles and makes shared logic harder to test.

**Rule:** if API and agent capabilities need the same behavior, move reusable logic into core or a focused service module, then call it from thin adapters. DB modules own persistence helpers; focused core service modules own shared multi-step workflows; adapters own validation, output mapping, and commits.

## 4. Chat Providers Use Runtime Adapters Over One Capability Registry
**Decision:** API chat providers run through Pydantic AI runtime adapters. Codex research chat runs through Claudesk's Codex app-server adapter. All tool definitions and execution come from `claudesk/agent/capabilities/`.

**Why:** Claudesk should own local-resource policy, gates, schemas, and execution once. Provider-specific adapters should not duplicate tool definitions.

**If adding a provider:** add or update a runtime adapter/model mapping and keep capability execution through the registry.

## 5. Agent Tools Are Narrow And Policy-Gated
**Decision:** mutating agent tools are limited to approved task/project/log/note/paper/PDF-asset actions and are gated by domain-scoped `chat.tools.*` settings.

**Why:** the agent can help organize research state, but completion, deletion, project status, and broad paper-status changes are high-intent user actions.

**Intentional omissions:** no task completion/reopen/delete, no delete tools, no project-status mutation, and no broad paper-status mutation.

## 6. Managed PDFs Are Accessed By Asset Id, Not Filesystem Path
**Decision:** durable paper PDFs are copied under `<vault>/assets`, stored as managed relative paths, and accessed by paper/asset ids. Local PDF agent access goes through normalized parse tables, chunks, and page images.

**Why:** this keeps vaults portable, prevents arbitrary filesystem reads, and lets the backend bound text/image evidence returned to models.

**Rule:** do not expose absolute local paths to the browser or model. Do not dump whole PDFs into prompts.

## 7. The MCP Server Is A Transport Over The Registry
**Decision:** `claudesk/agent/mcp_server.py` uses the official MCP Python SDK. MCP `tools/list` and `tools/call` are derived from the same capability registry used by API chat.

**Why:** MCP is a transport boundary, not a second tool system.

**Rule:** do not add handwritten parallel MCP tool definitions or a second dispatcher.

## 8. Chat Streaming Uses SSE
**Decision:** chat uses `POST /api/chat/sessions/{session_id}/messages/stream` with `text/event-stream`.

**Why:** each turn is a one-way server-to-client stream; SSE is simpler than WebSockets and works cleanly through Vite proxying.

**Current event types:**
```json
{"type":"text","content":"..."}
{"type":"trace","entry":{"type":"tool_start","name":"..."}}
{"type":"done"}
```

Provider-native tool/progress/reasoning events are normalized inside backend runtime code. The frontend renders visible assistant text and compact Activity trace entries, not raw provider thinking.

## 9. Theme Uses CSS Variables And Tailwind v4 CSS-First Config
**Decision:** theme-sensitive colors are CSS variables and Tailwind v4 `@theme` tokens in `frontend/src/index.css`; there is no JavaScript Tailwind config.

**Why:** one light/dark class on `<html>` updates app colors without duplicating `dark:` classes. Settings owns the persisted `ui.theme_mode`; browser-local appearance preferences stay in localStorage where appropriate.

**Rule:** do not use Tailwind built-in colors for theme-sensitive UI. Use semantic tokens such as `bg-bg`, `bg-surface`, `text-primary`, `text-muted`, and `border-border`.

## 10. Server State Uses TanStack Query; UI State Uses Zustand
**Decision:** server/cache state is TanStack Query. Local app shell and interaction state is Zustand.

**Why:** fetched API data needs cache invalidation and filter-aware query keys; shell layout and current selection need fast local state.

**Rule:** query keys must include every filter or parameter that affects the result.

## 11. `load_config()` Is Cached
**Decision:** `claudesk/core/config.py::load_config()` is `@lru_cache(maxsize=1)`.

**Why:** config is read often and is process-local. UI Settings PATCH clears the cache for live-editable keys.

**Consequence:** manual edits to `<vault>/interests.yaml` require restarting the server or process.

## 12. Saved Papers Are Not Time-Windowed
**Decision:** `GET /api/papers` treats missing `days` as no date window.

**Why:** Saved papers represent explicit user intent and must remain visible across all time.

## 13. Authors Are Stored As A JSON Array String
**Decision:** `papers.authors` is TEXT containing a JSON array.

**Why:** it keeps schema simple while preserving author order. FTS tokenization still matches author names because JSON punctuation is ignored by the tokenizer.

## 14. Transport Boundaries Own Error Conversion And Transactions
**Decision:** shared core logic raises domain-appropriate Python errors. FastAPI routes, CLI commands, jobs, API-provider tool runtimes, and MCP tool runtimes convert those errors into their transport-specific responses or failures.

**Why:** core services are reusable only if they do not know about HTTP errors, CLI output, model tool payloads, or process-job reporting.

**Rule:** keep commits and rollbacks at explicit caller boundaries. Capability tool runtimes roll back pending transactions after failed capability execution or resource-read persistence, while successful mutating tools still commit in their existing handlers or adapters.

`claudesk/core/errors.py` defines the small shared taxonomy currently used for touched paths: `NotFoundError` and `ValidationError`. Add broader domain errors only when a workflow actually needs typed transport mapping.

## 15. Semantic Retrieval Index Is Derived Local Cache
**Decision:** SQLite remains the canonical search source of truth. The LanceDB semantic index is derived, rebuildable, machine-local cache state under the retrieval-index path, outside Dropbox-synced vault content.

**Why:** semantic search needs local vector storage, but vault portability and Dropbox-safe state require that rebuildable index files not become canonical synced data. Losing the LanceDB directory must not lose papers, notes, projects, tasks, log entries, PDF chunks, or evidence locators.

**Rule:** semantic results must hydrate live SQLite rows before returning API or agent payloads. PDF semantic hits must verify the live paper/asset/chunk relationship before returning evidence. LanceDB imports stay inside retrieval/vector modules; API routes, agent capabilities, and DB helpers call the retrieval service rather than depending on LanceDB directly.

**Current defaults:** lexical retrieval remains the API, agent, and frontend default backend. Frontend users can opt into `hybrid` retrieval independently per surface with `Include semantic matches`; pure `semantic` remains an explicit compatibility/advanced backend. The only embedding provider for this index is the local `all-MiniLM-L6-v2` path; remote embedding providers are not part of this design.

**Fast text policy:** lexical retrieval uses canonical SQLite FTS5 tables for papers, notes, projects, tasks, log entries, and PDF chunks. It preserves exact FTS5/BM25 matches as the strongest pass, then uses safe prefix matching, relaxed multi-term fallback, and RapidFuzz typo-tolerant reranking over bounded FTS candidate pools. It must not whole-vault fuzzy scan on every keystroke, and lexical/default requests must not import or warm the embedding stack.

**Relevance policy:** semantic-only results must pass conservative absolute and relative score thresholds before API, agent, or frontend payloads expose them. Hybrid search keeps lexical hits and admits semantic-only hits only after thresholding, so weak or arbitrary queries do not flood every note, task, log, project, or PDF chunk into results.

**UI/API policy:** `/api/search` may expose additive backend and result-type query parameters, but filtering remains enforced through core retrieval. Ordinary UI does not present normal search as a named Keyword/Meaning/Best mode. Search, Digest, Notes, Projects, Tasks, and Log each persist their own embedding enhancement preference; semantic index status and embedding model cost copy are shown only when that surface has enabled embedding search. Pane-local searches use a retrieval result-mode contract and ignore browse filters/sorts while the query is active. Explicit rebuild/update actions live in Settings > Storage next to managed paper PDFs; Search rows and pane-local rows do not run maintenance actions. The app does not run automatic index rebuilds in the background.

## 16. Background Jobs Are SQLite-Backed Local State
**Decision:** API-triggered background work uses SQLite `background_jobs`, `background_job_events`, and `background_job_failures` for durable lifecycle, progress, result, cancellation, retry, and failure history. Live thread/process handles stay in memory only and are keyed by durable job id.

**Why:** Claudesk is a local-first single-user app. Digest, rubric scoring, PDF parse, semantic index, and future extraction/backfill work need crash-visible state and auditable failures, but not a distributed queue or service dependency.

**Rule:** do not add Celery, Redis, a scheduler daemon, or a broad worker framework for local background work unless SQLite plus the existing thread/process runners hits a concrete blocker. Store metadata, bounded JSON payloads, resource ids, and machine/executor facts in SQLite; do not store Python handles, queues, arbitrary local paths, or process objects.

## 17. Chat Runtime Settings Belong To Sessions
**Decision:** `chat_sessions.runtime_settings` stores each session's backend, explicit model, and supported generation options. Global chat runtime Settings are creation defaults. Instructions, capability gates, skills, native Codex permissions, and credentials remain global.

**Rules:** create sessions with materialized defaults; replace runtime settings atomically; reset to the target backend's defaults on a backend switch; never fall back to current global runtime defaults when reading a saved session. Use the shared core runtime model/catalog for offline validation and discovered model metadata for selection and applicable controls. There is one model field; the picker accepts discovered choices only while retaining saved unlisted IDs for display.

Runtime changes invalidate only that session's provider state. No-op or metadata changes do not. Reject runtime updates and overlapping sends during an active turn. Codex's shared process identity excludes session runtime options; thread identity includes them.

**Beta update:** schema v42 initializes existing session runtime settings once and clears old provider state while preserving chat data. Retired or backend-inapplicable YAML runtime keys must be removed directly before starting the updated app; no legacy config aliases or read-time fallback paths are maintained.

## Model discovery and OpenAI Responses

**Decision:** discover OpenAI and Codex models through their configured provider runtimes, with one shared Chat/Settings dropdown and a 15-minute cache. Gemini and Claude retain built-in lists. Discovery is independent of config loading and saved-session parsing.

**Why:** provider availability changes independently of Claudesk releases. Codex advertises model capabilities; OpenAI's Models API supplies identifiers only, so a small explicit compatibility policy gates new selections and parameter controls. Unknown conversational OpenAI IDs are visible but disabled until verified; specialized non-chat models are excluded.

**Rules:** do not use hardcoded OpenAI/Codex suggestions as a discovery fallback. Coalesce requests, isolate caches by credentials/runtime identity, offer explicit refresh, and report stale/error state. Use OpenAI Responses directly with provider storage disabled and the existing agent/tool pipeline; do not keep a parallel Chat Completions chat adapter.

## Local HTTP Trust Boundary

**Decision:** the single-user API accepts only loopback Host headers and, when supplied, loopback browser origins. Remote and opaque (`null`) origins are rejected before dispatch, including ordinary form uploads. Native local clients may omit Origin. Loopback development ports are trusted; this is not authentication against other local processes or a supported remote-hosting mode.

**Rules:** preserve streaming with the shared ASGI request guard. Agent web requests and PDF URL downloads share the core public-HTTP boundary: validate each destination before dispatch, including redirects, and fail closed on DNS lookup errors. Redirects are bounded to five hops. PDF downloads require HTTPS at every hop and retain their streamed size limit. DNS validation and connection resolution remain separate, so protection against DNS rebinding is not claimed.

## Vault Startup And Recovery

**Decision:** one app process owns a vault on a machine, from before initialization through shutdown. A persistent advisory lock excludes competing app instances without preventing the owner's worker processes from using SQLite. It does not coordinate machines sharing a synced folder or standalone CLI writers.

**Rules:** reject newer database schemas before schema writes. Use SQLite's backup API to snapshot an existing older file database before schema creation or migration, using the connection's actual database path. A failed backup or migration aborts startup before job reconciliation and attachment cleanup. Keep completed recovery snapshots: migrations contain intermediate commits, so rollback alone is insufficient. Publish both configuration files with a shared atomic YAML writer. Do not add a parallel vault manager or a new storage dependency.
