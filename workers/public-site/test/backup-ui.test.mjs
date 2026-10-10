// Regresión de las correcciones de la interfaz de /backup/:
//   2. Frase de paso mínima de 12 caracteres, con el motivo visible en la página.
//   4. El estado válido de checkLicense es 'pro' (no 'ok').
//   6. La lista de exclusión barre también los VALORES (claves de Binance de 64 caracteres)
//      y la página cuenta exactamente qué queda fuera.
//   7. Restaurar no pisa el token del bot de Telegram con uno vacío.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(HERE, '..', 'static', 'backup', 'index.html'), 'utf8');

const PASS = 'frase-de-paso-larga-y-segura-42';
const TG_KEY = 'swal.guardian.tg';

async function makeSigner() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
  const pubkeyB64 = Buffer.from(new Uint8Array(spki)).toString('base64');
  const nowSec = Math.floor(Date.now() / 1000);
  async function token(payload = {}) {
    const body = { iss: 'swal-trade-billing', iat: nowSec, ...payload };
    const b64 = Buffer.from(new TextEncoder().encode(JSON.stringify(body))).toString('base64url');
    const sig = await crypto.subtle.sign('Ed25519', kp.privateKey, new TextEncoder().encode(b64));
    return `${b64}.${Buffer.from(new Uint8Array(sig)).toString('base64url')}`;
  }
  return { pubkeyB64, token };
}

// El módulo se importa UNA vez y sus manejadores quedan ligados a este documento, así que el
// DOM es uno solo y cada test reinicia sus valores.
const els = new Map();
const mk = (id) => ({
  id,
  value: '',
  checked: false,
  textContent: '',
  className: '',
  disabled: false,
  firstElementChild: { style: {} },
  listeners: {},
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
  click() { return Promise.all((this.listeners.click || []).map((fn) => fn())); },
});
for (const id of ['pass', 'meter', 'strength', 'journal', 'include-tg-token', 'backup', 'restore', 'delete', 'out', 'lic-info']) {
  els.set(id, mk(id));
}
const store = new Map();
const fetchCalls = [];
globalThis.document = { getElementById: (id) => els.get(id) ?? null };
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

/**
 * Estado inicial de la página antes de cada caso. Limpia también los manejadores: el módulo se
 * reimporta con un especificador distinto para que initLicense vuelva a ejecutarse con la
 * licencia de este caso.
 */
let cargas = 0;
function resetPage({ pass = '', telegram = null, license = null, includeTgToken = false, journal = [] } = {}) {
  store.clear();
  fetchCalls.length = 0;
  cargas += 1;
  for (const el of els.values()) {
    el.listeners = {};
    el.value = '';
    el.checked = false;
    el.textContent = '';
    el.className = '';
    el.disabled = false;
    el.firstElementChild.style.width = '';
  }
  if (telegram) store.set(TG_KEY, JSON.stringify(telegram));
  if (license) store.set('swal.license', license);
  if (journal.length) store.set('swal.backup.journal', JSON.stringify(journal));
  els.get('pass').value = pass;
  els.get('include-tg-token').checked = includeTgToken;
}

let pubkeyB64 = null;
/** Carga backup-ui.js con un fetch que responde a la pubkey y a /api/backup. */
async function loadUi(apiHandler) {
  globalThis.fetch = async (url, opts = {}) => {
    fetchCalls.push({ url: String(url), opts });
    if (String(url).includes('pubkey')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ spki_base64: pubkeyB64 }) };
    }
    return apiHandler(String(url), opts);
  };
  // Especificador distinto en cada caso: instancia nueva del módulo, initLicense incluido.
  return import(`../static/backup/backup-ui.js?caso=${cargas}`);
}

/** Espera a que `fn()` deje de lanzar (initLicense es asíncrona). */
async function waitFor(fn, timeoutMs = 4000) {
  const start = Date.now();
  for (;;) {
    try {
      if (fn()) return;
    } catch { /* seguimos */ }
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: tiempo agotado');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const back = () => els.get('backup').click();

test('interfaz: frase corta -> avisa del mínimo de 12 y no envía nada', async () => {
  const signer = await makeSigner();
  pubkeyB64 = signer.pubkeyB64;
  resetPage({ pass: 'corta', license: await signer.token({ sub: 'ui_short', exp: Math.floor(Date.now() / 1000) + 3600 }) });
  await loadUi(async () => ({ ok: true, json: async () => ({ size: 10 }) }));
  await waitFor(() => els.get('lic-info').textContent.length > 0);

  await back();
  const out = els.get('out');
  assert.match(out.textContent, /al menos 12 caracteres/);
  assert.equal(out.className, 'err');
  // No se cifra ni se llama a /api/backup con una frase inválida.
  assert.equal(fetchCalls.filter((c) => c.url === '/api/backup').length, 0);

  // Lo mismo al restaurar.
  await els.get('restore').click();
  assert.match(els.get('out').textContent, /al menos 12 caracteres/);
  assert.equal(fetchCalls.filter((c) => c.url === '/api/backup').length, 0);
});

