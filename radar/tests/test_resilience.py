import unittest
import time
import os
import tempfile
from unittest.mock import MagicMock, patch

from radar.store import RadarStore
from radar.retention import prune_alerts
from radar.__main__ import backoff_seconds, run_cycle, parse_args

class TestResilience(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmp_dir.name, 'radar_test.db')
        self.store = RadarStore(self.db_path)
        self.binance_client = MagicMock()
        self.core_source = MagicMock()
        self.symbols = ['BTCUSDC', 'ETHUSDC']
        self.tfs = ['15m']
        self.last_closed_times = {}
        self.state = {'errors': 0, 'last_scan': None, 'symbols': self.symbols, 'tfs': self.tfs}
        self.loop_count = 0

    def tearDown(self):
        self.tmp_dir.cleanup()

    def test_backoff_values(self):
        self.assertEqual(backoff_seconds(1), 2)
        self.assertEqual(backoff_seconds(3), 8)
        self.assertEqual(backoff_seconds(10), 60)

    @patch('radar.__main__.evaluate_alert_on_candles')
    def test_evaluate_alert_raises_for_one_of_three(self, mock_evaluate):
        # Create 3 active alerts
        for i in range(3):
            self.store.create_alert({
                'dedupe_key': f'key{i}',
                'symbol': 'BTCUSDC',
                'tf': '15m',
                'kind': 'fvg',
                'title': f'Alert {i}',
                'direction': 'long',
                'entry': 100,
                'stop': 90,
                'target_1r': 110,
                'target_2r': 120,
                'strength': 0.8,
                'status': 'pending',
                'created_at': time.time()
            })

        # mock fetch_klines to always return something
        self.binance_client.fetch_klines.return_value = [{'time': 1000, 'open': 100, 'high': 100, 'low': 100, 'close': 100}]

        # mock evaluate to raise on the second alert but not the others
        def side_effect(alert, candles):
            if alert['id'] == 2:
                raise ValueError("Evaluation failed")
            return {'status': 'win_1r', 'outcome_r': 1.0}

        mock_evaluate.side_effect = side_effect

        # Run cycle
        run_cycle(self.store, self.binance_client, self.core_source, self.symbols, self.tfs, self.last_closed_times, self.state, self.loop_count)

        # Check assertions
        self.assertEqual(self.state['errors'], 1)
        active_alerts = self.store.get_active_alerts()
        # alert 2 failed to update, so it's still active. 1 and 3 are win_1r so they are resolved.
        self.assertEqual(len(active_alerts), 1)
        self.assertEqual(active_alerts[0]['id'], 2)

    def test_fetch_klines_raises_for_btcusdc_but_ethusdc_succeeds(self):
        def side_effect(sym, tf, limit):
            if sym == 'BTCUSDC':
                raise ConnectionError("Network error")
            return [{'time': 1000, 'open': 100, 'high': 100, 'low': 100, 'close': 100}]

        self.binance_client.fetch_klines.side_effect = side_effect

        self.core_source.scan.return_value = [{
            'dedupe_key': 'eth_key',
            'symbol': 'ETHUSDC',
            'tf': '15m',
            'kind': 'fvg',
            'title': 'Alert ETH',
            'direction': 'long',
            'entry': 100,
            'stop': 90,
            'target_1r': 110,
            'target_2r': 120,
            'strength': 0.8,
        }]

        run_cycle(self.store, self.binance_client, self.core_source, self.symbols, self.tfs, self.last_closed_times, self.state, self.loop_count)

        # We had a failure for BTCUSDC 15m (1 error)
        self.assertEqual(self.state['errors'], 1)

        # ETHUSDC alert should be created
        alerts = self.store.list_alerts('all')
        self.assertEqual(len(alerts), 1)
        self.assertEqual(alerts[0]['symbol'], 'ETHUSDC')

    def test_prune_alerts_deletes_terminal_old_untaken(self):
        # Create an old terminal alert
        aid = self.store.create_alert({
            'dedupe_key': 'old_loss',
            'symbol': 'BTCUSDC',
            'tf': '15m',
            'kind': 'fvg',
            'title': 'Old',
            'direction': 'long',
            'entry': 100,
            'stop': 90,
            'target_1r': 110,
            'target_2r': 120,
            'strength': 0.8,
            'status': 'loss',
        })
        # Hack created_at to be old
        with self.store.get_connection() as conn:
            conn.execute("UPDATE alerts SET created_at = ? WHERE id = ?", (time.time() - 10 * 86400, aid))

        deleted = prune_alerts(self.store, 5)
        self.assertEqual(deleted, 1)
        self.assertEqual(len(self.store.list_alerts('all')), 0)

    def test_prune_alerts_preserves_taken_alerts(self):
        aid = self.store.create_alert({
            'dedupe_key': 'old_taken',
            'symbol': 'BTCUSDC',
            'tf': '15m',
            'kind': 'fvg',
            'title': 'Old Taken',
            'direction': 'long',
            'entry': 100,
            'stop': 90,
            'target_1r': 110,
            'target_2r': 120,
            'strength': 0.8,
            'status': 'win_1r',
        })
        with self.store.get_connection() as conn:
            conn.execute("UPDATE alerts SET created_at = ?, taken_by_user = 1 WHERE id = ?", (time.time() - 10 * 86400, aid))

        deleted = prune_alerts(self.store, 5)
        self.assertEqual(deleted, 0)
        self.assertEqual(len(self.store.list_alerts('all')), 1)

    def test_prune_alerts_preserves_recent_terminal(self):
        aid = self.store.create_alert({
            'dedupe_key': 'recent_loss',
            'symbol': 'BTCUSDC',
            'tf': '15m',
            'kind': 'fvg',
            'title': 'Recent',
            'direction': 'long',
            'entry': 100,
            'stop': 90,
            'target_1r': 110,
            'target_2r': 120,
            'strength': 0.8,
            'status': 'loss',
        })
        with self.store.get_connection() as conn:
            conn.execute("UPDATE alerts SET created_at = ? WHERE id = ?", (time.time() - 2 * 86400, aid))

        deleted = prune_alerts(self.store, 5)
        self.assertEqual(deleted, 0)
        self.assertEqual(len(self.store.list_alerts('all')), 1)

    def test_prune_alerts_preserves_pending(self):
        aid = self.store.create_alert({
            'dedupe_key': 'old_pending',
            'symbol': 'BTCUSDC',
            'tf': '15m',
            'kind': 'fvg',
            'title': 'Old Pending',
            'direction': 'long',
            'entry': 100,
            'stop': 90,
            'target_1r': 110,
            'target_2r': 120,
            'strength': 0.8,
            'status': 'pending',
        })
        with self.store.get_connection() as conn:
            conn.execute("UPDATE alerts SET created_at = ? WHERE id = ?", (time.time() - 10 * 86400, aid))

        deleted = prune_alerts(self.store, 5)
        self.assertEqual(deleted, 0)
        self.assertEqual(len(self.store.list_alerts('all')), 1)

    def test_prune_alerts_hourly_run_cycle(self):
        # Create an old terminal alert
        aid = self.store.create_alert({
            'dedupe_key': 'old_loss',
            'symbol': 'BTCUSDC',
            'tf': '15m',
            'kind': 'fvg',
            'title': 'Old',
            'direction': 'long',
            'entry': 100,
            'stop': 90,
            'target_1r': 110,
            'target_2r': 120,
            'strength': 0.8,
            'status': 'loss',
        })
        with self.store.get_connection() as conn:
            conn.execute("UPDATE alerts SET created_at = ? WHERE id = ?", (time.time() - 10 * 86400, aid))

        # Test it doesn't run if not 60 loops
        os.environ['RADAR_RETENTION_DAYS'] = '5'
        run_cycle(self.store, self.binance_client, self.core_source, self.symbols, self.tfs, self.last_closed_times, self.state, 59)
        self.assertEqual(len(self.store.list_alerts('all')), 1)

        # Test it runs if 60 loops
        run_cycle(self.store, self.binance_client, self.core_source, self.symbols, self.tfs, self.last_closed_times, self.state, 60)
        self.assertEqual(len(self.store.list_alerts('all')), 0)
        del os.environ['RADAR_RETENTION_DAYS']

if __name__ == '__main__':
    unittest.main()
