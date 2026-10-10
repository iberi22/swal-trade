// Regresión de las correcciones pedidas por la revisión de seguridad de /api/backup:
//   1. Parámetros del sobre (iter/salt/iv) validados ANTES del KDF y ligados como AAD.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleBackupRequest } from '../src/backup.js';
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
