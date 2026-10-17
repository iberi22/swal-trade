import unittest
import tempfile
import os
from radar.store import RadarStore

class TestUserTradesLinking(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.store = RadarStore(os.path.join(self.tmp_dir.name, 'radar_trades.db'))

    def tearDown(self):
        self.tmp_dir.cleanup()

    def test_link_trade_within_15m_window(self):
        # Alert created at t=1000, triggered at t=1060
        aid = self.store.create_alert({
            'dedupe_key': 'k_trade_test',
            'symbol': 'BTCUSDC',
            'tf': '15m',
            'kind': 'fvg',
            'title': 'FVG',
            'direction': 'long',
            'entry': 82000.0,
            'stop': 81500.0,
            'target_1r': 82500.0,
            'target_2r': 83000.0,
            'created_at': 1700000000.0,
            'status': 'pending',
        })
        self.store.update_alert(aid, {'status': 'triggered', 'triggered_at': 1700000060.0})

        # Trade 1: 5 minutes after trigger (t = 1060 + 300 = 1360) -> within 15 min (900 s)
        trade = {
            'id': 'trade_001',
            'symbol': 'BTCUSDC',
            'orderId': 'ord_123',
            'side': 'BUY',
            'price': 82050.0,
            'qty': 0.1,
            'time': 1700000360.0 * 1000, # ms
            'realizedPnl': 0.0,
        }
        linked_id = self.store.link_user_trade(trade)
        self.assertEqual(linked_id, aid)

        alert = self.store.get_alert(aid)
        self.assertEqual(alert['taken_by_user'], 1)
        self.assertEqual(alert['user_entry'], 82050.0)

    def test_do_not_link_different_direction(self):
        aid = self.store.create_alert({
            'dedupe_key': 'k_trade_short',
            'symbol': 'BTCUSDC',
            'tf': '15m',
            'kind': 'fvg',
            'title': 'FVG',
            'direction': 'short',
            'entry': 82000.0,
            'stop': 82500.0,
            'target_1r': 81500.0,
            'target_2r': 81000.0,
            'created_at': 1700000000.0,
            'status': 'triggered',
        })
        self.store.update_alert(aid, {'triggered_at': 1700000060.0})

        # Trade with side BUY (long) on a short alert -> should not link
        trade = {
            'id': 'trade_002',
            'symbol': 'BTCUSDC',
            'side': 'BUY',
            'price': 82000.0,
            'qty': 0.1,
            'time': 1700000100.0 * 1000,
        }
        linked_id = self.store.link_user_trade(trade)
        self.assertIsNone(linked_id)

if __name__ == '__main__':
    unittest.main()
