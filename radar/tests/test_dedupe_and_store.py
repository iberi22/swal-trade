import unittest
import tempfile
import os
from radar.store import RadarStore
from radar.sources.core import CoreSource

class TestDedupeAndStore(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmp_dir.name, 'radar_test.db')
        self.store = RadarStore(self.db_path)

    def tearDown(self):
        self.tmp_dir.cleanup()

    def test_dedupe_prevents_duplicate_active_alert(self):
        alert1 = {
            'dedupe_key': 'BTCUSDC:15m:double_top:short:82000.0:82500.0',
            'symbol': 'BTCUSDC',
            'tf': '15m',
            'kind': 'double_top',
            'title': 'Doble techo',
            'direction': 'short',
            'entry': 82000.0,
            'stop': 82500.0,
            'target_1r': 81500.0,
            'target_2r': 81000.0,
            'strength': 0.85,
            'status': 'pending',
        }
        id1 = self.store.create_alert(alert1)
        self.assertIsNotNone(id1)

        # Attempt to insert identical alert while pending
        id2 = self.store.create_alert(alert1)
        self.assertIsNone(id2, 'Duplicate active alert must be rejected by dedupe')

        # Different kind or level creates a new alert
        alert2 = dict(alert1)
        alert2['dedupe_key'] = 'BTCUSDC:15m:fvg_bearish:short:82100.0:82300.0'
        alert2['kind'] = 'fvg_bearish'
        id3 = self.store.create_alert(alert2)
        self.assertIsNotNone(id3)

    def test_resolved_alert_is_not_recreated_within_its_window(self):
        base = {'dedupe_key': 'ETHUSDC:15m:order_block_bearish:short:2457.31:2464.02', 'symbol': 'ETHUSDC',
                'tf': '15m', 'kind': 'order_block_bearish', 'title': 'Order block bajista', 'direction': 'short',
                'entry': 2457.31, 'stop': 2464.02, 'target_1r': 2450.6, 'target_2r': 2443.89, 'strength': 0.72,
                'status': 'pending', 'created_at': 1_000_000.0}
        first = self.store.create_alert(base)
        self.store.update_alert(first, {'status': 'win_2r'})
        again = dict(base, created_at=1_000_000.0 + 60 * 13)       # 13 min later, same setup
        self.assertIsNone(self.store.create_alert(again), 'a resolved setup must not come back as a new alert')
        later = dict(base, created_at=1_000_000.0 + 96 * 900 + 1)  # after its 96-bar window
        self.assertIsNotNone(self.store.create_alert(later))

    def test_stats_count_only_triggered_trades(self):
        def mk(i, status, triggered):
            a = {'dedupe_key': f'k{i}', 'symbol': 'BTCUSDC', 'tf': '15m', 'kind': 'fvg_bullish', 'title': 't',
                 'direction': 'long', 'entry': 100.0, 'stop': 90.0, 'target_1r': 110.0, 'target_2r': 120.0,
                 'strength': 0.7, 'status': 'pending', 'created_at': 1_000.0 + i}
            aid = self.store.create_alert(a)
            upd = {'status': status, 'net_r': 0.9 if status.startswith('win') else -1.0}
            if triggered:
                upd['triggered_at'] = 2_000.0 + i
            self.store.update_alert(aid, upd)
        mk(1, 'win_1r', True)
        mk(2, 'loss', True)
        mk(3, 'missed', False)        # entry passed before the alert existed
        mk(4, 'expired', False)       # never triggered
        overall = self.store.get_stats()['overall']
        self.assertEqual(overall['n_resolved'], 2)
        self.assertEqual(overall['win_rate_1r'], 0.5)
        self.assertEqual(overall['label'], 'sin evidencia (n<30)')

    def test_wal_mode_and_list_filtering(self):
        with self.store.get_connection() as conn:
            mode = conn.execute('PRAGMA journal_mode;').fetchone()[0]
            self.assertEqual(mode.lower(), 'wal')

        aid = self.store.create_alert({
            'dedupe_key': 'k1',
            'symbol': 'ETHUSDC',
            'tf': '1h',
            'kind': 'fvg',
            'title': 'FVG',
            'direction': 'long',
            'entry': 2500.0,
            'stop': 2400.0,
            'target_1r': 2600.0,
            'target_2r': 2700.0,
            'strength': 0.7,
            'status': 'pending',
        })
        self.assertEqual(len(self.store.list_alerts('active')), 1)
        self.assertEqual(len(self.store.list_alerts('resolved')), 0)

        # Resolve the alert
        self.store.update_alert(aid, {'status': 'win_1r', 'outcome_r': 1.0})
        self.assertEqual(len(self.store.list_alerts('active')), 0)
        self.assertEqual(len(self.store.list_alerts('resolved')), 1)
        self.assertEqual(len(self.store.list_alerts('all')), 1)

if __name__ == '__main__':
    unittest.main()
