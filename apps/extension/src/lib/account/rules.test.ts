import { describe, expect, it } from 'vitest';
import { evaluateRules, type RuleInput, type RuleResult } from './rules';
import type { AccountSnapshot, Fill, PositionSide, PositionView } from './types';

const NOW = 10_000_000;
const MIN = 60_000;

function mk(side: PositionSide, over: Partial<PositionView> = {}, snap: Partial<AccountSnapshot> = {}, extra: Partial<RuleInput> = {}): RuleInput {
  const s = side === 'long' ? 1 : -1;
  const position: PositionView = {
    symbol: 'BTCUSDT',
    side,
    size: 1,
    entry: 100,
    mark: 100,
    liq: 100 - s * 20,
    leverage: 5,
    marginType: 'isolated',
    uPnl: 0,
    breakEven: null,
    notional: 100,
    stop: { price: 100 - s * 0.5, kind: 'algo' },
    firstFillMs: null,
    ...over,
  };
  const snapshot: AccountSnapshot = {
    fetchedAt: NOW,
    equity: 1000,
    dailyPnl: 0,
    positions: [position],
    fundingRate: 0,
    nextFundingMs: NOW + 8 * 60 * MIN,
    ...snap,
  };
  return {
    position,
    snapshot,
    atr: 5,
    rules: { maxRiskPct: 1, maxLeverage: 10, dailyLossUsd: 10, revengeMinutes: 15 },
    now: NOW,
    ...extra,
  };
}

const find = (r: RuleResult[], code: string, sev?: string) => r.find((x) => x.code === code && (!sev || x.sev === sev));
const stop = (price: number) => ({ price, kind: 'algo' as const });
const fill = (side: 'BUY' | 'SELL', price: number, qty: number, timeMs: number): Fill => ({
  symbol: 'BTCUSDT', side, price, qty, fee: 0, realizedPnl: 0, timeMs, orderId: String(timeMs),
});

describe.each(['long', 'short'] as const)('reglas (%s)', (side) => {
  const s = side === 'long' ? 1 : -1;
  const px = (d: number) => 100 + s * d; // d>0 favorable al lado de la posicion

  it('base sin alertas', () => {
    expect(evaluateRules(mk(side))).toEqual([]);
  });

  it('NO_STOP dispara y menciona liquidacion', () => {
    const r = evaluateRules(mk(side, { stop: null }));
    const x = find(r, 'NO_STOP', 'critical')!;
    expect(x.text).toContain('liquidacion');
    expect(x.text).toContain('20.0%');
    const noLiq = find(evaluateRules(mk(side, { stop: null, liq: null })), 'NO_STOP')!;
    expect(noLiq.text).not.toContain('%');
  });
  it('NO_STOP no dispara con stop', () => {
    expect(find(evaluateRules(mk(side)), 'NO_STOP')).toBeUndefined();
  });

  it('STOP_BEYOND_LIQ dispara', () => {
    expect(find(evaluateRules(mk(side, { stop: stop(px(-25)) })), 'STOP_BEYOND_LIQ', 'critical')).toBeDefined();
    expect(find(evaluateRules(mk(side, { stop: stop(px(-20)) })), 'STOP_BEYOND_LIQ')).toBeDefined();
  });
  it('STOP_BEYOND_LIQ no dispara', () => {
    expect(find(evaluateRules(mk(side, { stop: stop(px(-10)) })), 'STOP_BEYOND_LIQ')).toBeUndefined();
    expect(find(evaluateRules(mk(side, { liq: null })), 'STOP_BEYOND_LIQ')).toBeUndefined();
  });

  it('STOP_NEAR_LIQ dispara', () => {
    expect(find(evaluateRules(mk(side, { stop: stop(px(-17)) })), 'STOP_NEAR_LIQ', 'warn')).toBeDefined();
  });
  it('STOP_NEAR_LIQ no dispara', () => {
    expect(find(evaluateRules(mk(side, { stop: stop(px(-15)) })), 'STOP_NEAR_LIQ')).toBeUndefined();
  });

  it('RISK_OVER_RULE warn', () => {
    // perdida = 15 + 85*0.0005 ~ 15.04 sobre 1000 => 1.5%
    const x = find(evaluateRules(mk(side, { stop: stop(px(-15)) }, { equity: 1000 })), 'RISK_OVER_RULE', 'warn')!;
    expect(x).toBeDefined();
    expect(x.values.riskPct).toBeCloseTo(1.5, 1);
  });
  it('RISK_OVER_RULE critical sobre 2x', () => {
    const r = evaluateRules(mk(side, { stop: stop(px(-18)) }, { equity: 500 }));
    expect(find(r, 'RISK_OVER_RULE', 'critical')).toBeDefined();
  });
  it('RISK_OVER_RULE no dispara', () => {
    expect(find(evaluateRules(mk(side)), 'RISK_OVER_RULE')).toBeUndefined();
    expect(find(evaluateRules(mk(side, { stop: stop(px(-15)) }, { equity: null })), 'RISK_OVER_RULE')).toBeUndefined();
    expect(find(evaluateRules(mk(side, { stop: stop(px(-15)) }, { equity: 0 })), 'RISK_OVER_RULE')).toBeUndefined();
  });

  it('LEV_OVER_RULE', () => {
    expect(find(evaluateRules(mk(side, { leverage: 20 })), 'LEV_OVER_RULE', 'warn')).toBeDefined();
    expect(find(evaluateRules(mk(side, { leverage: 10 })), 'LEV_OVER_RULE')).toBeUndefined();
  });

  it('LIQ_CLOSE dispara (<3 ATR)', () => {
    const x = find(evaluateRules(mk(side, {}, {}, { atr: 10 })), 'LIQ_CLOSE', 'warn')!;
    expect(x.values.atrMultiple).toBeCloseTo(2, 6);
  });
  it('LIQ_CLOSE no dispara', () => {
    expect(find(evaluateRules(mk(side, {}, {}, { atr: 5 })), 'LIQ_CLOSE')).toBeUndefined();
    expect(find(evaluateRules(mk(side, {}, {}, { atr: null })), 'LIQ_CLOSE')).toBeUndefined();
    expect(find(evaluateRules(mk(side, { liq: null }, {}, { atr: 10 })), 'LIQ_CLOSE')).toBeUndefined();
  });

  it('DAILY_LIMIT critical, warn y sin alerta', () => {
    expect(find(evaluateRules(mk(side, {}, { dailyPnl: -10 })), 'DAILY_LIMIT', 'critical')!.text).toContain('Limite diario alcanzado');
    expect(find(evaluateRules(mk(side, {}, { dailyPnl: -7 })), 'DAILY_LIMIT', 'warn')!.text).toContain('70%');
    expect(find(evaluateRules(mk(side, {}, { dailyPnl: -6.9 })), 'DAILY_LIMIT')).toBeUndefined();
    expect(find(evaluateRules(mk(side, {}, { dailyPnl: null })), 'DAILY_LIMIT')).toBeUndefined();
  });

  it('FUNDING_AGAINST dispara contra la posicion', () => {
    const f = 0.001 * s; // long paga con f>0; short paga con f<0
    const r = evaluateRules(mk(side, {}, { fundingRate: f, nextFundingMs: NOW + 30 * MIN }));
    const x = find(r, 'FUNDING_AGAINST', 'info')!;
    expect(x.values.cost).toBeCloseTo(0.1, 6);
  });
  it('FUNDING_AGAINST no dispara', () => {
    const f = 0.001 * s;
    expect(find(evaluateRules(mk(side, {}, { fundingRate: -f, nextFundingMs: NOW + 30 * MIN })), 'FUNDING_AGAINST')).toBeUndefined();
    expect(find(evaluateRules(mk(side, {}, { fundingRate: f, nextFundingMs: NOW + 90 * MIN })), 'FUNDING_AGAINST')).toBeUndefined();
    expect(find(evaluateRules(mk(side, {}, { fundingRate: 0.0004 * s, nextFundingMs: NOW + 30 * MIN })), 'FUNDING_AGAINST')).toBeUndefined();
    expect(find(evaluateRules(mk(side, {}, { fundingRate: null })), 'FUNDING_AGAINST')).toBeUndefined();
  });

  const open: 'BUY' | 'SELL' = side === 'long' ? 'BUY' : 'SELL';
  it('AVERAGING_DOWN dispara', () => {
    const fills = [fill(open, 100, 1, 1000), fill(open, px(-5), 1, 2000)];
    expect(find(evaluateRules(mk(side, {}, {}, { recentFills: fills })), 'AVERAGING_DOWN', 'warn')).toBeDefined();
  });
  it('AVERAGING_DOWN no dispara', () => {
    const better = [fill(open, 100, 1, 1000), fill(open, px(5), 1, 2000)];
    expect(find(evaluateRules(mk(side, {}, {}, { recentFills: better })), 'AVERAGING_DOWN')).toBeUndefined();
    const single = [fill(open, 100, 1, 1000)];
    expect(find(evaluateRules(mk(side, {}, {}, { recentFills: single })), 'AVERAGING_DOWN')).toBeUndefined();
    expect(find(evaluateRules(mk(side)), 'AVERAGING_DOWN')).toBeUndefined();
    expect(find(evaluateRules(mk(side, {}, {}, { recentFills: [] })), 'AVERAGING_DOWN')).toBeUndefined();
  });

  it('STOP_WIDENED', () => {
    expect(find(evaluateRules(mk(side, { stop: stop(px(-5)) }, {}, { initialStopPrice: px(-2) })), 'STOP_WIDENED', 'warn')).toBeDefined();
    expect(find(evaluateRules(mk(side, { stop: stop(px(-2)) }, {}, { initialStopPrice: px(-5) })), 'STOP_WIDENED')).toBeUndefined();
    expect(find(evaluateRules(mk(side, { stop: stop(px(-5)) }, {}, { initialStopPrice: px(-5) })), 'STOP_WIDENED')).toBeUndefined();
    expect(find(evaluateRules(mk(side, { stop: stop(px(-5)) }, {}, { initialStopPrice: null })), 'STOP_WIDENED')).toBeUndefined();
  });

  it('REVENGE', () => {
    const closed = NOW - 100 * MIN;
    const near = mk(side, { firstFillMs: closed + 5 * MIN }, {}, { lastClosedLoss: { closedAtMs: closed } });
    expect(find(evaluateRules(near), 'REVENGE', 'warn')).toBeDefined();
    const far = mk(side, { firstFillMs: closed + 30 * MIN }, {}, { lastClosedLoss: { closedAtMs: closed } });
    expect(find(evaluateRules(far), 'REVENGE')).toBeUndefined();
    expect(find(evaluateRules(mk(side, { firstFillMs: closed + 5 * MIN })), 'REVENGE')).toBeUndefined();
    expect(find(evaluateRules(mk(side, { firstFillMs: null }, {}, { lastClosedLoss: { closedAtMs: closed } })), 'REVENGE')).toBeUndefined();
  });

  it('STALE', () => {
    expect(find(evaluateRules(mk(side, {}, { fetchedAt: NOW - 30_001 })), 'STALE', 'info')).toBeDefined();
    expect(find(evaluateRules(mk(side, {}, { fetchedAt: NOW - 30_000 })), 'STALE')).toBeUndefined();
  });

  it('ordena critical, warn, info', () => {
    const r = evaluateRules(
      mk(side, { stop: null, leverage: 50 }, { fetchedAt: NOW - 60_000 }),
    );
    const order = r.map((x) => x.sev);
    expect(order).toEqual([...order].sort((a, b) => ['critical', 'warn', 'info'].indexOf(a) - ['critical', 'warn', 'info'].indexOf(b)));
    expect(order[0]).toBe('critical');
    expect(order[order.length - 1]).toBe('info');
  });

  it('textos: honestos y <= 90 caracteres', () => {
    const fills = [fill(open, 100, 1, 1000), fill(open, px(-5), 1, 2000)];
    const closed = NOW - 100 * MIN;
    const inputs = [
      mk(side, { stop: null, leverage: 50, firstFillMs: closed + MIN, liq: px(-2) }, {
        dailyPnl: -12, fetchedAt: NOW - 99_000, fundingRate: 0.001 * s, nextFundingMs: NOW + MIN,
      }, { recentFills: fills, initialStopPrice: px(-1), lastClosedLoss: { closedAtMs: closed }, atr: 5 }),
      mk(side, { stop: stop(px(-30)), liq: px(-20) }, { equity: 300, dailyPnl: -8 }, { initialStopPrice: px(-1) }),
    ];
    for (const inp of inputs) {
      for (const x of evaluateRules(inp)) {
        expect(x.text.length).toBeLessThanOrEqual(90);
        expect(x.text).not.toMatch(/compra|vende|entra|gana|acierto|[*_`#]/i);
        expect(x.text).not.toMatch(/%\s*(de\s*)?acierto|acierto\s*%/i);
      }
    }
  });
});
