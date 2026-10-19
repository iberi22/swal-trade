import { describe, expect, it } from 'vitest';
import { buildRoundTrips, computeMetrics, type MetricsOptions } from './metrics';
import type { Fill, IncomeRow } from './types';

const T0 = Date.UTC(2026, 0, 5, 0, 0, 0);
const min = (m: number) => T0 + m * 60_000;

let oid = 0;
function fill(p: Partial<Fill> & Pick<Fill, 'side' | 'qty' | 'timeMs'>): Fill {
  return { symbol: 'BTCUSDT', price: 100, fee: 0, realizedPnl: 0, orderId: String(++oid), ...p };
}
/** Long de qty a 100 que cierra con pnl realizado `net` (fee 0). */
function longTrip(openMin: number, closeMin: number, qty: number, net: number, symbol = 'BTCUSDT'): Fill[] {
  return [
    fill({ symbol, side: 'BUY', qty, timeMs: min(openMin) }),
    fill({ symbol, side: 'SELL', qty, timeMs: min(closeMin), price: 100 + net / qty, realizedPnl: net }),
  ];
}

const opts: MetricsOptions = {
  riskPerTradeUsd: 50,
  riskCapitalUsd: 1000,
  leverageRule: 0.15,
  tzOffsetHours: 0,
  revengeMinutes: 30,
  equity: 1000,
  openExposureUsd: 250,
};

describe('buildRoundTrips', () => {
  it('partial close keeps one trip', () => {
    const fills = [
      fill({ side: 'BUY', qty: 2, timeMs: min(0), fee: 0.2 }),
      fill({ side: 'SELL', qty: 1, timeMs: min(10), price: 110, realizedPnl: 10, fee: 0.1 }),
      fill({ side: 'SELL', qty: 1, timeMs: min(20), price: 120, realizedPnl: 20, fee: 0.1 }),
    ];
    const t = buildRoundTrips(fills, []);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ side: 'long', size: 2, entry: 100, exit: 115, pnl: 30 });
    expect(t[0]!.fees).toBeCloseTo(0.4);
    expect(t[0]!.netUsd).toBeCloseTo(29.6);
  });

  it('reversal closes trip and opens the remainder', () => {
    const fills = [
      fill({ side: 'BUY', qty: 1, timeMs: min(0) }),
      // vende 3: cierra 1 (pnl 10) y abre short de 2; fee 0.3 prorrateado 1/3 - 2/3
      fill({ side: 'SELL', qty: 3, timeMs: min(10), price: 110, realizedPnl: 10, fee: 0.3 }),
      fill({ side: 'BUY', qty: 2, timeMs: min(20), price: 105, realizedPnl: 10 }),
    ];
    const t = buildRoundTrips(fills, []);
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ side: 'long', openedMs: min(0), closedMs: min(10), pnl: 10 });
    expect(t[0]!.fees).toBeCloseTo(0.1);
    expect(t[1]).toMatchObject({ side: 'short', openedMs: min(10), closedMs: min(20), size: 2, entry: 110, exit: 105 });
    expect(t[1]!.fees).toBeCloseTo(0.2);
  });

  it('drops still-open trips', () => {
    expect(buildRoundTrips([fill({ side: 'BUY', qty: 1, timeMs: min(0) })], [])).toEqual([]);
  });

  it('attributes funding inside the window only, per symbol', () => {
    const fills = [...longTrip(0, 100, 1, 10), ...longTrip(0, 100, 1, 5, 'ETHUSDT')];
    const inc: IncomeRow[] = [
      { symbol: 'BTCUSDT', incomeType: 'FUNDING_FEE', income: -0.5, asset: 'USDT', timeMs: min(50) },
      { symbol: 'BTCUSDT', incomeType: 'FUNDING_FEE', income: -9, asset: 'USDT', timeMs: min(500) },
      { symbol: 'BTCUSDT', incomeType: 'COMMISSION', income: -9, asset: 'USDT', timeMs: min(50) },
      { symbol: 'ETHUSDT', incomeType: 'FUNDING_FEE', income: 0.25, asset: 'USDT', timeMs: min(60) },
    ];
    const t = buildRoundTrips(fills, inc);
    const btc = t.find((x) => x.symbol === 'BTCUSDT')!;
    const eth = t.find((x) => x.symbol === 'ETHUSDT')!;
    expect(btc.fundingUsd).toBe(-0.5);
    expect(btc.netUsd).toBeCloseTo(9.5);
    expect(eth.netUsd).toBeCloseTo(5.25);
  });
});

describe('computeMetrics hand-computed fixture', () => {
  // nets 100, -50, +30, -20, +40; fees 0; riesgo 50 USD.
  // T1 0-60, T2 180-240, T3 245-300 (qty 2), T4 600-660, T5 665-700.
  // winRate 3/5 = 0.6; expectancy 120/5 = 24... suma = 100-50+30-20+40 = 100 -> 20
  // PF = (100+30+40)/(50+20) = 170/70
  // curva 100,50,80,60,100 -> pico 100, drawdown max 50 (50% del pico)
  // revenge (<=30 min tras perdida): T3 (5 min tras T2) y T5 (5 min tras T4) = 2
  // sizeUp: T3 notional 200 > 1.5 * mediana 100 justo tras perdida = 1
  // mediana de hold: 60,60,55,60,35 -> 60
  const fills = [
    ...longTrip(0, 60, 1, 100),
    ...longTrip(180, 240, 1, -50),
    ...longTrip(245, 300, 2, 30),
    ...longTrip(600, 660, 1, -20),
    ...longTrip(665, 700, 1, 40),
  ];
  const trips = buildRoundTrips(fills, []);
  const m = computeMetrics(trips, opts);

  it('core stats', () => {
    expect(trips).toHaveLength(5);
    expect(m.n).toBe(5);
    expect(m.winRate).toBeCloseTo(0.6);
    expect(m.winRateWilsonLow).not.toBeNull();
    expect(m.expectancyUsd).toBeCloseTo(20);
    expect(m.profitFactor).toBeCloseTo(170 / 70);
    expect(m.maxDrawdownUsd).toBeCloseTo(50);
    expect(m.maxDrawdownPctOfPeak).toBeCloseTo(0.5);
    expect(m.rNominalMean).toBeCloseTo(0.4);
    expect(m.medianHoldMin).toBe(60);
    expect(m.feesUsd).toBe(0);
  });

  it('behaviour flags', () => {
    expect(m.revengeCount).toBe(2);
    expect(m.sizeUpAfterLossCount).toBe(1);
    expect(m.maxLeverageSeen).toBeCloseTo(0.2); // 200 / 1000
    expect(m.leverageBreaches).toBe(1);
    expect(m.exposureRatio).toBeCloseTo(0.25);
  });

  it('n < 30 is no_evidence', () => {
    expect(m.grade.grade).toBe('no_evidence');
  });

  it('profit factor null when no losses', () => {
    const only = computeMetrics(buildRoundTrips(longTrip(0, 10, 1, 5), []), opts);
    expect(only.profitFactor).toBeNull();
  });
});

describe('buckets', () => {
  it('hour of day uses tz offset', () => {
    const trips = buildRoundTrips([...longTrip(0, 60, 1, 10), ...longTrip(120, 180, 1, -5, 'ETHUSDT')], []);
    const utc = computeMetrics(trips, opts);
    expect(Object.keys(utc.byBucket.hour).sort()).toEqual(['0', '2']);
    const local = computeMetrics(trips, { ...opts, tzOffsetHours: -5 });
    expect(Object.keys(local.byBucket.hour).sort()).toEqual(['19', '21']);
    expect(local.byBucket.hour['19']).toMatchObject({ n: 1, winRate: 1, netUsd: 10 });
    expect(local.byBucket.symbol.ETHUSDT).toMatchObject({ n: 1, winRate: 0, netUsd: -5 });
    expect(local.byBucket.side.long?.n).toBe(2);
  });
});

describe('n >= 30 grading', () => {
  it('can leave no_evidence with enough trades', () => {
    const fills: Fill[] = [];
    for (let i = 0; i < 40; i++) fills.push(...longTrip(i * 1000, i * 1000 + 10, 1, i % 4 === 0 ? -10 : 30));
    const m = computeMetrics(buildRoundTrips(fills, []), opts);
    expect(m.n).toBe(40);
    expect(m.grade.grade).not.toBe('no_evidence');
  });
});

describe('empty input', () => {
  it('returns zeros and nulls', () => {
    expect(buildRoundTrips([], [])).toEqual([]);
    const m = computeMetrics([], opts);
    expect(m.n).toBe(0);
    expect(m.winRate).toBe(0);
    expect(m.profitFactor).toBeNull();
    expect(m.maxDrawdownUsd).toBe(0);
    expect(m.maxDrawdownPctOfPeak).toBeNull();
    expect(m.maxLeverageSeen).toBeNull();
    expect(m.grade.grade).toBe('no_evidence');
  });
});
