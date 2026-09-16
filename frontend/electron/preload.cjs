const { contextBridge, ipcRenderer } = require('electron')

function desktopPlatform() {
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'win32') return 'windows'
  return 'linux'
}

function gpuMode() {
  const mode = (process.env.CLAUDESK_ELECTRON_GPU_MODE || 'auto').trim().toLowerCase()
  if (mode !== 'auto' && mode !== 'force' && mode !== 'off') return 'auto'
  if (mode === 'force' && process.platform !== 'linux') return 'auto'
  return mode
}

const desktop = {
  shell: 'electron',
  platform: desktopPlatform(),
  titlebarOverlay: process.platform === 'linux',
  gpuMode: gpuMode(),
  getGpuDiagnostics: () => ipcRenderer.invoke('claudesk:get-gpu-diagnostics'),
}

if (process.platform === 'linux') {
  desktop.setTitlebarOverlayTheme = (theme) => {
    return ipcRenderer.invoke('claudesk:set-titlebar-overlay-theme', theme)
  }
}

contextBridge.exposeInMainWorld('claudeskDesktop', desktop)
