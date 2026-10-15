#!/usr/bin/env python3
"""Guardian de riesgo para Binance USD-M Futures (trading manual). Solo stdlib.
Avisa por Telegram del limite de perdida diaria y de posiciones SIN STOP (solo aviso, nunca crea ordenes);
GUARDIAN_ENFORCE=true cierra a mercado al limite diario. --once: solo imprime."""
import hashlib, hmac, json, os, sys, time, urllib.parse, urllib.request

USD = {"USDT", "USDC", "FDUSD", "BUSD"}
PNL_TYPES = {"REALIZED_PNL", "COMMISSION", "FUNDING_FEE"}

def day_start_ms(now_ms, tz_h):
    off = int(tz_h * 3600_000)
    return (now_ms + off) // 86_400_000 * 86_400_000 - off

def realized_usd(rows):
    return sum(float(r["income"]) for r in rows if r.get("incomeType") in PNL_TYPES and r.get("asset") in USD)

def positions(account):
    return [{"symbol": p["symbol"], "amt": p["positionAmt"], "notional": abs(float(p["notional"])),
             "unrealized": float(p["unrealizedProfit"]), "positionSide": p.get("positionSide", "BOTH")}
            for p in account.get("positions", []) if float(p["positionAmt"]) != 0]

def breaches(day_pnl, pos, leverages, cfg):
    out, lim, open_ = {}, cfg["limit"], sum(p["unrealized"] for p in pos)
    det = f"PnL del dia {day_pnl:.2f} USD (realizado {day_pnl - open_:.2f}, abierto {open_:.2f}), limite -{lim:.2f}."
    if day_pnl <= -lim:
        out["daily_hit"] = f"GUARDIAN: limite diario alcanzado. {det} Para de operar hoy."
    elif day_pnl <= -lim * cfg["warn"]:
        out["daily_warn"] = f"GUARDIAN: cerca del limite diario. {det} Cuidado."
    for p in pos:
        s, mx, lv = p["symbol"], cfg.get("max_notional"), cfg.get("max_lev")
        if mx and p["notional"] > mx:
            out[f"notional:{s}"] = f"GUARDIAN: {s} nocional {p['notional']:.0f} USD supera el maximo {mx:.0f}."
        if lv and leverages.get(s, 0) > lv:
            out[f"lev:{s}"] = f"GUARDIAN: {s} apalancamiento {leverages[s]}x supera el maximo {lv:g}x."
    return out

def _true(v):
    return v is True or str(v).lower() == "true"

def has_stop(p, algo):
    """Hay un STOP_MARKET abierto (closePosition o reduceOnly) del lado que cierra la posicion?"""
    long_ = float(p["amt"]) > 0
    for o in algo:
        typ = o.get("orderType") or o.get("type")
        if o.get("symbol") != p["symbol"] or typ != "STOP_MARKET" or o.get("side") != ("SELL" if long_ else "BUY"):
            continue
        if p["positionSide"] != "BOTH" and o.get("positionSide") != p["positionSide"]:
            continue
        if _true(o.get("closePosition")) or _true(o.get("reduceOnly")):
            return True
    return False

def unprotected(pos, algo):
    return [p for p in pos if not has_stop(p, algo)]

def stop_alerts_due(missing, last, now, every_s):
    """Mensajes 'SIN STOP' a enviar ahora (max 1 por posicion cada every_s); actualiza `last`."""
    out, keys = [], set()
    for p in missing:
        k = (p["symbol"], "LONG" if float(p["amt"]) > 0 else "SHORT")
        keys.add(k)
        if now - last.get(k, -1e18) >= every_s:
            last[k] = now
            out.append(f"SIN STOP: {k[0]} {k[1]} {p['amt'].lstrip('-')}")
    for k in set(last) - keys:
        del last[k]  # posicion protegida o cerrada: si vuelve a quedar sin stop, avisa al instante
    return out

def close_orders(pos, hedge):
    return [{"symbol": p["symbol"], "type": "MARKET", "quantity": p["amt"].lstrip("-"),
             "side": "SELL" if float(p["amt"]) > 0 else "BUY",
             **({"positionSide": p["positionSide"]} if hedge and p["positionSide"] != "BOTH" else {"reduceOnly": "true"})}
            for p in pos]

# --- IO ---
def load_env():
    f = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend", ".env")
    if os.path.exists(f):
        for ln in open(f, encoding="utf-8"):
            k, sep, v = ln.strip().partition("=")
            if sep and not k.startswith("#"):
                os.environ.setdefault(k.strip(), v.strip().strip("\"'"))

def get_cfg():
    e = os.environ.get
    opt = lambda k: float(e(k)) if e(k) else None
    try:
        cfg = {"key": e("BINANCE_API_KEY", ""), "secret": e("BINANCE_API_SECRET") or e("BINANCE_SECRET_KEY", ""), "tg_token": e("TELEGRAM_BOT_TOKEN", ""),
               "url": e("BINANCE_FUTURES_URL", "https://fapi.binance.com").rstrip("/"), "tg_chat": e("TELEGRAM_CHAT_ID", ""),
               "limit": opt("GUARDIAN_DAILY_LOSS_USD") or 0, "warn": float(e("GUARDIAN_WARN_FRACTION", "0.7")),
               "max_notional": opt("GUARDIAN_MAX_NOTIONAL_USD"), "max_lev": opt("GUARDIAN_MAX_LEVERAGE"),
               "tz": float(e("GUARDIAN_TZ_OFFSET_HOURS", "-5")), "poll": max(5, float(e("GUARDIAN_POLL_SECS", "15"))),
               "enforce": e("GUARDIAN_ENFORCE", "false").lower() in ("1", "true", "yes"),
               "require_stop": e("GUARDIAN_REQUIRE_STOP", "true").lower() in ("1", "true", "yes"),
               "stop_every": max(1, float(e("GUARDIAN_STOP_ALERT_MINUTES", "15"))) * 60,
               "heartbeat": e("GUARDIAN_HEARTBEAT_URL", ""),
               # Con ~0,5 s de ida y vuelta, 5 s no bastaban en picos de red (-1021). Binance admite hasta 60 s.
               "recv_window": min(60000, max(5000, int(float(e("GUARDIAN_RECV_WINDOW_MS", "15000")))))}
    except ValueError as x:
        sys.exit(f"ERROR: GUARDIAN_* no numerico ({x})")
    if not (cfg["key"] and cfg["secret"]) or cfg["limit"] <= 0:
        sys.exit("ERROR: faltan BINANCE_API_KEY/SECRET o GUARDIAN_DAILY_LOSS_USD>0. Ver docs/RISK_GUARDIAN.md")
    return cfg

def call(cfg, method, path, params=None, _retry=True):
    q = urllib.parse.urlencode({**(params or {}), "timestamp": int(time.time() * 1000),
                                "recvWindow": cfg.get("recv_window", 15000)})
    q += "&signature=" + hmac.new(cfg["secret"].encode(), q.encode(), hashlib.sha256).hexdigest()
    r = urllib.request.Request(f"{cfg['url']}{path}?{q}", method=method, headers={"X-MBX-APIKEY": cfg["key"]})
    try:
        return json.load(urllib.request.urlopen(r, timeout=10))
    except urllib.error.HTTPError as x:
        body = x.read().decode(errors="replace")[:200]
        # -1021: llego tarde o con la hora corrida; Binance no la ejecuto, asi que un reintento firmado de nuevo es seguro.
        if _retry and '"code":-1021' in body.replace(" ", ""):
            return call(cfg, method, path, params, _retry=False)
        raise RuntimeError(f"HTTP {x.code} {body}") from None
    except Exception as x:
        raise RuntimeError(type(x).__name__ + ": " + str(x)[:150]) from None

def income_since(cfg, start):
    rows = []
    for _ in range(10):
        page = call(cfg, "GET", "/fapi/v1/income", {"startTime": start, "limit": 1000})
        rows += page
        if len(page) < 1000:
            break
        start = int(page[-1]["time"]) + 1
    return rows

def send(cfg, text):
    print(time.strftime("%H:%M:%S"), text, flush=True)
    if cfg["tg_token"]:
        try:
            u = f"https://api.telegram.org/bot{cfg['tg_token']}/sendMessage"
            urllib.request.urlopen(urllib.request.Request(u, json.dumps({"chat_id": cfg["tg_chat"], "text": text}).encode(),
                                   {"Content-Type": "application/json"}), timeout=10).read()
        except Exception as x:
            print("telegram fallo:", type(x).__name__)  # sin URL: lleva el token

def heartbeat(cfg):
    """Ping dead-man (healthchecks.io-style). Un fallo se registra, nunca es fatal."""
    if cfg.get("heartbeat"):
        try:
            urllib.request.urlopen(cfg["heartbeat"], timeout=10).read()
        except Exception as x:
            print("heartbeat fallo:", type(x).__name__, flush=True)  # sin URL: puede llevar el uuid

def snapshot(cfg, start):
    pos = positions(call(cfg, "GET", "/fapi/v3/account"))
    # Apalancamiento por simbolo: /fapi/v2/positionRisk (v3 account no lo trae)
    lev = {r["symbol"]: float(r["leverage"]) for r in call(cfg, "GET", "/fapi/v2/positionRisk")
           if float(r["positionAmt"]) != 0}
    real = realized_usd(income_since(cfg, start))
    pnl = real + sum(p["unrealized"] for p in pos)
    return pos, lev, real, pnl, breaches(pnl, pos, lev, cfg)

def enforce(cfg, pos):
    hedge = any(p["positionSide"] != "BOTH" for p in pos)
    for sym in {p["symbol"] for p in pos}:
        try:
            call(cfg, "DELETE", "/fapi/v1/allOpenOrders", {"symbol": sym})
        except RuntimeError:
            pass  # si falla, igual se intenta cerrar
    for o in close_orders(pos, hedge):
        try:
            call(cfg, "POST", "/fapi/v1/order", o)
            send(cfg, f"GUARDIAN: cerrada {o['symbol']} {o['side']} {o['quantity']} a mercado.")
        except RuntimeError as x:
            send(cfg, f"GUARDIAN: FALLO al cerrar {o['symbol']} ({x})")

def main():
    load_env()
    cfg = get_cfg()
    if "--once" in sys.argv:
        pos, lev, real, pnl, br = snapshot(cfg, day_start_ms(int(time.time() * 1000), cfg["tz"]))
        print(json.dumps(dict(day_pnl=pnl, realized=real, unrealized=pnl - real, positions=pos, leverages=lev, breaches=br), indent=1))
        return
    send(cfg, f"GUARDIAN activo. Limite -{cfg['limit']:.2f} USD (aviso {cfg['warn']:.0%}), nocional max {cfg['max_notional']}, "
              f"apalancamiento max {cfg['max_lev']}, ENFORCE {'ON' if cfg['enforce'] else 'OFF'}.")
    day, alerted, fails, blind, stop_last = None, set(), 0, False, {}
    while True:
        start = day_start_ms(int(time.time() * 1000), cfg["tz"])
        day, alerted = (start, set()) if start != day else (day, alerted)  # dia nuevo: reinicia alertas
        try:
            pos, lev, real, pnl, br = snapshot(cfg, start)
            if blind:
                send(cfg, "GUARDIAN recuperado")
            fails, blind = 0, False
            for k in sorted(br.keys() - alerted):
                alerted.add(k)
                send(cfg, br[k])
            if cfg["enforce"] and "daily_hit" in br and pos:
                enforce(cfg, pos)  # lockout: cada poll del dia cierra lo que se reabra
            if cfg["require_stop"]:  # solo aviso, independiente de ENFORCE; nunca crea ordenes
                try:
                    miss = unprotected(pos, call(cfg, "GET", "/fapi/v1/openAlgoOrders") if pos else [])
                    for m in stop_alerts_due(miss, stop_last, time.time(), cfg["stop_every"]):
                        send(cfg, m)
                except Exception as x:
                    print("error openAlgoOrders:", x, flush=True)
            heartbeat(cfg)
        except Exception as x:  # cualquier fallo (JSON raro incluido) no puede matar al guardian
            fails += 1
            print("error:", x, flush=True)
            if fails >= 5 and not blind:
                blind = True
                send(cfg, f"GUARDIAN ciego: no puedo leer la cuenta ({x})")
        time.sleep(cfg["poll"])

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("GUARDIAN detenido.")
    except RuntimeError as e:  # solo --once: el loop captura sus propios errores
        sys.exit(f"ERROR: {e}")
