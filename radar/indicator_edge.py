"""Does any classic indicator signal (the ones feeding the bot's consensus) predict the next bars?

usage: python3 -m radar.indicator_edge OUT.md SYMBOL...   (reads the klines cache; in-sample)
Signal -> forward return over H bars (direction adjusted) minus round-trip cost, compared with the
distribution of the same statistic at random times (permutation, same count). No parameter tuning.
"""
import json
import os
import random
import sys
import time

from radar.klines_cache import load_klines
from radar.audit_collect import _binance_fetch_paginated, ema_series

COST = 0.0008
RNG = random.Random(3)


def rsi(cl, p=14):
    out = [None] * len(cl)
    g = l = 0.0
    for i in range(1, len(cl)):
        d = cl[i] - cl[i - 1]
        up, dn = max(d, 0), max(-d, 0)
        if i <= p:
            g += up / p
            l += dn / p
            if i == p:
                out[i] = 100 - 100 / (1 + g / l) if l else 100
        else:
            g = (g * (p - 1) + up) / p
            l = (l * (p - 1) + dn) / p
            out[i] = 100 - 100 / (1 + g / l) if l else 100
    return out


def macd_hist(cl):
    e12, e26 = ema_series(cl, 12), ema_series(cl, 26)
    line = [a - b if a is not None and b is not None else None for a, b in zip(e12, e26)]
    vals = [v for v in line if v is not None]
    sig = ema_series(vals, 9)
    out, k = [None] * len(cl), 0
    for i, v in enumerate(line):
        if v is None:
            continue
        out[i] = v - sig[k] if sig[k] is not None else None
        k += 1
    return out


def signals(c):
    cl = [x['close'] for x in c]
    r = rsi(cl)
    h = macd_hist(cl)
    e20, e50 = ema_series(cl, 20), ema_series(cl, 50)
    S = {k: [] for k in ('rsi_oversold_long', 'rsi_overbought_short', 'rsi_trend_long(>60)', 'rsi_trend_short(<40)',
                         'macd_cross_up_long', 'macd_cross_down_short', 'ema_cross_up_long', 'ema_cross_down_short',
                         'trend_follow_long(e20>e50)', 'trend_follow_short(e20<e50)')}
    for i in range(60, len(cl) - 1):
        if r[i] is not None and r[i - 1] is not None:
            if r[i] < 30 <= r[i - 1] or (r[i] < 30):
                S['rsi_oversold_long'].append((i, 1))
            if r[i] > 70:
                S['rsi_overbought_short'].append((i, -1))
            if r[i] > 60 and r[i - 1] <= 60:
                S['rsi_trend_long(>60)'].append((i, 1))
            if r[i] < 40 and r[i - 1] >= 40:
                S['rsi_trend_short(<40)'].append((i, -1))
        if h[i] is not None and h[i - 1] is not None:
            if h[i] > 0 >= h[i - 1]:
                S['macd_cross_up_long'].append((i, 1))
            if h[i] < 0 <= h[i - 1]:
                S['macd_cross_down_short'].append((i, -1))
        if e20[i] and e50[i] and e20[i - 1] and e50[i - 1]:
            if e20[i] > e50[i] and e20[i - 1] <= e50[i - 1]:
                S['ema_cross_up_long'].append((i, 1))
            if e20[i] < e50[i] and e20[i - 1] >= e50[i - 1]:
                S['ema_cross_down_short'].append((i, -1))
            if e20[i] > e50[i]:
                S['trend_follow_long(e20>e50)'].append((i, 1))
            else:
                S['trend_follow_short(e20<e50)'].append((i, -1))
    return cl, S


def fwd(cl, i, d, H):
    j = min(i + H, len(cl) - 1)
    return d * (cl[j] / cl[i] - 1) - COST


def main():
    out, syms = sys.argv[1], sys.argv[2:]
    day = 86400 * 1000
    end = int(time.time() * 1000) // day * day
    L = ['# Poder predictivo de los indicadores clasicos (en muestra, 90 dias)\n',
         f'Retorno hacia adelante a H velas, ajustado por direccion, menos {COST:.2%} de coste ida y vuelta. '
         'Referencia: el mismo estadistico en instantes aleatorios (misma cantidad de senales, 1000 permutaciones). '
         'Una senal solo aporta si su media supera el percentil 97.5 del azar.\n',
         '| activo | tf | senal | H | n | media neta | azar p2.5..p97.5 | percentil |', '|---|---|---|---|---|---|---|---|']
    flag = []
    for sym in syms:
        for tf in ('15m', '1h'):
            c = load_klines(sym, tf, end - 90 * day, end, fetch=_binance_fetch_paginated)
            cl, S = signals(c)
            for name, sg in S.items():
                # de-overlap: keep signals at least H bars apart
                for H in (4, 12):
                    picks, last = [], -999
                    for i, d in sg:
                        if i - last >= H:
                            picks.append((i, d))
                            last = i
                    if len(picks) < 30:
                        continue
                    m = sum(fwd(cl, i, d, H) for i, d in picks) / len(picks)
                    ref = []
                    for _ in range(1000):
                        ref.append(sum(fwd(cl, RNG.randrange(60, len(cl) - 1), d, H) for _, d in picks) / len(picks))
                    ref.sort()
                    pct = sum(1 for v in ref if v < m) / len(ref)
                    L.append(f'| {sym} | {tf} | {name} | {H} | {len(picks)} | {m * 100:+.3f}% | '
                             f'{ref[25] * 100:+.3f}..{ref[975] * 100:+.3f}% | {pct:.0%} |')
                    if pct > 0.975:
                        flag.append(f'{sym} {tf} {name} H={H}')
    L.append('')
    L.append('Senales por encima del percentil 97.5 del azar: ' + (', '.join(flag) or 'ninguna') + '. '
             'Con ~80 pruebas se esperan 2 falsos positivos por casualidad.')
    open(out, 'w').write('\n'.join(L))
    print('\n'.join(L))


if __name__ == '__main__':
    main()
