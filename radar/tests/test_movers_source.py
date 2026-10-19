import os
import sqlite3
import tempfile
import time
import unittest

from radar import movers
from radar.__main__ import run_cycle
from radar.movers_source import MoversSource
from radar.store import RadarStore

BAR = 300000
BAR_CLOSE = 1_760_000_100_000 - (1_760_000_100_000 % BAR)  # a bar boundary
NOW = BAR_CLOSE + 5000


def raw_rows(close_path, last_open):
    """Binance-shaped kline arrays ending at open time `last_open`."""
    n = len(close_path)
    rows = []
    prev = close_path[0]
    for k, c in enumerate(close_path):
        ot = last_open - (n - 1 - k) * BAR
        hi = max(prev, c) * 1.0005
        lo = min(prev, c) * 0.9995
        rows.append([ot, str(prev), str(hi), str(lo), str(c), '1000', ot + BAR - 1, str(1000 * c), 10, '500', '0', '0'])
        prev = c
    return rows


def flat(price=10.0, n=40):
    return [price] * n


def jump(price=10.0, mult=1.04, n=40):
    p = [price] * n
    p[-1] = price * mult
    return p


class FakeClient:
    def __init__(self, symbols, q24, paths, fail=()):
        self.symbols = symbols
        self.q24 = q24
        self.paths = paths
        self.fail = set(fail)
        self.used_weight_1m = None
        self.kline_calls = 0
        self.universe_calls = 0

    def fetch_exchange_info_universe(self, quotes=('USDT', 'USDC')):
        self.universe_calls += 1
        return list(self.symbols)

    def fetch_ticker_24hr(self):
        return dict(self.q24)

    def fetch_klines_raw(self, symbol, interval='5m', limit=40):
        self.kline_calls += 1
        if symbol in self.fail:
            return []
        return raw_rows(self.paths[symbol], BAR_CLOSE - BAR)


def make_client(jumpers=(), flats=8, q_jump=3e7, fail=(), jump_q=None):
    symbols = [f'F{k:02d}USDT' for k in range(flats)] + list(jumpers)
    q24 = {s: 5e7 for s in symbols}
    paths = {s: flat() for s in symbols}
    for j in jumpers:
        paths[j] = jump()
        q24[j] = (jump_q or {}).get(j, q_jump)
    return FakeClient(symbols, q24, paths, fail)


class TestMoversSource(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, 'm.db')
        self.store = RadarStore(self.db)

    def tearDown(self):
        self.tmp.cleanup()

    def test_alert_shape_and_kinds(self):
        c = make_client(['AAAUSDT'])
        res = MoversSource().scan_cycle(c, NOW)
        self.assertEqual(res['status'], 'ok')
        kinds = sorted(a['kind'] for a in res['alerts'])
        self.assertEqual(kinds, ['mv_fade_15m_t3_mid', 'mv_fade_30m_t3_mid', 'mv_follow_15m_t3_mid', 'mv_follow_30m_t3_mid'])
        for a in res['alerts']:
            self.assertEqual(a['source'], 'movers')
            self.assertEqual(a['tf'], '5m')
            self.assertEqual(a['created_at'], BAR_CLOSE / 1000.0)
            self.assertIn('ret', a['meta'])
        dirs = {a['kind']: a['direction'] for a in res['alerts']}
        self.assertEqual(dirs['mv_follow_30m_t3_mid'], 'long')
        self.assertEqual(dirs['mv_fade_30m_t3_mid'], 'short')

    def test_universe_filter_and_volume(self):
        c = make_client(['AAAUSDT', 'LOWUSDT'], jump_q={'LOWUSDT': 1e6})
        res = MoversSource().scan_cycle(c, NOW)
        self.assertTrue(all(a['symbol'] == 'AAAUSDT' for a in res['alerts']))
        self.assertEqual(res['symbols'], 9)  # 8 flat + AAA, LOW excluded by volume
        res2 = MoversSource(min_q24=1e5).scan_cycle(make_client(['LOWUSDT'], jump_q={'LOWUSDT': 1e6}), NOW)
        self.assertTrue(any(a['kind'].endswith('_lo') for a in res2['alerts']))

    def test_universe_cached_one_hour(self):
        c = make_client(['AAAUSDT'])
        src = MoversSource()
        src.scan_cycle(c, NOW)
        src.scan_cycle(c, NOW + BAR)
        self.assertEqual(c.universe_calls, 1)
        src.scan_cycle(c, NOW + 3600 * 1000 + BAR)
        self.assertEqual(c.universe_calls, 2)

    def test_idempotent_per_bar_and_store_dedupe(self):
        c = make_client(['AAAUSDT'])
        src = MoversSource()
        r1 = src.run(self.store, c, NOW)
        self.assertEqual(r1['created'], 4)
        calls = c.kline_calls
        r2 = src.run(self.store, c, NOW + 20000)
        self.assertEqual(r2['status'], 'already_done')
        self.assertEqual(r2['created'], 0)
        self.assertEqual(c.kline_calls, calls)
        # a fresh source (daemon restart) hits the store dedupe instead
        r3 = MoversSource().run(self.store, c, NOW)
        self.assertEqual(r3['created'], 0)
        self.assertEqual(len(self.store.list_alerts('all')), 4)

    def test_cooldown_respected_next_bar(self):
        src = MoversSource()
        c = make_client(['AAAUSDT'])
        self.assertEqual(len(src.scan_cycle(c, NOW)['alerts']), 4)
        # next bar: same jump again at the new last bar (shift the fake series)
        import radar.tests.test_movers_source as me
        old = me.BAR_CLOSE
        me.BAR_CLOSE = old + BAR
        try:
            res = src.scan_cycle(c, NOW + BAR)
        finally:
            me.BAR_CLOSE = old
        self.assertEqual(res['status'], 'ok')
        self.assertEqual(res['alerts'], [])  # inside the 480 min cooldown at the same threshold

    def test_not_due_in_grace_processes_previous_bar_once(self):
        src = MoversSource()
        c = make_client(['AAAUSDT'])
        res = src.scan_cycle(c, BAR_CLOSE + 1000)  # inside +3 s grace: previous bar close
        self.assertEqual(res['bar_close_ms'], BAR_CLOSE - BAR)

    def test_cap_and_tier_order(self):
        jumpers = [f'M{k}USDT' for k in range(4)] + ['HIUSDT']
        c = make_client(jumpers, flats=30, jump_q=dict({'HIUSDT': 5e8}, **{f'M{k}USDT': 3e7 for k in range(4)}))
        res = MoversSource().scan_cycle(c, NOW)
        self.assertEqual(len(res['alerts']), 10)
        self.assertTrue(all(a['kind'].endswith('_hi') for a in res['alerts'][:4]))
        self.assertTrue(all(a['symbol'] == 'HIUSDT' for a in res['alerts'][:4]))
        self.assertTrue(res['alerts'][4]['kind'].endswith('_mid'))

    def test_market_burst_has_no_tradable_alert(self):
        c = make_client([f'J{k:02d}USDT' for k in range(14)], flats=2)
        res = MoversSource().scan_cycle(c, NOW)
        self.assertEqual(res['alerts'], [])
        self.assertTrue(res['market'])
        self.assertTrue(all(e['symbol'] == 'MARKET' for e in res['market']))

    def test_majority_failures_abort(self):
        c = make_client(['AAAUSDT'], flats=9, fail=[f'F{k:02d}USDT' for k in range(6)])
        src = MoversSource()
        res = src.scan_cycle(c, NOW)
        self.assertEqual(res['status'], 'aborted')
        self.assertEqual(res['alerts'], [])
        self.assertIsNone(src.last_bar_close_ms)  # retried next cycle
        ok = make_client(['AAAUSDT'], flats=9, fail=['F00USDT'])
        self.assertEqual(MoversSource().scan_cycle(ok, NOW)['status'], 'ok')

    def test_weight_guard_aborts(self):
        c = make_client(['AAAUSDT'])
        c.used_weight_1m = 1300
        res = MoversSource().scan_cycle(c, NOW)
        self.assertEqual(res['status'], 'aborted')
        self.assertEqual(c.kline_calls, 0)

    def test_max_symbols_cap(self):
        c = make_client(['AAAUSDT'], flats=20)
        res = MoversSource(max_symbols=5).scan_cycle(c, NOW)
        self.assertEqual(res['symbols'], 5)
        self.assertLessEqual(c.kline_calls, 5)

    def test_failing_source_does_not_break_run_cycle(self):
        class Boom:
            def run(self, store, client):
                raise RuntimeError('boom')

        class NoKlines:
            def fetch_klines(self, *a, **k):
                return []

        class Core:
            def scan(self, *a, **k):
                return []

        state = {}
        run_cycle(self.store, NoKlines(), Core(), ['BTCUSDC'], ['15m'], {}, state, 1, None, Boom())
        self.assertEqual(state['errors'], 1)

    def test_meta_roundtrip(self):
        c = make_client(['AAAUSDT'])
        MoversSource().run(self.store, c, NOW)
        listed = self.store.list_alerts('all')
        self.assertTrue(all('meta' in a for a in listed))
        got = self.store.get_alert(listed[0]['id'])
        self.assertEqual(got['meta']['tier'], 'mid')

    def test_no_meta_key_when_absent(self):
        aid = self.store.create_alert({
            'symbol': 'BTCUSDC', 'tf': '15m', 'kind': 'k', 'title': 't', 'direction': 'long', 'entry': 1,
            'stop': 0.9, 'target_1r': 1.1, 'target_2r': 1.2, 'dedupe_key': 'x'})
        self.assertNotIn('meta', self.store.get_alert(aid))
        self.assertNotIn('meta', self.store.list_alerts('all')[0])

    def test_migration_on_old_schema(self):
        old = os.path.join(self.tmp.name, 'old.db')
        conn = sqlite3.connect(old)
        conn.execute("""CREATE TABLE alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL DEFAULT 'core',
            symbol TEXT NOT NULL, tf TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, direction TEXT NOT NULL,
            entry REAL NOT NULL, stop REAL NOT NULL, target_1r REAL NOT NULL, target_2r REAL NOT NULL,
            strength REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at REAL NOT NULL,
            triggered_at REAL, resolved_at REAL, outcome_r REAL, mfe_r REAL NOT NULL DEFAULT 0.0,
            mae_r REAL NOT NULL DEFAULT 0.0, net_r REAL, minutes_to_trigger INTEGER, minutes_to_outcome INTEGER,
            taken_by_user INTEGER NOT NULL DEFAULT 0, user_entry REAL, user_pnl REAL, user_note TEXT,
            dedupe_key TEXT NOT NULL)""")
        conn.execute("INSERT INTO alerts (symbol,tf,kind,title,direction,entry,stop,target_1r,target_2r,strength,created_at,dedupe_key)"
                     " VALUES ('BTCUSDC','15m','k','t','long',1,0.9,1.1,1.2,0.5,?, 'old')", (time.time(),))
        conn.commit()
        conn.close()
        s = RadarStore(old)
        RadarStore(old)  # second open: migration is idempotent
        self.assertNotIn('meta', s.get_alert(1))
        aid = s.create_alert({'symbol': 'ETHUSDC', 'tf': '5m', 'kind': 'k', 'title': 't', 'direction': 'long',
                              'entry': 1, 'stop': 0.9, 'target_1r': 1.1, 'target_2r': 1.2, 'dedupe_key': 'n',
                              'meta': {'a': 1}})
        self.assertEqual(s.get_alert(aid)['meta'], {'a': 1})


if __name__ == '__main__':
    unittest.main()
