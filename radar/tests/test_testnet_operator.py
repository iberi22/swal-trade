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


class GuardTests(unittest.TestCase):
    def mv(self, **kw):
        a = alert(1)
        a.update({'source': 'movers', 'kind': 'mv_follow_15m_t3_a'})
        a.update(kw)
        return a

    def ign(self, a, sources=('core',), kinds=()):
        return op.ignored(a, set(sources), set(kinds))

    def test_sources_allowlist_defaults_to_core(self):
        self.assertFalse(self.ign(alert(1)))  # no source key -> core
        self.assertTrue(self.ign(self.mv(), sources=('core',), kinds=('mv_*',)))
        self.assertFalse(self.ign(self.mv(), sources=('core', 'movers'), kinds=('mv_*',)))

    def test_kinds_allowlist_exact_prefix_and_empty(self):
        k = ('movers',)
        self.assertTrue(self.ign(self.mv(), k, kinds=()))
        self.assertFalse(self.ign(self.mv(), k, kinds=('mv_follow_15m_t3_a',)))
        self.assertFalse(self.ign(self.mv(), k, kinds=('mv_follow_*',)))
        self.assertTrue(self.ign(self.mv(), k, kinds=('mv_fade_*',)))
        self.assertFalse(self.ign(alert(1), ('core', 'movers'), kinds=()))  # core unaffected

    def test_negative_grade_never_traded(self):
        self.assertTrue(self.ign(dict(alert(1), cell_grade='negative')))
        self.assertTrue(self.ign(self.mv(cell_grade='negative'), ('movers',), ('mv_*',)))
        self.assertFalse(self.ign(dict(alert(1), cell_grade='unproven')))

    def test_market_burst_skipped(self):
        k = ('movers',)
        self.assertTrue(self.ign(self.mv(kind='mv_market_follow'), k, ('mv_*',)))
        self.assertTrue(self.ign(self.mv(meta={'market_wide': True}), k, ('mv_*',)))
        self.assertFalse(self.ign(self.mv(meta={'market_wide': False}), k, ('mv_*',)))

    def gate(self, a=None, **kw):
        args = dict(symbols={'BTCUSDT'}, last_entry={}, entries=[], equity=5000, day_equity=5000,
                    fetch_price=lambda s: 100.2)
        args.update(kw)
        return op.gate(a or alert(1), NOW, **args)

    def test_gate_passes_clean_alert(self):
        self.assertIsNone(self.gate())

    def test_symbols_whitelist(self):
        self.assertEqual(self.gate(symbols={'ETHUSDT'}), 'skipped: symbol not in bot SYMBOLS')
        self.assertEqual(self.gate(symbols=set()), 'skipped: symbol not in bot SYMBOLS')

    def test_price_divergence_and_failure(self):
        self.assertEqual(self.gate(fetch_price=lambda s: 101.0), 'skipped: testnet price differs')
        self.assertEqual(self.gate(fetch_price=lambda s: 99.4), 'skipped: testnet price differs')

        def boom(s):
            raise OSError('x')
        self.assertEqual(self.gate(fetch_price=boom), 'skipped: no testnet price')

    def test_symbol_cooldown(self):
        self.assertEqual(self.gate(last_entry={'BTCUSDT': NOW - 3600}), 'skipped: symbol cooldown')
        self.assertIsNone(self.gate(last_entry={'BTCUSDT': NOW - 4 * 3600 - 1}))

    def test_hourly_cap(self):
        full = [NOW - 10, NOW - 600, NOW - 3000]
        self.assertEqual(self.gate(entries=full), 'skipped: hourly entry cap')
        self.assertIsNone(self.gate(entries=[NOW - 4000, NOW - 600, NOW - 3000]))

    def test_daily_stop(self):
        self.assertEqual(self.gate(equity=4900, day_equity=5000), 'skipped: daily stop')
        self.assertIsNone(self.gate(equity=4901, day_equity=5000))

    def test_day_start_equity_persists_within_day(self):
        import os
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, 'day.json')
            self.assertEqual(op.day_start_equity(p, 5000, NOW), 5000)
            self.assertEqual(op.day_start_equity(p, 4000, NOW + 60), 5000)
            self.assertEqual(op.day_start_equity(p, 4000, NOW + 86400), 4000)

    def test_confirmation_lines(self):
        pend = {1: ('BTCUSDT', NOW), 2: ('ETHUSDT', NOW), 3: ('SOLUSDT', NOW - 100)}
        out = op.confirm_step(pend, {'BTCUSDT'}, NOW + 10)
        self.assertEqual([(o['alert_id'], o['result']) for o in out],
                         [(1, 'confirmed open'), (3, 'dropped by bot')])
        self.assertEqual(list(pend), [2])  # still waiting inside the 90 s grace
        self.assertEqual(op.confirm_step(pend, set(), NOW + 91)[0]['result'], 'dropped by bot')
        self.assertEqual(pend, {})

    def test_rebuild_state_ignores_skips(self):
        recs = [{'t': NOW, 'symbol': 'BTCUSDC', 'sizing': {'x': 1}, 'result': 'ok'},
                {'t': NOW + 1, 'symbol': 'ETHUSDC', 'sizing': {'x': 1}, 'result': 'skipped: daily stop'},
                {'alert_id': 1, 'result': 'confirmed open'}]
        last, ent = op.rebuild_state(recs)
        self.assertEqual((last, ent), ({'BTCUSDT': NOW}, [NOW]))

    def test_take_profit_only_when_requested(self):
        s = op.size_signal(5000, 100.0, 99.0, 0.25, 1500, 5)
        a = {'symbol': 'BTCUSDC', 'direction': 'long'}
        self.assertNotIn('take_profit_r', op.build_payload(a, s))
        self.assertEqual(op.build_payload(a, s, 1.0)['take_profit_r'], 1.0)


if __name__ == '__main__':
    unittest.main()
