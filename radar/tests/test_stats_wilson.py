import unittest
from radar.store import wilson_interval, RadarStore
import tempfile
import os

class TestStatsAndWilson(unittest.TestCase):
    def test_wilson_interval_zero_and_known_values(self):
        # 0 trials
        res_zero = wilson_interval(0, 0)
        self.assertIsNone(res_zero['rate'])
        self.assertIsNone(res_zero['low'])
        self.assertIsNone(res_zero['high'])

        # 10 out of 20 (p = 0.5, n = 20)
        res = wilson_interval(10, 20)
        self.assertEqual(res['rate'], 0.5)
        self.assertTrue(0.25 < res['low'] < 0.35)
        self.assertTrue(0.65 < res['high'] < 0.75)

    def test_honesty_rule_sin_evidencia_until_n_30(self):
        tmp_dir = tempfile.TemporaryDirectory()
        store = RadarStore(os.path.join(tmp_dir.name, 'radar_stats.db'))

        # Insert 10 resolved alerts (n < 30)
        for i in range(10):
            aid = store.create_alert({
                'dedupe_key': f'k_{i}',
                'symbol': 'BTCUSDC',
                'tf': '15m',
                'kind': 'shock',
                'title': 'Choque',
                'direction': 'long',
                'entry': 100.0 + i,
                'stop': 90.0 + i,
                'target_1r': 110.0 + i,
                'target_2r': 120.0 + i,
                'strength': 0.7,
                'status': 'pending',
            })
            store.update_alert(aid, {
                'status': 'win_1r' if i % 2 == 0 else 'loss',
                'outcome_r': 1.0 if i % 2 == 0 else -1.0,
                'net_r': 0.95 if i % 2 == 0 else -1.05,
                'triggered_at': 1000.0,
            })

        stats = store.get_stats()
        overall = stats['overall']
        self.assertEqual(overall['n_resolved'], 10)
        self.assertEqual(overall['label'], 'sin evidencia (n<30)')
        self.assertIn('sin evidencia', stats['note'])

        # Add 25 more resolved alerts (total 35 >= 30)
        for i in range(10, 35):
            aid = store.create_alert({
                'dedupe_key': f'k_{i}',
                'symbol': 'BTCUSDC',
                'tf': '15m',
                'kind': 'shock',
                'title': 'Choque',
                'direction': 'long',
                'entry': 100.0 + i,
                'stop': 90.0 + i,
                'target_1r': 110.0 + i,
                'target_2r': 120.0 + i,
                'strength': 0.7,
                'status': 'pending',
            })
            store.update_alert(aid, {
                'status': 'win_1r',
                'outcome_r': 1.0,
                'net_r': 0.95,
                'triggered_at': 1000.0,
            })

        stats35 = store.get_stats()
        self.assertEqual(stats35['overall']['n_resolved'], 35)
        self.assertNotEqual(stats35['overall']['label'], 'sin evidencia (n<30)')
        self.assertIsNotNone(stats35['overall']['ci_1r']['low'])
        self.assertIsNotNone(stats35['overall']['ci_1r']['high'])

        tmp_dir.cleanup()

if __name__ == '__main__':
    unittest.main()
