// Cliente de SOLO LECTURA de Binance USD-M Futures desde el navegador. Solo GET firmados.
// El secreto se importa como CryptoKey NO extraible; nunca se envia a ningun sitio salvo
// la firma HMAC de cada peticion hacia fapi.binance.com.

export const BASE = 'https://fapi.binance.com';
export const SPOT_BASE = 'https://api.binance.com';
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function importSecret(secret, subtle = crypto.subtle) {
  return subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function sign(hmacKey, query, subtle = crypto.subtle) {
  return hex(await subtle.sign('HMAC', hmacKey, new TextEncoder().encode(query)));
}

export function createClient({ apiKey, hmacKey, fetchFn = fetch.bind(globalThis), subtle = crypto.subtle, now = () => Date.now(), base = BASE }) {
  let offset = 0;

  async function syncTime() {
    const t0 = now();
    const r = await fetchFn(`${base}/fapi/v1/time`);
    if (!r.ok) throw new Error(`HTTP ${r.status} en /fapi/v1/time`);
    const { serverTime } = await r.json();
    offset = serverTime - Math.round((t0 + now()) / 2);
    return offset;
  }

  const get = (path, params = {}) => getAt(base, path, params);

  async function getAt(host, path, params = {}, retry = true) {
    const q = new URLSearchParams({ ...params, timestamp: String(now() + offset), recvWindow: '15000' }).toString();
    const sig = await sign(hmacKey, q, subtle);
    const r = await fetchFn(`${host}${path}?${q}&signature=${sig}`, { method: 'GET', headers: { 'X-MBX-APIKEY': apiKey } });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 200);
      if (retry && body.replace(/\s+/g, '').includes('"code":-1021')) {
        await syncTime();
        return getAt(host, path, params, false);
      }
      throw new Error(`HTTP ${r.status} ${body}`);
    }
    return r.json();
  }

  async function incomeSince(start) {
    let rows = [];
    let s = start;
    for (let i = 0; i < 10; i += 1) {
      const page = await get('/fapi/v1/income', { startTime: s, limit: 1000 });
      rows = rows.concat(page);
      if (page.length < 1000) break;
      s = Number(page[page.length - 1].time) + 1;
    }
    return rows;
  }

  return {
    syncTime,
    get,
    incomeSince,
    account: () => get('/fapi/v3/account'),
    positionRisk: () => get('/fapi/v2/positionRisk'),
    openAlgoOrders: () => get('/fapi/v1/openAlgoOrders'),
    // Sondeo de permisos (GET firmado inofensivo, no crea ordenes). Mejor esfuerzo: puede fallar por CORS.
    apiRestrictions: () => getAt(SPOT_BASE, '/sapi/v1/account/apiRestrictions'),
    get timeOffset() { return offset; },
  };
}

// --- almacenamiento de claves: CryptoKey en IndexedDB, API key en localStorage ---
const DB = 'swal-guardian';
const STORE = 'keys';
const LS_API = 'swal.guardian.apikey';

function idb() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(DB, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}

export async function saveCredentials(apiKey, secret) {
  const key = await importSecret(secret);
  const db = await idb();
  await new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(key, 'hmac');
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
  localStorage.setItem(LS_API, apiKey);
}

export async function loadCredentials() {
  const apiKey = localStorage.getItem(LS_API);
  if (!apiKey) return null;
  const db = await idb();
  const hmacKey = await new Promise((res, rej) => {
    const rq = db.transaction(STORE).objectStore(STORE).get('hmac');
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  return hmacKey ? { apiKey, hmacKey } : null;
}

export async function clearCredentials() {
  localStorage.removeItem(LS_API);
  const db = await idb();
  await new Promise((res) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = res;
    tx.onerror = res;
  });
}
