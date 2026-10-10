// SPDX-License-Identifier: AGPL-3.0-only
//
// Respaldo cifrado de extremo a extremo: PUT / GET / DELETE /api/backup.
//
// El cliente cifra con backup-core.js (PBKDF2 + AES-256-GCM) y manda SOLO el sobre
// {v, kdf, iter, salt, iv, ct}. El servidor NUNCA ve la frase, la clave derivada ni el
// texto en claro (contrato E2EE de docs/SWAL/GOAL.md): guarda el sobre tal cual en D1,
// una fila por cuenta. La clave por cuenta es el `sub` de la licencia Ed25519 (la misma
// que verifica /guardian/). En desarrollo, con BACKUP_DEV_OPEN=true, se acepta cualquier
// token no vacío ("gratis durante desarrollo") y la cuenta se deriva de su hash con el
// prefijo "dev:", en un espacio separado de las cuentas reales.

import {
  MAX_BACKUP_BYTES,
  base64ToBytes,
  envelopeJson,
  measureEnvelopeBytes,
  parseEnvelope,
} from '../static/backup/backup-core.js';

/** Límite por cuenta: peticiones por ventana. Generoso: el respaldo es manual. */
export const BACKUP_RATE_LIMIT_DEFAULT = 60;
export const BACKUP_RATE_WINDOW_MS = 60 * 60 * 1000;
/** URL de la clave pública de licencias; campo spki_base64. Igual que /guardian/. */
export const BACKUP_PUBKEY_URL = 'https://pay.swal.network/v1/pubkey';
/** Prefijo del `sub` de las cuentas de desarrollo (separadas de las reales). */
const DEV_SUB_PREFIX = 'dev:';
/** Emisor obligatorio de la licencia: firma billing-worker. */
export const LICENSE_ISSUER = 'swal-trade-billing';/** Tolerancia de reloj admisible en `iat` (60 s). */
const IAT_SKEW_SEC = 60;
/** Hosts donde se permite el modo desarrollo: local y previsualizaciones *.workers.dev. */
const DEV_ALLOWED_SUFFIXES = ['workers.dev'];

// ---------- base64 / hashing ----------

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- verificación de licencia Ed25519 (servidor) ----------

/**
 * Verifica el token Ed25519 `base64url(payload).base64url(sig)` contra la clave SPKI.
 * Espejo de guardian-license.js checkLicense, del lado del servidor. No depende de red.
 * @returns {Promise<{status:'ok'|'invalid'|'expired', payload?: object, reason?: string}>}
 */
export async function verifyBackupLicense(token, pubkeySpki, nowSec, subtle = crypto.subtle) {
  if (typeof token !== 'string' || !token.trim()) return { status: 'invalid', reason: 'missing' };
  const parts = token.trim().split('.');
  if (parts.length !== 2) return { status: 'invalid', reason: 'malformed' };
  if (typeof pubkeySpki !== 'string' || !pubkeySpki.trim()) return { status: 'invalid', reason: 'no_pubkey' };

  let key;
  try {
    key = await subtle.importKey('spki', base64ToBytes(pubkeySpki), { name: 'Ed25519' }, false, ['verify']);
  } catch {
    return { status: 'invalid', reason: 'pubkey_import' };
  }
  let ok;
  try {
    ok = await subtle.verify({ name: 'Ed25519' }, key, base64ToBytes(parts[1]), new TextEncoder().encode(parts[0]));
  } catch {
    return { status: 'invalid', reason: 'sig_decode' };
  }
  if (!ok) return { status: 'invalid', reason: 'bad_signature' };

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64ToBytes(parts[0])));
  } catch {
    return { status: 'invalid', reason: 'payload_decode' };
  }
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) return { status: 'expired', payload };
  // Emisor: solo billing.swal.network firma licencias de SWAL.
  if (payload.iss !== LICENSE_ISSUER) return { status: 'invalid', reason: 'issuer', payload };
  // `iat` numérica, no futura (con 60 s de tolerancia de reloj) y no posterior a `exp`.
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) return { status: 'invalid', reason: 'iat_type', payload };
  if (payload.iat > nowSec + IAT_SKEW_SEC) return { status: 'invalid', reason: 'iat_future', payload };
  if (payload.iat > payload.exp) return { status: 'invalid', reason: 'iat_after_exp', payload };
  return { status: 'ok', payload };
}

/**
 * Clave por cuenta: SOLO el `sub` de la licencia. Ni `account` ni `account_id` valen: un
 * atacante que firme (o robe) un payload con otro campo no debe elegir la fila de otro.
 * @param {object} payload
 * @returns {string|null}
 */
export function accountSubFrom(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const v = payload.sub;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Clave pública de licencias: inyectada (tests) > fijada en env > red (con caché en modulo). */
let pubkeyCache = null;
export async function resolveBackupPubkey(env, deps = {}) {
  if (typeof deps.pubkeySpki === 'string' && deps.pubkeySpki.trim()) return deps.pubkeySpki.trim();
  if (env && typeof env.BACKUP_LICENSE_PUBKEY === 'string' && env.BACKUP_LICENSE_PUBKEY.trim()) {
    return env.BACKUP_LICENSE_PUBKEY.trim();
  }
  if (pubkeyCache) return pubkeyCache;
  const fetchFn = deps.fetchFn ?? fetch;
  let text = '';
  try {
    const res = await fetchFn(BACKUP_PUBKEY_URL);
    if (!res || res.ok === false) return null;
    text = (await res.text()).trim();
  } catch {
    return null;
  }
  let value = text;
  try {
    const j = JSON.parse(text);
    value = j.spki_base64 || j.public_key || j.pubkey || j.spki || '';
  } catch {
    /* texto plano */
  }
  if (typeof value !== 'string' || !value) return null;
  pubkeyCache = value;
  return value;
}

/** El interruptor "gratis durante desarrollo". Acepta true, "true" o "1". */
export function devOpenEnabled(env) {
  const v = env && env.BACKUP_DEV_OPEN;
  return v === true || v === 'true' || v === '1';
}

/**
 * Host de la petición ("trade.swal.network"), o cadena vacía si no se puede determinar.
 * No registra nada: solo se usa para decidir si el modo desarrollo puede aplicarse.
 * @param {Request} request
 * @returns {string}
 */
function requestHost(request) {
  try {
    return new URL(request.url).hostname;
  } catch {
    return '';
  }
}

/**
 * true solo en localhost / 127.0.0.1 / ::1 / *.workers.dev (previsualizaciones de Cloudflare).
 * Cualquier otro host (producción incluida) bloquea el modo desarrollo: el flag nunca debe
 * poder aceptar tokens sin licencia real en el dominio público.
 * @param {Request} request
 * @returns {boolean}
 */
export function devOpenHostAllowed(request) {
  const host = requestHost(request).toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
  return DEV_ALLOWED_SUFFIXES.some((suffix) => host.endsWith(`.${suffix}`));
}

function bearerToken(request) {
  const auth = request.headers.get('Authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

/**
 * Autoriza una petición de respaldo. Devuelve {ok:true, sub, dev} o {ok:false, status, error}.
 */
export async function authorizeBackup(request, env, deps = {}) {
  const nowSec = deps.nowSec ?? Math.floor((deps.nowMs ?? Date.now()) / 1000);
  const token = bearerToken(request);
  if (!token) return { ok: false, status: 401, error: 'license_required' };

  const devOpen = devOpenEnabled(env) && devOpenHostAllowed(request);
  let pubkey = null;
  try {
    pubkey = await resolveBackupPubkey(env, deps);
  } catch {
    pubkey = null;
  }

  if (pubkey) {
    const lic = await verifyBackupLicense(token, pubkey, nowSec);
    if (lic.status === 'ok') {
      const sub = accountSubFrom(lic.payload);
      if (sub) return { ok: true, sub, dev: false };
      return { ok: false, status: 401, error: 'license_no_sub' };
    }
    if (lic.status === 'expired') return { ok: false, status: 402, error: 'license_expired' };
    // inválida: si dev-open está activo, se trata como token de desarrollo más abajo.
  } else if (!devOpen) {
    return { ok: false, status: 503, error: 'pubkey_unavailable' };
  }

  if (devOpen) {
    const sub = DEV_SUB_PREFIX + (await sha256Hex(token)).slice(0, 32);
    return { ok: true, sub, dev: true };
  }
  return { ok: false, status: 401, error: 'license_invalid' };
}

// ---------- límite por cuenta (atómico en D1; si no hay D1, falla cerrado) ----------

/**
 * Reclamo atómico del cupo por cuenta: UNA sola sentencia SQL, sin leer-y-escribir.
 *   - Inserta la ventana (count = 1) si la cuenta no existe.
 *   - Si la ventana guardada ya caducó, la reinicia a `nowMs` con count = 1.
 *   - Si no, incrementa el contador.
 * Devuelve el recuento resultante de la ventana vigente (RETURNING): quien compara con el
 * límite es el llamador, con el valor que ha escrito la propia base de datos.
 * @param {object} db
 * @param {string} sub
 * @param {number} nowMs
 * @param {number} windowMs
 */
const SQL_RATE_CLAIM =
  'INSERT INTO backup_rate_limits (account_sub, window_start, count) VALUES (?1, ?2, 1) ' +
  'ON CONFLICT(account_sub) DO UPDATE SET ' +
  'window_start = CASE WHEN backup_rate_limits.window_start < ?3 THEN ?2 ELSE backup_rate_limits.window_start END, ' +
  'count = CASE WHEN backup_rate_limits.window_start < ?3 THEN 1 ELSE backup_rate_limits.count + 1 END ' +
  'RETURNING count, window_start';

/**
 * Reclama una unidad del cupo por cuenta. `null` si no hay binding de D1: en ese caso el
 * llamador responde 503 (falla cerrado) en lugar de rebajar el límite a la memoria del isolate,
 * que se reinicia en cada invocación y no protege nada.
 * @param {object} env
 * @param {string} sub
 * @param {number} nowMs
 * @param {{limit?: number, windowMs?: number}} [opts]
 * @returns {Promise<{allowed: boolean, remaining: number, retryAfterS: number}|null>}
 */
export async function claimBackupRateLimit(env, sub, nowMs, opts = {}) {
  const db = env && env.DB;
  if (!db || typeof db.prepare !== 'function') return null;
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : backupRateLimit(env);
  const windowMs = Number.isFinite(opts.windowMs) && opts.windowMs > 0 ? opts.windowMs : BACKUP_RATE_WINDOW_MS;
  const row = await db.prepare(SQL_RATE_CLAIM).bind(sub, nowMs, nowMs - windowMs).first();
  const count = row && Number.isFinite(row.count) ? row.count : 1;
  const windowStart = row && Number.isFinite(row.window_start) ? row.window_start : nowMs;
  const allowed = count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - count),
    retryAfterS: allowed ? 0 : Math.max(1, Math.ceil((windowStart + windowMs - nowMs) / 1000)),
  };
}

// ---------- almacén de sobres (D1; memoria en desarrollo) ----------

const SQL_GET = 'SELECT account_sub, updated_at, size, envelope FROM backups WHERE account_sub = ?1';
const SQL_PUT =
  'INSERT INTO backups (account_sub, updated_at, size, envelope) VALUES (?1, ?2, ?3, ?4) ' +
  'ON CONFLICT(account_sub) DO UPDATE SET updated_at = excluded.updated_at, size = excluded.size, envelope = excluded.envelope';
const SQL_DELETE = 'DELETE FROM backups WHERE account_sub = ?1';

const memoryStores = new WeakMap();

/**
 * Almacén de sobres. D1 si existe el binding `DB`. Sin binding no hay almacén: el respaldo es
 * persistente por definición, así que guardar en la memoria del isolate (que se pierde entre
 * invocaciones) sería peor que fallar. `handleBackupRequest` responde 503 en ese caso.
 * @param {object} env
 */
export function backupStore(env) {
  const db = env && env.DB;
  if (!db || typeof db.prepare !== 'function') return null;
  return {
    kind: 'd1',
    async get(sub) {
      const row = await db.prepare(SQL_GET).bind(sub).first();
      return row
        ? { account_sub: row.account_sub, updated_at: row.updated_at, size: row.size, envelope: row.envelope }
        : null;
    },
    async put(sub, envelope, size, nowSec) {
      await db.prepare(SQL_PUT).bind(sub, nowSec, size, envelope).run();
    },
    async del(sub) {
      await db.prepare(SQL_DELETE).bind(sub).run();
    },
  };
}

// ---------- configuración ----------

/** @param {object} env */
export function backupRateLimit(env) {
  const v = Number(env && env.BACKUP_RATE_LIMIT);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : BACKUP_RATE_LIMIT_DEFAULT;
}

// ---------- respuesta HTTP ----------

function json(payload, status, extra = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

function wwwAuth(status) {
  if (status === 401) return { 'WWW-Authenticate': 'Bearer' };
  if (status === 402) return { 'X-License-Expired': '1' };
  return {};
}

/**
 * PUT / GET / DELETE /api/backup. Autenticado por licencia; guarda solo el sobre cifrado.
 * @param {Request} request
 * @param {object} env
 * @param {{nowMs?: number, nowSec?: number, pubkeySpki?: string, fetchFn?: typeof fetch}} [deps]
 */
export async function handleBackupRequest(request, env, deps = {}) {
  const nowMs = deps.nowMs ?? Date.now();
  const nowSec = deps.nowSec ?? Math.floor(nowMs / 1000);
  const method = request.method;

  if (method !== 'PUT' && method !== 'GET' && method !== 'DELETE') {
    return json({ error: 'method_not_allowed' }, 405, { Allow: 'PUT, GET, DELETE' });
  }

  // 0. Sin binding de D1 no hay dónde guardar el respaldo: falla cerrado (503).
  if (!env || !env.DB || typeof env.DB.prepare !== 'function') {
    return json({ error: 'storage_unavailable' }, 503);
  }

  // 1. Autorización por licencia (o token de desarrollo si BACKUP_DEV_OPEN=true en un host local).
  const auth = await authorizeBackup(request, env, { ...deps, nowMs, nowSec });
  if (!auth.ok) return json({ error: auth.error }, auth.status, wwwAuth(auth.status));

  // 2. Límite por cuenta para proteger el cupo de escrituras de D1 (100k/día gratis).
  //    Reclamo atómico en una sola sentencia; si la base falla, falla cerrado (503).
  const budget = await claimBackupRateLimit(env, auth.sub, nowMs, { limit: backupRateLimit(env), windowMs: BACKUP_RATE_WINDOW_MS });
  if (budget === null) return json({ error: 'rate_limit_unavailable' }, 503);
  if (!budget.allowed) {
    return json({ error: 'rate_limited', retryAfterS: budget.retryAfterS }, 429, {
      'Retry-After': String(budget.retryAfterS),
    });
  }

  const store = backupStore(env);

  // 3a. GET: devuelve el sobre cifrado (nunca el texto en claro; el cliente lo descifra).
  if (method === 'GET') {
    const row = await store.get(auth.sub);
    if (!row) return json({ error: 'no_backup' }, 404);
    let envelope;
    try {
      envelope = JSON.parse(row.envelope);
    } catch {
      return json({ error: 'corrupt_backup' }, 500);
    }
    return json({ sub: auth.sub, dev: auth.dev, updated_at: row.updated_at, size: row.size, envelope }, 200);
  }

  // 3b. DELETE: borra el respaldo de la cuenta.
  if (method === 'DELETE') {
    await store.del(auth.sub);
    return json({ sub: auth.sub, dev: auth.dev, deleted: true }, 200);
  }

  // 3c. PUT: valida el sobre y lo guarda exactamente como viene.
  //     El tope se mira ANTES de bufferizar el cuerpo (Content-Length), no después.
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BACKUP_BYTES) {
    return json({ error: 'too_large', max_bytes: MAX_BACKUP_BYTES }, 413);
  }
  const bodyText = await request.text();
  if (new TextEncoder().encode(bodyText).length > MAX_BACKUP_BYTES) {
    return json({ error: 'too_large', max_bytes: MAX_BACKUP_BYTES }, 413);
  }
  let raw;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const parsed = parseEnvelope(raw);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  const envelope = envelopeJson(parsed.value); // serialización canónica: solo 6 campos
  const size = measureEnvelopeBytes(parsed.value);
  if (size > MAX_BACKUP_BYTES) {
    return json({ error: 'too_large', max_bytes: MAX_BACKUP_BYTES }, 413);
  }
  await store.put(auth.sub, envelope, size, nowSec);
  return json({ sub: auth.sub, dev: auth.dev, size, updated_at: nowSec }, 200);
}
