"""Costed study of the 'movement alert' signals over many perpetual pairs (in-sample, NOT forward evidence).

usage: python3 -m radar.movers_study KLINES_DIR UNIVERSE_JSON OUT.md OUT.json
Klines files are JSON arrays of [open_time_ms, open, high, low, close, quote_volume] on 5m bars.
Signals (from the owner's reference repo): price move >= T% over a window ending at the trigger bar.
Each event is evaluated as FOLLOW (trade with the move) and FADE (trade against it), entering at the next bar's
open, with an ATR-based stop (floor 0.3% of price), a 1R target, a 4h time exit and a 0.08% round-trip cost.
Events of one symbol and direction closer than 12 bars are merged. Intervals are cluster bootstraps by day.
"""
import bisect
import json
import math
import os
import random
import sys
from collections import defaultdict

COST = 0.0008
BAR_S = 300
RNG = random.Random(11)
WINDOWS = {'30m': 6, '10m': 2}
THRESHOLDS = {'30m': (3.0, 5.0, 7.0), '10m': (2.0, 3.0)}
HORIZON = 48  # bars, 4h
GAP = 12
STOP_FLOOR = 0.003
VOL_HIGH = 100_000_000


def wilson(w, n, z=1.96):
    if n == 0:
        return (None, None)
    p = w / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def atr_series(h, l, c, p=14):
    out = [None] * len(c)
    a = None
    for i in range(1, len(c)):
        tr = max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
        if i < p:
            a = (a or 0) + tr / p
            if i == p - 1:
                out[i] = a
        else:
            a = (a * (p - 1) + tr) / p
            out[i] = a
    return out


def load(klines_dir):
    data = {}
    for fn in os.listdir(klines_dir):
        if not fn.endswith('.json'):
            continue
        rows = json.load(open(os.path.join(klines_dir, fn)))
        if len(rows) < 2000:
            continue
        data[fn[:-5]] = rows
    return data


def evaluate(entry_i, d, h, l, c, o, risk, entry):
    """Return (net_r, win, ret_net_by_horizon). d=+1 long, -1 short. Entry at open of bar entry_i."""
    target = entry + d * risk
    stop = entry - d * risk
    exit_px = None
    win = 0
    last = min(entry_i + HORIZON, len(c) - 1)
    for j in range(entry_i, last + 1):
        if d == 1:
            hit_stop, hit_tgt = l[j] <= stop, h[j] >= target
        else:
            hit_stop, hit_tgt = h[j] >= stop, l[j] <= target
        if hit_stop:  # stop first when both inside one bar (conservative)
            exit_px = stop
            break
        if hit_tgt:
            exit_px = target
            win = 1
            break
    if exit_px is None:
        exit_px = c[last]
    r = d * (exit_px - entry) / risk
    net_r = r - COST * entry / risk
    rets = {}
    for hh in (6, 12, 48):
        j = min(entry_i + hh, len(c) - 1)
        rets[hh] = d * (c[j] / entry - 1) - COST
    return net_r, win, rets


def collect(data, universe):
    vol24 = universe['volume24h']
    btc = data.get('BTCUSDT')
    btc_t = [r[0] for r in btc] if btc else []
    btc_c = [r[4] for r in btc] if btc else []
    events = []
    for sym, rows in data.items():
        t = [r[0] for r in rows]
        o = [r[1] for r in rows]
        h = [r[2] for r in rows]
        l = [r[3] for r in rows]
        c = [r[4] for r in rows]
        qv = [r[5] for r in rows]
        atr = atr_series(h, l, c)
        tier = 'alto' if vol24.get(sym, 0) >= VOL_HIGH else 'bajo'
        cum = [0.0]
        for x in qv:
            cum.append(cum[-1] + x)
        for wname, W in WINDOWS.items():
            last_evt = {1: -999, -1: -999}
            for i in range(300, len(c) - HORIZON - 2):
                mv = (c[i] / c[i - W] - 1) * 100
                for T in THRESHOLDS[wname]:
                    if abs(mv) < T:
                        continue
                    mdir = 1 if mv > 0 else -1
                    key = (wname, T, mdir)
                    if i - last_evt.get(key, -999) < GAP:
                        continue
                    last_evt[key] = i
                    a = atr[i]
                    if not a:
                        continue
                    entry = o[i + 1]
                    risk = max(1.5 * a, STOP_FLOOR * entry)
                    # volume spike: quote volume of the window vs the trailing 288-bar mean * W
                    base = (cum[i - W + 1] - cum[max(0, i - W + 1 - 288)]) / 288 * W
                    spike = (cum[i + 1] - cum[i - W + 1]) / base if base > 0 else None
                    # market-wide: BTC move over the same window
                    bj = bisect.bisect_left(btc_t, t[i]) if btc else None
                    bmove = None
                    if btc and bj is not None and bj < len(btc_t) and btc_t[bj] == t[i] and bj >= W:
                        bmove = (btc_c[bj] / btc_c[bj - W] - 1) * 100
                    for mode, d in (('follow', mdir), ('fade', -mdir)):
                        net_r, win, rets = evaluate(i + 1, d, h, l, c, o, risk, entry)
                        events.append({'sym': sym, 't': t[i], 'w': wname, 'T': T, 'mdir': mdir, 'mode': mode,
                                       'tier': tier, 'net_r': net_r, 'win': win, 'r6': rets[6], 'r12': rets[12],
                                       'r48': rets[48], 'spike': spike, 'bmove': bmove, 'risk_pct': risk / entry})
    return events


def cluster_ci(vals_by_day, iters=800):
    days = list(vals_by_day)
    if len(days) < 5:
        return None
    means = []
    for _ in range(iters):
        tot, n = 0.0, 0
        for _ in days:
            d = RNG.choice(days)
            v = vals_by_day[d]
            tot += sum(v)
            n += len(v)
        means.append(tot / n if n else 0.0)
    means.sort()
    return means[int(iters * 0.025)], means[int(iters * 0.975)]


def summarize(evs):
    n = len(evs)
    if not n:
        return None
    wins = sum(e['win'] for e in evs)
    by_day = defaultdict(list)
    for e in evs:
        by_day[e['t'] // 86_400_000].append(e['net_r'])
    lo, hi = wilson(wins, n)
    ordered = sorted(evs, key=lambda e: e['t'])
    half = len(ordered) // 2
    m = lambda xs: sum(e['net_r'] for e in xs) / len(xs) if xs else 0.0
    return {'n': n, 'symbols': len({e['sym'] for e in evs}), 'win_rate': wins / n, 'ci_low': lo, 'ci_high': hi,
            'mean_net_r': sum(e['net_r'] for e in evs) / n, 'r_ci': cluster_ci(by_day),
            'mean_ret_30m': sum(e['r6'] for e in evs) / n, 'mean_ret_1h': sum(e['r12'] for e in evs) / n,
            'mean_ret_4h': sum(e['r48'] for e in evs) / n, 'r_first_half': m(ordered[:half]),
            'r_second_half': m(ordered[half:]), 'median_risk_pct': sorted(e['risk_pct'] for e in evs)[n // 2]}


def grade(s):
    if s['n'] < 30:
        return 'no_evidence'
    ci = s['r_ci']
    if ci and ci[1] < 0:
        return 'negative'
    if ci and ci[0] > 0 and s['r_first_half'] > 0 and s['r_second_half'] > 0:
        return 'promising'
    return 'no_evidence'


def main():
    klines_dir, uni, out_md, out_json = sys.argv[1:5]
    universe = json.load(open(uni))
    data = load(klines_dir)
    events = collect(data, universe)
    L = ['# Estudio de senales de movimiento (replay, en muestra)\n',
         f'{len(data)} pares perpetuos USDT (los de mayor volumen), 90 dias de velas de 5m, {len(events) // 2} eventos. '
         'Entrada en la apertura de la vela siguiente, stop de 1,5 ATR (minimo 0,3 % del precio), objetivo 1R, salida por tiempo a 4 h, '
         'coste 0,08 % ida y vuelta. Intervalos: bootstrap por dia. **No es evidencia hacia adelante.** Sesgo de supervivencia: solo pares listados hoy.\n',
         '## Por senal, direccion y volumen\n',
         '| ventana | umbral | modo | volumen 24h | n | pares | acierto 1R (IC95) | R neto | IC95 R | 1a/2a mitad | ret 1h neto | veredicto |',
         '|---|---|---|---|---|---|---|---|---|---|---|---|']
    cells = []
    groups = defaultdict(list)
    for e in events:
        groups[(e['w'], e['T'], e['mode'], e['tier'])].append(e)
        groups[(e['w'], e['T'], e['mode'], 'todos')].append(e)
    for key in sorted(groups):
        s = summarize(groups[key])
        if not s:
            continue
        g = grade(s)
        w, T, mode, tier = key
        ci = f"{s['r_ci'][0]:+.2f}..{s['r_ci'][1]:+.2f}" if s['r_ci'] else 'n/d'
        L.append(f"| {w} | {T:g}% | {mode} | {tier} | {s['n']} | {s['symbols']} | {s['win_rate']:.0%} ({s['ci_low']:.0%}-{s['ci_high']:.0%}) | "
                 f"{s['mean_net_r']:+.2f} | {ci} | {s['r_first_half']:+.2f} / {s['r_second_half']:+.2f} | {s['mean_ret_1h'] * 100:+.2f}% | {g} |")
        cells.append({'signal': f'move_{w}', 'threshold': T, 'mode': mode, 'vol_tier': tier, 'n': s['n'],
                      'win_rate': s['win_rate'], 'ci_low': s['ci_low'], 'ci_high': s['ci_high'],
                      'mean_net_r': s['mean_net_r'], 'grade': g, 'r_first_half': s['r_first_half'],
                      'r_second_half': s['r_second_half']})
    # context slices for the main cell (30m, 5%)
    L += ['', '## Contexto (30m, umbral 5 %): movimiento de todo el mercado contra movimiento propio\n',
          '| modo | contexto | n | acierto 1R | R neto | IC95 R |', '|---|---|---|---|---|---|']
    for mode in ('follow', 'fade'):
        base = [e for e in events if e['w'] == '30m' and e['T'] == 5.0 and e['mode'] == mode and e['bmove'] is not None]
        splits = {
            'propio (BTC se mueve < 1/3)': [e for e in base if abs(e['bmove']) < abs(e['T']) / 3],
            'de mercado (BTC se mueve >= 1/3)': [e for e in base if abs(e['bmove']) >= abs(e['T']) / 3],
            'con pico de volumen (>3x)': [e for e in base if e['spike'] and e['spike'] > 3],
            'sin pico de volumen (<=3x)': [e for e in base if e['spike'] is not None and e['spike'] <= 3],
        }
        for name, evs in splits.items():
            s = summarize(evs)
            if not s:
                continue
            ci = f"{s['r_ci'][0]:+.2f}..{s['r_ci'][1]:+.2f}" if s['r_ci'] else 'n/d'
            L.append(f"| {mode} | {name} | {s['n']} | {s['win_rate']:.0%} | {s['mean_net_r']:+.2f} | {ci} |")
    open(out_md, 'w').write('\n'.join(L) + '\n')
    json.dump({'schema': 'swal.movers-stats.v1', 'method': 'replay_in_sample', 'cells': cells}, open(out_json, 'w'))
    print('\n'.join(L))


if __name__ == '__main__':
    main()
