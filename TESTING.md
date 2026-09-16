# claudesk Testing And Running Guide

## Prerequisites
```bash
python -m pip install --require-hashes -r requirements.lock
python -m pip install --no-deps --no-build-isolation -e .
(cd frontend && npm ci)
(cd frontend && npx playwright install chromium)
```

Requirements:
- Supported release-check target: Linux x86-64, Python 3.12, Node.js 24, npm 11.
- The Python lock includes CPU-only PyTorch and editable-build dependencies; no GPU is required.

Useful environment variables:
- `OPENAI_API_KEY`: OpenAI digest scoring and OpenAI API chat. Without it, configured topics use local embedding ranking; without topics, papers are sorted by date.
- `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) and `ANTHROPIC_API_KEY`: optional Gemini and Claude chat. See [provider setup](README.md#optional-ai-and-discovery-setup) for Codex installation and authentication.
- `OPENALEX_API_KEY`: required when OpenAlex is enabled.
- `CLAUDESK_DATA_DIR`: highest-precedence vault override.
- `CLAUDESK_LOCAL_CONFIG`: advanced override for the machine-local vault pointer.
- `CLAUDESK_OBSIDIAN_VAULT`: optional Obsidian export override.

## Running The App
Production:

```bash
(cd frontend && npm run build)
claudesk up --no-browser
```

Open `http://localhost:8765`. API docs are at `http://localhost:8765/api/docs`.

Development:

```bash
uvicorn claudesk.api.main:app --host 127.0.0.1 --port 8765 --reload
(cd frontend && npm run dev)
```

Open `http://localhost:5173`; Vite proxies `/api/*` to the backend.

Digest:

```bash
python -m claudesk.jobs.run_digest --dry-run
python -m claudesk.jobs.run_digest --source arxiv --days 1
python -m claudesk.jobs.run_digest
```

## Core Checks

`.github/workflows/ci.yml` installs a fresh locked environment, builds the frontend, and runs frontend units plus the backend suite. The fresh-vault API smoke below requires that build; it checks real application startup, default settings, credential-free note persistence, empty collections, and serving the built UI. It runs in an isolated subprocess and vault, without downloading embedding models or sending provider requests.

```bash
python -m pip check
(cd frontend && npm run build)
python -m unittest -q tests.test_api_frontend_static
```
Frontend typecheck/build:

```bash
(cd frontend && npm run build)
```

Frontend unit tests:

```bash
(cd frontend && npm run test)
```

Frontend browser tests:

```bash
(cd frontend && npm run e2e)
(cd frontend && npm run e2e:headed)
(cd frontend && npm run e2e:ui)
```

Focused note editor checks:

```bash
(cd frontend && npm run test -- MarkdownContent markdownCallouts noteBlocks)
(cd frontend && npm run e2e -- notes-pane.spec.ts -g "rich markdown editor|callout|admonition|metadata-bearing code fences|scrolling past the note end|bare autolinks|align numbering")
```

Python targeted suite:

```bash
python -m unittest -q tests.test_backend_architecture tests.test_lazy_imports tests.test_process_jobs tests.test_api_digest_process tests.test_api_settings_rubric_process tests.test_agent_capabilities tests.test_chat_sessions tests.test_agent_web_tools tests.test_biorxiv_source tests.test_pubmed_source tests.test_openalex_and_settings tests.test_paper_journal_metadata tests.test_projects tests.test_project_milestones tests.test_settings_registry tests.test_notes tests.test_paper_doi_deduplication tests.test_paper_doi_ingestion tests.test_doi_normalization tests.test_paper_delete tests.test_tasks tests.test_chat_backends tests.test_paper_assets tests.test_pdf_ingest tests.test_agent_pdf_tools
```

Backend quality gate:

```bash
python scripts/check_backend_quality.py
```

This dependency-free gate runs `compileall` over backend/tests/scripts, `tests.test_backend_architecture`, `tests.test_lazy_imports`, and `git diff --check`.

Doc or whitespace check:

```bash
git diff --check
```

There is no dependency-backed Python linter/typechecker or frontend lint command.

## Focused Backend Coverage
- Process jobs and lazy imports: `tests.test_lazy_imports`, `tests.test_process_jobs`, `tests.test_api_digest_process`, `tests.test_api_settings_rubric_process`.
- Backend boundaries: `tests.test_backend_architecture`.
- Source fetching/settings: `tests.test_biorxiv_source`, `tests.test_pubmed_source`, `tests.test_openalex_and_settings`, `tests.test_paper_journal_metadata`.
- Papers and lifecycle: `tests.test_paper_doi_deduplication`, `tests.test_paper_doi_ingestion`, `tests.test_doi_normalization`, `tests.test_paper_delete`.
- Notes/projects/tasks: `tests.test_notes`, `tests.test_projects`, `tests.test_project_milestones`, `tests.test_tasks`.
- Settings registry: `tests.test_settings_registry`.
- Paper assets/PDFs: `tests.test_paper_assets`, `tests.test_pdf_ingest`, `tests.test_agent_pdf_tools`.
- Chat/agent: `tests.test_chat_sessions`, `tests.test_chat_backends`, `tests.test_agent_capabilities`, `tests.test_agent_web_tools`.

## Playwright Guidance
Use Playwright for rendered frontend changes that affect layout, focus, keyboard behavior, menus, dialogs, chat flows, note editing, PDF viewing, responsive behavior, or screenshots.

Checked-in Playwright coverage currently includes:
- Settings navigation and dropdown/menu flows.
- Codex native capability toggles.
- Chat context tray attachment/removal/send payload, including the temporary-attachment notice before upload.
- Per-session runtime persistence, new-chat defaults, backend resets, failed-save retries, and disabled controls during turns or overlapping session updates.
- Shared discovered Chat/Settings dropdowns, search, refresh, stale/error messages, unlisted saved selections, disabled unsupported choices, and nullable model-specific controls.
- Concurrent first-chat attachment uploads/runtime saves and failed session-creation retries.
- Assistant Activity trace expansion.
- Chat attachment picker/paste/remove/send-payload flows.
- A real sandboxed browser form upload with an opaque Origin must return 403; the same attachment form from an allowed client must succeed.
- Pane outages: initial failure must show Retry instead of an empty list, refetch failure must retain cached rows, and failed Notes pagination must retry the same page without reloading earlier pages.
- Project workspace overview layout, derived research-state cues, tab-based resource navigation, and project-linked log creation.
- Project milestone progress layout, create/edit/delete actions, task linking, and overflow guards.

Prefer isolated test vaults via `CLAUDESK_DATA_DIR` for automated runs. Manual QA may use the normal vault, but note that explicitly.

## Codex Chat Smoke And Diagnostics
Run the opt-in smoke test after changing `claudesk/agent/codex_runtime.py`, `claudesk/agent/codex_transport.py`, `claudesk/agent/codex_events.py`, `claudesk/agent/mcp_server.py`, or Codex/MCP integration:

```bash
CLAUDESK_CODEX_SMOKE=1 python -m unittest -q tests.test_chat_backends.CodexAppServerSmokeTests
```

Provider tests also cover discovery pagination/cache/credential changes and mocked HTTP Responses streams with tool rounds, image continuation, reasoning, and storage disabled. Discovery smoke checks must not create a model turn; use a temporary vault and report whether the tested Codex home was authenticated.

Enable MCP inventory diagnostics before starting the backend:

```bash
CLAUDESK_CODEX_MCP_DIAGNOSTICS=1 claudesk up --no-browser
```

Diagnostics compare:
- registry-enabled tools
- MCP manifest tools
- Codex app-server registered tools

They prove registry/export/app-server alignment, not whether a model has preloaded every deferred tool name.

## Manual QA Priorities
High-value manual checks when relevant:
- Paper asset upload/rename/remove/parse/retry and file-health states.
- In-app PDF open, page navigation, zoom, fit-width, missing-file handling, light/dark mode.
- Rich note LIVE editing, source-mode CodeMirror editing, preview rendering, autosave, paper mention completion, overflow delete, and reload persistence.
- Rich note editor WYSIWYG Markdown links, math blocks, task lists, source mode, autosave, note switching, and reload persistence.
- Add Paper DOI dialog success, duplicate, warning, invalid DOI, and navigation behavior.
- Paper lifecycle default/dismissed-inclusive Digest/Search behavior.
- Projects create/edit/link flows and project task/log workflows.
- Persistent chat create/rename/delete/clear, context attachment, file upload, Activity/read-ledger display, and live model turns.
- Mobile overflow and keyboard/focus behavior in dense rows and icon-only actions.

## Common Failures
- `ModuleNotFoundError: No module named 'claudesk'`: run `pip install -e .`.
- Chat says LLM is not configured: export `OPENAI_API_KEY` or switch to a configured backend.
- OpenAlex source fails: export `OPENALEX_API_KEY` or disable OpenAlex.
- Frontend shows 503: run `(cd frontend && npm run build)` before production mode.
- Playwright cannot find Chromium: run `(cd frontend && npx playwright install chromium)`.
- `database is locked`: stop competing writer processes; API retries briefly but concurrent vault writes are not a supported workflow.
- Settings YAML edits do not apply: restart the process after manual file edits.
- API returns 400/403: use a loopback URL (`localhost`, `127.0.0.1`, or `[::1]`); remote Host headers and remote/opaque browser origins are rejected. Test clients must also use a loopback base URL.
- Digest ranks no papers: check hard include/exclude filters with `--dry-run`.
