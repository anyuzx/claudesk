import { describe, expect, it } from 'vitest'

const AA_NORMAL_TEXT_CONTRAST = 4.5
const SURFACE_TOKENS = ['bg', 'sidebar', 'surface', 'hover', 'active-surface'] as const
const TEXT_TOKENS = ['display', 'primary', 'secondary', 'muted', 'active', 'accent', 'success', 'warn'] as const
const LIGHT_COLOR_TOKENS = [
  ...SURFACE_TOKENS,
  ...TEXT_TOKENS,
  'border',
] as const

type Rgb = [number, number, number]

function linearizeChannel(value: number): number {
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function relativeLuminance([red, green, blue]: Rgb): number {
  return 0.2126 * linearizeChannel(red)
    + 0.7152 * linearizeChannel(green)
    + 0.0722 * linearizeChannel(blue)
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(parseColor(foreground))
  const backgroundLuminance = relativeLuminance(parseColor(background))
  const lighter = Math.max(foregroundLuminance, backgroundLuminance)
  const darker = Math.min(foregroundLuminance, backgroundLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

function parseColor(value: string): Rgb {
  const normalized = value.trim()
  if (normalized.startsWith('#')) return parseHexColor(normalized)
  if (normalized.startsWith('oklch(')) return parseOklchColor(normalized)
  throw new Error(`Unsupported color value: ${value}`)
}

function parseHexColor(value: string): Rgb {
  const hex = value.slice(1)
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`Unsupported hex color: ${value}`)
  }
  return [
    Number.parseInt(hex.slice(0, 2), 16) / 255,
    Number.parseInt(hex.slice(2, 4), 16) / 255,
    Number.parseInt(hex.slice(4, 6), 16) / 255,
  ]
}

function parseOklchColor(value: string): Rgb {
  const match = value.match(/^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/)
  if (!match) {
    throw new Error(`Unsupported OKLCH color: ${value}`)
  }

  const lightness = Number.parseFloat(match[1]) / 100
  const chroma = Number.parseFloat(match[2])
  const hueRadians = Number.parseFloat(match[3]) * Math.PI / 180
  const a = chroma * Math.cos(hueRadians)
  const b = chroma * Math.sin(hueRadians)

  const long = lightness + 0.3963377774 * a + 0.2158037573 * b
  const medium = lightness - 0.1055613458 * a - 0.0638541728 * b
  const short = lightness - 0.0894841775 * a - 1.291485548 * b

  const longCubed = long ** 3
  const mediumCubed = medium ** 3
  const shortCubed = short ** 3

  return [
    4.0767416621 * longCubed - 3.3077115913 * mediumCubed + 0.2309699292 * shortCubed,
    -1.2684380046 * longCubed + 2.6097574011 * mediumCubed - 0.3413193965 * shortCubed,
    -0.0041960863 * longCubed - 0.7034186147 * mediumCubed + 1.707614701 * shortCubed,
  ].map(linearSrgbToSrgb) as Rgb
}

function linearSrgbToSrgb(value: number): number {
  const clamped = Math.min(1, Math.max(0, value))
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055
}

function extractBlock(css: string, selector: string): string {
  const match = css.match(new RegExp(`${selector.replace('.', '\\.')}\\s*{([\\s\\S]*?)\\n}`))
  if (!match) throw new Error(`Could not find ${selector} block`)
  return match[1]
}

function extractColorToken(block: string, name: string): string | null {
  const match = block.match(new RegExp(`--color-${name}:\\s*([^;]+);`))
  return match?.[1].trim() ?? null
}

describe('index.css design tokens', () => {
  it('keeps semantic text and state contrast at WCAG AA against core app surfaces', async () => {
    const fsPromises = 'node:fs/promises'
    const { readFile } = await import(fsPromises)
    const indexCss = await readFile(new URL('./index.css', import.meta.url), 'utf8')
    const darkTokens = extractBlock(indexCss, '@theme')
    const lightOverrides = extractBlock(indexCss, ':root.light')

    for (const [theme, overrides] of [
      ['dark', darkTokens],
      ['light', lightOverrides],
    ] as const) {
      for (const textToken of TEXT_TOKENS) {
        const textColor = extractColorToken(overrides, textToken)
        expect(textColor, `${theme} ${textToken} token`).toBeTruthy()

        for (const surface of SURFACE_TOKENS) {
          const surfaceColor = extractColorToken(overrides, surface)
          expect(surfaceColor, `${theme} ${surface} token`).toBeTruthy()
          expect(
            contrastRatio(textColor as string, surfaceColor as string),
            `${theme} ${textToken} on ${surface}`,
          ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_CONTRAST)
        }
      }
    }
  })

  it('keeps light theme tokens in the tinted OKLCH system', async () => {
    const fsPromises = 'node:fs/promises'
    const { readFile } = await import(fsPromises)
    const indexCss = await readFile(new URL('./index.css', import.meta.url), 'utf8')
    const lightOverrides = extractBlock(indexCss, ':root.light')

    for (const token of LIGHT_COLOR_TOKENS) {
      const color = extractColorToken(lightOverrides, token)
      expect(color, `light ${token} token`).toBeTruthy()
      expect(color, `light ${token} token`).toMatch(/^oklch\(/)
      expect(color, `light ${token} token`).not.toBe('oklch(100% 0 0)')
    }
  })

  it('keeps PDF pages in the border-only app chrome', async () => {
    const fsPromises = 'node:fs/promises'
    const { readFile } = await import(fsPromises)
    const indexCss = await readFile(new URL('./index.css', import.meta.url), 'utf8')

    expect(indexCss).toContain('box-shadow: none !important;')
    expect(indexCss).not.toContain('0 10px 24px')
  })

  it('does not opacity-dim readable inactive toolbar text', async () => {
    const fsPromises = 'node:fs/promises'
    const { readFile } = await import(fsPromises)
    const targets = [
      './components/DigestPane.tsx',
      './components/SavedPane.tsx',
      './components/SearchPane.tsx',
    ]

    for (const target of targets) {
      const source = await readFile(new URL(target, import.meta.url), 'utf8')
      expect(source).not.toContain('text-muted opacity-40')
      expect(source).not.toContain('hover:opacity-75')
    }
  })
})
