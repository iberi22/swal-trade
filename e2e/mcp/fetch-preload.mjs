// Sustituye fetch global antes de que arranque el servidor MCP.
// El CLI (packages/mcp/src/index.ts) no acepta fetch por argumento: createServer()
// usa el fetch global. Este preload es el mock de red del e2e STDIO.
import { appendFileSync } from 'node:fs';
import { toBinanceKlines } from '../fixtures/candles.mjs';

const logFile = process.env.SWAL_E2E_FETCH_LOG;

function hrefOf(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && 'url' in input) return String(input.url);
  return String(input);
}

function note(method, href) {
  if (!logFile) return;
  appendFileSync(logFile, `${method} ${href}\n`);
}

const klines = toBinanceKlines();

globalThis.fetch = async (input, init = {}) => {
  const href = hrefOf(input);
  const method = String(init.method || 'GET').toUpperCase();
  note(method, href);
  const url = new URL(href);
  if (method !== 'GET') {
    return Response.json({ error: 'e2e refuses non-GET' }, { status: 405 });
  }
  if (url.pathname === '/fapi/v1/klines') {
    return Response.json(klines);
  }
  if (url.pathname === '/fapi/v1/premiumIndex') {
    return Response.json({ markPrice: '100', symbol: url.searchParams.get('symbol') });
  }
  return Response.json({ error: 'not mocked', path: url.pathname }, { status: 404 });
};
