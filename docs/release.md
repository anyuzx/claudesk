# Claudesk Release Process

Claudesk currently uses a lightweight manual GitHub release process. A release is a source snapshot identified by an annotated `vX.Y.Z` tag. This process does not publish to PyPI, bundle the built frontend into a wheel, or build Electron installers.

## Reproducible Source Installation

The initial supported target is Linux x86-64 with Python 3.12 and Node.js 24. `requirements.lock` contains hashed runtime dependencies plus Hatchling and its editable-install helper; `frontend/package-lock.json` fixes the frontend dependency tree. CPU-only PyTorch avoids requiring CUDA for local embeddings. Pydantic AI stays below version 2 because the current runtime uses the version 1 model-profile API.

In a fresh Python 3.12 environment, install and check:

```bash
python -m pip install --require-hashes -r requirements.lock
python -m pip install --no-deps --no-build-isolation -e .
python -m pip check
(cd frontend && npm ci && npm run build)
python -m unittest -q tests.test_api_frontend_static tests.test_chat_backends
```

Regenerate the Python lock with `uv` (a maintainer tool, not an app dependency), using Python 3.12. Existing pins are retained unless an explicit upgrade is requested:

```bash
printf '%s\n' hatchling editables | uv pip compile pyproject.toml - --python-version 3.12 --python-platform x86_64-unknown-linux-gnu --torch-backend cpu --index https://download.pytorch.org/whl/cpu --generate-hashes --emit-index-url --output-file requirements.lock
```

Keep the emitted CPU package index: `torch` versions ending in `+cpu` are not hosted on PyPI. After a dependency change, recreate the environment from the lock and run the complete CI command set. Do not export `pip freeze` from a personal environment, which may include unrelated packages and private editable paths.

The `Source install and tests` GitHub Actions workflow runs these installation checks, the built-frontend API smoke, frontend unit tests, and the backend suite without API keys or embedding-model downloads. Require a successful run on the release commit before tagging; local tests alone do not establish that hosted CI passed.

## Version Policy

- Use SemVer without a leading `v` in files: `X.Y.Z` or an explicit prerelease such as `X.Y.Z-rc.1`.
- Use the leading `v` only for Git tags: `vX.Y.Z`.
- Before `1.0.0`, use patch releases for fixes and docs, and minor releases for user-visible features, schema migrations, or release-process changes.
- `pyproject.toml` is the canonical app version. `claudesk.__version__`, `frontend/package.json`, and `frontend/package-lock.json` must stay synchronized.
- Record the database `SCHEMA_VERSION` in each release note when it changes.

## Backup And Restore

Stop all Claudesk apps, CLI writers, and background work before copying or restoring a vault. For synced vaults, stop usage on every machine and finish synchronization first. The same-machine app lock cannot coordinate independent machines or standalone CLI commands. Do not delete `.claudesk-app.lock` to bypass an active process; an exited process releases its OS lock automatically.

Keep a separate copy of the entire vault (`claudesk.db`, `interests.yaml`, and `assets/`) before updating. The machine-local `local.yaml` pointer and API credentials are outside the vault. Before upgrading an older on-disk database schema, startup also creates a uniquely named database-only snapshot under the database's sibling `backups/` directory. New and already-current databases do not create upgrade snapshots. Failed backups stop migration; failed migrations stop startup and report the retained snapshot path. Because older migrations can commit intermediate steps, do not assume a failed migration rolled back the original database.

To recover after a migration failure:

1. Stop Claudesk and preserve the failed vault as a separate copy for diagnosis. Keep its `backups/` directory.
2. Copy the complete pre-update vault to a new recovery directory. If only the automatic database snapshot is available, copy the stopped vault's `assets/` and `interests.yaml` alongside that snapshot, then name the snapshot copy `claudesk.db`. A database snapshot alone cannot recover missing asset files.
3. Use the previous compatible source checkout and its dependencies, or a version containing the migration fix. A version older than the recovered schema is rejected. Select the recovery directory with `claudesk vault set /absolute/path/to/recovered-vault`; remove a conflicting `CLAUDESK_DATA_DIR` override if present.
4. Run `claudesk vault show`, start Claudesk, and verify notes, tasks, and a stored PDF. Retain the original failed vault until recovery is confirmed. Rebuilding derived search indexes is safe after the source data has been verified.

Configuration and vault-pointer writes publish complete YAML through an atomic replacement. This protects against partial writes; it does not replace a backup of prior settings.

## Manual Release Flow

The initial public repository starts from an audited source snapshot with fresh Git history. Earlier development commits and tracker items remain in the private archive. Do not import the archive's branches or tags into the public repository: they contain font binaries that were removed before publication. Verify the current source snapshot and every ref intended for publication; deleting a file from the latest checkout does not remove historical copies.

The project code uses `AGPL-3.0-only`; retain the root `LICENSE` and the separate OFL notices alongside bundled fonts. Keep dependency packages' own notices when distributing installed dependencies or built bundles. The supported initial release remains a source snapshot. Python source archives explicitly exclude the default `data/` vault, installed frontend dependencies, and generated frontend/test output. Build from a clean audited checkout; do not put custom vaults inside that checkout.

1. Start from a clean, up-to-date `main` checkout.

   ```bash
   git switch main
   git pull --ff-only
   git status --short
   ```

2. Choose the next version and update version-bearing files.

   ```bash
   python scripts/release.py bump X.Y.Z
   ```

3. Update `CHANGELOG.md`.

   - Move relevant bullets from `Unreleased` into a `## [X.Y.Z] - YYYY-MM-DD` section.
   - Mention the current database `SCHEMA_VERSION` if it changed since the previous release.
   - Keep the `Unreleased` section at the top for the next cycle.

4. Validate release readiness.

   Confirm the clean-install workflow succeeded on this commit, then run the focused browser checks and release metadata checks locally. On a separate test vault, follow the README from an empty configuration, create a note and task without credentials, attach and open a paper PDF, and verify persistence after restart. Complete one authenticated chat turn with the provider/model intended for the beta, including a local-context read; record the provider, model, and result without credentials or private content. Mocked API requests and model-list/MCP inventory checks do not establish that a real chat turn works.

   ```bash
   python scripts/release.py check X.Y.Z
   python -m unittest -q tests.test_lazy_imports tests.test_process_jobs tests.test_api_digest_process tests.test_api_settings_rubric_process tests.test_agent_capabilities tests.test_chat_sessions tests.test_agent_web_tools tests.test_biorxiv_source tests.test_pubmed_source tests.test_openalex_and_settings tests.test_paper_journal_metadata tests.test_projects tests.test_project_milestones tests.test_settings_registry tests.test_notes tests.test_paper_doi_deduplication tests.test_tasks tests.test_chat_backends tests.test_paper_assets tests.test_pdf_ingest tests.test_agent_pdf_tools
   (cd frontend && npm run build)
   (cd frontend && npm run test)
   (cd frontend && npm run e2e -- chat-dropdowns.spec.ts settings-dropdowns.spec.ts)
   git diff --check
   ```

5. Commit the release prep.

   ```bash
   git add pyproject.toml claudesk/__init__.py frontend/package.json frontend/package-lock.json CHANGELOG.md
   git commit -m "Prepare claudesk X.Y.Z release"
   ```

   Also stage `docs/release.md`, `scripts/release.py`, and release-helper tests when the release process itself changes.

6. Create and push the annotated tag.

   ```bash
   git tag -a vX.Y.Z -m "claudesk vX.Y.Z"
   git push origin main
   git push origin vX.Y.Z
   ```

7. Create the GitHub release from the tag.

   ```bash
   gh release create vX.Y.Z --title "claudesk vX.Y.Z" --notes-file /tmp/claudesk-vX.Y.Z-notes.md
   ```

   The notes file should contain only the relevant `CHANGELOG.md` section for `X.Y.Z`, not the whole changelog. If using the GitHub web UI instead, copy that same section into the release notes.

## Release Helper Commands

```bash
python scripts/release.py bump X.Y.Z
python scripts/release.py check X.Y.Z
```

`bump` updates the version-bearing files. `check` verifies SemVer syntax, manifest synchronization, the matching changelog entry, and that the Git tag does not already exist.
