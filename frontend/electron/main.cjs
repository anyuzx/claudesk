const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')

const TITLEBAR_OVERLAY_HEIGHT = 48
const APP_ICON_PATH = path.join(__dirname, '..', 'public', 'icon-512.png')
const TITLEBAR_OVERLAY_COLORS = {
  dark: '#050709',
  light: '#ffffff',
}
const GPU_DIAGNOSTICS_PREFIX = '[claudesk:electron:gpu]'
const GPU_FEATURE_KEYS = [
  'gpu_compositing',
  'rasterization',
  'webgl',
  'webgl2',
  'video_decode',
]
const VALID_GPU_MODES = new Set(['auto', 'force', 'off'])

function requestedGpuMode() {
  const mode = (process.env.CLAUDESK_ELECTRON_GPU_MODE || 'auto').trim().toLowerCase()
  if (VALID_GPU_MODES.has(mode)) return mode
  console.warn(`${GPU_DIAGNOSTICS_PREFIX} Ignoring invalid CLAUDESK_ELECTRON_GPU_MODE="${mode}". Expected auto, force, or off.`)
  return 'auto'
}

const requestedGpuModeValue = requestedGpuMode()
const gpuMode = requestedGpuModeValue === 'force' && process.platform !== 'linux' ? 'auto' : requestedGpuModeValue
const appliedGpuSwitches = []

function appendGpuSwitch(name, value) {
  if (value === undefined) {
    app.commandLine.appendSwitch(name)
  } else {
    app.commandLine.appendSwitch(name, value)
  }
  appliedGpuSwitches.push(value ? `${name}=${value}` : name)
}

function configureGpuMode() {
  if (gpuMode === 'off') {
    app.disableHardwareAcceleration()
    console.info(`${GPU_DIAGNOSTICS_PREFIX} Hardware acceleration disabled by CLAUDESK_ELECTRON_GPU_MODE=off.`)
    return
  }

  if (requestedGpuModeValue === 'force' && process.platform !== 'linux') {
    console.warn(`${GPU_DIAGNOSTICS_PREFIX} CLAUDESK_ELECTRON_GPU_MODE=force is Linux-only; using Electron defaults.`)
    return
  }

  if (gpuMode !== 'force') return

  appendGpuSwitch('ignore-gpu-blocklist')
  appendGpuSwitch('enable-gpu-rasterization')
  appendGpuSwitch('ozone-platform-hint', 'auto')
  console.info(`${GPU_DIAGNOSTICS_PREFIX} Force GPU mode enabled with switches: ${appliedGpuSwitches.join(', ')}.`)
}

let gpuDiagnostics = {
  state: 'pending',
  gpuMode,
  requestedGpuMode: requestedGpuModeValue,
  platform: process.platform,
  appliedSwitches: appliedGpuSwitches,
}

function rendererUrl() {
  return process.env.CLAUDESK_ELECTRON_RENDERER_URL || 'http://127.0.0.1:5173'
}

function titlebarOverlayOptions(theme = 'dark') {
  const color = TITLEBAR_OVERLAY_COLORS[theme] || TITLEBAR_OVERLAY_COLORS.dark
  return {
    color,
    height: TITLEBAR_OVERLAY_HEIGHT,
  }
}

function selectedGpuFeatureStatus(status) {
  return Object.fromEntries(GPU_FEATURE_KEYS.map((key) => [key, status?.[key] || 'unknown']))
}

async function collectGpuDiagnostics() {
  const diagnostics = {
    state: 'ready',
    gpuMode,
    requestedGpuMode: requestedGpuModeValue,
    platform: process.platform,
    appliedSwitches: appliedGpuSwitches,
    hardwareAccelerationEnabled: app.isHardwareAccelerationEnabled(),
    featureStatus: selectedGpuFeatureStatus(app.getGPUFeatureStatus()),
    gpuInfo: null,
    gpuInfoError: null,
  }

  try {
    diagnostics.gpuInfo = await app.getGPUInfo('basic')
  } catch (err) {
    diagnostics.gpuInfoError = err instanceof Error ? err.message : String(err)
  }

  gpuDiagnostics = diagnostics
  console.info(GPU_DIAGNOSTICS_PREFIX, JSON.stringify(gpuDiagnostics, null, 2))
}

configureGpuMode()

ipcMain.handle('claudesk:set-titlebar-overlay-theme', (event, theme) => {
  if (process.platform !== 'linux') return
  if (theme !== 'dark' && theme !== 'light') return
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) return
  window.setTitleBarOverlay(titlebarOverlayOptions(theme))
})

ipcMain.handle('claudesk:get-gpu-diagnostics', () => gpuDiagnostics)

app.on('gpu-info-update', () => {
  void collectGpuDiagnostics()
})

function createWindow() {
  const isMac = process.platform === 'darwin'
  const isLinux = process.platform === 'linux'
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: 'claudesk',
    icon: APP_ICON_PATH,
    titleBarStyle: isMac || isLinux ? 'hidden' : 'default',
    ...(isMac ? { trafficLightPosition: { x: 12, y: 15 } } : {}),
    ...(isLinux ? { titleBarOverlay: titlebarOverlayOptions() } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })

  void window.loadURL(rendererUrl())
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
