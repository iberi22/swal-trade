// Prueba de humo del paquete tal y como lo recibe un usuario: empaqueta, instala en un
// directorio vacío (sin el repositorio), arranca el binario instalado por stdio y llama a una
// herramienta que necesita el núcleo de análisis. Uso: node scripts/verify-pack.mjs
// Necesita red solo para `npm install`: las velas son sintéticas (Binance responde 451 desde las IP de
// los ejecutores de CI y la prueba no debe depender de un mercado en vivo). No usa claves.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(path.join(tmpdir(), 'swal-verify-pack-'));
let client;
try {
  // No se confía en los ganchos de npm (ignore-scripts=true es habitual): se construye a mano.
  execFileSync('npm', ['run', 'build'], { cwd: pkg, stdio: 'pipe' });
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', work], { cwd: pkg, encoding: 'utf8' }))[0];
  const tarball = path.join(work, packed.filename);
  const app = path.join(work, 'app');
  execFileSync('mkdir', [app]);
  writeFileSync(path.join(app, 'package.json'), '{"name":"verify","private":true}\n');
  execFileSync('npm', ['install', '--no-audit', '--no-fund', tarball], { cwd: app, stdio: 'pipe' });

  const bin = path.join(app, 'node_modules/@swal-trade/mcp/dist/index.js');
  // Velas sintéticas deterministas: sube con ondas, con mechas. Solo el camino /fapi/v1/klines.
  const preload = path.join(work, 'fetch-preload.mjs');
  writeFileSync(
    preload,
    `const rows = [];
let price = 100;
for (let i = 0; i < 400; i++) {
  const open = price;
  const close = open * (1 + 0.004 * Math.sin(i / 7) + 0.0006);
  const high = Math.max(open, close) * 1.002;
  const low = Math.min(open, close) * 0.998;
  const t = 1_700_000_000_000 + i * 3_600_000;
  rows.push([t, String(open), String(high), String(low), String(close), String(10 + (i % 9)), t + 3_599_999, '0', 100, '5', '0', '0']);
  price = close;
}
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (new URL(href).pathname === '/fapi/v1/klines') return Response.json(rows);
  return real(input, init);
};
`,
  );
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('SWAL_') || k.startsWith('BINANCE_')) delete env[k];
  client = new Client({ name: 'verify-pack', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', preload, bin], env, cwd: app, stderr: 'pipe' }));

  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  console.log('herramientas:', names.join(', '));
  assert.ok(names.includes('analyze_chart') && names.includes('grid_plan'));
  assert.ok(!names.some((n) => /place_order|close_position|grid_place/.test(n)), 'las escrituras no deben registrarse por defecto');

  const res = await client.callTool({ name: 'analyze_chart', arguments: { symbol: 'BTCUSDT', timeframe: '1h', limit: 120 } });
  assert.notEqual(res.isError, true, JSON.stringify(res));
  const body = JSON.parse(res.content.find((c) => c.type === 'text').text);
  assert.ok(Array.isArray(body.findings), 'analyze_chart sin núcleo: ' + JSON.stringify(body).slice(0, 200));
  console.log('analyze_chart desde el paquete instalado: OK,', body.findings.length, 'hallazgos');
  console.log('verify-pack: OK');
} finally {
  try {
    await client?.close();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
