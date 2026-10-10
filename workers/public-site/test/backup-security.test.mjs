// Regresión de las correcciones pedidas por la revisión de seguridad de /api/backup:
//   1. Parámetros del sobre (iter/salt/iv) validados ANTES del KDF y ligados como AAD.
import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeBackup, devOpenHostAllowed, handleBackupRequest, verifyBackupLicense } from '../src/backup.js';
import {
  BACKUP_ENVELOPE_VERSION,
  IV_BYTES,
  KDF_ITERATIONS,
  MAX_BACKUP_BYTES,
  MAX_KDF_ITERATIONS,
  MIN_KDF_ITERATIONS,
  SALT_BYTES,
  base64ToBytes,
  bytesToBase64,
  decryptBackup,
  encryptBackup,
  envelopeAad,
  parseEnvelope,
  randomBytes,
} from '../static/backup/backup-core.js';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const NOW_SEC = Math.floor(NOW / 1000);
const PASS = 'frase-de-paso-larga-y-segura-42';
const PROD_URL = 'https://trade.swal.network/api/backup';
const LOCAL_URL = 'http://127.0.0.1:8787/api/backup';
const PREVIEW_URL = 'https://swal-trade-public-site.worker-dev.example.workers.dev/api/backup';

async function makeSigner() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
  const pubkeyB64 = bytesToBase64(new Uint8Array(spki));
  async function token(payload) {
    const body = { iss: 'swal-trade-billing', iat: NOW_SEC, ...payload };
    const b64 = Buffer.from(new TextEncoder().encode(JSON.stringify(body))).toString('base64url');
    const sig = await crypto.subtle.sign('Ed25519', kp.privateKey, new TextEncoder().encode(b64));
    return `${b64}.${Buffer.from(new Uint8Array(sig)).toString('base64url')}`;
  }
  return { pubkeyB64, token };
}

/** D1 falso que entiende la tabla backups y el límite por cuenta. */
function fakeDb() {
  const rows = new Map();
  const rates = new Map();
  const norm = (sql) => sql.replace(/\s+/g, ' ').trim();
  return {
    rows,
    rates,
    calls: 0,
    prepare(sql) {
      const text = norm(sql);
      this.calls += 1;
      const rate = /^INSERT INTO backup_rate_limits/.test(text);
      return {
        bind(...args) {
          return {
            async first() {
              if (/^SELECT account_sub/.test(text)) {
                const r = rows.get(args[0]);
                return r ? { ...r } : null;
              }
              if (rate) {
                const [sub, windowStart, cutoff] = args;
                const prev = rates.get(sub);
                const next = !prev || prev.window_start < cutoff
                  ? { window_start: windowStart, count: 1 }
                  : { window_start: prev.window_start, count: prev.count + 1 };
                rates.set(sub, next);
                return { count: next.count, window_start: next.window_start };
              }
              return null;
            },
            async run() {
              if (/^INSERT INTO backups/.test(text)) rows.set(args[0], { account_sub: args[0], updated_at: args[1], size: args[2], envelope: args[3] });
              else if (/^DELETE FROM backups/.test(text)) rows.delete(args[0]);
              else if (/^INSERT INTO explain_kv/.test(text)) rates.set(args[0], { value: args[1] });
              else throw new Error(`SQL no soportado por el fake: ${text}`);
            },
          };
        },
      };
    },
  };
}

const fakeEnvelope = (over = {}) => ({
  v: BACKUP_ENVELOPE_VERSION,
  kdf: 'PBKDF2-SHA256',
  iter: KDF_ITERATIONS,
  salt: bytesToBase64(randomBytes(SALT_BYTES)),
  iv: bytesToBase64(randomBytes(IV_BYTES)),
  ct: bytesToBase64(randomBytes(40)),
  ...over,
});

const req = (method, envelope, token, url = PROD_URL, headers = {}) => new Request(url, {
  method,
  headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(envelope ? { 'Content-Type': 'application/json' } : {}),
    ...headers,
  },
  body: envelope ? JSON.stringify(envelope) : undefined,
});

// ---------- 1. parámetros del sobre: validación estricta ANTES del KDF ----------

test('sobre: iter debe ser número entero y estar entre 600.000 y 2.000.000', () => {
  const good = fakeEnvelope();
  // Topes aceptados (incluidos).
  assert.equal(parseEnvelope({ ...good, iter: MIN_KDF_ITERATIONS }).ok, true);
  assert.equal(parseEnvelope({ ...good, iter: MAX_KDF_ITERATIONS }).ok, true);
  // Fuera de rango.
  assert.equal(parseEnvelope({ ...good, iter: MIN_KDF_ITERATIONS - 1 }).ok, false);
  assert.equal(parseEnvelope({ ...good, iter: MAX_KDF_ITERATIONS + 1 }).ok, false);
  assert.equal(parseEnvelope({ ...good, iter: 1 }).error, 'envelope_iter');
  assert.equal(parseEnvelope({ ...good, iter: 1e15 }).error, 'envelope_iter');
  assert.equal(parseEnvelope({ ...good, iter: 600000.5 }).error, 'envelope_iter');
  assert.equal(parseEnvelope({ ...good, iter: Number.MAX_SAFE_INTEGER }).error, 'envelope_iter');
  // Tipo incorrecto: ni boolean, ni cadena, ni array (antes llegaban al KDF convertidos).
  assert.equal(parseEnvelope({ ...good, iter: true }).error, 'envelope_iter');
  assert.equal(parseEnvelope({ ...good, iter: '600000' }).error, 'envelope_iter');
  assert.equal(parseEnvelope({ ...good, iter: [1e15] }).error, 'envelope_iter');
  assert.equal(parseEnvelope({ ...good, iter: null }).error, 'envelope_iter');
  assert.equal(parseEnvelope({ ...good, iter: undefined }).error, 'envelope_iter');
});

test('sobre: la sal es de exactamente 16 bytes y el IV de 12', () => {
  const good = fakeEnvelope();
  assert.equal(parseEnvelope({ ...good, salt: bytesToBase64(new Uint8Array(1)) }).error, 'envelope_salt_length');
  assert.equal(parseEnvelope({ ...good, salt: bytesToBase64(new Uint8Array(64)) }).error, 'envelope_salt_length');
  assert.equal(parseEnvelope({ ...good, salt: bytesToBase64(new Uint8Array(65536)) }).error, 'envelope_salt_length');
  assert.equal(parseEnvelope({ ...good, salt: bytesToBase64(new Uint8Array(15)) }).ok, false);
  assert.equal(parseEnvelope({ ...good, salt: bytesToBase64(new Uint8Array(17)) }).ok, false);
  assert.equal(parseEnvelope({ ...good, iv: bytesToBase64(new Uint8Array(11)) }).error, 'envelope_iv_length');
  assert.equal(parseEnvelope({ ...good, iv: bytesToBase64(new Uint8Array(13)) }).error, 'envelope_iv_length');
  assert.equal(parseEnvelope({ ...good, salt: bytesToBase64(randomBytes(SALT_BYTES)) }).ok, true);
});

test('sobre: un sobre con parámetros inválido se rechaza SIN derivar ninguna clave', async () => {
  let subtleCalls = 0;
  const countingSubtle = {
    importKey(...args) { subtleCalls += 1; return crypto.subtle.importKey(...args); },
    deriveKey(...args) { subtleCalls += 1; return crypto.subtle.deriveKey(...args); },
    decrypt(...args) { subtleCalls += 1; return crypto.subtle.decrypt(...args); },
    encrypt(...args) { subtleCalls += 1; return crypto.subtle.encrypt(...args); },
  };
  for (const bad of [1, 1e15, true, [1e15]]) {
    await assert.rejects(
      () => decryptBackup(fakeEnvelope({ iter: bad }), PASS, { subtle: countingSubtle }),
      /sobre inválido: envelope_iter/,
    );
  }
  await assert.rejects(
    () => decryptBackup(fakeEnvelope({ salt: bytesToBase64(new Uint8Array(1)) }), PASS, { subtle: countingSubtle }),
    /sobre inválido: envelope_salt_length/,
  );
  await assert.rejects(
    () => decryptBackup(fakeEnvelope({ iv: bytesToBase64(new Uint8Array(4)) }), PASS, { subtle: countingSubtle }),
    /sobre inválido: envelope_iv_length/,
  );
  assert.equal(subtleCalls, 0, 'el KDF no debe ejecutarse con parámetros inválidos');
});

test('sobre: v, kdf, iter y salt van como AAD; alterarlos rompe la etiqueta GCM', async () => {
  const env = await encryptBackup({ saldo: 1 }, PASS);
  const aad = envelopeAad(env.v, env.kdf, env.iter, env.salt);
  // El AAD depende de los cuatro campos: cambiarlos cambia los bytes ligados.
  assert.notDeepEqual([...aad], [...envelopeAad(env.v, env.kdf, env.iter + 1, env.salt)]);
  assert.notDeepEqual([...aad], [...envelopeAad(env.v, env.kdf, env.iter, bytesToBase64(randomBytes(SALT_BYTES)))]);

  // iter manipulado DENTRO del rango permitido: la validación de forma lo acepta,
  // pero la etiqueta GCM falla porque el AAD ya no coincide.
  const forged = { ...env, iter: env.iter + 100000 };
  assert.equal(parseEnvelope(forged).ok, true);
  await assert.rejects(() => decryptBackup(forged, PASS), /frase incorrecta o datos alterados/);

  // Igual con kdf o v (aunque v/kdf los rechaza antes la validación de versión).
  await assert.rejects(() => decryptBackup({ ...env, kdf: 'PBKDF2-SHA512' }, PASS), /sobre inválido/);
  await assert.rejects(() => decryptBackup({ ...env, v: 2 }, PASS), /sobre inválido/);
  // Sal sustituida por otra de 16 bytes válida: también rompe la etiqueta.
  await assert.rejects(
    () => decryptBackup({ ...env, salt: bytesToBase64(randomBytes(SALT_BYTES)) }, PASS),
    /frase incorrecta o datos alterados/,
  );
  // Y el sobre intacto sigue descifrando.
  assert.deepEqual(await decryptBackup(env, PASS), { saldo: 1 });
});

test('sobre: el servidor rechaza los parámetros inválidos antes de guardar nada', async () => {
  const { pubkeyB64, token } = await makeSigner();
  const t = await token({ sub: 'acc_env', exp: NOW_SEC + 3600 });
  const deps = { pubkeySpki: pubkeyB64, nowSec: NOW_SEC, nowMs: NOW };
  for (const [over, error] of [
    [{ iter: 1 }, 'envelope_iter'],
    [{ iter: 1e15 }, 'envelope_iter'],
    [{ iter: true }, 'envelope_iter'],
    [{ iter: [1e15] }, 'envelope_iter'],
    [{ salt: bytesToBase64(new Uint8Array(1)) }, 'envelope_salt_length'],
    [{ salt: bytesToBase64(new Uint8Array(65536)) }, 'envelope_salt_length'],
    [{ iv: bytesToBase64(new Uint8Array(8)) }, 'envelope_iv_length'],
  ]) {
    const db = fakeDb();
    const res = await handleBackupRequest(req('PUT', fakeEnvelope(over), t, PROD_URL), { DB: db }, deps);
    assert.equal(res.status, 400, JSON.stringify(over));
    assert.equal((await res.json()).error, error, JSON.stringify(over));
    assert.equal(db.rows.size, 0, 'no se guarda nada con parámetros inválidos');
  }
});

// ---------- 3. licencia: emisor, iat y clave por cuenta ----------

test('licencia: exige iss=swal-trade-billing', async () => {
  const { pubkeyB64, token } = await makeSigner();
  const ok = await token({ sub: 'a', exp: NOW_SEC + 3600 });
  assert.equal((await verifyBackupLicense(ok, pubkeyB64, NOW_SEC)).status, 'ok');
  const otherIss = await token({ iss: 'otro-emisor', sub: 'a', exp: NOW_SEC + 3600 });
  assert.equal((await verifyBackupLicense(otherIss, pubkeyB64, NOW_SEC)).status, 'invalid');
  assert.equal((await verifyBackupLicense(otherIss, pubkeyB64, NOW_SEC)).reason, 'issuer');
  const noIss = await token({ sub: 'a', exp: NOW_SEC + 3600, iss: undefined });
  assert.equal((await verifyBackupLicense(noIss, pubkeyB64, NOW_SEC)).status, 'invalid');
});

test('licencia: iat numérica, no futura (60 s de holgura) y nunca posterior a exp', async () => {
  const { pubkeyB64, token } = await makeSigner();
  const good = await token({ sub: 'a', iat: NOW_SEC - 10, exp: NOW_SEC + 3600 });
  assert.equal((await verifyBackupLicense(good, pubkeyB64, NOW_SEC)).status, 'ok');
  // Holgura de reloj de 60 s.
  const slightlyFuture = await token({ sub: 'a', iat: NOW_SEC + 60, exp: NOW_SEC + 3600 });
  assert.equal((await verifyBackupLicense(slightlyFuture, pubkeyB64, NOW_SEC)).status, 'ok');
  // Más allá de la holgura: emitida en el futuro.
  const future = await token({ sub: 'a', iat: NOW_SEC + 61, exp: NOW_SEC + 3600 });
  assert.equal((await verifyBackupLicense(future, pubkeyB64, NOW_SEC)).status, 'invalid');
  assert.equal((await verifyBackupLicense(future, pubkeyB64, NOW_SEC)).reason, 'iat_future');
  // iat no numérica.
  for (const iat of [true, '1700000000', null, [NOW_SEC]]) {
    const bad = await token({ sub: 'a', iat, exp: NOW_SEC + 3600 });
    assert.equal((await verifyBackupLicense(bad, pubkeyB64, NOW_SEC)).status, 'invalid');
    assert.equal((await verifyBackupLicense(bad, pubkeyB64, NOW_SEC)).reason, 'iat_type');
  }
  // iat posterior a exp: ventana imposible (iat dentro de la holgura, exp aún vigente).
  const inverted = await token({ sub: 'a', iat: NOW_SEC + 40, exp: NOW_SEC + 30 });
  assert.equal((await verifyBackupLicense(inverted, pubkeyB64, NOW_SEC)).status, 'invalid');
  assert.equal((await verifyBackupLicense(inverted, pubkeyB64, NOW_SEC)).reason, 'iat_after_exp');
});

test('licencia: la fila se busca SOLO por sub (sin account/account_id)', async () => {
  const { token } = await makeSigner();
  const withAccounts = await token({ sub: 'acc_sub', account: 'acc_account', account_id: 'acc_account_id', exp: NOW_SEC + 3600 });
  const payload = JSON.parse(new TextDecoder().decode(base64ToBytes(withAccounts.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))));
  assert.equal(payload.account, 'acc_account');

  // Solo hay `sub`.
  const db = fakeDb();
  const res = await handleBackupRequest(req('GET', null, withAccounts, PROD_URL), { DB: db }, {
    pubkeySpki: (await makeSigner()).pubkeyB64, nowSec: NOW_SEC, nowMs: NOW,
  });
  // Falla la firma (otra clave), pero si llegara a autorizar usaría `sub`: comprobado abajo.
  assert.equal(res.status, 401);

  const { pubkeyB64, token: sign } = await makeSigner();
  const t = await sign({ sub: 'fila_sub', account: 'fila_account', account_id: 'fila_account_id', exp: NOW_SEC + 3600 });
  const put = await handleBackupRequest(req('PUT', fakeEnvelope(), t, PROD_URL), { DB: db }, { pubkeySpki: pubkeyB64, nowSec: NOW_SEC, nowMs: NOW });
  assert.equal(put.status, 200);
  assert.deepEqual([...db.rows.keys()], ['fila_sub']);

  // Sin `sub`, con account: no autoriza.
  const noSub = await sign({ account: 'solo_account', exp: NOW_SEC + 3600 });
  const res2 = await handleBackupRequest(req('PUT', fakeEnvelope(), noSub, PROD_URL), { DB: fakeDb() }, { pubkeySpki: pubkeyB64, nowSec: NOW_SEC, nowMs: NOW });
  assert.equal(res2.status, 401);
  assert.equal((await res2.json()).error, 'license_no_sub');
});

// ---------- 5. dev-open solo en localhost ----------

test('dev-open: se acepta en localhost y en *.workers.dev, nunca en el dominio público', () => {
  assert.equal(devOpenHostAllowed(new Request(LOCAL_URL)), true);
  assert.equal(devOpenHostAllowed(new Request('http://localhost:8787/api/backup')), true);
  assert.equal(devOpenHostAllowed(new Request('http://127.0.0.1:8787/api/backup')), true);
  assert.equal(devOpenHostAllowed(new Request('http://[::1]:8787/api/backup')), true);
  assert.equal(devOpenHostAllowed(new Request(PREVIEW_URL)), true);
  // Producción y cualquier otro host: prohibido.
  assert.equal(devOpenHostAllowed(new Request(PROD_URL)), false);
  assert.equal(devOpenHostAllowed(new Request('https://trade.swal.network.evil.com/api/backup')), false);
  assert.equal(devOpenHostAllowed(new Request('https://workers.dev.ejemplo.com/api/backup')), false);
});

test('dev-open: con el flag activo, en trade.swal.network NO se acepta un token sin licencia', async () => {
  const { pubkeyB64 } = await makeSigner();
  const env = { DB: fakeDb(), BACKUP_DEV_OPEN: true };
  const deps = { pubkeySpki: pubkeyB64, nowSec: NOW_SEC, nowMs: NOW };
  const res = await handleBackupRequest(req('PUT', fakeEnvelope(), 'token-de-desarrollo-libre', PROD_URL), env, deps);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'license_invalid');
  // Nada se guarda y el límite ni se reclama.
  assert.equal(env.DB.rows.size, 0);
  assert.equal(env.DB.rates.size, 0);

  // El mismo token sí funciona en localhost.
  const local = await handleBackupRequest(req('PUT', fakeEnvelope(), 'token-de-desarrollo-libre', LOCAL_URL), env, deps);
  assert.equal(local.status, 200);
  const localBody = await local.json();
  assert.equal(localBody.dev, true);
  assert.match(localBody.sub, /^dev:[0-9a-f]{32}$/);
});

test('dev-open: en producción una licencia válida sigue funcionando con el flag puesto', async () => {
  const { pubkeyB64, token } = await makeSigner();
  const t = await token({ sub: 'acc_prod', exp: NOW_SEC + 3600 });
  const res = await handleBackupRequest(req('PUT', fakeEnvelope(), t, PROD_URL), { DB: fakeDb(), BACKUP_DEV_OPEN: 'true' }, { pubkeySpki: pubkeyB64, nowSec: NOW_SEC, nowMs: NOW });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).dev, false);
});

test('dev-open: authorizeBackup no marca dev fuera de un host local', async () => {
  const auth = await authorizeBackup(
    new Request(PROD_URL, { headers: { Authorization: 'Bearer x' } }),
    { BACKUP_DEV_OPEN: true },
    { pubkeySpki: (await makeSigner()).pubkeyB64, nowSec: NOW_SEC },
  );
  assert.deepEqual(auth, { ok: false, status: 401, error: 'license_invalid' });
});
