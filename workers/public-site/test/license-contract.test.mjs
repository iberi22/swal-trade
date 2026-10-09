import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenFromStored, loadPubkey } from '../static/guardian/guardian-license.js';

test('tokenFromStored reads the JSON written by /checkout/ and raw tokens', () => {
  assert.equal(tokenFromStored(JSON.stringify({ token: 'aaa.bbb', plan: 'pro_month' })), 'aaa.bbb');
  assert.equal(tokenFromStored('aaa.bbb'), 'aaa.bbb');
  assert.equal(tokenFromStored(null), null);
  assert.equal(tokenFromStored('{bad json'), null);
  assert.equal(tokenFromStored(JSON.stringify({ plan: 'x' })), null);
});

test('loadPubkey accepts the billing worker shape {algorithm, spki_base64, issuer}', async () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const fetchFn = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' },
    json: async () => ({ algorithm: 'Ed25519', spki_base64: 'MCowBQYDK2VwAyEAabc=', issuer: 'swal-trade-billing' }),
    text: async () => JSON.stringify({ algorithm: 'Ed25519', spki_base64: 'MCowBQYDK2VwAyEAabc=' }) });
  assert.equal(await loadPubkey({ fetchFn, storage }), 'MCowBQYDK2VwAyEAabc=');
});
