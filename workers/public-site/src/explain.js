/**
 * Explicador IA: POST /api/explain.
 *
 * Convierte el análisis determinista de analysis-core (que calcula el cliente) en una
 * explicación corta y prudente en español, usando Workers AI. No añade señales, no da
 * órdenes y no promete nada: el límite abierto/privado (docs/OPEN_VS_PRIVATE.md, regla 3)
 * prohíbe cualquier texto público que prometa rentabilidad.
 *
 * Contrato de entrada (JSON): {symbol, timeframe, analysis:{top, trend, levels}}
 *   - symbol: 2-30 letras o dígitos (se normaliza a mayúsculas).
 *   - timeframe: 1m | 5m | 15m | 1h | 4h | 1d.
 *   - analysis.top: como máximo EXPLAIN_MAX_FINDINGS hallazgos (más → 400 too_many_findings).
 *   - analysis.trend: {direction, strength, label}.
 *   - analysis.levels: como máximo EXPLAIN_MAX_LEVELS niveles.
 * Contrato de salida: {source, model, symbol, timeframe, asOf, summary, scenarios[], caution, ...}
 *
 * Abusos: límite por IP (10/hora en ventana móvil), caché de 5 minutos para peticiones
 * idénticas, tope de tokens de salida y cupo diario global (EXPLAIN_DAILY_CAP, 500 por
 * defecto). Cuando algo falla o el cupo se agota, la respuesta la construyen reglas fijas
 * (respaldo determinista) y `source` es "fallback": el endpoint nunca devuelve error por
 * estar sin IA.
 */

import {
  buildExplainUserPrompt,
  DEFAULT_CAUTION,
  DEFAULT_RISK_NOTE,
  EXPLAIN_DISCLAIMER,
  EXPLAIN_JSON_SCHEMA,
  EXPLAIN_SYSTEM_PROMPT,
  FALLBACK_NOTE,
  findForbiddenPhrase,
  levelsOf,
} from './explain-prompt.js';
import { newsStore } from './news.js';

/** Temporalidades que acepta el núcleo de análisis (workers/.../analysis-core.js TOOL_SPEC). */
export const EXPLAIN_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];
/** Más de 20 hallazgos se rechaza: el cuerpo es del cliente y no puede inflarse. */
export const EXPLAIN_MAX_FINDINGS = 20;
/** Topes de tamaño: nadie necesita más para explicar 5 patrones. */
export const EXPLAIN_MAX_LEVELS = 200;
export const EXPLAIN_MAX_LEVELS_PER_FINDING = 8;
export const EXPLAIN_MAX_SCENARIOS = 5;
export const EXPLAIN_MAX_BODY_BYTES = 24 * 1024;
export const EXPLAIN_MAX_PAYLOAD_CHARS = 24000;
/** Límite por IP: 10 peticiones por hora en ventana móvil. */
export const EXPLAIN_RATE_LIMIT = 10;
export const EXPLAIN_RATE_WINDOW_MS = 60 * 60 * 1000;
/** Caché de respuestas idénticas. */
export const EXPLAIN_CACHE_MS = 5 * 60 * 1000;
/** Cupo diario global de llamadas al modelo. */
export const EXPLAIN_DAILY_CAP_DEFAULT = 500;
/** Modelo por defecto: instruct rápido y con JSON Mode en el catálogo actual de Workers AI. */
export const EXPLAIN_MODEL_DEFAULT = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const EXPLAIN_MAX_TOKENS_DEFAULT = 480;
export const EXPLAIN_TEMPERATURE = 0.2;
export const EXPLAIN_CACHE_CONTROL = 'no-store';

const KV_KEY_PREFIX = 'explain:';
const memoryStores = new WeakMap();

// ---------- validación y normalización ----------

const isObj = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const cleanString = (value, max) => {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
};

const cleanNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const cleanDirection = (value) => (value === 'up' || value === 'down' ? value : 'neutral');

/** Nivel ya saneado: solo precios y rol. La evidencia cruda se queda fuera. */
function cleanLevel(raw) {
  if (!isObj(raw)) return null;
  const level = {
    role: cleanString(raw.role, 40),
    price: cleanNumber(raw.price),
    low: cleanNumber(raw.low),
    high: cleanNumber(raw.high),
    confirm: cleanNumber(raw.confirm),
    invalidate: cleanNumber(raw.invalidate),
  };
  if (Number.isFinite(cleanNumber(raw.time))) level.time = cleanNumber(raw.time);
  return level;
}

/** Hallazgo ya saneado, con los campos que el prompt necesita. */
export function cleanFinding(raw) {
  if (!isObj(raw)) return null;
  const levels = (Array.isArray(raw.levels) ? raw.levels : [])
    .slice(0, EXPLAIN_MAX_LEVELS_PER_FINDING)
    .map(cleanLevel)
    .filter(Boolean);
  const finding = {
    id: cleanString(raw.id, 64),
    kind: cleanString(raw.kind, 40),
    label: cleanString(raw.label || raw.kind, 120),
    direction: cleanDirection(raw.direction),
    strength: Math.max(0, Math.min(1, cleanNumber(raw.strength) ?? 0)),
    status: raw.status === 'confirmed' ? 'confirmed' : 'forming',
    explanation: cleanString(raw.explanation, 400),
    levels,
  };
  if (Number.isFinite(cleanNumber(raw.from))) finding.from = cleanNumber(raw.from);
  if (Number.isFinite(cleanNumber(raw.to))) finding.to = cleanNumber(raw.to);
  return finding;
}

/** Símbolo → activo de noticias (el store solo guarda BTC y ETH). */
export function explainSymbolAsset(symbol) {
  const upper = String(symbol || '').toUpperCase();
  if (upper.startsWith('BTC')) return 'BTC';
  if (upper.startsWith('ETH')) return 'ETH';
  return null;
}

/**
 * Valida el cuerpo y devuelve el análisis ya saneado y topado.
 * @param {unknown} raw
 * @returns {{ok: true, value: {symbol: string, timeframe: string, analysis: object}}|{ok: false, error: string}}
 */
export function parseExplainBody(raw) {
  if (!isObj(raw)) return { ok: false, error: 'body_invalid' };
  if (typeof raw.symbol !== 'string' || raw.symbol.trim().length > 30) return { ok: false, error: 'symbol_invalid' };
  const symbol = cleanString(raw.symbol, 30).toUpperCase();
  if (!/^[A-Z0-9]{2,30}$/.test(symbol)) return { ok: false, error: 'symbol_invalid' };
  if (typeof raw.timeframe !== 'string' || raw.timeframe.trim().length > 8) return { ok: false, error: 'timeframe_invalid' };
  const timeframe = cleanString(raw.timeframe, 8);
  if (!EXPLAIN_TIMEFRAMES.includes(timeframe)) return { ok: false, error: 'timeframe_invalid' };
  const analysis = raw.analysis;
  if (!isObj(analysis)) return { ok: false, error: 'analysis_invalid' };

  const rawTop = analysis.top;
  if (rawTop !== undefined && rawTop !== null) {
    if (!Array.isArray(rawTop)) return { ok: false, error: 'top_invalid' };
    if (rawTop.length > EXPLAIN_MAX_FINDINGS) return { ok: false, error: 'too_many_findings' };
  }
  const rawLevels = analysis.levels;
  if (rawLevels !== undefined && rawLevels !== null) {
    if (!Array.isArray(rawLevels)) return { ok: false, error: 'levels_invalid' };
    if (rawLevels.length > EXPLAIN_MAX_LEVELS) return { ok: false, error: 'too_many_levels' };
  }

  const top = (Array.isArray(rawTop) ? rawTop : []).map(cleanFinding).filter(Boolean).slice(0, EXPLAIN_MAX_FINDINGS);
  const levels = (Array.isArray(rawLevels) ? rawLevels : []).map(cleanLevel).filter(Boolean).slice(0, EXPLAIN_MAX_LEVELS);
  const rawTrend = analysis.trend;
  const trend = isObj(rawTrend)
    ? {
      direction: cleanDirection(rawTrend.direction),
      strength: Math.max(0, Math.min(1, cleanNumber(rawTrend.strength) ?? 0)),
      label: cleanString(rawTrend.label, 80),
    }
    : null;

  const clean = { symbol, timeframe, analysis: { top, trend, levels } };
  if (JSON.stringify(clean).length > EXPLAIN_MAX_PAYLOAD_CHARS) return { ok: false, error: 'analysis_too_large' };
  return { ok: true, value: clean };
}

// ---------- respaldo determinista ----------

const pct = (strength) => Math.round((Number(strength) || 0) * 100);
const dirWord = (direction) => (direction === 'up' ? 'alcista' : direction === 'down' ? 'bajista' : 'neutral');

/** true si los hallazgos principales señalan en direcciones opuestas. */
export function directionsConflict(top) {
  const ups = top.filter((f) => f.direction === 'up').length;
  const downs = top.filter((f) => f.direction === 'down').length;
  return ups > 0 && downs > 0;
}

/**
 * Explicación construida con reglas fijas, sin modelo. Es la respuesta cuando no hay
 * binding de IA, cuando el JSON del modelo no se puede reparar, cuando el modelo rompe
 * una regla del prompt o cuando se agota el cupo diario.
 * @param {{symbol: string, timeframe: string, analysis: object, reason?: string}} input
 */
export function buildFallbackExplain({ symbol, timeframe, analysis, reason = 'fallback' } = {}) {
  const top = (analysis && Array.isArray(analysis.top) ? analysis.top : []).slice(0, EXPLAIN_MAX_SCENARIOS);
  const conflict = directionsConflict(top);
  let summary;
  if (!top.length) {
    summary = `En ${symbol} (${timeframe}) el análisis determinista no ve patrones claros en esta ventana. Sin patrón no hay escenario que explicar: lo coherente es esperar a que el gráfico muestre algo con niveles definidos.`;
  } else {
    const first = top[0];
    summary =
      `En ${symbol} (${timeframe}) el análisis determinista ve ${top.length} patrón(es). El de mayor fuerza del patrón es ` +
      `${first.label || first.kind} (fuerza ${pct(first.strength)}/100, dirección ${dirWord(first.direction)}). ` +
      (conflict
        ? 'Los patrones no señalan todos en la misma dirección: cuando se contradicen, lo prudente es esperar y no forzar una lectura. '
        : '');
  }
  const scenarios = top.map((finding) => {
    const levels = levelsOf(finding);
    const above = finding.direction === 'down' ? 'por debajo de' : 'por encima de';
    const below = finding.direction === 'down' ? 'por encima de' : 'por debajo de';
    return {
      name: finding.label || finding.kind || 'Patrón',
      condition: levels
        ? `Se confirma si el precio cierra ${above} ${levels.confirm} y se mantiene ahí.`
        : 'El análisis no da un nivel numérico para este hallazgo: se confirmaría solo si el precio mantiene el comportamiento descrito.',
      invalidation: levels
        ? `Deja de valer si el precio cierra ${below} ${levels.invalidate}.`
        : 'Deja de valer si el comportamiento descrito desaparece en las siguientes velas.',
      risk_note: `${DEFAULT_RISK_NOTE} El stop va detrás del nivel de invalidación (${levels ? levels.invalidate : 'sin nivel definido'}) y el tamaño se calcula desde ese stop, no al revés.`,
    };
  });
  return {
    summary,
    scenarios,
    caution: `${DEFAULT_CAUTION} Sin medición histórica publicada no hay porcentaje de acierto que mostrar.`,
    note: FALLBACK_NOTE,
    reason,
  };
}

// ---------- lectura y reparación del JSON del modelo ----------

/**
 * Cierra comillas y corchetes de un JSON truncado y quita comas colgantes.
 * @param {string} text
 * @returns {string}
 */
export function balanceJson(text) {
  let out = String(text).trim();
  // Coma colgante antes de } o ].
  out = out.replace(/,(\s*[}\]])/g, '$1');
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const char of out) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') stack.pop();
  }
  if (inString) out += '"';
  while (stack.length) out += stack.pop() === '{' ? '}' : ']';
  return out;
}

/**
 * Extrae y repara el JSON de una respuesta de modelo. Acepta texto envuelto en vallas
 * markdown, objetos envueltos en {response: ...} y JSON truncado por max_tokens.
 * @param {unknown} raw
 * @returns {{ok: true, value: object}|{ok: false, error: string}}
 */
/** Intenta parsear un texto como objeto JSON, arreglando lo arreglable. */
function parseLoose(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) candidates.push(fenced[1]);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  if (first >= 0) candidates.push(text.slice(first));
  candidates.push(text);
  for (const candidate of candidates) {
    for (const variant of [candidate, balanceJson(candidate)]) {
      let parsed;
      try {
        parsed = JSON.parse(variant);
      } catch {
        continue;
      }
      // Doble codificación: "{\"summary\"...}" dentro de un string.
      for (let depth = 0; depth < 2 && typeof parsed === 'string'; depth += 1) {
        try {
          parsed = JSON.parse(parsed);
        } catch {
          break;
        }
      }
      if (isObj(parsed)) return parsed;
    }
  }
  return null;
}

/**
 * Extrae y repara el JSON de una respuesta de modelo. Acepta texto envuelto en vallas
 * markdown, objetos envueltos en {response: ...} / {result: ...} y JSON truncado por
 * max_tokens. Devuelve el objeto ya desempaquetado.
 * @param {unknown} raw
 * @returns {{ok: true, value: object}|{ok: false, error: string}}
 */
export function repairExplainJson(raw) {
  let parsed = typeof raw === 'string' ? parseLoose(raw) : isObj(raw) ? raw : null;
  if (parsed === null) return { ok: false, error: 'invalid_json' };

  // Envoltorios: {response: <objeto|texto>} o {result: <objeto|texto>}, hasta dos niveles.
  for (let depth = 0; depth < 2; depth += 1) {
    if (!isObj(parsed)) break;
    if (!('response' in parsed) && !('result' in parsed)) break;
    const innerRaw = 'response' in parsed ? parsed.response : parsed.result;
    const inner = typeof innerRaw === 'string' ? parseLoose(innerRaw) : isObj(innerRaw) ? innerRaw : null;
    if (!inner) break;
    parsed = inner;
  }

  if (!isObj(parsed)) return { ok: false, error: 'invalid_json' };
  if (!('summary' in parsed) && !('scenarios' in parsed)) return { ok: false, error: 'invalid_json' };
  return { ok: true, value: parsed };
}

/**
 * Valida y repara el payload del modelo al contrato público. Devuelve
 * {ok:true, value, repaired:boolean} o {ok:false, error} para tirar de respaldo.
 * @param {unknown} value
 */
export function coerceExplainPayload(value) {
  if (!isObj(value)) return { ok: false, error: 'not_object' };
  let repaired = false;

  let summary = cleanString(value.summary, 600);
  if (!summary) return { ok: false, error: 'summary_missing' };
  if (summary !== value.summary) repaired = true;

  const rawScenarios = Array.isArray(value.scenarios) ? value.scenarios : null;
  if (!rawScenarios) return { ok: false, error: 'scenarios_missing' };
  if (rawScenarios.length > EXPLAIN_MAX_SCENARIOS) repaired = true;
  const scenarios = [];
  for (const raw of rawScenarios.slice(0, EXPLAIN_MAX_SCENARIOS)) {
    if (!isObj(raw)) {
      repaired = true;
      continue;
    }
    const name = cleanString(raw.name, 120);
    if (!name) {
      repaired = true;
      continue;
    }
    const condition = cleanString(raw.condition, 400);
    const invalidation = cleanString(raw.invalidation, 400);
    const riskNote = cleanString(raw.risk_note ?? raw.riskNote, 400);
    if (!condition || !invalidation || !riskNote) repaired = true;
    scenarios.push({
      name,
      condition: condition || 'El análisis no fija una condición concreta para este patrón.',
      invalidation: invalidation || 'Sin nivel de invalidación definido: se descarta si el patrón deja de verse en el gráfico.',
      risk_note: riskNote || DEFAULT_RISK_NOTE,
    });
  }
  if (!scenarios.length) return { ok: false, error: 'scenarios_empty' };

  let caution = cleanString(value.caution, 300);
  if (!caution) {
    caution = DEFAULT_CAUTION;
    repaired = true;
  }

  const payload = { summary, scenarios, caution };

  for (const field of [summary, ...scenarios.flatMap((s) => [s.name, s.condition, s.invalidation, s.risk_note]), caution]) {
    const hit = findForbiddenPhrase(field);
    if (hit) {
      console.warn(`explain: frase prohibida descartada (${hit})`);
      return { ok: false, error: 'forbidden_phrase' };
    }
  }
  return { ok: true, value: payload, repaired };
}

// ---------- almacenamiento: límites, cupo y caché ----------

const D1_GET = 'SELECT value FROM explain_kv WHERE key = ?1 AND (expires_at IS NULL OR expires_at > ?2)';
const D1_PUT =
  'INSERT INTO explain_kv (key, value, expires_at) VALUES (?1, ?2, ?3) ' +
  'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at';

const sec = (ms) => Math.floor(ms / 1000);

function d1ExplainStore(db) {
  return {
    kind: 'd1',
    async get(key, nowMs) {
      const row = await db.prepare(D1_GET).bind(key, sec(nowMs || Date.now())).first();
      return row && typeof row.value === 'string' ? row.value : null;
    },
    async put(key, value, ttlMs, nowMs = Date.now()) {
      await db.prepare(D1_PUT).bind(key, value, ttlMs ? sec(nowMs) + Math.ceil(ttlMs / 1000) : null).run();
    },
  };
}

function kvExplainStore(kv) {
  return {
    kind: 'kv',
    async get(key) {
      return (await kv.get(KV_KEY_PREFIX + key)) ?? null;
    },
    async put(key, value, ttlMs) {
      // KV no acepta reloj inyectado: la caducidad es aproximada (documentado).
      await kv.put(KV_KEY_PREFIX + key, value, ttlMs ? { expirationTtl: Math.ceil(ttlMs / 1000) } : undefined);
    },
  };
}

/**
 * Store de límites y caché. D1 si existe el binding `DB` (100.000 escrituras/día gratis);
 * KV `SNAPSHOTS` como respaldo (1.000 escrituras/día para TODA la cuenta, así que en KV
 * el límite es aproximado); memoria del isolate como último recurso (desarrollo y pruebas).
 * La memoria vive en un WeakMap por objeto `env`, para no filtrar estado entre pruebas.
 * @param {object} env
 */
export function explainStore(env) {
  if (env && env.DB && typeof env.DB.prepare === 'function') return d1ExplainStore(env.DB);
  if (env && env.SNAPSHOTS && typeof env.SNAPSHOTS.get === 'function') return kvExplainStore(env.SNAPSHOTS);
  let memory = memoryStores.get(env);
  if (!memory) {
    memory = {
      kind: 'memory',
      rows: new Map(),
      async get(key, nowMs = Date.now()) {
        const row = memory.rows.get(key);
        if (!row) return null;
        if (row.expiresAt !== null && row.expiresAt <= nowMs) {
          memory.rows.delete(key);
          return null;
        }
        return row.value;
      },
      async put(key, value, ttlMs, nowMs = Date.now()) {
        memory.rows.set(key, { value, expiresAt: ttlMs ? nowMs + ttlMs : null });
      },
    };
    memoryStores.set(env, memory);
  }
  return memory;
}

/**
 * Límite por IP en ventana móvil: 10 peticiones por hora.
 * @param {object|null} store
 * @param {string} ipKey - hash de la IP, nunca la IP en claro
 * @param {number} nowMs
 */
export async function checkIpBudget(store, ipKey, nowMs, limit = EXPLAIN_RATE_LIMIT, windowMs = EXPLAIN_RATE_WINDOW_MS) {
  if (!store) return { allowed: true, count: 0, remaining: limit, retryAfterS: 0 };
  const key = `ip:${ipKey}`;
  let stamps = [];
  try {
    const parsed = JSON.parse((await store.get(key, nowMs)) || '[]');
    if (Array.isArray(parsed)) stamps = parsed.filter((t) => Number.isFinite(t) && nowMs - t < windowMs);
  } catch {
    stamps = [];
  }
  if (stamps.length >= limit) {
    await store.put(key, JSON.stringify(stamps), windowMs * 2, nowMs);
    const oldest = Math.min(...stamps);
    return { allowed: false, count: stamps.length, remaining: 0, retryAfterS: Math.max(1, Math.ceil((windowMs - (nowMs - oldest)) / 1000)) };
  }
  stamps.push(nowMs);
  await store.put(key, JSON.stringify(stamps), windowMs * 2, nowMs);
  return { allowed: true, count: stamps.length, remaining: Math.max(0, limit - stamps.length), retryAfterS: 0 };
}

/** Cupo diario global: cuenta intentos de llamada al modelo. */
export async function bumpDailyBudget(store, nowMs, cap) {
  if (!store) return { used: 0, cap, exceeded: cap <= 0 };
  const key = `day:${new Date(nowMs).toISOString().slice(0, 10)}`;
  const used = (Number(await store.get(key, nowMs)) || 0) + 1;
  await store.put(key, String(used), 48 * 60 * 60 * 1000, nowMs);
  return { used, cap, exceeded: used > cap };
}

async function readCache(store, key, nowMs) {
  if (!store) return null;
  try {
    const raw = await store.get(key, nowMs);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCache(store, key, payload, nowMs, ttlMs = EXPLAIN_CACHE_MS) {
  if (!store) return;
  try {
    await store.put(key, JSON.stringify(payload), ttlMs, nowMs);
  } catch (err) {
    console.warn('explain: caché fallo', err && err.message);
  }
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Clave de caché: solo lo que cambia la respuesta (símbolo, temporalidad y análisis). */
export async function explainCacheKey({ symbol, timeframe, analysis }) {
  const basis = JSON.stringify({
    symbol,
    timeframe,
    top: (analysis && analysis.top) || [],
    trend: (analysis && analysis.trend) || null,
  });
  return `cache:${await sha256Hex(basis)}`;
}

// ---------- noticias ----------

/**
 * Titulares del store para el activo del símbolo (BTC/ETH). Fallo de lectura = cero
 * titulares: el explicador no depende de las noticias para funcionar.
 * @param {object} env
 * @param {string} symbol
 * @param {number} nowMs
 * @param {number} limit
 */
export async function headlinesFor(env, symbol, nowMs, limit = 3) {
  const asset = explainSymbolAsset(symbol);
  if (!asset) return [];
  const store = newsStore(env);
  if (!store) return [];
  try {
    const items = await store.list(asset, limit, nowMs);
    return (Array.isArray(items) ? items : []).slice(0, limit).map((item) => ({
      title: cleanString(item.title, 160),
      source: cleanString(item.source, 60),
      publishedAt: cleanString(item.publishedAt, 40),
      sentiment: { label: cleanString(item.sentiment && item.sentiment.label, 20) },
    })).filter((item) => item.title);
  } catch (err) {
    console.warn('explain: titulares fallo', err && err.message);
    return [];
  }
}

// ---------- configuración ----------

/** @param {object} env */
export function explainModel(env) {
  const configured = env && typeof env.EXPLAIN_MODEL === 'string' ? env.EXPLAIN_MODEL.trim() : '';
  return configured || EXPLAIN_MODEL_DEFAULT;
}

/** @param {object} env */
export function explainMaxTokens(env) {
  const value = Number(env && env.EXPLAIN_MAX_TOKENS);
  if (!Number.isFinite(value) || value <= 0) return EXPLAIN_MAX_TOKENS_DEFAULT;
  return Math.min(2000, Math.floor(value));
}

/** @param {object} env */
export function explainDailyCap(env) {
  const value = Number(env && env.EXPLAIN_DAILY_CAP);
  if (!Number.isFinite(value) || value < 0) return EXPLAIN_DAILY_CAP_DEFAULT;
  return Math.floor(value);
}

// ---------- llamada al modelo ----------

/** Texto de la respuesta de Workers AI, que varía por modelo y por modo JSON. */
export function aiText(out) {
  if (typeof out === 'string') return out;
  if (!isObj(out)) return '';
  if (typeof out.response === 'string') return out.response;
  if (typeof out.result === 'string') return out.result;
  if (typeof out.text === 'string') return out.text;
  if (isObj(out.response)) return JSON.stringify(out.response);
  if (isObj(out.result)) return JSON.stringify(out.result);
  return '';
}

/**
 * Una llamada al modelo. `env.AI` es el binding `[ai] binding = "AI"` de wrangler.toml.
 * @param {object} env
 * @param {{symbol: string, timeframe: string, analysis: object, headlines: object[]}} input
 * @returns {Promise<{ok: true, model: string, text: string}|{ok: false, model: string, error: string}>}
 */
export async function runExplainModel(env, input) {
  const model = explainModel(env);
  if (!env || !env.AI || typeof env.AI.run !== 'function') return { ok: false, model, error: 'no_ai_binding' };
  try {
    const out = await env.AI.run(model, {
      messages: [
        { role: 'system', content: EXPLAIN_SYSTEM_PROMPT },
        { role: 'user', content: buildExplainUserPrompt(input) },
      ],
      max_tokens: explainMaxTokens(env),
      temperature: EXPLAIN_TEMPERATURE,
      response_format: { type: 'json_schema', json_schema: EXPLAIN_JSON_SCHEMA },
    });
    const text = aiText(out);
    if (!text.trim()) return { ok: false, model, error: 'empty_response' };
    return { ok: true, model, text };
  } catch (err) {
    console.warn('explain: modelo fallo', err && err.message);
    return { ok: false, model, error: 'ai_error' };
  }
}

// ---------- respuesta HTTP ----------

function jsonResponse(payload, status, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': EXPLAIN_CACHE_CONTROL,
    ...extraHeaders,
  };
  return new Response(JSON.stringify(payload), { status, headers });
}

function clientIpKey(request) {
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '';
  return ip.trim() || 'anonymous';
}

/**
 * POST /api/explain.
 * @param {Request} request
 * @param {object} env
 * @param {{nowMs?: number, ipKey?: string}} [deps]
 */
export async function handleExplainRequest(request, env, deps = {}) {
  const nowMs = deps.nowMs ?? Date.now();
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  }

  let raw;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > EXPLAIN_MAX_BODY_BYTES) {
      return jsonResponse({ error: 'body_too_large' }, 413);
    }
    raw = JSON.parse(text);
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  const parsed = parseExplainBody(raw);
  if (!parsed.ok) {
    return jsonResponse({ error: parsed.error }, 400, { 'X-Explain-Error': parsed.error });
  }
  const { symbol, timeframe, analysis } = parsed.value;
  const store = explainStore(env);

  // 0. Freno de ráfaga con el binding de Rate Limiting de Cloudflare, si está configurado
  // (opcional: wrangler.toml [[ratelimits]] name = "EXPLAIN_RATE_LIMITER"). Su periodo solo
  // puede ser de 10 o 60 segundos, así que complementa al contador por hora, no lo sustituye.
  const limiter = env && env.EXPLAIN_RATE_LIMITER;
  if (limiter && typeof limiter.limit === 'function') {
    const ipRaw = deps.ipKey ?? clientIpKey(request);
    try {
      const outcome = await limiter.limit({ key: ipRaw });
      if (outcome && outcome.success === false) {
        return jsonResponse({ error: 'rate_limited', retryAfterS: 60 }, 429, { 'Retry-After': '60' });
      }
    } catch (err) {
      console.warn('explain: rate limiter fallo', err && err.message);
    }
  }

  // 1. Límite por IP antes de tocar nada más.
  const ipKey = deps.ipKey ?? clientIpKey(request);
  const ipHash = (await sha256Hex(ipKey)).slice(0, 32);
  const budget = await checkIpBudget(store, ipHash, nowMs);
  if (!budget.allowed) {
    return jsonResponse(
      { error: 'rate_limited', retryAfterS: budget.retryAfterS },
      429,
      { 'Retry-After': String(budget.retryAfterS) },
    );
  }

  // 2. Caché de peticiones idénticas (5 min). No gasta cupo ni tokens.
  const cacheKey = await explainCacheKey({ symbol, timeframe, analysis });
  const cached = await readCache(store, cacheKey, nowMs);
  if (cached) {
    return jsonResponse({ ...cached, source: 'cache', origin: cached.source || 'ai' }, 200, { 'X-Explain-Source': 'cache' });
  }

  // 3. Cupo diario global. Sin cupo hay respaldo determinista, no error.
  const cap = explainDailyCap(env);
  const model = explainModel(env);
  const hasAi = Boolean(env && env.AI && typeof env.AI.run === 'function');
  const base = {
    symbol,
    timeframe,
    asOf: new Date(nowMs).toISOString(),
    disclaimer: EXPLAIN_DISCLAIMER,
  };

  // Sin binding de IA no hay intento que contar: el cupo diario solo cuenta llamadas al modelo.
  if (!hasAi) {
    const payload = {
      ...base,
      source: 'fallback',
      model: null,
      reason: 'no_ai_binding',
      newsUsed: 0,
      ...buildFallbackExplain({ symbol, timeframe, analysis, reason: 'no_ai_binding' }),
    };
    await writeCache(store, cacheKey, payload, nowMs);
    return jsonResponse(payload, 200, { 'X-Explain-Source': 'fallback' });
  }

  const day = cap > 0 ? await bumpDailyBudget(store, nowMs, cap) : { used: 0, cap, exceeded: true };
  if (day.exceeded) {
    const payload = {
      ...base,
      source: 'fallback',
      model: null,
      reason: 'daily_cap',
      newsUsed: 0,
      ...buildFallbackExplain({ symbol, timeframe, analysis, reason: 'daily_cap' }),
    };
    await writeCache(store, cacheKey, payload, nowMs);
    return jsonResponse(payload, 200, { 'X-Explain-Source': 'fallback' });
  }

  // 4. Modelo. Si no hay binding, falla o rompe las reglas: respaldo determinista.
  const headlines = await headlinesFor(env, symbol, nowMs);
  const run = await runExplainModel(env, { symbol, timeframe, analysis, headlines });
  if (!run.ok) {
    const payload = {
      ...base,
      source: 'fallback',
      model,
      reason: run.error,
      newsUsed: headlines.length,
      ...buildFallbackExplain({ symbol, timeframe, analysis, reason: run.error }),
    };
    await writeCache(store, cacheKey, payload, nowMs);
    return jsonResponse(payload, 200, { 'X-Explain-Source': 'fallback' });
  }

  const repaired = repairExplainJson(run.text);
  if (!repaired.ok) {
    const payload = {
      ...base,
      source: 'fallback',
      model,
      reason: repaired.error,
      newsUsed: headlines.length,
      ...buildFallbackExplain({ symbol, timeframe, analysis, reason: repaired.error }),
    };
    await writeCache(store, cacheKey, payload, nowMs);
    return jsonResponse(payload, 200, { 'X-Explain-Source': 'fallback' });
  }

  const coerced = coerceExplainPayload(repaired.value);
  if (!coerced.ok) {
    const payload = {
      ...base,
      source: 'fallback',
      model,
      reason: coerced.error,
      newsUsed: headlines.length,
      ...buildFallbackExplain({ symbol, timeframe, analysis, reason: coerced.error }),
    };
    await writeCache(store, cacheKey, payload, nowMs);
    return jsonResponse(payload, 200, { 'X-Explain-Source': 'fallback' });
  }

  const payload = {
    ...base,
    source: 'ai',
    model: run.model,
    reason: null,
    repaired: coerced.repaired,
    newsUsed: headlines.length,
    ...coerced.value,
  };
  await writeCache(store, cacheKey, payload, nowMs);
  return jsonResponse(payload, 200, { 'X-Explain-Source': 'ai' });
}
