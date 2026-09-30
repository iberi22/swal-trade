// Módulo puro de ayuda para firma de peticiones.
// Sin dependencias, sin estado global, sin acceso a red.
// Compatible con navegador (módulos ES) y Node (import desde .mjs / package type module).

const CHUNK = 0x8000;

export function toU8(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError('Se esperaba ArrayBuffer o TypedArray');
}

/**
 * Construye un query string preservando el orden de inserción.
 * Acepta un objeto plano o una lista de pares [clave, valor].
 * Claves y valores se codifican con encodeURIComponent (RFC 3986).
 */
export function buildQuery(params) {
  const pairs = Array.isArray(params) ? params : Object.entries(params);
  return pairs
    .filter(([k]) => k !== null && k !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v === null || v === undefined ? '' : String(v))}`)
    .join('&');
}

/**
 * Query string con las claves ordenadas alfabéticamente.
 * Requisito del WS API de Binance para el payload de session.logon.
 */
export function buildSortedQuery(params, { encode = true } = {}) {
  const pairs = (Array.isArray(params) ? params : Object.entries(params))
    .slice()
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (!encode) return pairs.map(([k, v]) => `${k}=${v}`).join('&');
  return buildQuery(pairs);
}

export function b64Of(input) {
  const bytes = toU8(input);
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function hexOf(input) {
  const bytes = toU8(input);
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += Array.from(bytes.subarray(i, i + CHUNK), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return out;
}

/**
 * Envuelve un SPKI (ArrayBuffer) en PEM con líneas de 64 caracteres.
 */
export function toPem(spki, label = 'PUBLIC KEY') {
  const b64 = b64Of(spki);
  const lines = b64.length ? b64.match(/.{1,64}/g) : [''];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

export function fromPem(pem, label = 'PUBLIC KEY') {
  const body = String(pem)
    .replace(`-----BEGIN ${label}-----`, '')
    .replace(`-----END ${label}-----`, '')
    .replace(/\s+/g, '');
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export async function exportPublicPem(publicKey) {
  const spki = await crypto.subtle.exportKey('spki', publicKey);
  return toPem(spki);
}

export async function importHmacSecret(secretText) {
  const material = new TextEncoder().encode(String(secretText));
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function signHmacHex(hmacKey, payload) {
  const sig = await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(payload));
  return hexOf(sig);
}

export async function signRsaBase64(privateKey, payload) {
  const sig = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    new TextEncoder().encode(payload),
  );
  return b64Of(sig);
}

export async function signEd25519Base64(privateKey, payload) {
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, new TextEncoder().encode(payload));
  return b64Of(sig);
}

export async function verifyText(publicKey, algorithm, signature, payload) {
  const bytes = signature instanceof ArrayBuffer || ArrayBuffer.isView(signature)
    ? toU8(signature)
    : (algorithm === 'HMAC' ? hexToBytes(signature) : b64ToBytes(signature));
  return crypto.subtle.verify(algorithm, publicKey, bytes, new TextEncoder().encode(payload));
}

export function hexToBytes(hex) {
  const clean = String(hex).trim();
  if (clean.length % 2 !== 0) throw new Error('Hex impar');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function b64ToBytes(b64) {
  const bin = atob(String(b64).trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export const BINANCE_TESTNET_FUTURES_BASE = 'https://testnet.binancefuture.com';
export const BINANCE_TESTNET_FUTURES_WS = 'wss://testnet.binancefuture.com/ws-fapi/v1';
export const DEFAULT_RECV_WINDOW = 5000;

export async function fetchServerTimeMs(fetchImpl = fetch) {
  const res = await fetchImpl(`${BINANCE_TESTNET_FUTURES_BASE}/fapi/v1/time`);
  const body = await res.json();
  return Number(body.serverTime);
}

export function timestampWithOffset(offsetMs) {
  return Date.now() + (offsetMs || 0);
}
