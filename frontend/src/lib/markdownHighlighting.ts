import rehypeShikiFromHighlighter from '@shikijs/rehype/core'
import bash from '@shikijs/langs/bash'
import css from '@shikijs/langs/css'
import diff from '@shikijs/langs/diff'
import html from '@shikijs/langs/html'
import javascript from '@shikijs/langs/javascript'
import json from '@shikijs/langs/json'
import jsx from '@shikijs/langs/jsx'
import markdown from '@shikijs/langs/markdown'
import python from '@shikijs/langs/python'
import r from '@shikijs/langs/r'
import sql from '@shikijs/langs/sql'
import tsx from '@shikijs/langs/tsx'
import typescript from '@shikijs/langs/typescript'
import yaml from '@shikijs/langs/yaml'
import { createHighlighterCoreSync, type ThemeRegistration } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import type { Pluggable } from 'unified'
import type { MarkdownCodeTheme } from './markdownHighlightingLoader'

// Chinese Palette intentionally uses literal hex colors. Shiki emits these as
// inline styles, keeping the theme portable for future Electron/Tauri packaging.
const chinesePaletteLightCodeTheme = {
  name: 'chinese-palette',
  type: 'light',
  colors: {
    'editor.background': '#f4f4f4',
    'editor.foreground': '#090a0b',
  },
  settings: [
    {
      settings: {
        background: '#f4f4f4',
        foreground: '#090a0b',
      },
    },
    {
      scope: [
        'comment',
        'punctuation.definition.comment',
        'markup.quote',
      ],
      settings: {
        foreground: '#696c77',
        fontStyle: 'italic',
      },
    },
    {
      scope: [
        'keyword',
        'storage',
        'storage.type',
        'support.type.property-name',
      ],
      settings: {
        foreground: '#5f549b',
        fontStyle: 'bold',
      },
    },
    {
      scope: [
        'entity.name.tag',
        'entity.name.section',
        'markup.deleted',
      ],
      settings: {
        foreground: '#9a394f',
      },
    },
    {
      scope: [
        'constant.language',
        'constant.other',
        'keyword.operator',
      ],
      settings: {
        foreground: '#005a8d',
      },
    },
    {
      scope: [
        'string',
        'string.quoted',
        'string.regexp',
        'markup.inserted',
        'entity.other.attribute-name',
      ],
      settings: {
        foreground: '#306754',
      },
    },
    {
      scope: [
        'entity.name.class',
        'entity.name.type',
        'support.class',
        'support.type',
        'support.type.primitive',
      ],
      settings: {
        foreground: '#5a6940',
      },
    },
    {
      scope: [
        'constant.numeric',
        'variable',
        'variable.other',
        'variable.parameter',
        'variable.language',
        'support.variable',
        'meta.property-name',
      ],
      settings: {
        foreground: '#a03c6d',
      },
    },
    {
      scope: [
        'entity.name.function',
        'entity.name.method',
        'support.function',
        'variable.function',
        'markup.heading',
        'markup.underline.link',
      ],
      settings: {
        foreground: '#395db2',
        fontStyle: 'bold',
      },
    },
    {
      scope: [
        'meta.function.parameters',
        'meta.parameters',
      ],
      settings: {
        foreground: '#8e615f',
      },
    },
    {
      scope: [
        'invalid',
        'invalid.illegal',
      ],
      settings: {
        foreground: '#9a394f',
      },
    },
  ],
} satisfies ThemeRegistration

const chinesePaletteDarkCodeTheme = {
  name: 'chinese-palette-dark',
  type: 'dark',
  colors: {
    'editor.background': '#0c0f12',
    'editor.foreground': '#e0ded9',
  },
  settings: [
    {
      settings: {
        background: '#0c0f12',
        foreground: '#e0ded9',
      },
    },
    {
      scope: [
        'comment',
        'punctuation.definition.comment',
        'markup.quote',
      ],
      settings: {
        foreground: '#7c888f',
        fontStyle: 'italic',
      },
    },
    {
      scope: [
        'keyword',
        'storage',
        'storage.type',
        'support.type.property-name',
      ],
      settings: {
        foreground: '#afa8e7',
        fontStyle: 'bold',
      },
    },
    {
      scope: [
        'entity.name.tag',
        'entity.name.section',
        'markup.deleted',
      ],
      settings: {
        foreground: '#e08795',
      },
    },
    {
      scope: [
        'constant.language',
        'constant.other',
        'keyword.operator',
      ],
      settings: {
        foreground: '#71b2e5',
      },
    },
    {
      scope: [
        'string',
        'string.quoted',
        'string.regexp',
        'markup.inserted',
        'entity.other.attribute-name',
      ],
      settings: {
        foreground: '#6fb99e',
      },
    },
    {
      scope: [
        'entity.name.class',
        'entity.name.type',
        'support.class',
        'support.type',
        'support.type.primitive',
      ],
      settings: {
        foreground: '#9aad7c',
      },
    },
    {
      scope: [
        'constant.numeric',
        'variable',
        'variable.other',
        'variable.parameter',
        'variable.language',
        'support.variable',
        'meta.property-name',
      ],
      settings: {
        foreground: '#d98dad',
      },
    },
    {
      scope: [
        'entity.name.function',
        'entity.name.method',
        'support.function',
        'variable.function',
        'markup.heading',
        'markup.underline.link',
      ],
      settings: {
        foreground: '#8dadf1',
        fontStyle: 'bold',
      },
    },
    {
      scope: [
        'meta.function.parameters',
        'meta.parameters',
      ],
      settings: {
        foreground: '#c1908e',
      },
    },
    {
      scope: [
        'invalid',
        'invalid.illegal',
      ],
      settings: {
        foreground: '#e48394',
      },
    },
  ],
} satisfies ThemeRegistration

const highlighter = createHighlighterCoreSync({
  themes: [chinesePaletteLightCodeTheme, chinesePaletteDarkCodeTheme],
  langs: [
    bash,
    css,
    diff,
    html,
    javascript,
    json,
    jsx,
    markdown,
    python,
    r,
    sql,
    tsx,
    typescript,
    yaml,
  ],
  engine: createJavaScriptRegexEngine(),
})

const codeHighlightCaches = {
  dark: new Map(),
  light: new Map(),
} satisfies Record<MarkdownCodeTheme, Map<unknown, unknown>>

const shikiThemeNames = {
  dark: 'chinese-palette-dark',
  light: 'chinese-palette',
} satisfies Record<MarkdownCodeTheme, string>

export function createRehypeCodeHighlight(theme: MarkdownCodeTheme): Pluggable {
  return [
    rehypeShikiFromHighlighter,
    highlighter,
    {
      addLanguageClass: true,
      cache: codeHighlightCaches[theme],
      defaultLanguage: 'text',
      fallbackLanguage: 'text',
      stripEndNewline: true,
      theme: shikiThemeNames[theme],
    },
  ]
}
