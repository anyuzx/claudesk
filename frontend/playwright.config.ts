import { defineConfig, devices } from '@playwright/test'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const configDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(configDir, '..')
const testVault = join(tmpdir(), 'claudesk-playwright-vault')
const backendPort = 18_765
const frontendPort = 15_173
const backendUrl = `http://127.0.0.1:${backendPort}`
const frontendUrl = `http://127.0.0.1:${frontendPort}`

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: frontendUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: `python -m uvicorn claudesk.api.main:app --host 127.0.0.1 --port ${backendPort}`,
      cwd: repoRoot,
      env: {
        ...process.env,
        CLAUDESK_DATA_DIR: testVault,
      },
      url: `${backendUrl}/api/settings`,
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${frontendPort} --strictPort`,
      cwd: configDir,
      env: {
        ...process.env,
        CLAUDESK_API_TARGET: backendUrl,
      },
      url: frontendUrl,
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
