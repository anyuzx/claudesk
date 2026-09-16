export type FontRole = 'ui' | 'content' | 'mono' | 'display'

export type FontConfig = {
  ui: string
  content: string
  mono: string
  display: string
}

type LocalFace = {
  src: string
  format: 'truetype' | 'opentype'
  weight?: string
  style?: 'normal' | 'italic'
}

type FontEntry = {
  family: string
  label: string
  roles: FontRole[]
  source: { kind: 'google' } | { kind: 'local'; faces: LocalFace[] }
}

export const FONT_CATALOG: FontEntry[] = [
  {
    family: 'Crimson Pro',
    label: 'Crimson Pro (local)',
    roles: ['content', 'ui'],
    source: {
      kind: 'local',
      faces: [
        { src: '/fonts/crimson-pro/CrimsonPro-VariableFont.ttf', format: 'truetype', weight: '200 700', style: 'normal' },
        { src: '/fonts/crimson-pro/CrimsonPro-Italic-VariableFont.ttf', format: 'truetype', weight: '200 700', style: 'italic' },
      ],
    },
  },
  {
    family: 'Commit Mono',
    label: 'Commit Mono (local)',
    roles: ['mono', 'ui'],
    source: {
      kind: 'local',
      faces: [
        { src: '/fonts/commit-mono/CommitMono-400-Regular.otf', format: 'opentype', weight: '400', style: 'normal' },
        { src: '/fonts/commit-mono/CommitMono-700-Regular.otf', format: 'opentype', weight: '700', style: 'normal' },
      ],
    },
  },
  { family: 'Nabla',         label: 'Nabla (Google)',         roles: ['display'], source: { kind: 'google' } },
  { family: 'Doto',          label: 'Doto (Google)',          roles: ['display'], source: { kind: 'google' } },
  { family: 'Space Grotesk', label: 'Space Grotesk (Google)', roles: ['ui', 'content'], source: { kind: 'google' } },
  { family: 'Space Mono',    label: 'Space Mono (Google)',    roles: ['mono'],    source: { kind: 'google' } },
  { family: 'Inter',         label: 'Inter (Google)',         roles: ['ui'],      source: { kind: 'google' } },
  { family: 'JetBrains Mono', label: 'JetBrains Mono (Google)', roles: ['mono'],  source: { kind: 'google' } },
  { family: 'Instrument Serif', label: 'Instrument Serif (Google)', roles: ['ui'], source: { kind: 'google' } },
]

export const FONT_CONFIG: FontConfig = {
  ui: 'Space Grotesk',
  content: 'Crimson Pro',
  mono: 'Commit Mono',
  display: 'Nabla',
}

const LOCAL_STYLE_ID = 'claudesk-local-fonts'
const GOOGLE_LINK_ID = 'claudesk-google-fonts'
const FONT_STORAGE_KEY = 'font-config'

function normalizeFontFamily(family: string, fallback: string): string {
  const normalized = family.trim().replace(/\s+/g, ' ')
  return normalized || fallback
}

function quotedFontFamily(family: string): string {
  return JSON.stringify(family)
}

function findEntry(family: string): FontEntry | undefined {
  return FONT_CATALOG.find((entry) => entry.family === family)
}

export function fontsForRole(role: FontRole): FontEntry[] {
  return FONT_CATALOG.filter((entry) => entry.roles.includes(role))
}

function resolveFontFamily(role: FontRole, family: string | undefined, fallback: string): string {
  const normalized = normalizeFontFamily(family ?? fallback, fallback)
  return fontsForRole(role).some((entry) => entry.family === normalized) ? normalized : fallback
}

export function resolveFontConfig(config?: Partial<FontConfig> | null): FontConfig {
  return {
    ui: resolveFontFamily('ui', config?.ui, FONT_CONFIG.ui),
    content: resolveFontFamily('content', config?.content, FONT_CONFIG.content),
    mono: resolveFontFamily('mono', config?.mono, FONT_CONFIG.mono),
    display: resolveFontFamily('display', config?.display, FONT_CONFIG.display),
  }
}

export function loadStoredFontConfig(): FontConfig {
  if (typeof window === 'undefined') return FONT_CONFIG
  try {
    const raw = window.localStorage.getItem(FONT_STORAGE_KEY)
    if (!raw) return FONT_CONFIG
    return resolveFontConfig(JSON.parse(raw) as Partial<FontConfig>)
  } catch {
    return FONT_CONFIG
  }
}

export function saveStoredFontConfig(config: FontConfig): FontConfig {
  const resolved = resolveFontConfig(config)
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(FONT_STORAGE_KEY, JSON.stringify(resolved))
  }
  return resolved
}

export function clearStoredFontConfig(): void {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(FONT_STORAGE_KEY)
  }
}

function buildLocalFontFace(entry: FontEntry): string {
  if (entry.source.kind !== 'local') return ''
  return entry.source.faces
    .map((face) => {
      const lines = [
        `  font-family: ${quotedFontFamily(entry.family)};`,
        `  src: url('${face.src}') format('${face.format}');`,
        `  font-display: swap;`,
      ]
      if (face.weight) lines.push(`  font-weight: ${face.weight};`)
      if (face.style) lines.push(`  font-style: ${face.style};`)
      return `@font-face {\n${lines.join('\n')}\n}`
    })
    .join('\n')
}

function buildLocalFontStylesheet(): string {
  return FONT_CATALOG
    .filter((entry) => entry.source.kind === 'local')
    .map(buildLocalFontFace)
    .join('\n')
}

function googleFontsHref(families: string[]): string | null {
  if (families.length === 0) return null
  const familyParams = Array.from(new Set(families))
    .map((family) => `family=${encodeURIComponent(family).replace(/%20/g, '+')}`)
    .join('&')
  return `https://fonts.googleapis.com/css2?${familyParams}&display=swap`
}

export function applyFontConfig(config: FontConfig = FONT_CONFIG): void {
  const resolved = resolveFontConfig(config)

  document.documentElement.style.setProperty('--font-ui-family', quotedFontFamily(resolved.ui))
  document.documentElement.style.setProperty('--font-content-family', quotedFontFamily(resolved.content))
  document.documentElement.style.setProperty('--font-mono-family', quotedFontFamily(resolved.mono))
  document.documentElement.style.setProperty('--font-display-family', quotedFontFamily(resolved.display))

  // Inject @font-face rules for every local family in the catalog (cheap; lets users
  // switch without reloading).
  let localStyle = document.getElementById(LOCAL_STYLE_ID) as HTMLStyleElement | null
  const localCss = buildLocalFontStylesheet()
  if (localCss) {
    if (localStyle == null) {
      localStyle = document.createElement('style')
      localStyle.id = LOCAL_STYLE_ID
      document.head.appendChild(localStyle)
    }
    if (localStyle.textContent !== localCss) {
      localStyle.textContent = localCss
    }
  }

  // Google Fonts link only for currently-selected Google families.
  const selectedGoogleFamilies = (Object.values(resolved) as string[]).filter((family) => {
    const entry = findEntry(family)
    return entry?.source.kind === 'google'
  })
  const href = googleFontsHref(selectedGoogleFamilies)
  let googleLink = document.getElementById(GOOGLE_LINK_ID) as HTMLLinkElement | null
  if (href) {
    if (googleLink == null) {
      googleLink = document.createElement('link')
      googleLink.id = GOOGLE_LINK_ID
      googleLink.rel = 'stylesheet'
      document.head.appendChild(googleLink)
    }
    if (googleLink.href !== href) {
      googleLink.href = href
    }
  } else if (googleLink) {
    googleLink.remove()
  }
}
