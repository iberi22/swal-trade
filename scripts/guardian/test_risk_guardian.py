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

    def test_token_goes_in_bearer_header_by_post(self):
        with mock.patch.object(rg.urllib.request, "urlopen") as u:
            rg.heartbeat({"heartbeat": "https://trade.example/heartbeat/guardian", "heartbeat_token": "tok"})
        req = u.call_args[0][0]
        self.assertEqual(req.full_url, "https://trade.example/heartbeat/guardian")
        self.assertEqual(req.get_method(), "POST")
        self.assertEqual(req.get_header("Authorization"), "Bearer tok")

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


class RecvWindow(unittest.TestCase):
    CFG = {"key": "k", "secret": "s", "url": "https://fapi.binance.com", "recv_window": 15000}

    @staticmethod
    def http_error(code, body):
        import io
        return rg.urllib.error.HTTPError("u", code, "x", {}, io.BytesIO(body.encode()))

    def test_recv_window_default_and_env(self):
        base = {"BINANCE_API_KEY": "k", "BINANCE_API_SECRET": "s", "GUARDIAN_DAILY_LOSS_USD": "10"}
        with mock.patch.dict(os.environ, base, clear=True):
            self.assertEqual(rg.get_cfg()["recv_window"], 15000)
        with mock.patch.dict(os.environ, {**base, "GUARDIAN_RECV_WINDOW_MS": "90000"}, clear=True):
            self.assertEqual(rg.get_cfg()["recv_window"], 60000)  # Binance acepta 60000 como maximo

    def test_signed_query_carries_recv_window(self):
        resp = mock.MagicMock()
        resp.read.return_value = b"[]"
        with mock.patch.object(rg.urllib.request, "urlopen", return_value=resp) as u:
            rg.call(self.CFG, "GET", "/fapi/v2/account")
        self.assertIn("recvWindow=15000", u.call_args[0][0].full_url)

    def test_retries_once_on_1021_then_succeeds(self):
        ok = mock.MagicMock()
        ok.read.return_value = b'{"ok": 1}'
        err = self.http_error(400, '{"code":-1021,"msg":"Timestamp for this request is outside of the recvWindow."}')
        with mock.patch.object(rg.urllib.request, "urlopen", side_effect=[err, ok]) as u:
            self.assertEqual(rg.call(self.CFG, "GET", "/fapi/v2/account"), {"ok": 1})
        self.assertEqual(u.call_count, 2)

    def test_other_errors_are_not_retried(self):
        err = self.http_error(400, '{"code":-2015,"msg":"Invalid API-key"}')
        with mock.patch.object(rg.urllib.request, "urlopen", side_effect=[err]) as u:
            with self.assertRaises(RuntimeError):
                rg.call(self.CFG, "GET", "/fapi/v2/account")
        self.assertEqual(u.call_count, 1)



class UnreadAlerts(unittest.TestCase):
    def test_no_alert_before_threshold(self):
        st = {"last_ok": 1000}
        msgs = rg.unread_alerts(st, False, "timeout", 1120, threshold_s=180)
        self.assertEqual(msgs, [])
        self.assertEqual(st["fails"], 1)
        self.assertFalse(st["alerted"])

    def test_exactly_one_alert_at_threshold(self):
        st = {"last_ok": 1000}
        msgs = rg.unread_alerts(st, False, "HTTP 500 Server Error", 1180, threshold_s=180)
        self.assertEqual(len(msgs), 1)
        self.assertEqual(
            msgs[0],
            "GUARDIAN: no puedo leer tu cuenta de Binance desde hace 3 min (ultimo error: HTTP 500 Server Error). No estoy vigilando tus posiciones.",
        )
        self.assertTrue(st["alerted"])
        # Poll immediately after still within suppression window
        msgs2 = rg.unread_alerts(st, False, "HTTP 500 Server Error", 1195, threshold_s=180)
        self.assertEqual(msgs2, [])

    def test_rate_limit_of_repeats(self):
        st = {"last_ok": 1000}
        rg.unread_alerts(st, False, "err1", 1180, threshold_s=180, repeat_s=1800)
        # 29 min after first alert -> suppressed
        self.assertEqual(rg.unread_alerts(st, False, "err2", 2920, threshold_s=180, repeat_s=1800), [])
        # 30 min after first alert (1180 + 1800 = 2980, 33 min elapsed from last_ok) -> repeat alert
        msgs = rg.unread_alerts(st, False, "err3", 2980, threshold_s=180, repeat_s=1800)
        self.assertEqual(len(msgs), 1)
        self.assertEqual(
            msgs[0],
            "GUARDIAN: no puedo leer tu cuenta de Binance desde hace 33 min (ultimo error: err3). No estoy vigilando tus posiciones.",
        )
        # Next poll suppressed
        self.assertEqual(rg.unread_alerts(st, False, "err3", 2995, threshold_s=180, repeat_s=1800), [])

    def test_recovery_message_once(self):
        st = {"last_ok": 1000}
        rg.unread_alerts(st, False, "down", 1180, threshold_s=180)
        self.assertTrue(st["alerted"])
        # First successful read recovers
        msgs = rg.unread_alerts(st, True, None, 1200, threshold_s=180)
        self.assertEqual(msgs, ["GUARDIAN: vuelvo a leer tu cuenta. Vigilancia restablecida."])
        self.assertFalse(st["alerted"])
        self.assertEqual(st["fails"], 0)
        self.assertEqual(st["last_ok"], 1200)
        # Second successful read sends nothing
        self.assertEqual(rg.unread_alerts(st, True, None, 1215, threshold_s=180), [])
        # Recovery is not sent if failure never reached threshold
        st2 = {"last_ok": 1000}
        rg.unread_alerts(st2, False, "down", 1030, threshold_s=180)
        self.assertEqual(rg.unread_alerts(st2, True, None, 1045, threshold_s=180), [])

    def test_secrets_and_signature_never_leak(self):
        cfg = {"key": "dummy_key_fixture", "secret": "dummy_secret_fixture"}
        raw_err = (
            "HTTP 400 https://fapi.binance.com/fapi/v1/order?symbol=BTCUSDT"
            "&timestamp=1700000000000&signature=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
            " key dummy_key_fixture secret dummy_secret_fixture"
        )
        st = {"last_ok": 1000}
        msgs = rg.unread_alerts(st, False, raw_err, 1180, threshold_s=180, cfg=cfg)
        self.assertEqual(len(msgs), 1)
        alert = msgs[0]
        self.assertNotIn("dummy_key_fixture", alert)
        self.assertNotIn("dummy_secret_fixture", alert)
        self.assertNotIn("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", alert)
        self.assertNotIn("?", alert)

    def test_unread_alert_minutes_cfg(self):
        base = {"BINANCE_API_KEY": "k", "BINANCE_API_SECRET": "s", "GUARDIAN_DAILY_LOSS_USD": "10"}
        with mock.patch.dict(os.environ, base, clear=True):
            self.assertEqual(rg.get_cfg()["unread_alert_s"], 180)
        with mock.patch.dict(os.environ, {**base, "GUARDIAN_UNREAD_ALERT_MINUTES": "5"}, clear=True):
            self.assertEqual(rg.get_cfg()["unread_alert_s"], 300)
