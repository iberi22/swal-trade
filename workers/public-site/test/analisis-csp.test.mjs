import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cspFor } from '../src/worker.js';

test('cspFor: /analisis/ puede hablar con Binance publico y fear & greed, y nada mas', () => {
  const c = cspFor('/analisis/');
  assert.match(c, /connect-src 'self' https:\/\/fapi\.binance\.com wss:\/\/fstream\.binance\.com https:\/\/api\.alternative\.me$/);
  assert.match(c, /script-src 'self'(;|$)/);
  assert.doesNotMatch(c, /pay\.swal\.network|telegram/);
  assert.match(cspFor('/pricing/'), /connect-src 'self'$/);
});

test('_headers repite la CSP de /analisis/*', () => {
  const h = readFileSync(new URL('../static/_headers', import.meta.url), 'utf8');
  const block = h.split('\n\n').find((b) => b.startsWith('/analisis/*'));
  assert.ok(block);
  assert.ok(block.includes(cspFor('/analisis/')), 'debe coincidir con cspFor');
});
