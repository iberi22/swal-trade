"""Hermetic tests for radar.level_study (no network, hand-built synthetic candles)."""
import calendar
import json
import math
import os
import random
import tempfile
import unittest

from radar import level_study as ls


def mk(t, o, h, l, c):
    return {'time': t, 'open': o, 'high': h, 'low': l, 'close': c}


def flat_bars(n, start, price=100.0, step=300):
    return [mk(start + i * step, price, price + 0.1, price - 0.1, price) for i in range(n)]


def ref_ema(closes, period):
    """levels.ts `ema` verbatim (SMA seed), used as the reference for the parity test."""
    if period < 1 or len(closes) < period:
        return None
    k = 2 / (period + 1)
    value = sum(closes[:period]) / period
    for i in range(period, len(closes)):
        value = closes[i] * k + value * (1 - k)
    return value


def ref_bollinger(closes, period=20, mult=2):
    if len(closes) < period:
        return None
    window = closes[-period:]
    mid = sum(window) / period
    sd = math.sqrt(sum((c - mid) ** 2 for c in window) / period)
    return mid + mult * sd, mid - mult * sd


def walk_bars(n, seed, start=0, sigma=0.3, price=100.0):
    """Synthetic driftless random walk on 5m bars: gaussian steps with the sample mean removed (so the
    realised path has no drift contaminating the barrier race) and a tiny intrabar range."""
    rng = random.Random(seed)
    steps = [rng.gauss(0.0, sigma) for _ in range(n - 1)]
    mean = sum(steps) / len(steps)
    steps = [steps[0]] + [s - mean for s in steps]
    bars, close = [], price
    for i, step in enumerate(steps):
        prev = close
        close = prev + step
        bars.append(mk(start + i * 300, prev, max(prev, close) + 0.05, min(prev, close) - 0.05, close))
    return bars


class TestGrids(unittest.TestCase):
    def test_week_starts_on_monday(self):
        monday = calendar.timegm((2026, 10, 19, 0, 0, 0, 0, 0, 0))
        self.assertEqual(ls.bucket_start(monday, ls.W1), monday)
        self.assertEqual(ls.bucket_start(monday + 6 * 86400 + 86399, ls.W1), monday)
        self.assertEqual(ls.bucket_start(monday + 7 * 86400, ls.W1), monday + 7 * 86400)
        self.assertEqual(ls.bucket_start(monday - 1, ls.W1), monday - 7 * 86400)

    def test_epoch_is_thursday_so_not_a_week_start(self):
        # 1970-01-01 00:00 UTC was a Thursday: the week must start on 1969-12-29 (Monday).
        self.assertEqual(ls.bucket_start(0, ls.W1), -259200)
        self.assertEqual(ls.bucket_end(-259200, ls.W1), 345600)

    def test_month_grid(self):
        oct1 = calendar.timegm((2026, 10, 1, 0, 0, 0, 0, 0, 0))
        self.assertEqual(ls.bucket_start(calendar.timegm((2026, 10, 19, 13, 7, 0, 0, 0, 0)), ls.MONTH), oct1)
        self.assertEqual(ls.bucket_start(oct1 - 1, ls.MONTH), calendar.timegm((2026, 9, 1, 0, 0, 0, 0, 0, 0)))
        self.assertEqual(ls.bucket_end(oct1, ls.MONTH), calendar.timegm((2026, 11, 1, 0, 0, 0, 0, 0, 0)))
        dec1 = calendar.timegm((2026, 12, 1, 0, 0, 0, 0, 0, 0))
        self.assertEqual(ls.bucket_end(dec1, ls.MONTH), calendar.timegm((2027, 1, 1, 0, 0, 0, 0, 0, 0)))

    def test_aggregate_ohlc(self):
        start = calendar.timegm((2026, 10, 19, 0, 0, 0, 0, 0, 0))
        bars = [mk(start + i * 300, 100 + i, 101 + i, 99 + i, 100.5 + i) for i in range(12)]
        agg = ls.aggregate(bars, ls.H1)
        self.assertEqual(len(agg), 1)
        self.assertEqual(agg[0]['time'], start)
        self.assertEqual(agg[0]['open'], 100)
        self.assertEqual(agg[0]['close'], 111.5)
        self.assertEqual(agg[0]['high'], 112)
        self.assertEqual(agg[0]['low'], 99)

    def test_aggregate_week_boundary(self):
        monday = calendar.timegm((2026, 10, 19, 0, 0, 0, 0, 0, 0))
        bars = [mk(monday - 600, 90, 91, 89, 90), mk(monday - 300, 90, 92, 89, 91),
                mk(monday, 91, 95, 90, 94), mk(monday + 300, 94, 96, 93, 95)]
        agg = ls.aggregate(bars, ls.W1)
        self.assertEqual([c['time'] for c in agg], [monday - 7 * 86400, monday])
        self.assertEqual(agg[1]['open'], 91)
        self.assertEqual(agg[1]['high'], 96)


class TestLevels(unittest.TestCase):
    def setUp(self):
        self.monday = calendar.timegm((2026, 10, 19, 0, 0, 0, 0, 0, 0))
        # 25 days of 5m bars (enough for EMA50 on 4h and for the 1st of the month) with a zig-zag
        self.bars = []
        for i in range(25 * 288):
            base = 100 + 5 * math.sin(i / 37.0) + i * 0.01
            self.bars.append(mk(self.monday - 25 * 86400 + i * 300, base, base + 0.4, base - 0.4, base + 0.1))
        self.ctx = ls.Ctx(self.bars)
        self.t = self.monday - 86400 + 7 * 3600 + 600  # inside the series, 10 min into an hour
        self.price = 103.0

    def by_kind(self, ctx=None, t=None, price=None):
        out = {}
        levels = (ctx or self.ctx).levels(t or self.t, self.price if price is None else price)
        for kind, value in levels:
            out.setdefault(kind, []).append(value)
        return out

    def test_levels_ignore_everything_not_closed(self):
        """Nothing of the bar being evaluated, nor of the in-progress 1h/4h/day candle, may leak in:
        rewriting every 5m bar of the current hour must not move a single level (this is the documented
        deviation from levels.ts, which feeds the in-progress closes into the averages)."""
        before = self.by_kind()
        hour_start = self.t - 600
        tampered = [mk(b['time'], b['open'] * 3, b['high'] * 5, b['low'] * 0.1, b['close'] * 4)
                    if hour_start <= b['time'] <= self.t else b for b in self.bars]
        after = self.by_kind(ls.Ctx(tampered))
        self.assertEqual(before, after)
        self.assertTrue(before)

    def test_day_levels_match_levels_ts(self):
        t, price = self.t, self.price
        levels = self.by_kind()
        one = lambda k: levels[k][0]
        d1 = ls.aggregate(self.bars, ls.D1)
        di = max(i for i, c in enumerate(d1) if c['time'] <= t)
        today, prev = d1[di], d1[di - 1]
        pivot = (prev['high'] + prev['low'] + prev['close']) / 3
        self.assertAlmostEqual(one('dayOpen'), today['open'])
        self.assertAlmostEqual(one('prevDayHigh'), prev['high'])
        self.assertAlmostEqual(one('prevDayLow'), prev['low'])
        self.assertAlmostEqual(one('pivot'), pivot)
        self.assertAlmostEqual(one('r1'), 2 * pivot - prev['low'])
        self.assertAlmostEqual(one('s1'), 2 * pivot - prev['high'])
        w1 = ls.aggregate(self.bars, ls.W1)
        wi = max(i for i, c in enumerate(w1) if c['time'] <= t)
        self.assertAlmostEqual(one('weekOpen'), w1[wi]['open'])
        self.assertAlmostEqual(one('prevWeekHigh'), w1[wi - 1]['high'])
        self.assertAlmostEqual(one('prevWeekLow'), w1[wi - 1]['low'])
        # data starts on 2026-09-24: the 1st of October is inside the history
        oct1 = calendar.timegm((2026, 10, 1, 0, 0, 0, 0, 0, 0))
        self.assertAlmostEqual(one('monthOpen'), [c for c in d1 if c['time'] == oct1][0]['open'])
        self.assertAlmostEqual(one('r1'), 2 * pivot - prev['low'])

    def test_month_open_missing_without_the_first_of_the_month(self):
        # levels.ts only sets monthOpen when the 1st of the month has a daily candle in history
        start = calendar.timegm((2026, 9, 5, 0, 0, 0, 0, 0, 0))
        bars = [mk(start + i * 300, 100, 100.2, 99.8, 100) for i in range(15 * 288)]
        t = start + 11 * 86400  # 2026-09-16: 1 September is NOT in the series
        kinds = dict(ls.Ctx(bars).levels(t, 100.0))
        self.assertNotIn('monthOpen', kinds)
        self.assertIn('dayOpen', kinds)
        # ... and it IS present once the 1st of the month has a daily candle
        start2 = calendar.timegm((2026, 9, 28, 0, 0, 0, 0, 0, 0))
        bars2 = [mk(start2 + i * 300, 100 + i * 0.001, 101, 99, 100) for i in range(10 * 288)]
        t2 = calendar.timegm((2026, 10, 2, 12, 0, 0, 0, 0, 0))
        kinds2 = dict(ls.Ctx(bars2).levels(t2, 100.0))
        self.assertIn('monthOpen', kinds2)

    def test_ema_and_bollinger_match_levels_ts(self):
        t = self.t
        levels = self.by_kind()
        one = lambda k: levels[k][0]
        h1 = ls.aggregate(self.bars, ls.H1)
        hc = self.ctx.closed('h1', t)
        # the in-progress 1h candle (the one containing t) is NOT used
        self.assertLess(h1[hc - 1]['time'] + 3600, t)
        self.assertGreaterEqual(h1[hc]['time'] + 3600, t)
        closes = [c['close'] for c in h1[:hc]]
        self.assertEqual(len(closes), hc)
        self.assertAlmostEqual(one('ema20_1h'), ref_ema(closes, 20), places=6)
        self.assertAlmostEqual(one('ema50_1h'), ref_ema(closes, 50), places=6)
        upper, lower = ref_bollinger(closes)
        self.assertAlmostEqual(one('bbUpper'), upper, places=6)
        self.assertAlmostEqual(one('bbLower'), lower, places=6)
        h4 = ls.aggregate(self.bars, ls.H4)
        closes4 = [c['close'] for c in h4[:self.ctx.closed('h4', t)]]
        self.assertAlmostEqual(one('ema50_4h'), ref_ema(closes4, 50), places=6)

    def test_ema_and_bollinger_states_match_direct_formulas(self):
        closes = [100 + math.sin(i / 7.0) * 3 + i * 0.05 for i in range(300)]
        states = ls.ema_states(closes, 20)
        for j in (20, 21, 120, 299, 300):
            self.assertAlmostEqual(states[j], ref_ema(closes[:j], 20), places=9)
        self.assertIsNone(states[19])
        bstates = ls.bollinger_states(closes, 20, 2)
        for j in (20, 57, 300):
            upper, lower = ref_bollinger(closes[:j])
            self.assertAlmostEqual(bstates[j]['upper'], upper, places=8)
            self.assertAlmostEqual(bstates[j]['lower'], lower, places=8)
        self.assertIsNone(bstates[19])
        self.assertIsNone(ls.bollinger(closes[:5]))

    def test_round_numbers(self):
        self.assertEqual(ls.round_step(82000), 1000)
        self.assertEqual(ls.round_step(3000), 100)
        self.assertEqual(ls.round_step(150), 10)
        self.assertEqual(ls.round_numbers(82_345.6), {'below': 82_000.0, 'above': 83_000.0})
        self.assertIsNone(ls.round_numbers(0))
        levels = ls.Ctx(flat_bars(400, self.monday, price=1234.0)).levels(self.monday + 399 * 300, 1234.0)
        self.assertEqual(sorted(p for k, p in levels if k == 'round'), [1200.0, 1300.0])

    def test_atr_wilder_matches_levels_ts(self):
        bars = [mk(i * 3600, 10, 11 + i, 9, 10 + i) for i in range(5)]
        atr = ls.atr_wilder(bars, period=2)
        self.assertIsNone(atr[0])
        self.assertIsNone(atr[1])
        # tr(i) = max(high-low, |high-prev_close|, |low-prev_close|) -> 3, 4, 5, 6 for i=1..4
        self.assertAlmostEqual(atr[2], (3 + 4) / 2)
        self.assertAlmostEqual(atr[3], (atr[2] * 1 + 5) / 2)
        self.assertAlmostEqual(atr[4], (atr[3] * 1 + 6) / 2)

    def test_trend_uses_closed_4h_ema(self):
        ctx = self.ctx
        t_up = self.monday - 3 * 86400  # rising zig-zag: 4h EMAs are warm and ema20 > ema50 or not
        self.assertIsNotNone(ctx.trend_up(t_up))
        early = self.bars[0]['time'] + 10 * 3600  # 4h EMA50 needs 50 candles: still warming up
        self.assertIsNone(ctx.trend_up(early))


class TestTouches(unittest.TestCase):
    """Touch bars close BELOW the level so the next bar is not automatically a support touch."""

    def plain(self, i):
        return mk(i * 300, 99, 99.2, 98.8, 99)

    def resistance_bar(self, i, high=100.5):
        return mk(i * 300, 99, high, 98.8, 99.5)

    def test_resistance_and_support_side(self):
        bars = [mk(0, 99, 99.2, 98.8, 99), mk(300, 99, 100.5, 98.9, 100.2),
                mk(600, 100.2, 101.0, 99.6, 99.8)]
        self.assertEqual(ls.touch_side(99, bars[1], 100.0), 'resistance')
        self.assertEqual(ls.touch_side(100.2, bars[2], 100.0), 'support')
        self.assertIsNone(ls.touch_side(99, bars[1], 200.0))

    def test_find_touches_merges_close_repeats(self):
        bars = [self.plain(i) for i in range(40)]
        for i in (2, 7, 25):  # gaps of 5 and 18 bars
            bars[i] = self.resistance_bar(i)
        stats = {}
        events = ls.find_touches(bars, lambda t, p: [('pivot', 100.0)], lambda t: 1.0, stats=stats)
        self.assertEqual([e['i'] for e in events], [2, 25])
        self.assertEqual(stats['merged'], 1)
        self.assertTrue(all(e['side'] == 'resistance' for e in events))

    def test_twelve_bar_gap_is_a_fresh_event(self):
        bars = [self.plain(i) for i in range(40)]
        for i in (2, 14):
            bars[i] = self.resistance_bar(i)
        events = ls.find_touches(bars, lambda t, p: [('pivot', 100.0)], lambda t: 1.0)
        self.assertEqual([e['i'] for e in events], [2, 14])

    def test_level_value_change_starts_a_fresh_event(self):
        bars = [self.plain(i) for i in range(20)]
        for i in (2, 7):
            bars[i] = self.resistance_bar(i)
        levels = {2: 100.0, 7: 100.5}
        events = ls.find_touches(bars, lambda t, p: [('pivot', levels.get(t // 300, 100.5))],
                                 lambda t: 1.0)
        self.assertEqual([e['i'] for e in events], [2, 7])

    def test_kinds_are_counted_separately(self):
        bars = [self.plain(i) for i in range(10)]
        bars[3] = self.resistance_bar(3)
        levels = [('pivot', 100.0), ('r1', 100.0)]
        events = ls.find_touches(bars, lambda t, p: levels, lambda t: 1.0)
        self.assertEqual(sorted(e['kind'] for e in events), ['pivot', 'r1'])

    def test_round_pair_never_collides(self):
        # the round level below the price can only be support, the one above only resistance
        from radar.level_study import round_numbers
        rr = round_numbers(101.2)
        bars = [mk(0, 101.2, 101.2, 101.2, 101.2), mk(300, 101.2, 101.4, 99.5, 101.0)]
        self.assertEqual(ls.touch_side(101.2, bars[1], rr['below']), 'support')
        self.assertIsNone(ls.touch_side(101.2, bars[1], rr['above']))


class TestOutcome(unittest.TestCase):
    def _bars(self, rows):
        return [mk(i * 300, o, h, l, c) for i, (o, h, l, c) in enumerate(rows)]

    def test_reacted(self):
        rows = [(100, 100.2, 99.8, 100)] + [(100, 100.2, 98.5, 99.5)] + [(99.5, 99.6, 99.4, 99.5)] * 48
        bars = self._bars(rows)
        self.assertEqual(ls.resolve_outcome(bars, 0, 100.0, 'resistance', 1.0), 'reacted')

    def test_broke_on_close(self):
        rows = [(100, 100.2, 99.8, 100)] + [(100, 100.7, 99.9, 100.6)] + [(100.6, 100.7, 100.5, 100.6)] * 48
        bars = self._bars(rows)
        self.assertEqual(ls.resolve_outcome(bars, 0, 100.0, 'resistance', 1.0), 'broke')

    def test_both_in_one_bar_is_broke(self):
        rows = [(100, 100.2, 99.8, 100)] + [(100, 100.7, 98.5, 100.6)] + [(100.6, 100.7, 100.5, 100.6)] * 48
        bars = self._bars(rows)
        self.assertEqual(ls.resolve_outcome(bars, 0, 100.0, 'resistance', 1.0), 'broke')

    def test_unresolved(self):
        rows = [(100, 100.2, 99.8, 100)] + [(100, 100.2, 99.6, 100.1)] * 49
        bars = self._bars(rows)
        self.assertEqual(ls.resolve_outcome(bars, 0, 100.0, 'resistance', 1.0), 'unresolved')

    def test_support_side_is_mirrored(self):
        rows = [(100, 100.2, 99.8, 100)] + [(100, 101.5, 99.9, 100.4)] + [(100.4, 100.5, 100.3, 100.4)] * 48
        bars = self._bars(rows)
        self.assertEqual(ls.resolve_outcome(bars, 0, 100.0, 'support', 1.0), 'reacted')

    def test_window_boundaries(self):
        # exactly 48 bars after the touch must be measurable, one fewer must not
        rows = [(100, 100.2, 99.8, 100)] * 50
        self.assertEqual(ls.resolve_outcome(self._bars(rows), 1, 100.0, 'resistance', 1.0), 'unresolved')
        self.assertIsNone(ls.resolve_outcome(self._bars(rows), 2, 100.0, 'resistance', 1.0))
        self.assertIsNone(ls.resolve_outcome(self._bars(rows[:49]), 1, 100.0, 'resistance', 1.0))

    def test_zero_atr_is_not_counted(self):
        bars = self._bars([(100, 100.2, 99.8, 100)] * 60)
        self.assertIsNone(ls.resolve_outcome(bars, 0, 100.0, 'resistance', 0.0))
        self.assertIsNone(ls.resolve_outcome(bars, 0, 0.0, 'resistance', 1.0))


class TestBaseline(unittest.TestCase):
    def test_driftless_walk_baseline_is_near_one_third(self):
        """Driftless walk, 1.0 ATR reaction before a 0.5 ATR break -> 0.5/1.5 = 0.333 in continuous time.

        The tolerance is not hand-waved. Two effects pull in opposite directions once the rule is
        evaluated bar by bar: (a) the 48-bar horizon truncates the race, which favours the NEARER
        barrier (the 0.5 A break) and pushes the reaction share DOWN, and (b) a bar can jump over the
        nearer barrier without closing beyond it, which pushes it UP. With a 0.15 ATR step (sigma=0.15)
        they nearly cancel: the measured split is ~0.337, and 0.13 of the windows stay unresolved. The
        band asserted is [0.30, 0.38]; the test also asserts the direction of effect (b) by requiring
        that a bigger step gives a HIGHER reaction share.
        """
        rates = {}
        for sigma in (0.15, 0.3, 0.5):
            bars = walk_bars(20000, seed=5, sigma=sigma)
            table_r, table_s = ls.baseline_table(bars, lambda t: 1.0)
            side_rates = []
            for table in (table_r, table_s):
                reacted = sum(1 for v in table if v == 'reacted')
                broke = sum(1 for v in table if v == 'broke')
                side_rates.append(reacted / (reacted + broke))
            for rate in side_rates:
                self.assertLess(abs(rate - 1 / 3), 0.09, f'sigma={sigma} rate={rate:.3f}')
            rates[sigma] = sum(side_rates) / 2
        self.assertTrue(0.30 < rates[0.15] < 0.38, rates)
        self.assertGreater(rates[0.3], rates[0.15])
        self.assertGreater(rates[0.5], rates[0.3])

    def test_pool_and_probs_agree_with_the_permutation_limit(self):
        bars = walk_bars(6000, seed=3, sigma=0.15)
        table_r, table_s = ls.baseline_table(bars, lambda t: 1.0)
        valid = ls.valid_times(table_r, table_s)
        self.assertGreater(len(valid), 1000)
        pool_ = ls.baseline_pool(table_r, table_s, valid)
        self.assertEqual(len(pool_), 2 * len(valid))
        self.assertTrue({1, 2} <= set(pool_))
        self.assertTrue(set(pool_) <= {0, 1, 2})
        probs = ls.baseline_probs(table_r, table_s, valid)
        exact = probs['random'][0] / (probs['random'][0] + probs['random'][1])
        rates = ls.permutation_rates({'X': 1500}, {'X': pool_}, perms=400)
        mean = sum(rates) / len(rates)
        self.assertLess(abs(mean - exact), 0.02)  # ratio of random sums, so not exactly the expectation
        lo, hi = ls.band_of(rates)
        self.assertLess(lo, mean)
        self.assertGreater(hi, mean)
        self.assertEqual(ls.baseline_pool(table_r, table_s, []), [])
        self.assertIsNone(ls.baseline_probs(table_r, table_s, []))

    def test_empirical_baseline_is_deterministic_and_bounded(self):
        bars = walk_bars(6000, seed=3, sigma=0.15)
        table_r, table_s = ls.baseline_table(bars, lambda t: 1.0)
        valid = ls.valid_times(table_r, table_s)
        tables = {'BTCUSDT': {'table_r': table_r, 'table_s': table_s, 'valid': valid}}
        events = [{'symbol': 'BTCUSDT', 'side': 'resistance'}, {'symbol': 'BTCUSDT', 'side': 'support'}] * 20
        a = ls.empirical_baseline(events, tables, perms=60, seed=11)
        b = ls.empirical_baseline(events, tables, perms=60, seed=11)
        self.assertEqual(a['base_r'], b['base_r'])
        self.assertEqual(a['perm_rate'], b['perm_rate'])
        for key in ('base_r', 'base_b', 'bm_r', 'bm_b'):
            self.assertEqual(len(a[key]), len(events))
            self.assertTrue(all(0.0 <= v <= 1.0 for v in a[key]), key)
            self.assertTrue(all(v > 0 for v in a[key]), key)
        # a support event gets a different (mirrored) chance column than a resistance event
        self.assertNotAlmostEqual(a['bm_r'][0], a['bm_r'][1])
        self.assertAlmostEqual(a['base_r'][0], a['base_r'][1])
        lo, hi = a['band']
        self.assertLessEqual(lo, hi)
        self.assertTrue(0.0 <= lo and hi <= 1.0)
        self.assertEqual(a['n_valid_times'], len(valid))

    def test_empirical_baseline_without_valid_times(self):
        tables = {'X': {'table_r': [None], 'table_s': [None], 'valid': []}}
        out = ls.empirical_baseline([{'symbol': 'X', 'side': 'resistance'}] * 3, tables, perms=5)
        self.assertEqual(out['base_r'], [0.0, 0.0, 0.0])
        self.assertEqual(out['band'], (None, None))
        self.assertIsNone(out['perm_rate'])


class TestStats(unittest.TestCase):
    def test_wilson(self):
        lo, hi = ls.wilson(10, 20)
        self.assertTrue(0.25 < lo < 0.31)
        self.assertTrue(0.69 < hi < 0.75)
        self.assertEqual(ls.wilson(0, 0), (None, None))
        lo, hi = ls.wilson(0, 10)
        self.assertEqual(lo, 0.0)
        self.assertTrue(hi < 0.31)
        lo, hi = ls.wilson(10, 10)
        self.assertTrue(lo > 0.69)
        self.assertEqual(hi, 1.0)

    def _events(self, days=60, per_day=1, reacted=1, base_r=0.20, base_b=0.30):
        out = []
        for d in range(days):
            for _ in range(per_day):
                out.append({'day': d, 'outcome': 'reacted' if reacted else 'broke',
                            'base_r': base_r, 'base_b': base_b})
        return out

    def test_cluster_bootstrap_positive_lift(self):
        ci = ls.cluster_bootstrap(self._events())
        self.assertIsNotNone(ci)
        self.assertGreater(ci[0], 0.0)
        self.assertLessEqual(ci[0], ci[1])

    def test_cluster_bootstrap_negative_lift(self):
        ci = ls.cluster_bootstrap(self._events(reacted=0, base_r=0.20, base_b=0.30))
        self.assertLess(ci[1], 0.0)

    def test_cluster_bootstrap_needs_five_days(self):
        self.assertIsNone(ls.cluster_bootstrap(self._events(days=4)))

    def test_pooled_lift(self):
        totals = ls.pool(self._events(days=10))
        self.assertAlmostEqual(ls.lift_of(totals), 1.0 - 0.4)
        self.assertIsNone(ls.lift_of((0, 0, 0.0, 0.0)))

    def test_grade_rules(self):
        g = ls.grade_level
        self.assertEqual(g(29, (5.0, 9.0), 5.0, 5.0, 5), 'no_evidence')
        self.assertEqual(g(100, (1.0, 3.0), 2.0, 1.0, 4), 'promising')
        self.assertEqual(g(100, (1.0, 3.0), 2.0, -1.0, 4), 'no_evidence')  # second half fails
        self.assertEqual(g(100, (1.0, 3.0), 2.0, 1.0, 3), 'no_evidence')   # only 3 symbols agree
        self.assertEqual(g(100, (1.0, 3.0), None, 1.0, 5), 'no_evidence')   # missing half
        self.assertEqual(g(100, (-3.0, -1.0), -2.0, -2.0, 0), 'negative')
        self.assertEqual(g(100, (-1.0, 2.0), 1.0, 1.0, 5), 'no_evidence')   # CI contains 0
        self.assertEqual(g(100, None, 1.0, 1.0, 5), 'no_evidence')
        self.assertEqual(g(100, (0.0, 3.0), 1.0, 1.0, 5), 'no_evidence')    # CI touching 0 is not > 0

    def test_summarize_cell(self):
        events = []
        for d in range(45):
            events.append({'symbol': 'BTCUSDT', 'side': 'resistance', 'day': d, 'outcome': 'reacted',
                           'base_r': 0.2, 'base_b': 0.3, 'bm_r': 0.1, 'bm_b': 0.4, 'with_trend': True})
            events.append({'symbol': 'ETHUSDT', 'side': 'resistance', 'day': d, 'outcome': 'broke',
                           'base_r': 0.2, 'base_b': 0.3, 'bm_r': 0.1, 'bm_b': 0.4, 'with_trend': False})
        s = ls.summarize(events, day_split=22)
        self.assertEqual((s['n'], s['n_days'], s['reacted'], s['broke'], s['unresolved']), (90, 45, 45, 45, 0))
        self.assertAlmostEqual(s['rate'], 0.5)
        self.assertAlmostEqual(s['baseline'], 0.4)
        self.assertAlmostEqual(s['lift_pp'], 10.0)
        self.assertAlmostEqual(s['lift_matched_pp'], 30.0)  # matched baseline 0.1/(0.1+0.4)
        self.assertAlmostEqual(s['with_trend']['rate'], 1.0)
        self.assertAlmostEqual(s['against_trend']['rate'], 0.0)
        self.assertEqual(s['symbols_agree'], 1)
        self.assertIn(s['grade'], ls.GRADES)
        self.assertIsNone(s['baseline_band'][0])

    def test_summarize_without_matched_columns(self):
        events = [{'symbol': 'A', 'day': d, 'outcome': 'reacted', 'base_r': 0.2, 'base_b': 0.3,
                   'with_trend': None} for d in range(40)]
        s = ls.summarize(events, day_split=20)
        self.assertIsNone(s['lift_matched_pp'])
        self.assertEqual(s['with_trend'], {'n': 0, 'rate': None})


class TestBuildEvents(unittest.TestCase):
    def setUp(self):
        self.monday = calendar.timegm((2026, 10, 19, 0, 0, 0, 0, 0, 0))
        self.start = self.monday - 20 * 86400
        self.bars = []
        n = 20 * 288
        for i in range(n):
            base = 100 + 6 * math.sin(i / 53.0) + 4 * math.sin(i / 11.0)
            self.bars.append(mk(self.start + i * 300, base, base + 0.5, base - 0.5, base + 0.05))
        self.eval_start = self.start + 16 * 86400
        self.eval_end = self.start + 20 * 86400

    def test_events_carry_the_expected_columns(self):
        events, info = ls.build_events('BTCUSDT', self.bars, self.eval_start, self.eval_end)
        self.assertGreater(len(events), 20)
        self.assertGreater(info['n_valid_times'], 500)
        self.assertEqual(len(info['pool']), 2 * info['n_valid_times'])
        kinds = {e['kind'] for e in events}
        self.assertTrue(kinds <= set(ls.KIND_ORDER), kinds)
        self.assertIn('prevDayHigh', kinds)
        for e in events:
            self.assertTrue(self.eval_start <= e['t'] < self.eval_end)
            self.assertEqual(e['day'], e['t'] // 86400)
            self.assertIn(e['side'], ls.SIDES)
            self.assertIn(e['outcome'], ('reacted', 'broke', 'unresolved'))
            self.assertIn(e['with_trend'], (True, False, None))
            self.assertGreater(e['atr'], 0)
            for key in ('base_r', 'base_b', 'bm_r', 'bm_b'):
                self.assertGreater(e[key], 0.0, key)
            self.assertLessEqual(e['base_r'] + e['base_b'], 1.0)

    def test_cells_group_kind_and_side(self):
        events, info = ls.build_events('BTCUSDT', self.bars, self.eval_start, self.eval_end)
        cells = ls.cells_from_events(events, day_split=(self.eval_start // 86400) + 2,
                                     pools={'BTCUSDT': info['pool']}, perms=50)
        self.assertTrue(cells)
        keys = {(c['id'], c['side']) for c in cells}
        self.assertEqual(len(keys), len(cells))
        for c in cells:
            self.assertEqual(c['n'], c['reacted'] + c['broke'] + c['unresolved'])
            self.assertIn(c['grade'], ls.GRADES)
            lo, hi = c['baseline_band']
            self.assertLessEqual(lo, hi)
            self.assertLessEqual(hi, 1.0)

    def test_outcomes_are_deterministic(self):
        a, _ = ls.build_events('BTCUSDT', self.bars, self.eval_start, self.eval_end)
        b, _ = ls.build_events('BTCUSDT', self.bars, self.eval_start, self.eval_end)
        self.assertEqual([(e['t'], e['kind'], e['side'], e['outcome']) for e in a],
                         [(e['t'], e['kind'], e['side'], e['outcome']) for e in b])


class TestPatterns(unittest.TestCase):
    def test_patterns_from_jsonl(self):
        def row(i, kind, d, status, net_r, t):
            return json.dumps({'t': t, 'symbol': 'BTCUSDC', 'tf': '1h', 'kind': kind, 'direction': d,
                               'status': status, 'net_r': net_r, 'risk_pct': 0.005})

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'BTCUSDC_1h.jsonl')
            with open(path, 'w') as fh:
                fh.write(json.dumps({'meta': {'symbol': 'BTCUSDC', 'tf': '1h', 'days': 90,
                                              'baseline': {'candle_doji|long': 0.37}}}) + '\n')
                for i in range(40):
                    fh.write(row(i, 'candle_doji', 'long', 'win_1r' if i % 2 else 'loss',
                                 -0.5 if i % 2 else -1.0, 1_790_000_000 + i * 3600) + '\n')
                fh.write(row(99, 'candle_doji', 'long', 'expired', 0.0, 1_790_000_000) + '\n')
            # a smoke-test file (days < 30) and a non-audit jsonl must be ignored
            short = os.path.join(tmp, 'BTCUSDC_15m.jsonl')
            with open(short, 'w') as fh:
                fh.write(json.dumps({'meta': {'symbol': 'BTCUSDC', 'tf': '15m', 'days': 1,
                                              'baseline': {}}}) + '\n')
                fh.write(row(0, 'candle_doji', 'long', 'win_1r', 1.0, 1_790_000_000) + '\n')
            with open(os.path.join(tmp, 'other.jsonl'), 'w') as fh:
                fh.write('{"nope": 1}\n')
            out, used = ls.patterns_from_jsonl([path, short, os.path.join(tmp, 'other.jsonl')])
        self.assertEqual(used, ['BTCUSDC_1h.jsonl'])
        self.assertEqual(len(out), 1)
        cell = out[0]
        self.assertEqual((cell['kind'], cell['direction'], cell['n']), ('candle_doji', 'long', 40))
        self.assertAlmostEqual(cell['win_rate'], 0.5)
        self.assertAlmostEqual(cell['baseline'], 0.37)
        self.assertIsNotNone(cell['r_ci'])
        self.assertIn(cell['grade'], ls.GRADES)

    def test_missing_audit_files(self):
        out, used = ls.patterns_from_jsonl(['/nonexistent/x.jsonl'])
        self.assertEqual((out, used), ([], []))


class TestStatsDoc(unittest.TestCase):
    def test_schema_and_level_ids(self):
        cells = [{'id': 'prevDayHigh', 'side': 'resistance', 'n': 40, 'n_days': 20,
                  'reacted': 20, 'broke': 18, 'unresolved': 2, 'rate': 20 / 38,
                  'ci_low': 0.38, 'ci_high': 0.68, 'baseline': 0.33, 'lift_pp': 19.6,
                  'lift_ci': [2.0, 40.0], 'grade': 'promising',
                  'with_trend': {'n': 20, 'rate': 0.6}, 'against_trend': {'n': 20, 'rate': 0.5},
                  'first_half_lift_pp': 10.0, 'second_half_lift_pp': 12.0, 'symbols_agree': 4}]
        doc = ls.build_stats_doc(cells, [], ['BTCUSDT'], 90, '2026-10-19T00:00:00+00:00')
        self.assertEqual(doc['schema'], 'swal.glossary-stats.v1')
        self.assertEqual(doc['method'], 'replay_in_sample')
        self.assertEqual(doc['days'], 90)
        self.assertIsInstance(doc['caveat'], str)
        level = doc['levels'][0]
        for key in ('id', 'side', 'n', 'n_days', 'reacted', 'broke', 'unresolved', 'rate', 'ci_low',
                    'ci_high', 'baseline', 'lift_pp', 'lift_ci', 'grade', 'with_trend', 'against_trend',
                    'first_half_lift_pp', 'second_half_lift_pp', 'symbols_agree'):
            self.assertIn(key, level)
        self.assertEqual(level['lift_ci'], [2.0, 40.0])
        json.dumps(doc)  # must be serialisable as-is

    def test_kind_order_covers_the_extension_level_kinds(self):
        # ids must be exactly LevelKind strings from apps/extension/src/lib/context/levels.ts
        self.assertEqual(len(set(ls.KIND_ORDER)), len(ls.KIND_ORDER))
        ts = os.path.join(os.path.dirname(__file__), '..', '..', 'apps', 'extension', 'src', 'lib',
                          'context', 'levels.ts')
        if not os.path.exists(ts):
            self.skipTest('extension sources not present')
        with open(ts) as fh:
            src = fh.read()
        for kind in ls.KIND_ORDER:
            self.assertIn(f"'{kind}'", src)
        self.assertNotIn('confirm', ls.KIND_ORDER)  # finding-based levels are not these levels


if __name__ == '__main__':
    unittest.main()
