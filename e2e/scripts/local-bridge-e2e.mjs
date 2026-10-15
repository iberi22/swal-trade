import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const extensionDir = path.join(repoRoot, 'apps/extension/.output/chrome-mv3');
const serverPath = path.join(repoRoot, 'packages/mcp/dist/index.js');

async function run() {
  const tempHome = fs.mkdtempSync('/tmp/swal-e2e-home-');
  const tempUserData = fs.mkdtempSync('/tmp/swal-e2e-user-');
  const port = 47321;

  console.log('--- 1. Starting MCP server ---');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      HOME: tempHome,
      SWAL_MCP_CHART_BRIDGE: 'enabled',
      SWAL_MCP_CHART_PORT: String(port),
    },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'claude-local-check', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  console.log('MCP server connected via stdio');

  const tokenFile = path.join(tempHome, '.config', 'swal-trade', 'chart-bridge-token');
  let token = '';
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(tokenFile)) {
      token = fs.readFileSync(tokenFile, 'utf8').trim();
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const stat = fs.statSync(tokenFile);
  console.log(`Token created at ${tokenFile} (mode 0${(stat.mode & 0o777).toString(8)}, length ${token.length})`);

  console.log('--- 2. Launching Chromium with extension ---');
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  const context = await chromium.launchPersistentContext(tempUserData, {
    executablePath,
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--headless=new',
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  });

  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(worker.url()).host;
  console.log(`Extension loaded in Chromium. ID: ${extensionId}`);

  console.log('--- 3. Configuring extension settings in storage.local ---');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  await page.evaluate(
    async ({ port, token }) => {
      const api = window.chrome;
      await new Promise((resolve) => {
        api.storage.local.set(
          {
            settings: {
              defaultTimeframe: '15m',
              symbols: [],
              autoSync: true,
              paintOnChart: true,
              explainWithAi: false,
              claudeBridgeEnabled: true,
              claudeBridgePort: port,
              claudeBridgeToken: token,
            },
          },
          resolve,
        );
      });
    },
    { port, token },
  );

  console.log('Waiting for extension to connect and complete hello handshake...');
  await new Promise((r) => setTimeout(r, 2000));

  console.log('--- 4. Calling chart_state via MCP client ---');
  const stateRes = await client.callTool({ name: 'chart_state', arguments: {} });
  console.log('chart_state tool response:');
  console.log(JSON.stringify(stateRes, null, 2));

  console.log('--- 5. Calling chart_paint via MCP client ---');
  const paintRes = await client.callTool({
    name: 'chart_paint',
    arguments: {
      shapes: [
        {
          kind: 'level',
          text: 'Soporte clave',
          points: [{ time: 1710000000, price: 68500 }],
        },
        {
          kind: 'trend',
          text: 'Tendencia alcista',
          points: [
            { time: 1710000000, price: 67000 },
            { time: 1710003600, price: 68500 },
          ],
        },
      ],
    },
  });
  console.log('chart_paint tool response:');
  console.log(JSON.stringify(paintRes, null, 2));

  console.log('--- 6. Calling chart_clear via MCP client ---');
  const clearRes = await client.callTool({ name: 'chart_clear', arguments: {} });
  console.log('chart_clear tool response:');
  console.log(JSON.stringify(clearRes, null, 2));

  console.log('--- 7. Cleanup ---');
  await page.close();
  await context.close();
  await client.close();
  fs.rmSync(tempHome, { recursive: true, force: true });
  fs.rmSync(tempUserData, { recursive: true, force: true });
  console.log('--- SUCCESS: End-to-end local check passed! ---');
}

run().catch((err) => {
  console.error('Local check failed:', err);
  process.exit(1);
});
