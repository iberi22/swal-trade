#!/usr/bin/env python3
"""Tests offline (HTTP mockeado) de risk_guardian.py. Ejecutar: python3 -m unittest test_risk_guardian"""
import importlib.util, os, unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("risk_guardian", os.path.join(os.path.dirname(os.path.abspath(__file__)), "risk_guardian.py"))
rg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rg)


def pos(sym="BTCUSDC", amt="0.01", ps="BOTH"):
    return {"symbol": sym, "amt": amt, "notional": 500.0, "unrealized": 0.0, "positionSide": ps}


def algo(sym="BTCUSDC", side="SELL", typ="STOP_MARKET", **kw):
    return {"symbol": sym, "side": side, "orderType": typ, **kw}


class SecretFallback(unittest.TestCase):
    BASE = {"BINANCE_API_KEY": "k", "GUARDIAN_DAILY_LOSS_USD": "10"}

    def cfg(self, extra):
        with mock.patch.dict(os.environ, {**self.BASE, **extra}, clear=True):
            return rg.get_cfg()

    def test_secret_key_fallback(self):
        self.assertEqual(self.cfg({"BINANCE_SECRET_KEY": "s2"})["secret"], "s2")

    def test_api_secret_has_priority(self):
        self.assertEqual(self.cfg({"BINANCE_API_SECRET": "s1", "BINANCE_SECRET_KEY": "s2"})["secret"], "s1")

    def test_missing_secret_exits(self):
        with self.assertRaises(SystemExit):
            self.cfg({})

    def test_require_stop_default_true_and_off(self):
        self.assertTrue(self.cfg({"BINANCE_SECRET_KEY": "s"})["require_stop"])
        self.assertFalse(self.cfg({"BINANCE_SECRET_KEY": "s", "GUARDIAN_REQUIRE_STOP": "false"})["require_stop"])


class Stops(unittest.TestCase):
    def test_long_with_close_position_stop(self):
        self.assertTrue(rg.has_stop(pos(), [algo(closePosition=True)]))

    def test_reduce_only_string_true(self):
        self.assertTrue(rg.has_stop(pos(), [algo(reduceOnly="true")]))

    def test_wrong_side_symbol_or_type(self):
        self.assertFalse(rg.has_stop(pos(), [algo(side="BUY", closePosition=True)]))
        self.assertFalse(rg.has_stop(pos(), [algo(sym="ETHUSDC", closePosition=True)]))
        self.assertFalse(rg.has_stop(pos(), [algo(typ="TAKE_PROFIT_MARKET", closePosition=True)]))

    def test_stop_without_close_or_reduce_does_not_protect(self):
        self.assertFalse(rg.has_stop(pos(), [algo(closePosition=False, reduceOnly=False)]))

    def test_short_needs_buy_stop(self):
        self.assertTrue(rg.has_stop(pos(amt="-0.01"), [algo(side="BUY", closePosition=True)]))
        self.assertFalse(rg.has_stop(pos(amt="-0.01"), [algo(side="SELL", closePosition=True)]))

    def test_hedge_position_side_must_match(self):
        p = pos(ps="LONG")
        self.assertFalse(rg.has_stop(p, [algo(closePosition=True, positionSide="SHORT")]))
        self.assertTrue(rg.has_stop(p, [algo(closePosition=True, positionSide="LONG")]))

    def test_alert_text_and_rate_limit(self):
        last, miss = {}, [pos(amt="-0.5", sym="ETHUSDC")]
        self.assertEqual(rg.stop_alerts_due(miss, last, 1000, 600), ["SIN STOP: ETHUSDC SHORT 0.5"])
        self.assertEqual(rg.stop_alerts_due(miss, last, 1100, 600), [])      # dentro de la ventana
        self.assertEqual(len(rg.stop_alerts_due(miss, last, 1700, 600)), 1)  # ventana vencida
        rg.stop_alerts_due([], last, 1800, 600)                              # protegida: se olvida
        self.assertEqual(len(rg.stop_alerts_due(miss, last, 1801, 600)), 1)  # reaviso inmediato


class Heartbeat(unittest.TestCase):
    def test_pings_url(self):
        with mock.patch.object(rg.urllib.request, "urlopen") as u:
            rg.heartbeat({"heartbeat": "https://hc.example/ping/abc"})
        self.assertEqual(u.call_args[0][0], "https://hc.example/ping/abc")

    def test_no_url_no_call(self):
        with mock.patch.object(rg.urllib.request, "urlopen") as u:
            rg.heartbeat({"heartbeat": ""})
        u.assert_not_called()

    def test_failure_is_not_fatal_and_does_not_leak_url(self):
        with mock.patch.object(rg.urllib.request, "urlopen", side_effect=OSError("https://hc.example/ping/abc")), \
                mock.patch("builtins.print") as pr:
            rg.heartbeat({"heartbeat": "https://hc.example/ping/abc"})
        self.assertNotIn("abc", " ".join(map(str, pr.call_args[0])))


if __name__ == "__main__":
    unittest.main()
