import os
import json
import argparse
import sqlite3
import time
import subprocess
from typing import List, Dict, Any, Callable, Optional

from radar.klines_cache import load_klines

BANNER = "REPLAY - in-sample, not forward evidence"

def _calc_ema(candles: List[Dict[str, Any]], period: int) -> Optional[float]:
    if len(candles) < period:
        return None
    multiplier = 2 / (period + 1)
    sma = sum(c['close'] for c in candles[:period]) / period
    ema = sma
    for c in candles[period:]:
        ema = (c['close'] - ema) * multiplier + ema
    return ema

def _aggregate_candles(candles: List[Dict[str, Any]], tf_seconds: int) -> List[Dict[str, Any]]:
    if not candles:
        return []

    aggs = []
    current_agg = None

    for c in candles:
        t = c['time']
        aligned_t = (t // tf_seconds) * tf_seconds

        if current_agg is None or current_agg['time'] != aligned_t:
            if current_agg is not None:
                aggs.append(current_agg)
            current_agg = {
                'time': aligned_t,
                'open': c['open'],
                'high': c['high'],
                'low': c['low'],
                'close': c['close']
            }
        else:
            current_agg['high'] = max(current_agg['high'], c['high'])
            current_agg['low'] = min(current_agg['low'], c['low'])
            current_agg['close'] = c['close']

    if current_agg is not None:
        aggs.append(current_agg)

    return aggs

def _compute_trend_aligned(candles_detect: List[Dict[str, Any]], alert_time: float, tf_secs: int) -> Optional[bool]:
    available = [c for c in candles_detect if c['time'] <= alert_time]
    aggs = _aggregate_candles(available, tf_secs)

    ema20 = _calc_ema(aggs, 20)
    ema50 = _calc_ema(aggs, 50)

    if ema20 is None or ema50 is None:
        return None

    return ema20 > ema50

def replay(candles_detect: List[Any], candles_1m: List[Any], scan: Callable, evaluate: Callable, window: int = 300, tf: str = '15m', symbol: str = 'BTCUSDC') -> List[Dict[str, Any]]:
    alerts = []

    for i in range(window, len(candles_detect) + 1):
        window_candles = candles_detect[i - window:i]
        findings = scan(symbol, tf, window_candles)

        for f in findings:
            alert = dict(f)
            alert['source'] = 'replay'

            alert_time = window_candles[-1]['time']
            trend_4h_aligned = _compute_trend_aligned(candles_detect, alert_time, 14400)
            trend_1h_aligned = _compute_trend_aligned(candles_detect, alert_time, 3600)

            alert['features'] = {
                'trend_4h_aligned': trend_4h_aligned,
                'trend_1h_aligned': trend_1h_aligned
            }

            resolved_alert = evaluate(alert, candles_1m)
            alerts.append(resolved_alert)

    return alerts

def _binance_fetch_paginated(symbol: str, tf: str, start_ms: int, limit: int) -> List[Dict[str, Any]]:
    import subprocess
    url = f"https://fapi.binance.com/fapi/v1/klines?symbol={symbol}&interval={tf}&limit={limit}&startTime={start_ms}"
    try:
        res = subprocess.run(['curl', '-s', '-A', 'Swal-Radar/1.0', url], capture_output=True, text=True, timeout=20)
        data = json.loads(res.stdout)
    except Exception:
        return []

    candles = []
    if not isinstance(data, list):
        return []
    for k in data:
        if not isinstance(k, list) or len(k) < 6:
            continue
        open_time = int(k[0])
        candles.append({
            'time': int(open_time / 1000) if open_time > 1e11 else open_time,
            'open': float(k[1]),
            'high': float(k[2]),
            'low': float(k[3]),
            'close': float(k[4]),
            'volume': float(k[5])
        })
    return candles

def _init_db(db_path: str):
    conn = sqlite3.connect(db_path)
    conn.execute('''
        CREATE TABLE IF NOT EXISTS replay_alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT,
            tf TEXT,
            kind TEXT,
            direction TEXT,
            outcome_r REAL,
            win_1r INTEGER,
            win_2r INTEGER,
            net_r REAL,
            features_json TEXT
        )
    ''')
    conn.commit()
    return conn

def main():
    parser = argparse.ArgumentParser(description="Radar Replay")
    parser.add_argument('--symbol', required=True)
    parser.add_argument('--tf', required=True)
    parser.add_argument('--days', type=int, required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--db', default=os.path.expanduser('~/.local/share/swal-trade/radar-replay.db'))

    args = parser.parse_args()

    forward_db = os.environ.get('RADAR_DB', 'radar.db')
    if os.path.abspath(args.db) == os.path.abspath(forward_db):
        print("Error: --db cannot be the forward radar database")
        exit(1)

    print(BANNER)

    end_ms = int(time.time() * 1000)
    start_ms = end_ms - args.days * 24 * 60 * 60 * 1000

    candles_detect = load_klines(args.symbol, args.tf, start_ms, end_ms, fetch=_binance_fetch_paginated)
    candles_1m = load_klines(args.symbol, '1m', start_ms, end_ms, fetch=_binance_fetch_paginated)

    from radar.sources.core import CoreSource
    from radar.evaluate import evaluate_alert_on_candles

    core = CoreSource()
    scan = core.scan
    evaluate = evaluate_alert_on_candles

    alerts = replay(candles_detect, candles_1m, scan, evaluate, window=300, tf=args.tf, symbol=args.symbol)

    os.makedirs(os.path.dirname(args.db), exist_ok=True)
    conn = _init_db(args.db)

    cells = {}

    for a in alerts:
        features_json = json.dumps(a.get('features', {}))
        outcome_r = a.get('outcome_r', 0.0) or 0.0
        win_1r = 1 if a.get('status') in ('win_1r', 'win_2r') else 0
        win_2r = 1 if a.get('status') == 'win_2r' else 0
        net_r = a.get('net_r', 0.0) or 0.0

        conn.execute('''
            INSERT INTO replay_alerts (symbol, tf, kind, direction, outcome_r, win_1r, win_2r, net_r, features_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (a.get('symbol'), a.get('tf'), a.get('kind'), a.get('direction'), outcome_r, win_1r, win_2r, net_r, features_json))

        key = (a.get('kind'), a.get('tf'), a.get('direction'))
        if key not in cells:
            # ONLY features trend_4h_aligned and trend_1h_aligned as requested
            cells[key] = {
                'kind': a.get('kind'),
                'tf': a.get('tf'),
                'direction': a.get('direction'),
                'n': 0,
                'wins_1r': 0,
                'wins_2r': 0,
                'sum_net_r': 0.0,
                'features': {
                    'trend_4h_aligned': {'true': {'n': 0, 'wins_1r': 0}, 'false': {'n': 0, 'wins_1r': 0}, 'null': {'n': 0, 'wins_1r': 0}},
                    'trend_1h_aligned': {'true': {'n': 0, 'wins_1r': 0}, 'false': {'n': 0, 'wins_1r': 0}, 'null': {'n': 0, 'wins_1r': 0}}
                }
            }

        c = cells[key]
        c['n'] += 1
        c['wins_1r'] += win_1r
        c['wins_2r'] += win_2r
        c['sum_net_r'] += net_r

        t4 = a.get('features', {}).get('trend_4h_aligned')
        t4_key = 'true' if t4 is True else ('false' if t4 is False else 'null')
        c['features']['trend_4h_aligned'][t4_key]['n'] += 1
        c['features']['trend_4h_aligned'][t4_key]['wins_1r'] += win_1r

        t1 = a.get('features', {}).get('trend_1h_aligned')
        t1_key = 'true' if t1 is True else ('false' if t1 is False else 'null')
        c['features']['trend_1h_aligned'][t1_key]['n'] += 1
        c['features']['trend_1h_aligned'][t1_key]['wins_1r'] += win_1r

    conn.commit()
    conn.close()

    out_cells = []
    for c in cells.values():
        n = c['n']
        c['mean_net_r'] = c['sum_net_r'] / n if n > 0 else 0.0
        del c['sum_net_r']
        out_cells.append(c)

    summary = {
        'banner': BANNER,
        'symbol': args.symbol,
        'tf': args.tf,
        'days': args.days,
        'cells': out_cells
    }

    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(summary, f, indent=2)

if __name__ == '__main__':
    main()
