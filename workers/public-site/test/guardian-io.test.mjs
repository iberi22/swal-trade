import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { webcrypto } from 'node:crypto';
import { createClient, importSecret } from '../static/guardian/binance-ro.js';
import { checkLicense } from '../static/guardian/guardian-license.js';
import { sendTelegram } from '../static/guardian/telegram.js';

const subtle = webcrypto.subtle;
const b64u = (buf) => Buffer.from(buf).toString('base64url');

test('binance client: signed read-only GETs, non-extractable key, time offset, pagination', async () => {
  const hmacKey = await importSecret('s3cret', subtle);
  assert.equal(hmacKey.extractable, false);
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.includes('/fapi/v1/time')) return { ok: true, json: async () => ({ serverTime: 1_000_500 }) };
    if (url.includes('/fapi/v1/income')) {
      const n = calls.filter((c) => c.url.includes('/income')).length;
      const page = n === 1 ? Array.from({ length: 1000 }, (_, i) => ({ time: 1000 + i })) : [{ time: 5000 }];
      return { ok: true, json: async () => page };
    }
    return { ok: true, json: async () => ({}) };
  };
  const c = createClient({ apiKey: 'AK', hmacKey, fetchFn, subtle, now: () => 1_000_000 });
  assert.equal(await c.syncTime(), 500);
  const rows = await c.incomeSince(0);
  assert.equal(rows.length, 1001);
  await c.account();
  for (const { url, opts } of calls.filter((x) => !x.url.includes('/time'))) {
    assert.ok(url.startsWith('https://fapi.binance.com/'));
    assert.equal(opts.method, 'GET');
    assert.equal(opts.headers['X-MBX-APIKEY'], 'AK');
    const [base, qs] = url.split('?');
    const idx = qs.lastIndexOf('&signature=');
    const q = qs.slice(0, idx);
    assert.equal(qs.slice(idx + 11), crypto.createHmac('sha256', 's3cret').update(q).digest('hex'));
    assert.ok(q.includes('recvWindow=5000'));
    assert.ok(q.includes('timestamp=1000500'));
    assert.ok(!base.includes('s3cret'));
  }
  assert.ok(calls.at(-1).url.includes('/fapi/v3/account'));
  assert.ok(calls.some((c2) => c2.url.includes('startTime=2000')), 'second page starts after last row');
});

test('binance client: http error surfaces', async () => {
  const hmacKey = await importSecret('x', subtle);
  const c = createClient({ apiKey: 'k', hmacKey, subtle, fetchFn: async () => ({ ok: false, status: 401, text: async () => 'bad' }) });
  await assert.rejects(() => c.account(), /HTTP 401/);
});

async function makeLicense(payload, tamper = false) {
  const { publicKey, privateKey } = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const body = b64u(Buffer.from(JSON.stringify(payload)));
  const sig = new Uint8Array(await subtle.sign('Ed25519', privateKey, Buffer.from(body)));
  if (tamper) sig[0] ^= 1;
  const spki = Buffer.from(await subtle.exportKey('spki', publicKey)).toString('base64');
  return { token: `${body}.${b64u(sig)}`, spki };
}

test('license: valid, expired, tampered, none, unsupported', async () => {
  const now = 2_000_000_000;
  const ok = await makeLicense({ sub: 'a', plan: 'pro', exp: now + 100 });
  assert.equal((await checkLicense({ token: ok.token, pubkeySpki: ok.spki, subtle, nowSec: now })).status, 'pro');
  const old = await makeLicense({ sub: 'a', plan: 'pro', exp: now - 1 });
  assert.equal((await checkLicense({ token: old.token, pubkeySpki: old.spki, subtle, nowSec: now })).status, 'expired');
  const bad = await makeLicense({ sub: 'a', exp: now + 100 }, true);
  assert.equal((await checkLicense({ token: bad.token, pubkeySpki: bad.spki, subtle, nowSec: now })).status, 'invalid');
  const other = await makeLicense({ exp: now + 100 });
  assert.equal((await checkLicense({ token: ok.token, pubkeySpki: other.spki, subtle, nowSec: now })).status, 'invalid');
  assert.equal((await checkLicense({ token: '', pubkeySpki: ok.spki, subtle })).status, 'none');
  assert.equal((await checkLicense({ token: 'garbage', pubkeySpki: ok.spki, subtle })).status, 'invalid');
  assert.equal((await checkLicense({ token: ok.token, pubkeySpki: ok.spki, subtle: null })).status, 'unsupported');
});

test('telegram: plain text POST, errors do not leak token', async () => {
  let sent;
  const r = await sendTelegram({ token: 'TOK', chatId: '1', text: 'hola', fetchFn: async (u, o) => { sent = { u, o }; return { ok: true }; } });
  assert.ok(r.ok);
  assert.equal(sent.u, 'https://api.telegram.org/botTOK/sendMessage');
  assert.deepEqual(JSON.parse(sent.o.body), { chat_id: '1', text: 'hola' });
  const e = await sendTelegram({ token: 'TOK', chatId: '1', text: 'x', fetchFn: async () => { throw new TypeError('fetch failed https://api.telegram.org/botTOK'); } });
  assert.equal(e.ok, false);
  assert.ok(!e.error.includes('TOK'));
});
