# claudesk Active Plan

**Last reviewed:** 2026-09-15
**Primary surface:** FastAPI + React at `http://localhost:8765`

## Purpose
Claudesk is a local-first personal research assistant with four practical jobs:

1. Surface relevant new papers.
2. Track tasks and research progress.
3. Organize work around projects.
4. Provide a constrained chat agent over local research memory, managed PDFs, chat attachments, and limited public-web tools.

This file is the active roadmap. `STATUS.md` is the current implementation snapshot.

Issue numbers from private development below refer to the archived tracker; public follow-up issues can be created separately.

## Public Beta Release Work

Work in this order. Complete plan, implementation, independent review, review fixes, and verification for each area before starting the next. Keep source installation as the initial distribution method; publishing, pushing, and changing repository visibility are separate release actions.

| Area | Minimum scope | Status |
|---|---|---|
| 1. Reliable installation | Bound the compatible Pydantic AI major; lock a supported dependency set; add clean-install CI and empty-vault/core-flow checks. | Complete: independent review fixes verified; clean install, 617 backend tests (2 opt-in skips), 262 frontend tests, build, and quality gate passed. Hosted CI awaits a future push. |
| 2. Local request security | Validate Host and mutation Origin centrally; check every web/PDF redirect before requesting it. | Complete: independent review and fixes closed, including the later PDF downloader audit. Web and PDF downloads share one core policy; unsafe destinations are rejected before dispatch. See STATUS.md for verification and remaining audit limits. |
| 3. Vault safety | Reject duplicate app processes before initialization; back up before migration and abort on failure; save configuration atomically; document restore. | Complete: independent review and shutdown fixes verified; backup restoration, restart, atomic-write failures, and competing-process tests passed. |
| 4. Publication licensing | Use the user-selected AGPL-3.0 license; resolve PyMuPDF/font notices; scan historical content for secrets. | Complete for current source: independent review, license/archive checks, font browser validation, and historical credential scan passed. Removed fonts remain in private history; publication requires the separate history gate in docs/release.md. |
| 5. Honest load failures | Reuse error/Retry UI in existing panes; retain cached content after refresh failures. | Complete: independent review, build, 263 unit tests, and five outage browser tests passed, including Settings draft retention. |
| 6. First-use instructions | One correct install/vault path; all provider setup; download/data-sharing details; disclose attachment expiry before upload. | Complete: README/example and composer reuse reviewed; build, pre-upload browser check, example validation, and vault ignore checks passed. |

Release acceptance: clean source installation, useful notes/tasks without credentials, one configured chat provider, PDF use, restart and backup restoration, and rejection of competing launches and hostile requests without changing vault data. Existing feature lanes below remain follow-up work, not additional beta requirements.

## Current Baseline
- Core app: SQLite vault, source fetching, dedupe, ranking, digest writing, CLI, FastAPI API, React frontend.
- UI tabs: Digest, Saved, Notes, Tasks, Log, Projects, Search, Settings, plus persistent Chat.
- Coordination model: first-class notes, many-to-many projects, `paper://` mentions, task/log paper mentions, and recoverable paper lifecycle state.
- Managed resources: durable paper PDFs under `<vault>/assets`, structured PDF parsing, in-app PDF viewer, local PDF RAG/page-image tools, and chat-owned attachments.
- Agent layer: canonical capability registry, Pydantic AI API runtimes, Codex app-server research runtime, official MCP SDK server, Activity trace, context attachments, and read ledger.

## Roadmap Lanes
### 1. AI Context And Chat Workflow
Goal: make the assistant use local research memory deliberately, transparently, and with low friction.

Current foundation:
- Visible context tray and backend context resolver.
- Persisted Activity trace.
- Backend read ledger and compact Activity evidence UI.
- Managed chat attachments for text, image, and PDF context.
- Deterministic preflight for structured required capabilities.
- Per-session runtime settings with backend-aware controls and Settings defaults for new sessions (#71).

Next candidates:
- #130 Support editing and resending prior user chat messages.
- #25 Build central AI context engineering layer follow-ups on read-ledger memory/audit UI and managed resource lifecycle.
- #23 Add Summarize button in paper abstract/notes panel.

Constraints:
- Keep raw provider thinking hidden.
- Keep prompt/context assembly centralized.
- Agent access to local files and PDFs must go through Claudesk-managed capabilities.

### 2. Search, Ranking, And Personalization
Goal: improve recall and relevance without breaking predictable lexical search.

Next candidates:
- #27 Implement `seed_papers` in ranking.
- #28 Follow up on retrieval quality and freshness in the existing optional semantic search.
- Add semantic/hybrid PDF retrieval as a new named tool rather than changing lexical PDF tools in place.
- Decide how feedback rows should affect ranking/personalization.

Constraints:
- Preserve existing FTS behavior for exact terms, names, IDs, and methods.
- Add semantic/hybrid features explicitly and keep them auditable.

### 3. Full-Text And PDF Assets
Goal: make managed paper files useful for reading, retrieval, and future annotation.

Current foundation:
- Durable asset store, upload/list/rename/remove/open.
- Structured PDF blocks/chunks/pages/artifacts.
- Local RAG, search, section read, page text, and page-image tools.
- Chat-owned PDF attachments reuse the same cache path.

Next candidates:
- #31 Broader PDF discovery/download interface beyond the existing agent HTTPS attachment tool.
- #64 Add persistent PDF annotation model.
- #65 Add PDF annotation overlay and agent-authored marks.
- #57 Generalize paper asset ingestion beyond PDFs.
- OCR/scanned-PDF path and cropped figure/table extraction.

Constraints:
- Keep source files, parser artifacts, normalized blocks, chunks, page images, and future embeddings separable and rebuildable.
- Do not expose arbitrary filesystem paths or whole-PDF dumps to models.

### 4. Workflow Polish And Accessibility
Goal: reduce daily friction in the existing app rather than broad redesign.

Next candidates:
- #102 Fix narrow-window overflow risks in dense desktop UI rows.
- #101 Use consistent confirmation and recovery for destructive actions.
- #100 Make empty loading and error states more actionable.
- #98 Standardize compact select and dropdown controls.
- #97 Make hover-only row actions usable without hover.
- #96 Restore visible focus states across compact controls.
- #95 Add accessible names to form controls and icon-only actions.
- #19 Make project tasks operable from project view.
- #18 Keep renamed chats synchronized in project-related chats.
- #16 Fix stale project name under task when no project is selected.
- #11 Remove linked-paper count from note list pane.
- #34 Finalize logo/app icon.

Constraints:
- Follow `DESIGN.md`: dense, quiet, token-based, accessible, and workspace-oriented.
- Use existing shared controls before adding new component surface.

### 5. Integrations
Goal: connect Claudesk to external research systems while preserving the local-first data model.

Next candidates:
- #30 Zotero/Paperpile integration design.
- #29 Obsidian export for first-class notes.
- #94 Electron macOS-first desktop wrapper and native shell design.
- Decide how far `obsidian_note_path` should go: simple open/create actions or richer vault-aware context.

Constraints:
- Keep API keys and provider CLI auth machine-local.
- Do not turn Claudesk into a full replacement for a note app or reference manager.

## Known Gaps
- `seed_papers` is persisted but ignored by `pipeline/rank.py`.
- Optional semantic search is implemented; its local index needs manual updates and has no automatic rebuild scheduler.
- OCR/scanned-PDF handling, PDF annotations, a general PDF discovery/download interface, and broader asset ingestion are not implemented. The agent can already attach a PDF from an HTTPS URL.
- Some Settings registry fields are stored before they are fully consumed by runtime behavior.
- Browser coverage is still focused on Settings, chat context/activity/attachments, and selected flows.
- No linter, formatter, Python typechecker, or frontend lint config is configured.

## Invariants
- Do not collapse many-to-many project relationships back to single `project_id` ownership.
- Do not reintroduce `papers.note` as the note product path.
- Do not mix API `get_conn()` with CLI/job `get_connection()`.
- Do not switch SQLite from DELETE journal mode to WAL without revisiting Dropbox sync.
- Do not assume manual edits to `<vault>/interests.yaml` hot-reload.
- Do not import `api/` or `cli.py` from `claudesk/core/`.
- Do not use Tailwind built-in color utilities for theme-sensitive UI.
- Do not add agent completion/reopen/delete tools unless product policy changes.

## Resume Workflow
1. Read `STATUS.md`, this file, `DECISIONS.md`, and `TESTING.md`.
2. Check `git status --short`.
3. Pick one issue or lane and keep scope focused.
4. Reuse existing modules and update tests for changed behavior.
5. Run relevant checks plus `git diff --check`.
6. Update `STATUS.md` when the current state, verified commands, or known gaps change.
