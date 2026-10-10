// SPDX-License-Identifier: AGPL-3.0-only
//
// Núcleo E2EE del "respaldo cifrado de extremo a extremo" de SWAL (Socio SWAL).
// Puro (sin DOM, sin red) y basado solo en WebCrypto. Lo importan la web /backup/ y,
// más adelante, la extensión. Con los tests: node --test workers/public-site/test.
//
// Contrato de datos (docs/SWAL/GOAL.md): el cifrado ocurre ANTES de llegar al backend y
// el operador no conserva la clave ni partes suficientes para reconstruir el texto. Por eso
// la clave se deriva en el cliente (PBKDF2) y NUNCA sale del navegador: ni la frase, ni la
// clave derivada, ni el texto en claro viajan a /api/backup. Solo viaja el `sobre`.

/** Versión del formato de sobre. Un cliente futuro que no la entienda, rechaza el sobre. */
export const BACKUP_ENVELOPE_VERSION = 1;
/** KDF: PBKDF2-HMAC-SHA256. Iteraciones por defecto (>= 600.000, "o mejor si hay"). */
export const KDF_ITERATIONS = 600000;
/** Mínimo aceptado al cifrar: por debajo de esto se usa KDF_ITERATIONS. */
export const MIN_KDF_ITERATIONS = 600000;
/** Sal aleatoria: 16 bytes (128 bits). IV de AES-GCM: 12 bytes (96 bits, el recomendado). */
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
/** Tope de tamaño del sobre serializado: 256 KB. Lo aplica también el worker. */
export const MAX_BACKUP_BYTES = 256 * 1024;

// ---------- base64 (estándar) que funciona igual en navegador y Node ----------

/** Uint8Array -> base64 estándar (para salt, iv y ct del sobre). */
export function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** base64 estándar -> Uint8Array. Acepta también base64url (guiones/barras bajas). */
export function base64ToBytes(b64) {
  const norm = String(b64).trim().replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Bytes aleatorios criptográficos (sal e IV). */
export function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

// ---------- lista de exclusión de claves de exchanges / secretos ----------

// Nombres exactos (en minúsculas) que NUNCA deben entrar en un respaldo.
const DENIED_NAMES = new Set([
  'api_key', 'apikey', 'api_secret', 'apisecret', 'secret', 'secret_key',
  'hmac', 'hmac_key', 'private_key', 'privatekey', 'mnemonic', 'seed', 'seed_phrase',
  'passphrase', 'password', 'x-mbx-apikey', 'signature',
]);
// Subcadenas que delatan una clave de exchange o un secreto (Binance: apiKey/secret/hmac/X-MBX).
const DENIED_MARKERS = ['apikey', 'api_secret', 'apisecret', 'hmac', 'mbx', 'privatekey', 'mnemonic', 'seedphrase', 'bottoken_secret'];

/** true si el nombre de una propiedad debe excluirse por parecer una clave o secreto. */
export function isDeniedKey(key) {
  const k = String(key).toLowerCase();
  if (DENIED_NAMES.has(k)) return true;
  return DENIED_MARKERS.some((m) => k.includes(m));
}

/**
 * Elimina de forma recursiva toda propiedad cuyo nombre esté en la lista de exclusión.
 * Defensa en profundidad: aunque el armador solo copie campos permitidos, cualquier clave
 * de Binance que se cuele en los ajustes o en el diario se descarta antes de cifrar.
 * @param {unknown} value
 * @returns {unknown}
 */
export function scrubDenied(value) {
  if (Array.isArray(value)) return value.map(scrubDenied);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isDeniedKey(k)) continue;
      out[k] = scrubDenied(v);
    }
    return out;
  }
  return value;
}

// ---------- armado del contenido a respaldar ----------

/**
 * Construye el objeto que se va a cifrar. Solo se copian los campos permitidos:
 *  - guardian.cfg: límites del guardián (limit, warn, maxNotional, maxLev, tz).
 *  - guardian.telegram: chat id (NO el token del bot salvo opt-in explícito del usuario).
 *  - analysis: ajustes de análisis/extensión (objeto libre ya saneado).
 *  - journal: diario local (array de notas).
 * Las claves de Binance (apiKey, secret, hmac…) NUNCA se incluyen: no se copian y, además,
 * scrubDenied barre el resultado. El token del bot se guarda bajo `botToken` solo con opt-in.
 * @param {{guardian?: object, analysis?: object, journal?: unknown[], includeBotToken?: boolean, now?: () => Date}} input
 */
export function buildBackupData(input = {}) {
  const { guardian = {}, analysis = {}, journal = [], includeBotToken = false, now = () => new Date() } = input;

  const cfg = guardian && guardian.cfg && typeof guardian.cfg === 'object' ? { ...guardian.cfg } : null;
  const tg = (guardian && guardian.telegram && typeof guardian.telegram === 'object') ? guardian.telegram : {};

  const telegram = { chat: tg.chat ?? null };
  if (includeBotToken && tg.token) telegram.botToken = tg.token;

  const data = {
    v: BACKUP_ENVELOPE_VERSION,
    created_at: now().toISOString(),
    guardian: { cfg, telegram },
    analysis: analysis && typeof analysis === 'object' ? analysis : {},
    journal: Array.isArray(journal) ? journal : [],
  };
  return scrubDenied(data);
}

// ---------- derivación de clave y cifrado AES-256-GCM ----------

/**
 * Deriva una clave AES-256-GCM desde la frase del usuario con PBKDF2-SHA256.
 * La clave resultante es NO extraíble: no puede exportarse ni enviarse a ningún sitio.
 * @param {string} passphrase
 * @param {Uint8Array} salt
 * @param {number} [iterations]
 * @param {SubtleCrypto} [subtle]
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKey(passphrase, salt, iterations = KDF_ITERATIONS, subtle = crypto.subtle) {
  const iter = Math.max(MIN_KDF_ITERATIONS, Math.floor(iterations));
  const baseKey = await subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false, // no extraíble
    ['encrypt', 'decrypt'],
  );
}

/**
 * Cifra un objeto (o texto) y devuelve el sobre versionado {v, kdf, iter, salt, iv, ct},
 * todo en base64 salvo v e iter. Sal e IV son aleatorios y nuevos en cada llamada.
 * @param {unknown} plaintext
 * @param {string} passphrase
 * @param {{iterations?: number, salt?: Uint8Array, iv?: Uint8Array, subtle?: SubtleCrypto}} [opts]
 */
export async function encryptBackup(plaintext, passphrase, opts = {}) {
  const subtle = opts.subtle ?? crypto.subtle;
  const iterations = Math.max(MIN_KDF_ITERATIONS, Math.floor(opts.iterations ?? KDF_ITERATIONS));
  const salt = opts.salt ?? randomBytes(SALT_BYTES);
  const iv = opts.iv ?? randomBytes(IV_BYTES);
  const key = await deriveKey(passphrase, salt, iterations, subtle);
  const data = typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext);
  const ctBuf = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(data));
  return {
    v: BACKUP_ENVELOPE_VERSION,
    kdf: 'PBKDF2-SHA256',
    iter: iterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ctBuf)),
  };
}

/**
 * Descifra un sobre comprobando su integridad. La etiqueta de AES-GCM detecta tanto la
 * frase incorrecta como datos alterados: en ambos casos subtle.decrypt lanza y aquí se
 * convierte en un error legible. Devuelve el objeto (o el texto) original.
 * @param {object} envelope
 * @param {string} passphrase
 * @param {{subtle?: SubtleCrypto}} [opts]
 */
export async function decryptBackup(envelope, passphrase, opts = {}) {
  const subtle = opts.subtle ?? crypto.subtle;
  if (!envelope || typeof envelope !== 'object') throw new Error('sobre inválido');
  if (envelope.v !== BACKUP_ENVELOPE_VERSION) {
    throw new Error(`versión de sobre no soportada: ${String(envelope.v)}`);
  }
  if (envelope.kdf !== 'PBKDF2-SHA256') {
    throw new Error(`kdf no soportado: ${String(envelope.kdf)}`);
  }
  const iterations = Number(envelope.iter);
  if (!Number.isFinite(iterations) || iterations < 1) throw new Error('iteraciones inválidas');
  const salt = base64ToBytes(envelope.salt);
  const iv = base64ToBytes(envelope.iv);
  const ct = base64ToBytes(envelope.ct);
  if (iv.length !== IV_BYTES) throw new Error('IV inválido');
  if (ct.length < 16) throw new Error('texto cifrado inválido (falta la etiqueta GCM)');

  const key = await deriveKey(passphrase, salt, iterations, subtle);
  let ptBuf;
  try {
    ptBuf = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  } catch {
    throw new Error('no se pudo descifrar: frase incorrecta o datos alterados');
  }
  const text = new TextDecoder().decode(ptBuf);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------- serialización y medida del sobre (la aplica también el worker) ----------

/** Serialización canónica del sobre: solo las 6 claves del contrato, en orden fijo. */
export function envelopeJson(envelope) {
  return JSON.stringify({
    v: envelope.v,
    kdf: envelope.kdf,
    iter: envelope.iter,
    salt: envelope.salt,
    iv: envelope.iv,
    ct: envelope.ct,
  });
}

/** Bytes que ocupa el sobre serializado (para el tope de tamaño del servidor). */
export function measureEnvelopeBytes(envelope) {
  return new TextEncoder().encode(envelopeJson(envelope)).length;
}

/**
 * Valida la forma de un sobre sin descifrarlo (lo usa el worker antes de guardar, y el
 * cliente al restaurar). No toca la clave ni el texto: solo estructura y tamaños.
 * @param {unknown} envelope
 * @returns {{ok: true, value: object}|{ok: false, error: string}}
 */
export function parseEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return { ok: false, error: 'envelope_invalid' };
  const v = envelope.v;
  if (v !== BACKUP_ENVELOPE_VERSION) return { ok: false, error: 'envelope_version' };
  if (envelope.kdf !== 'PBKDF2-SHA256') return { ok: false, error: 'envelope_kdf' };
  const iter = Number(envelope.iter);
  if (!Number.isInteger(iter) || iter < 1) return { ok: false, error: 'envelope_iter' };
  for (const field of ['salt', 'iv', 'ct']) {
    if (typeof envelope[field] !== 'string' || !envelope[field]) return { ok: false, error: `envelope_${field}` };
  }
  let ivLen;
  let ctLen;
  try {
    ivLen = base64ToBytes(envelope.iv).length;
    ctLen = base64ToBytes(envelope.ct).length;
  } catch {
    return { ok: false, error: 'envelope_b64' };
  }
  if (ivLen !== IV_BYTES) return { ok: false, error: 'envelope_iv_length' };
  if (ctLen < 16) return { ok: false, error: 'envelope_ct_length' };
  return { ok: true, value: { v, kdf: envelope.kdf, iter, salt: envelope.salt, iv: envelope.iv, ct: envelope.ct } };
}

// ---------- pista de fuerza de la frase (UI) ----------

/**
 * Pista cualitativa de fuerza de la frase (0 = muy débil … 4 = fuerte). No mide entropía
 * real; solo empuja a frases largas y variadas. Devuelve {score, label, hint}.
 * @param {string} passphrase
 */
export function passphraseStrength(passphrase) {
  const p = typeof passphrase === 'string' ? passphrase : '';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(p)).length;
  let score = 0;
  if (p.length >= 8) score += 1;
  if (p.length >= 12) score += 1;
  if (p.length >= 16) score += 1;
  if (classes >= 3) score += 1;
  if (p.length < 8) score = Math.min(score, 1);
  const labels = ['muy débil', 'débil', 'aceptable', 'buena', 'fuerte'];
  const hints = [
    'Demasiado corta: usa al menos 12 caracteres.',
    'Añade longitud y distinto tipo de caracteres.',
    'Vale, pero una frase más larga aguanta mejor.',
    'Buena. Cuanto más larga, mejor.',
    'Fuerte. Aun así, guárdala bien.',
  ];
  return { score, label: labels[score], hint: hints[score] };
}
