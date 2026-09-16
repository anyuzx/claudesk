# Paper Lifecycle, Retention, And Invariants

**Last reviewed:** 2026-05-11

This document defines how paper state should behave across digest runs, user actions, duplicate merges, and future cleanup work.

## Current Model
The `papers` table stores independent user flags plus a derived display `status`.

Flags:
- `is_saved`: durable user-owned paper.
- `is_read`: user has marked the paper read.
- `is_to_read`: paper is queued for later reading.
- dismissed state: user wants the paper hidden from normal surfaces.

Display status precedence:
1. `dismissed`
2. `saved`
3. `read`
4. `new`

Because `saved` wins over `read`, a saved-and-read paper displays as saved while preserving `is_read = true`. To-read is independent and clears when the paper is marked read.

## State Semantics
### New
Digest-visible and not saved, read, queued, or dismissed. New is not a deletion policy; digest-only rows can remain in SQLite.

### Read
User-owned read state. Marking read clears `is_to_read`. Read state must survive refetches and duplicate merges.

### Saved
Durable research memory. Unsaving removes only the saved flag; it must not clear read state, notes, projects, feedback, or references.

### To-Read
A paper queue flag, not a task. It is surfaced inside Tasks but must not be merged into the `todos` system.

### Dismissed
Retained but hidden from normal list, search, autocomplete, suggestion, and browse surfaces. Existing historical references must still resolve. Normal creation flows should not suggest dismissed papers unless the user enters an explicit dismissed/recovery mode.

### Deleted
Destructive paper-row removal. Deletion is user-triggered only; there is no automatic cleanup job.

## Retention Rules
Retain papers that are:
- saved
- read
- to-read
- dismissed
- linked from notes, projects, tasks, log entries, chat sessions, or chat messages
- referenced by `paper://<id>`
- represented in feedback rows

Unsaved, unread, unqueued, unlinked digest-only papers are also retained. Date-window behavior hides old digest noise from default views; it does not delete rows.

No automatic cleanup job may delete papers until a separate policy and test suite proves the paper is not user-owned, linked, referenced, or otherwise retained.

## Duplicate Merge Invariants
Duplicate merge may change the canonical row, especially when a published record replaces a preprint. It must preserve:
- saved/read/to-read/dismissed state
- feedback
- notes and note-paper links
- project links
- task/log/chat linked-paper references
- `paper://<id>` links in notes, tasks, log entries, and chat messages

Join rows and id arrays should rewrite to the canonical id and deduplicate without losing manual/mentioned link flags.

Metadata may be promoted during merge, but user-owned state must not be overwritten or cleared.

## Current Implementation
- Default paper list/search surfaces exclude dismissed papers.
- Explicit dismissed-inclusive controls and direct paper lookup recover dismissed rows.
- Paper suggestion/autocomplete flows exclude dismissed papers by default.
- Duplicate merge tests cover state/link preservation.
- Dismissed papers remain historically resolvable.

## Remaining Follow-Ups
- Add paper status actions to Search results.
- Improve paper-card action density and dismissed/restore affordances.
- Design archive/history/cleanup only as a separate feature with policy and tests.
