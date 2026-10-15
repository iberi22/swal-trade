// market-pulse.js — Pulso de mercado en /analisis/.
// Hechos de solo lectura del libro (muros), liquidaciones en vivo y tendencia multitemporalidad.
// Todo fallo degrada limpiamente a "No disponible ahora." sin romper el resto de la página.

import { depthWalls, liquidationSummary, trendOf } from './analysis-core.js';

export const REST_ORIGIN = 'https://fapi.binance.com';
export const WS_ORIGIN = 'wss://fstream.binance.com/market/ws';
export const DEPTH_LIMIT = 500;
export const DEPTH_REFRESH_MS = 15_000;
export const PULSE_TIMEFRAMES = ['15m', '1h', '4h'];
export const LIQUIDATION_EVENT_CAP = 400;
export const LIQUIDATION_RECONNECT_MS = 5_000;
export const NO_DATA = 'No disponible ahora.';

const SOCKET_OPEN_TIMEOUT_MS = 4_000;
const WS_OPEN = 1;

export function assertSymbol(symbol) {
  const normalized = String(symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,30}$/.test(normalized)) {
    throw new Error('símbolo no válido');
  }
  return normalized;
}

export function quoteAsset(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (s.endsWith('USDC')) return 'USDC';
  return 'USDT';
}

export function depthUrl(symbol, limit = DEPTH_LIMIT) {
  const capped = Math.min(1000, Math.max(5, Math.floor(limit)));
  return `${REST_ORIGIN}/fapi/v1/depth?symbol=${assertSymbol(symbol)}&limit=${capped}`;
}

export function forceOrderUrl(symbol) {
  return `${WS_ORIGIN}/${assertSymbol(symbol).toLowerCase()}@forceOrder`;
}

export function klinesUrl(symbol, timeframe, limit = 200) {
  const safe = assertSymbol(symbol);
  const capped = Math.min(1500, Math.max(1, Math.floor(limit)));
  return `${REST_ORIGIN}/fapi/v1/klines?symbol=${safe}&interval=${encodeURIComponent(timeframe)}&limit=${capped}`;
}

/**
 * Parsea un forceOrder de Binance.
 * S=SELL liquida una posición larga; S=BUY liquida una posición corta.
 * Preferimos ap (precio medio) y z (cantidad ejecutada); usd = precio * cantidad.
 */
export function parseForceOrder(data) {
  let msg;
  try {
    msg = typeof data === 'string' ? JSON.parse(data) : data;
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  const evt = msg.e ?? (msg.data && typeof msg.data === 'object' ? msg.data.e : undefined);
  if (evt !== undefined && evt !== 'forceOrder') return null;
  const body = msg.o && typeof msg.o === 'object'
    ? msg.o
    : msg.data && typeof msg.data === 'object'
      ? (msg.data.o && typeof msg.data.o === 'object' ? msg.data.o : msg.data)
      : null;
  if (!body) return null;
  const symbol = String(body.s ?? '');
  if (!/^[A-Z0-9]{2,30}$/.test(symbol)) return null;
  const side = body.S === 'SELL' ? 'long' : body.S === 'BUY' ? 'short' : null;
  if (!side) return null;
  const price = Number(body.ap ?? body.p);
  const qty = Number(body.z ?? body.q);
  const at = Number(body.T ?? body.E ?? Date.now());
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(at)) {
    return null;
  }
  return { symbol, at, side, usd: price * qty, price, qty };
}

/** Formatea importes en español con unidad de cotización (USDT o USDC). */
export function formatUsd(value, quote = 'USDT') {
  if (!Number.isFinite(value) || value <= 0) return `0 ${quote}`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace('.', ',')} M ${quote}`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace('.', ',')} mil ${quote}`;
  return `${value.toFixed(1).replace('.', ',')} ${quote}`;
}

/** Formatea precios con decimales apropiados según su orden de magnitud. */
export function formatPrice(value) {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const maxDigits = abs < 0.0001 ? 8 : abs < 0.01 ? 6 : abs < 1 ? 4 : 2;
  return new Intl.NumberFormat('es-ES', { maximumFractionDigits: maxDigits }).format(value);
}

/** Formatea porcentajes con dos decimales y coma. */
export function formatPct(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(2).replace('.', ',')} %`;
}

export async function fetchDepth(symbol, fetchImpl = fetch) {
  const res = await fetchImpl(depthUrl(symbol), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`depth status ${res.status}`);
  return res.json();
}

export async function fetchWalls(symbol, fetchImpl = fetch) {
  try {
    const raw = await fetchDepth(symbol, fetchImpl);
    return depthWalls(raw);
  } catch {
    return null;
  }
}

export async function fetchKlines(symbol, timeframe, limit = 200, fetchImpl = fetch) {
  const res = await fetchImpl(klinesUrl(symbol, timeframe, limit), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`klines status ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    time: Math.floor(r[0] / 1000),
    open: +r[1],
    high: +r[2],
    low: +r[3],
    close: +r[4],
    volume: +r[5],
    trades: Number.isFinite(+r[8]) ? +r[8] : undefined,
    takerBuyVolume: Number.isFinite(+r[9]) ? +r[9] : undefined,
  }));
}

export async function fetchRegimen(symbol, fetchImpl = fetch, timeframes = PULSE_TIMEFRAMES) {
  const rows = await Promise.all(
    timeframes.map(async (timeframe) => {
      try {
        const candles = await fetchKlines(symbol, timeframe, 200, fetchImpl);
        if (!candles.length) return null;
        const trend = trendOf(candles);
        if (!trend || typeof trend !== 'object') return null;
        const direction = trend.direction === 'up' || trend.direction === 'down' ? trend.direction : 'neutral';
        const label = typeof trend.label === 'string' && trend.label ? trend.label : direction;
        return { timeframe, direction, label };
      } catch {
        return null;
      }
    }),
  );
  const out = rows.filter(Boolean);
  return out.length ? out : null;
}

export function openLiquidationStream(
  symbol,
  handlers,
  wsFactory = (url) => new WebSocket(url),
) {
  const url = forceOrderUrl(symbol);
  const upper = assertSymbol(symbol);
  let socket = null;
  let closed = false;
  let openTimer = null;
  let retryTimer = null;

  const connect = () => {
    if (closed) return;
    try {
      const ws = wsFactory(url);
      socket = ws;
      openTimer = setTimeout(() => {
        if (ws.readyState !== WS_OPEN) {
          try { ws.close(); } catch { /* ignore */ }
        }
      }, SOCKET_OPEN_TIMEOUT_MS);
      ws.onopen = () => {
        if (openTimer !== null) clearTimeout(openTimer);
        openTimer = null;
        handlers.onLive?.(true);
      };
      ws.onmessage = (event) => {
        if (!event || typeof event.data !== 'string') return;
        const parsed = parseForceOrder(event.data);
        if (parsed && parsed.symbol === upper) {
          handlers.onEvent(parsed);
        }
      };
      ws.onerror = () => {
        /* onclose gestiona la reconexión */
      };
      ws.onclose = () => {
        if (openTimer !== null) clearTimeout(openTimer);
        openTimer = null;
        if (closed) return;
        handlers.onLive?.(false);
        retryTimer = setTimeout(connect, LIQUIDATION_RECONNECT_MS);
      };
    } catch {
      if (closed) return;
      handlers.onLive?.(false);
      retryTimer = setTimeout(connect, LIQUIDATION_RECONNECT_MS);
    }
  };

  connect();

  return {
    close() {
      closed = true;
      if (openTimer !== null) clearTimeout(openTimer);
      if (retryTimer !== null) clearTimeout(retryTimer);
      try { socket?.close(); } catch { /* ignore */ }
    },
  };
}

export function documentVisibility() {
  return {
    current: () => (typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'),
    subscribe(listener) {
      if (typeof document === 'undefined') return () => {};
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
  };
}

export function startMarketPulse(symbol, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const visibility = options.visibility ?? documentVisibility();
  const refreshMs = Math.max(10_000, options.depthRefreshMs ?? DEPTH_REFRESH_MS);
  const events = [];
  let walls = null;
  let regimen = null;
  let live = false;
  let alive = true;
  let timer = null;
  let stream = null;

  const emit = () => {
    if (!alive) return;
    options.onChange?.({
      symbol,
      walls,
      liquidations: liquidationSummary(events, {}, now()),
      regimen,
      live,
    });
  };

  const refreshWalls = async () => {
    try {
      const next = await fetchWalls(symbol, fetchImpl);
      if (!alive) return;
      walls = next;
      emit();
    } catch {
      if (!alive) return;
      walls = null;
      emit();
    }
  };

  const startPolling = () => {
    if (timer !== null) return;
    void refreshWalls();
    timer = setInterval(() => {
      void refreshWalls();
    }, refreshMs);
  };

  const startStream = () => {
    if (stream) return;
    stream = openLiquidationStream(
      symbol,
      {
        onEvent(event) {
          events.push(event);
          if (events.length > LIQUIDATION_EVENT_CAP) events.shift();
          emit();
        },
        onLive(value) {
          live = value;
          emit();
        },
      },
      options.wsFactory,
    );
  };

  const applyVisibility = () => {
    if (!alive) return;
    if (visibility.current()) {
      startPolling();
      startStream();
    } else {
      if (timer !== null) clearInterval(timer);
      timer = null;
      stream?.close();
      stream = null;
      live = false;
      emit();
    }
  };

  void (async () => {
    const next = await fetchRegimen(symbol, fetchImpl);
    if (!alive) return;
    regimen = next;
    emit();
  })();

  const unsubscribe = visibility.subscribe(applyVisibility);
  applyVisibility();

  return {
    stop() {
      alive = false;
      if (timer !== null) clearInterval(timer);
      timer = null;
      stream?.close();
      stream = null;
      unsubscribe();
    },
  };
}
