"""Collect replayed radar alerts with market-context features (in-sample audit, NOT forward evidence).

usage: python3 -m radar.audit_collect SYMBOL TF DAYS OUT.jsonl
Every alert is evaluated from its own creation time on 1m candles (the same evaluator the live radar
uses), de-duplicated per (kind, direction) with a minimum gap, and tagged with context known at detection.
"""
import bisect
import json
import math
import os
import subprocess
import sys
import time

from radar.baseline import random_baseline_rate
from radar.evaluate import evaluate_alert_on_candles, tf_to_seconds
from radar.klines_cache import load_klines
from radar.replay import _binance_fetch_paginated as _fetch_once
from radar.sources.core import CoreSource

MIN_GAP_BARS = 6


def _binance_fetch_paginated(symbol, tf, start_ms, limit):
    """Paced fetch with retries: parallel collectors otherwise trip the weight limit and get empty pages."""
    for attempt in range(6):
        time.sleep(0.4)
        batch = _fetch_once(symbol, tf, start_ms, limit)
        if batch:
            return batch
        time.sleep(5 * (attempt + 1))
    return []


def curl_json(url):
    r = subprocess.run(['curl', '-s', '-m', '20', '-A', 'Swal-Radar/1.0', url], capture_output=True, text=True, timeout=30)
    return json.loads(r.stdout)


def aggregate(c1m, secs):
    out, cur = [], None
    for c in c1m:
        t = (c['time'] // secs) * secs
        if cur is None or cur['time'] != t:
            if cur is not None:
                out.append(cur)
            cur = {'time': t, 'open': c['open'], 'high': c['high'], 'low': c['low'], 'close': c['close']}
        else:
            cur['high'] = max(cur['high'], c['high'])
            cur['low'] = min(cur['low'], c['low'])
            cur['close'] = c['close']
    if cur is not None:
        out.append(cur)
    return out


def ema_series(vals, p):
    k = 2 / (p + 1)
    out, e = [], None
    for i, v in enumerate(vals):
        if i < p - 1:
            out.append(None)
            continue
        e = sum(vals[:p]) / p if i == p - 1 else (v - e) * k + e
        out.append(e)
    return out


def atr_pct_series(bars, p=14):
    trs = []
    for i, b in enumerate(bars):
        pc = bars[i - 1]['close'] if i else b['close']
        trs.append(max(b['high'] - b['low'], abs(b['high'] - pc), abs(b['low'] - pc)))
    out, a = [], None
    for i, tr in enumerate(trs):
        if i < p - 1:
            out.append(None)
            continue
        a = sum(trs[:p]) / p if i == p - 1 else (a * (p - 1) + tr) / p
        out.append(a / bars[i]['close'])
    return out


class Ctx:
    """Context lookups using only information closed before time t."""

    def __init__(self, c1m, symbol, start_s, end_s):
        self.b1h = aggregate(c1m, 3600)
        self.b4h = aggregate(c1m, 14400)
        self.t1h = [b['time'] + 3600 for b in self.b1h]  # close time
        self.t4h = [b['time'] + 14400 for b in self.b4h]
        cl1, cl4 = [b['close'] for b in self.b1h], [b['close'] for b in self.b4h]
        self.e20_1h, self.e50_1h = ema_series(cl1, 20), ema_series(cl1, 50)
        self.e20_4h, self.e50_4h = ema_series(cl4, 20), ema_series(cl4, 50)
        self.atr1h = atr_pct_series(self.b1h)
        vals = sorted(a for a in self.atr1h if a is not None)
        self.q33, self.q66 = vals[len(vals) // 3], vals[2 * len(vals) // 3]
        try:
            fr = curl_json(f'https://fapi.binance.com/fapi/v1/fundingRate?symbol={symbol}&limit=1000')
            self.fund = sorted((int(x['fundingTime']) // 1000, float(x['fundingRate'])) for x in fr)
        except Exception:
            self.fund = []
        try:
            fg = curl_json('https://api.alternative.me/fng/?limit=0')['data']
            self.fng = sorted((int(x['timestamp']), int(x['value'])) for x in fg)
        except Exception:
            self.fng = []

    def _last(self, times, t):
        i = bisect.bisect_right(times, t) - 1
        return i if i >= 0 else None

    def at(self, t, direction):
        f = {}
        i = self._last(self.t1h, t)
        j = self._last(self.t4h, t)
        sign = 1 if direction == 'long' else -1
        if j is not None and self.e20_4h[j] and self.e50_4h[j]:
            up = self.e20_4h[j] > self.e50_4h[j]
            f['trend_4h'] = 'with' if up == (direction == 'long') else 'against'
        if i is not None and self.e20_1h[i] and self.e50_1h[i]:
            up = self.e20_1h[i] > self.e50_1h[i]
            f['trend_1h'] = 'with' if up == (direction == 'long') else 'against'
        if i is not None and self.atr1h[i] is not None:
            a = self.atr1h[i]
            f['vol'] = 'low' if a <= self.q33 else ('mid' if a <= self.q66 else 'high')
        h = int((t % 86400) // 3600)
        f['session'] = 'asia' if h < 8 else ('eu' if h < 16 else 'us')
        if self.fund:
            k = bisect.bisect_right([x[0] for x in self.fund], t) - 1
            if k >= 0:
                r = self.fund[k][1] * sign  # >0: our side pays (crowded on our side)
                f['funding'] = 'crowded_with' if r > 0.00005 else ('crowded_against' if r < -0.00002 else 'neutral')
        if self.fng:
            k = bisect.bisect_right([x[0] for x in self.fng], t) - 1
            if k >= 0:
                v = self.fng[k][1]
                f['fng'] = 'fear' if v < 40 else ('greed' if v > 60 else 'neutral')
        return f


def main():
    # The audit must see every pattern, including the ones the live radar mutes by default.
    os.environ['RADAR_EXCLUDE_CELLS'] = ''
    os.environ['RADAR_MIN_RISK_PCT'] = '0'
    symbol, tf, days, out = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
    day_ms = 86400 * 1000
    end_ms = int(time.time() * 1000) // day_ms * day_ms  # aligned to the day so the kline cache is reused
    start_ms = end_ms - days * day_ms
    det = load_klines(symbol, tf, start_ms, end_ms, fetch=_binance_fetch_paginated)
    c1m = load_klines(symbol, '1m', start_ms, end_ms, fetch=_binance_fetch_paginated)
    c1m.sort(key=lambda c: c['time'])
    t1m = [c['time'] for c in c1m]
    tfs = tf_to_seconds(tf)
    ctx = Ctx(c1m, symbol, start_ms // 1000, end_ms // 1000)
    core = CoreSource()
    last_idx = {}
    rows, risks = [], {}
    window = 300
    for i in range(window, len(det) + 1):
        w = det[i - window:i]
        t_close = w[-1]['time'] + tfs
        for a in core.scan(symbol, tf, w):
            key = (a['kind'], a['direction'])
            if i - last_idx.get(key, -999) < MIN_GAP_BARS:
                continue
            last_idx[key] = i
            a = dict(a)
            a['created_at'] = t_close
            lo = bisect.bisect_left(t1m, t_close)
            hi = bisect.bisect_right(t1m, t_close + tfs * 100)
            res = evaluate_alert_on_candles(a, c1m[lo:hi])
            risk_pct = abs(a['entry'] - a['stop']) / a['entry']
            risks.setdefault(key, []).append(risk_pct)
            rows.append({'t': t_close, 'symbol': symbol, 'tf': tf, 'kind': a['kind'], 'direction': a['direction'],
                         'strength': a['strength'], 'risk_pct': risk_pct, 'status': res.get('status'),
                         'net_r': res.get('net_r'), 'mfe_r': res.get('mfe_r'), 'mae_r': res.get('mae_r'),
                         **ctx.at(t_close, a['direction'])})
    base = {}
    for (kind, d), rs in risks.items():
        base[f'{kind}|{d}'] = random_baseline_rate(c1m, rs[:200], rr=1.0)
    with open(out, 'w') as fh:
        fh.write(json.dumps({'meta': {'symbol': symbol, 'tf': tf, 'days': days, 'candles_1m': len(c1m),
                                      'generated': time.time(), 'baseline': base}}) + '\n')
        for r in rows:
            fh.write(json.dumps(r) + '\n')
    print(f'{symbol} {tf}: {len(rows)} alerts', flush=True)


if __name__ == '__main__':
    main()
