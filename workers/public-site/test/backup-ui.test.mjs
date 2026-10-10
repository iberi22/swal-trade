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

test('interfaz: licencia válida (status pro) respalda de extremo a extremo', async () => {
  const signer = await makeSigner();
  pubkeyB64 = signer.pubkeyB64;
  resetPage({
    pass: PASS,
    license: await signer.token({ sub: 'ui_ok', exp: Math.floor(Date.now() / 1000) + 3600 }),
    telegram: { chat: '99', token: 'BOT-TOKEN' },
    journal: [{ note: 'nota privada' }],
  });
  await loadUi(async (url, opts) => {
    assert.equal(opts.method, 'PUT');
    assert.match(opts.headers.Authorization, /^Bearer /);
    // Solo viaja el sobre cifrado.
    const sent = JSON.parse(opts.body);
    assert.deepEqual(Object.keys(sent).sort(), ['ct', 'iter', 'iv', 'kdf', 'salt', 'v']);
    assert.ok(!opts.body.includes('BOT-TOKEN'));
    assert.ok(!opts.body.includes('nota privada'));
    return { ok: true, status: 200, json: async () => ({ size: 512, dev: false }) };
  });
  await waitFor(() => els.get('lic-info').textContent.length > 0);

  // checkLicense devuelve 'pro': la página debe tratarlo como licencia válida.
  assert.equal(els.get('lic-info').textContent, 'Licencia Socio válida. Respaldo cifrado disponible.');
  assert.equal(els.get('lic-info').className, 'ok');

  await back();
  assert.match(els.get('out').textContent, /^Respaldo guardado \(512 bytes\)/);
  assert.equal(els.get('out').className, 'ok');
  assert.equal(els.get('restore').disabled, false);
  // El diario del textarea queda guardado en local (cifrado al respaldar).
  const saved = JSON.parse(store.get('swal.backup.journal'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].note, 'nota privada');
});

test('interfaz: restaurar conserva el token del bot si el respaldo no lo trae', async () => {
  const core = await import('../static/backup/backup-core.js');
  // Respaldo hecho SIN el token del bot (opt-in desmarcado).
  const data = core.buildBackupData({
    guardian: { cfg: { limit: 50 }, telegram: { chat: '99', token: 'TOKEN-DEL-RESPALDO' } },
    journal: [{ note: 'hola' }],
    includeBotToken: false,
  });
  const envelope = await core.encryptBackup(data, PASS);

  const signer = await makeSigner();
  pubkeyB64 = signer.pubkeyB64;
  resetPage({
    pass: PASS,
    license: await signer.token({ sub: 'ui_restore', exp: Math.floor(Date.now() / 1000) + 3600 }),
    telegram: { chat: '1', token: 'TOKEN-LOCAL-EXISTENTE' },
  });
  await loadUi(async () => ({ ok: true, status: 200, json: async () => ({ envelope }) }));
  await waitFor(() => els.get('lic-info').textContent.length > 0);

  await els.get('restore').click();
  await waitFor(() => els.get('out').textContent.startsWith('Respaldo restaurado'));
  const restored = JSON.parse(store.get(TG_KEY));
  assert.equal(restored.chat, '99');
  // El token local NO se sobrescribe con uno vacío.
  assert.equal(restored.token, 'TOKEN-LOCAL-EXISTENTE');
  // El resto sí se restaura.
  assert.deepEqual(JSON.parse(store.get('swal.guardian.cfg')), { limit: 50 });
  assert.equal(els.get('journal').value, 'hola');
});

test('interfaz: restaurar sí sustituye el token cuando el respaldo lo incluye', async () => {
  const core = await import('../static/backup/backup-core.js');
  const data = core.buildBackupData({
    guardian: { telegram: { chat: '7', token: 'TOKEN-NUEVO' } },
    includeBotToken: true,
  });
  const envelope = await core.encryptBackup(data, PASS);
  const signer = await makeSigner();
  pubkeyB64 = signer.pubkeyB64;
  resetPage({
    pass: PASS,
    license: await signer.token({ sub: 'ui_restore2', exp: Math.floor(Date.now() / 1000) + 3600 }),
    telegram: { chat: '1', token: 'TOKEN-VIEJO' },
  });
  await loadUi(async () => ({ ok: true, status: 200, json: async () => ({ envelope }) }));
  await waitFor(() => els.get('lic-info').textContent.length > 0);

  await els.get('restore').click();
  await waitFor(() => els.get('out').textContent.startsWith('Respaldo restaurado'));
  assert.deepEqual(JSON.parse(store.get(TG_KEY)), { chat: '7', token: 'TOKEN-NUEVO' });
});

// ---------- 6. lista de exclusión: nombres Y valores ----------

test('exclusión: descarta valores con forma de clave de Binance (64 alfanuméricos)', async () => {
  const { scrubDenied, isDeniedValue } = await import('../static/backup/backup-core.js');
  const key64 = 'a'.repeat(64);
  const key64b = 'AbCd0123'.repeat(8);
  assert.equal(isDeniedValue(key64), true);
  assert.equal(isDeniedValue(key64b), true);
  assert.equal(isDeniedValue('a'.repeat(63)), false);
  assert.equal(isDeniedValue('a'.repeat(65)), false);
  assert.equal(isDeniedValue(42), false);
  assert.equal(isDeniedValue('clave aaa bbb ccc'), false);

  const clean = scrubDenied({
    nota: key64,
    ajustes: { nivel2: { valor: key64b, nombre: 'vale' } },
    journal: [{ note: `clave ${key64} anotada` }, { note: 'vale' }, 'texto', 7, key64],
    texto: 'una nota normal, con signos y espacios, que no lleva ninguna clave dentro',
    lista: [key64, 'ok'],
  });
  assert.equal(clean.nota, undefined);
  assert.equal(clean.ajustes.nivel2.valor, undefined);
  assert.equal(clean.ajustes.nivel2.nombre, 'vale');
  // La nota que contenía la clave se descarta entera; las demás se conservan.
  assert.deepEqual(clean.journal, [{ note: 'vale' }, 'texto', 7]);
  assert.equal(clean.texto.includes('espacios'), true);
  assert.deepEqual(clean.lista, ['ok']);
  // Nada de la clave sobrevive.
  assert.ok(!JSON.stringify(clean).includes(key64));
  assert.ok(!JSON.stringify(clean).includes(key64b));
});

test('exclusión: descarta claves token/secret/apikey/binance*/fapi* a cualquier profundidad', async () => {
  const { scrubDenied, isDeniedKey, buildBackupData } = await import('../static/backup/backup-core.js');
  for (const k of ['token', 'Token', 'secret', 'apikey', 'binance', 'binanceApiKey', 'BINANCE_SECRET', 'fapi', 'fapi_key', 'hmac']) {
    assert.equal(isDeniedKey(k), true, k);
  }
  // Lo permitido sigue pasando.
  for (const k of ['botToken', 'chat', 'limit', 'note', 'public_field', 'myTokens']) {
    assert.equal(isDeniedKey(k), false, k);
  }

  const data = buildBackupData({
    guardian: {
      cfg: { limit: 10, binanceApiKey: 'FUGA_X', fapi_key: 'FUGA_Y', nested: { deep: { token: 'FUGA_T', secret: 'FUGA_S' } } },
      telegram: { chat: '5', token: 'NO-DEBE-SALIR' },
    },
    analysis: { theme: 'dark', creds: { token: 'FUGA_T2', apikey: 'FUGA_K', other: 'ok' } },
    journal: [{ note: 'ok', token: 'FUGA_JT', binanceSecret: 'FUGA_BS', payload: { fapi: 'FUGA_F' } }],
  });
  const flat = JSON.stringify(data);
  for (const bad of ['FUGA_X', 'FUGA_Y', 'FUGA_T', 'FUGA_S', 'FUGA_T2', 'FUGA_K', 'FUGA_JT', 'FUGA_BS', 'FUGA_F', 'NO-DEBE-SALIR']) {
    assert.ok(!flat.includes(bad), bad);
  }
  // El cascarón que se queda vacío al quitarle los secretos se descarta entero.
  assert.equal(data.guardian.cfg.nested, undefined);
  assert.equal(data.guardian.cfg.limit, 10);
  assert.equal(data.analysis.creds.other, 'ok');
  assert.deepEqual(data.journal, [{ note: 'ok' }]);

  // El token del bot solo entra con opt-in explícito.
  const withToken = buildBackupData({ guardian: { telegram: { chat: '1', token: 'TB' } }, includeBotToken: true });
  assert.equal(withToken.guardian.telegram.botToken, 'TB');
});

test('interfaz: la página cuenta exactamente qué queda fuera del respaldo', () => {
  assert.match(HTML, /Frase de paso \(mínimo 12 caracteres\)/);
  assert.match(HTML, /Nunca se incluye ninguna clave ni secreto/);
  for (const frag of ['apiKey', 'secret', 'hmac', 'X-MBX-*', 'token', 'binance', 'fapi', '64 caracteres alfanuméricos']) {
    assert.ok(HTML.includes(frag), `falta explicar ${frag}`);
  }
  // También lo dice el diario, no solo los ajustes.
  assert.match(HTML, /tanto en los ajustes como en las notas del diario/);
});
