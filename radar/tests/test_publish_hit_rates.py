import unittest
import os
import json
import tempfile
import random
import sys
from io import StringIO
from typing import Dict, Any, List

from radar.baseline import random_baseline_rate
from radar.publish_hit_rates import build_public_table, cli_main
from radar.store import RadarStore

class TestPublishHitRates(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmp_dir.name, 'test_publish.db')
        self.out_path = os.path.join(self.tmp_dir.name, 'hit-rates.public.json')
        self.store = RadarStore(self.db_path)

    def tearDown(self):
        self.tmp_dir.cleanup()

    def generate_random_walk(self, length: int, seed: int = 42) -> List[Dict[str, float]]:
        rng = random.Random(seed)
        candles = []
        price = 100.0
        for i in range(length):
            open_p = price
            close_p = price + rng.uniform(-0.1, 0.1)
            high_p = max(open_p, close_p) + rng.uniform(0, 0.05)
            low_p = min(open_p, close_p) - rng.uniform(0, 0.05)
            candles.append({'time': float(i), 'open': open_p, 'high': high_p, 'low': low_p, 'close': close_p})
            price = close_p
        return candles

    def test_baseline_deterministic(self):
        # 1. test_baseline_deterministic
        candles = self.generate_random_walk(500, seed=1)
        risks = [0.01]
        rate1 = random_baseline_rate(candles, risks, rr=1.0, cost_r=0.0008, samples=500, seed=99)
        rate2 = random_baseline_rate(candles, risks, rr=1.0, cost_r=0.0008, samples=500, seed=99)
        self.assertIsNotNone(rate1)
        self.assertEqual(rate1, rate2, "Baseline must be deterministic with same seed")

    def test_baseline_synthetic_random_walk(self):
        # 2. test_baseline_synthetic_random_walk
        candles = self.generate_random_walk(10000, seed=1337)
        risks = [0.008]
        rate = random_baseline_rate(candles, risks, rr=1.0, cost_r=0.0008, samples=5000, seed=42)
        self.assertTrue(0.40 <= rate <= 0.55, f"Rate {rate} is outside [0.40, 0.55]")

    def test_baseline_less_than_200_candles(self):
        # 3. test_baseline_less_than_200_candles
        candles = self.generate_random_walk(199, seed=3)
        risks = [0.01]
        rate = random_baseline_rate(candles, risks, rr=1.0, cost_r=0.0008, samples=10, seed=1)
        self.assertIsNone(rate)

    def test_build_public_table_schema_keys(self):
        # 4. test_build_public_table_schema_keys
        alerts = [
            {"kind": "p1", "tf": "15m", "symbol": "BTC", "direction": "long", "status": "win_1r", "net_r": 0.9, "taken_by_user": 0, "source": "core"}
        ]
        res = build_public_table(alerts, {"p1_15m_BTC_long": 0.45}, {"from": "2023", "to": "2024"}, "crypto")
        self.assertEqual(res["schema"], "swal.hit-rates.v1")
        self.assertIn("generated_at", res)
        self.assertEqual(res["period"], {"from": "2023", "to": "2024"})
        self.assertEqual(res["market"], "crypto")
        self.assertEqual(res["method"], "forward")
        self.assertEqual(res["cost_round_trip"], 0.0008)
        self.assertEqual(res["note"], "Medición pasada de alertas automáticas; no es una promesa ni una recomendación. Sin evidencia hasta n >= 30; validada solo con n >= 100 y por encima del azar.")
        self.assertEqual(len(res["cells"]), 1)
        cell = res["cells"][0]
        expected_keys = {"kind", "tf", "symbol", "direction", "n", "wins_1r", "rate_1r", "ci_low", "ci_high", "breakeven", "baseline_rate", "mean_net_r", "grade"}
        self.assertEqual(set(cell.keys()), expected_keys)
        self.assertEqual(cell["baseline_rate"], 0.45)

    def test_build_public_table_no_trade_data(self):
        # 5. test_build_public_table_no_trade_data
        alerts = [
            {"kind": "p1", "tf": "15m", "symbol": "BTC", "direction": "long", "status": "win_1r", "net_r": 0.9, "price": 10000, "time": 12345, "id": 1, "entry": 10000, "taken_by_user": 0}
        ]
        res = build_public_table(alerts, {}, {"from": "2023", "to": "2024"}, "crypto")
        cell = res["cells"][0]
        keys_str = " ".join(cell.keys())
        self.assertNotIn("price", keys_str)
        self.assertNotIn("time", keys_str)
        self.assertNotIn("id", keys_str)
        self.assertNotIn("entry", keys_str)
        self.assertNotIn("taken_by_user", keys_str)

    def test_build_public_table_excludes_replay(self):
        # 6. test_build_public_table_excludes_replay
        alerts = [
            {"kind": "p1", "tf": "15m", "symbol": "BTC", "direction": "long", "status": "win_1r", "net_r": 0.9, "source": "replay", "taken_by_user": 0},
            {"kind": "p1", "tf": "15m", "symbol": "BTC", "direction": "long", "status": "loss", "net_r": -1.0, "source": "core", "taken_by_user": 0}
        ]
        res = build_public_table(alerts, {}, {"from": "2023", "to": "2024"}, "crypto")
        self.assertEqual(len(res["cells"]), 1)
        self.assertEqual(res["cells"][0]["n"], 1)
        self.assertEqual(res["cells"][0]["wins_1r"], 0)

    def test_build_public_table_excludes_taken_by_user(self):
        # 7. test_build_public_table_excludes_taken_by_user
        alerts = [
            {"kind": "p1", "tf": "15m", "symbol": "BTC", "direction": "long", "status": "win_1r", "net_r": 0.9, "source": "core", "taken_by_user": 1},
            {"kind": "p1", "tf": "15m", "symbol": "BTC", "direction": "long", "status": "loss", "net_r": -1.0, "source": "core", "taken_by_user": 0}
        ]
        res = build_public_table(alerts, {}, {"from": "2023", "to": "2024"}, "crypto")
        self.assertEqual(len(res["cells"]), 1)
        self.assertEqual(res["cells"][0]["n"], 1)

    def test_build_public_table_empty_alerts(self):
        # 8. test_build_public_table_empty_alerts
        res = build_public_table([], {}, {"from": "2023", "to": "2024"}, "crypto")
        self.assertEqual(res["cells"], [])
        self.assertEqual(res["schema"], "swal.hit-rates.v1")

    def test_cli_help(self):
        # 9. test_cli_help
        with self.assertRaises(SystemExit) as cm:
            cli_main(['--help'], None)
        self.assertEqual(cm.exception.code, 0)

    def test_cli_offline_failure(self):
        # 10. test_cli_offline_failure
        alert = {
            'source': 'core', 'symbol': 'BTC', 'tf': '15m', 'kind': 'test', 'title': 'Test',
            'direction': 'long', 'entry': 100.0, 'stop': 90.0, 'target_1r': 110.0, 'target_2r': 120.0,
            'strength': 0.8, 'status': 'win_1r', 'created_at': 1.0, 'net_r': 0.9, 'dedupe_key': 'x'
        }
        aid = self.store.create_alert(alert)
        self.store.update_alert(aid, {'status': 'win_1r', 'net_r': 0.9})

        def mock_fetch_fail(symbol, tf, start, end):
            raise ConnectionError("No network")

        cli_main(['--out', self.out_path, '--db', self.db_path], fetch_klines_func=mock_fetch_fail)

        self.assertTrue(os.path.exists(self.out_path))
        with open(self.out_path, 'r') as f:
            data = json.load(f)

        self.assertEqual(len(data["cells"]), 1)
        self.assertIsNone(data["cells"][0]["baseline_rate"])

    def test_grade_integration_no_evidence(self):
        # 11. test_grade_integration_no_evidence
        alerts = [
            {"kind": "p1", "tf": "15m", "symbol": "BTC", "direction": "long", "status": "win_1r", "net_r": 0.9, "source": "core", "taken_by_user": 0}
        ] * 29  # n = 29
        res = build_public_table(alerts, {}, {"from": "2023", "to": "2024"}, "crypto")
        cell = res["cells"][0]
        self.assertEqual(cell["grade"], "no_evidence")

    def test_baseline_cost_evaluation(self):
        # 12. test_baseline_cost_evaluation
        # A test to show cost_r causes instant loss if stop_dist <= 0 (e.g. huge cost relative to risk)
        candles = self.generate_random_walk(500, seed=1)
        # risk_pct = 0.0001 (0.01%), but cost_r = 0.0008 (0.08%).
        # stop_dist = risk - entry * cost_r = entry * 0.0001 - entry * 0.0008 < 0!
        # It should return 0 hit rate because every trade instantly fails due to costs.
        risks = [0.0001]
        rate = random_baseline_rate(candles, risks, rr=1.0, cost_r=0.0008, samples=50, seed=1)
        self.assertEqual(rate, 0.0)

if __name__ == '__main__':
    unittest.main()
