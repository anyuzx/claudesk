# claudesk

`claudesk` is a local-first personal research assistant for paper discovery, notes, tasks, project coordination, managed PDFs, and chat over local research memory.

Claudesk is beta software. The supported installation is from source on Linux; packaged desktop installers and a stable 1.0 API are not available. Keep a backup of your vault before updating.

## License

Claudesk's original code is licensed under [GNU AGPL version 3](LICENSE) (`AGPL-3.0-only`). Copyright 2026 Claudesk contributors.

Third-party software and fonts retain their own licenses and notices. The default PDF parser, [PyMuPDF/MuPDF](https://pymupdf.readthedocs.io/en/latest/about.html#license-and-copyright), is used under its AGPL option. Bundled fonts are separately licensed under the SIL Open Font License; their copyright notices and complete license texts are listed in [Bundled fonts](frontend/public/fonts/README.md). Python and JavaScript dependencies are installed from their upstream packages, which supply their own notices.

Bundled English emoji data/messages and the derived GitHub shortcode map come from [Emojibase data 17.0.0](https://www.npmjs.com/package/emojibase-data/v/17.0.0) and retain its [MIT license and copyright notice](frontend/public/assets/emojibase/LICENSE.txt).

## What It Does
- Fetches papers from arXiv, bioRxiv, PubMed, and OpenAlex.
- Ranks papers with local embeddings and optional OpenAI rubric scoring.
- Tracks paper state as saved, read, to-read, and dismissed.
- Stores first-class markdown notes linked to papers by explicit links and `paper://` mentions.
- Tracks tasks, subtasks, and research log entries.
- Organizes papers, tasks, log entries, and chats around projects.
- Stores managed paper PDFs under a local vault, opens them in-app, parses them into structured blocks/chunks/pages, and exposes bounded evidence to chat tools.
- Supports managed chat attachments for long pasted text, text-like files, images/screenshots, and PDFs.
- Runs on a local SQLite database in a Claudesk vault directory.

## Current UI
The app is FastAPI + React.

Primary surfaces:
- Digest: ranked recent papers, fetch status, triage actions, and paper workspace.
- Saved: saved papers across all time.
- Notes: standalone markdown notes and paper-linked notes.
- Tasks: tasks, subtasks, priorities, due dates, to-read papers, and project assignment.
- Log: durable progress entries with paper tagging.
- Projects: project metadata, linked papers, tasks, log entries, notes/assets context, and chats.
- Search: local text search across papers, notes, projects, tasks, log entries, and parsed PDF chunks, with optional embedding enhancement.
- Settings: profile, discovery, ranking, AI chat, storage, appearance, integrations, and advanced settings.
- Chat: persistent side-panel chat with context attachments, Activity trace, and constrained local tools.

## Markdown Note Editing
Notes are stored as canonical Markdown. Live editing uses a Milkdown-on-ProseMirror rich Markdown editor with Claudesk-specific plugins for math, links, images, admonitions, paper mentions, and fenced code blocks. Source mode uses the full-note CodeMirror Markdown editor for direct Markdown editing, and preview mode uses the shared Markdown renderer.

Resolved note-to-note links are stored as readable id-backed Markdown such as `[@Target Note](note://104)` or `[@Target Note > Methods](note://104#Methods)`. Legacy `[[Target Note]]` wikilinks remain readable for unresolved/create-note workflows and are canonicalized on save once they resolve to a target note.

## Requirements
- Initial supported source-install target: Linux x86-64, Python 3.12, Node.js 24, npm 11.
- `requirements.lock` fixes the tested Python dependencies and uses CPU-only PyTorch; no GPU is required.
- Other platforms and Python versions are not yet covered by the release checks.

## Quick Start
Install Python 3.12 (including `venv`), Node.js 24/npm 11, and Git first. From a terminal:

```bash
git clone https://github.com/anyuzx/claudesk.git
cd claudesk
python3.12 -m venv .venv
source .venv/bin/activate

python -m pip install --require-hashes -r requirements.lock
python -m pip install --no-deps --no-build-isolation -e .
(cd frontend && npm ci)
(cd frontend && npm run build)

claudesk vault show
claudesk up --no-browser
```

Open `http://localhost:8765`. You can create notes, tasks, and projects immediately, without API keys or a configuration file. Use Settings to personalize your profile and discovery topics; Settings writes `interests.yaml` in the active vault. Discovery and AI features need the separate setup below.

For a first installation without overrides, the vault is `<project_root>/data`, created automatically. `claudesk vault show` reports the effective location and settings file; an existing machine-local pointer or `CLAUDESK_DATA_DIR` can select a different location. In later terminals, return to this checkout and activate `.venv` before running Claudesk.

To use a different vault, stop Claudesk, run `claudesk vault set /absolute/path/to/Claudesk`, check `claudesk vault show`, then restart. This selects a directory; it does not move existing data. Move the complete stopped vault if you want to keep its contents, and clear a conflicting `CLAUDESK_DATA_DIR` override. See [Data and sync](#data-and-sync).

## Optional AI And Discovery Setup
Set only the credentials you need in the environment of the terminal that starts Claudesk. Restart the server after changing its environment. Keep credentials out of `interests.yaml` and Git; Claudesk does not load a `.env` file automatically.

| Chat backend in Settings → AI Chat | Setup before starting Claudesk |
|---|---|
| OpenAI API | Set `OPENAI_API_KEY` to an OpenAI API key. |
| Gemini API | Set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`; `GEMINI_API_KEY` takes precedence). |
| Claude API | Set `ANTHROPIC_API_KEY`. |
| Codex | Install and sign in to Codex on this machine, with `codex` available on the server's `PATH`. |

For example, export an API key in your shell before `claudesk up --no-browser`. For Codex, follow the [official CLI installation instructions](https://developers.openai.com/codex/cli/), then run `codex login` and `codex login status`. Claudesk starts the app-server automatically using that local configuration and authentication. See [Codex authentication](https://developers.openai.com/codex/auth/) for API-key and headless sign-in options. Signing in to Codex does not configure the separate OpenAI API backend or digest scoring.

Choose the backend and a model from the dropdown in Settings → AI Chat, then start a new chat and send a short test message. Settings provides defaults for new chats; use the controls in an existing chat to change that chat. OpenAI and Codex discover model lists from the configured provider; use Refresh after changing account access. Gemini and Claude currently use built-in lists. Disabled entries are not yet supported by Claudesk, and a listed model is not a guarantee of account access or available quota.

For discovery, choose sources and topics in Settings. `OPENALEX_API_KEY` is required only when OpenAlex is enabled. OpenAI rubric scoring also uses `OPENAI_API_KEY`, independently of the chat backend. Without that key, configured topics still support local embedding ranking; without topics, papers are sorted by date. Fetching papers requires an internet connection.

Other environment variables:
- `CLAUDESK_DATA_DIR`: highest-precedence vault override.
- `CLAUDESK_LOCAL_CONFIG`: advanced override for the machine-local vault pointer file.
- `CLAUDESK_OBSIDIAN_VAULT`: optional Obsidian export override.

## Downloads And Data Sharing
- Initial dependency installation needs internet access. The first embedding ranking or semantic-index/search use downloads `sentence-transformers/all-MiniLM-L6-v2` from Hugging Face if it is not cached. Embedding computation runs locally; notes and abstracts are not sent to an embedding API. Model weights are not bundled in the source or Python lock. Basic notes, tasks, and text search do not need that download.
- PyMuPDF is the included local PDF parser. PyMuPDF4LLM, Docling, and MinerU are optional backends whose packages and any model downloads are not included in the supported install. OCR/scanned-PDF support is not part of this beta.
- Chat sends messages, assembled research context, selected attachments, and tool results to the chosen AI provider. Depending on the turn, this can include note text, paper/PDF excerpts, images, and project/task information. Enabled tools can retrieve more local context beyond the visible attachment tray. Provider account terms govern remote retention; local storage does not mean chat content stays on this device.
- Optional OpenAI rubric scoring sends paper metadata/abstracts and your research profile, topics, and rubric to OpenAI. Discovery and web tools send queries, identifiers, and requests to their upstream services, including arXiv, bioRxiv/Crossref, PubMed, OpenAlex, and requested public websites.
- The default UI/display fonts load from Google Fonts; locally bundled fonts are identified in Appearance settings. Markdown can also contain remote image URLs, which the browser requests when displayed.
- Chat-uploaded files, screenshots, and long pastes converted to attachments are temporary: the server clears them at shutdown and on the next startup after a crash. Closing a browser tab alone does not stop the server. Chat messages remain, but expired attachments cannot be reopened. For durable PDFs, upload through a paper's ASSETS tab; images uploaded into notes are also durable.

Use Settings → Storage to update the semantic search index, then enable the embedding toggle in the search surface where you want it. Index maintenance is manual; ordinary text search remains available without an index. Run Claudesk on loopback for one trusted local user; it has no multi-user authentication or supported public-server deployment.

## Run The App
Production mode serves the built frontend from FastAPI:

```bash
(cd frontend && npm run build)
claudesk up --no-browser
```

Open:
- app: `http://localhost:8765`
- API docs: `http://localhost:8765/api/docs`

If the frontend has not been built, non-API routes return a 503 page explaining the build command.

Development mode:

```bash
uvicorn claudesk.api.main:app --host 127.0.0.1 --port 8765 --reload
(cd frontend && npm run dev)
```

Open `http://localhost:5173`; Vite proxies `/api/*` to the backend.

Electron development uses the same backend and Vite dev server. Start the three
processes in separate terminals:

```bash
uvicorn claudesk.api.main:app --host 127.0.0.1 --port 8765 --reload
(cd frontend && npm run dev -- --host 127.0.0.1 --port 5173 --strictPort)
(cd frontend && npm run electron)
```

Electron loads `http://127.0.0.1:5173` by default. If Electron opens a blank
window with `ERR_CONNECTION_REFUSED`, verify that Vite is reachable from the same
environment:

```bash
curl -I http://127.0.0.1:5173/
```

If Vite is only reachable through `localhost`, override the renderer URL:

```bash
(cd frontend && CLAUDESK_ELECTRON_RENDERER_URL=http://localhost:5173 npm run electron)
```

Electron GPU diagnostics are enabled in the main process. After startup, inspect
the terminal output prefixed with `[claudesk:electron:gpu]`, or open DevTools and
run:

```js
await window.claudeskDesktop.getGpuDiagnostics()
```

Use `CLAUDESK_ELECTRON_GPU_MODE` to compare GPU behavior without changing code:

```bash
# Default Electron/Chromium behavior.
(cd frontend && CLAUDESK_ELECTRON_GPU_MODE=auto npm run electron)

# Fedora/Linux troubleshooting mode. Adds conservative Chromium GPU switches.
(cd frontend && CLAUDESK_ELECTRON_GPU_MODE=force npm run electron)

# Disable hardware acceleration for comparison.
(cd frontend && CLAUDESK_ELECTRON_GPU_MODE=off npm run electron)
```

## App Icon Assets
The source logo is `frontend/src/assets/claudesk-logo.svg`. The About dialog
imports that SVG directly.

Browser and desktop-runtime icon files are checked in under `frontend/public/`:
- `favicon.svg`: browser favicon.
- `apple-touch-icon.png`: Apple touch icon.
- `icon-192.png` and `icon-512.png`: web manifest icons.
- `site.webmanifest`: browser install metadata.

Electron uses `frontend/public/icon-512.png` as the runtime window/taskbar icon.
If installer or `.desktop` packaging is added later, point that packaging at the
same app icon asset.

After changing the source SVG, regenerate the public derivatives:

```bash
cp frontend/src/assets/claudesk-logo.svg frontend/public/favicon.svg
rsvg-convert -w 180 -h 180 frontend/src/assets/claudesk-logo.svg -o frontend/public/apple-touch-icon.png
rsvg-convert -w 192 -h 192 frontend/src/assets/claudesk-logo.svg -o frontend/public/icon-192.png
rsvg-convert -w 512 -h 512 frontend/src/assets/claudesk-logo.svg -o frontend/public/icon-512.png
```

## Configuration
Settings is the simplest way to create and edit configuration. For manual setup, use `examples/interests.example.yaml` as a template for the settings file reported by `claudesk vault show`. Copy it only if that file does not already exist, edit your own values, and restart Claudesk. For a custom or synced vault, use its `interests.yaml`, not the checkout's `data/interests.yaml`.

Main sections:
- `profile`: name, research fields, and free-text research context.
- `topics`: embedding search queries for ranking.
- `keywords.include` / `keywords.exclude`: hard filter before ranking.
- `tracked_authors`: papers from these authors stay eligible.
- `seed_papers`: stored but not used by ranking yet.
- `sources`: arXiv, bioRxiv, PubMed, and OpenAlex settings.
- `digest`: lookback window, per-source fetch cap, final digest size.
- `obsidian`: optional digest export.
- `llm`: scoring provider/model/rubric settings.
- `chat`: backend/model/tool settings.
- `paper_assets`: PDF parser backend.
- `ui`: backend-synced appearance mode.

Minimal example:

```yaml
profile:
  name: "Your Name"
  field:
    - "Biophysics"
    - "Chromatin biology"
  description: |
    Describe your current research focus.

topics:
  - "chromatin mechanics and nucleosome positioning"
  - "single-molecule force spectroscopy"

keywords:
  include:
    - "chromatin"
    - "optical tweezers"
  exclude:
    - "clinical trial"

tracked_authors:
  - "Dekker"

sources:
  arxiv:
    enabled: true
    categories: ["q-bio.BM", "q-bio.SC", "physics.bio-ph"]
  biorxiv:
    enabled: true
    categories: ["Biophysics"]
    provider: api
    fallback_provider: crossref
  pubmed:
    enabled: true
    query_mode: auto
  openalex:
    enabled: false

digest:
  days_back: 3
  max_per_source: 200
  top_n: 10
```

Notes:
- arXiv empty categories means no arXiv fetch.
- bioRxiv empty categories means all bioRxiv categories.
- PubMed `auto` builds from topics, include/exclude keywords, and profile fields.
- PubMed `builder` uses PubMed-specific concept/exclusion chips.
- PubMed `raw` preserves direct PubMed syntax from `search_terms`.
- `load_config()` is cached per process. UI Settings saves clear live-editable config; manual YAML edits require restart.

## Fonts
The frontend has four runtime font roles: UI, content, monospace, and display. Defaults are Space Grotesk, Crimson Pro, Commit Mono, and Nabla. Change them in Settings -> Appearance -> Fonts.

The picker is populated from `frontend/src/config/fonts.ts`. Local font files live under `frontend/public/fonts/`; record sources and licenses in `frontend/public/fonts/README.md`.

## Digest And CLI
Digest:

```bash
python -m claudesk.jobs.run_digest
python -m claudesk.jobs.run_digest --dry-run
python -m claudesk.jobs.run_digest --source arxiv --days 1
```

CLI:

```bash
claudesk up --no-browser
claudesk papers list --days 7
claudesk papers list --status saved
claudesk papers status 12 saved
claudesk papers dedupe --dry-run
claudesk papers dedupe --apply
claudesk todo add "Read the new paper" --priority high
claudesk todo list
claudesk todo done 3
claudesk log add "Compared pulling geometries" --project 1
claudesk log list --days 14
claudesk vault set /path/to/Claudesk
claudesk vault show
```

## Testing
Frontend build/typecheck:

```bash
(cd frontend && npm run build)
```

Frontend tests:

```bash
(cd frontend && npm run test)
(cd frontend && npm run e2e)
```

Targeted Python suite:

```bash
python -m unittest -q tests.test_lazy_imports tests.test_process_jobs tests.test_api_digest_process tests.test_api_settings_rubric_process tests.test_agent_capabilities tests.test_chat_sessions tests.test_agent_web_tools tests.test_biorxiv_source tests.test_pubmed_source tests.test_openalex_and_settings tests.test_paper_journal_metadata tests.test_projects tests.test_project_milestones tests.test_settings_registry tests.test_notes tests.test_paper_doi_deduplication tests.test_tasks tests.test_chat_backends tests.test_paper_assets tests.test_pdf_ingest tests.test_agent_pdf_tools
```

Backend quality gate:

```bash
python scripts/check_backend_quality.py
```

There is no dependency-backed Python linter/typechecker beyond the frontend build's TypeScript check.

## Project Structure
```text
claudesk/
  core/       config, DB, models, DOI ingest, paper assets, PDF ingestion
  api/        FastAPI routes and app wiring
  sources/    arXiv, bioRxiv, PubMed, OpenAlex fetchers
  pipeline/   fetch, dedupe, rank, digest write/format
  agent/      capability registry, runtimes, prompts, MCP server, web/PDF tools
  jobs/       digest and rubric-scoring entry points
frontend/
  src/        React + TypeScript app
docs/         topic-specific implementation and policy references
examples/     example vault config
tests/        targeted unit/integration tests
```

## Reference Docs
- `AGENTS.md` and `CLAUDE.md`: coding-agent handoff.
- `STATUS.md`: current implementation state and gaps.
- `PLAN.md`: active roadmap.
- `ARCHITECTURE.md`: architecture, data model, and agent design.
- `DECISIONS.md`: decisions not to reverse casually.
- `TESTING.md`: running and verification guide.
- `DESIGN.md`: UI design constraints.
- `docs/paper-sources.md`: source fetching and digest pipeline.
- `docs/paper-lifecycle.md`: paper lifecycle and retention policy.
- `docs/paper-assets.md`: managed asset model.
- `docs/agent-paper-asset-access.md`: managed PDF/chat attachment access for agents.

## Data And Sync
The active vault contains:

```text
<vault>/
  claudesk.db
  interests.yaml
  assets/
  backups/        # database snapshots created before schema upgrades
```

Rules:
- Each machine stores an unsynced pointer to the vault path via `claudesk vault set`.
- `CLAUDESK_DATA_DIR` overrides the pointer.
- A running server pins the effective vault until restart.
- SQLite uses DELETE journal mode, not WAL, for Dropbox compatibility.
- A same-machine lock rejects a second app instance using this vault, even on another port. Keep the `.claudesk-app.lock` file in place; the operating system releases the lock after exit or a crash.
- Stop Claudesk on one machine and let sync finish before opening the vault on another. The local process lock does not coordinate Dropbox clients or standalone CLI writers.
- Managed assets are portable relative paths under `<vault>/assets`.

Before an existing database schema is upgraded, Claudesk saves a SQLite snapshot under `<vault>/backups/`. Backup or migration failure stops startup. These snapshots contain database records, not `assets/` or `interests.yaml`; keep a separate copy of the whole stopped vault for full recovery. See [backup and restore](docs/release.md#backup-and-restore).

Vault migration:

```bash
claudesk vault set /path/to/Claudesk_Vault
claudesk vault show
claudesk vault assets audit
claudesk vault assets prune-missing --apply
claudesk vault assets audit --check
```

Move `assets/` with the DB/settings when you want to preserve managed PDFs. Omit `--apply` on `prune-missing` to preview metadata cleanup.

## Known Gaps
- `seed_papers` is stored but not used by ranking.
- Semantic search needs a manually maintained local index; no automatic rebuild scheduler is provided.
- OCR, PDF annotations, and Zotero/Paperpile integration remain future work. Chat tools can attach a PDF from a public HTTPS URL; a general PDF discovery/download interface remains a follow-up.
- Agent write tools are intentionally constrained and cannot complete/reopen/delete tasks or delete data.
