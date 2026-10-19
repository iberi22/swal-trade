import copy
import json
import os
import tempfile
import unittest

from radar import movers
from radar.evaluate import evaluate_alert_on_candles
from radar.store import RadarStore

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'movers')
SPEC = movers.load_spec()
BAR = 300000


def mkbars(closes, start=1_760_000_100_000, vol=100.0, hl=0.001):
    out, prev = [], closes[0]
    for n, c in enumerate(closes):
        out.append({'open_time_ms': start + n * BAR, 'open': prev, 'high': max(prev, c) * (1 + hl),
                    'low': min(prev, c) * (1 - hl), 'close': c, 'volume': vol, 'quote_volume': vol * c,
                    'taker_buy_volume': vol * 0.5})
        prev = c
    return out


def fixture_bars():
    with open(os.path.join(FIX, 'klines_sample.json')) as f:
        return movers.bars_from_klines(json.load(f))


class TestSpec(unittest.TestCase):
    def test_spec_values(self):
        self.assertEqual(SPEC['spec'], 'swal.movers-spec.v1')
        self.assertEqual(SPEC['thresholds_pct'], [3, 5, 7])
        self.assertEqual(SPEC['signals']['move30']['window_min'], 30)
        self.assertEqual(SPEC['cooldown_min'], 480)

    def test_sha_is_stable_and_sensitive(self):
        self.assertEqual(movers.spec_sha(SPEC), movers.spec_sha(copy.deepcopy(SPEC)))
        self.assertEqual(len(movers.spec_sha(SPEC)), 64)
        other = copy.deepcopy(SPEC)
        other['entry_atr'] = 0.3
        self.assertNotEqual(movers.spec_sha(SPEC), movers.spec_sha(other))

    def test_canonical_integral_floats(self):
        self.assertIn('"min_q24":100000000', movers.canonical_json({'min_q24': 1e8}))


class TestBars(unittest.TestCase):
    def test_bars_from_klines_fixture(self):
        bars = fixture_bars()
        self.assertEqual(len(bars), 45)
        b = bars[0]
        self.assertEqual(set(b), {'open_time_ms', 'open', 'high', 'low', 'close', 'volume', 'quote_volume',
                                  'taker_buy_volume'})
        with open(os.path.join(FIX, 'klines_sample.json')) as f:
            raw = json.load(f)[0]
        self.assertEqual(b['quote_volume'], float(raw[7]))
        self.assertEqual(b['taker_buy_volume'], float(raw[9]))
        self.assertEqual(b['volume'], float(raw[5]))

    def test_fixture_detects_jump(self):
        bars = fixture_bars()
        ev = movers.detect_events({'XUSDT': bars}, bars[40]['open_time_ms'], {'XUSDT': 3e7}, SPEC)
        self.assertEqual({(e['signal'], e['threshold']) for e in ev}, {('move15', 3), ('move30', 3)})
        self.assertTrue(all(e['move'] == 'up' and e['tier'] == 'mid' for e in ev))


class TestMetrics(unittest.TestCase):
    def test_ret_w(self):
        bars = mkbars([100, 101, 102, 103, 104, 105, 110])
        self.assertAlmostEqual(movers.ret_w(bars, 6, 6), 0.10)
        self.assertIsNone(movers.ret_w(bars, 5, 6))  # not enough history

    def test_ret_w_gap(self):
        bars = mkbars([100, 101, 102, 103, 104, 105, 110])
        del bars[3]
        self.assertIsNone(movers.ret_w(bars, 5, 5))
        self.assertIsNotNone(movers.ret_w(bars, 5, 2))  # window after the gap is intact

    def test_vol_tier_boundaries(self):
        self.assertEqual(movers.vol_tier(1e8, SPEC), 'hi')
        self.assertEqual(movers.vol_tier(99_999_999, SPEC), 'mid')
        self.assertEqual(movers.vol_tier(2e7, SPEC), 'mid')
        self.assertEqual(movers.vol_tier(1.9e7, SPEC), 'lo')
        self.assertEqual(movers.vol_tier(0, SPEC), 'lo')

    def test_vol_ratio(self):
        bars = mkbars([100.0] * 40)
        for k in range(34, 40):  # last W=6 bars carry 3x the volume
            bars[k]['quote_volume'] *= 3
        self.assertAlmostEqual(movers.vol_ratio(bars, 39, 6, SPEC), 3.0)
        self.assertIsNone(movers.vol_ratio(bars, 20, 6, SPEC))  # baseline does not fit

    def test_taker_imb(self):
        bars = mkbars([100.0] * 10)
        self.assertAlmostEqual(movers.taker_imb(bars, 9, 6), 0.0)
        for b in bars:
            b['taker_buy_volume'] = b['volume'] * 0.75
        self.assertAlmostEqual(movers.taker_imb(bars, 9, 6), 0.5)

    def test_atr14_simple_mean(self):
        closes = [100.0] * 20
        bars = mkbars(closes, hl=0.0)
        for b in bars:
            b['high'], b['low'] = 101.0, 99.0  # TR = 2 everywhere
        self.assertAlmostEqual(movers.atr14(bars, 19), 2.0)
        bars[19]['high'] = 106.0  # TR 7 on the last bar: (13*2 + 7)/14
        self.assertAlmostEqual(movers.atr14(bars, 19), 33 / 14)
        self.assertIsNone(movers.atr14(bars, 13))

    def test_atr_uses_prev_close(self):
        bars = mkbars([100.0] * 16, hl=0.0)
        for b in bars:
            b['high'], b['low'] = 100.0, 100.0
        bars[15]['open'] = bars[15]['high'] = bars[15]['low'] = bars[15]['close'] = 110.0
        self.assertAlmostEqual(movers.atr14(bars, 15), 10 / 14)

    def test_breadth_and_market_wide(self):
        rets = {'A': 0.04, 'B': 0.02, 'C': 0.01, 'D': -0.05, 'E': None}
        # T=3: same sign and abs >= 1.5 %: A, B -> 2 of the 4 valid
        self.assertAlmostEqual(movers.breadth(rets, 1, 3), 0.5)
        self.assertTrue(movers.market_wide(0.30, SPEC))
        self.assertFalse(movers.market_wide(0.29, SPEC))
        self.assertFalse(movers.market_wide(None, SPEC))

    def test_rel_btc(self):
        self.assertAlmostEqual(movers.rel_btc(0.05, 0.01), 0.04)
        self.assertIsNone(movers.rel_btc(0.05, None))


def universe(extra=None, flat=10):
    base = [100.0] * 60
    u = {'BTCUSDT': mkbars(base)}
    for k in range(flat):
        u[f'F{k}USDT'] = mkbars(base)
    u.update(extra or {})
    return u


class TestDetect(unittest.TestCase):
    def jump(self, level, at=50, n=60):
        c = [100.0] * at + [level] * (n - at)
        return mkbars(c)

    def t(self, k, start=1_760_000_100_000):
        return start + k * BAR

    def test_edge_trigger_no_retrigger(self):
        u = universe({'XUSDT': self.jump(104.0)})
        ev = movers.detect_events(u, self.t(50), {'XUSDT': 3e7}, SPEC)
        self.assertEqual(sorted((e['signal'], e['threshold']) for e in ev), [('move15', 3), ('move30', 3)])
        for k in (51, 52, 55):
            self.assertEqual(movers.detect_events(u, self.t(k), {'XUSDT': 3e7}, SPEC), [], k)

    def test_one_event_per_threshold(self):
        u = universe({'XUSDT': self.jump(108.0)})
        ev = movers.detect_events(u, self.t(50), {'XUSDT': 3e8}, SPEC)
        self.assertEqual([e['threshold'] for e in ev if e['signal'] == 'move30'], [3, 5, 7])
        self.assertTrue(all(e['tier'] == 'hi' for e in ev if e['symbol'] == 'XUSDT'))

    def test_below_threshold_and_down(self):
        u = universe({'XUSDT': self.jump(102.0), 'YUSDT': self.jump(94.0)})
        ev = movers.detect_events(u, self.t(50), {}, SPEC)
        self.assertEqual({e['symbol'] for e in ev}, {'YUSDT'})
        self.assertTrue(all(e['move'] == 'down' and e['tier'] == 'lo' for e in ev))

    def test_gap_means_no_event(self):
        bars = self.jump(104.0)
        del bars[48]
        u = universe({'XUSDT': bars})
        self.assertEqual(movers.detect_events(u, self.t(50), {}, SPEC), [])

    def test_event_fields_and_times(self):
        u = universe({'XUSDT': self.jump(104.0)})
        ev = [e for e in movers.detect_events(u, self.t(50), {'XUSDT': 3e7}, SPEC)
              if e['signal'] == 'move30'][0]
        self.assertEqual(ev['close_time_ms'], self.t(50) + BAR)
        self.assertEqual(ev['close'], 104.0)
        self.assertAlmostEqual(ev['rel_btc'], 0.04)
        self.assertIsNotNone(ev['atr14'])
        self.assertIsNotNone(ev['vol_ratio'])
        self.assertAlmostEqual(ev['taker_imb'], 0.0)
        self.assertFalse(ev['market_wide'])  # 1 mover of 12

    def test_market_wide(self):
        extra = {f'M{k}USDT': self.jump(104.0) for k in range(6)}
        u = universe(extra, flat=6)
        ev = movers.detect_events(u, self.t(50), {}, SPEC)
        self.assertTrue(ev and all(e['market_wide'] for e in ev))

    def test_signal_not_in_series(self):
        u = universe({'XUSDT': self.jump(104.0)})
        self.assertEqual(movers.detect_events(u, self.t(500), {}, SPEC), [])

    def test_fast2_not_detected(self):
        u = universe({'XUSDT': self.jump(104.0)})
        ev = movers.detect_events(u, self.t(50), {}, SPEC)
        self.assertNotIn('fast2', {e['signal'] for e in ev})


class TestPlans(unittest.TestCase):
    def ev(self, **kw):
        e = {'ret': 0.04, 'close': 100.0, 'atr14': 1.0}
        e.update(kw)
        return e

    def test_up_move_plans(self):
        p = movers.plans_for_event(self.ev(), SPEC)
        f, d = p['follow'], p['fade']
        self.assertEqual((f['direction'], d['direction']), ('long', 'short'))
        self.assertAlmostEqual(f['entry'], 100.25)
        self.assertAlmostEqual(f['stop'], 98.75)
        self.assertAlmostEqual(f['t1'], 101.75)
        self.assertAlmostEqual(f['t2'], 103.25)
        self.assertAlmostEqual(d['entry'], 99.75)
        self.assertAlmostEqual(d['stop'], 101.25)
        self.assertAlmostEqual(d['t1'], 98.25)
        self.assertAlmostEqual(d['t2'], 96.75)

    def test_entry_is_beyond_close_in_trade_direction(self):
        for ret in (0.05, -0.05):
            p = movers.plans_for_event(self.ev(ret=ret), SPEC)
            self.assertGreater(p['follow' if ret > 0 else 'fade']['entry'], 100.0)
            self.assertLess(p['fade' if ret > 0 else 'follow']['entry'], 100.0)

    def test_stop_floor(self):
        p = movers.plans_for_event(self.ev(atr14=0.04), SPEC)['follow']
        self.assertAlmostEqual(p['stop_dist'], 0.003 * p['entry'])

    def test_stop_cap_skips(self):
        self.assertEqual(movers.plans_for_event(self.ev(atr14=4.0), SPEC), {'follow': None, 'fade': None})
        p = movers.plans_for_event(self.ev(atr14=3.33), SPEC)
        self.assertIsNotNone(p['follow'])
        self.assertIsNone(p['fade'])

    def test_no_atr(self):
        self.assertEqual(movers.plans_for_event(self.ev(atr14=None), SPEC), {'follow': None, 'fade': None})


def sample_event(ret=0.04, atr=1.0, close=100.0):
    return {'symbol': 'XUSDT', 'signal': 'move30', 'window_min': 30, 'threshold': 3,
            'move': 'up' if ret > 0 else 'down', 'ret': ret, 'close': close, 'atr14': atr,
            'tier': 'mid', 'open_time_ms': 1_760_000_100_000, 'close_time_ms': 1_760_000_100_000 + BAR}


class TestAlertDict(unittest.TestCase):
    def test_shape(self):
        ev = sample_event()
        plan = movers.plans_for_event(ev, SPEC)['fade']
        a = movers.alert_dict('XUSDT', ev, plan, SPEC)
        self.assertEqual(a['source'], 'movers')
        self.assertEqual(a['tf'], '5m')
        self.assertEqual(a['kind'], 'mv_fade_30m_t3_mid')
        self.assertEqual(a['dedupe_key'], 'mv:XUSDT:move30:3:up:fade')
        self.assertEqual(a['direction'], 'short')
        self.assertEqual(a['strength'], 0.5)
        self.assertEqual(a['status'], 'pending')
        self.assertEqual(a['created_at'], (ev['open_time_ms'] + BAR) / 1000.0)
        self.assertEqual((a['entry'], a['stop'], a['target_1r'], a['target_2r']),
                         (plan['entry'], plan['stop'], plan['t1'], plan['t2']))
        self.assertIn('Sube 4,0 %', a['title'])
        self.assertIn('30 min', a['title'])

    def test_down_follow_title(self):
        ev = sample_event(ret=-0.062)
        a = movers.alert_dict('XUSDT', ev, movers.plans_for_event(ev, SPEC)['follow'], SPEC)
        self.assertTrue(a['title'].startswith('Baja 6,2 %'))
        self.assertEqual(a['direction'], 'short')
        self.assertEqual(a['dedupe_key'], 'mv:XUSDT:move30:3:down:follow')


def mini(sym, signal, move, T, k, mw=False):
    t0 = 1_760_000_100_000 + k * BAR
    return {'symbol': sym, 'signal': signal, 'move': move, 'threshold': T, 'window_min': 30,
            'open_time_ms': t0, 'close_time_ms': t0 + BAR, 'market_wide': mw}


class TestCooldown(unittest.TestCase):
    def setUp(self):
        self.tr = movers.CooldownTracker(SPEC)

    def kinds(self, evs):
        return [(o['type'], o['event']['threshold']) for o in self.tr.process(evs)]

    def test_new_then_suppressed(self):
        self.assertEqual(self.kinds([mini('A', 'move30', 'up', 3, 0)]), [('new', 3)])
        self.assertEqual(self.kinds([mini('A', 'move30', 'up', 3, 1)]), [])

    def test_escalation_updates(self):
        self.kinds([mini('A', 'move30', 'up', 3, 0)])
        out = self.tr.process([mini('A', 'move30', 'up', 5, 1)])
        self.assertEqual([(o['type'], o['prev_threshold']) for o in out], [('update', 3)])
        self.assertEqual(self.kinds([mini('A', 'move30', 'up', 5, 2)]), [])
        self.assertEqual(self.kinds([mini('A', 'move30', 'up', 3, 3)]), [])
        self.assertEqual(self.kinds([mini('A', 'move30', 'up', 7, 4)]), [('update', 7)])

    def test_keys_independent(self):
        self.kinds([mini('A', 'move30', 'up', 3, 0)])
        self.assertEqual(self.kinds([mini('A', 'move30', 'down', 3, 1)]), [('new', 3)])
        self.assertEqual(self.kinds([mini('A', 'move15', 'up', 3, 1)]), [('new', 3)])
        self.assertEqual(self.kinds([mini('B', 'move30', 'up', 3, 1)]), [('new', 3)])

    def test_same_bar_keeps_highest(self):
        self.assertEqual(self.kinds([mini('A', 'move30', 'up', 3, 0), mini('A', 'move30', 'up', 5, 0)]),
                         [('new', 5)])

    def test_cooldown_boundary(self):
        self.kinds([mini('A', 'move30', 'up', 3, 0)])
        self.assertEqual(self.kinds([mini('A', 'move30', 'up', 3, 95)]), [])   # 475 min after the open
        self.assertEqual(self.kinds([mini('A', 'move30', 'up', 3, 96)]), [('new', 3)])  # exactly 480

    def test_burst_collapses(self):
        evs = [mini(f'S{k}', 'move30', 'up', 3 if k else 5, 0, mw=True) for k in range(11)]
        evs.append(mini('Q', 'move30', 'up', 3, 0, mw=False))
        out = self.tr.process(evs)
        market = [o for o in out if o['event']['symbol'] == movers.MARKET_SYMBOL]
        self.assertEqual(len(market), 1)
        self.assertEqual(market[0]['event']['count'], 11)
        self.assertEqual(market[0]['event']['threshold'], 5)
        self.assertEqual(len(out), 2)  # the market row plus the isolated Q event
        self.assertEqual(self.tr.process([mini('S1', 'move30', 'up', 3, 1)]) and 0, 0)

    def test_not_collapsed_at_limit(self):
        evs = [mini(f'S{k}', 'move30', 'up', 3, 0, mw=True) for k in range(10)]
        out = self.tr.process(evs)
        self.assertEqual(len(out), 10)
        self.assertNotIn(movers.MARKET_SYMBOL, {o['event']['symbol'] for o in out})


class TestGoldens(unittest.TestCase):
    def test_goldens_match_disk(self):
        self.assertEqual(movers.check_goldens(), [])

    def test_golden_headers(self):
        for name in ('detect', 'plans', 'alerts', 'metrics', 'cooldown', 'burst'):
            with open(os.path.join(movers.GOLDEN_DIR, name + '.json')) as f:
                g = json.load(f)
            self.assertEqual(g['spec_sha'], movers.spec_sha(SPEC), name)
            self.assertEqual(g['spec_version'], SPEC['version'], name)

    def test_write_then_check_in_temp_dir(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(len(movers.check_goldens(d)), 6)  # all missing
            movers.write_goldens(d)
            self.assertEqual(movers.check_goldens(d), [])
            with open(os.path.join(d, 'plans.json'), 'a') as f:
                f.write(' ')
            self.assertEqual(movers.check_goldens(d), ['plans'])

    def test_cli_exit_codes(self):
        self.assertEqual(movers.main(['--golden', '--check']), 0)

    def test_goldens_cover_required_cases(self):
        def load(n):
            with open(os.path.join(movers.GOLDEN_DIR, n + '.json')) as f:
                return json.load(f)
        det = {c['name']: c for c in load('detect')['cases']}
        self.assertEqual(det['main_bar_after']['expected'], [])
        self.assertEqual({e['tier'] for e in det['main_signal_bar']['expected']}, {'hi', 'mid'})
        self.assertTrue(any(e['market_wide'] for e in det['wide_signal_bar']['expected']))
        self.assertTrue(any(not e['market_wide'] for e in det['idio_signal_bar']['expected']))
        plans = {c['name']: c for c in load('plans')['cases']}
        self.assertIsNone(plans['stop_cap_skip']['expected']['fade'])
        self.assertIn('update', {o['type'] for s in load('cooldown')['steps'] for o in s['expected']})
        self.assertIn('MARKET', {o['event']['symbol'] for s in load('burst')['steps'] for o in s['expected']})


class TestStoreAndEvaluator(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = RadarStore(os.path.join(self.tmp.name, 'radar.db'))
        self.ev = sample_event(atr=0.5)

    def tearDown(self):
        self.tmp.cleanup()

    def candles(self, start_s, closes):
        return [{'time': start_s + 60 * k, 'open': c, 'high': c * 1.0002, 'low': c * 0.9998, 'close': c}
                for k, c in enumerate(closes)]

    def alert_for(self, mode):
        plan = movers.plans_for_event(self.ev, SPEC)[mode]
        return plan, movers.alert_dict('XUSDT', self.ev, plan, SPEC)

    def test_store_accepts_alert_and_dedupes(self):
        plan, a = self.alert_for('follow')
        aid = self.store.create_alert(a)
        self.assertIsNotNone(aid)
        row = self.store.get_alert(aid)
        self.assertEqual((row['source'], row['tf'], row['kind'], row['status']),
                         ('movers', '5m', 'mv_follow_30m_t3_mid', 'pending'))
        self.assertEqual(row['created_at'], a['created_at'])
        self.assertIsNone(self.store.create_alert(a))

    def arming_candles(self, plan, a, first_close):
        # price walks from first_close to beyond the entry in 1m steps
        d = 1 if plan['direction'] == 'long' else -1
        closes = [first_close + d * k * 0.1 for k in range(0, 8)]
        return self.candles(a['created_at'], closes)

    def test_evaluator_arms_alert_with_offset_entry(self):
        for mode in ('follow', 'fade'):
            plan, a = self.alert_for(mode)
            aid = self.store.create_alert(dict(a, dedupe_key=a['dedupe_key'] + mode))
            row = self.store.get_alert(aid)
            d = 1 if plan['direction'] == 'long' else -1
            # first 1m close right at the signal close (near side of the entry), then it crosses
            res = evaluate_alert_on_candles(row, self.arming_candles(plan, a, self.ev['close'] + d * 0.1))
            self.assertIn(res['status'], ('triggered', 'win_1r', 'win_2r', 'loss', 'expired'), mode)
            self.assertNotEqual(res['status'], 'missed')
            self.assertIsNotNone(res.get('triggered_at'))

    def test_entry_equal_to_close_would_be_missed(self):
        # atr 0.5 -> offset 0.125. Price keeps going in the trade direction: the first 1m close after the
        # signal is already past the (unshifted) entry, so nobody could have taken it.
        plan, a = self.alert_for('follow')
        a_eq = dict(a, entry=self.ev['close'], stop=plan['stop'] - (plan['entry'] - self.ev['close']))
        first = self.ev['close'] + 0.05  # beyond close, still on the near side of the real entry (100.125)
        candles = self.candles(a['created_at'], [first, first + 0.2, first + 0.4])
        self.assertEqual(evaluate_alert_on_candles(dict(a_eq, mfe_r=0.0, mae_r=0.0), candles)['status'], 'missed')
        armed = evaluate_alert_on_candles(dict(a, mfe_r=0.0, mae_r=0.0), candles)
        self.assertNotEqual(armed['status'], 'missed')
        self.assertEqual(armed['status'], 'triggered')


if __name__ == '__main__':
    unittest.main()
