import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cpSync, createReadStream, readFileSync, rmSync, statSync } from 'node:fs'
import { extname, isAbsolute, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const apiTarget = process.env.CLAUDESK_API_TARGET ?? 'http://localhost:8765'
const packageJsonPath = fileURLToPath(new URL('./package.json', import.meta.url))
const changelogPath = fileURLToPath(new URL('../CHANGELOG.md', import.meta.url))
const appVersion = loadAppVersion()
const appReleaseDate = loadAppReleaseDate(appVersion)
const pdfjsDistRoot = fileURLToPath(new URL('./node_modules/pdfjs-dist/', import.meta.url))
const pdfjsAssetDirectories = {
  cmaps: 'cmaps',
  standard_fonts: 'standard_fonts',
  wasm: 'wasm',
} as const
const pdfjsAssetSources = Object.fromEntries(
  Object.entries(pdfjsAssetDirectories).map(([publicName, sourceName]) => [
    publicName,
    resolvePath(pdfjsDistRoot, sourceName),
  ]),
) as Record<keyof typeof pdfjsAssetDirectories, string>

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function loadAppVersion(): string {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown }
  return typeof packageJson.version === 'string' ? packageJson.version : '0.0.0'
}

function loadAppReleaseDate(version: string): string {
  const changelog = readFileSync(changelogPath, 'utf8')
  const heading = new RegExp(`^## \\[?${escapeRegExp(version)}\\]? - (\\d{4}-\\d{2}-\\d{2})$`, 'm')
  return heading.exec(changelog)?.[1] ?? ''
}

function pdfjsAssetContentType(filePath: string): string {
  switch (extname(filePath)) {
    case '.bcmap':
    case '.pfb':
      return 'application/octet-stream'
    case '.wasm':
      return 'application/wasm'
    default:
      return 'application/octet-stream'
  }
}

function resolvePdfjsAssetRequest(url: string | undefined): string | null {
  if (!url) return null
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(url, 'http://claudesk.local').pathname)
  } catch {
    return null
  }
  const [directory, ...fileParts] = pathname.split('/').filter(Boolean)
  const sourceRoot = pdfjsAssetSources[directory as keyof typeof pdfjsAssetSources]
  if (!sourceRoot || fileParts.length === 0) return null
  if (fileParts.some((part) => part === '..' || part.includes('/') || part.includes('\\'))) return null
  const filePath = resolvePath(sourceRoot, ...fileParts)
  if (!filePath.startsWith(`${sourceRoot}${sep}`)) return null
  return filePath
}

function pdfjsAssetsPlugin(): Plugin {
  let outputDirectory = ''

  return {
    name: 'claudesk-pdfjs-assets',
    configResolved(config) {
      outputDirectory = isAbsolute(config.build.outDir)
        ? config.build.outDir
        : resolvePath(config.root, config.build.outDir)
    },
    configureServer(server) {
      server.middlewares.use('/assets/pdfjs', (request, response, next) => {
        const filePath = resolvePdfjsAssetRequest(request.url)
        if (!filePath) {
          next()
          return
        }
        try {
          const stats = statSync(filePath)
          if (!stats.isFile()) {
            next()
            return
          }
          response.statusCode = 200
          response.setHeader('Content-Type', pdfjsAssetContentType(filePath))
          response.setHeader('Content-Length', stats.size)
          createReadStream(filePath).on('error', next).pipe(response)
        } catch {
          next()
        }
      })
    },
    closeBundle() {
      const outputRoot = resolvePath(outputDirectory, 'assets/pdfjs')
      rmSync(outputRoot, { recursive: true, force: true })
      for (const [publicName, sourceRoot] of Object.entries(pdfjsAssetSources)) {
        cpSync(sourceRoot, resolvePath(outputRoot, publicName), { recursive: true })
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), pdfjsAssetsPlugin()],
  define: {
    __CLAUDESK_VERSION__: JSON.stringify(appVersion),
    __CLAUDESK_RELEASE_DATE__: JSON.stringify(appReleaseDate),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    include: [
      '@milkdown/kit/core',
      '@milkdown/kit/plugin/clipboard',
      '@milkdown/kit/plugin/history',
      '@milkdown/kit/plugin/listener',
      '@milkdown/kit/preset/commonmark',
      '@milkdown/kit/preset/gfm',
      '@milkdown/kit/prose',
      '@milkdown/kit/prose/commands',
      '@milkdown/kit/prose/inputrules',
      '@milkdown/kit/prose/state',
      '@milkdown/kit/prose/view',
      '@milkdown/kit/utils',
      'katex',
      'remark-math',
    ],
  },
  build: {
    outDir: 'dist',
  },
})
