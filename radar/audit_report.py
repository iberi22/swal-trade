"""Markdown report over radar.audit_collect output (in-sample replay; NOT forward evidence).

usage: python3 -m radar.audit_report OUT.md FILE.jsonl [FILE.jsonl ...]
"""
import json
import math
import random
import sys
from collections import defaultdict

from radar.grading import wilson_bounds as wilson_interval

RESOLVED = ('win_1r', 'win_2r', 'loss')
CONTEXT = ('trend_4h', 'trend_1h', 'vol', 'session', 'funding', 'fng')
RNG = random.Random(7)


def gross_baselines(rows):
    """Random-entry control with the SAME definition as the cell win rate (1R touch before the stop, no costs)."""
    import time
    from radar.baseline import random_baseline_rate
    from radar.klines_cache import load_klines
    from radar.audit_collect import _binance_fetch_paginated
    day = 86400 * 1000
    end = int(time.time() * 1000) // day * day
    c1m = {}
    for sym in {r['symbol'] for r in rows}:
        c1m[sym] = load_klines(sym, '1m', end - 90 * day, end, fetch=_binance_fetch_paginated)
    risks = defaultdict(list)
    for r in rows:
        risks[(r['symbol'], r['kind'], r['direction'])].append(r['risk_pct'])
    out = {}
    for (sym, kind, d), rs in risks.items():
        out[(sym, kind, d)] = random_baseline_rate(c1m[sym], rs[:200], rr=1.0, cost_r=0.0, samples=1500, seed=5)
    return out


def load(paths):
    rows, base = [], {}
    for p in paths:
        with open(p) as fh:
            meta = json.loads(fh.readline())['meta']
            for k, v in meta['baseline'].items():
                base[(meta['symbol'], meta['tf'], k)] = v
            for ln in fh:
                r = json.loads(ln)
                if r['status'] in RESOLVED and r.get('net_r') is not None:
                    r['win'] = 1 if r['status'] in ('win_1r', 'win_2r') else 0
                    rows.append(r)
    return rows, base


def fill_fng(rows):
    """Fear & Greed is a daily public series; fill it in rows whose collector could not fetch it."""
    import bisect
    import subprocess
    if all(r.get('fng') for r in rows):
        return
    try:
        out = subprocess.run(['curl', '-s', '-m', '30', '-A', 'Swal-Radar/1.0', 'https://api.alternative.me/fng/?limit=0'],
                             capture_output=True, text=True, timeout=40).stdout
        series = sorted((int(x['timestamp']), int(x['value'])) for x in json.loads(out)['data'])
    except Exception:
        return
    ts = [t for t, _ in series]
    for r in rows:
        if r.get('fng'):
            continue
        k = bisect.bisect_right(ts, r['t']) - 1
        if k >= 0:
            v = series[k][1]
            r['fng'] = 'fear' if v < 40 else ('greed' if v > 60 else 'neutral')


def boot_mean(vals, iters=1000):
    if len(vals) < 5:
        return None
    ms = []
    for _ in range(iters):
        ms.append(sum(RNG.choice(vals) for _ in vals) / len(vals))
    ms.sort()
    return ms[int(iters * 0.025)], ms[int(iters * 0.975)]


def stats(rs):
    n = len(rs)
    w = sum(r['win'] for r in rs)
    nets = [r['net_r'] for r in rs]
    lo, hi = wilson_interval(w, n) if n else (None, None)
    ci = boot_mean(nets)
    return {'n': n, 'win': w / n if n else None, 'lo': lo, 'hi': hi, 'mean': sum(nets) / n if n else None,
            'ci': ci}


def fmt(s):
    if not s['n']:
        return '| 0 | - | - | - |'
    ci = f"{s['ci'][0]:+.2f}..{s['ci'][1]:+.2f}" if s['ci'] else 'n/d'
    return f"| {s['n']} | {s['win']:.0%} ({s['lo']:.0%}-{s['hi']:.0%}) | {s['mean']:+.2f} | {ci} |"


def verdict(s, base):
    if s['n'] < 30:
        return 'sin evidencia (n<30)'
    ci = s['ci']
    if ci and ci[1] < 0:
        return 'NEGATIVA (IC95 de R neto <0)'
    if ci and ci[0] > 0 and (base is None or s['lo'] > base):
        return 'positiva en la muestra (confirmar hacia adelante)'
    return 'no distinguible de cero'


def main():
    out, paths = sys.argv[1], sys.argv[2:]
    rows, base = load(paths)
    fill_fng(rows)
    gb = gross_baselines(rows)
    L = []
    P = L.append
    P('# Auditoria de patrones del radar (replay, en muestra)\n')
    P('Replay sobre velas historicas, evaluado con el mismo evaluador del radar en vivo. Es **en muestra**: no es evidencia hacia adelante. '
      'Se descartan alertas ya superadas y se separan las repetidas (min. 6 velas por patron y direccion).\n')
    syms = sorted({r['symbol'] for r in rows})
    P(f'Simbolos: {", ".join(syms)}. Operaciones resueltas: **{len(rows)}**.\n')
    allst = stats(rows)
    P('## Global\n')
    P('| n | acierto 1R (IC95) | R neto medio | IC95 bootstrap |')
    P('|---|---|---|---|')
    P(fmt(allst) + '\n')

    P('## Por patron y direccion (BTC+ETH, 15m+1h)\n')
    P('| patron | dir | n | acierto 1R (IC95) | R neto | IC95 R | R 1ra mitad / 2da | azar (bruto) | veredicto |')
    P('|---|---|---|---|---|---|---|---|---|')
    cells = defaultdict(list)
    for r in rows:
        cells[(r['kind'], r['direction'])].append(r)
    summary = []
    for (kind, d), rs in sorted(cells.items(), key=lambda kv: -len(kv[1])):
        s = stats(rs)
        bs = [gb.get((r['symbol'], kind, d)) for r in rs]
        bs = [b for b in bs if b is not None]
        b = sum(bs) / len(bs) if bs else None
        v = verdict(s, b)
        ordered = sorted(rs, key=lambda x: x['t'])
        h1, h2 = ordered[:len(ordered) // 2], ordered[len(ordered) // 2:]
        m1 = sum(x['net_r'] for x in h1) / len(h1) if h1 else 0.0
        m2 = sum(x['net_r'] for x in h2) / len(h2) if h2 else 0.0
        robust_neg = bool(s['n'] >= 100 and s['ci'] and s['ci'][1] < 0 and m1 < 0 and m2 < 0)
        if robust_neg:
            v = 'NEGATIVA ROBUSTA (ambas mitades)'
        summary.append((kind, d, s, b, v, robust_neg, m1, m2))
        ci = f"{s['ci'][0]:+.2f}..{s['ci'][1]:+.2f}" if s['ci'] else 'n/d'
        P(f"| {kind} | {d} | {s['n']} | {s['win']:.0%} ({s['lo']:.0%}-{s['hi']:.0%}) | {s['mean']:+.2f} | {ci} | {m1:+.2f} / {m2:+.2f} | "
          f"{('%.0f%%' % (b * 100)) if b is not None else 'n/d'} | {v} |")
    P('')

    P('## Costes: el tamano del stop manda\n')
    P('| stop (% del precio) | n | acierto 1R (IC95) | R neto | IC95 R |')
    P('|---|---|---|---|---|')
    for lab, lo_, hi_ in (('<0.15%', 0, 0.0015), ('0.15-0.3%', 0.0015, 0.003), ('0.3-0.6%', 0.003, 0.006), ('0.6-1.2%', 0.006, 0.012), ('>1.2%', 0.012, 9)):
        rs = [r for r in rows if lo_ <= r['risk_pct'] < hi_]
        P(f'| {lab} ' + fmt(stats(rs)))
    P('')

    P('## Dependencia del contexto de mercado (todos los patrones juntos)\n')
    P('Tendencia, volatilidad, sesion, funding y miedo/codicia conocidos en el momento de la alerta.\n')
    P('| variable | valor | n | acierto 1R (IC95) | R neto | IC95 R |')
    P('|---|---|---|---|---|---|')
    ctx_hits = []
    for f in CONTEXT:
        vals = sorted({r.get(f) for r in rows if r.get(f)})
        for v in vals:
            rs = [r for r in rows if r.get(f) == v]
            s = stats(rs)
            P(f'| {f} | {v} ' + fmt(s))
            if s['n'] >= 100 and s['ci'] and (s['ci'][0] > 0 or s['ci'][1] < 0):
                ctx_hits.append((f, v, s))
    P('')
    P('Valores con n>=100 cuyo IC95 no incluye 0: ' + (', '.join(f"{f}={v} ({s['mean']:+.2f}R)" for f, v, s in ctx_hits) or 'ninguno') + '.\n')

    P('## Prueba de seleccion fuera de muestra (sin trampas)\n')
    P('Se eligen las combinaciones patron+direccion con mejor R neto en el primer 60% del tiempo (n>=20) y se miden en el 40% final.\n')
    rows.sort(key=lambda r: r['t'])
    cut = rows[int(len(rows) * 0.6)]['t']
    train = [r for r in rows if r['t'] < cut]
    test = [r for r in rows if r['t'] >= cut]
    tc = defaultdict(list)
    for r in train:
        tc[(r['kind'], r['direction'])].append(r)
    ranked = sorted(((sum(x['net_r'] for x in rs) / len(rs), k) for k, rs in tc.items() if len(rs) >= 20), reverse=True)
    top = [k for _, k in ranked[:5]]
    sel = [r for r in test if (r['kind'], r['direction']) in top]
    P('Elegidas: ' + (', '.join(f'{k[0]}/{k[1]}' for k in top) or 'ninguna') + '\n')
    P('| conjunto | n | acierto 1R (IC95) | R neto | IC95 R |')
    P('|---|---|---|---|---|')
    P('| elegidas, tramo de prueba ' + fmt(stats(sel)))
    P('| todos, tramo de prueba ' + fmt(stats(test)))
    P('')

    with open(out, 'w') as fh:
        fh.write('\n'.join(L))
    print('\n'.join(L))
    json.dump([{'kind': k, 'direction': d, 'n': s['n'], 'win': s['win'], 'mean_net_r': s['mean'],
                'ci': s['ci'], 'baseline': b, 'verdict': v, 'robust_negative': rn, 'r_first_half': m1, 'r_second_half': m2}
               for k, d, s, b, v, rn, m1, m2 in summary],
              open(out.replace('.md', '.json'), 'w'))


if __name__ == '__main__':
    main()
