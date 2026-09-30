// Spike de firma no custodiada contra Binance USDⓈ-M Futures TESTNET.
// La clave privada nunca se exporta: solo se firma con ella dentro del navegador.

import {
  BINANCE_TESTNET_FUTURES_BASE,
  BINANCE_TESTNET_FUTURES_WS,
  DEFAULT_RECV_WINDOW,
  buildQuery,
  buildSortedQuery,
  exportPublicPem,
  fetchServerTimeMs,
  importHmacSecret,
  signEd25519Base64,
  signHmacHex,
  signRsaBase64,
  timestampWithOffset,
} from './signing.js';

const DB_NAME = 'key-spike';
const DB_VERSION = 1;
const STORE = 'keys';
const REC = {
  rsa: { id: 'rsa', kind: 'rsa' },
  ed: { id: 'ed', kind: 'ed25519' },
  hmac: { id: 'hmac', kind: 'hmac' },
  apiKey: { id: 'apiKey', kind: 'apikey' },
};

const el = (id) => document.getElementById(id);
const ui = {
  banner: el('base-url'),
  pem: el('out-pubpem'),
  status: el('out-status'),
  rest: el('out-rest'),
  ws: el('out-ws'),
  hmacInput: el('in-hmac'),
  apiKeyInput: el('in-apikey'),
  orderIdInput: el('in-orderid'),
  wsMethod: el('in-ws-method'),
};

ui.banner.textContent = BINANCE_TESTNET_FUTURES_BASE;
ui.rest.textContent = '';
ui.ws.textContent = '';

/* ---------------------------------------------------------------- logging */

function line(target, text) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 23);
  target.textContent += `[${stamp}] ${text}\n`;
  target.scrollTop = target.scrollHeight;
}

function show(target, text) {
  target.textContent = text;
}

/* ------------------------------------------------------- IndexedDB (CryptoKey structured clone) */

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        let result;
        try {
          result = run(store);
        } catch (err) {
          reject(err);
          return;
        }
        t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

const db = {
  get: (id) => tx('readonly', (s) => s.get(id)),
  all: () => tx('readonly', (s) => s.getAll()),
  put: (rec) => tx('readwrite', (s) => s.put(rec)),
  del: (id) => tx('readwrite', (s) => s.delete(id)),
  clear: () => tx('readwrite', (s) => s.clear()),
};

/* ---------------------------------------------------------------- estado en memoria */

const state = {
  rsa: null, // { privateKey, publicKey, publicPem }
  ed: null,
  hmac: null, // CryptoKey
  apiKey: '',
  timeOffset: 0,
  lastOrderId: null,
  socket: null,
};

async function loadAll() {
  const recs = await db.all();
  for (const rec of recs) {
    if (rec.id === REC.rsa.id) state.rsa = rec;
    if (rec.id === REC.ed.id) state.ed = rec;
    if (rec.id === REC.hmac.id) state.hmac = rec.key;
    if (rec.id === REC.apiKey.id) state.apiKey = rec.value;
  }
  if (state.apiKey) ui.apiKeyInput.value = state.apiKey;
  await refreshPem();
  await refreshStatus();
}

async function refreshPem() {
  const rec = state.rsa || state.ed;
  show(ui.pem, rec ? rec.publicPem : '— sin clave generada —');
}

async function refreshStatus() {
  const lines = [
    `base REST   : ${BINANCE_TESTNET_FUTURES_BASE}`,
    `base WS     : ${BINANCE_TESTNET_FUTURES_WS}`,
    `recvWindow  : ${DEFAULT_RECV_WINDOW}`,
    `clave RSA   : ${state.rsa ? 'presente (no exportable)' : 'ninguna'}`,
    `clave Ed25519: ${state.ed ? 'presente (no exportable)' : 'ninguna'}`,
    `clave HMAC  : ${state.hmac ? 'importada (no exportable)' : 'ninguna'}`,
    `API key     : ${state.apiKey ? 'guardada' : 'sin guardar'}`,
    `desfase reloj: ${state.timeOffset} ms`,
    `último orderId: ${state.lastOrderId === null ? '—' : state.lastOrderId}`,
  ];
  show(ui.status, lines.join('\n'));
}

/* ------------------------------------------------------------ generación de claves */

async function generateRsa() {
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
  const publicPem = await exportPublicPem(pair.publicKey);
  state.rsa = { ...REC.rsa, privateKey: pair.privateKey, publicKey: pair.publicKey, publicPem };
  await db.put(state.rsa);
  await refreshPem();
  await refreshStatus();
  line(ui.status, 'Clave RSA-2048 generada y guardada en IndexedDB (no exportable).');
}

async function generateEd() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
  const publicPem = await exportPublicPem(pair.publicKey);
  state.ed = { ...REC.ed, privateKey: pair.privateKey, publicKey: pair.publicKey, publicPem };
  await db.put(state.ed);
  await refreshPem();
  await refreshStatus();
  line(ui.status, 'Clave Ed25519 generada y guardada en IndexedDB (no exportable).');
}

async function useHmac() {
  const secret = ui.hmacInput.value;
  if (!secret) {
    line(ui.status, 'No hay secreto HMAC pegado.');
    return;
  }
  const key = await importHmacSecret(secret);
  ui.hmacInput.value = ''; // se borra el campo de inmediato
  state.hmac = key;
  await db.put({ ...REC.hmac, key });
  await refreshStatus();
  line(ui.status, 'Secreto HMAC importado como clave no exportable; el campo de entrada quedó vacío.');
}

async function saveApiKey() {
  state.apiKey = ui.apiKeyInput.value.trim();
  await db.put({ ...REC.apiKey, value: state.apiKey });
  await refreshStatus();
  line(ui.status, state.apiKey ? 'API key guardada.' : 'API key vacía.');
}

async function wipeAll() {
  await db.clear();
  state.rsa = null;
  state.ed = null;
  state.hmac = null;
  state.apiKey = '';
  state.lastOrderId = null;
  state.timeOffset = 0;
  ui.apiKeyInput.value = '';
  ui.orderIdInput.value = '';
  show(ui.pem, '— sin clave generada —');
  await refreshStatus();
  line(ui.status, 'Registros de IndexedDB eliminados.');
}

/* ---------------------------------------------------------------- firma REST */

function activeSigner() {
  if (state.rsa) return { kind: 'rsa', sign: (p) => signRsaBase64(state.rsa.privateKey, p) };
  if (state.ed) return { kind: 'ed25519', sign: (p) => signEd25519Base64(state.ed.privateKey, p) };
  if (state.hmac) return { kind: 'hmac', sign: (p) => signHmacHex(state.hmac, p) };
  return null;
}

async function syncClock() {
  state.timeOffset = (await fetchServerTimeMs()) - Date.now();
  await refreshStatus();
  line(ui.status, `Reloj sincronizado con el servidor: desfase ${state.timeOffset} ms.`);
}

async function signedFetch(method, path, params, { withSignature = true } = {}) {
  const apiKey = state.apiKey;
  if (!apiKey) throw new Error('Falta la API key.');
  const signer = activeSigner();
  if (withSignature && !signer) throw new Error('Genera RSA, Ed25519 o importa una clave HMAC primero.');

  const full = [...params, ['recvWindow', DEFAULT_RECV_WINDOW], ['timestamp', timestampWithOffset(state.timeOffset)]];
  const query = buildQuery(full);
  const headers = { 'X-MBX-APIKEY': apiKey };

  let url = `${BINANCE_TESTNET_FUTURES_BASE}${path}?${query}`;
  let body;
  if (withSignature) {
    const signature = await signer.sign(query);
    if (signer.kind === 'hmac') {
      url += `&signature=${signature}`;
    } else {
      // RSA/Ed25519: base64 URL-encoded
      url += `&signature=${encodeURIComponent(signature)}`;
    }
  }

  const init = { method, headers, mode: 'cors', cache: 'no-store' };
  if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
    // Binance firma query + body concatenados; aquí el body va vacío y todo va en el query.
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = '';
  }

  line(ui.rest, `${method} ${path} · firma ${signer ? signer.kind : 'ninguna'}`);
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    /* respuesta no JSON: se muestra cruda */
  }
  line(ui.rest, `HTTP ${res.status} ${res.statusText}\n${parsed}`);
  return { status: res.status, body: text };
}

/* ---------------------------------------------------------------- acciones REST */

async function getBalance() {
  return signedFetch('GET', '/fapi/v2/balance', []);
}

async function placeTestOrder() {
  const idxRes = await fetch(`${BINANCE_TESTNET_FUTURES_BASE}/fapi/v1/premiumIndex?symbol=BTCUSDT`, {
    cache: 'no-store',
  });
  const idx = await idxRes.json();
  const mark = Number(idx.markPrice);
  if (!Number.isFinite(mark)) throw new Error(`premiumIndex no devolvió markPrice: ${JSON.stringify(idx)}`);

  const raw = mark * 0.5;
  const price = (Math.floor(raw / 0.1) * 0.1).toFixed(1); // tick 0.1, muy lejos del mercado

  const res = await signedFetch('POST', '/fapi/v1/order', [
    ['symbol', 'BTCUSDT'],
    ['side', 'BUY'],
    ['type', 'LIMIT'],
    ['timeInForce', 'GTC'],
    ['quantity', '0.002'],
    ['price', price],
  ]);
  try {
    const parsed = JSON.parse(res.body);
    if (parsed.orderId) {
      state.lastOrderId = parsed.orderId;
      ui.orderIdInput.value = String(parsed.orderId);
      await refreshStatus();
    }
  } catch {
    /* ignorado */
  }
  return res;
}

async function cancelOrder() {
  const orderId = ui.orderIdInput.value.trim() || (state.lastOrderId ?? '');
  if (!orderId) throw new Error('Indica un orderId.');
  return signedFetch('DELETE', '/fapi/v1/order', [
    ['symbol', 'BTCUSDT'],
    ['orderId', orderId],
  ]);
}

async function testEndpoint() {
  return signedFetch('POST', '/fapi/v1/order/test', [
    ['symbol', 'BTCUSDT'],
    ['side', 'BUY'],
    ['type', 'LIMIT'],
    ['timeInForce', 'GTC'],
    ['quantity', '0.002'],
    ['price', '0.1'],
  ]);
}

/* ---------------------------------------------------------------- WebSocket (Ed25519) */

function wsSend(socket, id, method, params) {
  const msg = params && Object.keys(params).length ? { id, method, params } : { id, method };
  line(ui.ws, `→ ${JSON.stringify(msg)}`);
  socket.send(JSON.stringify(msg));
}

async function wsTest() {
  if (!state.ed) throw new Error('Se requiere una clave Ed25519 para session.logon.');
  if (!state.apiKey) throw new Error('Falta la API key.');

  if (state.socket && state.socket.readyState <= WebSocket.OPEN) {
    state.socket.close();
  }

  const socket = new WebSocket(BINANCE_TESTNET_FUTURES_WS);
  state.socket = socket;
  line(ui.ws, `conectando a ${BINANCE_TESTNET_FUTURES_WS}`);

  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('No se pudo abrir el WebSocket.'));
  });

  socket.onmessage = (ev) => line(ui.ws, `← ${ev.data}`);
  socket.onclose = (ev) => line(ui.ws, `socket cerrado (code ${ev.code})`);

  // session.logon: payload = parámetros ordenados alfabéticamente, unidos por &
  const logonParams = [
    ['apiKey', state.apiKey],
    ['timestamp', timestampWithOffset(state.timeOffset)],
  ];
  const payload = buildSortedQuery(logonParams);
  const signature = await signEd25519Base64(state.ed.privateKey, payload);
  logonParams.push(['signature', signature]);

  wsSend(socket, 1, 'session.logon', Object.fromEntries(logonParams));

  const method = ui.wsMethod.value.trim() || 'v2/account.balance';
  setTimeout(() => {
    try {
      wsSend(socket, 2, method, { recvWindow: DEFAULT_RECV_WINDOW, timestamp: timestampWithOffset(state.timeOffset) });
    } catch (err) {
      line(ui.ws, `error enviando ${method}: ${err.message}`);
    }
  }, 600);
}

function wsClose() {
  if (state.socket) state.socket.close();
  else line(ui.ws, 'No hay socket abierto.');
}

/* ---------------------------------------------------------------- wiring */

function guard(fn) {
  return async () => {
    try {
      await fn();
    } catch (err) {
      line(ui.rest, `ERROR: ${err && err.message ? err.message : String(err)}`);
    }
  };
}

el('btn-rsa').addEventListener('click', guard(generateRsa));
el('btn-ed').addEventListener('click', guard(generateEd));
el('btn-hmac').addEventListener('click', guard(useHmac));
el('btn-save-apikey').addEventListener('click', guard(saveApiKey));
el('btn-wipe').addEventListener('click', guard(wipeAll));
el('btn-sync').addEventListener('click', guard(syncClock));
el('btn-balance').addEventListener('click', guard(getBalance));
el('btn-order').addEventListener('click', guard(placeTestOrder));
el('btn-cancel').addEventListener('click', guard(cancelOrder));
el('btn-test-endpoint').addEventListener('click', guard(testEndpoint));
el('btn-ws').addEventListener('click', guard(wsTest));
el('btn-ws-close').addEventListener('click', guard(wsClose));

el('btn-copy-pem').addEventListener('click', async () => {
  const rec = state.rsa || state.ed;
  if (!rec) {
    line(ui.status, 'No hay clave pública que copiar.');
    return;
  }
  try {
    await navigator.clipboard.writeText(rec.publicPem);
    line(ui.status, 'PEM copiado al portapapeles.');
  } catch {
    line(ui.status, 'El portapapeles no está disponible; selecciona el texto manualmente.');
  }
});

guard(loadAll)();
