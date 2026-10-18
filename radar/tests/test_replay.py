import unittest
import tempfile
import os
import sqlite3
import json
import subprocess
import sys
from radar.klines_cache import load_klines
from radar.replay import replay, _aggregate_candles, _compute_trend_aligned, _calc_ema

class TestReplay(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp_dir.cleanup()

    def test_cli_refuses_forward_db(self):
        forward_db = os.path.join(self.tmp_dir.name, 'radar.db')
        os.environ['RADAR_DB'] = forward_db

        env = os.environ.copy()
        env['PYTHONPATH'] = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
        res = subprocess.run([
            sys.executable, '-m', 'radar.replay',
            '--symbol', 'BTCUSDC',
            '--tf', '15m',
            '--days', '1',
            '--out', 'summary.json',
            '--db', forward_db
        ], capture_output=True, text=True, env=env)

        self.assertNotEqual(res.returncode, 0)
        self.assertIn('cannot be the forward radar database', res.stdout + res.stderr)

    def test_pagination_logic_in_load_klines(self):
        calls = []
        def fake_fetch(symbol, tf, start_ms, limit):
            calls.append((start_ms, limit))

            if len(calls) == 1:
                return [{'time': 1000 + i * 900, 'open': 100, 'high': 105, 'low': 95, 'close': 100} for i in range(1500)]
            elif len(calls) == 2:
                return [{'time': 1000 + 1500 * 900 + i * 900, 'open': 100, 'high': 105, 'low': 95, 'close': 100} for i in range(1500)]
            elif len(calls) == 3:
                return [{'time': 1000 + 3000 * 900 + i * 900, 'open': 100, 'high': 105, 'low': 95, 'close': 100} for i in range(200)]
            return []

        cache_dir = os.path.join(self.tmp_dir.name, 'klines')
        candles = load_klines('BTCUSDC', '15m', 1000000, 1000000 + 3200*900*1000, fetch=fake_fetch, cache_dir=cache_dir)

        self.assertEqual(len(calls), 3)
        self.assertEqual(len(candles), 3200)
        times = [c['time'] for c in candles]
        self.assertEqual(times, sorted(list(set(times))))

    def test_no_lookahead_bias_in_scan(self):
        candles_detect = [{'time': i * 900, 'open': 1, 'high': 1, 'low': 1, 'close': 1} for i in range(400)]
        candles_1m = [{'time': i * 60, 'open': 1, 'high': 1, 'low': 1, 'close': 1} for i in range(6000)]

        scan_times = []
        def fake_scan(sym, tf, window_candles):
            if window_candles:
                scan_times.append(window_candles[-1]['time'])
            return []

        def fake_eval(a, c):
            return a

        replay(candles_detect, candles_1m, fake_scan, fake_eval, window=300)

        self.assertEqual(scan_times[0], candles_detect[299]['time'])
        self.assertEqual(len(scan_times), 101)

    def test_returned_alerts_have_source_replay(self):
        candles_detect = [{'time': i * 900, 'open': 1, 'high': 1, 'low': 1, 'close': 1} for i in range(301)]
        candles_1m = [{'time': i * 60, 'open': 1, 'high': 1, 'low': 1, 'close': 1} for i in range(6000)]

        def fake_scan(sym, tf, window_candles):
            return [{
                'symbol': sym,
                'tf': tf,
                'kind': 'test',
                'direction': 'long',
                'entry': 100,
                'stop': 90,
                'target_1r': 110,
                'target_2r': 120,
                'status': 'pending'
            }]

        def fake_eval(a, c):
            a['status'] = 'win_1r'
            a['outcome_r'] = 1.0
            a['net_r'] = 0.9
            return a

        alerts = replay(candles_detect, candles_1m, fake_scan, fake_eval, window=300)

        self.assertEqual(len(alerts), 2)
        for a in alerts:
            self.assertEqual(a['source'], 'replay')
            self.assertIn('features', a)

    def test_ema_calc(self):
        candles = [{'close': i} for i in range(1, 22)]
        ema20 = _calc_ema(candles, 20)
        self.assertIsNotNone(ema20)

    def test_aggregate_candles(self):
        candles = [
            {'time': 100, 'open': 10, 'high': 12, 'low': 9, 'close': 11},
            {'time': 200, 'open': 11, 'high': 15, 'low': 10, 'close': 14},
            {'time': 400, 'open': 14, 'high': 16, 'low': 13, 'close': 15}
        ]
        aggs = _aggregate_candles(candles, 300)
        self.assertEqual(len(aggs), 2)
        self.assertEqual(aggs[0]['time'], 0)
        self.assertEqual(aggs[0]['open'], 10)
        self.assertEqual(aggs[0]['high'], 15)
        self.assertEqual(aggs[0]['low'], 9)
        self.assertEqual(aggs[0]['close'], 14)

    def test_compute_trend_aligned(self):
        candles = [{'time': i * 3600, 'open': i, 'high': i, 'low': i, 'close': i} for i in range(1, 100)]
        res = _compute_trend_aligned(candles, 50 * 3600, 3600)
        self.assertTrue(res)

    def test_cli_help(self):
        env = os.environ.copy()
        env['PYTHONPATH'] = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
        res = subprocess.run([
            sys.executable, '-m', 'radar.replay', '--help'
        ], capture_output=True, text=True, env=env)
        self.assertEqual(res.returncode, 0)
        self.assertIn('--symbol', res.stdout)
        self.assertIn('--tf', res.stdout)
        self.assertIn('--days', res.stdout)
        self.assertIn('--out', res.stdout)
        self.assertIn('--db', res.stdout)

    def test_evaluator_sees_only_candles_after_the_alert(self):
        candles_detect = [{'time': i * 900, 'open': 1, 'high': 1, 'low': 1, 'close': 1} for i in range(301)]
        candles_1m = [{'time': i * 60, 'open': 1, 'high': 1, 'low': 1, 'close': 1} for i in range(30000)]
        seen = []

        def fake_scan(sym, tf, window_candles):
            return [{'symbol': sym, 'tf': tf, 'kind': 'test', 'direction': 'long', 'entry': 1, 'stop': 0.9,
                     'target_1r': 1.1, 'target_2r': 1.2, 'status': 'pending'}]

        def fake_eval(a, c):
            seen.append((a['created_at'], c[0]['time'], c[-1]['time']))
            return a

        replay(candles_detect, candles_1m, fake_scan, fake_eval, window=300)
        created, first, last = seen[0]
        self.assertEqual(created, candles_detect[299]['time'] + 900)
        self.assertEqual(first, created)
        self.assertLessEqual(last, created + 900 * 100)


if __name__ == '__main__':
    unittest.main()
