# Paper Sources And Digest Fetching

**Last reviewed:** 2026-05-11

This document describes the current source-fetch path and the settings that affect it.

## Overview
Source modules:

- `claudesk/sources/arxiv.py`: arXiv Atom API.
- `claudesk/sources/biorxiv.py`: direct bioRxiv API with optional Crossref fallback.
- `claudesk/sources/pubmed.py`: NCBI E-utilities with auto, builder, and raw query modes.
- `claudesk/sources/openalex.py`: OpenAlex Works and Authors APIs.

Digest runtime:

```text
interests.yaml / Settings
  -> claudesk.core.config.load_config()
  -> claudesk.sources.get_enabled_sources()
  -> claudesk.pipeline.fetch.fetch_all()
  -> source.fetch(since)
  -> claudesk.pipeline.dedupe.dedupe()
  -> claudesk.pipeline.rank.rank()
  -> claudesk.pipeline.digest.write_digest()
  -> SQLite
```

Settings saved through `PATCH /api/settings` clear cached config for live-editable keys. Manual config-file edits require restarting the process.

## Shared Rules
- Fetchers receive `since: datetime` and return `Paper` records.
- `digest.days_back` determines the normal date window.
- `digest.max_per_source` caps source-level fetch work.
- `digest.top_n` caps final digest output after ranking.
- Function arguments may override config for tests and one-off calls.
- If one source fails, `fetch_all()` logs the error and continues.
- If every selected source fails, the digest run fails before dedupe, ranking, or DB writes.
- A successful source returning zero papers still counts as a completed source.

## arXiv
Config:

```yaml
sources:
  arxiv:
    enabled: true
    categories: ["q-bio.BM", "q-bio.SC", "physics.bio-ph"]
```

Behavior:
- Empty category list means no arXiv fetch.
- Categories are sent as `cat:<id>` terms joined by `OR`.
- Results sort by submitted date descending.
- Pagination stops when results predate `since`, no more records return, or `digest.max_per_source` is reached.
- Settings suggests known category ids from package data but allows custom values.

## bioRxiv
Config:

```yaml
sources:
  biorxiv:
    enabled: true
    categories: ["Biophysics"]
    provider: api
    fallback_provider: crossref
```

Behavior:
- Empty category list means all bioRxiv categories.
- `provider: api` uses `https://api.biorxiv.org/details`.
- `provider: crossref` uses Crossref member works for openRxiv.
- `fallback_provider` is tried only when the primary provider errors and fallback is not `none`.
- Direct API fetches one day at a time from newest to oldest.
- Direct API category values are normalized to the provider shape and returned records are post-filtered.
- Repeated DOI versions collapse to the highest version.
- Crossref category filtering is local against `group-title`.

Keep `Paper.external_id` as the base DOI for both providers; dedupe relies on stable DOI values.

## PubMed
Config:

```yaml
sources:
  pubmed:
    enabled: true
    query_mode: auto
```

Modes:
- `auto`: builds a literal PubMed query from `topics`, `keywords.include`, `keywords.exclude`, and `profile.field`.
- `builder`: uses PubMed-specific `concepts`, `exclude_terms`, and `concept_scope`.
- `raw`: preserves direct PubMed syntax from `search_terms`.

Compatibility:
- Existing configs with `search_terms` but no `query_mode` load as `raw`, including an empty list.
- A function-level `search_terms=` override is still accepted for tests/direct calls and is treated as raw syntax.
- `POST /api/settings/pubmed/preview` returns the generated ESearch query after draft patches.

If the active strategy generates an empty query, PubMed returns no records without calling ESearch.

Returned PMIDs are fetched through EFetch XML. The parser maps title, abstract, authors, journal abbreviation, DOI, and date into `Paper`. DOI is used as `external_id` when available; otherwise `pmid:<pmid>` is used.

## OpenAlex
Config:

```yaml
sources:
  openalex:
    enabled: true
```

Behavior:
- Requires `OPENALEX_API_KEY` when enabled.
- Uses `keywords.include` for keyword work searches.
- Uses `tracked_authors` for author lookup and author-work searches.
- If no API key is available, the source raises a configuration error.
- If no keywords or tracked authors are configured, it returns no records.
- Results are filtered to recent article/preprint works with abstracts, merged by work id, sorted newest first, and capped by `digest.max_per_source`.

## Dedupe, Ranking, And Storage
Fetched records are combined, deduped, ranked, and then written.

Dedupe:
- DOI identity first.
- Normalized-title matching for preprint/publication duplicates.
- Existing duplicate repair preserves user-owned state and relationship links.

Ranking:
- include/exclude keyword filter over title and abstract
- local embedding similarity against `topics`
- optional OpenAI rubric scoring over the shortlist

Storage:
- New local rows created by a digest receive the latest-digest marker.
- Existing rows may receive refreshed ranking/source metadata.
- Saved/read/dismissed/to-read flags, notes, feedback, and project links are preserved.

## Practical Notes
- Source settings decide what is fetched; ranking settings decide what makes the digest.
- Category suggestions are UI metadata from `claudesk/core/source_category_options.json`; saved config remains plain strings.
- `seed_papers` is persisted but not used by OpenAlex or ranking yet.
