import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({ browser: { storage: { local: { get: async () => ({}), set: async () => {} } } } }));

import {
  contextKlinesUrl,
  fetchLevelCandles,
  fetchPremium,
  fetchTicker24h,
  parsePremium,
  premiumUrl,
  startContextFeed,
  ticker24hUrl,
  type ContextSnapshot,
} from './context-feed';

function json(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 429, json: async () => body } as unknown as Response;
}

const row = (t: number) => [t * 1000, '1', '2', '0.5', '1.5', '10', 0, '0', 5, '4'];
const PREMIUM = {
  symbol: 'BTCUSDT',
  markPrice: '81977.23595652',
  indexPrice: '82002.74717391',
  lastFundingRate: '0.00009341',
  nextFundingTime: 1792454400000,
  time: 1792429020000,
};

describe('urls', () => {
  it('premiumIndex y ticker exactos, con el símbolo validado', () => {
    expect(premiumUrl('btcusdt')).toBe('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT');
    expect(ticker24hUrl('ETHUSDT')).toBe('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=ETHUSDT');
    expect(() => premiumUrl('BTC/USDT&x=1')).toThrow();
    expect(contextKlinesUrl('BTCUSDT', '1w', 8)).toBe(
      'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1w&limit=8',
    );
  });
});

describe('fetchPremium / fetchTicker24h', () => {
  it('parsea la respuesta real de Binance', async () => {
    const fetchImpl = vi.fn(async (_url: string) => json(PREMIUM));
    const out = await fetchPremium('BTCUSDT', fetchImpl as unknown as typeof fetch);
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT');
    expect(out).toEqual({
      lastFundingRate: 0.00009341,
      nextFundingTime: 1792454400000,
      markPrice: 81977.23595652,
      indexPrice: 82002.74717391,
    });
  });

  it('429, red caída, JSON raro y símbolo inválido dan null', async () => {
    const f429 = vi.fn(async () => json({ code: -1003 }, false)) as unknown as typeof fetch;
    const boom = vi.fn(async () => {
      throw new Error('net');
    }) as unknown as typeof fetch;
    const weird = vi.fn(async () => json({ markPrice: 'x' })) as unknown as typeof fetch;
    expect(await fetchPremium('BTCUSDT', f429)).toBeNull();
    expect(await fetchPremium('BTCUSDT', boom)).toBeNull();
    expect(await fetchPremium('BTCUSDT', weird)).toBeNull();
    expect(await fetchPremium('../x', f429)).toBeNull();
    expect(await fetchTicker24h('BTCUSDT', f429)).toBeNull();
    expect(await fetchTicker24h('BTCUSDT', boom)).toBeNull();
    expect(await fetchTicker24h('??', f429)).toBeNull();
  });

  it('ticker: priceChangePercent numérico', async () => {
    const fetchImpl = vi.fn(async (_url: string) => json({ priceChangePercent: '1.195', symbol: 'BTCUSDT' }));
    expect(await fetchTicker24h('BTCUSDT', fetchImpl as unknown as typeof fetch)).toEqual({
      priceChangePercent: 1.195,
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT');
    const bad = vi.fn(async () => json({ priceChangePercent: null }));
    expect(await fetchTicker24h('BTCUSDT', bad as unknown as typeof fetch)).toBeNull();
  });

  it('parsePremium rechaza basura', () => {
    expect(parsePremium(null)).toBeNull();
    expect(parsePremium('x')).toBeNull();
    expect(parsePremium({ ...PREMIUM, nextFundingTime: undefined })?.nextFundingTime).toBe(0);
  });
});

describe('fetchLevelCandles', () => {
  it('pide 1d x40, 1w x8, 1h x120 y 4h x100', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return json([row(100), row(200)]);
    });
    const out = await fetchLevelCandles('BTCUSDT', fetchImpl as unknown as typeof fetch);
    expect(urls.sort()).toEqual(
      [
        'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1d&limit=40',
        'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1w&limit=8',
        'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=120',
        'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=4h&limit=100',
      ].sort(),
    );
    expect(out?.d1).toHaveLength(2);
    expect(out?.w1[0]?.time).toBe(100);
  });

  it('series que fallan quedan vacías; si fallan todas, null', async () => {
    const mixed = vi.fn(async (url: string) =>
      url.includes('interval=1w') ? json({}, false) : json([row(1)]),
    );
    const out = await fetchLevelCandles('BTCUSDT', mixed as unknown as typeof fetch);
    expect(out?.w1).toEqual([]);
    expect(out?.h1).toHaveLength(1);
    const all429 = vi.fn(async () => json({}, false));
    expect(await fetchLevelCandles('BTCUSDT', all429 as unknown as typeof fetch)).toBeNull();
    expect(await fetchLevelCandles('bad symbol', all429 as unknown as typeof fetch)).toBeNull();
  });
});

describe('startContextFeed', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(visible = true) {
    let isVisible = visible;
    let listener: () => void = () => {};
    const visibility = {
      current: () => isVisible,
      subscribe: (fn: () => void) => {
        listener = fn;
        return () => {};
      },
    };
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes('premiumIndex')) return json(PREMIUM);
      if (url.includes('ticker/24hr')) return json({ priceChangePercent: '1.2' });
      if (url.includes('klines')) return json([row(1)]);
      return json({ data: [{ value: '32', value_classification: 'Fear' }] });
    });
    const snapshots: ContextSnapshot[] = [];
    const handle = startContextFeed('BTCUSDT', {
      onChange: (s) => snapshots.push(s),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      visibility,
      now: () => 1_000,
    });
    return {
      handle,
      calls,
      snapshots,
      setVisible(v: boolean) {
        isVisible = v;
        listener();
      },
    };
  }
  const count = (calls: string[], part: string) => calls.filter((u) => u.includes(part)).length;

  it('carga todo al abrir, mercado cada 30 s y velas cada 5 min', async () => {
    const t = setup();
    await vi.advanceTimersByTimeAsync(0);
    const last = t.snapshots[t.snapshots.length - 1]!;
    expect(last.premium?.markPrice).toBeCloseTo(81977.23595652);
    expect(last.ticker?.priceChangePercent).toBe(1.2);
    expect(last.candles?.h1).toHaveLength(1);
    expect(last.fearGreed?.value).toBe(32);
    expect(last.ready).toEqual({ fearGreed: true, market: true, candles: true });
    expect(count(t.calls, 'premiumIndex')).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(count(t.calls, 'premiumIndex')).toBe(2);
    expect(count(t.calls, 'interval=1d')).toBe(1);
    await vi.advanceTimersByTimeAsync(270_000);
    expect(count(t.calls, 'interval=1d')).toBe(2);
    t.handle.stop();
    const total = t.calls.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(t.calls.length).toBe(total);
  });

  it('con el panel oculto no pide nada y al volver refresca', async () => {
    const t = setup(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.calls).toEqual([]);
    t.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(count(t.calls, 'premiumIndex')).toBe(1);
    t.setVisible(false);
    const total = t.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.calls.length).toBe(total);
    t.handle.stop();
  });

  it('un fallo marca la parte como lista pero vacía', async () => {
    const snapshots: ContextSnapshot[] = [];
    const handle = startContextFeed('BTCUSDT', {
      onChange: (s) => snapshots.push(s),
      fetchImpl: (async () => json({}, false)) as unknown as typeof fetch,
      visibility: { current: () => true, subscribe: () => () => {} },
    });
    await vi.advanceTimersByTimeAsync(0);
    const last = snapshots[snapshots.length - 1]!;
    expect(last.premium).toBeNull();
    expect(last.candles).toBeNull();
    expect(last.ready.market).toBe(true);
    handle.stop();
  });
});
