// node --test apps/key-spike/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildQuery,
  buildSortedQuery,
  toPem,
  fromPem,
  hexOf,
  b64Of,
  hexToBytes,
  b64ToBytes,
  importHmacSecret,
  signHmacHex,
  signEd25519Base64,
  signRsaBase64,
  exportPublicPem,
  verifyText,
  timestampWithOffset,
  BINANCE_TESTNET_FUTURES_BASE,
  BINANCE_TESTNET_FUTURES_WS,
} from './signing.js';

test('crypto.subtle está disponible en el global de Node', () => {
  assert.ok(globalThis.crypto, 'globalThis.crypto ausente');
  assert.ok(globalThis.crypto.subtle, 'globalThis.crypto.subtle ausente');
  assert.equal(typeof crypto.subtle.importKey, 'function');
  assert.equal(typeof crypto.subtle.sign, 'function');
  assert.ok(crypto.subtle.generateKey, 'generateKey ausente');
});

test('buildQuery conserva el orden de inserción y codifica valores', () => {
  const q = buildQuery([
    ['symbol', 'LTCBTC'],
    ['side', 'BUY'],
    ['type', 'LIMIT'],
    ['timeInForce', 'GTC'],
    ['quantity', 1],
    ['price', 0.1],
    ['recvWindow', 5000],
    ['timestamp', 1499827319559],
  ]);
  assert.equal(
    q,
    'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559',
  );
});

test('buildQuery acepta objeto plano y escapa caracteres especiales', () => {
  assert.equal(buildQuery({ a: 'x y', 'b&c': 'v=w' }), 'a=x%20y&b%26c=v%3Dw');
  assert.equal(buildQuery({}), '');
  assert.equal(buildQuery({ sym: null, qty: undefined }), 'sym=&qty=');
  assert.equal(buildQuery([['k', 'BTC/USDT']]), 'k=BTC%2FUSDT');
  // la query canónica de los docs no debe llevar espacios ni comillas
  assert.equal(/[\s'"]/.test(buildQuery({ symbol: 'BTCUSDT' })), false);
});

test('buildSortedQuery ordena alfabéticamente (payload WS de Binance)', () => {
  const sorted = buildSortedQuery([
    ['timestamp', 1],
    ['apiKey', 'abc'],
    ['symbol', 'BTCUSDT'],
  ]);
  assert.equal(sorted, 'apiKey=abc&symbol=BTCUSDT&timestamp=1');
  assert.equal(buildSortedQuery({ b: '2', a: '1' }, { encode: false }), 'a=1&b=2');
});

test('toPem genera header, footer y líneas de 64 caracteres', () => {
  const spki = new Uint8Array(200).fill(7);
  const pem = toPem(spki.buffer);
  const lines = pem.trimEnd().split('\n');

  assert.equal(lines[0], '-----BEGIN PUBLIC KEY-----');
  assert.equal(lines[lines.length - 1], '-----END PUBLIC KEY-----');

  const body = lines.slice(1, -1);
  assert.ok(body.length >= 4, 'se esperaban varias líneas base64');
  const expectedLen = Math.ceil((200 * 4) / 3 / 4) * 4; // longitud base64 con padding
  body.forEach((l, i) => {
    const isLast = i === body.length - 1;
    assert.equal(l.length, isLast ? expectedLen - 64 * (body.length - 1) : 64, `línea ${i} mal formada`);
  });
  // sin líneas de más de 64 caracteres
  assert.equal(body.every((l) => l.length <= 64), true);
  // base64 válido y reversible
  assert.equal(b64ToBytes(body.join('')).length, 200);
  assert.equal(hexOf(b64ToBytes(body.join(''))).length, 400);
});

test('toPem/fromPem hacen roundtrip y hexOf/b64Of codifican bien', () => {
  const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01]);
  assert.equal(hexOf(bytes), 'deadbeef01');
  assert.equal(b64Of(bytes), Buffer.from(bytes).toString('base64'));
  assert.equal(fromPem(toPem(bytes.buffer)).byteLength, 5);
  assert.deepEqual([...new Uint8Array(fromPem(toPem(bytes.buffer)))], [...bytes]);
  assert.equal(hexOf(new Uint8Array([])), '');
  assert.equal(b64Of(new Uint8Array(0)), '');
});

test('HMAC: vector conocido de la documentación de Binance', async () => {
  const secret = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j'; // gitleaks:allow — vector público de la documentación de Binance
  const query =
    'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559';

  const key = await importHmacSecret(secret);
  assert.equal(key.extractable, false, 'la clave HMAC no debe ser exportable');
  assert.deepEqual(key.usages, ['sign']);

  const sig = await signHmacHex(key, query);
  assert.equal(sig, 'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71');
  assert.equal(sig.length, 64);
  assert.equal(/^[0-9a-f]{64}$/.test(sig), true);
});

test('HMAC: determinismo y sensibilidad al payload', async () => {
  const key = await importHmacSecret('clave-secreta-de-prueba');
  const a = await signHmacHex(key, 'a=1');
  const b = await signHmacHex(key, 'a=1');
  const c = await signHmacHex(key, 'a=2');
  assert.equal(a, b, 'HMAC es determinista');
  assert.notEqual(a, c);
  assert.notEqual(a, await signHmacHex(key, 'a=1&extra=1'));
});

test('Ed25519: sign/verify roundtrip con clave no exportable', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
  assert.equal(pair.privateKey.extractable, false);
  assert.equal(pair.publicKey.extractable, true);

  const payload = 'symbol=BTCUSDT&timestamp=1499827319559';
  const sig = await signEd25519Base64(pair.privateKey, payload);
  assert.equal(typeof sig, 'string');
  assert.equal(b64ToBytes(sig).length, 64, 'firma Ed25519 = 64 bytes');

  assert.equal(await verifyText(pair.publicKey, { name: 'Ed25519' }, sig, payload), true);
  assert.equal(await verifyText(pair.publicKey, { name: 'Ed25519' }, sig, `${payload}x`), false);

  const pem = await exportPublicPem(pair.publicKey);
  assert.match(pem, /^-----BEGIN PUBLIC KEY-----\n/);
  assert.match(pem, /-----END PUBLIC KEY-----\n$/);
});

test('RSA: firma PKCS1 v1.5 verificable y PEM SPKI correcto', async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    false,
    ['sign', 'verify'],
  );
  assert.equal(pair.privateKey.extractable, false);
  assert.equal(pair.privateKey.algorithm.modulusLength, 2048);

  const payload = buildQuery({ symbol: 'BTCUSDT', recvWindow: 5000, timestamp: 1 });
  const sig = await signRsaBase64(pair.privateKey, payload);
  assert.equal(b64ToBytes(sig).length, 256, 'firma RSA-2048 = 256 bytes');
  assert.equal(await verifyText(pair.publicKey, { name: 'RSASSA-PKCS1-v1_5' }, sig, payload), true);

  const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
  const pem = toPem(spki);
  const body = pem.trimEnd().split('\n').slice(1, -1);
  assert.equal(body.every((l) => l.length <= 64), true);
  assert.ok(body[0].length === 64);
  // SPKI DER empieza con SEQUENCE 0x30 y contiene el OID rsaEncryption 1.2.840.113549.1.1.1
  const der = [...b64ToBytes(body.join(''))];
  assert.equal(der[0], 0x30);
  // SPKI: SEQUENCE(30) len(82 xx) SEQUENCE(30) len(0d) OID(06 09) 1.2.840.113549.1.1.1
  assert.deepEqual(der.slice(8, 16), [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01].slice(0, 8));
});

test('la base URL es TESTNET y no permite mainnet', () => {
  assert.equal(BINANCE_TESTNET_FUTURES_BASE, 'https://testnet.binancefuture.com');
  assert.equal(BINANCE_TESTNET_FUTURES_WS, 'wss://testnet.binancefuture.com/ws-fapi/v1');
  assert.equal(/binance\.com/.test(BINANCE_TESTNET_FUTURES_BASE), false);
  assert.equal(BINANCE_TESTNET_FUTURES_BASE.includes('api.binance.com'), false);
});

test('timestampWithOffset aplica el offset de reloj del servidor', () => {
  assert.equal(timestampWithOffset(0) > 0, true);
  const now = Date.now();
  const drifted = timestampWithOffset(5000);
  assert.ok(Math.abs(drifted - (now + 5000)) < 50);
  assert.equal(timestampWithOffset(undefined) > 0, true);
});
