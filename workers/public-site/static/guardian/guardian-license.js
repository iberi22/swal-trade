// Verificacion de licencia Ed25519 en el navegador. Formato: base64url(JSON) + "." + base64url(firma),
// firmado sobre los bytes ASCII del primer segmento (ver billing-worker/src/license.js).

// Copia fijada de la clave publica (SPKI base64). Vacia = usar solo /v1/pubkey.
export const PINNED_PUBKEY = '';
export const PUBKEY_URL = 'https://pay.swal.network/v1/pubkey';
export const LICENSE_KEY = 'swal.license';
const PUBKEY_CACHE = 'swal.pubkey';

export function b64ToBytes(b64) {
  const norm = String(b64).trim().replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export async function ed25519Supported(subtle) {
  try {
    await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    return true;
  } catch {
    return false;
  }
}

/** @returns {Promise<{status:'pro'|'none'|'expired'|'invalid'|'unsupported', payload?:object, reason?:string}>} */
export async function checkLicense({ token, pubkeySpki, subtle, nowSec = Math.floor(Date.now() / 1000) }) {
  if (!token) return { status: 'none' };
  if (!subtle) return { status: 'unsupported' };
  const parts = String(token).trim().split('.');
  if (parts.length !== 2) return { status: 'invalid', reason: 'token mal formado' };
  let key;
  try {
    key = await subtle.importKey('spki', b64ToBytes(pubkeySpki), { name: 'Ed25519' }, false, ['verify']);
  } catch (e) {
    if (e && (e.name === 'NotSupportedError' || e.name === 'SyntaxError')) return { status: 'unsupported' };
    return { status: 'invalid', reason: 'clave publica invalida' };
  }
  let ok;
  try {
    ok = await subtle.verify({ name: 'Ed25519' }, key, b64ToBytes(parts[1]), new TextEncoder().encode(parts[0]));
  } catch {
    return { status: 'invalid', reason: 'firma ilegible' };
  }
  if (!ok) return { status: 'invalid', reason: 'firma invalida' };
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64ToBytes(parts[0])));
  } catch {
    return { status: 'invalid', reason: 'payload ilegible' };
  }
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) return { status: 'expired', payload };
  return { status: 'pro', payload };
}

/** Clave publica: fijada > cache local > red. Devuelve SPKI base64 o null. */
export async function loadPubkey({ fetchFn, storage }) {
  if (PINNED_PUBKEY) return PINNED_PUBKEY;
  const cached = storage.getItem(PUBKEY_CACHE);
  if (cached) return cached;
  try {
    const r = await fetchFn(PUBKEY_URL);
    if (!r.ok) return null;
    const t = (await r.text()).trim();
    let v = t;
    try {
      const j = JSON.parse(t);
      v = j.public_key || j.pubkey || j.spki || (typeof j === 'string' ? j : '');
    } catch { /* texto plano */ }
    if (!v) return null;
    storage.setItem(PUBKEY_CACHE, v);
    return v;
  } catch {
    return null;
  }
}
