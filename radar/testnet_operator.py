"""Testnet operator: takes the radar's triggered alerts and sends them to YOUR Binance Futures TESTNET bot.

It exists to exercise execution (entries, stops, closes, restarts) and to collect forward evidence with
fills, never to claim an edge: the costed audit (docs/research/AUDIT_PATRONES_2026-10-18.md) found none.
Refuses to run unless the bot reports a testnet exchange. Python stdlib only.

  python3 -m radar.testnet_operator

  RADAR_URL            default http://127.0.0.1:47322
  RADAR_TOKEN_FILE     default ~/.config/swal-trade/radar-token
  BOT_URL              default http://127.0.0.1:19244
  BOT_ENV_FILE         default ~/.config/swal-trade/testnet-bot.env   (SYNAPSE_ADMIN_TOKEN, BINANCE_TESTNET=true)
  OPERATOR_RISK_PCT    default 0.25   (% of equity lost if the stop is hit)
  OPERATOR_MAX_NOTIONAL default 1500  (USDT per position)
  OPERATOR_MAX_LEVERAGE default 5
  OPERATOR_MAX_OPEN    default 2
  OPERATOR_MAX_AGE_MIN default 6      (ignore alerts triggered longer ago than this)
  OPERATOR_JOURNAL     default ~/.local/share/swal-trade/testnet-operator.jsonl
"""
import json
import math
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

QUOTE_MAP = {'USDC': 'USDT'}  # the radar reads USDC perps; the testnet account is funded in USDT


def parse_ts(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return None


def bot_symbol(radar_symbol):
    for q, t in QUOTE_MAP.items():
        if radar_symbol.endswith(q):
            return radar_symbol[:-len(q)] + t
    return radar_symbol


def select_candidates(alerts, seen_ids, open_symbols, now, max_age_s, max_open):
    """Triggered, fresh, not already sent, symbol not already open, within the open-position cap."""
    out = []
    slots = max_open - len(open_symbols)
    taken = set(open_symbols)
    for a in sorted(alerts, key=lambda x: x.get('id', 0)):
        if slots <= 0:
            break
        if a.get('status') != 'triggered' or a.get('id') in seen_ids or a.get('taken_by_user'):
            continue
        t = parse_ts(a.get('triggered_at'))
        if t is None or now - t > max_age_s:
            continue
        sym = bot_symbol(a.get('symbol', ''))
        if sym in taken:
            continue
        taken.add(sym)
        slots -= 1
        out.append(a)
    return out


def size_signal(equity, entry, stop, risk_pct, max_notional, max_leverage):
    """Notional so that the loss at the stop is risk_pct of equity, capped; leverage is just the margin needed."""
    stop_frac = abs(entry - stop) / entry if entry else 0
    if equity <= 0 or stop_frac <= 0:
        return None
    risk_usd = equity * risk_pct / 100
    notional = min(risk_usd / stop_frac, max_notional)
    leverage = max(1, math.ceil(notional / (equity * 0.5)))  # never more than half of equity as margin
    if leverage > max_leverage:
        return None
    return {'amount_usdt': round(notional, 2), 'leverage': leverage, 'stop_loss_pct': round(stop_frac * 100, 4),
            'loss_at_stop_usd': round(notional * stop_frac, 2)}


def build_payload(alert, sizing):
    return {'symbol': bot_symbol(alert['symbol']), 'side': alert['direction'].upper(),
            'leverage': sizing['leverage'], 'amount_usdt': sizing['amount_usdt'],
            'stop_loss_pct': sizing['stop_loss_pct']}


def http_json(url, headers=None, body=None, timeout=15):
    data = json.dumps(body).encode() if body is not None else None
    h = dict(headers or {})
    if data is not None:
        h['Content-Type'] = 'application/json'
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h), timeout=timeout) as r:
        txt = r.read().decode()
        return json.loads(txt) if txt else {}


def read_env(path):
    env = {}
    for ln in open(os.path.expanduser(path), encoding='utf-8'):
        ln = ln.strip()
        if ln and not ln.startswith('#') and '=' in ln:
            k, v = ln.split('=', 1)
            env[k.replace('export ', '').strip()] = v.strip().strip('"\'')
    return env


def main():
    e = os.environ.get
    radar = e('RADAR_URL', 'http://127.0.0.1:47322').rstrip('/')
    bot = e('BOT_URL', 'http://127.0.0.1:19244').rstrip('/')
    radar_token = open(os.path.expanduser(e('RADAR_TOKEN_FILE', '~/.config/swal-trade/radar-token'))).read().strip()
    benv = read_env(e('BOT_ENV_FILE', '~/.config/swal-trade/testnet-bot.env'))
    if benv.get('BINANCE_TESTNET', '').lower() != 'true' or 'testnet' not in benv.get('BINANCE_FUTURES_URL', ''):
        sys.exit('refused: the bot env file does not say BINANCE_TESTNET=true with a testnet futures URL')
    auth = {'Authorization': f"Bearer {benv['SYNAPSE_ADMIN_TOKEN']}"}
    risk, cap, maxlev = float(e('OPERATOR_RISK_PCT', '0.25')), float(e('OPERATOR_MAX_NOTIONAL', '1500')), int(e('OPERATOR_MAX_LEVERAGE', '5'))
    max_open, max_age = int(e('OPERATOR_MAX_OPEN', '2')), float(e('OPERATOR_MAX_AGE_MIN', '6')) * 60
    journal = os.path.expanduser(e('OPERATOR_JOURNAL', '~/.local/share/swal-trade/testnet-operator.jsonl'))
    seen = set()
    if os.path.exists(journal):
        for ln in open(journal):
            try:
                seen.add(json.loads(ln).get('alert_id'))
            except ValueError:
                pass
    print('testnet operator up', flush=True)
    while True:
        try:
            status = http_json(f'{bot}/status', auth)
            equity = float(status['equity'])
            open_syms = {p['symbol'] for p in status.get('positions', [])} if isinstance(status.get('positions'), list) else set()
            alerts = http_json(f"{radar}/v1/alerts?status=active&limit=100", {'X-Radar-Token': radar_token}).get('alerts', [])
            for a in select_candidates(alerts, seen, open_syms, time.time(), max_age, max_open):
                s = size_signal(equity, float(a['entry']), float(a['stop']), risk, cap, maxlev)
                rec = {'t': time.time(), 'alert_id': a['id'], 'kind': a['kind'], 'tf': a['tf'], 'direction': a['direction'],
                       'symbol': a['symbol'], 'entry': a['entry'], 'stop': a['stop'], 'sizing': s}
                if s is None:
                    rec['result'] = 'skipped: sizing refused (stop too wide for the leverage cap)'
                else:
                    try:
                        rec['result'] = http_json(f'{bot}/control/manual-signal', auth, build_payload(a, s)).get('message', 'sent')
                    except Exception as x:  # noqa: BLE001
                        rec['result'] = f'error: {type(x).__name__}'
                seen.add(a['id'])
                os.makedirs(os.path.dirname(journal), exist_ok=True)
                with open(journal, 'a') as fh:
                    fh.write(json.dumps(rec) + '\n')
                print(rec['result'], a['kind'], a['symbol'], flush=True)
        except Exception as x:  # noqa: BLE001
            print('cycle failed:', type(x).__name__, flush=True)
        time.sleep(30)


if __name__ == '__main__':
    main()
