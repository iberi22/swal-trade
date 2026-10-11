import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const e2eRoot = path.resolve(here, '..');
const repoRoot = path.resolve(e2eRoot, '..');
const serverPath = path.join(repoRoot, 'packages/mcp/dist/index.js');
const preload = path.join(here, 'fetch-preload.mjs');

const WRITE = /place_order|cancel|withdraw|transfer|create_order|grid_place|modify_order|close_position|set_leverage/i;

function textOf(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const block = result.content.find((item) => item.type === 'text');
  assert.ok(block && 'text' in block);
  return block.text;
}

const logDir = await mkdtemp(path.join(tmpdir(), 'swal-mcp-e2e-'));
const logFile = path.join(logDir, 'fetch.log');
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.startsWith('SWAL_') || key.startsWith('BINANCE_') || key === 'NODE_OPTIONS') delete env[key];
}
env.SWAL_E2E_FETCH_LOG = logFile;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', preload, serverPath],
  env,
  stderr: 'pipe',
});
const client = new Client({ name: 'swal-trade-e2e', version: '0.0.0' });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['account_risk', 'analyze_chart', 'explain_analysis', 'grid_plan', 'market_context', 'propose_order']);
  // explain_analysis habla con el hosting por POST: aquí solo se comprueba que existe y es de lectura.
  const explain = listed.tools.find((tool) => tool.name === 'explain_analysis');
  assert.match(explain.description, /deterministic fallback/);
  for (const tool of listed.tools) {
    assert.equal(WRITE.test(tool.name), false, tool.name);
    assert.notEqual(tool.annotations?.destructiveHint, true, tool.name);
  }

  const analyzed = JSON.parse(
    textOf(
      await client.callTool({
        name: 'analyze_chart',
        arguments: { symbol: 'btcusdt', timeframe: '15m', limit: 80 },
      }),
    ),
  );
  const doble = analyzed.findings.find((finding) => finding.kind === 'double_bottom');
  assert.ok(doble, `findings: ${analyzed.findings.map((f) => f.kind).join(' ')}`);
  assert.equal(typeof doble.strength, 'number');
  assert.equal(JSON.stringify(analyzed).includes('"probability"'), false);

  const proposal = JSON.parse(
    textOf(
      await client.callTool({
        name: 'propose_order',
        arguments: {
          symbol: 'BTCUSDT',
          side: 'BUY',
          notional_usd: 100,
          stop_loss_pct: 1,
          leverage: 2,
        },
      }),
    ),
  );
  assert.equal(proposal.sent, false);
  assert.equal(proposal.orderType, 'MARKET');
  assert.equal(proposal.quantity, 1);
  assert.equal(proposal.markPrice, 100);
  assert.equal(proposal.stopPrice, 99);
  assert.equal(proposal.stopOrderType, 'STOP_MARKET');
  assert.match(proposal.note, /nothing was sent/i);

  const log = await readFile(logFile, 'utf8');
  assert.match(log, /GET https:\/\/fapi\.binance\.com\/fapi\/v1\/klines\?.*interval=15m/);
  assert.match(log, /GET https:\/\/fapi\.binance\.com\/fapi\/v1\/premiumIndex/);
  assert.equal(/POST /i.test(log), false, log);
  console.log('mcp stdio: ok', names.join(', '));
} finally {
  await client.close().catch(() => {});
  await rm(logDir, { recursive: true, force: true });
}
