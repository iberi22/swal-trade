/**
 * Cloudflare Worker for SynapseTrader Public Dashboard (trade.swal.network)
 * Contract: synapse.public.snapshot/v1
 */

import { handleExplainRequest } from './explain.js';
import { handleNewsRequest, ingestNews } from './news.js';
import { handleBackupRequest } from './backup.js';

/**
 * Server-side privacy sanitizer.
 * Rebuilds the snapshot retaining ONLY contract-whitelisted fields.
 * Strips secrets, unknown keys at all levels, caps arrays, and enforces privacy rules.
 *
 * @param {unknown} raw - Unsanitized incoming snapshot object.
 * @returns {object} Strictly sanitized snapshot conforming to synapse.public.snapshot/v1.
 */
export function sanitizeSnapshot(raw, env = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid snapshot: expected JSON object');
  }

  if (raw.schema !== 'synapse.public.snapshot/v1') {
    throw new Error(`Invalid schema: expected "synapse.public.snapshot/v1", got "${raw.schema}"`);
  }

  if (!raw.generated_at || typeof raw.generated_at !== 'string' || isNaN(Date.parse(raw.generated_at))) {
    throw new Error('Invalid or unparseable generated_at timestamp');
  }

  const mode = (typeof raw.mode === 'string' && ['paper', 'testnet', 'live'].includes(raw.mode))
    ? raw.mode
    : 'paper';

  // Engine whitelist
  const rawEngine = (raw.engine && typeof raw.engine === 'object' && !Array.isArray(raw.engine)) ? raw.engine : {};
  const engine = {
    status: typeof rawEngine.status === 'string' ? rawEngine.status : 'degraded',
    feed_ok: Boolean(rawEngine.feed_ok),
    last_price_update_at: (typeof rawEngine.last_price_update_at === 'string' && !isNaN(Date.parse(rawEngine.last_price_update_at)))
      ? rawEngine.last_price_update_at
      : null,
    uptime_s: typeof rawEngine.uptime_s === 'number' && Number.isFinite(rawEngine.uptime_s)
      ? rawEngine.uptime_s
      : null,
    strategies_registered: typeof rawEngine.strategies_registered === 'number' && Number.isFinite(rawEngine.strategies_registered)
      ? rawEngine.strategies_registered
      : null
  };

  // Account whitelist - force initial_capital = null if mode !== "paper"
  const rawAccount = (raw.account && typeof raw.account === 'object' && !Array.isArray(raw.account)) ? raw.account : {};
  const initialCapital = (mode === 'paper' && typeof rawAccount.initial_capital === 'number' && Number.isFinite(rawAccount.initial_capital))
    ? rawAccount.initial_capital
    : null;

  const account = {
    initial_capital: initialCapital,
    equity_pct: typeof rawAccount.equity_pct === 'number' && Number.isFinite(rawAccount.equity_pct)
      ? rawAccount.equity_pct
      : null,
    daily_pnl_pct: typeof rawAccount.daily_pnl_pct === 'number' && Number.isFinite(rawAccount.daily_pnl_pct)
      ? rawAccount.daily_pnl_pct
      : null,
    max_drawdown_pct: typeof rawAccount.max_drawdown_pct === 'number' && Number.isFinite(rawAccount.max_drawdown_pct)
      ? rawAccount.max_drawdown_pct
      : null,
    open_positions: null, // Will be updated after filtering
    total_trades: typeof rawAccount.total_trades === 'number' && Number.isFinite(rawAccount.total_trades)
      ? rawAccount.total_trades
      : null,
    win_rate: typeof rawAccount.win_rate === 'number' && Number.isFinite(rawAccount.win_rate)
      ? rawAccount.win_rate
      : null
  };

  const points_formula = typeof raw.points_formula === 'string'
    ? raw.points_formula
    : '1 punto = 1 pb (0,01 %) de rendimiento neto acumulado del bot tras comisiones y funding';

  // Bots array (capped at 100)
  const rawBots = Array.isArray(raw.bots) ? raw.bots : [];
  const bots = rawBots.slice(0, 100).map((b) => {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
    return {
      id: String(b.id || ''),
      name: String(b.name || b.id || ''),
      status: typeof b.status === 'string' ? b.status : 'disabled',
      allocation_pct: typeof b.allocation_pct === 'number' && Number.isFinite(b.allocation_pct)
        ? b.allocation_pct
        : null,
      fidelity: typeof b.fidelity === 'string' ? b.fidelity : null,
      points: typeof b.points === 'number' && Number.isFinite(b.points)
        ? Math.round(b.points)
        : 0,
      trades: typeof b.trades === 'number' && Number.isFinite(b.trades)
        ? b.trades
        : 0,
      wins: typeof b.wins === 'number' && Number.isFinite(b.wins)
        ? b.wins
        : 0,
      win_rate: typeof b.win_rate === 'number' && Number.isFinite(b.win_rate)
        ? b.win_rate
        : null,
      profit_factor: typeof b.profit_factor === 'number' && Number.isFinite(b.profit_factor)
        ? b.profit_factor
        : null,
      pnl_pct: typeof b.pnl_pct === 'number' && Number.isFinite(b.pnl_pct)
        ? b.pnl_pct
        : null,
      last_trade_at: (typeof b.last_trade_at === 'string' && !isNaN(Date.parse(b.last_trade_at)))
        ? b.last_trade_at
        : null
    };
  }).filter(Boolean);

  // Age filter for open positions
  let minAgeMin = 15;
  if (env && env.PUBLIC_POSITIONS_MIN_AGE_MIN !== undefined) {
    const parsed = Number(env.PUBLIC_POSITIONS_MIN_AGE_MIN);
    if (Number.isFinite(parsed)) {
      minAgeMin = Math.max(0, Math.min(240, parsed));
    }
  }
  const minAgeMs = minAgeMin * 60 * 1000;

  let generatedAtMs = Date.parse(raw.generated_at);
  if (isNaN(generatedAtMs)) generatedAtMs = Date.now();

  // Open positions array (capped at 100)
  const rawPositions = Array.isArray(raw.open_positions) ? raw.open_positions : [];
  const open_positions = rawPositions.slice(0, 100).map((p) => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;

    const openedAtStr = typeof p.opened_at === 'string' ? p.opened_at : null;
    if (!openedAtStr) return null;

    const openedAtMs = Date.parse(openedAtStr);
    if (isNaN(openedAtMs)) return null;

    if (generatedAtMs - openedAtMs < minAgeMs) return null;

    return {
      bot: String(p.bot || ''),
      symbol: String(p.symbol || ''),
      side: String(p.side || ''),
      entry_price: typeof p.entry_price === 'number' && Number.isFinite(p.entry_price)
        ? p.entry_price
        : null,
      upnl_pct: typeof p.upnl_pct === 'number' && Number.isFinite(p.upnl_pct)
        ? p.upnl_pct
        : null,
      opened_at: openedAtStr
    };
  }).filter(Boolean);

  account.open_positions = typeof rawAccount.open_positions === 'number' && Number.isFinite(rawAccount.open_positions)
    ? open_positions.length
    : null;

  // Recent trades array (capped at 50)
  const rawTrades = Array.isArray(raw.recent_trades) ? raw.recent_trades : [];
  const recent_trades = rawTrades.slice(0, 50).map((t) => {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
    return {
      bot: String(t.bot || ''),
      symbol: String(t.symbol || ''),
      side: String(t.side || ''),
      entry_price: typeof t.entry_price === 'number' && Number.isFinite(t.entry_price)
        ? t.entry_price
        : null,
      exit_price: typeof t.exit_price === 'number' && Number.isFinite(t.exit_price)
        ? t.exit_price
        : null,
      pnl_pct: typeof t.pnl_pct === 'number' && Number.isFinite(t.pnl_pct)
        ? t.pnl_pct
        : null,
      exit_reason: typeof t.exit_reason === 'string' ? t.exit_reason : null,
      opened_at: (typeof t.opened_at === 'string' && !isNaN(Date.parse(t.opened_at)))
        ? t.opened_at
        : null,
      closed_at: (typeof t.closed_at === 'string' && !isNaN(Date.parse(t.closed_at)))
        ? t.closed_at
        : null
    };
  }).filter(Boolean);

  // Equity curve array (capped at 500)
  const rawCurve = Array.isArray(raw.equity_curve) ? raw.equity_curve : [];
  const equity_curve = rawCurve.slice(0, 500).map((pt) => {
    if (!pt || typeof pt !== 'object' || Array.isArray(pt)) return null;
    const t = (typeof pt.t === 'string' && !isNaN(Date.parse(pt.t))) ? pt.t : null;
    if (!t) return null;
    return {
      t,
      equity_pct: typeof pt.equity_pct === 'number' && Number.isFinite(pt.equity_pct)
        ? pt.equity_pct
        : null
    };
  }).filter(Boolean);

  return {
    schema: 'synapse.public.snapshot/v1',
    generated_at: new Date(raw.generated_at).toISOString(),
    mode,
    engine,
    account,
    points_formula,
    bots,
    open_positions,
    recent_trades,
    equity_curve
  };
}

/**
 * Valida de forma estricta un payload de hit-rates.
 * @param {any} body
 * @returns {{ok: boolean, value?: any, error?: string}}
 */
export function validateHitRates(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Expected JSON object' };
  }
  if (body.schema !== 'swal.hit-rates.v1') {
    return { ok: false, error: 'Invalid schema' };
  }
  if (body.method !== 'forward') {
    return { ok: false, error: 'Invalid method' };
  }

  const strRegex = /^[A-Za-z0-9_ .:-]+$/;
  function checkStr(s, maxLen) {
    if (typeof s !== 'string') return false;
    if (s.length > maxLen) return false;
    return strRegex.test(s);
  }

  const res = {
    schema: 'swal.hit-rates.v1',
    method: 'forward',
  };

  if (body.period && typeof body.period === 'object' && !Array.isArray(body.period)) {
    if (!checkStr(body.period.from, 64) || !checkStr(body.period.to, 64)) {
       return { ok: false, error: 'Invalid period fields' };
    }
    res.period = { from: body.period.from, to: body.period.to };
  } else {
    return { ok: false, error: 'Invalid period' };
  }

  if (!checkStr(body.market, 64)) {
    return { ok: false, error: 'Invalid market' };
  }
  res.market = body.market;

  if (typeof body.cost_round_trip !== 'number' || !Number.isFinite(body.cost_round_trip)) {
    return { ok: false, error: 'Invalid cost_round_trip' };
  }
  res.cost_round_trip = body.cost_round_trip;

  if (!Array.isArray(body.cells)) {
    return { ok: false, error: 'cells must be an array' };
  }
  if (body.cells.length > 200) {
    return { ok: false, error: 'cells array too large' };
  }

  const allowedKeys = new Set(['kind', 'tf', 'symbol', 'direction', 'n', 'wins_1r', 'rate_1r', 'ci_low', 'ci_high', 'breakeven', 'baseline_rate', 'mean_net_r', 'grade']);
  res.cells = [];

  for (const cell of body.cells) {
    if (!cell || typeof cell !== 'object' || Array.isArray(cell)) {
      return { ok: false, error: 'Invalid cell' };
    }

    const keys = Object.keys(cell);
    if (keys.length !== allowedKeys.size) {
      return { ok: false, error: 'Invalid cell keys' };
    }
    for (const key of keys) {
      if (!allowedKeys.has(key)) {
        return { ok: false, error: 'Invalid cell keys' };
      }
    }

    if (!checkStr(cell.kind, 64) || !checkStr(cell.tf, 64) || !checkStr(cell.symbol, 64)) {
      return { ok: false, error: 'Invalid cell string fields' };
    }

    if (cell.direction !== 'long' && cell.direction !== 'short') {
      return { ok: false, error: 'Invalid direction' };
    }

    const n = cell.n;
    const w = cell.wins_1r;
    if (typeof n !== 'number' || typeof w !== 'number' || !Number.isInteger(n) || !Number.isInteger(w) || w < 0 || n < w) {
      return { ok: false, error: 'Invalid n or wins_1r' };
    }

    const r = cell.rate_1r;
    const l = cell.ci_low;
    const h = cell.ci_high;
    const b = cell.breakeven;
    if (typeof r !== 'number' || typeof l !== 'number' || typeof h !== 'number' || typeof b !== 'number' ||
        !Number.isFinite(r) || !Number.isFinite(l) || !Number.isFinite(h) || !Number.isFinite(b)) {
      return { ok: false, error: 'Invalid rates (not finite numbers)' };
    }

    if (r < 0 || r > 1 || l < 0 || l > 1 || h < 0 || h > 1 || b < 0 || b > 1) {
      return { ok: false, error: 'Invalid rates (out of bounds)' };
    }

    if (l > r || r > h) {
      return { ok: false, error: 'Invalid confidence interval' };
    }

    const br = cell.baseline_rate;
    if (br !== null && (typeof br !== 'number' || !Number.isFinite(br) || br < 0 || br > 1)) {
       return { ok: false, error: 'Invalid baseline_rate' };
    }

    const m = cell.mean_net_r;
    if (typeof m !== 'number' || !Number.isFinite(m)) {
       return { ok: false, error: 'Invalid mean_net_r' };
    }

    if (!['no_evidence', 'promising', 'validated', 'negative'].includes(cell.grade)) {
      return { ok: false, error: 'Invalid grade' };
    }

    res.cells.push({
      kind: cell.kind,
      tf: cell.tf,
      symbol: cell.symbol,
      direction: cell.direction,
      n: n,
      wins_1r: w,
      rate_1r: r,
      ci_low: l,
      ci_high: h,
      breakeven: b,
      baseline_rate: br,
      mean_net_r: m,
      grade: cell.grade
    });
  }

  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string' || body.note.length > 300) {
      return { ok: false, error: 'Invalid note' };
    }
    res.note = body.note;
  }

  return { ok: true, value: res };
}

/**
 * Constant-time comparison between two strings via SHA-256 digests.
 *
 * @param {string} a
 * @param {string} b
 * @returns {Promise<boolean>}
 */
async function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const encoder = new TextEncoder();
  const aBuf = await crypto.subtle.digest('SHA-256', encoder.encode(a));
  const bBuf = await crypto.subtle.digest('SHA-256', encoder.encode(b));
  const aArr = new Uint8Array(aBuf);
  const bArr = new Uint8Array(bBuf);
  if (aArr.length !== bArr.length) return false;
  let diff = 0;
  for (let i = 0; i < aArr.length; i++) {
    diff |= aArr[i] ^ bArr[i];
  }
  return diff === 0;
}

/**
 * Injects required security headers to any outgoing Response.
 *
 * @param {Response} response
 * @returns {Response}
 */
const CSP_BASE =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/**
 * CSP por ruta: solo /checkout/ habla con el cobrador y solo /guardian/ con Binance (lectura),
 * Telegram y el cobrador (clave pública de licencias). El resto del sitio, connect-src 'self'.
 *
 * @param {string} pathname
 * @returns {string}
 */
export function cspFor(pathname = '/') {
  let connect = "'self'";
  if (pathname.startsWith('/checkout/')) {
    connect = "'self' https://pay.swal.network";
  } else if (pathname.startsWith('/guardian/')) {
    connect =
      "'self' https://fapi.binance.com https://api.binance.com https://api.telegram.org https://pay.swal.network";
  } else if (pathname.startsWith('/analisis/')) {
    // Datos publicos de mercado (REST + WebSocket) y fear & greed; sin claves ni cobrador.
    connect = "'self' https://fapi.binance.com wss://fstream.binance.com https://api.alternative.me";
  } else if (pathname.startsWith('/backup/')) {
    // Respaldo E2EE: solo habla con el cobrador (clave publica de licencias), igual que /checkout/.
    connect = "'self' https://pay.swal.network";
  }
  return `${CSP_BASE}; connect-src ${connect}`;
}

function withSecurityHeaders(response, pathname = '/') {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', cspFor(pathname));
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');

  // PWA: el service worker se revisa en cada carga y puede controlar todo el origen; el
  // manifiesto lleva su Content-Type correcto. No dependen de la heuristica de assets.
  // (La CSP no necesita tocarse: worker-src y manifest-src caen a default-src 'self'.)
  if (pathname === '/sw.js') {
    headers.set('Cache-Control', 'no-cache');
    headers.set('Service-Worker-Allowed', '/');
  } else if (pathname === '/manifest.webmanifest') {
    headers.set('Content-Type', 'application/manifest+json');
    headers.set('Cache-Control', 'public, max-age=3600');
  }

  const body = (response.status === 204 || response.status === 304) ? null : response.body;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

/**
 * Almacenamiento del snapshot. D1 si existe el binding `DB` (100.000 escrituras/día en el plan
 * gratuito); KV (`SNAPSHOTS`) como respaldo. KV gratuito solo permite 1.000 escrituras/día para
 * TODA la cuenta, y el publicador escribe cada minuto (1.440/día): por eso D1 es el principal.
 *
 * @param {object} env
 * @returns {{get: (key: string) => Promise<string|null>, put: (key: string, value: string, ttlSeconds?: number) => Promise<void>}|null}
 */
export function snapshotStore(env) {
  if (env && env.DB && typeof env.DB.prepare === 'function') {
    const db = env.DB;
    return {
      async get(key) {
        const row = await db
          .prepare('SELECT value FROM snapshots WHERE key = ?1 AND (expires_at IS NULL OR expires_at > ?2)')
          .bind(key, Math.floor(Date.now() / 1000))
          .first();
        return row ? row.value : null;
      },
      async put(key, value, ttlSeconds) {
        const now = Math.floor(Date.now() / 1000);
        await db
          .prepare(
            'INSERT INTO snapshots (key, value, updated_at, expires_at) VALUES (?1, ?2, ?3, ?4) ' +
              'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, expires_at = excluded.expires_at'
          )
          .bind(key, value, now, ttlSeconds ? now + ttlSeconds : null)
          .run();
      },
    };
  }
  if (env && env.SNAPSHOTS) {
    const kv = env.SNAPSHOTS;
    return {
      get: (key) => kv.get(key),
      put: (key, value, ttlSeconds) => kv.put(key, value, ttlSeconds ? { expirationTtl: ttlSeconds } : undefined),
    };
  }
  return null;
}


const DEADMAN_KEY = 'deadman:state';
const DEFAULT_STALE_AFTER_S = 300;

/**
 * Pure dead-man decision. Alerts once when the snapshot goes stale and once when it recovers.
 *
 * @param {number|null} ageS - Seconds since last snapshot (null/NaN = no snapshot at all).
 * @param {string|null} prevState - 'ok' | 'stale' | null (never evaluated; treated as 'ok').
 * @param {number} staleAfterS
 * @returns {{state: 'ok'|'stale', alert: 'stale'|'recovered'|null}}
 */
export function decideDeadman(ageS, prevState, staleAfterS = DEFAULT_STALE_AFTER_S) {
  const stale = typeof ageS !== 'number' || !Number.isFinite(ageS) || ageS > staleAfterS;
  const prev = prevState === 'stale' ? 'stale' : 'ok';
  if (stale) return { state: 'stale', alert: prev === 'ok' ? 'stale' : null };
  return { state: 'ok', alert: prev === 'stale' ? 'recovered' : null };
}

/**
 * Cron handler: checks snapshot freshness in D1/KV and notifies via Telegram (plain text).
 * Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID. Optional var: STALE_AFTER_S.
 *
 * @param {object} env
 * @param {number} [nowMs]
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{state: string, alert: string|null, sent: boolean}|null>}
 */
export async function checkDeadman(env, nowMs = Date.now(), fetchImpl = fetch) {
  const store = snapshotStore(env);
  if (!store) return null;
  const parsedStale = Number(env.STALE_AFTER_S);
  const staleAfterS = Number.isFinite(parsedStale) && parsedStale > 0 ? parsedStale : DEFAULT_STALE_AFTER_S;

  let ageS = null;
  try {
    const latest = await store.get('latest');
    const gen = latest ? new Date(JSON.parse(latest).generated_at).getTime() : NaN;
    if (!isNaN(gen)) ageS = Math.max(0, Math.floor((nowMs - gen) / 1000));
  } catch (_) {}

  const prev = await store.get(DEADMAN_KEY);
  const { state, alert } = decideDeadman(ageS, prev, staleAfterS);
  if (!alert) {
    if (state !== prev) await store.put(DEADMAN_KEY, state);
    return { state, alert: null, sent: false };
  }

  const text = alert === 'stale'
    ? `SYNAPSE SIN SNAPSHOT: ${ageS === null ? 'no hay snapshot' : `ultimo hace ${Math.round(ageS / 60)} min`} (umbral ${Math.round(staleAfterS / 60)} min). El bot o el host pueden estar caidos.`
    : 'SYNAPSE recuperado: vuelven a llegar snapshots.';

  if (!(await sendTelegram(env, text, fetchImpl, 'deadman'))) return { state, alert, sent: false };
  await store.put(DEADMAN_KEY, state);
  return { state, alert, sent: true };
}

/**
 * Envía un aviso de texto plano (sin parse_mode) al chat del dueño. Nunca lanza.
 *
 * @param {object} env - TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
 * @param {string} text
 * @param {typeof fetch} fetchImpl
 * @param {string} tag - Prefijo de los logs.
 * @returns {Promise<boolean>} true si Telegram lo aceptó.
 */
async function sendTelegram(env, text, fetchImpl, tag) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.warn(`${tag}: faltan TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID`);
    return false;
  }
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text })
    });
    if (!res.ok) throw new Error(`telegram http ${res.status}`);
    return true;
  } catch (err) {
    console.warn(`${tag}: telegram fallo`, err && err.message);
    return false;
  }
}

// Latidos de los servicios locales del dueño (guardián, radar). Cada uno hace
// POST /heartbeat/<nombre> con Authorization: Bearer HEARTBEAT_TOKEN tras cada ciclo sano.
// El token va en la cabecera, no en la URL: los logs de Workers guardan la URL.
const DEFAULT_HEARTBEAT_NAMES = 'guardian,radar';
const DEFAULT_HEARTBEAT_STALE_S = 600;
const HEARTBEAT_MIN_WRITE_S = 60;
const HEARTBEAT_LABELS = { guardian: 'GUARDIAN', radar: 'RADAR' };

/**
 * Nombres admitidos (var HEARTBEAT_NAMES, separados por comas). Evita que el dueño del token
 * cree filas arbitrarias en D1.
 *
 * @param {object} env
 * @returns {Set<string>}
 */
export function heartbeatNames(env) {
  const raw = env && typeof env.HEARTBEAT_NAMES === 'string' ? env.HEARTBEAT_NAMES : DEFAULT_HEARTBEAT_NAMES;
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z0-9-]{1,32}$/.test(s)));
}

/**
 * POST /heartbeat/<nombre>: registra el latido en D1 (tabla heartbeats, migración 0005).
 * Escribe como mucho una vez cada 60 s por nombre; el estado ok/stale lo lleva el cron.
 *
 * @param {Request} request
 * @param {object} env - HEARTBEAT_TOKEN (secret), DB, HEARTBEAT_NAMES.
 * @param {string} name
 * @param {number} [nowMs]
 * @returns {Promise<Response>}
 */
export async function handleHeartbeatRequest(request, env, name, nowMs = Date.now()) {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { 'Allow': 'POST' } });
  }
  const authHeader = request.headers.get('Authorization') || '';
  const expectedToken = env && env.HEARTBEAT_TOKEN ? String(env.HEARTBEAT_TOKEN) : '';
  if (!expectedToken || !authHeader.startsWith('Bearer ')
      || !(await timingSafeEqualString(authHeader.slice(7), expectedToken))) {
    return new Response(null, { status: 401 });
  }
  if (!heartbeatNames(env).has(name)) {
    return new Response(null, { status: 404 });
  }
  if (!env.DB || typeof env.DB.prepare !== 'function') {
    return new Response(null, { status: 503 });
  }
  const now = Math.floor(nowMs / 1000);
  await env.DB
    .prepare(
      "INSERT INTO heartbeats (name, last_seen, state) VALUES (?1, ?2, 'ok') " +
        'ON CONFLICT(name) DO UPDATE SET last_seen = excluded.last_seen ' +
        'WHERE heartbeats.last_seen <= excluded.last_seen - ?3'
    )
    .bind(name, now, HEARTBEAT_MIN_WRITE_S)
    .run();
  return new Response(null, { status: 204 });
}

/**
 * Cron: avisa por Telegram (texto plano) una vez cuando un servicio deja de latir y otra cuando
 * vuelve. Solo vigila nombres que ya latieron alguna vez (no avisa antes de configurarlos).
 *
 * @param {object} env - DB, HEARTBEAT_STALE_S, HEARTBEAT_NAMES, TELEGRAM_*.
 * @param {number} [nowMs]
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Array<{name: string, state: string, alert: string|null, sent: boolean}>|null>}
 */
export async function checkHeartbeats(env, nowMs = Date.now(), fetchImpl = fetch) {
  if (!env || !env.DB || typeof env.DB.prepare !== 'function') return null;
  const parsedStale = Number(env.HEARTBEAT_STALE_S);
  const staleAfterS = Number.isFinite(parsedStale) && parsedStale > 0 ? parsedStale : DEFAULT_HEARTBEAT_STALE_S;
  const names = heartbeatNames(env);
  const now = Math.floor(nowMs / 1000);

  const { results = [] } = await env.DB.prepare('SELECT name, last_seen, state FROM heartbeats').all();
  const out = [];
  for (const row of results) {
    if (!row || !names.has(row.name)) continue;
    const ageS = Math.max(0, now - Number(row.last_seen));
    const { state, alert } = decideDeadman(ageS, row.state, staleAfterS);
    let sent = false;
    if (alert) {
      const label = HEARTBEAT_LABELS[row.name] || row.name.toUpperCase();
      const text = alert === 'stale'
        ? `${label} SIN LATIDO: ultimo hace ${Math.round(ageS / 60)} min (umbral ${Math.round(staleAfterS / 60)} min). El servicio, la red o el PC pueden estar caidos.`
        : `${label} recuperado: vuelve a latir.`;
      sent = await sendTelegram(env, text, fetchImpl, 'heartbeat');
      // Si Telegram falla, el estado no cambia y el siguiente tick reintenta el aviso.
      if (!sent) {
        out.push({ name: row.name, state, alert, sent });
        continue;
      }
    }
    if (state !== row.state) {
      await env.DB.prepare('UPDATE heartbeats SET state = ?1 WHERE name = ?2').bind(state, row.name).run();
    }
    out.push({ name: row.name, state, alert, sent });
  }
  return out;
}

export default {

  /**
   * Cron Trigger handler (dead-man switch for snapshot ingestion).
   *
   * @param {object} event
   * @param {object} env
   * @param {object} ctx
   */
  async scheduled(event, env, ctx) {
    // Dead-man en cada tick (5 min). Noticias como máximo cada 30 min (ingestNews).
    const run = Promise.all([
      checkDeadman(env).catch((err) => {
        console.warn('deadman: cron fallo', err && err.message);
        return null;
      }),
      checkHeartbeats(env).catch((err) => {
        console.warn('heartbeat: cron fallo', err && err.message);
        return null;
      }),
      ingestNews(env).catch((err) => {
        console.warn('news: cron fallo', err && err.message);
        return null;
      }),
    ]);
    ctx.waitUntil(run);
  },

  /**
   * Cloudflare Worker fetch handler.
   *
   * @param {Request} request
   * @param {object} env
   * @param {object} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. GET /public/v1/snapshot -> Read latest snapshot from KV
    if (url.pathname === '/public/v1/snapshot') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return withSecurityHeaders(new Response(null, {
          status: 405,
          headers: { 'Allow': 'GET, HEAD' }
        }));
      }

      const store = snapshotStore(env);
      if (!store) {
        return withSecurityHeaders(new Response(JSON.stringify({ error: 'no_snapshot' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        }));
      }

      const snapshotData = await store.get('latest');
      if (!snapshotData) {
        return withSecurityHeaders(new Response(JSON.stringify({ error: 'no_snapshot' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        }));
      }

      let ageSeconds = 0;
      try {
        const parsed = JSON.parse(snapshotData);
        if (parsed && parsed.generated_at) {
          const genTime = new Date(parsed.generated_at).getTime();
          if (!isNaN(genTime)) {
            ageSeconds = Math.max(0, Math.floor((Date.now() - genTime) / 1000));
          }
        }
      } catch (_) {}

      return withSecurityHeaders(new Response(snapshotData, {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=30',
          'X-Snapshot-Age-S': String(ageSeconds)
        }
      }));
    }

    // 2. /ingest endpoint
    if (url.pathname === '/ingest') {
      if (request.method !== 'POST') {
        return withSecurityHeaders(new Response(null, {
          status: 405,
          headers: { 'Allow': 'POST' }
        }));
      }

      // Authorization check (constant-time token comparison)
      const authHeader = request.headers.get('Authorization') || '';
      const expectedToken = (env && env.PUBLIC_INGEST_TOKEN) ? String(env.PUBLIC_INGEST_TOKEN) : '';

      if (!expectedToken || !authHeader.startsWith('Bearer ')) {
        return withSecurityHeaders(new Response(null, { status: 401 }));
      }

      const providedToken = authHeader.slice(7);
      const isTokenValid = await timingSafeEqualString(providedToken, expectedToken);
      if (!isTokenValid) {
        return withSecurityHeaders(new Response(null, { status: 401 }));
      }

      // Payload size check (> 512 KB rejected with 413)
      const MAX_BODY_BYTES = 512 * 1024;
      const contentLength = request.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
        return withSecurityHeaders(new Response(null, { status: 413 }));
      }

      const bodyText = await request.text();
      const bodyBytes = new TextEncoder().encode(bodyText).length;
      if (bodyBytes > MAX_BODY_BYTES) {
        return withSecurityHeaders(new Response(null, { status: 413 }));
      }

      // Parse JSON
      let rawJson;
      try {
        rawJson = JSON.parse(bodyText);
      } catch (_) {
        return withSecurityHeaders(new Response(JSON.stringify({ error: 'invalid_json' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }));
      }

      // Sanitize snapshot
      let sanitized;
      try {
        sanitized = sanitizeSnapshot(rawJson, env);
      } catch (err) {
        return withSecurityHeaders(new Response(JSON.stringify({ error: err.message || 'invalid_snapshot' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }));
      }

      const sanitizedJson = JSON.stringify(sanitized);

      // Store latest
      const store = snapshotStore(env);
      if (store) {
        await store.put('latest', sanitizedJson);

        // Daily history snapshot: history:<YYYY-MM-DD> (first snapshot of the day, 90-day TTL)
        const dateStr = sanitized.generated_at.slice(0, 10);
        const historyKey = `history:${dateStr}`;
        const existingHistory = await store.get(historyKey);
        if (!existingHistory) {
          await store.put(historyKey, sanitizedJson, 90 * 86400);
        }
      }

      return withSecurityHeaders(new Response(null, { status: 204 }));
    }

    // POST /ingest/hit-rates endpoint
    if (url.pathname === '/ingest/hit-rates') {
      if (request.method !== 'POST') {
        return withSecurityHeaders(new Response(null, {
          status: 405,
          headers: { 'Allow': 'POST' }
        }));
      }

      // Authorization check (constant-time token comparison)
      const authHeader = request.headers.get('Authorization') || '';
      const expectedToken = (env && env.PUBLIC_INGEST_TOKEN) ? String(env.PUBLIC_INGEST_TOKEN) : '';

      if (!expectedToken || !authHeader.startsWith('Bearer ')) {
        return withSecurityHeaders(new Response(null, { status: 401 }));
      }

      const providedToken = authHeader.slice(7);
      const isTokenValid = await timingSafeEqualString(providedToken, expectedToken);
      if (!isTokenValid) {
        return withSecurityHeaders(new Response(null, { status: 401 }));
      }

      // Payload size check (> 64 KB rejected with 413)
      const MAX_BODY_BYTES = 64 * 1024;
      const contentLength = request.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
        return withSecurityHeaders(new Response(null, { status: 413 }));
      }

      const bodyText = await request.text();
      const bodyBytes = new TextEncoder().encode(bodyText).length;
      if (bodyBytes > MAX_BODY_BYTES) {
        return withSecurityHeaders(new Response(null, { status: 413 }));
      }

      // Parse JSON
      let rawJson;
      try {
        rawJson = JSON.parse(bodyText);
      } catch (_) {
        return withSecurityHeaders(new Response(JSON.stringify({ error: 'invalid_json' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }));
      }

      const validation = validateHitRates(rawJson);
      if (!validation.ok) {
        return withSecurityHeaders(new Response(JSON.stringify({ error: validation.error }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }));
      }

      validation.value.generated_at = new Date().toISOString();

      const store = snapshotStore(env);
      if (store) {
        await store.put('hit-rates', JSON.stringify(validation.value));
      }

      return withSecurityHeaders(new Response(null, { status: 204 }));
    }

    // GET /api/hit-rates endpoint
    if (url.pathname === '/api/hit-rates') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return withSecurityHeaders(new Response(null, {
          status: 405,
          headers: { 'Allow': 'GET, HEAD' }
        }));
      }

      const store = snapshotStore(env);
      let hitRatesData = null;
      if (store) {
        try {
          hitRatesData = await store.get('hit-rates');
        } catch (_) {
          // Una lectura fallida (D1 sin migrar, KV caido) no rompe la pagina: tabla vacia.
          hitRatesData = null;
        }
      }

      if (!hitRatesData) {
        hitRatesData = JSON.stringify({
          schema: "swal.hit-rates.v1",
          cells: [],
          note: "Aun no hay datos publicados."
        });
      }

      return withSecurityHeaders(new Response(hitRatesData, {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=300'
        }
      }));
    }

    // 3. GET /api/news?symbol=BTC|ETH&limit=20 — misma origen, sin secretos.
    if (url.pathname === '/api/news') {
      return withSecurityHeaders(await handleNewsRequest(request, env));
    }

    // 4. POST /api/explain — explicador IA (Workers AI) con respaldo determinista.
    if (url.pathname === '/api/explain') {
      return withSecurityHeaders(await handleExplainRequest(request, env));
    }

    // 5. PUT/GET/DELETE /api/backup — respaldo E2EE autenticado por licencia.
    if (url.pathname === '/api/backup') {
      return withSecurityHeaders(await handleBackupRequest(request, env), url.pathname);
    }

    // 6. POST /heartbeat/<nombre> — latido del guardián o del radar locales (dead-man por servicio).
    const hb = /^\/heartbeat\/([a-z0-9-]{1,32})$/.exec(url.pathname);
    if (hb) {
      return withSecurityHeaders(await handleHeartbeatRequest(request, env, hb[1]), url.pathname);
    }

    // 7. Static assets fallback
    if (env && env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      const assetResponse = await env.ASSETS.fetch(request);
      return withSecurityHeaders(assetResponse, url.pathname);
    }

    return withSecurityHeaders(new Response('Not Found', { status: 404 }));
  }
};
