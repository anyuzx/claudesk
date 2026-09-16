# Agent Instructions

## Snapshot
- App: local-first personal research assistant built with FastAPI, React, and SQLite.
- Current phase: Phase 3 feature work is active; Phase 2 core app is complete.
- Current baseline: read `STATUS.md` for the latest branch/head, verified commands, and gaps.
- No next feature is preselected. Read `PLAN.md` before choosing work.

## Read Order
- `CLAUDE.md`
- `STATUS.md`
- `PLAN.md`
- `ARCHITECTURE.md`
- `DECISIONS.md`
- `TESTING.md`
- `DESIGN.md` for frontend or UX work

## Commands
| Task | Command |
|---|---|
| Install backend | `pip install -e .` |
| Install frontend | `(cd frontend && npm install)` |
| Production run | `(cd frontend && npm run build) && claudesk up --no-browser` |
| Backend dev | `uvicorn claudesk.api.main:app --host 127.0.0.1 --port 8765 --reload` |
| Frontend dev | `(cd frontend && npm run dev)` |
| Frontend build/typecheck | `(cd frontend && npm run build)` |
| Frontend unit tests | `(cd frontend && npm run test)` |
| Frontend browser tests | `(cd frontend && npm run e2e)` |
| Digest smoke test | `python -m claudesk.jobs.run_digest --dry-run` |
| Targeted Python suite | `python -m unittest -q tests.test_lazy_imports tests.test_process_jobs tests.test_api_digest_process tests.test_api_settings_rubric_process tests.test_agent_capabilities tests.test_chat_sessions tests.test_agent_web_tools tests.test_biorxiv_source tests.test_pubmed_source tests.test_openalex_and_settings tests.test_paper_journal_metadata tests.test_projects tests.test_project_milestones tests.test_settings_registry tests.test_notes tests.test_paper_doi_deduplication tests.test_tasks tests.test_chat_backends tests.test_paper_assets tests.test_pdf_ingest tests.test_agent_pdf_tools` |

## Key Conventions
- `claudesk/core/` must not import from `claudesk/api/` or `claudesk/cli.py`.
- API routes use `claudesk/api/deps.py::get_conn()`; CLI and jobs use `claudesk/core/db.py::get_connection()`.
- Every DB write needs `conn.commit()`.
- SQLite uses DELETE journal mode because the vault may be Dropbox-synced; do not switch to WAL casually.
- `load_config()` and the effective vault path are cached per process. UI Settings PATCH clears live-editable config; manual YAML/vault-pointer edits require restart.
- Use semantic theme tokens only for theme-sensitive UI. Do not use Tailwind built-in color utilities such as `bg-black`, `text-white`, or `bg-gray-*`.
- Frontend UI uses local shadcn Base UI-backed wrappers. For UI work, search `frontend/src/components/ui/`, `frontend/src/components/Pane.tsx`, `SettingsControls`, and nearby feature components first. If a reusable primitive is missing, copy/adapt it from shadcn Base UI into `frontend/src/components/ui/`; feature code should import local wrappers, not Base UI primitives directly. Hand-code reusable primitives only when local/shadcn reuse does not fit, and state why.
- Server state is TanStack Query; UI/layout state is Zustand. Query keys must include every active filter.
- Project links are many-to-many through join tables. Do not regress to single-project ownership.
- Notes are first-class records linked through `note_papers`; `papers.note` is compatibility/migration state only.
- Managed PDFs live under `<vault>/assets`. Agent and browser access must go through asset ids, normalized parse tables, chunks, and rendered page images, never arbitrary local paths.
- Current capability registry count is 43. It includes project/note/chat-attachment context, local PDF tools, `search_notes`, and the approved task/project/log/note/paper/PDF-asset write yes-list.
- Agent tools intentionally exclude task completion/reopen/delete, project status mutation, broad paper-status mutation, and delete tools for projects/logs/notes/papers/assets.

## Codebase Maintenance
- Prefer modifying existing modules over adding new files, wrappers, routes, components, or dependencies.
- Before adding code, search for similar behavior and reuse or refactor the smallest coherent existing module.
- Add a new abstraction only when it removes real duplication or isolates a real boundary.
- Keep domain logic in core/domain modules and keep UI components thin.
- Remove obsolete code when replacing behavior; do not leave parallel old/new implementations without a reason.
- Do not add production dependencies without explicit approval.
- Run relevant tests, type checks, and `git diff --check` before handoff.

## Commit Attribution
AI commits should include:

```text
Co-Authored-By: OpenAI Codex <noreply@openai.com>
```

## Review
For reviews, follow `code_review.md`.
