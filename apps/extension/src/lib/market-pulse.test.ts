import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// El almacén de la extensión, sustituido por un objeto en memoria.
const storage = vi.hoisted(() => {
  const store: Record<string, unknown> = {};
  return {
    store,
    api: {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: store[key] }),
          set: async (value: Record<string, unknown>) => {
            Object.assign(store, value);
          },
        },
      },
    },
  };
});
vi.mock('wxt/browser', () => ({ browser: storage.api }));

import {
  FEAR_GREED_URL,
  browserCache,
  depthUrl,
  fearGreedLabel,
  fetchFearGreed,
  fetchRegimen,
  fetchWalls,
  forceOrderUrl,
  openLiquidationStream,
  parseFearGreed,
  parseForceOrder,
  startMarketPulse,
  type MarketPulseSnapshot,
  type PulseCache,
} from './market-pulse';
import type { FearGreed, LiquidationEvent } from './types';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

/** Libro con la mediana en 1: solo los tamaños >= 2,5 son muros. */
const DEPTH = {
  bids: [['99.9', '1'], ['99.8', '1'], ['99.7', '1'], ['99.6', '1'], ['99.5', '20'], ['95.0', '50']],
  asks: [['100.1', '1'], ['100.2', '1'], ['100.3', '1'], ['100.4', '10'], ['100.5', '40']],
};

const FORCE_ORDER = forceOrderAt(1_700_000_000_000);

/** Misma forma que el stream, con el instante que pida la prueba. */
function forceOrderAt(at: number): string {
  return JSON.stringify({
    e: 'forceOrder',
    E: at + 500,
    o: { s: 'BTCUSDT', S: 'SELL', q: '0.5', p: '100', ap: '101', z: '0.5', T: at },
  });
}

const FNG_PAYLOAD = { data: [{ value: '37', value_classification: 'Fear', timestamp: '1700000000' }] };

/** Filas de klines con cierre lineal: sube o baja según `step`. */
function klineRows(count: number, start: number, step: number): unknown[] {
  return Array.from({ length: count }, (_, i) => {
    const close = start + i * step;
    return [
      1_700_000_000_000 + i * 60_000,
      String(close),
      String(close + 1),
      String(close - 1),
      String(close),
      '100',
      1,
      '0',
      10,
      '60',
    ];
  });
}

class FakeSocket {
  static all: FakeSocket[] = [];
  static get last(): FakeSocket {
    return FakeSocket.all[FakeSocket.all.length - 1]!;
  }
  static reset() {
    FakeSocket.all = [];
  }

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {
    FakeSocket.all.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  send(data: string) {
    this.onmessage?.({ data });
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
}

const fakeWs = (url: string) => new FakeSocket(url) as unknown as WebSocket;

/** Deja correr microtareas pendientes sin avanzar el reloj. */
const flush = () => vi.advanceTimersByTimeAsync(0);

class MemoryCache implements PulseCache {
  store: unknown = null;
  writes = 0;
  async read(): Promise<unknown> {
    return this.store;
  }
  async write(value: unknown): Promise<void> {
    this.store = value;
    this.writes += 1;
  }
}

describe('urls y parseo del pulso', () => {
  it('construye las URLs públicas y valida el símbolo', () => {
    expect(depthUrl('btcusdt')).toBe('https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=500');
    expect(forceOrderUrl('btcusdt')).toBe('wss://fstream.binance.com/market/ws/btcusdt@forceOrder');
    expect(() => depthUrl('no vale')).toThrow();
    expect(() => forceOrderUrl('')).toThrow();
    expect(FEAR_GREED_URL).toBe('https://api.alternative.me/fng/?limit=1');
  });

  it('parsea forceOrder: venta liquida un largo, compra un corto', () => {
    expect(parseForceOrder(FORCE_ORDER)).toEqual({
      symbol: 'BTCUSDT',
      at: 1_700_000_000_000,
      side: 'long',
      usd: 50.5,
      price: 101,
      qty: 0.5,
    });
    const buy = JSON.stringify({
      e: 'forceOrder',
      data: { s: 'ETHUSDT', S: 'BUY', q: '2', ap: '10', T: 1_700_000_000_000 },
    });
    expect(parseForceOrder(buy)).toMatchObject({ symbol: 'ETHUSDT', side: 'short', usd: 20 });
  });

  it('descarta forceOrder roto o incompleto', () => {
    expect(parseForceOrder('no es json')).toBeNull();
    expect(parseForceOrder('{}')).toBeNull();
    expect(parseForceOrder(JSON.stringify({ e: 'kline', o: { s: 'BTCUSDT', S: 'SELL', q: '1', ap: '1', T: 1 } }))).toBeNull();
    expect(parseForceOrder(JSON.stringify({ e: 'forceOrder', o: { s: 'X', S: 'SELL', q: '1', ap: '1', T: 1 } }))).toBeNull();
    expect(parseForceOrder(JSON.stringify({ e: 'forceOrder', o: { s: 'BTCUSDT', S: 'HOLD', q: '1', ap: '1', T: 1 } }))).toBeNull();
  });

  it('parsea miedo/codicia con la etiqueta en español', () => {
    expect(parseFearGreed(FNG_PAYLOAD)).toEqual({ value: 37, classification: 'Fear', label: 'Miedo' });
    expect(fearGreedLabel('Extreme Greed')).toBe('Codicia extrema');
    expect(fearGreedLabel('Extreme Fear')).toBe('Miedo extremo');
    expect(fearGreedLabel('algo raro')).toBe('algo raro');
    expect(parseFearGreed({ data: [] })).toBeNull();
    expect(parseFearGreed(null)).toBeNull();
  });
});

describe('fetchWalls', () => {
  it('devuelve los muros del libro mockeado', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      return jsonResponse(DEPTH);
    }) as unknown as typeof fetch;
    const walls = await fetchWalls('BTCUSDT', fetchImpl);
    expect(calls[0]).toContain('/fapi/v1/depth?symbol=BTCUSDT&limit=500');
    expect(walls?.mid).toBe(100);
    expect(walls?.bids.map((w) => w.size)).toEqual([20]);
    expect(walls?.asks.map((w) => w.size)).toEqual([40, 10]);
  });

  it('degrada a null con error de red o respuesta no válida', async () => {
    const boom = (async () => {
      throw new Error('sin red');
    }) as unknown as typeof fetch;
    const bad = (async () => jsonResponse({}, false)) as unknown as typeof fetch;
    expect(await fetchWalls('BTCUSDT', boom)).toBeNull();
    expect(await fetchWalls('BTCUSDT', bad)).toBeNull();
  });
});

describe('openLiquidationStream', () => {
  beforeEach(() => FakeSocket.reset());
  afterEach(() => vi.useRealTimers());

  it('se conecta al stream público, emite eventos y filtra otros símbolos', () => {
    const events: LiquidationEvent[] = [];
    const live: boolean[] = [];
    const handle = openLiquidationStream(
      'BTCUSDT',
      { onEvent: (event) => events.push(event), onLive: (value) => live.push(value) },
      fakeWs,
    );
    expect(FakeSocket.last.url).toBe('wss://fstream.binance.com/market/ws/btcusdt@forceOrder');
    FakeSocket.last.open();
    expect(live).toEqual([true]);
    FakeSocket.last.send(FORCE_ORDER);
    expect(events).toHaveLength(1);
    FakeSocket.last.send(
      JSON.stringify({ e: 'forceOrder', o: { s: 'ETHUSDT', S: 'SELL', q: '1', ap: '10', T: 1_700_000_000_000 } }),
    );
    expect(events).toHaveLength(1);
    handle.close();
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('reconecta tras una caída y deja de reintentar al cerrar', async () => {
    vi.useFakeTimers();
    const handle = openLiquidationStream('BTCUSDT', { onEvent: () => {} }, fakeWs);
    FakeSocket.last.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeSocket.all).toHaveLength(2);
    handle.close();
    FakeSocket.last.close();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeSocket.all).toHaveLength(2);
  });
});

describe('fetchFearGreed', () => {
  it('pide el dato y lo guarda cuando no hay caché', async () => {
    const cache = new MemoryCache();
    const fetchImpl = vi.fn(async () => jsonResponse(FNG_PAYLOAD));
    const out = await fetchFearGreed({ fetchImpl: fetchImpl as unknown as typeof fetch, cache, nowMs: 1_000 });
    expect(out).toEqual({ value: 37, classification: 'Fear', label: 'Miedo' });
    expect(cache.writes).toBe(1);
    expect(cache.store).toMatchObject({ at: 1_000, data: { value: 37 } });
  });

  it('usa la caché de menos de una hora sin tocar la red', async () => {
    const cache = new MemoryCache();
    const fresh: FearGreed = { value: 60, classification: 'Greed', label: 'Codicia' };
    cache.store = { at: 1_000, data: fresh };
    const fetchImpl = vi.fn(async () => jsonResponse(FNG_PAYLOAD));
    const out = await fetchFearGreed({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cache,
      nowMs: 1_000 + 59 * 60_000,
    });
    expect(out).toEqual(fresh);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('con la caché caducada vuelve a pedir; si falla, no inventa', async () => {
    const cache = new MemoryCache();
    cache.store = { at: 0, data: { value: 60, classification: 'Greed', label: 'Codicia' } };
    const boom = (async () => {
      throw new Error('sin red');
    }) as unknown as typeof fetch;
    expect(await fetchFearGreed({ fetchImpl: boom, cache, nowMs: 10 * 60 * 60_000 })).toBeNull();
    const bad = (async () => jsonResponse({}, false)) as unknown as typeof fetch;
    expect(await fetchFearGreed({ fetchImpl: bad, cache, nowMs: 10 * 60 * 60_000 })).toBeNull();
    // Basura en la caché tampoco pasa el filtro.
    cache.store = { at: Number.NaN, data: 5 };
    expect(await fetchFearGreed({ fetchImpl: boom, cache, nowMs: 1 })).toBeNull();
  });

  it('browserCache lee y escribe con el almacenamiento de la extensión', async () => {
    const cache = browserCache('pulse.test');
    expect(await cache.read()).toBeNull();
    await cache.write({ at: 1, data: { value: 1 } });
    expect(await cache.read()).toMatchObject({ at: 1 });
    expect(storage.store['pulse.test']).toMatchObject({ at: 1 });
  });
});

describe('fetchRegimen', () => {
  it('calcula la tendencia de 15m, 1h y 4h con el núcleo', async () => {
    const fetchImpl = (async (url: string) => {
      const text = String(url);
      if (text.includes('interval=4h')) return jsonResponse(klineRows(120, 200, -0.5));
      return jsonResponse(klineRows(120, 100, 1));
    }) as unknown as typeof fetch;
    const regimen = await fetchRegimen('BTCUSDT', fetchImpl);
    expect(regimen?.map((row) => row.timeframe)).toEqual(['15m', '1h', '4h']);
    expect(regimen?.map((row) => row.direction)).toEqual(['up', 'up', 'down']);
    expect(regimen?.[0]?.label).toBe('Alcista');
  });

  it('devuelve null si ninguna temporalidad responde', async () => {
    const bad = (async () => jsonResponse({}, false)) as unknown as typeof fetch;
    expect(await fetchRegimen('BTCUSDT', bad)).toBeNull();
  });
});

describe('startMarketPulse', () => {
  beforeEach(() => {
    FakeSocket.reset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  function harness() {
    const fetches: string[] = [];
    const fetchImpl = (async (url: string) => {
      const text = String(url);
      fetches.push(text);
      if (text.includes('/fapi/v1/depth')) return jsonResponse(DEPTH);
      if (text.includes('/fapi/v1/klines')) return jsonResponse(klineRows(120, 100, 1));
      if (text.includes('alternative.me')) return jsonResponse(FNG_PAYLOAD);
      return jsonResponse({}, false);
    }) as unknown as typeof fetch;
    const snapshots: MarketPulseSnapshot[] = [];
    let visible = true;
    const listeners: Array<() => void> = [];
    const visibility = {
      current: () => visible,
      subscribe: (listener: () => void) => {
        listeners.push(listener);
        return () => {};
      },
    };
    const handle = startMarketPulse('BTCUSDT', {
      onChange: (snapshot) => snapshots.push(snapshot),
      fetchImpl,
      wsFactory: fakeWs,
      cache: null,
      visibility,
      depthRefreshMs: 10_000,
    });
    return {
      fetches,
      snapshots,
      handle,
      setVisible(value: boolean) {
        visible = value;
        listeners.forEach((listener) => listener());
      },
      last: () => snapshots[snapshots.length - 1]!,
      depthFetches: () => fetches.filter((url) => url.includes('/fapi/v1/depth')).length,
    };
  }

  it('pide muros, régimen y miedo/codicia al abrir el panel', async () => {
    const h = harness();
    await flush();
    expect(h.depthFetches()).toBe(1);
    expect(h.fetches.filter((url) => url.includes('/fapi/v1/klines'))).toHaveLength(3);
    expect(h.fetches.some((url) => url.includes('alternative.me'))).toBe(true);
    expect(h.last().walls?.mid).toBe(100);
    expect(h.last().fearGreed?.value).toBe(37);
    expect(h.last().regimen).toHaveLength(3);
    h.handle.stop();
  });

  it('acumula liquidaciones del stream y refresca los muros por intervalo', async () => {
    const h = harness();
    await flush();
    FakeSocket.last.open();
    FakeSocket.last.send(forceOrderAt(Date.now()));
    await flush();
    expect(h.last().live).toBe(true);
    expect(h.last().liquidations.count).toBe(1);
    expect(h.last().liquidations.windows[0]?.longUsd).toBe(50.5);
    expect(h.last().liquidations.windows[0]?.totalUsd).toBe(50.5);
    expect(h.last().liquidations.largest).toMatchObject({ usd: 50.5, side: 'long' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.depthFetches()).toBe(2);
    h.handle.stop();
  });

  it('para el sondeo y el stream cuando el panel se oculta', async () => {
    const h = harness();
    await flush();
    expect(h.depthFetches()).toBe(1);
    h.setVisible(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.depthFetches()).toBe(1);
    expect(FakeSocket.last.readyState).toBe(3);
    h.setVisible(true);
    await flush();
    expect(h.depthFetches()).toBe(2);
    h.handle.stop();
  });

  it('stop cierra el stream y deja de refrescar', async () => {
    const h = harness();
    await flush();
    h.handle.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.depthFetches()).toBe(1);
    expect(FakeSocket.last.readyState).toBe(3);
  });
});
