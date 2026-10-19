import unittest

from radar import testnet_operator as op

NOW = 1_800_000_000.0


def alert(i, status='triggered', symbol='BTCUSDC', age=60, direction='long', taken=False):
    ts = datetime_z(NOW - age)
    return {'id': i, 'status': status, 'symbol': symbol, 'direction': direction, 'triggered_at': ts,
            'taken_by_user': taken, 'entry': 100.0, 'stop': 99.0}


def datetime_z(t):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(t, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


class SelectTests(unittest.TestCase):
    def pick(self, alerts, seen=(), open_syms=(), max_open=2):
        return [a['id'] for a in op.select_candidates(alerts, set(seen), set(open_syms), NOW, 360, max_open)]

    def test_only_fresh_triggered_alerts(self):
        self.assertEqual(self.pick([alert(1), alert(2, status='pending'), alert(3, age=900)]), [1])

    def test_seen_and_user_taken_are_skipped(self):
        self.assertEqual(self.pick([alert(1), alert(2, symbol='ETHUSDC', taken=True)], seen={1}), [])

    def test_one_position_per_symbol_and_the_open_cap(self):
        self.assertEqual(self.pick([alert(1), alert(2)]), [1])  # same symbol twice -> only the first
        self.assertEqual(self.pick([alert(1)], open_syms={'BTCUSDT'}), [])
        both = [alert(1), alert(2, symbol='ETHUSDC')]
        self.assertEqual(self.pick(both, max_open=1), [1])

    def test_usdc_symbols_map_to_the_usdt_testnet_account(self):
        self.assertEqual(op.bot_symbol('ETHUSDC'), 'ETHUSDT')
        self.assertEqual(op.bot_symbol('BTCUSDT'), 'BTCUSDT')


class SizingTests(unittest.TestCase):
    def test_loss_at_the_stop_matches_the_risk_budget(self):
        s = op.size_signal(5000, 100.0, 99.0, 0.25, 1500, 5)  # 1% stop, risk 12.5 USD -> notional 1250
        self.assertEqual(s['amount_usdt'], 1250.0)
        self.assertAlmostEqual(s['loss_at_stop_usd'], 12.5, places=1)
        self.assertEqual(s['leverage'], 1)

    def test_notional_is_capped(self):
        s = op.size_signal(5000, 100.0, 99.9, 0.25, 1500, 5)  # 0.1% stop would be 12500 notional
        self.assertEqual(s['amount_usdt'], 1500.0)
        self.assertLess(s['loss_at_stop_usd'], 12.5)

    def test_refuses_when_leverage_cap_is_exceeded_or_inputs_are_bad(self):
        self.assertIsNone(op.size_signal(100, 100.0, 99.0, 100, 10_000, 2))
        self.assertIsNone(op.size_signal(0, 100.0, 99.0, 0.25, 1500, 5))
        self.assertIsNone(op.size_signal(5000, 100.0, 100.0, 0.25, 1500, 5))

    def test_payload_shape(self):
        s = op.size_signal(5000, 100.0, 99.0, 0.25, 1500, 5)
        p = op.build_payload({'symbol': 'ETHUSDC', 'direction': 'short'}, s)
        self.assertEqual((p['symbol'], p['side']), ('ETHUSDT', 'SHORT'))
        self.assertEqual(p['stop_loss_pct'], 1.0)


if __name__ == '__main__':
    unittest.main()
