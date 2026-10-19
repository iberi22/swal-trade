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
  OPERATOR_SOURCES     default core   (comma list; alerts from other sources are ignored; alert.get('source','core'))
  OPERATOR_KINDS       default empty  (allowlist for 'movers' alerts: exact kinds or prefixes ending with '*';
                                       empty means NO movers alerts are traded; core alerts ignore this list)
  OPERATOR_SYMBOL_COOLDOWN_H default 4   (hours before the same symbol can be entered again)
  OPERATOR_MAX_PER_HOUR default 3     (new entries per rolling hour)
  OPERATOR_TP_R        default unset  (if set, payload carries take_profit_r = 1.0; see below)

Extra guards, all journaled once per alert id as 'skipped: ...': a 'negative' cell_grade is never traded; the
mapped symbol must be in SYMBOLS of the bot env file (missing SYMBOLS means nothing is traded); the testnet price
(BINANCE_FUTURES_URL of the bot env, must contain 'testnet') must be within 0.5 % of the alert entry; a daily stop
refuses entries when equity <= 98 % of the equity seen at the first cycle of the UTC day (kept in a small JSON
next to the journal); market-burst alerts (source movers with kind 'mv_market*' or meta market_wide) are ignored.
After a successful send the operator reads the bot /status each cycle and appends {alert_id, result} to the journal:
'confirmed open' once the symbol shows as a position, or 'dropped by bot' if it is still not open after 90 s.

Take profit: the measured cell scores the FIRST 1R touch, while the bot default exits at 2R. Set OPERATOR_TP_R
only if the running bot binary knows take_profit_r; by default the field is omitted from the payload.
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


def csv_set(value, upper=False):
    items = [x.strip() for x in (value or '').split(',') if x.strip()]
    return {x.upper() for x in items} if upper else set(items)


def kind_allowed(kind, patterns):
    """Exact kinds or prefixes ending with '*'. Empty allowlist allows nothing."""
    for p in patterns:
        if (p.endswith('*') and kind.startswith(p[:-1])) or kind == p:
            return True
    return False


def is_burst(a):
    meta = a.get('meta') if isinstance(a.get('meta'), dict) else {}
    return a.get('source', 'core') == 'movers' and (str(a.get('kind', '')).startswith('mv_market')
                                                    or bool(meta.get('market_wide')) or bool(a.get('market_wide')))


def ignored(a, sources, kinds):
    """Alerts that are not ours to trade at all (no journal line): source, kinds allowlist, negative cell, burst."""
    src = a.get('source', 'core')
    if src not in sources or a.get('cell_grade') == 'negative' or is_burst(a):
        return True
    return src == 'movers' and not kind_allowed(str(a.get('kind', '')), kinds)


def day_key(now):
    return datetime.fromtimestamp(now, timezone.utc).strftime('%Y-%m-%d')


def day_start_equity(path, equity, now):
    """Equity at the first cycle of the UTC day, persisted in a small JSON."""
    day = day_key(now)
    try:
        with open(path, encoding='utf-8') as fh:
            d = json.load(fh)
        if d.get('day') == day and float(d.get('equity', 0)) > 0:
            return float(d['equity'])
    except (OSError, ValueError, TypeError):
        pass
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump({'day': day, 'equity': equity}, fh)
    return equity


def gate(a, now, symbols, last_entry, entries, equity, day_equity, fetch_price,
         cooldown_s=4 * 3600, max_per_hour=3, max_div=0.005, daily_stop=0.98):
    """Reason string to skip this candidate, or None to go ahead. fetch_price(sym) -> float (may raise)."""
    sym = bot_symbol(a.get('symbol', ''))
    if sym not in symbols:
        return 'skipped: symbol not in bot SYMBOLS'
    if day_equity and equity <= daily_stop * day_equity:
        return 'skipped: daily stop'
    if now - last_entry.get(sym, -1e18) < cooldown_s:
        return 'skipped: symbol cooldown'
    if sum(1 for t in entries if now - t < 3600) >= max_per_hour:
        return 'skipped: hourly entry cap'
    try:
        px = float(fetch_price(sym))
        if not px > 0:
            raise ValueError('price')
    except Exception:  # noqa: BLE001
        return 'skipped: no testnet price'
    entry = float(a.get('entry') or 0)
    if entry <= 0 or abs(px / entry - 1) > max_div:
        return 'skipped: testnet price differs'
    return None


def is_entry(rec):
    return bool(rec.get('sizing')) and not str(rec.get('result', '')).startswith(('skipped', 'error'))


def rebuild_state(records):
    """last_entry {sym: t} and entries [t] from journal records, so limits survive a restart."""
    last, ent = {}, []
    for r in records:
        if is_entry(r) and isinstance(r.get('t'), (int, float)):
            sym = bot_symbol(r.get('symbol', ''))
            last[sym] = max(last.get(sym, 0), r['t'])
            ent.append(r['t'])
    return last, ent


def confirm_step(pending, open_syms, now, grace_s=90):
    """pending {alert_id: (symbol, sent_t)}; returns journal lines and removes resolved ones."""
    out = []
    for aid, (sym, t) in list(pending.items()):
        if sym in open_syms:
            out.append({'t': now, 'alert_id': aid, 'result': 'confirmed open'})
        elif now - t > grace_s:
            out.append({'t': now, 'alert_id': aid, 'result': 'dropped by bot'})
        else:
            continue
        del pending[aid]
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


def build_payload(alert, sizing, take_profit_r=None):
    p = {'symbol': bot_symbol(alert['symbol']), 'side': alert['direction'].upper(),
         'leverage': sizing['leverage'], 'amount_usdt': sizing['amount_usdt'],
         'stop_loss_pct': sizing['stop_loss_pct']}
    if take_profit_r is not None:
        p['take_profit_r'] = take_profit_r
    return p


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
    sources, kinds = csv_set(e('OPERATOR_SOURCES', 'core')), csv_set(e('OPERATOR_KINDS', ''))
    symbols = csv_set(benv.get('SYMBOLS', ''), upper=True)
    cooldown_s, max_hour = float(e('OPERATOR_SYMBOL_COOLDOWN_H', '4')) * 3600, int(e('OPERATOR_MAX_PER_HOUR', '3'))
    tp_r = 1.0 if e('OPERATOR_TP_R') else None
    day_path = os.path.join(os.path.dirname(journal), 'testnet-operator-day.json')
    fut = benv['BINANCE_FUTURES_URL'].rstrip('/')

    def fetch_price(sym):
        return http_json(f'{fut}/fapi/v1/ticker/price?symbol={sym}')['price']

    seen, records = set(), []
    if os.path.exists(journal):
        for ln in open(journal):
            try:
                r = json.loads(ln)
                seen.add(r.get('alert_id'))
                records.append(r)
            except ValueError:
                pass
    last_entry, entries = rebuild_state(records)
    pending = {}

    def write(rec):
        os.makedirs(os.path.dirname(journal), exist_ok=True)
        with open(journal, 'a') as fh:
            fh.write(json.dumps(rec) + '\n')

    if not symbols:
        print('warning: no SYMBOLS in the bot env file, nothing will be traded', flush=True)
    print('testnet operator up', flush=True)
    while True:
        try:
            now = time.time()
            status = http_json(f'{bot}/status', auth)
            equity = float(status['equity'])
            open_syms = {p['symbol'] for p in status.get('positions', [])} if isinstance(status.get('positions'), list) else set()
            for line in confirm_step(pending, open_syms, now):
                write(line)
                print(line['result'], line['alert_id'], flush=True)
            day_eq = day_start_equity(day_path, equity, now)
            alerts = http_json(f"{radar}/v1/alerts?status=active&limit=100", {'X-Radar-Token': radar_token}).get('alerts', [])
            alerts = [x for x in alerts if not ignored(x, sources, kinds)]
            for a in select_candidates(alerts, seen, open_syms, now, max_age, max_open):
                s = size_signal(equity, float(a['entry']), float(a['stop']), risk, cap, maxlev)
                rec = {'t': now, 'alert_id': a['id'], 'kind': a['kind'], 'tf': a['tf'], 'direction': a['direction'],
                       'symbol': a['symbol'], 'entry': a['entry'], 'stop': a['stop'], 'sizing': s}
                skip = gate(a, now, symbols, last_entry, entries, equity, day_eq, fetch_price, cooldown_s, max_hour)
                if skip:
                    rec['result'] = skip
                elif s is None:
                    rec['result'] = 'skipped: sizing refused (stop too wide for the leverage cap)'
                else:
                    try:
                        rec['result'] = http_json(f'{bot}/control/manual-signal', auth, build_payload(a, s, tp_r)).get('message', 'sent')
                        sym = bot_symbol(a['symbol'])
                        last_entry[sym] = now
                        entries.append(now)
                        pending[a['id']] = (sym, now)
                    except Exception as x:  # noqa: BLE001
                        rec['result'] = f'error: {type(x).__name__}'
                seen.add(a['id'])
                write(rec)
                print(rec['result'], a['kind'], a['symbol'], flush=True)
        except Exception as x:  # noqa: BLE001
            print('cycle failed:', type(x).__name__, flush=True)
        time.sleep(30)


if __name__ == '__main__':
    main()
