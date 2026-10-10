import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {
  authorizeBackup,
  backupRateLimit,
  handleBackupRequest,
  verifyBackupLicense,
} from '../src/backup.js';
import { explainStore } from '../src/explain.js';
import {
  BACKUP_ENVELOPE_VERSION,
  IV_BYTES,
  KDF_ITERATIONS,
  MAX_BACKUP_BYTES,
  SALT_BYTES,
  base64ToBytes,
  bytesToBase64,
  buildBackupData,
  decryptBackup,
  encryptBackup,
  parseEnvelope,
  passphraseStrength,
  randomBytes,
  scrubDenied,
} from '../static/backup/backup-core.js';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const NOW_SEC = Math.floor(NOW / 1000);
const PASS = 'frase-de-paso-larga-y-segura-42';

// ---------- utilidades de prueba ----------

const flipByte = (b64) => {
  const bytes = base64ToBytes(b64);
  bytes[0] ^= 0x01;
  return bytesToBase64(bytes);
};

async function makeSigner() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
  const pubkeyB64 = bytesToBase64(new Uint8Array(spki));
  async function token(payload) {
    // El contrato de licencia firma los bytes ASCII del primer segmento (base64url), no el JSON crudo
    // (igual que guardian-license.js). Ver docs del formato en static/guardian/guardian-license.js.
    const bodyB64url = Buffer.from(new TextEncoder().encode(JSON.stringify(payload))).toString('base64url');
    const sig = await crypto.subtle.sign('Ed25519', kp.privateKey, new TextEncoder().encode(bodyB64url));
    return `${bodyB64url}.${Buffer.from(new Uint8Array(sig)).toString('base64url')}`;
  }
  return { pubkeyB64, token };
}

/** Sobre estructuralmente válido sin cripto real (el servidor solo valida la forma). */
function fakeEnvelope() {
  return {
    v: BACKUP_ENVELOPE_VERSION,
    kdf: 'PBKDF2-SHA256',
    iter: KDF_ITERATIONS,
    salt: bytesToBase64(randomBytes(SALT_BYTES)),
    iv: bytesToBase64(randomBytes(IV_BYTES)),
    ct: bytesToBase64(randomBytes(40)),
  };
}

/** D1 falso que entiende la tabla backups y la explain_kv (límite por cuenta). */
function fakeDb() {
  const rows = new Map();
  const kv = new Map();
  const norm = (sql) => sql.replace(/\s+/g, ' ').trim();
  return {
    rows,
    prepare(sql) {
      const text = norm(sql);
      const isBackupsSelect = /^SELECT account_sub, updated_at, size, envelope FROM backups/.test(text);
      const isExplainSelect = /^SELECT value FROM explain_kv/.test(text);
      return {
        bind(...args) {
          return {
            async first() {
              if (isBackupsSelect) {
                const r = rows.get(args[0]);
                return r ? { ...r } : null;
              }
              if (isExplainSelect) {
                const row = kv.get(args[0]);
                const expired = row && row.expires_at !== null && row.expires_at <= args[1];
                return row && !expired ? { value: row.value } : null;
              }
              return null;
            },
            async run() {
              if (/^INSERT INTO backups/.test(text)) {
                rows.set(args[0], { account_sub: args[0], updated_at: args[1], size: args[2], envelope: args[3] });
              } else if (/^DELETE FROM backups/.test(text)) {
                rows.delete(args[0]);
              } else if (/^INSERT INTO explain_kv/.test(text)) {
                kv.set(args[0], { value: args[1], expires_at: args[2] });
              } else {
                throw new Error(`SQL no soportado por el fake: ${text}`);
              }
            },
          };
        },
      };
    },
  };
}

const req = (method, envelope, token) => new Request('https://trade.swal.network/api/backup', {
  method,
  headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(envelope ? { 'Content-Type': 'application/json' } : {}),
  },
  body: envelope ? JSON.stringify(envelope) : undefined,
});

const freshDeps = (pubkeyB64) => ({ pubkeySpki: pubkeyB64, nowSec: NOW_SEC, nowMs: NOW, rateStore: explainStore({}) });

// ---------- cliente: ida y vuelta, adverso, unicidad, formato ----------

test('cliente: ida y vuelta cifrar/descifrar', async () => {
  const data = buildBackupData({ guardian: { cfg: { limit: 50, maxLev: 5 } }, journal: [{ note: 'hola' }] });
  const env = await encryptBackup(data, PASS);
  assert.deepEqual(await decryptBackup(env, PASS), data);
});

test('cliente: frase incorrecta falla', async () => {
  const env = await encryptBackup({ secreto: 'no-leible' }, PASS);
  await assert.rejects(() => decryptBackup(env, 'otra-frase-distinta-larga'), /frase incorrecta o datos alterados/);
});

test('cliente: texto cifrado alterado falla (caso adverso de integridad)', async () => {
  const env = await encryptBackup({ saldo: 12345 }, PASS);
  const tampered = { ...env, ct: flipByte(env.ct) };
  await assert.rejects(() => decryptBackup(tampered, PASS), /frase incorrecta o datos alterados/);
});

test('cliente: IV y salt únicos por cifrado, y determinista con salt/iv fijos', async () => {
  const a = await encryptBackup({ x: 1 }, PASS);
  const b = await encryptBackup({ x: 1 }, PASS);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const c1 = await encryptBackup({ x: 1 }, PASS, { salt, iv });
  const c2 = await encryptBackup({ x: 1 }, PASS, { salt, iv });
  assert.equal(c1.ct, c2.ct);
});

test('cliente: formato de sobre versionado y parámetros mínimos', async () => {
  const env = await encryptBackup({ a: 1 }, PASS);
  assert.equal(env.v, BACKUP_ENVELOPE_VERSION);
  assert.equal(env.kdf, 'PBKDF2-SHA256');
  assert.ok(env.iter >= 600000);
  assert.equal(KDF_ITERATIONS, 600000);
  assert.equal(new Uint8Array(base64ToBytes(env.salt)).length, SALT_BYTES);
  assert.equal(new Uint8Array(base64ToBytes(env.iv)).length, IV_BYTES);
});

test('cliente: parseEnvelope rechaza sobres mal formados', () => {
  const good = fakeEnvelope();
  assert.equal(parseEnvelope(good).ok, true);
  assert.equal(parseEnvelope({ ...good, v: 2 }).ok, false);
  assert.equal(parseEnvelope({ ...good, kdf: 'scrypt' }).ok, false);
  assert.equal(parseEnvelope({ ...good, iv: bytesToBase64(new Uint8Array(8)) }).ok, false);
  assert.equal(parseEnvelope({ ...good, ct: bytesToBase64(new Uint8Array(4)) }).ok, false);
  assert.equal(parseEnvelope(null).ok, false);
  assert.equal(parseEnvelope('nope').ok, false);
});

// ---------- denylist de claves de Binance ----------

test('denylist: excluye claves de Binance y secretos, conserva lo permitido', () => {
  const dirty = {
    apiKey: 'BINANCE-APIKEY',
    secret: 'BINANCE-SECRET',
    nested: { hmac: 'H', X_MBX_APIKEY: 'K', public_field: 'keep' },
    arr: [{ private_key: 'p', note: 'n' }, 'texto', 7],
  };
  const clean = scrubDenied(dirty);
  assert.equal(clean.apiKey, undefined);
  assert.equal(clean.secret, undefined);
  assert.equal(clean.nested.hmac, undefined);
  assert.equal(clean.nested.X_MBX_APIKEY, undefined);
  assert.equal(clean.nested.public_field, 'keep');
  assert.deepEqual(clean.arr, [{ note: 'n' }, 'texto', 7]);
});

test('denylist: buildBackupData nunca incluye claves de Binance ni el token del bot salvo opt-in', () => {
  const data = buildBackupData({
    guardian: {
      cfg: { limit: 100, maxLev: 5 },
      telegram: { chat: '99', token: 'BOT-TOKEN-SECRETO' },
      apiKey: 'BINANCE-APIKEY',
      secret: 'BINANCE-SECRET',
    },
    analysis: { theme: 'dark', api_key: 'FUGA' },
    journal: [{ note: 'ok', X_MBX_APIKEY: 'FUGA2' }],
    includeBotToken: false,
  });
  const flat = JSON.stringify(data);
  assert.equal(data.guardian.cfg.limit, 100);
  assert.equal(data.guardian.telegram.chat, '99');
  assert.equal(data.guardian.telegram.botToken, undefined);
  assert.ok(!flat.includes('BINANCE-APIKEY'));
  assert.ok(!flat.includes('BINANCE-SECRET'));
  assert.ok(!flat.includes('BOT-TOKEN-SECRETO'));
  assert.equal('api_key' in data.analysis, false);
  assert.equal(data.analysis.theme, 'dark');
  assert.equal(data.journal[0].X_MBX_APIKEY, undefined);
  assert.equal(data.journal[0].note, 'ok');

  const withToken = buildBackupData({ guardian: { telegram: { chat: '1', token: 'TB' } }, includeBotToken: true });
  assert.equal(withToken.guardian.telegram.botToken, 'TB');
});

// ---------- fuerza de frase (UI) ----------

test('fuerza de frase: sube con longitud y variedad', () => {
  assert.ok(passphraseStrength('abc').score < passphraseStrength('abcdefghijk').score);
  assert.ok(passphraseStrength('abcdefghijk').score < passphraseStrength('Abcd3fghijk!largo').score);
  assert.equal(passphraseStrength(123).score <= 1, true);
});

// ---------- servidor: licencia ----------

test('servidor: sin licencia devuelve 401', async () => {
  const { pubkeyB64 } = await makeSigner();
  const res = await handleBackupRequest(req('PUT', fakeEnvelope()), { DB: fakeDb() }, freshDeps(pubkeyB64));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'license_required');
  assert.equal(res.headers.get('WWW-Authenticate'), 'Bearer');
});

test('servidor: licencia inválida (firmada con otra clave) devuelve 401', async () => {
  const good = await makeSigner();
  const other = await makeSigner();
  const token = await other.token({ sub: 'acc_1', exp: NOW_SEC + 3600 });
  // La firma con otra clave no verifica contra la pública correcta.
  assert.equal((await verifyBackupLicense(token, good.pubkeyB64, NOW_SEC)).status, 'invalid');
  const res = await handleBackupRequest(req('PUT', fakeEnvelope(), token), { DB: fakeDb() }, freshDeps(good.pubkeyB64));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'license_invalid');
});

test('servidor: licencia caducada devuelve 402', async () => {
  const { pubkeyB64, token } = await makeSigner();
  const expired = await token({ sub: 'acc_1', exp: NOW_SEC - 10 });
  assert.equal((await verifyBackupLicense(expired, pubkeyB64, NOW_SEC)).status, 'expired');
  const http = new Request('https://trade.swal.network/api/backup', { method: 'PUT', headers: { Authorization: `Bearer ${expired}`, 'Content-Type': 'application/json' }, body: JSON.stringify(fakeEnvelope()) });
  const res = await handleBackupRequest(http, { DB: fakeDb() }, freshDeps(pubkeyB64));
  assert.equal(res.status, 402);
  assert.equal((await res.json()).error, 'license_expired');
});

test('servidor: licencia válida guarda, lee y borra el sobre', async () => {
  const { pubkeyB64, token } = await makeSigner();
  const t = await token({ sub: 'acc_ok', exp: NOW_SEC + 3600 });
  const db = fakeDb();
  const envelope = fakeEnvelope();

  const put = await handleBackupRequest(req('PUT', envelope, t), { DB: db }, freshDeps(pubkeyB64));
  assert.equal(put.status, 200);
  const putBody = await put.json();
  assert.equal(putBody.sub, 'acc_ok');
  assert.equal(putBody.dev, false);
  assert.ok(db.rows.has('acc_ok'));

  const get = await handleBackupRequest(req('GET', null, t), { DB: db }, freshDeps(pubkeyB64));
  assert.equal(get.status, 200);
  const getBody = await get.json();
  assert.deepEqual(getBody.envelope, envelope);

  const del = await handleBackupRequest(req('DELETE', null, t), { DB: db }, freshDeps(pubkeyB64));
  assert.equal(del.status, 200);
  assert.equal(db.rows.has('acc_ok'), false);

  const missing = await handleBackupRequest(req('GET', null, t), { DB: db }, freshDeps(pubkeyB64));
  assert.equal(missing.status, 404);
});

test('servidor: rechaza método no permitido', async () => {
  const { pubkeyB64, token } = await makeSigner();
  const t = await token({ sub: 'acc_ok', exp: NOW_SEC + 3600 });
  const res = await handleBackupRequest(req('PATCH', null, t), { DB: fakeDb() }, freshDeps(pubkeyB64));
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('Allow'), 'PUT, GET, DELETE');
});

// ---------- servidor: tope de tamaño ----------

test('servidor: rechaza sobres por encima de 256 KB', async () => {
  const { pubkeyB64, token } = await makeSigner();
  const t = await token({ sub: 'acc_big', exp: NOW_SEC + 3600 });
  const huge = { ...fakeEnvelope(), ct: 'A'.repeat(300 * 1024) };
  const res = await handleBackupRequest(req('PUT', huge, t), { DB: fakeDb() }, freshDeps(pubkeyB64));
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.error, 'too_large');
  assert.equal(body.max_bytes, MAX_BACKUP_BYTES);
});

// ---------- servidor: guarda EXACTAMENTE el sobre, sin texto en claro ----------

test('servidor: guarda solo el sobre; el texto en claro nunca llega', async () => {
  const { pubkeyB64, token } = await makeSigner();
  const t = await token({ sub: 'acc_secret', exp: NOW_SEC + 3600 });
  const data = buildBackupData({ guardian: { cfg: { limit: 10 } }, journal: [{ note: 'TEXTO-EN-CLARO-SECRETO-12345' }] });
  const envelope = await encryptBackup(data, PASS);
  const db = fakeDb();
  const res = await handleBackupRequest(req('PUT', envelope, t), { DB: db }, freshDeps(pubkeyB64));
  assert.equal(res.status, 200);

  const stored = db.rows.get('acc_secret').envelope;
  assert.equal(typeof stored, 'string');
  // El servidor almacena exactamente el sobre recibido (mismos 6 campos, mismos valores).
  assert.deepEqual(JSON.parse(stored), envelope);
  // No hay ni rastro del texto en claro ni de la frase: solo el sobre cifrado.
  assert.ok(!stored.includes('TEXTO-EN-CLARO-SECRETO-12345'));
  assert.ok(!stored.includes(PASS));
  assert.ok(stored.includes(envelope.ct));
  assert.ok(stored.includes(envelope.salt));
});

// ---------- servidor: límite por cuenta ----------

test('servidor: limita peticiones por cuenta (429 con Retry-After)', async () => {
  const { pubkeyB64, token } = await makeSigner();
  const t = await token({ sub: 'acc_rl', exp: NOW_SEC + 3600 });
  const env = { DB: fakeDb(), BACKUP_RATE_LIMIT: '3' };
  assert.equal(backupRateLimit(env), 3);
  const store = explainStore({});
  for (let i = 0; i < 3; i += 1) {
    const res = await handleBackupRequest(req('PUT', fakeEnvelope(), t), env, { pubkeySpki: pubkeyB64, nowSec: NOW_SEC, nowMs: NOW + i * 1000, rateStore: store });
    assert.equal(res.status, 200, `petición ${i}`);
  }
  const blocked = await handleBackupRequest(req('PUT', fakeEnvelope(), t), env, { pubkeySpki: pubkeyB64, nowSec: NOW_SEC, nowMs: NOW + 4000, rateStore: store });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('Retry-After')) > 0);
  // Otra cuenta no se ve afectada.
  const t2 = await token({ sub: 'acc_rl2', exp: NOW_SEC + 3600 });
  const ok = await handleBackupRequest(req('PUT', fakeEnvelope(), t2), env, { pubkeySpki: pubkeyB64, nowSec: NOW_SEC, nowMs: NOW + 5000, rateStore: store });
  assert.equal(ok.status, 200);
});

// ---------- servidor: modo desarrollo ("gratis durante desarrollo") ----------

test('dev-open: con el flag acepta cualquier token como cuenta dev; sin flag, 401', async () => {
  // Con BACKUP_DEV_OPEN=true: token arbitrario -> cuenta dev:<hash>, sin licencia real.
  const devEnv = { DB: fakeDb(), BACKUP_DEV_OPEN: 'true' };
  const resDev = await handleBackupRequest(req('PUT', fakeEnvelope(), 'token-de-desarrollo-libre'), devEnv, { nowSec: NOW_SEC, nowMs: NOW, rateStore: explainStore({}) });
  assert.equal(resDev.status, 200);
  const devBody = await resDev.json();
  assert.equal(devBody.dev, true);
  assert.match(devBody.sub, /^dev:[0-9a-f]{32}$/);

  // Sin el flag y sin licencia válida: 401 (aunque pueda resolverse la pubkey).
  const prodEnv = { DB: fakeDb() };
  const res = await handleBackupRequest(req('PUT', fakeEnvelope(), 'token-cualquiera'), prodEnv, { pubkeySpki: (await makeSigner()).pubkeyB64, nowSec: NOW_SEC, nowMs: NOW, rateStore: explainStore({}) });
  assert.equal(res.status, 401);

  // dev-open false explícito no activa el modo desarrollo.
  const off = await handleBackupRequest(req('PUT', fakeEnvelope(), 'x'), { DB: fakeDb(), BACKUP_DEV_OPEN: 'false' }, { pubkeySpki: (await makeSigner()).pubkeyB64, nowSec: NOW_SEC, nowMs: NOW, rateStore: explainStore({}) });
  assert.equal(off.status, 401);
});

test('dev-open: authorizeBackup separa las cuentas de desarrollo de las reales', async () => {
  const { pubkeyB64, token } = await makeSigner();
  const authDev = await authorizeBackup(req('GET', null, 'abc'), { BACKUP_DEV_OPEN: true }, { pubkeySpki: pubkeyB64, nowSec: NOW_SEC });
  assert.equal(authDev.ok, true);
  assert.ok(authDev.sub.startsWith('dev:'));
  const real = await token({ sub: 'acc_real', exp: NOW_SEC + 3600 });
  const authReal = await authorizeBackup(req('GET', null, real), { BACKUP_DEV_OPEN: true }, { pubkeySpki: pubkeyB64, nowSec: NOW_SEC });
  assert.deepEqual(authReal, { ok: true, sub: 'acc_real', dev: false });
});

// ---------- integración vía worker ----------

test('worker: /api/backup enrutado, autenticado y con cabeceras de seguridad', async () => {
  const { pubkeyB64, token } = await makeSigner();
  // El worker usa el reloj real (no se inyecta nowSec), así que la licencia debe caducar en el futuro real.
  const t = await token({ sub: 'acc_route', exp: Math.floor(Date.now() / 1000) + 3600 });
  const envelope = fakeEnvelope();
  const res = await worker.fetch(
    new Request('https://trade.swal.network/api/backup', { method: 'PUT', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify(envelope) }),
    { DB: fakeDb(), BACKUP_LICENSE_PUBKEY: pubkeyB64 },
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.match(res.headers.get('Content-Security-Policy'), /default-src 'self'/);
  assert.equal((await res.json()).sub, 'acc_route');
});
