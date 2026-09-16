# Bundled fonts

These font files are served as static assets at `/fonts/...` and registered as `@font-face` rules in `frontend/src/config/fonts.ts`.

The font binaries retain their own SIL Open Font License 1.1; they are not relicensed under Claudesk's AGPL license. Keep each family's copyright notice and `OFL.txt` with redistributed copies.

| Family | Files | Upstream source | License |
|---|---|---|---|
| Commit Mono | `commit-mono/CommitMono-400-Regular.otf`, `commit-mono/CommitMono-700-Regular.otf` | [Commit Mono](https://github.com/eigilnikolajsen/commit-mono), [upstream license](https://github.com/eigilnikolajsen/commit-mono/blob/main/LICENSE-FONT) | [SIL OFL 1.1](commit-mono/OFL.txt) |
| Crimson Pro | `crimson-pro/CrimsonPro-VariableFont.ttf`, `crimson-pro/CrimsonPro-Italic-VariableFont.ttf` | [Crimson Pro](https://github.com/Fonthausen/CrimsonPro), [upstream license](https://github.com/Fonthausen/CrimsonPro/blob/master/OFL.txt) | [SIL OFL 1.1](crimson-pro/OFL.txt) |

Commit Mono's bundled version 1.143 carries `Copyright 2023 Commit Mono authors (https://github.com/eigilnikolajsen/commit-mono)` in its font metadata. The upstream license names `Copyright (c) 2023 Eigil Nikolajsen (eigi0088@gmail.com)`.

Crimson Pro's bundled version 1.003 carries `Copyright 2018 The Crimson Pro Project Authors (https://github.com/Fonthausen/CrimsonPro)`.

The other font catalog entries, including the default UI family Space Grotesk and display family Nabla, load from Google Fonts at runtime. Their font files are not bundled here.

Font metadata and upstream license notices were checked on 2026-09-15. The font binaries are unchanged.
