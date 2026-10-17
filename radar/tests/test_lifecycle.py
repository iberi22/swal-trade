import unittest
from radar.evaluate import evaluate_alert_on_candles, cost_in_r

# Arming candles: the first close after the alert exists is on the near side of the entry.
ARM_LONG = {'time': 1030.0, 'open': 98.0, 'high': 99.5, 'low': 97.5, 'close': 99.0}
ARM_SHORT = {'time': 1030.0, 'open': 2008.0, 'high': 2012.0, 'low': 2004.0, 'close': 2010.0}


class TestAlertLifecycle(unittest.TestCase):
    def setUp(self):
        self.base_long = {
            'id': 1,
            'symbol': 'BTCUSDC',
            'tf': '15m',
            'direction': 'long',
            'entry': 100.0,
            'stop': 90.0,
            'target_1r': 110.0,
            'target_2r': 120.0,
            'status': 'pending',
            'created_at': 1000.0,
            'mfe_r': 0.0,
            'mae_r': 0.0,
        }
        self.base_short = {
            'id': 2,
            'symbol': 'ETHUSDC',
            'tf': '1h',
            'direction': 'short',
            'entry': 2000.0,
            'stop': 2100.0,
            'target_1r': 1900.0,
            'target_2r': 1800.0,
            'status': 'pending',
            'created_at': 1000.0,
            'mfe_r': 0.0,
            'mae_r': 0.0,
        }

    def test_path1_trigger_and_win_1r(self):
        # Long triggers on close > 100.0, then candle touches target_1r (110.0)
        c1 = {'time': 1060.0, 'open': 99.0, 'high': 100.5, 'low': 98.0, 'close': 100.0001}
        c2 = {'time': 1120.0, 'open': 102.0, 'high': 111.0, 'low': 101.0, 'close': 108.0}
        res = evaluate_alert_on_candles(self.base_long, [ARM_LONG, c1, c2])
        self.assertEqual(res['status'], 'win_1r')
        self.assertEqual(res['outcome_r'], 1.0)
        self.assertAlmostEqual(res['net_r'], 1.0 - cost_in_r(100.0, 10.0), places=4)
        self.assertGreaterEqual(res['mfe_r'], 1.0)
        self.assertEqual(res['triggered_at'], 1060.0)
        self.assertEqual(res['resolved_at'], 1120.0)

    def test_path2_trigger_and_win_2r(self):
        # Long triggers on c1, then touches target_2r (120.0)
        c1 = {'time': 1060.0, 'open': 99.0, 'high': 100.5, 'low': 98.0, 'close': 100.0001}
        c2 = {'time': 1120.0, 'open': 103.0, 'high': 122.0, 'low': 102.0, 'close': 121.0}
        res = evaluate_alert_on_candles(self.base_long, [ARM_LONG, c1, c2])
        self.assertEqual(res['status'], 'win_2r')
        self.assertEqual(res['outcome_r'], 2.0)
        self.assertAlmostEqual(res['net_r'], 2.0 - cost_in_r(100.0, 10.0), places=4)
        self.assertGreaterEqual(res['mfe_r'], 2.0)

    def test_path3_trigger_and_loss(self):
        # Long triggers, then touches stop (90.0)
        c1 = {'time': 1060.0, 'open': 99.0, 'high': 100.5, 'low': 98.0, 'close': 100.0001}
        c2 = {'time': 1120.0, 'open': 103.0, 'high': 104.0, 'low': 89.0, 'close': 91.0}
        res = evaluate_alert_on_candles(self.base_long, [ARM_LONG, c1, c2])
        self.assertEqual(res['status'], 'loss')
        self.assertEqual(res['outcome_r'], -1.0)
        self.assertAlmostEqual(res['net_r'], -1.0 - cost_in_r(100.0, 10.0), places=4)
        self.assertGreaterEqual(res['mae_r'], 1.0)

    def test_path4_both_in_one_candle_conservative_loss(self):
        # Rule: if stop and target are both inside one candle, count it as loss — conservative
        c1 = {'time': 1060.0, 'open': 99.0, 'high': 100.5, 'low': 98.0, 'close': 100.0001}
        c_wild = {'time': 1120.0, 'open': 103.0, 'high': 115.0, 'low': 85.0, 'close': 105.0}
        res = evaluate_alert_on_candles(self.base_long, [ARM_LONG, c1, c_wild])
        self.assertEqual(res['status'], 'loss')
        self.assertEqual(res['outcome_r'], -1.0)

    def test_path5_untriggered_expired_24_candles(self):
        # 15m timeframe: 24 candles = 24 * 900 = 21600 seconds
        # Never closes beyond entry within 24 candles
        c_late = {'time': 1000.0 + 21601.0, 'open': 98.0, 'high': 99.5, 'low': 95.0, 'close': 97.0}
        res = evaluate_alert_on_candles(self.base_long, [c_late])
        self.assertEqual(res['status'], 'expired')
        self.assertEqual(res['outcome_r'], 0.0)

    def test_path6_triggered_expired_96_candles(self):
        # Triggered, but neither stop nor target touched within 96 candles (96 * 900 = 86400s)
        c1 = {'time': 1060.0, 'open': 99.0, 'high': 100.5, 'low': 98.0, 'close': 100.0001}
        c_timeout = {'time': 1000.0 + 86401.0, 'open': 103.0, 'high': 105.0, 'low': 95.0, 'close': 104.0}
        res = evaluate_alert_on_candles(self.base_long, [ARM_LONG, c1, c_timeout])
        self.assertEqual(res['status'], 'expired')
        self.assertIsNotNone(res['outcome_r'])

    def test_short_direction_lifecycle(self):
        # Short: entry 2000, stop 2100, target 1900
        # c1 closes beyond entry: close < 2000
        c1 = {'time': 1060.0, 'open': 2010.0, 'high': 2015.0, 'low': 1999.0, 'close': 1999.9999}
        c2 = {'time': 1120.0, 'open': 1995.0, 'high': 2000.0, 'low': 1890.0, 'close': 1895.0}
        res = evaluate_alert_on_candles(self.base_short, [ARM_SHORT, c1, c2])
        self.assertEqual(res['status'], 'win_1r')
        self.assertEqual(res['outcome_r'], 1.0)

    def test_result_never_carries_internal_keys(self):
        # An armed alert that then expires used to leak '_armed' into the dict that the radar
        # writes back column by column, crashing the daemon with 'no such column: _armed'.
        far = {'time': 1000.0 + 15 * 60 * 25, 'open': 98.0, 'high': 99.0, 'low': 97.0, 'close': 98.5}
        res = evaluate_alert_on_candles(self.base_long, [ARM_LONG, far])
        self.assertEqual(res['status'], 'expired')
        self.assertEqual([k for k in res if k.startswith('_')], [])

    def test_entry_already_passed_is_missed_not_a_trade(self):
        # The first close after creation is already beyond the entry: nobody could take it.
        c1 = {'time': 1060.0, 'open': 101.0, 'high': 112.0, 'low': 100.5, 'close': 111.0}
        res = evaluate_alert_on_candles(self.base_long, [c1])
        self.assertEqual(res['status'], 'missed')
        self.assertIsNone(res['outcome_r'])

    def test_fill_is_trigger_close_and_outcome_waits_for_next_candle(self):
        # Trigger candle closes at 102 (fill) and its own high reaches 125: that must NOT count.
        c1 = {'time': 1060.0, 'open': 99.0, 'high': 125.0, 'low': 98.0, 'close': 102.0}
        res = evaluate_alert_on_candles(self.base_long, [ARM_LONG, c1])
        self.assertEqual(res['status'], 'triggered')
        self.assertEqual(res['entry'], 102.0)
        self.assertEqual(res['target_1r'], 114.0)   # risk = 102 - 90
        c2 = {'time': 1120.0, 'open': 102.0, 'high': 113.0, 'low': 101.0, 'close': 112.0}
        res = evaluate_alert_on_candles(res, [ARM_LONG, c1, c2])
        self.assertEqual(res['status'], 'triggered')  # 113 < 114: no win yet


if __name__ == '__main__':
    unittest.main()
