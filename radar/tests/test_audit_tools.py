import unittest

from radar.audit_collect import aggregate, ema_series, atr_pct_series
from radar.audit_report import stats, verdict
from radar.indicator_edge import rsi, macd_hist


def rows(wins, losses, win_r=0.9, loss_r=-1.1):
    return ([{'win': 1, 'net_r': win_r} for _ in range(wins)] + [{'win': 0, 'net_r': loss_r} for _ in range(losses)])


class AuditToolsTests(unittest.TestCase):
    def test_small_samples_are_never_a_verdict(self):
        self.assertIn('n<30', verdict(stats(rows(20, 5)), 0.5))

    def test_clearly_negative_cell_is_flagged_negative(self):
        s = stats(rows(40, 120))
        self.assertIn('NEGATIVA', verdict(s, 0.5))

    def test_positive_needs_the_interval_above_zero_and_above_the_random_control(self):
        s = stats(rows(150, 50))
        self.assertIn('positiva', verdict(s, 0.5))
        self.assertNotIn('positiva', verdict(s, 0.9))

    def test_aggregate_builds_hourly_bars_from_minutes(self):
        c1m = [{'time': 60 * i, 'open': i, 'high': i + 1, 'low': i - 1, 'close': i} for i in range(180)]
        bars = aggregate(c1m, 3600)
        self.assertEqual(len(bars), 3)
        self.assertEqual(bars[0]['high'], 60)
        self.assertEqual(bars[0]['close'], 59)

    def test_ema_and_atr_need_warmup(self):
        self.assertIsNone(ema_series([1.0] * 30, 20)[18])
        self.assertAlmostEqual(ema_series([2.0] * 30, 20)[25], 2.0)
        bars = [{'time': i, 'open': 10, 'high': 11, 'low': 9, 'close': 10} for i in range(30)]
        self.assertIsNone(atr_pct_series(bars)[5])
        self.assertAlmostEqual(atr_pct_series(bars)[20], 0.2)

    def test_rsi_extremes_and_macd_shape(self):
        up = [100 + i for i in range(60)]
        self.assertEqual(rsi(up)[-1], 100)
        down = [200 - i for i in range(60)]
        self.assertLess(rsi(down)[-1], 1)
        self.assertEqual(len(macd_hist(up)), 60)


if __name__ == '__main__':
    unittest.main()
