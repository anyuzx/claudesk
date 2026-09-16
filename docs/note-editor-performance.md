# Note Editor Performance

**Last reviewed:** 2026-06-02

This document summarizes the note-editor performance work covering long-note Preview rendering and the rich Markdown Live editor. The main principle across these changes is to keep Preview, Source, and Live responsibilities separate while reducing the amount of Markdown, KaTeX, Milkdown, and outline/snapshot work performed before the user can interact.

## Goals

- Keep long math-heavy notes responsive when opened in Preview.
- Keep Source mode free of Preview rendering work.
- Reduce rich Live editor keystroke latency and overlay churn.
- Defer nonessential outline/snapshot work until after the editor is interactive.
- Preserve math rendering, heading anchors, folding, selection, and editing behavior.

## Long Preview Rendering

Issue `#195` introduced staged Preview rendering for large Markdown notes.

The implementation keeps `MarkdownContent` as the renderer for mounted chunks, but routes long Preview bodies through chunk planning and virtualization:

- `StagedMarkdownPreview` mounts only the visible Preview range plus bounded overscan.
- `markdownPreviewChunks` splits large notes at safe Markdown block boundaries while preserving source offsets for headings.
- Visible chunks and outline-forced chunks remain mandatory so navigation targets are present when needed.
- Source mode stays CodeMirror-only and does not mount Preview chunks or KaTeX nodes.

The follow-up bounded unsafe degraded fallback behavior. Instead of falling back to one full-document chunk for difficult Markdown, fallback chunking uses `FALLBACK_PREVIEW_CHUNK_CHAR_LIMIT = 8000` so large notes do not silently defeat the performance goal.

Recorded production-preview benchmark evidence after this work:

- Preview above-fold: `514.1ms`.
- First interaction: `879.7ms`.
- Initial Preview render: `9` chunks and `24` KaTeX nodes.
- Source open: `307.9ms`, with `0` Preview chunks and `0` KaTeX nodes.
- Live typing/navigation guards: `261.2ms` / `40.0ms` p95.

## Rich Live Editor

The current `optimization/note-performance` branch focused on the Milkdown-backed rich Live editor path.

Keystroke handling was narrowed so Markdown synchronization and DOM work are not performed on every local editor event when they are not needed. Rich Markdown editing now avoids unnecessary selection and overlay recalculation work during ordinary typing.

Overlay churn was reduced across rich callouts, slash commands, and inline-style UI by reusing existing update paths and gating work to state changes that can affect visible overlays.

Instrumentation was added around editor mode transitions, outline extraction, snapshot scheduling/building, and rich typing paths. That made the follow-up changes evidence-driven instead of speculative.

Inline math alignment was finalized with the rich math wrapper still rendered as an `inline-block`, with `content-visibility: auto` and `contain-intrinsic-size` preserved:

```css
vertical-align: middle;
```

The intermediate `transform: translateY(0.04em)` approach avoided layout churn but could move rendered KaTeX outside the wrapper's paint area and clip descenders. The final fix removes the transform, keeps `overflow: visible`, and uses `vertical-align: middle` for baseline alignment. The note 55 Electron benchmark after this change did not show a significant typing-performance regression:

- Baseline JSON: `/tmp/claudesk-note55-electron-bench-1780426807434.json`.
- After-fix JSON: `/tmp/claudesk-note55-electron-bench-1780428408866.json`.
- Live editor ready: `575.9ms` -> `610.2ms`.
- Milkdown create: `445.6ms` -> `483.4ms`.
- Sequential keydown-to-frame p95: `40.9ms` -> `40.1ms`.
- Burst 20 cps visible lag p95: `103.1ms` -> `57.4ms`.
- Burst 40 cps visible lag p95: `1390.5ms` -> `431.5ms`.

## Outline And Snapshot Work

Heading extraction now uses a fast top-level ATX scanner for common notes and falls back to the Markdown parser for cases that need full parsing, such as setext headings, indented ATX headings, and complex inline heading markup. Review follow-ups kept the fast path but aligned it with CommonMark behavior for literal trailing heading hashes, supported character references, parser-recognized display math blocks, and CommonMark HTML blocks.

Snapshot work was moved out of the always-visible outline rail:

- The expensive heading and snapshot paths share the already-known heading count when available.
- Display equation counting reuses the snapshot parse tree for `remark-math` math nodes and uses a bounded delimiter scan for normalized display-math forms that the tree does not cover.
- Full word/equation snapshots are computed only when the note stats popover opens.
- The popover builds a cheap snapshot immediately for line/headings, then schedules the full snapshot in an idle callback.
- Pending stale popover snapshot work is canceled when the note body changes before it runs.

Final note 55 Electron benchmark evidence before the stats popover move:

- Benchmark JSON: `/tmp/claudesk-note55-electron-bench-1780379307172.json`.
- Screenshot: `/tmp/claudesk-note55-electron-auto-1780379307172.png`.
- Outline extraction: `3.3ms`.
- Snapshot scheduling: `delayMs: 3000`.
- No full snapshot build occurred in the ready-event timeline.
- Deferred snapshot builds later ran at about `62-67ms`.
- Live ready: `584.2ms`.

Final profiling evidence:

- Profile summary: `/tmp/claudesk-note55-electron-profile-1780379377399.summary.json`.
- CPU profile: `/tmp/claudesk-note55-electron-profile-1780379377399.cpuprofile`.
- Trace: `/tmp/claudesk-note55-electron-profile-1780379377399.trace.json`.
- Layout max: `2.18ms`.
- Paint max: `3.26ms`.
- No remaining evidence pointed to inline KaTeX as a long layout or paint hot surface.

Inline math visual evidence:

- Focused Playwright coverage now checks both same-line inline math continuation and descender clipping.
- The final alignment/clipping pass used `npx playwright test notes-pane.spec.ts -g "inline math" --config=/tmp/claudesk-playwright-no-webserver.config.cjs`; both focused tests passed.
- Editor content remains editable while inline math wrappers remain `contentEditable=false`.

## Commits

Long Preview rendering:

- `9d75c7c` - `perf(notes): virtualize long markdown preview`
- `091c972` - `fix(notes): bound staged preview fallback rendering`

Rich Live editor:

- `aecf48f` - `Optimize rich note editor keystroke handling`
- `b468627` - `Reduce rich editor overlay update churn`
- `0b8b81f` - `Instrument note editor performance paths`
- `cd61f8a` - `Improve rich markdown editor performance`
- `22413fd` - `Align inline math with surrounding text`
- `45ed638` - `Optimize note editor snapshot work`
- `c3d7b0b` - `Tune inline math offset`
- `e276f6d` - `Fix note outline parser edge cases`
- `5413d94` - `Keep entity headings on fast outline path`
- `5fb6171` - `Fix rich inline math clipping`
- `023f26a` - `Fix inline math baseline alignment`
- `e9bd818` - `Move note stats into lazy popover`

## Verification

Useful focused checks for this area:

```bash
cd frontend
npm run test -- markdownPreviewChunks StagedMarkdownPreview MarkdownContent noteBlocks noteLivePreview
PATH=/home/guangshi/miniforge3/bin:$PATH npm run e2e -- notes-pane.spec.ts -g "live preview|virtualizes|source mode"
npx playwright test notes-pane.spec.ts -g "inline math" --config=/tmp/claudesk-playwright-no-webserver.config.cjs
npm run build
git diff --check
```

For rich Live editor latency, use the note 55 Electron benchmark and production build/preview flows rather than dev-server timings. Dev mode and in-process clients have not matched the accepted performance evidence for this path.

## Remaining Risks

- Milkdown creation remains the dominant rich Live editor cold-start cost, around `445-485ms` in the final profiling and inline-math follow-up runs.
- The 40 cps burst typing metric is still noisy and can regress even when snapshot work is deferred.
- The Vite production build still reports large chunks; bundle splitting remains a separate performance lever.
- Inline math vertical tuning is still visual across fonts and zoom levels, but future fixes should avoid paint-only transforms that can reintroduce clipping.
