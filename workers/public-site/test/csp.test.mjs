import test from 'node:test';
import assert from 'node:assert/strict';
import { cspFor } from '../src/worker.js';

test('cspFor: only checkout/guardian may reach external hosts', () => {
  assert.match(cspFor('/'), /connect-src 'self'$/);
  assert.match(cspFor('/pricing/'), /connect-src 'self'$/);
  assert.match(cspFor('/checkout/'), /connect-src 'self' https:\/\/pay\.swal\.network$/);
  const g = cspFor('/guardian/');
  for (const host of ['https://fapi.binance.com', 'https://api.telegram.org', 'https://pay.swal.network']) {
    assert.ok(g.includes(host), host);
  }
  assert.ok(!cspFor('/').includes('googleapis'));
});
