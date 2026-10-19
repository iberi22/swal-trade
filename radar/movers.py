"""Reference implementation of the movers scanner (docs/design/SCANNER.md, 'Especificacion compartida').

Pure functions over closed bars, stdlib only. The TypeScript port is tested against the goldens this module
writes (apps/extension/src/lib/scanner/spec/golden/*.json).

Bars are dicts {open_time_ms, open, high, low, close, volume, quote_volume, taker_buy_volume}, oldest first,
closed bars only. `i` is the index of the last closed bar.

Conventions fixed here where the design leaves room (the TS port must copy them):
* ret_W(i) is a fraction (0.04 = 4 %), None if history is short or any open-time step is not one bar.
* Edge trigger needs ret_W(i) AND ret_W(i-1) to be non-null (a gap inside the previous window means no event).
  Percent comparison is `abs(ret) * 100 >= T`.
* Only signals whose bar_minutes equals the spec bar_minutes are detected (fast2 is 'measured: false').
* breadth = (symbols with ret_W(i) not None, same sign as the event, abs(ret) >= T/2 %) / (symbols with
  ret_W(i) not None), the event symbol included.
* Events have close_time_ms = open_time_ms + bar_ms (not Binance closeTime, which is 1 ms less).
* Alert strength is a constant 0.5 and is NOT a score or a probability.
"""
import argparse
import bisect
import hashlib
import json
import os
import random
import sys
from typing import Any, Dict, List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
SPEC_DIR = os.path.join(REPO_ROOT, 'apps', 'extension', 'src', 'lib', 'scanner', 'spec')
SPEC_PATH = os.path.join(SPEC_DIR, 'movers-spec.json')
GOLDEN_DIR = os.path.join(SPEC_DIR, 'golden')
MARKET_SYMBOL = 'MARKET'


# ---------------------------------------------------------------- spec

def load_spec(path: Optional[str] = None) -> Dict[str, Any]:
    with open(path or SPEC_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)


def _canon(o: Any) -> Any:
    """Integral floats become ints so the canonical text is identical in Python and JavaScript."""
    if isinstance(o, float) and o == int(o):
        return int(o)
    if isinstance(o, dict):
        return {k: _canon(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_canon(v) for v in o]
    return o


def canonical_json(spec: Dict[str, Any]) -> str:
    return json.dumps(_canon(spec), sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def spec_sha(spec: Optional[Dict[str, Any]] = None) -> str:
    spec = spec if spec is not None else load_spec()
    return hashlib.sha256(canonical_json(spec).encode('utf-8')).hexdigest()


# ---------------------------------------------------------------- bars

def bars_from_klines(rows: List[list]) -> List[Dict[str, Any]]:
    """Binance kline arrays -> bar dicts (indexes 0,1,2,3,4,5,7,9)."""
    return [{
        'open_time_ms': int(r[0]), 'open': float(r[1]), 'high': float(r[2]), 'low': float(r[3]),
        'close': float(r[4]), 'volume': float(r[5]), 'quote_volume': float(r[7]),
        'taker_buy_volume': float(r[9]),
    } for r in rows]


def _bar_ms(spec: Dict[str, Any], sig: Optional[Dict[str, Any]] = None) -> int:
    return int((sig or {}).get('bar_minutes', spec['bar_minutes'])) * 60000


def index_of(bars: List[Dict[str, Any]], open_time_ms: int) -> Optional[int]:
    times = [b['open_time_ms'] for b in bars]
    k = bisect.bisect_left(times, open_time_ms)
    return k if k < len(times) and times[k] == open_time_ms else None


# ---------------------------------------------------------------- metrics

def ret_w(bars, i: int, W: int, bar_ms: int = 300000) -> Optional[float]:
    if i - W < 0 or i >= len(bars):
        return None
    for k in range(i - W + 1, i + 1):
        if bars[k]['open_time_ms'] - bars[k - 1]['open_time_ms'] != bar_ms:
            return None
    return bars[i]['close'] / bars[i - W]['close'] - 1


def vol_tier(q24: float, spec: Dict[str, Any]) -> str:
    for t in spec['vol_tiers']:
        if q24 >= t['min_q24']:
            return t['id']
    return spec['vol_tiers'][-1]['id']


def vol_ratio(bars, i: int, W: int, spec: Dict[str, Any]) -> Optional[float]:
    n = spec['vol_baseline_bars']
    if i - W - n + 1 < 0:
        return None
    recent = sum(bars[k]['quote_volume'] for k in range(i - W + 1, i + 1))
    base = sum(bars[k]['quote_volume'] for k in range(i - W - n + 1, i - W + 1)) / n
    if base <= 0:
        return None
    return recent / (W * base)


def taker_imb(bars, i: int, W: int) -> Optional[float]:
    if i - W + 1 < 0:
        return None
    vol = sum(bars[k]['volume'] for k in range(i - W + 1, i + 1))
    if vol <= 0:
        return None
    tb = sum(bars[k]['taker_buy_volume'] for k in range(i - W + 1, i + 1))
    return 2 * tb / vol - 1


def atr14(bars, i: int, period: int = 14) -> Optional[float]:
    """Simple mean of the last `period` true ranges ending at bar i."""
    if i - period < 0 or i >= len(bars):
        return None
    total = 0.0
    for k in range(i - period + 1, i + 1):
        b, pc = bars[k], bars[k - 1]['close']
        total += max(b['high'] - b['low'], abs(b['high'] - pc), abs(b['low'] - pc))
    return total / period


def breadth(rets: Dict[str, Optional[float]], sign: int, T: float) -> Optional[float]:
    """Fraction of the universe (symbols with a valid ret) moving the same way with abs(ret) >= T/2 %."""
    valid = [r for r in rets.values() if r is not None]
    if not valid:
        return None
    same = sum(1 for r in valid if (r > 0) == (sign > 0) and r != 0 and abs(r) * 100 >= T / 2)
    return same / len(valid)


def market_wide(b: Optional[float], spec: Dict[str, Any]) -> bool:
    return b is not None and b >= spec['market_wide_breadth']


def rel_btc(ret_sym: Optional[float], ret_btc: Optional[float]) -> Optional[float]:
    if ret_sym is None or ret_btc is None:
        return None
    return ret_sym - ret_btc


# ---------------------------------------------------------------- detection

def detect_events(bars_by_symbol, i_time: int, q24_by_symbol, spec, btc_symbol: str = 'BTCUSDT'):
    """Edge-triggered events on the bar whose open time is `i_time`, one per crossing and threshold.
    Sorted by (symbol, signal, threshold)."""
    out: List[Dict[str, Any]] = []
    for sname in sorted(spec['signals']):
        sig = spec['signals'][sname]
        if sig.get('bar_minutes', spec['bar_minutes']) != spec['bar_minutes']:
            continue
        W = sig['window_min'] // spec['bar_minutes']
        bar_ms = _bar_ms(spec)
        idx, rets, prevs = {}, {}, {}
        for sym, bars in bars_by_symbol.items():
            i = index_of(bars, i_time)
            if i is None:
                continue
            idx[sym] = i
            rets[sym] = ret_w(bars, i, W, bar_ms)
            prevs[sym] = ret_w(bars, i - 1, W, bar_ms) if i >= 1 else None
        for sym in sorted(idx):
            r, rp = rets[sym], prevs[sym]
            if r is None or rp is None:
                continue
            i, bars = idx[sym], bars_by_symbol[sym]
            sign = 1 if r > 0 else -1
            q24 = float(q24_by_symbol.get(sym, 0.0))
            for T in spec['thresholds_pct']:
                if not (abs(r) * 100 >= T and abs(rp) * 100 < T):
                    continue
                br = breadth(rets, sign, T)
                out.append({
                    'symbol': sym, 'signal': sname, 'window_min': sig['window_min'], 'threshold': T,
                    'move': 'up' if sign > 0 else 'down', 'ret': r,
                    'open_time_ms': bars[i]['open_time_ms'],
                    'close_time_ms': bars[i]['open_time_ms'] + bar_ms,
                    'close': bars[i]['close'], 'q24': q24, 'tier': vol_tier(q24, spec),
                    'vol_ratio': vol_ratio(bars, i, W, spec), 'taker_imb': taker_imb(bars, i, W),
                    'atr14': atr14(bars, i, spec['atr_period']),
                    'breadth': br, 'market_wide': market_wide(br, spec),
                    'rel_btc': rel_btc(r, rets.get(btc_symbol)),
                })
    return out


# ---------------------------------------------------------------- plans and alerts

def plans_for_event(event, spec) -> Dict[str, Optional[Dict[str, Any]]]:
    """{'follow': plan|None, 'fade': plan|None}. A plan is None when atr is missing or the stop is wider than
    max_stop_frac of the entry."""
    atr = event.get('atr14')
    move_sign = 1 if event['ret'] > 0 else -1
    plans: Dict[str, Optional[Dict[str, Any]]] = {}
    for mode, d in (('follow', move_sign), ('fade', -move_sign)):
        if not atr or atr <= 0:
            plans[mode] = None
            continue
        entry = event['close'] + d * spec['entry_atr'] * atr
        s = max(spec['stop_atr'] * atr, spec['min_stop_frac'] * entry)
        if s / entry > spec['max_stop_frac']:
            plans[mode] = None
            continue
        plans[mode] = {
            'mode': mode, 'direction': 'long' if d > 0 else 'short', 'entry': entry,
            'stop': entry - d * s, 't1': entry + d * s, 't2': entry + 2 * d * s, 'stop_dist': s,
        }
    return plans


def _es(x: float, nd: int = 1) -> str:
    return f'{x:.{nd}f}'.replace('.', ',')


def alert_dict(symbol: str, event, plan, spec) -> Dict[str, Any]:
    """Radar alert dict (RadarStore.create_alert). strength is a fixed 0.5: it is NOT a score."""
    up = event['move'] == 'up'
    win, T, mode = event['window_min'], event['threshold'], plan['mode']
    verb = 'Sube' if up else 'Baja'
    how = 'seguir el movimiento' if mode == 'follow' else 'ir contra el movimiento'
    return {
        'source': 'movers', 'symbol': symbol, 'tf': spec['tf_label'],
        'kind': f"mv_{mode}_{win}m_t{T}_{event['tier']}",
        'title': f"{verb} {_es(abs(event['ret']) * 100)} % en {win} min ({how})",
        'direction': plan['direction'], 'entry': plan['entry'], 'stop': plan['stop'],
        'target_1r': plan['t1'], 'target_2r': plan['t2'],
        'strength': 0.5, 'status': 'pending',
        'dedupe_key': f"mv:{symbol}:{event['signal']}:{T}:{event['move']}:{mode}",
        'created_at': event['close_time_ms'] / 1000.0,
    }


# ---------------------------------------------------------------- cooldown

class CooldownTracker:
    """Cooldown per (symbol, signal, move) and market-burst collapse.

    process(events) takes the events of ONE bar and returns a list of
    {'type': 'new'|'update', 'event': ev, 'prev_threshold': None|T}.
    * Within a bar only the highest threshold per key is considered.
    * Inside the cooldown (measured from the first event of the key) a higher threshold gives an 'update'
      and raises the key's level; an equal or lower one is dropped. At exactly cooldown_min it is new again.
    * If more than max_events_per_bar market_wide events occur in the bar they are replaced by one event per
      (signal, move) with symbol 'MARKET', market=True, count and symbols; it follows the same cooldown.
    """

    def __init__(self, spec):
        self.spec = spec
        self.state: Dict[tuple, Dict[str, Any]] = {}

    def _apply(self, key, ev, out):
        t = ev['close_time_ms']
        st = self.state.get(key)
        if st is not None and t - st['t0'] < self.spec['cooldown_min'] * 60000:
            if ev['threshold'] > st['max_t']:
                out.append({'type': 'update', 'event': ev, 'prev_threshold': st['max_t']})
                st['max_t'] = ev['threshold']
            return
        self.state[key] = {'t0': t, 'max_t': ev['threshold']}
        out.append({'type': 'new', 'event': ev, 'prev_threshold': None})

    def process(self, events):
        events = list(events)
        mw = [e for e in events if e.get('market_wide')]
        rest = events
        collapsed: List[Dict[str, Any]] = []
        if len(mw) > self.spec['max_events_per_bar']:
            rest = [e for e in events if not e.get('market_wide')]
            groups: Dict[tuple, List[Dict[str, Any]]] = {}
            for e in mw:
                groups.setdefault((e['signal'], e['move']), []).append(e)
            for (sig, move) in sorted(groups):
                g = groups[(sig, move)]
                top = max(g, key=lambda e: (e['threshold'], e['symbol']))
                collapsed.append({
                    'symbol': MARKET_SYMBOL, 'signal': sig, 'move': move, 'market': True,
                    'threshold': top['threshold'], 'window_min': top['window_min'],
                    'open_time_ms': top['open_time_ms'], 'close_time_ms': top['close_time_ms'],
                    'count': len(g), 'symbols': sorted({e['symbol'] for e in g}), 'market_wide': True,
                })
        best: Dict[tuple, Dict[str, Any]] = {}
        for e in rest:
            k = (e['symbol'], e['signal'], e['move'])
            if k not in best or e['threshold'] > best[k]['threshold']:
                best[k] = e
        out: List[Dict[str, Any]] = []
        for k in sorted(best):
            self._apply(k, best[k], out)
        for e in collapsed:
            self._apply((e['symbol'], e['signal'], e['move']), e, out)
        return out


# ---------------------------------------------------------------- goldens

def _bars(rng, closes, start_ms, bar_ms=300000, noise=0.0005, vol=1000.0, skip=()):
    """Synthetic bars from a close path. `skip` = indexes dropped afterwards (gaps)."""
    bars, prev = [], closes[0]
    for n, c in enumerate(closes):
        hi = max(prev, c) * (1 + noise * rng.random())
        lo = min(prev, c) * (1 - noise * rng.random())
        v = round(vol * (0.8 + 0.4 * rng.random()), 3)
        # a quiet history then a loud move bar: volume x4 when the bar moves more than 1 %
        if abs(c / prev - 1) > 0.01:
            v = round(v * 4, 3)
        bars.append({
            'open_time_ms': start_ms + n * bar_ms, 'open': round(prev, 6), 'high': round(hi, 6),
            'low': round(lo, 6), 'close': round(c, 6), 'volume': v,
            'quote_volume': round(v * c, 3), 'taker_buy_volume': round(v * (0.3 + 0.5 * rng.random()), 3),
        })
        prev = c
    return [b for n, b in enumerate(bars) if n not in set(skip)]


def _path(rng, n, base, jumps, drift=0.0004):
    """Flat random path with explicit {index: new_level_multiplier} steps that persist."""
    out, level = [], base
    for n_ in range(n):
        level *= 1 + (rng.random() - 0.5) * 2 * drift
        if n_ in jumps:
            level *= jumps[n_]
        out.append(level)
    return out


START = 1_760_000_000_000 - (1_760_000_000_000 % 300000)
N = 60
I0 = 50  # index of the signal bar in the datasets


def build_datasets(spec):
    rng = random.Random(20261019)
    st = START
    t = lambda k: st + k * 300000

    main = {
        'BTCUSDT': _bars(rng, _path(rng, N, 60000, {}), st),
        'AAAUSDT': _bars(rng, _path(rng, N, 100, {I0: 1.04}), st),             # +4 %: T3 only
        'BBBUSDT': _bars(rng, _path(rng, N, 50, {I0: 1.085}), st),             # +8.5 %: T3, T5, T7 at once
        'CCCUSDT': _bars(rng, _path(rng, N, 10, {I0: 1.04}), st, skip=(48,)),  # gap inside the window
        'DDDUSDT': _bars(rng, _path(rng, N, 2, {I0 - 1: 1.04}), st),           # crossed one bar earlier
        'EEEUSDT': _bars(rng, _path(rng, N, 30, {I0: 0.94}), st),              # -6 %: T3 down
        'FFFUSDT': _bars(rng, _path(rng, N, 5, {}), st),
    }
    main['GGGUSDT'] = _bars(rng, _path(rng, N, 20, {I0: 1.032, I0 + 1: 1.004}), st)  # keeps rising after the cross

    idio = {'BTCUSDT': _bars(rng, _path(rng, N, 60000, {}), st), 'JUMPUSDT': _bars(rng, _path(rng, N, 8, {I0: 1.05}), st)}
    for k in range(10):
        idio[f'F{k:02d}USDT'] = _bars(rng, _path(rng, N, 10 + k, {}), st)

    wide = {'BTCUSDT': _bars(rng, _path(rng, N, 60000, {I0: 1.04}), st)}
    for k in range(12):
        wide[f'W{k:02d}USDT'] = _bars(rng, _path(rng, N, 10 + k, {I0: 1.04 + 0.001 * k}), st)

    q24 = {
        'main': {'BTCUSDT': 5e9, 'AAAUSDT': 3e7, 'BBBUSDT': 1.5e8, 'CCCUSDT': 5e6, 'DDDUSDT': 9e7,
                 'EEEUSDT': 2e7, 'FFFUSDT': 1e6, 'GGGUSDT': 1.2e8},
        'idio': {'BTCUSDT': 5e9, 'JUMPUSDT': 3e7},
        'wide': {'BTCUSDT': 5e9},
    }
    for k in range(10):
        q24['idio'][f'F{k:02d}USDT'] = 1e7
    for k in range(12):
        q24['wide'][f'W{k:02d}USDT'] = 3e7
    return {'main': main, 'idio': idio, 'wide': wide}, q24, t


def _header(name, spec, extra=None):
    h = {'golden': name, 'spec': spec['spec'], 'spec_version': spec['version'], 'spec_sha': spec_sha(spec),
         'tolerance': {'abs': 1e-9, 'rel': 1e-9}}
    h.update(extra or {})
    return h


def build_goldens(spec=None) -> Dict[str, Dict[str, Any]]:
    spec = spec or load_spec()
    datasets, q24, t = build_datasets(spec)
    goldens: Dict[str, Dict[str, Any]] = {}

    # ---- detect: edge trigger, tiers, gap, market_wide, vol_ratio, taker_imb, rel_btc
    cases = []
    def det(name, ds, i, note):
        ev = detect_events(datasets[ds], t(i), q24[ds], spec, 'BTCUSDT')
        cases.append({'name': name, 'note': note, 'dataset': ds, 'i_time': t(i), 'btc_symbol': 'BTCUSDT',
                      'expected': ev})
    det('main_signal_bar', 'main', I0, 'AAA T3 (tier mid), BBB T3/T5/T7 (hi), EEE down; CCC gap and DDD already above: none')
    det('main_bar_after', 'main', I0 + 1, 'edge trigger: moves still above T do not fire again')
    det('main_two_bars_after', 'main', I0 + 2, 'still no re-trigger while the 30 min window holds the move')
    det('main_before', 'main', I0 - 1, 'DDD crosses here (one bar earlier)')
    det('idio_signal_bar', 'idio', I0, 'single mover among 11 flat symbols: breadth low, market_wide false')
    det('wide_signal_bar', 'wide', I0, 'all symbols move: breadth 1.0, market_wide true')
    det('unknown_bar', 'main', I0 + 40, 'i_time not present in the series: no events')
    goldens['detect'] = dict(_header('detect', spec, {'datasets': datasets}), cases=cases)

    # ---- plans: hand-built events
    base = {'ret': 0.04, 'close': 100.0}
    pcases = []
    def pl(name, note, **kw):
        ev = dict(base, **kw)
        pcases.append({'name': name, 'note': note, 'event': ev, 'expected': plans_for_event(ev, spec)})
    pl('up_normal', 'follow long above close, fade short below close', atr14=1.0)
    pl('down_normal', 'follow short below close, fade long above close', ret=-0.04, atr14=1.0)
    pl('stop_floor', '1.5*atr = 0.06 < 0.3 % of 100: stop distance is the floor', atr14=0.04)
    pl('stop_cap_skip', '1.5*atr / entry > 5 %: both plans skipped', atr14=4.0)
    pl('cap_only_one_side', 'atr 3.33: follow stop is 4.95 % of entry (kept), fade is 5.04 % (skipped)', atr14=3.33)
    pl('atr_missing', 'no atr: no plans', atr14=None)
    goldens['plans'] = dict(_header('plans', spec), cases=pcases)

    # ---- alerts: from detect events through plans
    acases = []
    ev_all = cases[0]['expected']
    for ev in ev_all[:6]:
        for mode, plan in plans_for_event(ev, spec).items():
            if plan is None:
                continue
            acases.append({'name': f"{ev['symbol']}_{ev['signal']}_t{ev['threshold']}_{mode}", 'symbol': ev['symbol'],
                           'event': ev, 'plan': plan, 'expected': alert_dict(ev['symbol'], ev, plan, spec)})
    goldens['alerts'] = dict(_header('alerts', spec), cases=acases)

    # ---- metrics: direct helper checks on a bar series
    bars = datasets['main']['AAAUSDT']
    mcases = []
    for i, W in ((I0, 6), (I0, 3), (I0 - 1, 6), (5, 6), (2, 6)):
        mcases.append({
            'name': f'metrics_i{i}_W{W}', 'symbol': 'AAAUSDT', 'dataset': 'main', 'i': i, 'W': W,
            'expected': {'ret_w': ret_w(bars, i, W), 'vol_ratio': vol_ratio(bars, i, W, spec),
                         'taker_imb': taker_imb(bars, i, W), 'atr14': atr14(bars, i)}})
    gb = datasets['main']['CCCUSDT']
    gi = index_of(gb, t(I0))
    mcases.append({'name': 'metrics_gap', 'symbol': 'CCCUSDT', 'dataset': 'main', 'i': gi, 'W': 6,
                   'expected': {'ret_w': ret_w(gb, gi, 6), 'vol_ratio': vol_ratio(gb, gi, 6, spec),
                                'taker_imb': taker_imb(gb, gi, 6), 'atr14': atr14(gb, gi)}})
    tcases = [{'q24': q, 'expected': vol_tier(q, spec)} for q in (0, 1.99e7, 2e7, 9.99e7, 1e8, 5e9)]
    goldens['metrics'] = dict(_header('metrics', spec, {'datasets': {'main': datasets['main']}}),
                              cases=mcases, tiers=tcases)

    # ---- cooldown / escalation / burst
    def mini(sym, signal, move, T, k, mw=False):
        return {'symbol': sym, 'signal': signal, 'move': move, 'threshold': T, 'window_min': 30 if signal == 'move30' else 15,
                'open_time_ms': t(k), 'close_time_ms': t(k) + 300000, 'market_wide': mw}
    m = 12  # bars per hour
    steps_in = [
        ('new', [mini('AAAUSDT', 'move30', 'up', 3, 0)]),
        ('suppressed same level', [mini('AAAUSDT', 'move30', 'up', 3, 1)]),
        ('escalate to T5 -> update', [mini('AAAUSDT', 'move30', 'up', 5, 2)]),
        ('same T5 again', [mini('AAAUSDT', 'move30', 'up', 5, 3)]),
        ('lower T3 after T5', [mini('AAAUSDT', 'move30', 'up', 3, 4)]),
        ('escalate to T7 -> update', [mini('AAAUSDT', 'move30', 'up', 7, 5)]),
        ('other move key is independent', [mini('AAAUSDT', 'move30', 'down', 3, 6)]),
        ('other signal key is independent', [mini('AAAUSDT', 'move15', 'up', 3, 7)]),
        ('same bar T3 and T5: only the highest, as new', [mini('BBBUSDT', 'move30', 'up', 3, 8), mini('BBBUSDT', 'move30', 'up', 5, 8)]),
        ('479 min after first: still cooling', [mini('AAAUSDT', 'move30', 'up', 7, 95)]),
        ('480 min after first: new again', [mini('AAAUSDT', 'move30', 'up', 3, 96)]),
    ]
    tr = CooldownTracker(spec)
    steps = []
    for name, evs in steps_in:
        steps.append({'name': name, 'events': evs, 'expected': tr.process(evs)})
    # 95*5 = 475 min: cooling; 96*5 = 480 min: free (relative to bar index 0 close)
    goldens['cooldown'] = dict(_header('cooldown', spec), steps=steps)

    # burst: real events from the wide dataset, then a quiet repeat to show the market key cooldown
    wide_ev = next(c for c in cases if c['name'] == 'wide_signal_bar')['expected']
    tr2 = CooldownTracker(spec)
    first = tr2.process(wide_ev)
    few = [mini(f'S{k}USDT', 'move30', 'up', 3, 120, mw=True) for k in range(10)]
    tr3 = CooldownTracker(spec)
    ten = tr3.process(few)
    goldens['burst'] = dict(_header('burst', spec, {'max_events_per_bar': spec['max_events_per_bar']}), steps=[
        {'name': 'wide dataset collapses into market events', 'dataset': 'wide', 'i_time': t(I0),
         'events': wide_ev, 'expected': first},
        {'name': 'exactly max_events_per_bar market-wide events are NOT collapsed (fresh tracker)',
         'events': few, 'expected': ten},
        {'name': 'same burst again inside the cooldown (same tracker as step 1): nothing',
         'events': wide_ev, 'expected': tr2.process(wide_ev)},
    ])
    goldens['burst']['datasets'] = {'wide': datasets['wide']}
    return goldens


def golden_text(g) -> str:
    return json.dumps(g, indent=1, sort_keys=False, ensure_ascii=False) + '\n'


def check_goldens(directory: Optional[str] = None) -> List[str]:
    """Names of goldens that differ from (or are missing in) the directory. Empty = all equal."""
    d = directory or GOLDEN_DIR
    bad = []
    for name, g in build_goldens().items():
        p = os.path.join(d, name + '.json')
        try:
            with open(p, 'r', encoding='utf-8') as f:
                disk = f.read()
        except OSError:
            bad.append(name)
            continue
        if disk != golden_text(g):
            bad.append(name)
    return bad


def write_goldens(directory: Optional[str] = None) -> List[str]:
    d = directory or GOLDEN_DIR
    os.makedirs(d, exist_ok=True)
    names = []
    for name, g in build_goldens().items():
        with open(os.path.join(d, name + '.json'), 'w', encoding='utf-8') as f:
            f.write(golden_text(g))
        names.append(name)
    return names


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog='python3 -m radar.movers')
    ap.add_argument('--golden', action='store_true')
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--write', action='store_true')
    ap.add_argument('--sha', action='store_true')
    a = ap.parse_args(argv)
    if a.sha:
        print(spec_sha())
        return 0
    if not a.golden or a.check == a.write:
        ap.error('use --golden with exactly one of --check or --write (or --sha)')
    if a.write:
        print('wrote: ' + ', '.join(write_goldens()))
        return 0
    bad = check_goldens()
    if bad:
        print('goldens differ: ' + ', '.join(bad), file=sys.stderr)
        return 1
    print('goldens equal')
    return 0


if __name__ == '__main__':
    sys.exit(main())
