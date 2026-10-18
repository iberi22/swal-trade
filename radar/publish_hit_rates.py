import argparse
import json
import time
import datetime
from typing import Dict, List, Any, Optional, Callable
from collections import defaultdict
from radar.store import RadarStore
from radar.grading import grade_cell
from radar.baseline import random_baseline_rate
from radar.klines_cache import load_klines

def build_public_table(
    forward_alerts: List[Dict[str, Any]],
    baseline_by_cell: Dict[str, Optional[float]],
    period: Dict[str, str],
    market: str
) -> Dict[str, Any]:
    groups = defaultdict(list)
    for a in forward_alerts:
        if a.get('source') == 'replay':
            continue
        if a.get('taken_by_user') == 1:
            continue

        status = a.get('status', 'pending')
        # Include resolved alerts, excluding 'missed' since they have no net_r typically
        if status not in ('win_1r', 'win_2r', 'loss', 'expired'):
            continue
        if a.get('net_r') is None:
            continue

        key = (a.get('kind', ''), a.get('tf', ''), a.get('symbol', ''), a.get('direction', 'long'))
        groups[key].append(a)

    cells_out = []

    for (kind, tf, symbol, direction), alerts in sorted(groups.items()):
        n = len(alerts)
        if n == 0:
            continue

        wins_1r = sum(1 for a in alerts if a.get('status') in ('win_1r', 'win_2r'))
        net_rs = [float(a['net_r']) for a in alerts]

        cell_key = f"{kind}_{tf}_{symbol}_{direction}"
        baseline_rate = baseline_by_cell.get(cell_key)

        grade_info = grade_cell(
            n=n,
            wins=wins_1r,
            net_rs=net_rs,
            rr=1.0,
            cost_r=0.0008,
            baseline_win_rate=baseline_rate
        )

        cells_out.append({
            "kind": kind,
            "tf": tf,
            "symbol": symbol,
            "direction": direction,
            "n": n,
            "wins_1r": wins_1r,
            "rate_1r": round(grade_info['win_rate'], 4) if grade_info.get('win_rate') is not None else 0.0,
            "ci_low": round(grade_info['wilson_low'], 4) if grade_info.get('wilson_low') is not None else None,
            "ci_high": round(grade_info['wilson_high'], 4) if grade_info.get('wilson_high') is not None else None,
            "breakeven": round(grade_info['breakeven'], 4) if grade_info.get('breakeven') is not None else 0.0,
            "baseline_rate": round(baseline_rate, 4) if baseline_rate is not None else None,
            "mean_net_r": round(grade_info['mean_net_r'], 4) if grade_info.get('mean_net_r') is not None else 0.0,
            "grade": grade_info['grade']
        })

    return {
        "schema": "swal.hit-rates.v1",
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "period": period,
        "market": market,
        "method": "forward",
        "cost_round_trip": 0.0008,
        "cells": cells_out,
        "note": "Medición pasada de alertas automáticas; no es una promesa ni una recomendación. Sin evidencia hasta n >= 30; validada solo con n >= 100 y por encima del azar."
    }

def cli_main(args=None, fetch_klines_func: Optional[Callable] = None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    parser.add_argument('--db', default=None)
    parser.add_argument('--baseline-days', type=int, default=30)
    parsed = parser.parse_args(args)

    store = RadarStore(db_path=parsed.db)
    with store.get_connection() as conn:
        cur = conn.execute('SELECT * FROM alerts;')
        all_alerts = [dict(r) for r in cur.fetchall()]

    forward_alerts = []
    for a in all_alerts:
        if a.get('source') != 'replay' and a.get('taken_by_user') != 1:
            status = a.get('status', 'pending')
            if status in ('win_1r', 'win_2r', 'loss', 'expired'):
                if a.get('net_r') is not None:
                    forward_alerts.append(dict(a))

    now = time.time()
    period_from = datetime.datetime.fromtimestamp(now - parsed.baseline_days * 86400, tz=datetime.timezone.utc).strftime("%Y-%m-%d")
    period_to = datetime.datetime.fromtimestamp(now, tz=datetime.timezone.utc).strftime("%Y-%m-%d")
    period = {"from": period_from, "to": period_to}

    cell_risks = defaultdict(list)
    symbol_to_candles = {}

    for a in forward_alerts:
        entry = float(a.get('entry', 0.0))
        stop = float(a.get('stop', 0.0))
        if entry > 0 and entry != stop:
            risk_pct = abs(entry - stop) / entry
            key = (a.get('kind', ''), a.get('tf', ''), a.get('symbol', ''), a.get('direction', 'long'))
            cell_risks[key].append(risk_pct)

    baseline_by_cell = {}

    start_ms = int((now - parsed.baseline_days * 86400) * 1000)
    end_ms = int(now * 1000)

    fetcher = fetch_klines_func if fetch_klines_func else load_klines

    for (kind, tf, symbol, direction), risks in cell_risks.items():
        if symbol not in symbol_to_candles:
            try:
                candles = fetcher(symbol, '1m', start_ms, end_ms)
                symbol_to_candles[symbol] = [
                    {
                        'time': float(c['time'] if 'time' in c else c[0]),
                        'open': float(c['open'] if 'open' in c else c[1]),
                        'high': float(c['high'] if 'high' in c else c[2]),
                        'low': float(c['low'] if 'low' in c else c[3]),
                        'close': float(c['close'] if 'close' in c else c[4])
                    }
                    for c in candles
                ]
            except Exception:
                symbol_to_candles[symbol] = None

        candles_1m = symbol_to_candles.get(symbol)

        cell_key = f"{kind}_{tf}_{symbol}_{direction}"
        if not candles_1m or len(candles_1m) < 200:
            baseline_by_cell[cell_key] = None
            continue

        rate = random_baseline_rate(candles_1m, risks, rr=1.0, cost_r=0.0008, samples=2000, seed=11)
        baseline_by_cell[cell_key] = rate

    result = build_public_table(
        forward_alerts=forward_alerts,
        baseline_by_cell=baseline_by_cell,
        period=period,
        market="crypto"
    )

    with open(parsed.out, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

if __name__ == '__main__':
    cli_main()
