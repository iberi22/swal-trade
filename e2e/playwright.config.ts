import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const port = process.env.E2E_PORT || '18787';
const baseURL = `http://127.0.0.1:${port}`;

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: path.join(here, 'test-results'),
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    {
      name: 'site',
      testMatch: /tests\/(site|analisis|checkout|guardian|pwa|evidencia|operativa-privacy)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Una prueba por área del panel: tests/ext-<area>.spec.ts, con el arnés
      // compartido en tests/helpers/panel.ts (ver tests/README.md).
      name: 'extension',
      testMatch: /tests\/ext-[a-z-]+\.spec\.ts/,
    },
    {
      // Opcional: corre contra la página pública de Binance. Se salta si no está
      // E2E_BINANCE_LIVE=1 (npm run e2e:binance-live).
      name: 'binance-live',
      testMatch: /tests\/binance-live\.spec\.ts/,
    },
  ],
  webServer: {
    // wrangler 4.118 (workerd to 2026-08-06) cannot start compatibility_date 2026-09-16.
    command: `npx --yes wrangler@4.149.0 dev --local --port ${port} --ip 127.0.0.1`,
    cwd: path.join(repoRoot, 'workers/public-site'),
    url: `${baseURL}/`,
    reuseExistingServer: process.env.E2E_REUSE === '1',
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
