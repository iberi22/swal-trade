import test from 'node:test';
import assert from 'node:assert/strict';
import * as g from '../static/guardian/guardian-core.js';

const pos = (symbol = 'BTCUSDC', amt = '0.01', positionSide = 'BOTH') => ({ symbol, amt, notional: 500, unrealized: 0, positionSide });
const algo = (symbol = 'BTCUSDC', side = 'SELL', orderType = 'STOP_MARKET', kw = {}) => ({ symbol, side, orderType, ...kw });

test('dayStartMs respects TZ offset', () => {
  const now = Date.UTC(2026, 9, 9, 3, 0); // 03:00Z = 22:00 del 8 en UTC-5
  assert.equal(g.dayStartMs(now, -5), Date.UTC(2026, 9, 8, 5, 0));
  assert.equal(g.dayStartMs(now, 0), Date.UTC(2026, 9, 9, 0, 0));
});

test('realizedUsd sums only pnl types in USD assets', () => {
  const rows = [
    { incomeType: 'REALIZED_PNL', asset: 'USDT', income: '10.5' },
    { incomeType: 'COMMISSION', asset: 'USDC', income: '-0.5' },
    { incomeType: 'FUNDING_FEE', asset: 'FDUSD', income: '-1' },
    { incomeType: 'TRANSFER', asset: 'USDT', income: '1000' },
    { incomeType: 'REALIZED_PNL', asset: 'BNB', income: '5' },
  ];
  assert.equal(g.realizedUsd(rows), 9);
});

test('positionsFrom filters zero positions', () => {
  const p = g.positionsFrom({ positions: [
    { symbol: 'A', positionAmt: '0', notional: '0', unrealizedProfit: '0' },
    { symbol: 'B', positionAmt: '-0.5', notional: '-100', unrealizedProfit: '2', positionSide: 'SHORT' },
  ] });
  assert.deepEqual(p, [{ symbol: 'B', amt: '-0.5', notional: 100, unrealized: 2, positionSide: 'SHORT' }]);
});

test('breaches: daily warn/hit, notional, leverage', () => {
  const cfg = { limit: 100, warn: 0.7, maxNotional: 400, maxLev: 5 };
  assert.deepEqual(Object.keys(g.breaches(-50, [], {}, cfg)), []);
  assert.deepEqual(Object.keys(g.breaches(-70, [], {}, cfg)), ['daily_warn']);
  assert.deepEqual(Object.keys(g.breaches(-100, [], {}, cfg)), ['daily_hit']);
  const b = g.breaches(0, [pos()], { BTCUSDC: 10 }, cfg);
  assert.ok(b['notional:BTCUSDC'].includes('500'));
  assert.ok(b['lev:BTCUSDC'].includes('10x'));
  assert.ok(g.breaches(-100, [], {}, cfg).daily_hit.includes('límite -100.00'));
});

test('hasStop cases', () => {
  assert.ok(g.hasStop(pos(), [algo('BTCUSDC', 'SELL', 'STOP_MARKET', { closePosition: true })]));
  assert.ok(g.hasStop(pos(), [algo('BTCUSDC', 'SELL', 'STOP_MARKET', { reduceOnly: 'true' })]));
  assert.ok(!g.hasStop(pos(), [algo('BTCUSDC', 'BUY', 'STOP_MARKET', { closePosition: true })]));
  assert.ok(!g.hasStop(pos(), [algo('ETHUSDC', 'SELL', 'STOP_MARKET', { closePosition: true })]));
  assert.ok(!g.hasStop(pos(), [algo('BTCUSDC', 'SELL', 'TAKE_PROFIT_MARKET', { closePosition: true })]));
  assert.ok(!g.hasStop(pos(), [algo('BTCUSDC', 'SELL', 'STOP_MARKET', { closePosition: false, reduceOnly: false })]));
  assert.ok(g.hasStop(pos('BTCUSDC', '-0.01'), [algo('BTCUSDC', 'BUY', 'STOP_MARKET', { closePosition: true })]));
  assert.ok(!g.hasStop(pos('BTCUSDC', '-0.01'), [algo('BTCUSDC', 'SELL', 'STOP_MARKET', { closePosition: true })]));
  const p = pos('BTCUSDC', '0.01', 'LONG');
  assert.ok(!g.hasStop(p, [algo('BTCUSDC', 'SELL', 'STOP_MARKET', { closePosition: true, positionSide: 'SHORT' })]));
  assert.ok(g.hasStop(p, [algo('BTCUSDC', 'SELL', 'STOP_MARKET', { closePosition: true, positionSide: 'LONG' })]));
  assert.equal(g.unprotected([pos(), pos('ETHUSDC')], [algo('BTCUSDC', 'SELL', 'STOP_MARKET', { closePosition: true })]).length, 1);
});

test('stopAlertsDue text and rate limit', () => {
  const last = new Map();
  const miss = [pos('ETHUSDC', '-0.5')];
  assert.deepEqual(g.stopAlertsDue(miss, last, 1000, 600), ['SIN STOP: ETHUSDC SHORT 0.5']);
  assert.deepEqual(g.stopAlertsDue(miss, last, 1100, 600), []);
  assert.equal(g.stopAlertsDue(miss, last, 1700, 600).length, 1);
  g.stopAlertsDue([], last, 1800, 600);
  assert.equal(g.stopAlertsDue(miss, last, 1801, 600).length, 1);
});

test('newBreaches dedupes', () => {
  const al = new Set();
  assert.deepEqual(g.newBreaches({ b: 1, a: 1 }, al), ['a', 'b']);
  assert.deepEqual(g.newBreaches({ a: 1, c: 1 }, al), ['c']);
});

test('parseConfig validation', () => {
  assert.ok(g.parseConfig({ limit: '', tz: '-5' }).error);
  const r = g.parseConfig({ limit: '50', maxNotional: '', maxLev: '10', tz: '' });
  assert.deepEqual(r.cfg, { limit: 50, warn: 0.7, maxNotional: null, maxLev: 10, tz: -5 });
  assert.ok(g.parseConfig({ limit: '50', maxLev: '-1' }).error);
  assert.ok(g.parseConfig({ limit: '50', tz: '30' }).error);
});

test('tier gating is pure', () => {
  assert.equal(g.tierFor({ status: 'pro' }).tier, 'pro');
  for (const s of ['none', 'expired', 'invalid', 'unsupported']) {
    const t = g.tierFor({ status: s });
    assert.equal(t.tier, 'free');
    assert.equal(t.telegram, false);
    assert.equal(t.maxPositions, Infinity);
  }
  assert.equal(g.tierFor(null).tier, 'free');
  const ps = [{ ...pos('A'), notional: 1 }, { ...pos('B'), notional: 9 }];
  assert.deepEqual(g.monitoredPositions(ps, g.tierFor(null)).map((p) => p.symbol), ['A', 'B']);
  assert.equal(g.monitoredPositions(ps, g.tierFor({ status: 'pro' })).length, 2);
});

test('free tier: 3 positions contribute to daily loss breach and no-stop alerts', () => {
  const freeTier = g.tierFor(null);
  assert.equal(freeTier.tier, 'free');
  assert.equal(freeTier.maxPositions, Infinity);

  const p1 = { symbol: 'BTCUSDT', amt: '0.1', notional: 6000, unrealized: -30, positionSide: 'BOTH' };
  const p2 = { symbol: 'ETHUSDT', amt: '1.0', notional: 2500, unrealized: -25, positionSide: 'BOTH' };
  const p3 = { symbol: 'SOLUSDT', amt: '10', notional: 1500, unrealized: -20, positionSide: 'BOTH' };
  const all = [p1, p2, p3];

  const monitored = g.monitoredPositions(all, freeTier);
  assert.equal(monitored.length, 3);

  // If only 1 position was considered (-30), limit 50 wouldn't trigger (realized 0 + open -30 = -30 > -50).
  // But with all 3 positions: open = -75, dayPnl = -75 <= -50 -> daily_hit!
  const openPnl = monitored.reduce((a, p) => a + p.unrealized, 0);
  assert.equal(openPnl, -75);

  const cfg = { limit: 50, warn: 0.7 };
  const br = g.breaches(openPnl, monitored, {}, cfg);
  assert.ok(br.daily_hit, 'daily limit breach must trigger on sum of all 3 positions');
  assert.ok(br.daily_hit.includes('-75.00'));

  // Algo orders only has stop for BTCUSDT
  const algoOrders = [
    { symbol: 'BTCUSDT', side: 'SELL', orderType: 'STOP_MARKET', closePosition: true, positionSide: 'BOTH' },
  ];

  const unprot = g.unprotected(monitored, algoOrders);
  assert.equal(unprot.length, 2, 'both ETH and SOL must be flagged as unprotected');
  assert.deepEqual(unprot.map((p) => p.symbol).sort(), ['ETHUSDT', 'SOLUSDT']);

  const lastAlerts = new Map();
  const stopMsgs = g.stopAlertsDue(unprot, lastAlerts, 1000, 600);
  assert.equal(stopMsgs.length, 2);
  assert.ok(stopMsgs.some((m) => m.includes('ETHUSDT')));
  assert.ok(stopMsgs.some((m) => m.includes('SOLUSDT')));
});
