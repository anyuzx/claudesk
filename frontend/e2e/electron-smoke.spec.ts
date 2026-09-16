import { _electron as electron, expect, test } from '@playwright/test'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electronExecutable = require('electron') as string
const configDir = dirname(fileURLToPath(import.meta.url))
const frontendDir = resolve(configDir, '..')
const mainPath = resolve(frontendDir, 'electron/main.cjs')
const rendererUrl = process.env.CLAUDESK_ELECTRON_RENDERER_URL ?? 'http://127.0.0.1:15173'
const expectedPlatform = process.platform === 'darwin'
  ? 'macos'
  : process.platform === 'win32'
    ? 'windows'
    : 'linux'
const expectedTitlebarOverlay = process.platform === 'linux'
type GpuMode = 'auto' | 'force' | 'off'

function expectedGpuMode(): GpuMode {
  const mode = (process.env.CLAUDESK_ELECTRON_GPU_MODE ?? 'auto').trim().toLowerCase()
  if (mode !== 'auto' && mode !== 'force' && mode !== 'off') return 'auto'
  if (mode === 'force' && process.platform !== 'linux') return 'auto'
  return mode
}

type DesktopWindow = Window & {
  claudeskDesktop?: {
    shell: 'electron'
    platform: 'macos' | 'windows' | 'linux'
    titlebarOverlay: boolean
    gpuMode: GpuMode
    setTitlebarOverlayTheme?: (theme: 'dark' | 'light') => Promise<void>
    getGpuDiagnostics?: () => Promise<{
      state: 'pending' | 'ready'
      gpuMode: GpuMode
      platform: string
      appliedSwitches: string[]
    }>
  }
}

const electronSmokeEnabled = process.env.npm_lifecycle_event === 'e2e:electron' ||
  process.env.ELECTRON_SMOKE === '1'
const hasLinuxDisplay = process.platform !== 'linux' ||
  Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)

test.skip(!electronSmokeEnabled, 'Run npm run e2e:electron or set ELECTRON_SMOKE=1 to run the Electron smoke test.')
test.skip(!hasLinuxDisplay, 'Electron smoke requires a Linux display server or macOS/Windows GUI session.')

test('loads the renderer through the Electron preload contract', async () => {
  const electronApp = await electron.launch({
    executablePath: electronExecutable,
    args: [mainPath],
    env: {
      ...process.env,
      CLAUDESK_ELECTRON_RENDERER_URL: rendererUrl,
    },
  })

  try {
    const window = await electronApp.firstWindow()
    await expect(window).toHaveTitle(/claudesk/i)
    await expect(window.locator('html')).toHaveAttribute('data-desktop-shell', 'electron')
    await expect(window.locator('html')).toHaveAttribute('data-platform', expectedPlatform)
    if (expectedTitlebarOverlay) {
      await expect(window.locator('html')).toHaveAttribute('data-titlebar-overlay', 'true')
    } else {
      await expect(window.locator('html')).not.toHaveAttribute('data-titlebar-overlay', 'true')
    }
    await expect(window.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()

    const desktop = await window.evaluate(async () => {
      const api = (window as DesktopWindow).claudeskDesktop
      return {
        shell: api?.shell,
        platform: api?.platform,
        titlebarOverlay: api?.titlebarOverlay,
        gpuMode: api?.gpuMode,
        hasSetTitlebarOverlayTheme: typeof api?.setTitlebarOverlayTheme === 'function',
        hasGetGpuDiagnostics: typeof api?.getGpuDiagnostics === 'function',
        gpuDiagnostics: await api?.getGpuDiagnostics?.(),
      }
    })
    expect(desktop).toMatchObject({
      shell: 'electron',
      platform: expectedPlatform,
      titlebarOverlay: expectedTitlebarOverlay,
      gpuMode: expectedGpuMode(),
      hasSetTitlebarOverlayTheme: expectedTitlebarOverlay,
      hasGetGpuDiagnostics: true,
    })
    expect(desktop.gpuDiagnostics?.gpuMode).toBe(expectedGpuMode())
    expect(['pending', 'ready']).toContain(desktop.gpuDiagnostics?.state)
    expect(Array.isArray(desktop.gpuDiagnostics?.appliedSwitches)).toBe(true)
  } finally {
    await electronApp.close()
  }
})
