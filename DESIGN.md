---
name: Claudesk
description: Local-first research workspace for papers, notes, tasks, logs, chats, assets, and projects.
colors:
  dark-bg: "oklch(12.5% 0.008 255)"
  dark-sidebar: "oklch(14.5% 0.009 255)"
  dark-surface: "oklch(16.5% 0.009 255)"
  dark-hover: "oklch(20.5% 0.011 255)"
  dark-border: "oklch(25% 0.012 255)"
  dark-display: "oklch(96% 0.006 88)"
  dark-primary: "oklch(88% 0.007 88)"
  dark-secondary: "oklch(68% 0.018 230)"
  dark-muted: "oklch(61% 0.016 230)"
  dark-active-surface: "oklch(22% 0.035 245)"
  dark-active: "oklch(65% 0.13 245)"
  dark-accent: "oklch(63% 0.17 27)"
  dark-success: "oklch(67% 0.12 152)"
  dark-warn: "oklch(73% 0.13 78)"
  light-bg: "oklch(98.5% 0.004 230)"
  light-sidebar: "oklch(94.5% 0.006 230)"
  light-surface: "oklch(96.5% 0.005 230)"
  light-hover: "oklch(91.8% 0.008 230)"
  light-border: "oklch(86.5% 0.008 230)"
  light-display: "oklch(23% 0.012 230)"
  light-primary: "oklch(31% 0.011 230)"
  light-secondary: "oklch(43% 0.018 230)"
  light-muted: "oklch(48% 0.016 230)"
  light-active-surface: "oklch(88.5% 0.027 245)"
  light-active: "oklch(41% 0.1 245)"
  light-accent: "oklch(48% 0.17 27)"
  light-success: "oklch(43% 0.11 152)"
  light-warn: "oklch(46% 0.12 72)"
typography:
  ui:
    fontFamily: "Space Grotesk, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  content:
    fontFamily: "Crimson Pro, Georgia, serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  mono:
    fontFamily: "Commit Mono, Menlo, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: "normal"
  display:
    fontFamily: "Nabla, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "normal"
rounded:
  none: "0px"
  overlay: "2px"
  control: "4px"
spacing:
  "4": "4px"
  "8": "8px"
  "16": "16px"
  "24": "24px"
  "32": "32px"
  "48": "48px"
  "64": "64px"
  "96": "96px"
  pane-header: "48px"
components:
  pane-header:
    backgroundColor: "{colors.dark-bg}"
    textColor: "{colors.dark-display}"
    rounded: "{rounded.none}"
    height: "{spacing.pane-header}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.dark-secondary}"
    typography: "{typography.mono}"
    rounded: "{rounded.control}"
    padding: "0"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.dark-secondary}"
    typography: "{typography.mono}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.dark-secondary}"
    typography: "{typography.mono}"
    rounded: "{rounded.control}"
    size: "28px"
  input:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-primary}"
    typography: "{typography.ui}"
    rounded: "{rounded.none}"
    padding: "8px 12px"
  sidebar-item:
    backgroundColor: "transparent"
    textColor: "{colors.dark-secondary}"
    typography: "{typography.mono}"
    rounded: "{rounded.control}"
    height: "32px"
  tab:
    backgroundColor: "transparent"
    textColor: "{colors.dark-secondary}"
    typography: "{typography.ui}"
    rounded: "{rounded.control}"
    height: "32px"
  overlay:
    backgroundColor: "{colors.dark-bg}"
    textColor: "{colors.dark-primary}"
    rounded: "{rounded.overlay}"
---

# Design System: Claudesk

## 1. Overview

**Creative North Star:** Research instrument panel.

Claudesk is a local-first workspace for scientific papers, notes, tasks, logs, chats, assets, and research projects. The interface should feel serious, quiet, dense, and durable. It is built for repeated expert use, not for onboarding spectacle or SaaS-style persuasion.

The design should make research material the subject. Papers, notes, task text, project state, PDF pages, and chat evidence should carry the screen. Chrome exists to organize and operate the workspace. The app should look like a private instrument connected to a local archive, not a generic AI chat product or decorative note app.

Key characteristics:

- Monochrome, typography-led, and compact.
- Dark and light themes are both first-class.
- Color appears only for state, emphasis, selection, or interruption.
- Structure comes from panes, rows, borders, alignment, and metadata, not nested cards.
- Open papers, notes, projects, and PDFs in local workspace tabs rather than replacing the app surface.
- Project scope is a context cue, not a global filter that hides unrelated areas.

Primary desktop shell:

- Primary navigation sidebar.
- Current index pane.
- Central workspace with local tabs.
- Optional right chat/context pane.

The shell is desktop-first for Electron-style use. Narrow mobile shell behavior is not a supported app mode for this branch. Add content-level responsive behavior only when it improves desktop window resizing.

Implementation sources:

- Theme tokens, Electron shell CSS, PDF shell CSS, markdown CSS: `frontend/src/index.css`.
- Font catalog and runtime font loading: `frontend/src/config/fonts.ts`.
- App shell, resizable panes, workspace tabs, Electron shell state: `frontend/src/App.tsx`.
- Pane primitives: `frontend/src/components/Pane.tsx`.
- Primary navigation sidebar: `frontend/src/components/Sidebar.tsx`.
- Local Base UI-backed primitives: `frontend/src/components/ui/`.
- Settings controls: `frontend/src/components/SettingsControls.tsx`.
- Markdown renderer and `paper://` navigation: `frontend/src/components/MarkdownContent.tsx`.

## 2. Colors

The color system is restrained and semantic. The canonical runtime color source is `frontend/src/index.css`: Tailwind v4 `@theme` registers semantic utilities and default dark values, while `:root.light` overrides the same `--color-*` variables for light mode.

Use semantic tokens for all theme-sensitive UI. Do not use built-in Tailwind colors such as `bg-black`, `text-white`, `bg-gray-*`, or `text-slate-*` for theme-sensitive surfaces.

| Token utility | Use |
|---|---|
| `bg-bg` | Main app background, pane headers, pane bodies, default chrome. |
| `bg-sidebar` | Primary navigation sidebar and shell-adjacent navigation surfaces. |
| `bg-surface` | Secondary surfaces, inset reading/PDF/code areas, and overlay interiors when `bg-bg` is too flat. |
| `bg-hover` | Hover, focus, highlighted rows, light selected states, and temporary emphasis. |
| `border-border` | Structural dividers, pane edges, control borders, markdown rules. |
| `text-display` | Strongest headings, active labels, high-emphasis text. |
| `text-primary` | Main readable body text. |
| `text-secondary` | Secondary labels, links, supporting metadata, normal icon color. |
| `text-muted` | Low-emphasis metadata, placeholders, disabled or unavailable cues. |
| `bg-active-surface` | Selected tabs, date ranges, or active surfaces that need more than hover. |
| `bg-active` | Rare active indicator or accent fill when a state needs clear visual weight. |
| `text-accent` | Destructive, error, failed, missing, or interruptive state. Not decoration. |
| `text-success` | Completed, available, parsed, saved, or successful state. |
| `text-warn` | Warning, pending risk, stale, partial, or needs-attention state. |

Named rules:

- **Semantic-only color rule:** use `text-accent`, `text-success`, and `text-warn` only for actual state. Never use them as ornament.
- **Sparse accent rule:** inactive chrome stays monochrome. Accent is for interruption, selection, primary state, and meaningful feedback.
- **No color-only rule:** pair color with text, icon, border, position, or affordance.
- **Token-mix rule:** use `color-mix()` with existing tokens for subtle tints. Do not hard-code raw colors.
- **Theme parity rule:** check any new pane, row, overlay, PDF-adjacent surface, or token-mixed tint in both dark and light. PDF document pages may keep document-native white, but viewer chrome, sidebars, gutters, and scroll regions still use semantic tokens.

State precedence:

- Disabled or unavailable state overrides hover, active, warning, and success styling.
- Error or destructive state owns text and border emphasis, but selection may still own the row background.
- Selection owns background through `bg-active-surface` or `bg-hover`; hover must not mask error, warning, or destructive labels.
- Loading state disables repeated action, preserves layout, and uses inline text or existing spinner affordances where wrappers already provide them.
- Warning and success are label-level signals unless the whole surface is itself a warning or success state.

## 3. Typography

Runtime font roles come from `frontend/src/config/fonts.ts` and are applied through CSS variables. User preferences can change the active family through the font catalog, so design rules must describe roles rather than depend on one family.

**UI font:** `ui`, current runtime default `Space Grotesk`. Use for app chrome, controls, navigation, list titles, task/log/chat/project body text.

**Content font:** `content`, current runtime default `Crimson Pro`. Use for paper abstracts, note reading, note editing, and long-form reading surfaces only.

**Mono font:** `mono`, current runtime default `Commit Mono`. Use for metadata, timestamps, status labels, scores, IDs, code, compact menu labels.

**Display font:** `display`, current runtime default `Nabla`. Use only for rare product-mark or sidebar-title treatment. Never use display fonts for controls, data, labels, or body copy.

Practical hierarchy:

| Role | Font | Typical treatment | Use |
|---|---|---|---|
| Pane title | `mono` | 14px, uppercase, high emphasis | Primary pane identity in `PaneHeader`. |
| Pane meta | `mono` | 12px, uppercase, secondary | Counts, active filter summary, source/state cue. |
| Toolbar label | `mono` | 10-12px, uppercase, secondary/muted | Compact filters, date windows, mode labels. |
| Row title | `ui` | 13-15px, medium or regular, primary/display | Paper, note, task, log, project titles. |
| Row metadata | `mono` | 10-12px, uppercase when label-like | Dates, scores, source, status, project hints. |
| Body text | `ui` | 14px, regular, primary | Tasks, logs, chat, project bodies, settings help. |
| Reading text | `content` | 16px-ish, regular, primary | Notes, paper abstracts, long-form reading. |
| Code/math/status | `mono` for code/status | Existing code and KaTeX sizing | Compact evidence, code snippets, IDs, equations. |

Rules:

- Use fixed product UI sizes. Do not scale font size with viewport width.
- Use type role, weight, casing, and token contrast before adding containers or color.
- Keep long-form reading surfaces around 65-75ch when the screen pattern allows it.
- Keep compact product UI line lengths flexible enough for dense panes and tables.
- Metadata should usually be mono, 10-12px, uppercase when it functions as a label, and `text-secondary` or `text-muted`.
- KaTeX inside `.md` is capped at `1em` in `frontend/src/index.css`.
- Add fonts only through `FONT_CATALOG`; local files live under `frontend/public/fonts/`.

## 4. Elevation

Claudesk is flat by default. Depth comes from pane structure, borders, tonal surfaces, scroll regions, and active/hover state, not from card shadows. Use `border-border`, `bg-surface`, `bg-hover`, and spacing before considering any elevated treatment.

Permitted elevation:

- Floating overlays such as menus, popovers, tooltips, comboboxes, selects, calendars, and dialogs may use the existing local wrapper shadows when needed for layer separation.
- PDF pages may use border and surface contrast, not decorative shadow.
- Row and pane depth should be expressed through 1px borders, active backgrounds, dotted dividers, or spacing.

Forbidden elevation:

- Shadows used to create page sections or card-heavy layouts.
- Nested cards.
- Glassmorphism, backdrop blur, translucent pane chrome, glow, bokeh, blob backgrounds, or decorative gradients.
- Side-stripe borders greater than 1px as card, row, callout, or alert accents.

Named rules:

- **Flat-by-default rule:** surfaces rest flat; overlays may lift because they float above the interaction plane.
- **Border-over-card rule:** prefer borders, separators, row backgrounds, and alignment over framed cards.
- **No nested card rule:** if a card contains another card, replace at least one layer with spacing, a row, a table, or a simple border.

## 5. Components

Shared UI primitives live under `frontend/src/components/ui/` and are Base UI-backed local wrappers, mostly generated or adapted from the shadcn Base registry. Feature components import local wrappers instead of importing Base UI primitives directly.

Current shared primitives include alert dialog, alert, autocomplete, badge, button, calendar, checkbox, collapsible, combobox, context menu, date picker, dialog, dropdown menu, field, icon button, input, number field, popover, progress, select, separator, sidebar, switch, table, tabs, textarea, toggle group, and tooltip.

UI component workflow:

1. Search `frontend/src/components/ui/`, `frontend/src/components/Pane.tsx`, Settings controls, and nearby feature components.
2. Reuse or extend an existing local wrapper or feature pattern when it fits.
3. If a reusable primitive is missing, check the shadcn Base registry before hand-coding it. `frontend/components.json` maps shadcn `@ui` to `@/components/ui`.
4. Copy or adapt the shadcn Base component into `frontend/src/components/ui/`, using Claudesk semantic tokens, local radius/spacing/type rules, `lucide-react` icons, repo aliases, and the existing wrapper style.
5. Feature code imports local wrappers from `frontend/src/components/ui/`; do not import Base UI primitives directly except inside local wrapper files.
6. Hand-code a custom primitive only when no local wrapper or shadcn Base component fits. State why, and do not add production dependencies without explicit approval.

Component contracts:

| Family | Source of truth | Contract |
|---|---|---|
| Buttons and icon buttons | `Button`, `IconButton` | Use for commands. Preserve stable hit areas, loading disablement, focus rings, icon labels, and `aria-pressed` on active toggles. Text buttons are for submit, cancel, destructive confirmation, and ambiguous actions. |
| Text inputs and fields | `Input`, `SearchField`, `Textarea`, `Field`, `SettingsControls` | Use for editable text and search. Keep label, control, help, and error rhythm local to the field. Error state uses both control styling and explicit text. |
| Choice and numeric controls | `Select`, `Combobox`, `DatePicker`, `NumberField`, `Switch`, `ToggleGroup` | Use standard controls for option sets, dates, numeric values, binary settings, and modes. Menu/listbox popups own keyboard navigation and should keep trigger width, collision padding, and visible selected state. |
| Badges and chips | `Badge`, project/paper chip helpers | Use for compact metadata, scope, and status. Chips stay low-height, non-card, and label-like. Color variants must map to real state, not decoration. |
| Tables and index rows | `Table` plus pane-local row patterns | Use tables for grid data and one-row objects for index panes. Keep row geometry stable, action zones keyboard reachable, titles truncating or wrapping deliberately, and horizontal scrolling limited to true table/tool surfaces. |
| Pane and workspace chrome | `PaneFrame`, `PaneHeader`, `PaneToolbar`, `PaneBody`, local workspace tabs | Use for shell structure. Headers own the 48px band, actions stay compact, and workspace tabs keep close/reorder controls inside the tab strip. |
| Overlays and confirmations | `DropdownMenu`, `ContextMenu`, `Popover`, `Tooltip`, `Dialog`, `AlertDialog` | Use overlays for secondary action sets, inspectors, tooltips, editing dialogs, and destructive confirmations. Popups are the only routine elevated surfaces and must keep focus management and dismissal behavior from the wrapper. |
| Feedback surfaces | `Alert`, `Progress`, inline empty/loading/error states | Use local inline feedback before global banners. Empty states teach the surface and next action; loading and progress preserve layout; blocking warnings may use alert/dialog patterns. |

Contracts are behavioral, not just visual. If a feature needs custom markup inside one of these families, preserve the wrapper's accessible semantics, focus treatment, disabled behavior, dark/light token use, and overflow geometry. If two surfaces need the same custom anatomy, extract a local wrapper or feature helper before adding another parallel version.

Pane grammar:

| Primitive | Role | Rule |
|---|---|---|
| `PaneFrame` | Panel bounds | Owns flex column and overflow contract. |
| `PaneHeader` | Primary pane header | Fixed `var(--pane-header-height)`, currently 48px. Use for title, metadata, leading controls, and actions. |
| `PaneToolbar` | Secondary controls | Use for filters, tabs, project cues, and session controls below the header. |
| `PaneBody` | Scroll region | Owns vertical scrolling and optional padding. |

Do not replace pane headers with ad hoc sticky headers inside padded scroll containers.

Screen anatomy:

- **Index panes:** `PaneFrame`, `PaneHeader`, optional `PaneToolbar`, and `PaneBody`. Header holds title, count/meta, filters, and actions. Empty/loading states stay in the list geometry.
- **Index rows:** use one primary row object, not a card stack. Put source/icon/state cues first, the primary title or task text next, metadata/status badges below or beside it, and score/actions in the trailing zone only when space allows. Secondary abstracts, reasons, or note previews should be short supporting text, not a second header. Avoid fixed action columns unless a table pattern already owns the surface.
- **Detail panes:** local workspace surface for one active record. Put record identity, status, and actions near the top without making a hero. Use tabs or compact section controls for local navigation. Preserve dirty drafts and local tab focus.
- **Project overview panes:** use a five-region research-state layout rather than cards: state strip, project description/current summary, research-state/attention rail, recent activity, and linked-materials snapshot. Derive summary and attention state from existing project, milestone, task, log, and material queries; do not add persisted current-summary fields for this view. Use workspace tabs for linked-resource counts, not a duplicate overview count strip. Use container queries for the overview body because the workspace can be narrowed by the index and chat panes.
- **Workspace headers:** use a compact two-tier shape when needed: local workspace tabs first, then record identity plus metadata/actions. Metadata stays single-line when it is status-like; longer descriptions move into the body. Keep close actions in the workspace tab strip, not duplicated in record headers.
- **Reading and markdown surfaces:** render shared markdown through `MarkdownContent.tsx`; it remains the canonical read/preview renderer for notes and markdown snippets. Use `.md`/prose token bridges from `index.css`. Keep code, task lists, equations, callouts, and `paper://` links consistent across themes. Blockquote and fenced admonition syntaxes should share the same callout header, icon, label, and body structure.
- **Rich note editing:** the Milkdown-on-ProseMirror editor is the default live note editor. Preserve Markdown data first, keep CodeMirror as the source-mode escape hatch for source editing and unsupported round-trip cases, and add rich behavior through Milkdown plugins with selective ProseMirror primitives only where editor behavior requires them.
- **PDF surfaces:** treat the viewer as a full-height tool, not an embedded card. Toolbar, navigation sidebar, search, page jump, zoom, and chat-context actions stay in a single compact control band where possible. Preserve visible gutters around document pages and keep PDF-specific density in `index.css`.
- **Chat and agent panes:** right-side context pane attached to the workspace. Keep context, attachments, Activity trace, read evidence, tool progress, and errors compact and inspectable. Do not expose raw provider reasoning.
- **Chat evidence hierarchy:** keep composer context, per-message context, Activity entries, and read-ledger evidence visually distinct. Context chips name the attached local object, Activity rows summarize what happened, and expandable details show locator/evidence only when requested. Warning/error evidence uses semantic state text plus a compact label, not a large alert panel unless the turn is blocked.
- **Settings and forms:** reuse `SettingsControls.tsx` and local primitives. Group fields by domain, with a section heading/summary followed by stable label, control, help text, and error text rhythm. Use two-column label/control layouts on wide settings surfaces and stacked fields on narrow widths. Put recoverable errors near the affected control.

Control rules:

- Use `lucide-react` icons for compact toolbar, row, workspace, and sidebar actions unless the icon system changes deliberately.
- Prefer icon-only buttons for repeated secondary actions: edit, delete, add, clear, send, sort, parse, attach, open, save, close, collapse.
- Every icon-only button needs `aria-label` and `title`; active toggles expose `aria-pressed`.
- Keep submit, cancel, destructive confirmation, and high-risk actions as text when icon-only would reduce clarity.
- Sort and filter controls stay light unless active state or menu affordance needs more structure.
- Use switches for binary settings, selects/comboboxes for option sets, steppers or number fields for numeric values, and dialogs for confirmations.
- Menus and context menus use shared dropdown/context-menu primitives.
- Destructive confirmations and vault/path confirmations use shared dialog or alert-dialog primitives.

Component state contract:

| State | Required treatment |
|---|---|
| Default | Stable size, semantic tokens, no layout surprise. |
| Hover | `bg-hover`, border shift, or text emphasis only when interactive. |
| Focus | Visible focus treatment in both themes. Never remove without replacement. |
| Active/selected | Use `bg-hover` or `bg-active-surface` plus text/icon cue. |
| Open | Trigger and popup both show state through wrapper data attributes, selected text, or icon cue. |
| Disabled | Non-interactive cursor, `text-muted`, no hover upgrade. |
| Loading | Disable repeated submission, preserve dimensions, show inline loading near the action. |
| Invalid/error | Use `text-accent` or `border-accent` plus explicit text. |
| Destructive | Keep destructive copy explicit. Use `danger` or alert-dialog treatment for irreversible actions. |
| Warning/success | Use semantic label text and, when needed, subtle token-mixed tint. |
| Empty | Teach the local surface and next action. Do not use marketing panels. |

Density:

- Pane headers stay 48px.
- Repeated toolbar controls should stay in the compact wrapper range, usually `h-7`, `h-8`, or `h-9`.
- PDF toolbar density is tuned separately in `index.css`; do not generalize it into taller app chrome.
- Component dimensions are part of the contract. Loading spinners, badges, hover actions, selected labels, and validation text must not resize the row, toolbar, or form group unexpectedly.
- Long titles and labels must truncate, wrap, or reserve space without pushing controls out of the pane.
- Row actions must be keyboard reachable and not depend only on hover.
- Optional clusters such as search, sort, secondary filters, PDF search, and trailing action groups may collapse or wrap before primary navigation, titles, page jumps, or submit controls lose space.
- Use horizontal scrolling only for data tables, PDF internals, and intentionally bounded toolbars. The app shell, index panes, settings pages, chat pane, and markdown reading surfaces should not create page-level horizontal scroll.
- In narrow desktop windows, prefer collapsing optional pane chrome, shortening metadata, or stacking settings fields over shrinking type or inventing mobile-only navigation.

## 6. Do's and Don'ts

Do:

- Preserve the dense research instrument identity.
- Use the semantic tokens in `frontend/src/index.css`.
- Use local wrappers from `frontend/src/components/ui/` before creating custom primitives; add missing reusable primitives there from shadcn Base UI when appropriate.
- Use `PaneFrame`, `PaneHeader`, `PaneToolbar`, and `PaneBody` when the pane grammar applies.
- Keep dark and light themes equally legible.
- Keep list views scannable and stable.
- Prefer inline state, subtle borders, and local recoverable errors over global banners or toast churn.
- Preserve workspace-tab openings for papers, notes, projects, and PDFs.
- Run relevant checks for UI changes, plus `git diff --check`.

Do not:

- Make Claudesk look like a SaaS analytics dashboard, marketing landing page, social productivity app, generic AI chat wrapper, decorative note app, or gamified student tool.
- Use decorative gradients, gradient text, glow, bokeh, blob backgrounds, glassmorphism, decorative blur, or translucent pane chrome.
- Use large hero sections inside the app.
- Use repeated identical card grids with icon, heading, and copy.
- Use nested cards or page sections styled as floating cards.
- Use display fonts in labels, buttons, controls, dense rows, or data.
- Use raw Tailwind colors for theme-sensitive UI.
- Add production dependencies without explicit approval.
- Add new design tokens, files, components, routes, hooks, stores, APIs, or dependencies before searching for existing behavior and proving reuse is insufficient.

Platform shell constraints:

- Electron preload exposes `window.claudeskDesktop = { shell: 'electron', platform, titlebarOverlay }`. The renderer mirrors shell state onto `<html>` through `data-desktop-shell`, `data-platform`, and when present `data-titlebar-overlay`.
- macOS Electron: the top 48px app chrome doubles as the native titlebar zone. Keep the top-left 80px traffic-light area free of app controls. Empty draggable header regions use `electron-drag-region`; real controls remain `electron-no-drag`.
- macOS Electron: when the sidebar is collapsed, it fully disappears so native traffic lights blend into the first pane header. Restore controls live in the first visible pane header, outside the traffic-light safe zone. Settings sidebar content must not start under the native titlebar safe area.
- Linux Electron: Window Controls Overlay applies when `titlebarOverlay: true`. Native controls own the top-right 48px header region. Sync overlay background through the Linux `setTitlebarOverlayTheme` bridge.
- Linux Electron: reserve compact right-side titlebar space only in the rightmost visible pane header. Use one shell-level divider below the 48px titlebar band. Scope Linux overlay CSS to `data-platform="linux"` plus `data-titlebar-overlay="true"` so macOS behavior stays unchanged.
- Keep these shell constraints inline in this file until a separate shell design reference is explicitly approved.

Codex completion checklist:

- State the reuse/refactor plan before editing.
- Search local wrappers and nearby feature patterns first; if a primitive is missing, check shadcn Base UI and adapt it into `frontend/src/components/ui/`.
- Use semantic tokens and pane grammar.
- Check icon-only controls for `aria-label`, `title`, and `aria-pressed` when applicable.
- Check state precedence, focus visibility, dark/light contrast, and Electron titlebar constraints when relevant.
- For component-contract work, use Playwright or an existing focused spec to inspect at least one normal and one constrained width, plus the open/focus/error state that the change affects.
- Summarize what existing code was reused, what was refactored, what new code was added and why, what code was removed, and what checks were run.
