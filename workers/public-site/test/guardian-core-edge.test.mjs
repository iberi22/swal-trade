import test from 'node:test';
import assert from 'node:assert/strict';
import * as g from '../static/guardian/guardian-core.js';

// Helpers
const pos = (symbol = 'BTCUSDC', amt = '0.01', positionSide = 'BOTH') => ({ symbol, amt, notional: 500, unrealized: 0, positionSide });
const algo = (symbol = 'BTCUSDC', side = 'SELL', orderType = 'STOP_MARKET', kw = {}) => ({ symbol, side, orderType, ...kw });

// --- dayStartMs ---

test('dayStartMs offset -5', () => {
  const midnight = Date.UTC(2026, 9, 9, 5, 0); // 00:00 in UTC-5 is 05:00 UTC
  assert.equal(g.dayStartMs(midnight, -5), midnight);
  assert.equal(g.dayStartMs(midnight - 1, -5), midnight - 86400000);
  assert.equal(g.dayStartMs(midnight + 1, -5), midnight);
});

test('dayStartMs offset 0', () => {
  const midnight = Date.UTC(2026, 9, 9, 0, 0); // 00:00 in UTC
  assert.equal(g.dayStartMs(midnight, 0), midnight);
  assert.equal(g.dayStartMs(midnight - 1, 0), midnight - 86400000);
  assert.equal(g.dayStartMs(midnight + 1, 0), midnight);
});

test('dayStartMs offset 5.5', () => {
  const midnight = Date.UTC(2026, 9, 8, 18, 30); // 00:00 in UTC+5.5 is 18:30 UTC previous day
  assert.equal(g.dayStartMs(midnight, 5.5), midnight);
  assert.equal(g.dayStartMs(midnight - 1, 5.5), midnight - 86400000);
  assert.equal(g.dayStartMs(midnight + 1, 5.5), midnight);
});

test('dayStartMs offset 13', () => {
  const midnight = Date.UTC(2026, 9, 8, 11, 0); // 00:00 in UTC+13 is 11:00 UTC previous day
  assert.equal(g.dayStartMs(midnight, 13), midnight);
  assert.equal(g.dayStartMs(midnight - 1, 13), midnight - 86400000);
  assert.equal(g.dayStartMs(midnight + 1, 13), midnight);
});

// --- realizedUsd ---

test('realizedUsd ignores non-USD assets', () => {
  const rows = [
    { incomeType: 'REALIZED_PNL', asset: 'BTC', income: '10' },
    { incomeType: 'REALIZED_PNL', asset: 'ETH', income: '-5' },
    { incomeType: 'REALIZED_PNL', asset: 'USDT', income: '1' }
  ];
  assert.equal(g.realizedUsd(rows), 1);
});

test('realizedUsd ignores non-PNL income types', () => {
  const rows = [
    { incomeType: 'TRANSFER', asset: 'USDT', income: '100' },
    { incomeType: 'DEPOSIT', asset: 'USDC', income: '50' },
    { incomeType: 'COMMISSION', asset: 'USDT', income: '-1' }
  ];
  assert.equal(g.realizedUsd(rows), -1);
});

test('realizedUsd sums negatives correctly', () => {
  const rows = [
    { incomeType: 'REALIZED_PNL', asset: 'USDT', income: '-10.5' },
    { incomeType: 'FUNDING_FEE', asset: 'USDC', income: '-0.5' }
  ];
  assert.equal(g.realizedUsd(rows), -11);
});

test('realizedUsd with empty and malformed rows', () => {
  assert.equal(g.realizedUsd([]), 0);
  assert.equal(g.realizedUsd([{}, { incomeType: 'REALIZED_PNL', asset: 'USDT', income: 'NaN' }]), NaN);
});

// --- positionsFrom ---

test('positionsFrom long position', () => {
  const p = g.positionsFrom({ positions: [{ symbol: 'BTCUSDT', positionAmt: '1.5', notional: '50000', unrealizedProfit: '100' }] });
  assert.deepEqual(p, [{ symbol: 'BTCUSDT', amt: '1.5', notional: 50000, unrealized: 100, positionSide: 'BOTH' }]);
});

test('positionsFrom short position', () => {
  const p = g.positionsFrom({ positions: [{ symbol: 'ETHUSDT', positionAmt: '-2', notional: '-4000', unrealizedProfit: '-50', positionSide: 'SHORT' }] });
  assert.deepEqual(p, [{ symbol: 'ETHUSDT', amt: '-2', notional: 4000, unrealized: -50, positionSide: 'SHORT' }]);
});

test('positionsFrom zero amount', () => {
  const p = g.positionsFrom({ positions: [{ symbol: 'BTCUSDT', positionAmt: '0', notional: '0', unrealizedProfit: '0' }] });
  assert.deepEqual(p, []);
});

test('positionsFrom missing positionSide defaults to BOTH', () => {
  const p = g.positionsFrom({ positions: [{ symbol: 'ADAUSDT', positionAmt: '10', notional: '10', unrealizedProfit: '0' }] });
  assert.deepEqual(p, [{ symbol: 'ADAUSDT', amt: '10', notional: 10, unrealized: 0, positionSide: 'BOTH' }]);
});

// --- breaches ---

test('breaches at limit boundaries', () => {
  const cfg = { limit: 100, warn: 0.7 };
  assert.deepEqual(Object.keys(g.breaches(-99.99, [], {}, cfg)), ['daily_warn']);
  assert.deepEqual(Object.keys(g.breaches(-100, [], {}, cfg)), ['daily_hit']);
  assert.deepEqual(Object.keys(g.breaches(-100.01, [], {}, cfg)), ['daily_hit']);
});

test('breaches at warn 0.7 boundary', () => {
  const cfg = { limit: 100, warn: 0.7 };
  assert.deepEqual(Object.keys(g.breaches(-69.99, [], {}, cfg)), []);
  assert.deepEqual(Object.keys(g.breaches(-70, [], {}, cfg)), ['daily_warn']);
  assert.deepEqual(Object.keys(g.breaches(-70.01, [], {}, cfg)), ['daily_warn']);
});

test('breaches max notional and max leverage boundaries', () => {
  const cfg = { limit: 100, warn: 0.7, maxNotional: 500, maxLev: 10 };
  const p = pos('BTCUSDC', '0.01', 'BOTH');
  p.notional = 500;
  assert.equal(g.breaches(0, [p], { BTCUSDC: 10 }, cfg)['notional:BTCUSDC'], undefined);
  p.notional = 500.01;
  assert.ok(g.breaches(0, [p], { BTCUSDC: 10 }, cfg)['notional:BTCUSDC']);

  assert.equal(g.breaches(0, [pos()], { BTCUSDC: 10 }, cfg)['lev:BTCUSDC'], undefined);
  assert.ok(g.breaches(0, [pos()], { BTCUSDC: 10.1 }, cfg)['lev:BTCUSDC']);
});

test('breaches max notional when missing maxNotional or maxLev cfg', () => {
  const cfg = { limit: 100, warn: 0.7 };
  const p = pos();
  p.notional = 10000;
  const res = g.breaches(0, [p], { BTCUSDC: 100 }, cfg);
  assert.equal(res['notional:BTCUSDC'], undefined);
  assert.equal(res['lev:BTCUSDC'], undefined);
});

// --- newBreaches ---

test('newBreaches dedupes and adds to alerted set', () => {
  const alerted = new Set(['a']);
  const br = { a: 'warn', b: 'hit', c: 'lev' };
  const fresh = g.newBreaches(br, alerted);
  assert.deepEqual(fresh, ['b', 'c']);
  assert.ok(alerted.has('a'));
  assert.ok(alerted.has('b'));
  assert.ok(alerted.has('c'));
});

// --- hasStop / unprotected ---

test('hasStop STOP_MARKET and TAKE_PROFIT_MARKET only', () => {
  const p = pos('BTCUSDC', '1', 'BOTH');
  assert.equal(g.hasStop(p, [algo('BTCUSDC', 'SELL', 'TAKE_PROFIT_MARKET', { closePosition: true })]), false);
  assert.equal(g.hasStop(p, [algo('BTCUSDC', 'SELL', 'STOP_MARKET', { closePosition: true })]), true);
});

test('hasStop reduceOnly vs not', () => {
  const p = pos('BTCUSDC', '1', 'BOTH');
  assert.equal(g.hasStop(p, [algo('BTCUSDC', 'SELL', 'STOP_MARKET', { reduceOnly: true })]), true);
  assert.equal(g.hasStop(p, [algo('BTCUSDC', 'SELL', 'STOP_MARKET', { reduceOnly: 'true' })]), true);
  assert.equal(g.hasStop(p, [algo('BTCUSDC', 'SELL', 'STOP_MARKET', { reduceOnly: 'false', closePosition: false })]), false);
});

test('hasStop wrong symbol', () => {
  const p = pos('ETHUSDC', '1', 'BOTH');
  assert.equal(g.hasStop(p, [algo('BTCUSDC', 'SELL', 'STOP_MARKET', { closePosition: true })]), false);
});

test('hasStop hedge position sides', () => {
  const p = pos('BTCUSDC', '1', 'LONG');
  assert.equal(g.hasStop(p, [algo('BTCUSDC', 'SELL', 'STOP_MARKET', { closePosition: true, positionSide: 'SHORT' })]), false);
  assert.equal(g.hasStop(p, [algo('BTCUSDC', 'SELL', 'STOP_MARKET', { closePosition: true, positionSide: 'LONG' })]), true);
});

test('unprotected filters correctly', () => {
  const p1 = pos('ETHUSDC', '1', 'BOTH');
  const p2 = pos('BTCUSDC', '1', 'BOTH');
  const a = algo('BTCUSDC', 'SELL', 'STOP_MARKET', { closePosition: true });
  assert.deepEqual(g.unprotected([p1, p2], [a]), [p1]);
});

// --- stopAlertsDue ---

test('stopAlertsDue throttling', () => {
  const missing = [pos('BTCUSDC', '1', 'BOTH')];
  const last = new Map();
  const out1 = g.stopAlertsDue(missing, last, 1000, 600);
  assert.deepEqual(out1, ['SIN STOP: BTCUSDC LONG 1']);
  assert.equal(last.get('BTCUSDC|LONG'), 1000);
  const out2 = g.stopAlertsDue(missing, last, 1599, 600);
  assert.deepEqual(out2, []);
  const out3 = g.stopAlertsDue(missing, last, 1600, 600);
  assert.deepEqual(out3, ['SIN STOP: BTCUSDC LONG 1']);
  assert.equal(last.get('BTCUSDC|LONG'), 1600);
});

test('stopAlertsDue throttling at every-1', () => {
  const missing = [pos('BTCUSDC', '-1', 'BOTH')];
  const last = new Map();
  last.set('BTCUSDC|SHORT', 1000);
  const out = g.stopAlertsDue(missing, last, 1099, 100);
  assert.deepEqual(out, []);
  const out2 = g.stopAlertsDue(missing, last, 1100, 100);
  assert.deepEqual(out2, ['SIN STOP: BTCUSDC SHORT 1']);
});

// --- parseConfig ---

test('parseConfig with strings, NaN, negatives, missing values and defaults', () => {
  assert.equal(g.parseConfig({ limit: 'abc' }).error, 'El límite diario debe ser mayor que 0.');
  assert.equal(g.parseConfig({ limit: '-10' }).error, 'El límite diario debe ser mayor que 0.');
  assert.equal(g.parseConfig({ limit: '0' }).error, 'El límite diario debe ser mayor que 0.');

  assert.equal(g.parseConfig({ limit: '10', maxNotional: '-5' }).error, 'Nocional y apalancamiento máximos deben ser positivos o vacíos.');
  assert.equal(g.parseConfig({ limit: '10', maxLev: '0' }).error, 'Nocional y apalancamiento máximos deben ser positivos o vacíos.');

  assert.equal(g.parseConfig({ limit: '10', tz: '15' }).error, 'Zona horaria fuera de rango (-12 a 14).');
  assert.equal(g.parseConfig({ limit: '10', tz: '-13' }).error, 'Zona horaria fuera de rango (-12 a 14).');

  const valid = g.parseConfig({ limit: '10', maxNotional: '500', maxLev: '5', tz: '0' });
  assert.deepEqual(valid.cfg, { limit: 10, warn: 0.7, maxNotional: 500, maxLev: 5, tz: 0 });

  const defaults = g.parseConfig({ limit: '10' });
  assert.deepEqual(defaults.cfg, { limit: 10, warn: 0.7, maxNotional: null, maxLev: null, tz: -5 });
});

// --- tierFor ---

test('tierFor license statuses', () => {
  assert.equal(g.tierFor(null).tier, 'free');
  assert.equal(g.tierFor({ status: 'none' }).tier, 'free');
  assert.equal(g.tierFor({ status: 'invalid' }).tier, 'free');
  assert.equal(g.tierFor({ status: 'early_access' }).tier, 'free');
  assert.equal(g.tierFor({ status: 'pro' }).tier, 'pro');

  assert.equal(g.tierFor({ status: 'pro' }).selfHostLink, true);
  assert.equal(g.tierFor({ status: 'invalid' }).selfHostLink, false);
});

// --- monitoredPositions ---

test('monitoredPositions cap behavior', () => {
  const p1 = { symbol: 'A', notional: 100 };
  const p2 = { symbol: 'B', notional: 500 };
  const p3 = { symbol: 'C', notional: 200 };
  const pos = [p1, p2, p3];

  const tFree = { maxPositions: Infinity };
  assert.deepEqual(g.monitoredPositions(pos, tFree), pos);

  const tCapped = { maxPositions: 2 };
  const capped = g.monitoredPositions(pos, tCapped);
  assert.equal(capped.length, 2);
  assert.equal(capped[0].symbol, 'B');
  assert.equal(capped[1].symbol, 'C');
});

// --- Parity tests from python ---

test('parity: test_long_with_close_position_stop', () => {
  assert.equal(g.hasStop(pos(), [algo('BTCUSDC', 'SELL', 'STOP_MARKET', { closePosition: true })]), true);
});

test('parity: test_reduce_only_string_true', () => {
  assert.equal(g.hasStop(pos(), [algo('BTCUSDC', 'SELL', 'STOP_MARKET', { reduceOnly: 'true' })]), true);
});

test('parity: test_wrong_side_symbol_or_type', () => {
  assert.equal(g.hasStop(pos(), [algo('BTCUSDC', 'BUY', 'STOP_MARKET', { closePosition: true })]), false);
  assert.equal(g.hasStop(pos(), [algo('ETHUSDC', 'SELL', 'STOP_MARKET', { closePosition: true })]), false);
  assert.equal(g.hasStop(pos(), [algo('BTCUSDC', 'SELL', 'TAKE_PROFIT_MARKET', { closePosition: true })]), false);
});

test('parity: test_stop_without_close_or_reduce_does_not_protect', () => {
  assert.equal(g.hasStop(pos(), [algo('BTCUSDC', 'SELL', 'STOP_MARKET', { closePosition: false, reduceOnly: false })]), false);
});

test('parity: test_short_needs_buy_stop', () => {
  assert.equal(g.hasStop(pos('BTCUSDC', '-0.01'), [algo('BTCUSDC', 'BUY', 'STOP_MARKET', { closePosition: true })]), true);
  assert.equal(g.hasStop(pos('BTCUSDC', '-0.01'), [algo('BTCUSDC', 'SELL', 'STOP_MARKET', { closePosition: true })]), false);
});

test('parity: test_hedge_position_side_must_match', () => {
  const p = pos('BTCUSDC', '0.01', 'LONG');
  assert.equal(g.hasStop(p, [algo('BTCUSDC', 'SELL', 'STOP_MARKET', { closePosition: true, positionSide: 'SHORT' })]), false);
  assert.equal(g.hasStop(p, [algo('BTCUSDC', 'SELL', 'STOP_MARKET', { closePosition: true, positionSide: 'LONG' })]), true);
});

test('parity: test_alert_text_and_rate_limit', () => {
  const last = new Map();
  const miss = [pos('ETHUSDC', '-0.5', 'BOTH')];
  assert.deepEqual(g.stopAlertsDue(miss, last, 1000, 600), ['SIN STOP: ETHUSDC SHORT 0.5']);
  assert.deepEqual(g.stopAlertsDue(miss, last, 1100, 600), []);
  assert.equal(g.stopAlertsDue(miss, last, 1700, 600).length, 1);
  g.stopAlertsDue([], last, 1800, 600);
  assert.equal(g.stopAlertsDue(miss, last, 1801, 600).length, 1);
});
