#!/usr/bin/env python3
"""Tests de risk_guardian.py (funciones puras, sin red). Ejecutar: python3 -m unittest test_monitor_risk_guardian"""
import importlib.util, os, unittest

spec = importlib.util.spec_from_file_location("risk_guardian", os.path.join(os.path.dirname(os.path.abspath(__file__)), "risk_guardian.py"))
rg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rg)

CFG = {"limit": 10.0, "warn": 0.7, "max_notional": 1000.0, "max_lev": 10.0}
H = 3600_000


def pos(sym="BTCUSDC", amt="0.01", notional=500.0, up=0.0, ps="BOTH"):
    return {"symbol": sym, "amt": amt, "notional": notional, "unrealized": up, "positionSide": ps}


class T(unittest.TestCase):
    def test_day_start_utc5(self):
        mid = 5 * H  # 00:00 hora local = 05:00 UTC (dia 0)
        d = 86_400_000
        self.assertEqual(rg.day_start_ms(mid + d - 1, -5), mid)       # 23:59:59.999 local
        self.assertEqual(rg.day_start_ms(mid + d, -5), mid + d)       # 00:00 local siguiente
        self.assertEqual(rg.day_start_ms(mid, -5), mid)

    def test_realized_filters(self):
        rows = [{"incomeType": "REALIZED_PNL", "asset": "USDT", "income": "5.5"},
                {"incomeType": "COMMISSION", "asset": "USDC", "income": "-0.4"},
                {"incomeType": "COMMISSION", "asset": "USDT", "income": "-0.1"},
                {"incomeType": "FUNDING_FEE", "asset": "USDT", "income": "-1"},
                {"incomeType": "TRANSFER", "asset": "USDT", "income": "1000"},
                {"incomeType": "REALIZED_PNL", "asset": "BNB", "income": "99"}]
        self.assertAlmostEqual(rg.realized_usd(rows), 4.0)

    def test_positions_only_open(self):
        acc = {"positions": [{"symbol": "A", "positionAmt": "0", "notional": "0", "unrealizedProfit": "0"},
                             {"symbol": "B", "positionAmt": "-2", "notional": "-300", "unrealizedProfit": "-1.5", "positionSide": "SHORT"}]}
        self.assertEqual(rg.positions(acc), [pos("B", "-2", 300.0, -1.5, "SHORT")])

    def test_warn_vs_hit(self):
        self.assertEqual(rg.breaches(-1, [], {}, CFG), {})
        self.assertEqual(list(rg.breaches(-7.0, [], {}, CFG)), ["daily_warn"])
        hit = rg.breaches(-10.42, [pos(up=-2.32)], {}, CFG)
        self.assertEqual(list(hit), ["daily_hit"])
        self.assertIn("realizado -8.10, abierto -2.32", hit["daily_hit"])

    def test_notional_and_leverage(self):
        b = rg.breaches(0, [pos(notional=2000.0), pos("ETHUSDT")], {"BTCUSDC": 20, "ETHUSDT": 5}, CFG)
        self.assertEqual(sorted(b), ["lev:BTCUSDC", "notional:BTCUSDC"])

    def test_close_orders(self):
        long_, short = pos(amt="0.010"), pos("ETHUSDT", "-2.50")
        o = rg.close_orders([long_, short], hedge=False)
        self.assertEqual((o[0]["side"], o[0]["quantity"], o[0]["reduceOnly"]), ("SELL", "0.010", "true"))
        self.assertEqual((o[1]["side"], o[1]["quantity"]), ("BUY", "2.50"))
        h = rg.close_orders([pos(ps="LONG"), pos("ETHUSDT", "-1", ps="SHORT")], hedge=True)
        self.assertEqual((h[0]["positionSide"], h[1]["positionSide"]), ("LONG", "SHORT"))
        self.assertNotIn("reduceOnly", h[0])
        self.assertIn("reduceOnly", rg.close_orders([pos()], hedge=True)[0])  # BOTH = one-way

    def test_plain_text(self):
        msgs = list(rg.breaches(-50, [pos(notional=9e3)], {"BTCUSDC": 50}, CFG).values())
        msgs += list(rg.breaches(-7, [], {}, CFG).values())
        self.assertGreaterEqual(len(msgs), 3)
        for m in msgs:
            self.assertFalse(set("*_`") & set(m), m)


if __name__ == "__main__":
    unittest.main()
