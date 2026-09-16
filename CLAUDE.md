# claudesk Agent Guide

## Current Shape
- Local-first research assistant for paper discovery, notes, tasks, progress log, projects, managed PDFs, and chat.
- Stack: FastAPI backend, React/Vite frontend, SQLite database under the active Claudesk vault.
- Current app tabs: Digest, Saved, Notes, Tasks, Reading Queue, Log, Projects, Search, Settings, plus persistent side-panel Chat.
- Current schema version: `SCHEMA_VERSION = 42`.
- Current capability registry count: 50.

## Start Here
1. `STATUS.md` - current implementation snapshot, latest verified commands, known gaps.
2. `PLAN.md` - active roadmap and next candidates.
3. `ARCHITECTURE.md` - boundaries, data model, and agent design.
4. `DECISIONS.md` - decisions not to reverse casually.
5. `TESTING.md` - commands and QA expectations.
6. `DESIGN.md` for frontend/UX work.
7. The files you intend to change.

## Core Commands
```bash
python -m pip install --require-hashes -r requirements.lock
python -m pip install --no-deps --no-build-isolation -e .
(cd frontend && npm ci)

(cd frontend && npm run build)
claudesk up --no-browser

uvicorn claudesk.api.main:app --host 127.0.0.1 --port 8765 --reload
(cd frontend && npm run dev)

python -m claudesk.jobs.run_digest --dry-run
(cd frontend && npm run test)
(cd frontend && npm run e2e)
```

Targeted Python suite:

```bash
python -m unittest -q tests.test_backend_architecture tests.test_lazy_imports tests.test_process_jobs tests.test_api_digest_process tests.test_api_settings_rubric_process tests.test_agent_capabilities tests.test_chat_sessions tests.test_agent_web_tools tests.test_biorxiv_source tests.test_pubmed_source tests.test_openalex_and_settings tests.test_paper_journal_metadata tests.test_projects tests.test_project_milestones tests.test_settings_registry tests.test_notes tests.test_paper_doi_deduplication tests.test_paper_doi_ingestion tests.test_doi_normalization tests.test_paper_delete tests.test_tasks tests.test_chat_backends tests.test_paper_assets tests.test_pdf_ingest tests.test_agent_pdf_tools
```

## Repo Map
- `claudesk/core/`: config, focused DB modules, models, embeddings, LLM helpers, DOI ingest, paper lifecycle workflows, task/log workflows, paper assets, PDF ingestion, paper mentions.
- `claudesk/sources/`: arXiv, bioRxiv, PubMed, OpenAlex source adapters.
- `claudesk/pipeline/`: fetch, dedupe, rank, digest write/format.
- `claudesk/api/`: FastAPI routes, app setup, streaming chat, settings, process jobs.
- `claudesk/agent/`: canonical capability registry, policy, context, prompts, runtime adapters, MCP server.
- `claudesk/jobs/`: digest and rubric-scoring entry points.
- `frontend/src/`: React app, state, API client, components, tests.
- `tests/`: targeted backend/unit integration coverage.
- `data/`: default local vault, gitignored.

## Current Product Facts
- Notes are first-class markdown records. Paper links are many-to-many through `note_papers`; `paper://<id>` mentions derive additional links. Note-to-note link metadata is derived into `note_links`; resolved note links are stored as readable `note://<id>` Markdown while legacy `[[Title]]` wikilinks remain supported for unresolved/create-note flows. Managed note images are durable vault assets stored under `<vault>/assets/images`, linked through `note_assets`, and referenced from Markdown as `asset://<id>`.
- Projects are many-to-many across papers, tasks, log entries, and chat sessions.
- Project milestones are first-class project progress records with counts-only progress summaries, optional task links through `project_milestone_todos`, and controlled agent milestone tools.
- Tasks use the `todos` table and `/api/tasks`; Log uses `log_entries` and `/api/log`.
- Tasks support one subtask level through `todos.parent_id`. Completing a root task creates one deduped `task` log row in `log_entries`; task-log display fields, project links, and paper links are derived from the current task tree.
- Paper lifecycle state separates saved/read/to-read/dismissed. Dismissed papers are hidden from default list/search surfaces but remain recoverable.
- Managed PDF assets are copied under `<vault>/assets`, linked through `paper_assets`, parsed into normalized blocks/chunks/pages, and opened through safe paper/asset-id endpoints.
- Each chat owns its backend/model/runtime settings; Settings defines defaults for new chats. Instructions, tool permissions, skills, and credentials remain global.
- Chat has visible context attachments, managed chat file uploads, persisted Activity trace entries, and a backend read ledger for local resources provided to model turns.
- API chat providers use Pydantic AI runtime adapters. Codex research chat uses the Codex app-server runtime plus registry-derived MCP tools.
- The MCP server uses the official MCP Python SDK and exports the same canonical capability registry used by API chat.
- Capability tool runtimes roll back pending transactions after failed tool execution and convert errors at the provider/MCP boundary.

## Capability Policy
Read/context tools include web/page fetch, paper search, recent papers, paper ids, PDF asset structure/RAG/page tools, project context, note context, task/log listing/search, `search_notes`, and chat attachment context.

Write tools are deliberately narrow:
- Tasks: add task, add subtask, update text/priority/due date/project links.
- Log: add/update log entries.
- Projects: create/update metadata, link/unlink papers, and create/update/link/unlink milestones and milestone tasks.
- Notes: create/update and link/unlink papers.
- Papers/assets: save paper, add to reading queue, add by DOI, rename/parse/attach managed PDF assets.

There is intentionally no agent tool for task completion/reopen/delete, data deletion, project-status mutation, or broad paper-status mutation.

## Hard Boundaries
- `core/` never imports `api/` or `cli.py`.
- API routes use `get_conn()`; CLI/jobs use `get_connection()`.
- Agent capabilities use core services or focused DB helpers, not FastAPI routes or direct SQL.
- Every write commits.
- Keep SQLite DELETE journal mode.
- Legacy project columns are migration-only; live project membership uses join tables.
- Do not reintroduce `papers.note` as a product path.
- Use semantic UI tokens and keep Tailwind v4 configuration CSS-first in `frontend/src/index.css`.
- Frontend UI uses local shadcn Base UI-backed wrappers under `frontend/src/components/ui/`. For frontend/UX work, follow `DESIGN.md`: reuse local wrappers first, copy/adapt missing shadcn Base UI primitives into the local UI library second, and hand-code reusable primitives only as a documented last resort.

## Definition Of Done
- Smallest coherent diff, reusing existing modules where possible.
- Relevant tests/checks run, plus `git diff --check`.
- `STATUS.md` updated when feature work changes the current state or known gaps.
