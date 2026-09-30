/**
 * Cloudflare Worker for SynapseTrader Public Dashboard (trade.swal.network)
 * Contract: synapse.public.snapshot/v1
 */

/**
 * Server-side privacy sanitizer.
 * Rebuilds the snapshot retaining ONLY contract-whitelisted fields.
 * Strips secrets, unknown keys at all levels, caps arrays, and enforces privacy rules.
 *
 * @param {unknown} raw - Unsanitized incoming snapshot object.
 * @returns {object} Strictly sanitized snapshot conforming to synapse.public.snapshot/v1.
 */
export function sanitizeSnapshot(raw) {
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
    open_positions: typeof rawAccount.open_positions === 'number' && Number.isFinite(rawAccount.open_positions)
      ? rawAccount.open_positions
      : null,
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
      research_verdict: typeof b.research_verdict === 'string' ? b.research_verdict : null,
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

  // Open positions array (capped at 100)
  const rawPositions = Array.isArray(raw.open_positions) ? raw.open_positions : [];
  const open_positions = rawPositions.slice(0, 100).map((p) => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
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
      opened_at: (typeof p.opened_at === 'string' && !isNaN(Date.parse(p.opened_at)))
        ? p.opened_at
        : null
    };
  }).filter(Boolean);

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
function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
  );
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');

  const body = (response.status === 204 || response.status === 304) ? null : response.body;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export default {
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

      if (!env || !env.SNAPSHOTS) {
        return withSecurityHeaders(new Response(JSON.stringify({ error: 'no_snapshot' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        }));
      }

      const snapshotData = await env.SNAPSHOTS.get('latest');
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
        sanitized = sanitizeSnapshot(rawJson);
      } catch (err) {
        return withSecurityHeaders(new Response(JSON.stringify({ error: err.message || 'invalid_snapshot' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }));
      }

      const sanitizedJson = JSON.stringify(sanitized);

      // Store latest
      if (env && env.SNAPSHOTS) {
        await env.SNAPSHOTS.put('latest', sanitizedJson);

        // Daily history snapshot: history:<YYYY-MM-DD> (first snapshot of the day, 90-day TTL)
        const dateStr = sanitized.generated_at.slice(0, 10);
        const historyKey = `history:${dateStr}`;
        const existingHistory = await env.SNAPSHOTS.get(historyKey);
        if (!existingHistory) {
          await env.SNAPSHOTS.put(historyKey, sanitizedJson, {
            expirationTtl: 90 * 86400
          });
        }
      }

      return withSecurityHeaders(new Response(null, { status: 204 }));
    }

    // 3. Static assets fallback
    if (env && env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      const assetResponse = await env.ASSETS.fetch(request);
      return withSecurityHeaders(assetResponse);
    }

    return withSecurityHeaders(new Response('Not Found', { status: 404 }));
  }
};
