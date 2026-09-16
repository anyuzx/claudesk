# Changelog

All notable changes to Claudesk releases are recorded here.

## Unreleased

- Added per-session chat backends, models, and generation settings; Settings now defines defaults for new sessions.
- Chat and Settings share searchable model dropdowns populated by OpenAI API and Codex discovery, with refresh, cached results, availability messages, and model-specific generation controls. Gemini and Claude retain their built-in lists.
- OpenAI research chat now uses Responses with provider storage disabled, supporting current reasoning models through the existing tool and activity pipeline.
- Coalesced initial chat creation across attachment uploads and runtime changes, and made failed model saves retryable without changing the selection.
- Kept differently configured Codex sessions on the shared app-server process and isolated provider-state invalidation to the changed session.
- Passed the app's resolved vault path explicitly to the Codex MCP subprocess.
- Removed chat model-override and global-footer runtime writes. Beta YAML configurations require direct removal of retired/backend-inapplicable runtime keys before upgrade; schema v42 preserves existing chat data and initializes session settings once.

- Added app icon assets and an About dialog showing the logo, version, and release date.
- Repaired version-40 `note_links` schema drift so deleted note targets can leave id-backed source links in the valid `missing_target` state.
- Database schema version: 42.

## [0.3.0] - 2026-06-20

- Added note wikilinks, derived `note_links` metadata, linked mention groups, and soft unique note title enforcement.
- Added live Mermaid diagrams and managed Excalidraw drawing assets with workspace editing, previews, search text, and export bundle support.
- Exposed project milestones through agent context, registry exports, and controlled project milestone write tools.
- Made PubMed ESearch fetches length-aware with generated-query warnings, split auto/builder searches, request-body fallback, and request-too-long error normalization.
- Added durable SQLite background job records, events, and failures for digest and rubric-scoring runs while preserving the existing specialized API endpoints.
- Database schema version: 38.

## [0.2.0] - 2026-05-29

- Made the Milkdown-on-ProseMirror rich Markdown note editor the default live editing path, with CodeMirror retained for source mode.
- Added rich live editing support for admonitions, images, tables, math, footnotes, code blocks, paper links, and inline formatting.
- Database schema version: 33.

## [0.1.0] - 2026-05-24

- Baseline release point for the local-first research workspace.
- Includes paper discovery, first-class notes, tasks, log entries, projects, managed PDF assets, persistent chat, and constrained local agent tools.
- Database schema version: 32.
