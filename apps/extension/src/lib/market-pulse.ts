import * as coreModule from '@swal/analysis-core';
import { browser } from 'wxt/browser';
import { assertSymbol } from './binance';
import { fetchKlines, type LiveSocket } from './market-feed';
import type {
  Candle,
  DepthWalls,
  FearGreed,
  LiquidationEvent,
  LiquidationSummary,
  TimeframeTrend,
} from './types';

/**
 * Pulso de mercado: hechos de solo lectura para el símbolo abierto.
 * Muros del libro (`GET /fapi/v1/depth`), liquidaciones (`@forceOrder`),
 * miedo/codicia (alternative.me, cacheado 1 h) y régimen 15m/1h/4h con el
 * núcleo. Todo fallo se degrada a "No disponible ahora.": nada lanza hacia el
 * panel ni bloquea el análisis. Ninguna cifra de aquí es una probabilidad.
 */

const REST_ORIGIN = 'https://fapi.binance.com';
// Binance sirve los streams de mercado en /market/ws; la ruta vieja /ws acepta la conexión
// pero ya no envía datos (comprobado en vivo el 2026-10-15).
const WS_ORIGIN = 'wss://fstream.binance.com/market/ws';

export const DEPTH_LIMIT = 500;
/** Muros: refresco modesto (>= 10 s), nunca al ritmo del mercado. */
export const DEPTH_REFRESH_MS = 15_000;
export const FEAR_GREED_URL = 'https://api.alternative.me/fng/?limit=1';
export const FEAR_GREED_KEY = 'pulse.fearGreed';
export const FEAR_GREED_TTL_MS = 60 * 60 * 1000;
export const PULSE_TIMEFRAMES = ['15m', '1h', '4h'] as const;
export const REGIMEN_LIMIT = 200;
export const LIQUIDATION_EVENT_CAP = 400;
export const LIQUIDATION_RECONNECT_MS = 5_000;
export const NO_DATA = 'No disponible ahora.';

const SOCKET_OPEN_TIMEOUT_MS = 4_000;
const WS_OPEN = 1;

/** Solo el núcleo determinista compartido; sin él, el panel no inventa datos. */
interface PulseCoreModule {
  trendOf?: (candles: readonly Candle[]) => unknown;
  depthWalls?: (depth: unknown, opts?: Record<string, unknown>) => unknown;
  liquidationSummary?: (events: readonly unknown[], opts?: Record<string, unknown>, now?: number) => unknown;
}

const core = coreModule as PulseCoreModule;

export function depthUrl(symbol: string, limit: number = DEPTH_LIMIT): string {
  const capped = Math.min(1000, Math.max(5, Math.floor(limit)));
  return `${REST_ORIGIN}/fapi/v1/depth?symbol=${assertSymbol(symbol)}&limit=${capped}`;
}

export function forceOrderUrl(symbol: string): string {
  return `${WS_ORIGIN}/${assertSymbol(symbol).toLowerCase()}@forceOrder`;
}

async function fetchDepth(symbol: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(depthUrl(symbol), { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('depth');
  return response.json();
}

/** Muros del libro, o null si la red o el núcleo fallan. Nunca lanza. */
export async function fetchWalls(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DepthWalls | null> {
  const fn = core.depthWalls;
  if (typeof fn !== 'function') return null;
  try {
    const raw = fn(await fetchDepth(symbol, fetchImpl));
    return raw ? (raw as DepthWalls) : null;
  } catch {
    return null;
  }
}

/**
 * Un `forceOrder` de Binance. `S` es el lado de la orden: una venta (SELL)
 * liquida una posición larga y una compra (BUY) una corta. Preferimos el precio
 * medio (`ap`) y la cantidad ejecutada (`z`); el USD es precio x cantidad.
 */
export function parseForceOrder(data: string): LiquidationEvent | null {
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  const record = msg as { e?: unknown; o?: unknown; data?: unknown };
  if (record.e !== undefined && record.e !== 'forceOrder') return null;
  const body = record.o && typeof record.o === 'object'
    ? (record.o as Record<string, unknown>)
    : record.data && typeof record.data === 'object'
      ? (record.data as Record<string, unknown>)
      : null;
  if (!body) return null;
  const symbol = String(body.s ?? '');
  if (!/^[A-Z0-9]{2,30}$/.test(symbol)) return null;
  const side = body.S === 'SELL' ? 'long' : body.S === 'BUY' ? 'short' : null;
  if (!side) return null;
  const price = Number(body.ap ?? body.p);
  const qty = Number(body.z ?? body.q);
  const at = Number(body.T);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(at)) {
    return null;
  }
  return { symbol, at, side, usd: price * qty, price, qty };
}

export interface LiquidationStreamHandlers {
  onEvent: (event: LiquidationEvent) => void;
  onLive?: (live: boolean) => void;
}

/**
 * Stream público de liquidaciones del símbolo. Reconecta solo cada
 * `LIQUIDATION_RECONNECT_MS` hasta que se llama a `close()`.
 */
export function openLiquidationStream(
  symbol: string,
  handlers: LiquidationStreamHandlers,
  wsFactory: (url: string) => WebSocket = (url) => new WebSocket(url),
): LiveSocket {
  const url = forceOrderUrl(symbol);
  const upper = assertSymbol(symbol);
  let socket: WebSocket | null = null;
  let closed = false;
  let openTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (closed) return;
    const ws = wsFactory(url);
    socket = ws;
    openTimer = setTimeout(() => {
      if (ws.readyState !== WS_OPEN) ws.close();
    }, SOCKET_OPEN_TIMEOUT_MS);
    ws.onopen = () => {
      if (openTimer !== null) clearTimeout(openTimer);
      openTimer = null;
      handlers.onLive?.(true);
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      const parsed = parseForceOrder(event.data);
      if (parsed && parsed.symbol === upper) handlers.onEvent(parsed);
    };
    ws.onerror = () => {
      /* onclose hace la reconexión */
    };
    ws.onclose = () => {
      if (openTimer !== null) clearTimeout(openTimer);
      openTimer = null;
      if (closed) return;
      handlers.onLive?.(false);
      retryTimer = setTimeout(connect, LIQUIDATION_RECONNECT_MS);
    };
  };

  connect();

  return {
    close() {
      closed = true;
      if (openTimer !== null) clearTimeout(openTimer);
      if (retryTimer !== null) clearTimeout(retryTimer);
      socket?.close();
    },
  };
}

export const FEAR_GREED_LABELS: Readonly<Record<string, string>> = {
  'Extreme Fear': 'Miedo extremo',
  Fear: 'Miedo',
  Neutral: 'Neutral',
  Greed: 'Codicia',
  'Extreme Greed': 'Codicia extrema',
};

/** Mismas etiquetas que `/analisis/`; lo desconocido se muestra tal cual. */
export function fearGreedLabel(classification: unknown): string {
  const key = typeof classification === 'string' ? classification : '';
  return FEAR_GREED_LABELS[key] ?? (key || 'Sin dato');
}

export function parseFearGreed(payload: unknown): FearGreed | null {
  const rows = payload && typeof payload === 'object' ? (payload as { data?: unknown }).data : null;
  const row = Array.isArray(rows) && rows[0] && typeof rows[0] === 'object'
    ? (rows[0] as Record<string, unknown>)
    : null;
  if (!row) return null;
  const value = Number(row.value);
  if (!Number.isFinite(value)) return null;
  const classification = typeof row.value_classification === 'string' ? row.value_classification : '';
  return {
    value: Math.min(100, Math.max(0, Math.round(value))),
    classification,
    label: fearGreedLabel(classification),
  };
}

export interface PulseCache {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
}

/** Caché en `storage.local` de la extensión. Cualquier fallo es un fallo suave. */
export function browserCache(key: string): PulseCache {
  return {
    async read() {
      try {
        const stored = await browser.storage.local.get(key);
        return stored ? (stored as Record<string, unknown>)[key] ?? null : null;
      } catch {
        return null;
      }
    },
    async write(value) {
      try {
        await browser.storage.local.set({ [key]: value });
      } catch {
        /* sin caché se vuelve a pedir la próxima vez */
      }
    },
  };
}

function cachedFearGreed(raw: unknown): { at: number; data: FearGreed } | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as { at?: unknown; data?: Partial<FearGreed> };
  const at = Number(record.at);
  const data = record.data;
  if (!Number.isFinite(at) || !data || typeof data !== 'object') return null;
  if (typeof data.value !== 'number' || typeof data.label !== 'string' || typeof data.classification !== 'string') {
    return null;
  }
  return { at, data: { value: data.value, classification: data.classification, label: data.label } };
}

export interface FearGreedOptions {
  fetchImpl?: typeof fetch;
  cache?: PulseCache | null;
  nowMs?: number;
}

/**
 * Miedo/codicia cacheado 1 h. Con caché fresca no toca la red; si la petición
 * falla devuelve null (el panel pinta "No disponible ahora.") y no recicla un
 * dato viejo como si fuera de ahora.
 */
export async function fetchFearGreed(options: FearGreedOptions = {}): Promise<FearGreed | null> {
  const { fetchImpl = fetch, cache = null, nowMs = Date.now() } = options;
  const cached = cache ? cachedFearGreed(await cache.read()) : null;
  if (cached && nowMs - cached.at >= 0 && nowMs - cached.at < FEAR_GREED_TTL_MS) return cached.data;
  try {
    const response = await fetchImpl(FEAR_GREED_URL, { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    const data = parseFearGreed(await response.json());
    if (!data) return null;
    if (cache) await cache.write({ at: nowMs, data });
    return data;
  } catch {
    return null;
  }
}

function trendOfCandles(candles: readonly Candle[]): Pick<TimeframeTrend, 'direction' | 'label'> | null {
  const fn = core.trendOf;
  if (typeof fn !== 'function') return null;
  try {
    const raw = fn(candles) as { direction?: unknown; label?: unknown } | null;
    if (!raw || typeof raw !== 'object') return null;
    const direction = raw.direction === 'up' || raw.direction === 'down' ? raw.direction : 'neutral';
    const label = typeof raw.label === 'string' && raw.label ? raw.label : direction;
    return { direction, label };
  } catch {
    return null;
  }
}

/**
 * Tendencia de 15m, 1h y 4h con `trendOf` del núcleo sobre las klines públicas.
 * Las temporalidades que fallan se omiten; si fallan todas, null.
 */
export async function fetchRegimen(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TimeframeTrend[] | null> {
  const rows = await Promise.all(
    PULSE_TIMEFRAMES.map(async (timeframe) => {
      try {
        const candles = await fetchKlines(symbol, timeframe, REGIMEN_LIMIT, fetchImpl);
        const trend = candles.length ? trendOfCandles(candles) : null;
        return trend ? { ...trend, timeframe } : null;
      } catch {
        return null;
      }
    }),
  );
  const out: TimeframeTrend[] = [];
  for (const row of rows) {
    if (row) out.push(row);
  }
  return out.length ? out : null;
}

/** Estado completo que el panel pinta. */
export interface MarketPulseSnapshot {
  symbol: string;
  walls: DepthWalls | null;
  liquidations: LiquidationSummary;
  fearGreed: FearGreed | null;
  regimen: TimeframeTrend[] | null;
  live: boolean;
}

export interface PulseVisibility {
  current(): boolean;
  subscribe(listener: () => void): () => void;
}

/** Visibilidad de la pestaña: con el panel oculto no se consume nada. */
export function documentVisibility(): PulseVisibility {
  return {
    current: () => (typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'),
    subscribe(listener: () => void) {
      if (typeof document === 'undefined') return () => {};
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
  };
}

export interface MarketPulseOptions {
  onChange: (snapshot: MarketPulseSnapshot) => void;
  fetchImpl?: typeof fetch;
  wsFactory?: (url: string) => WebSocket;
  now?: () => number;
  cache?: PulseCache | null;
  visibility?: PulseVisibility;
  depthRefreshMs?: number;
}

export interface MarketPulseHandle {
  stop(): void;
}

const EMPTY_LIQUIDATIONS: LiquidationSummary = { count: 0, windows: [], largest: null };

function liquidationSummaryOf(events: readonly LiquidationEvent[], now: number): LiquidationSummary {
  const fn = core.liquidationSummary;
  if (typeof fn !== 'function') return EMPTY_LIQUIDATIONS;
  try {
    return (fn(events, {}, now) as LiquidationSummary) ?? EMPTY_LIQUIDATIONS;
  } catch {
    return EMPTY_LIQUIDATIONS;
  }
}

/**
 * Arranca el pulso para un símbolo. Devuelve un handle con `stop()`, que el
 * panel llama al desmontar o al cambiar de par. Con el panel oculto se para el
 * sondeo de muros y se cierra el stream; al volver, se refresca y reconecta.
 */
export function startMarketPulse(symbol: string, options: MarketPulseOptions): MarketPulseHandle {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const visibility = options.visibility ?? documentVisibility();
  const refreshMs = Math.max(10_000, options.depthRefreshMs ?? DEPTH_REFRESH_MS);
  const events: LiquidationEvent[] = [];
  let walls: DepthWalls | null = null;
  let fearGreed: FearGreed | null = null;
  let regimen: TimeframeTrend[] | null = null;
  let live = false;
  let alive = true;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stream: LiveSocket | null = null;

  const emit = () => {
    if (!alive) return;
    options.onChange({
      symbol,
      walls,
      liquidations: liquidationSummaryOf(events, now()),
      fearGreed,
      regimen,
      live,
    });
  };

  const refreshWalls = async () => {
    const next = await fetchWalls(symbol, fetchImpl);
    if (!alive) return;
    walls = next;
    emit();
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
    }
  };

  // Miedo/codicia y régimen cambian despacio: se piden una vez al abrir.
  void (async () => {
    const next = await fetchFearGreed({ fetchImpl, cache: options.cache ?? null, nowMs: now() });
    if (!alive) return;
    fearGreed = next;
    emit();
  })();
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
