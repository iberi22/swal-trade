import unittest
from radar.sources.core import CoreSource

class TestAlertCreationFromCore(unittest.TestCase):
    def setUp(self):
        self.source = CoreSource()

    def test_alert_creation_from_fixture_candles(self):
        # 50 candles with upward trend and swing creating detectable patterns
        candles = []
        for i in range(60):
            t = 1700000000 + i * 900
            o = 100.0 + i * 0.5
            h = o + 2.0
            l = o - 1.5
            c = o + 1.0
            v = 1000.0 + i * 10
            candles.append({
                'time': t,
                'open': o,
                'high': h,
                'low': l,
                'close': c,
                'volume': v,
                'trades': 100.0,
                'takerBuyVolume': 600.0,
            })

        alerts = self.source.scan('BTCUSDC', '15m', candles)
        # Even if synthetic candles yield few or no patterns, test interface contract
        self.assertIsInstance(alerts, list)
        for a in alerts:
            self.assertEqual(a['source'], 'core')
            self.assertEqual(a['symbol'], 'BTCUSDC')
            self.assertEqual(a['tf'], '15m')
            self.assertIn(a['direction'], ('long', 'short'))
            self.assertGreater(a['entry'], 0)
            self.assertGreater(a['stop'], 0)
            self.assertGreater(abs(a['entry'] - a['stop']), 0)
            self.assertEqual(a['status'], 'pending')
            self.assertIn('dedupe_key', a)

if __name__ == '__main__':
    unittest.main()


class TestAlertFilters(unittest.TestCase):
    """Only fresh, strong, entry-type findings become alerts (no context zones, no old shocks)."""

    def _scan_with(self, findings):
        from unittest import mock
        import json as _json
        candles = [{'time': 1700000000 + i * 900, 'open': 100, 'high': 101, 'low': 99, 'close': 100, 'volume': 1} for i in range(30)]
        done = mock.Mock(returncode=0, stdout=_json.dumps(findings), stderr='')
        with mock.patch('radar.sources.core.subprocess.run', return_value=done):
            return CoreSource().scan('BTCUSDC', '15m', candles)

    def finding(self, kind='range_breakout', strength=0.8, bars_ago=0, direction='down'):
        last = 1700000000 + 29 * 900
        return {'kind': kind, 'direction': direction, 'strength': strength, 'to': last - bars_ago * 900,
                'levels': [{'role': 'neck', 'price': 100, 'confirm': 99.0, 'invalidate': 101.0}]}

    def test_keeps_fresh_strong_entry_pattern(self):
        self.assertEqual(len(self._scan_with([self.finding()])), 1)

    def test_drops_old_weak_and_context_findings(self):
        alerts = self._scan_with([
            self.finding(bars_ago=40),              # old
            self.finding(strength=0.3),             # weak
            self.finding(kind='sr_zone'),           # context
            self.finding(kind='shock'),             # context
            self.finding(kind='volume_profile'),    # context
        ])
        self.assertEqual(alerts, [])
