"""Reaction study of the levels of the extension's "Mapa de niveles" (in-sample replay, NOT forward evidence).

usage: python3 -m radar.level_study OUT.md OUT.json [--symbols BTCUSDT ETHUSDT ...]
                                            [--audit-glob '/tmp/tn/audit/*.jsonl'] [--days 90]

The method below is pre-registered: it was written before looking at the numbers, it is copied verbatim
into the generated document, and it is NOT tuned afterwards.

Data     BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT perpetual 5m klines. 120 days are fetched so the
         weekly/monthly candles and the EMA warm-ups exist; events are only counted in the last 90
         days. Everything is aggregated from 5m on UTC grids (weeks start Monday 00:00 UTC, months on
         the 1st 00:00 UTC). No cost, no P&L: only reaction frequencies.
Levels   Recomputed at every 5m bar from candles CLOSED BEFORE that bar opens, with the definitions of
         apps/extension/src/lib/context/levels.ts: PDH/PDL/pivot/R1/S1 from the previous day candle,
         dayOpen from today's open, weekOpen/PWH/PWL from the current/previous week candle, monthOpen
         from the first day of the current month, ema20_1h/ema50_1h/bbUpper/bbLower over closed 1h
         closes, ema50_4h over closed 4h closes, and the nearest round numbers below/above the
         previous close (step by magnitude). Deviation from levels.ts: the extension also feeds the
         in-progress candle into the averages; here nothing of the bar being evaluated (or later) is
         used, so there is no look-ahead.
Touch    For bar i and level L: resistance-touch if prev_close < L <= high[i]; support-touch if
         prev_close > L >= low[i]. Touches of the same (symbol, kind, side) closer than 12 bars are
         merged into the first one; a change of the level value starts a fresh event (a discrete level
         that rolls to a new day/week, or a moving average that has drifted).
Unit     A = Wilder ATR14 on 1h candles closed before the bar.
Outcome  48 bars (4h) after the touch bar. REACTED if price reaches 1.0 A away from L (down for
         resistance, up for support) before any 5m CLOSE beyond L by >= 0.5 A; BROKE if that close
         comes first; UNRESOLVED otherwise. Both inside one bar counts as BROKE (conservative). Only
         events with a full 48-bar window are counted.
Rate     reacted / (reacted + broke). Analytic sanity reference for a driftless random walk:
         0.5 / 1.5 = 33.3 %. Empirical chance: every evaluated 5m bar of the same symbol is a
         candidate "random time"; the identical rule is applied as if the price were AT a level there
         (L = close[bar], A = ATR at that bar, side random). The exact per-event expectation under
         uniform draws is used for the lift; 1000 permutations (same count of events per symbol) give
         the band of the pooled chance rate. Lift = level rate - chance rate, in percentage points.
         A robustness column repeats it with the chance side kept equal to the event's side.
Splits   (1) 4h trend context, ema20_4h vs ema50_4h on closed 4h candles: the bounce (down on
         resistance, up on support) goes with or against the trend. (2) first 45 days against the last
         45. (3) per-symbol sign of the lift (how many of the 5 agree with the pooled sign).
Uncertainty  Wilson 95 % for the rate; day-cluster bootstrap (1000 resamples of whole days) for the
         lift. n_events and n_days are reported.
Grade    'no_evidence' if n < 30 or the lift CI contains 0; 'promising' if the lift CI is above 0 AND
         both halves have lift > 0 AND >= 4 of 5 symbols agree; 'negative' if the lift CI is below 0.
         Nothing is ever labelled 'validated': this is in-sample, 90 days, and the levels are
         correlated with each other.
"""
import argparse
import bisect
import calendar
import datetime
import glob
import json
import math
import os
import random
import time
from collections import defaultdict

from radar.klines_cache import load_klines
from radar.replay import _binance_fetch_paginated as _fetch_once

BAR_S = 300
HORIZON = 48
REACT_ATR = 1.0
BREAK_ATR = 0.5
MERGE_BARS = 12
ATR_PERIOD = 14
MIN_N = 30
MIN_AGREE = 4
PERMS = 1000
BOOT_ITERS = 1000
RNG_SEED = 11
BOOT_SEED = 7
ANALYTIC_BASELINE = 0.5 / 1.5
DEFAULT_SYMBOLS = ('BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT')
DEFAULT_DAYS = 90
FETCH_DAYS = 120
WEEK_OFFSET = 345600  # 1970-01-05 00:00 UTC, a Monday
MONTH = 'month'
H1, H4, D1, W1 = 3600, 14400, 86400, 604800
KIND_ORDER = ('prevDayHigh', 'prevDayLow', 'prevWeekHigh', 'prevWeekLow', 'dayOpen', 'weekOpen',
              'monthOpen', 'pivot', 'r1', 's1', 'ema20_1h', 'ema50_1h', 'ema50_4h', 'bbUpper',
              'bbLower', 'round')
SIDES = ('resistance', 'support')
CODE = {'unresolved': 0, 'reacted': 1, 'broke': 2}
GRADES = ('no_evidence', 'promising', 'negative')


# --------------------------------------------------------------------------- time grids


def bucket_start(t, secs):
    """Start of the UTC bucket that contains t. Weeks start on Monday 00:00 UTC (epoch is a Thursday)."""
    if secs == MONTH:
        g = time.gmtime(int(t))
        return calendar.timegm((g.tm_year, g.tm_mon, 1, 0, 0, 0, 0, 0, 0))
    if secs == W1:
        return ((int(t) - WEEK_OFFSET) // W1) * W1 + WEEK_OFFSET
    return (int(t) // secs) * secs


def bucket_end(start, secs):
    """Exclusive end of the bucket that starts at `start`."""
    if secs == MONTH:
        g = time.gmtime(int(start))
        y, m = (g.tm_year + 1, 1) if g.tm_mon == 12 else (g.tm_year, g.tm_mon + 1)
        return calendar.timegm((y, m, 1, 0, 0, 0, 0, 0, 0))
    return int(start) + secs


def aggregate(bars, secs):
    """Aggregate time-ordered candles into `secs` buckets aligned on the UTC grid."""
    out, cur, cur_t = [], None, None
    for c in bars:
        t = bucket_start(c['time'], secs)
        if cur is None or t != cur_t:
            if cur is not None:
                out.append(cur)
            cur = {'time': t, 'open': c['open'], 'high': c['high'], 'low': c['low'], 'close': c['close']}
            cur_t = t
        else:
            cur['high'] = max(cur['high'], c['high'])
            cur['low'] = min(cur['low'], c['low'])
            cur['close'] = c['close']
    if cur is not None:
        out.append(cur)
    return out


# --------------------------------------------------------------------------- levels.ts replica


def ema_states(closes, period):
    """EMA after the first j closes (SMA seed, like levels.ts `ema`); states[j] is None for j < period."""
    states = [None] * (len(closes) + 1)
    if period < 1 or len(closes) < period:
        return states
    k = 2 / (period + 1)
    value = sum(closes[:period]) / period
    states[period] = value
    for j in range(period, len(closes)):
        value = closes[j] * k + value * (1 - k)
        states[j + 1] = value
    return states


def bollinger_states(closes, period=20, mult=2):
    """Bollinger bands after the first j closes (population sd, like levels.ts `bollinger`)."""
    states = [None] * (len(closes) + 1)
    n = len(closes)
    if period < 1 or n < period:
        return states
    s = sum(closes[:period])
    s2 = sum(c * c for c in closes[:period])
    for j in range(period, n + 1):
        mid = s / period
        variance = max(0.0, s2 / period - mid * mid)
        sd = math.sqrt(variance)
        states[j] = {'mid': mid, 'upper': mid + mult * sd, 'lower': mid - mult * sd}
        if j < n:
            s += closes[j] - closes[j - period]
            s2 += closes[j] * closes[j] - closes[j - period] * closes[j - period]
    return states


def bollinger(closes, period=20, mult=2):
    """Bollinger bands over the last `period` closes, population standard deviation (as levels.ts)."""
    return bollinger_states(closes, period, mult)[len(closes)]


def atr_wilder(bars, period=ATR_PERIOD):
    """Wilder ATR after each bar, like levels.ts: needs `period`+1 bars, first value at index `period`."""
    n = len(bars)
    out = [None] * n
    if n < period + 1:
        return out
    tr = []
    for i in range(1, n):
        c, p = bars[i], bars[i - 1]
        tr.append(max(c['high'] - c['low'], abs(c['high'] - p['close']), abs(c['low'] - p['close'])))
    value = sum(tr[:period]) / period
    out[period] = value
    for i in range(period, len(tr)):
        value = (value * (period - 1) + tr[i]) / period
        out[i + 1] = value
    return out


def round_step(price):
    if not (isinstance(price, (int, float)) and price > 0):
        return 1
    return 10 ** (math.floor(math.log10(price)) - 1)


def round_numbers(price):
    """Nearest round numbers strictly below and above the price (step by magnitude, as levels.ts)."""
    if not (isinstance(price, (int, float)) and price > 0):
        return None
    step = round_step(price)

    def clean(n):
        return float(format(n, '.12g'))

    return {'below': clean((math.ceil(price / step) - 1) * step),
            'above': clean((math.floor(price / step) + 1) * step)}


class Ctx:
    """Pre-computed aggregation state of one symbol. Every accessor takes `t`, the OPEN time of the
    5m bar being evaluated, and only looks at candles that were fully closed at `t`."""

    def __init__(self, bars):
        self.bars = bars
        self.series, self.starts, self.ends = {}, {}, {}
        for name, secs in (('d1', D1), ('w1', W1), ('h1', H1), ('h4', H4)):
            s = aggregate(bars, secs)
            self.series[name] = s
            self.starts[name] = [c['time'] for c in s]
            self.ends[name] = [bucket_end(c['time'], secs) for c in s]
        self.h1_closes = [c['close'] for c in self.series['h1']]
        self.h4_closes = [c['close'] for c in self.series['h4']]
        self.e20_1h = ema_states(self.h1_closes, 20)
        self.e50_1h = ema_states(self.h1_closes, 50)
        self.e20_4h = ema_states(self.h4_closes, 20)
        self.e50_4h = ema_states(self.h4_closes, 50)
        self.bb_1h = bollinger_states(self.h1_closes, 20, 2)
        self.atr1h = atr_wilder(self.series['h1'])

    def closed(self, name, t):
        """How many candles of series `name` are fully closed at time t."""
        return bisect.bisect_right(self.ends[name], t)

    def current(self, name, t):
        """Index of the candle that contains t (in progress), or -1."""
        return bisect.bisect_right(self.starts[name], t) - 1

    def levels(self, t, ref_price):
        """[(kind, price), ...] known at the open of the bar at `t`. `ref_price` (the previous close)
        only picks which round numbers are adjacent."""
        out = {}
        d1, w1 = self.series['d1'], self.series['w1']
        di, wi = self.current('d1', t), self.current('w1', t)
        if di >= 0:
            out['dayOpen'] = d1[di]['open']  # the open of an in-progress candle is already known
            mstart = bucket_start(t, MONTH)
            j = bisect.bisect_left(self.starts['d1'], mstart)
            if j < len(d1) and d1[j]['time'] == mstart:  # levels.ts needs the 1st of the month in history
                out['monthOpen'] = d1[j]['open']
        if di >= 1:
            prev = d1[di - 1]
            out['prevDayHigh'] = prev['high']
            out['prevDayLow'] = prev['low']
            pivot = (prev['high'] + prev['low'] + prev['close']) / 3
            out['pivot'] = pivot
            out['r1'] = 2 * pivot - prev['low']
            out['s1'] = 2 * pivot - prev['high']
        if wi >= 0:
            out['weekOpen'] = w1[wi]['open']
        if wi >= 1:
            out['prevWeekHigh'] = w1[wi - 1]['high']
            out['prevWeekLow'] = w1[wi - 1]['low']
        hc = self.closed('h1', t)
        out['ema20_1h'] = self.e20_1h[hc]
        out['ema50_1h'] = self.e50_1h[hc]
        bb = self.bb_1h[hc]
        if bb:
            out['bbUpper'] = bb['upper']
            out['bbLower'] = bb['lower']
        out['ema50_4h'] = self.e50_4h[self.closed('h4', t)]
        res = []
        for kind, price in out.items():
            if price is not None and price > 0 and price == price:
                res.append((kind, price))
        rounds = round_numbers(ref_price)
        if rounds:
            res.append(('round', rounds['above']))
            res.append(('round', rounds['below']))
        return res

    def atr(self, t):
        """Wilder ATR14 of the last 1h candle closed at t."""
        j = self.closed('h1', t) - 1
        return self.atr1h[j] if 0 <= j < len(self.atr1h) else None

    def trend_up(self, t):
        """4h trend on closed candles: ema20_4h > ema50_4h, or None while warming up."""
        j = self.closed('h4', t)
        a, b = self.e20_4h[j], self.e50_4h[j]
        if a is None or b is None:
            return None
        return a > b


# --------------------------------------------------------------------------- touches and outcomes


def touch_side(prev_close, bar, level):
    """resistance / support / None for one bar and one level."""
    if level is None or level <= 0:
        return None
    if prev_close < level <= bar['high']:
        return 'resistance'
    if prev_close > level >= bar['low']:
        return 'support'
    return None


def find_touches(bars, level_fn, atr_fn, merge_bars=MERGE_BARS, t_from=None, stats=None):
    """Touch events over `bars`. `level_fn(t, prev_close)` returns [(kind, price)]; `atr_fn(t)` the ATR unit.
    Touches of the same (kind, side) closer than `merge_bars` bars are merged into the first one, unless
    the level value itself changed (a new day/week level, or a drifting average). Bars before `t_from`
    are skipped (the merge state only needs a short warm-up). `stats['merged']` counts merges."""
    events = []
    last = {}
    merged = 0
    for i in range(1, len(bars)):
        bar = bars[i]
        t = bar['time']
        if t_from is not None and t < t_from:
            continue
        prev_close = bars[i - 1]['close']
        atr = atr_fn(t)
        for kind, level in level_fn(t, prev_close):
            side = touch_side(prev_close, bar, level)
            if side is None:
                continue
            key = (kind, side)
            prev = last.get(key)
            if prev is not None:
                pi, pprice = prev
                if i - pi < merge_bars and level == pprice:
                    merged += 1
                    continue
            last[key] = (i, level)
            events.append({'i': i, 't': t, 'kind': kind, 'side': side, 'level': level,
                           'atr': atr, 'close': bar['close']})
    if stats is not None:
        stats['merged'] = merged
    return events


def resolve_outcome(bars, i, level, side, atr, horizon=HORIZON):
    """reacted / broke / unresolved for a touch at bar i; None if not measurable (no ATR or the
    `horizon` bars after i are not all available). Both inside one bar -> broke."""
    if not atr or atr <= 0 or level is None or level <= 0:
        return None
    if i < 0 or i + horizon >= len(bars):
        return None
    sign = -1.0 if side == 'resistance' else 1.0
    react = level + sign * REACT_ATR * atr
    brk = level - sign * BREAK_ATR * atr
    for j in range(i + 1, i + horizon + 1):
        c = bars[j]
        if (c['close'] >= brk) if side == 'resistance' else (c['close'] <= brk):
            return 'broke'
        if (c['low'] <= react) if side == 'resistance' else (c['high'] >= react):
            return 'reacted'
    return 'unresolved'


def baseline_table(bars, atr_fn, horizon=HORIZON):
    """Outcome of the same rule applied as if the price were AT a level at each bar (L = close, A = ATR).

    Returns (table_r, table_s): per-bar outcome for a pseudo resistance / support level, None where the
    outcome does not exist (no ATR, or the `horizon` bars after the bar are not all available)."""
    n = len(bars)
    table_r, table_s = [None] * n, [None] * n
    for i in range(n - 1):
        atr = atr_fn(bars[i]['time'])
        if not atr or atr <= 0 or i + horizon >= n:
            continue
        level = bars[i]['close']
        table_r[i] = resolve_outcome(bars, i, level, 'resistance', atr, horizon)
        table_s[i] = resolve_outcome(bars, i, level, 'support', atr, horizon)
    return table_r, table_s


def valid_times(table_r, table_s):
    """Bar indices with a measurable pseudo-level outcome (both sides share the same condition)."""
    return [i for i, v in enumerate(table_r) if v is not None and table_s[i] is not None]


def baseline_probs(table_r, table_s, valid):
    """Exact expectation of (P(reacted), P(broke)) for one uniformly drawn time in `valid`, per side and
    with the side drawn at random. This is the limit of the permutation average."""
    m = len(valid)
    if not m:
        return None
    out = {}
    for side, table in (('resistance', table_r), ('support', table_s)):
        codes = [table[i] for i in valid]
        out[side] = (codes.count('reacted') / m, codes.count('broke') / m)
    out['random'] = ((out['resistance'][0] + out['support'][0]) / 2,
                     (out['resistance'][1] + out['support'][1]) / 2)
    return out


def baseline_pool(table_r, table_s, valid):
    """Candidate pseudo-events as integer codes (1 reacted, 2 broke, 0 unresolved): every valid time
    appears once per side, so a uniform draw from the list is a random time AND a random side."""
    return [CODE[table[i]] for i in valid for table in (table_r, table_s)]


def permutation_rates(counts, pools, perms=PERMS, seed=RNG_SEED):
    """Pooled chance rate (reacted/(reacted+broke)) of `perms` random draws; `counts` maps symbol -> how
    many events to draw, `pools` maps symbol -> baseline_pool. Returns the sorted list of rates."""
    rng = random.Random(seed)
    rates = []
    for _ in range(perms):
        r = b = 0
        for sym, k in counts.items():
            pool_ = pools.get(sym)
            if not pool_ or not k:
                continue
            draw = rng.choices(pool_, k=k)
            r += draw.count(1)
            b += draw.count(2)
        if r + b:
            rates.append(r / (r + b))
    rates.sort()
    return rates


def band_of(rates):
    if not rates:
        return (None, None)
    return (rates[int(len(rates) * 0.025)], rates[min(len(rates) - 1, int(len(rates) * 0.975))])


def empirical_baseline(events, tables, perms=PERMS, seed=RNG_SEED):
    """Chance columns for a list of predicted events.

    `events` are dicts with 'symbol' and 'side'; `tables` maps symbol -> {'table_r', 'table_s', 'valid'}.
    Each event gets the exact chance probabilities of the identical rule at a uniformly drawn random
    time of its symbol (random side: base_r/base_b; matched side: bm_r/bm_b); drawing as many random
    times as events, 1000 times, gives the band of the pooled chance rate (`band`) and its mean
    (`perm_rate`). Nothing here looks at the level value of the event.
    """
    counts = defaultdict(int)
    for e in events:
        counts[e['symbol']] += 1
    pools, probs = {}, {}
    for sym, table in tables.items():
        pools[sym] = baseline_pool(table['table_r'], table['table_s'], table['valid'])
        probs[sym] = baseline_probs(table['table_r'], table['table_s'], table['valid'])
    out = {'base_r': [], 'base_b': [], 'bm_r': [], 'bm_b': []}
    for e in events:
        p = probs.get(e['symbol'])
        side = e['side']
        if p is None or side not in p:
            out['base_r'].append(0.0)
            out['base_b'].append(0.0)
            out['bm_r'].append(0.0)
            out['bm_b'].append(0.0)
            continue
        out['base_r'].append(p['random'][0])
        out['base_b'].append(p['random'][1])
        out['bm_r'].append(p[side][0])
        out['bm_b'].append(p[side][1])
    rates = permutation_rates(counts, pools, perms=perms, seed=seed)
    out['perm_rate'] = (sum(rates) / len(rates)) if rates else None
    out['band'] = band_of(rates)
    out['n_valid_times'] = sum(len(t['valid']) for t in tables.values())
    return out


# --------------------------------------------------------------------------- statistics


def wilson(wins, n, z=1.95996):
    """Wilson 95 % interval for a proportion."""
    if not n or n <= 0:
        return (None, None)
    p = wins / n
    z2 = z * z
    denom = 1 + z2 / n
    center = (p + z2 / (2 * n)) / denom
    margin = (z * math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom
    return (max(0.0, center - margin), min(1.0, center + margin))


def pool(events, matched=False):
    """Pooled (reacted, broke, base_r, base_b) sums of a set of events (random-side baseline unless matched)."""
    kr, kb = ('bm_r', 'bm_b') if matched else ('base_r', 'base_b')
    return (sum(1 for e in events if e['outcome'] == 'reacted'),
            sum(1 for e in events if e['outcome'] == 'broke'),
            sum(e.get(kr, 0.0) for e in events),
            sum(e.get(kb, 0.0) for e in events))


def lift_of(totals):
    """(level rate - chance rate) as a fraction, or None."""
    reacted, broke, base_r, base_b = totals
    if reacted + broke <= 0 or base_r + base_b <= 0:
        return None
    return reacted / (reacted + broke) - base_r / (base_r + base_b)


def cluster_bootstrap(events, iters=BOOT_ITERS, seed=BOOT_SEED):
    """Day-cluster percentile CI of the lift: whole days are resampled with replacement."""
    by_day = defaultdict(list)
    for e in events:
        by_day[e['day']].append(e)
    days = sorted(by_day)
    if len(days) < 5:
        return None
    totals = [pool(by_day[d]) for d in days]
    rng = random.Random(seed)
    nd = len(days)
    lifts = []
    for _ in range(iters):
        acc = [0.0, 0.0, 0.0, 0.0]
        for _ in range(nd):
            v = totals[rng.randrange(nd)]
            acc[0] += v[0]
            acc[1] += v[1]
            acc[2] += v[2]
            acc[3] += v[3]
        lift = lift_of(acc)
        if lift is not None:
            lifts.append(lift)
    if not lifts:
        return None
    lifts.sort()
    return (lifts[int(len(lifts) * 0.025)], lifts[min(len(lifts) - 1, int(len(lifts) * 0.975))])


def grade_level(n, lift_ci, first_half_lift, second_half_lift, symbols_agree):
    """Honest labels only. Never 'validated': in-sample, 90 days, correlated levels."""
    if n < MIN_N or lift_ci is None:
        return 'no_evidence'
    if lift_ci[0] > 0 and first_half_lift is not None and second_half_lift is not None \
            and first_half_lift > 0 and second_half_lift > 0 and symbols_agree >= MIN_AGREE:
        return 'promising'
    if lift_ci[1] < 0:
        return 'negative'
    return 'no_evidence'


def _rate(events):
    r, b, _, _ = pool(events)
    return (r / (r + b)) if (r + b) else None


def _pp(x):
    return None if x is None else x * 100


def summarize(events, day_split, pools=None, perms=PERMS):
    """Full cell summary for one (kind, side) across symbols: rate, Wilson, lift, splits, grade.
    `pools` (symbol -> baseline_pool) adds the permutation band of the chance rate."""
    n = len(events)
    reacted, broke, base_r, base_b = pool(events)
    resolved = reacted + broke
    rate = (reacted / resolved) if resolved else None
    ci_low, ci_high = wilson(reacted, resolved)
    baseline = (base_r / (base_r + base_b)) if (base_r + base_b) > 0 else None
    lift = lift_of((reacted, broke, base_r, base_b))
    has_matched = bool(events) and all('bm_r' in e for e in events)
    lift_m = lift_of(pool(events, matched=True)) if has_matched else None
    lift_ci = cluster_bootstrap(events) if n else None
    with_trend = [e for e in events if e.get('with_trend') is True]
    against_trend = [e for e in events if e.get('with_trend') is False]
    first = [e for e in events if e['day'] < day_split]
    second = [e for e in events if e['day'] >= day_split]
    lift1 = lift_of(pool(first)) if first else None
    lift2 = lift_of(pool(second)) if second else None
    per_symbol = {}
    for sym in sorted({e['symbol'] for e in events}):
        per_symbol[sym] = lift_of(pool([e for e in events if e['symbol'] == sym]))
    sign = 0 if not lift else (1 if lift > 0 else -1)
    agree = sum(1 for v in per_symbol.values()
                if v is not None and (1 if v > 0 else -1) == sign) if sign else 0
    band = (None, None)
    if pools:
        counts = defaultdict(int)
        for e in events:
            counts[e['symbol']] += 1
        band = band_of(permutation_rates(counts, pools, perms=perms))
    return {
        'n': n, 'n_days': len({e['day'] for e in events}),
        'reacted': reacted, 'broke': broke, 'unresolved': n - resolved,
        'rate': rate, 'ci_low': ci_low, 'ci_high': ci_high,
        'baseline': baseline, 'baseline_band': band,
        'lift_pp': _pp(lift), 'lift_matched_pp': _pp(lift_m),
        'lift_ci': (_pp(lift_ci[0]), _pp(lift_ci[1])) if lift_ci else (None, None),
        'grade': grade_level(n, lift_ci, lift1, lift2, agree),
        'with_trend': {'n': len(with_trend), 'rate': _rate(with_trend)},
        'against_trend': {'n': len(against_trend), 'rate': _rate(against_trend)},
        'first_half_lift_pp': _pp(lift1), 'second_half_lift_pp': _pp(lift2),
        'symbols_agree': agree,
        'per_symbol_lift_pp': {s: _pp(v) for s, v in per_symbol.items()},
    }


# --------------------------------------------------------------------------- per-symbol events


def build_events(symbol, bars, start_s, end_s):
    """Touches + outcomes + baseline columns for one symbol, events restricted to bars opening in
    [start_s, end_s). The chance baseline draws its random times from the SAME window (a random time
    outside the evaluated period would carry a different drift and would fake a lift).

    Returns (events, info); info carries the baseline tables/pool, counts and diagnostics.
    """
    ctx = Ctx(bars)
    table_r, table_s = baseline_table(bars, ctx.atr)
    valid = [i for i in valid_times(table_r, table_s) if start_s <= bars[i]['time'] < end_s]
    tables = {symbol: {'table_r': table_r, 'table_s': table_s, 'valid': valid}}
    merge_stats = {}
    touches = find_touches(bars, ctx.levels, ctx.atr, t_from=start_s - 2 * MERGE_BARS * BAR_S,
                           stats=merge_stats)
    touches = [e for e in touches if start_s <= e['t'] < end_s and e['atr']]
    events = []
    for e in touches:
        outcome = resolve_outcome(bars, e['i'], e['level'], e['side'], e['atr'])
        if outcome is None:
            continue
        trend_up = ctx.trend_up(e['t'])
        bounce_up = e['side'] == 'support'
        sign = -1.0 if e['side'] == 'resistance' else 1.0
        rel = sign * (e['close'] - e['level']) / e['atr']  # >0: the touch bar closed on the reaction side
        events.append({
            'symbol': symbol, 'kind': e['kind'], 'side': e['side'], 't': e['t'],
            'day': e['t'] // 86400, 'outcome': outcome, 'atr': e['atr'], 'level': e['level'],
            'with_trend': None if trend_up is None else (bounce_up == trend_up),
            'rel_close': rel, 'pre_broke': rel <= -BREAK_ATR,
        })
    base = empirical_baseline(events, tables)
    for e, br, bb, mr, mb in zip(events, base['base_r'], base['base_b'], base['bm_r'], base['bm_b']):
        e['base_r'], e['base_b'], e['bm_r'], e['bm_b'] = br, bb, mr, mb
    info = {'tables': tables, 'pool': baseline_pool(table_r, table_s, valid),
            'n_valid_times': len(valid), 'n_touches': len(touches),
            'merged': merge_stats.get('merged', 0), 'perm_band': base['band']}
    return events, info


def cells_from_events(events, day_split, pools=None, perms=PERMS):
    cells = []
    for kind in KIND_ORDER:
        for side in SIDES:
            evs = [e for e in events if e['kind'] == kind and e['side'] == side]
            if not evs:
                continue
            c = summarize(evs, day_split, pools=pools, perms=perms)
            c['id'] = kind
            c['side'] = side
            cells.append(c)
    return cells


# --------------------------------------------------------------------------- synthetic null control


def synthetic_walk_bars(n, end_s, seed=RNG_SEED, sigma=0.0015):
    """Synthetic 5m bars from a driftless multiplicative random walk (gaussian log-steps)."""
    rng = random.Random(seed)
    start = end_s - n * BAR_S
    bars, close = [], 100.0
    for i in range(n):
        prev = close
        close = prev * math.exp(rng.gauss(0.0, sigma))
        wick = abs(rng.gauss(0.0, sigma * 0.4))
        bars.append({'time': start + i * BAR_S, 'open': prev, 'high': max(prev, close) * (1 + wick),
                     'low': min(prev, close) * (1 - abs(rng.gauss(0.0, sigma * 0.4))),
                     'close': close, 'volume': 1.0})
    return bars


def synthetic_null_control(start_s, end_s, fetch_days=FETCH_DAYS, n_series=5, seed=RNG_SEED):
    """Noise floor: on a driftless random walk the level kinds are literally meaningless, so any lift or
    grade measured on it is the bias/noise of this pipeline (selection of touch times, geometry of the
    barrier race, number of tests). Runs the exact same pipeline over `n_series` independent synthetic
    series and reports the spread of the lifts and how many cells get a non-trivial grade by chance."""
    n_bars = (end_s + HORIZON * BAR_S + 6 * 3600 - (end_s - fetch_days * 86400)) // BAR_S
    events, drifts = [], []
    for k in range(n_series):
        bars = synthetic_walk_bars(n_bars, end_s + HORIZON * BAR_S + 6 * 3600, seed=seed + k)
        evs, _ = build_events(f'NULL{k}', bars, start_s, end_s)
        events.extend(evs)
        a = next(c['close'] for c in bars if c['time'] >= start_s)
        z = next(c['close'] for c in bars if c['time'] >= end_s)
        drifts.append((z / a - 1) * 100)
    day_split = start_s // 86400 + (end_s - start_s) // 86400 // 2
    cells = [c for c in cells_from_events(events, day_split) if c['n'] >= MIN_N and c['lift_pp'] is not None]
    if not cells:
        return None
    lifts = [c['lift_pp'] for c in cells]
    mean = sum(lifts) / len(lifts)
    sd = math.sqrt(sum((v - mean) ** 2 for v in lifts) / len(lifts))
    sup = [c['lift_pp'] for c in cells if c['side'] == 'support']
    res = [c['lift_pp'] for c in cells if c['side'] == 'resistance']
    return {'seed': seed, 'series': n_series, 'events': len(events), 'cells': len(cells),
            'drifts_pct': drifts, 'mean_pp': mean, 'sd_pp': sd, 'min_pp': min(lifts), 'max_pp': max(lifts),
            'mean_support_pp': (sum(sup) / len(sup)) if sup else None,
            'mean_resistance_pp': (sum(res) / len(res)) if res else None,
            'promising': sum(1 for c in cells if c['grade'] == 'promising'),
            'negative': sum(1 for c in cells if c['grade'] == 'negative')}


# --------------------------------------------------------------------------- audit patterns


def patterns_from_jsonl(paths, min_days=30):
    """Per-(kind, direction) audit table (n, win rate + Wilson, mean net R + bootstrap CI, chance
    baseline from the file meta, grade) as JSON entries. No network. Files whose meta covers fewer than
    `min_days` days (smoke tests) or that are not audit files are ignored."""
    from radar.grading import bootstrap_mean_ci

    rows, bases, used = [], defaultdict(list), []
    for path in paths:
        try:
            with open(path) as fh:
                head = json.loads(fh.readline())
        except Exception:
            continue
        meta = head.get('meta') if isinstance(head, dict) else None
        if not isinstance(meta, dict) or 'symbol' not in meta or (meta.get('days') or 0) < min_days:
            continue
        used.append(os.path.basename(path))
        for key, value in (meta.get('baseline') or {}).items():
            bases[(meta['symbol'], meta.get('tf'), key)].append(value)
        with open(path) as fh:
            fh.readline()
            for line in fh:
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                if r.get('status') not in ('win_1r', 'win_2r', 'loss') or r.get('net_r') is None:
                    continue
                rows.append(r)
    cells = defaultdict(list)
    for r in rows:
        r['win'] = 1 if r['status'] in ('win_1r', 'win_2r') else 0
        vals = bases.get((r.get('symbol'), r.get('tf'), f"{r['kind']}|{r['direction']}"))
        r['baseline'] = sum(vals) / len(vals) if vals else None
        cells[(r['kind'], r['direction'])].append(r)
    out = []
    for (kind, direction), rs in sorted(cells.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        n = len(rs)
        wins = sum(r['win'] for r in rs)
        nets = [r['net_r'] for r in rs]
        lo, hi = wilson(wins, n)
        rci = bootstrap_mean_ci(nets)
        bs = [r['baseline'] for r in rs if r['baseline'] is not None]
        baseline = (sum(bs) / len(bs)) if bs else None
        ordered = sorted(rs, key=lambda x: x['t'])
        half = len(ordered) // 2
        m1 = sum(x['net_r'] for x in ordered[:half]) / max(1, half)
        m2 = sum(x['net_r'] for x in ordered[half:]) / max(1, len(ordered) - half)
        if n < MIN_N:
            grade = 'no_evidence'
        elif rci and rci[1] < 0:
            grade = 'negative'
        elif rci and rci[0] > 0 and m1 > 0 and m2 > 0 and (baseline is None or lo > baseline):
            grade = 'promising'
        else:
            grade = 'no_evidence'
        out.append({'kind': kind, 'direction': direction, 'n': n,
                    'win_rate': wins / n, 'ci_low': lo, 'ci_high': hi,
                    'mean_net_r': sum(nets) / n, 'r_ci': list(rci) if rci else None,
                    'baseline': baseline, 'grade': grade})
    return out, used


# --------------------------------------------------------------------------- data


def paced_fetch(symbol, tf, start_ms, limit, sleep_s=0.35, retries=6):
    """Sequential, paced public klines fetch (Binance weight limits bite when parallel)."""
    for attempt in range(retries):
        time.sleep(sleep_s)
        batch = _fetch_once(symbol, tf, start_ms, limit)
        if batch:
            return batch
        time.sleep(3 * (attempt + 1))
    return []


def fetch_bars(symbol, start_ms, end_ms, sleep_s=0.35, attempts=3):
    """Closed 5m bars in [start_ms, end_ms), through the klines cache and the paced fetch. Retries when a
    dropped request truncated the series (the cache keeps the batches that did arrive, so a retry resumes)."""
    start_s, end_s = start_ms // 1000, end_ms // 1000
    bars = []
    for attempt in range(max(1, attempts)):
        raw = load_klines(symbol, '5m', start_ms, end_ms,
                          fetch=lambda s, tf, a, b: paced_fetch(s, tf, a, b, sleep_s))
        bars = sorted((c for c in raw if c['time'] + BAR_S <= end_s), key=lambda c: c['time'])
        head_ok = bool(bars) and bars[0]['time'] <= start_s + 3600
        tail_ok = bool(bars) and bars[-1]['time'] >= end_s - 2 * 3600
        if head_ok and tail_ok:
            break
        print(f'{symbol}: incomplete ({len(bars)} bars, head_ok={head_ok}, tail_ok={tail_ok}), '
              f'retry {attempt + 1}', flush=True)
        time.sleep(5)
    return bars


def count_gaps(bars):
    """Missing 5m bars inside the series."""
    return sum(max(0, (b['time'] - a['time']) // BAR_S - 1) for a, b in zip(bars, bars[1:]))


# --------------------------------------------------------------------------- report


def _pct(value, digits=1):
    return 'n/d' if value is None else f'{value * 100:.{digits}f}%'


def _pp_s(value, digits=1):
    return 'n/d' if value is None else f'{value:+.{digits}f}'


def method_text(symbols, days, fetch_days):
    return f'''## Metodo (pre-registrado antes de ver los numeros)

**Datos.** {', '.join(symbols)} perpetuos, velas de 5 m. Se descargan {fetch_days} dias para tener
historia suficiente de 1h/4h/diario/semanal y para que EMA50 4h y la apertura mensual esten calientes;
los eventos solo se cuentan en los ultimos {days} dias. Todo se agrega desde las velas de 5 m en
rejillas UTC (semanas desde el lunes 00:00, meses desde el dia 1 00:00). Sin costes y sin P&L: solo se
mide la frecuencia de reaccion.

**Niveles.** Se recalculan en cada vela de 5 m solo con velas **cerradas antes de que ella abra**,
con las definiciones de `apps/extension/src/lib/context/levels.ts`: PDH/PDL, pivote clasico y R1/S1 del
dia anterior; apertura del dia; apertura de la semana y PWH/PWL de la semana anterior; apertura del
mes (solo si el dia 1 esta en la historia); EMA20 y EMA50 de 1h, EMA50 de 4h y bandas de
Bollinger(20,2) de 1h; y los dos numeros redondos adyacentes al ultimo cierre (paso segun la magnitud:
82.000 -> 1.000, 3.000 -> 100, 150 -> 10). Diferencia con la extension: esta alimenta las medias con el
cierre de la vela en curso; aqui no se usa nada de la vela evaluada (ni posterior), para no mirar el
futuro. No se replica la fusion de niveles a menos del 0,1 %: cada tipo se mide por separado (si PDH y
R1 coinciden son dos eventos, y esa correlacion se advierte abajo).

**Toque.** Para la vela i y el nivel L: *resistencia* si el cierre previo < L <= maximo de la vela;
*soporte* si el cierre previo > L >= minimo. Los toques del mismo (simbolo, tipo, lado) a menos de 12
velas se fusionan con el primero; un **cambio del valor del nivel** (nivel discreto que rota de dia o
de semana, media que se ha desplazado) empieza un evento nuevo.

**Unidad.** A = ATR14 de Wilder sobre velas de 1h ya cerradas en el momento del toque.

**Resultado.** 48 velas (4 h) despues de la vela del toque. **REACCIONA** si el precio llega a 1,0 A
del nivel (abajo para resistencia, arriba para soporte) antes de que un **cierre** de 5 m supere el
nivel en 0,5 A; **ROMPE** si ese cierre llega primero; **SIN RESOLVER** en el resto. Si las dos cosas
caen en la misma vela cuenta como ROMPE (conservador). Solo se cuentan eventos con ventana completa
de 48 velas. Tasa = reacciona / (reacciona + rompe).

**Azar.** (a) Referencia analitica de paseo aleatorio sin deriva: 0,5 / 1,5 = 33,3 % (solo como
comprobacion de cordura). (b) **Azar empirico**: cada vela de 5 m evaluada del mismo simbolo es un
"instante al azar" y se aplica la misma regla como si el precio estuviera EN un nivel ahi (L = cierre
de esa vela, A = ATR de esa vela, lado al azar). El valor esperado por evento bajo sorteo uniforme se
calcula exacto; 1000 permutaciones (mismo numero de eventos por simbolo) dan la banda del azar agregado
(percentiles 2,5 y 97,5). El *lift* es la tasa del nivel menos la tasa de azar, en puntos porcentuales.
Columna de robustez: el mismo calculo con el lado del azar igual al del evento (`lift pareado`), que
controla la deriva de la ventana.

**Cortes.** (1) Tendencia de 4h con EMAs de velas cerradas (EMA20 4h frente a EMA50 4h): el rebote
(arriba en soporte, abajo en resistencia) va *con la tendencia* o *contra la tendencia*. (2) Primera
mitad (dias 1-{days // 2}) frente a segunda mitad. (3) Consistencia por simbolo: cuantos de los
{len(symbols)} simbolos tienen el mismo signo de lift que el conjunto.

**Incertidumbre.** Wilson 95 % para la tasa y bootstrap por dia (1000 remuestreos de dias completos)
para el lift. Se reportan n de eventos y n de dias.

**Grado.** `no_evidence` si n < 30 o el IC95 del lift contiene el 0; `promising` si el IC95 del lift
esta por encima de 0 **y** las dos mitades tienen lift > 0 **y** al menos 4 de 5 simbolos coinciden;
`negative` si el IC95 del lift esta por debajo de 0. Nunca se usa la etiqueta `validated`: es en
muestra, 90 dias, y los niveles estan correlacionados entre si (PDH y R1 suelen caer a la vez).

**Patrones del radar.** Si hay ficheros de auditoria ya calculados (`/tmp/tn/audit/*.jsonl`) se
re-emiten por (patron, direccion): n, acierto 1R con Wilson, R neto con IC95 bootstrap, azar del
`meta` del fichero y grado con la misma regla (mas R neto positivo en las dos mitades). No se
recalcula nada: son P&L con costes y se leen como en `docs/research/AUDIT_PATRONES_2026-10-18.md`.
'''


def caveat_text(n_cells):
    return f'''## Advertencias (leer antes de usar un numero)

1. **En muestra, una sola ventana.** Son 90 dias y {n_cells} pruebas (tipo x lado): algun positivo
   es esperable por azar (el control de ruido de abajo mide cuantos). Nada aqui es evidencia hacia
   adelante.
2. **Reaccion no es beneficio.** Una tasa alta de reaccion no paga el coste ni dice como entrar,
   donde poner el stop o cuanto arriesgar. No hay P&L en este estudio a proposito, y por eso tampoco
   hay costes.
3. **Los niveles estan correlacionados.** PDH, R1, EMA y redondo caen a menudo a pocos puntos del
   mismo precio: los eventos no son independientes y el conjunto de pruebas esta inflado. Los
   intervalos por dia no corrigen la dependencia entre niveles ni entre simbolos (BTC, ETH, SOL, BNB
   y XRP se mueven juntos).
4. **El azar tambien es en muestra** y usa las mismas series: mide geometria y volatilidad, no una
   estrategia alternativa. Y hay una asimetria conocida: un evento real empieza en el cierre de la
   vela del toque, que puede estar a cierta distancia del nivel, mientras que el azar empieza
   exactamente en el nivel (la mediana medida esta en Datos). Esa asimetria empuja el lift hacia
   abajo (hacia ROMPE) y el control de ruido la incluye, asi que no se corrige a mano: se compara
   contra el. La columna `lift pareado` controla el lado, no la distancia de entrada.
5. **Cinco mayores y 90 dias.** No generaliza a otros pares ni a otros regimenes; la deriva de la
   ventana por simbolo esta en Datos.
6. **El resultado depende del umbral.** 1,0 ATR de reaccion y 0,5 ATR de ruptura en 4 h son parte del
   pre-registro, no del nivel: con otros umbrales el numero cambia. No se ajustaron tras ver los datos.
7. **Muestra pequena por celda** en niveles poco tocados (apertura de mes, semanales): n < 30 se
   etiqueta `no_evidence` sin mirar el signo.
8. **La fusion de 12 velas no actua igual en todos los tipos.** Un nivel discreto (PDH, apertura,
   redondo) repite valor y por tanto se fusiona; una media que se mueve cambia de valor en cada vela
   y cada toque cuenta como evento nuevo. Por eso EMA20/EMA50 tienen muchos mas eventos solapados
   que PDH, y su n no es comparable entre tipos.
9. **Una ventana con tendencia favorece al lado de la tendencia.** El azar se mide en toda la
   ventana, no en el mismo dia que el evento: si la ventana sube, las celdas de soporte (rebote
   alcista) recogen esa subida y las de resistencia no. Por eso el signo de los lifts se lee junto a
   la deriva por simbolo (Datos) y al `lift pareado`.
'''


def render_md(cells, meta):
    symbols, days = meta['symbols'], meta['days']
    L = []
    P = L.append
    P(f'# Estudio de reaccion de los niveles del mapa ({meta["date"]})\n')
    P(f'> Medicion **en muestra** de {days} dias de velas de 5 m en {len(symbols)} perpetuos '
      f'({", ".join(symbols)}). Mide con que frecuencia el precio **reacciona** a cada nivel frente a '
      f'**romperlo**, comparado con un azar empirico de la misma serie. **No es evidencia hacia '
      f'adelante, no es una probabilidad de que el nivel "aguante" y no es una recomendacion.** '
      f'Reproducir: `python3 -m radar.level_study SALIDA.md salida.json`.\n')
    P('## Resumen\n')
    P(meta['summary'])
    P('')
    P(method_text(symbols, days, meta['fetch_days']))
    P(caveat_text(len(cells)))
    P('## Resultados por nivel y lado\n')
    P(f'{len(cells)} celdas (tipo de nivel x lado) con al menos un evento. `reacciona` es '
      f'reacciona/(reacciona+rompe) con IC95 de Wilson; `azar` es la tasa empirica de la celda con la '
      f'banda de sus 1000 permutaciones; `lift` son puntos porcentuales sobre ese azar con su IC95 por '
      f'dia; `lift pareado` repite el calculo con el lado del azar igual al del evento.\n')
    P('| nivel | lado | n | dias | reacciona (IC95) | rompe | sin resolver | azar (banda) | lift pp | IC95 lift | lift pareado pp | grado |')
    P('|---|---|---|---|---|---|---|---|---|---|---|---|')
    for c in cells:
        lo, hi = c['baseline_band']
        band = f"{_pct(c['baseline'])} ({_pct(lo, 0)}-{_pct(hi, 0)})"
        P(f"| {c['id']} | {c['side']} | {c['n']} | {c['n_days']} | "
          f"{_pct(c['rate'])} ({_pct(c['ci_low'], 0)}-{_pct(c['ci_high'], 0)}) | "
          f"{c['broke']} | {_pct(c['unresolved'] / c['n'] if c['n'] else None, 0)} | {band} | "
          f"{_pp_s(c['lift_pp'])} | {_pp_s(c['lift_ci'][0])}..{_pp_s(c['lift_ci'][1])} | "
          f"{_pp_s(c['lift_matched_pp'])} | {c['grade']} |")
    P('')
    P('## Cortes: tendencia, mitades y simbolos\n')
    P('`con tend.` y `contra tend.` dan n y tasa de reaccion dentro de cada contexto (tendencia de 4h '
      'medida con EMAs de velas cerradas). El lift de cada mitad y el numero de simbolos con el mismo '
      'signo que el conjunto son las condiciones del grado.\n')
    P('| nivel | lado | con tend. (n, tasa) | contra tend. (n, tasa) | lift 1a mitad pp | lift 2a mitad pp | simbolos de acuerdo |')
    P('|---|---|---|---|---|---|---|')
    for c in cells:
        wt, at = c['with_trend'], c['against_trend']
        P(f"| {c['id']} | {c['side']} | {wt['n']}, {_pct(wt['rate'], 0)} | {at['n']}, {_pct(at['rate'], 0)} | "
          f"{_pp_s(c['first_half_lift_pp'])} | {_pp_s(c['second_half_lift_pp'])} | "
          f"{c['symbols_agree']}/{len(symbols)} |")
    P('')
    P('## Lift por simbolo (puntos porcentuales)\n')
    P('| nivel | lado | ' + ' | '.join(symbols) + ' |')
    P('|---|---|' + '---|' * len(symbols))
    for c in cells:
        ps = c['per_symbol_lift_pp']
        P(f"| {c['id']} | {c['side']} | " + ' | '.join(_pp_s(ps.get(s)) for s in symbols) + ' |')
    P('')
    P('## Patrones del radar (auditoria ya calculada, solo se re-emite)\n')
    P(meta['patterns_text'])
    P('')
    P('## Control de ruido (paseo aleatorio puro)\n')
    P(meta['null_text'])
    P('')
    P('## Conclusion honesta\n')
    P(meta['conclusion'])
    P('')
    P('## Datos\n')
    P(meta['data_text'])
    return '\n'.join(L) + '\n'


def _null_text(null):
    if not null:
        return 'El control de ruido no se pudo calcular en esta ejecucion.'
    drifts = ', '.join(f'{d:+.0f} %' for d in null['drifts_pct'])
    return (f'En un paseo aleatorio sin deriva los niveles existen (PDH, EMAs, redondos se calculan '
            f'igual) pero no significan nada: cualquier lift medido sobre el es sesgo o ruido de esta '
            f'cadena, no una propiedad del nivel. Se ejecuto la misma cadena completa sobre '
            f'{null["series"]} series sinteticas independientes (seed {null["seed"]}, sin deriva; '
            f'deriva realizada en la ventana: {drifts}; {null["events"]} eventos, {null["cells"]} '
            f'celdas con n >= 30). Los lifts van de {null["min_pp"]:+.1f} a {null["max_pp"]:+.1f} pp '
            f'con media {null["mean_pp"]:+.1f} pp y desviacion {null["sd_pp"]:.1f} pp. Con el mismo '
            f'grado, **{null["promising"]} celdas salen `promising` y {null["negative"]} `negative` '
            f'solo por azar**. Ese es el tamano del ruido y la tasa de falsos positivos del filtro '
            f'({null["promising"]}/{null["cells"]} celdas). Por lado, el lift medio del control es '
            f'{null["mean_support_pp"]:+.1f} pp en soporte y {null["mean_resistance_pp"]:+.1f} pp en '
            f'resistencia: sin tendencia no hay asimetria por lado, asi que la que aparezca en los datos '
            f'reales viene de la deriva de la ventana, no del nivel.')


def _summary_text(cells, events, promising, negative, noev, null):
    ev = [c for c in cells if c['n'] >= MIN_N and c['lift_pp'] is not None]
    lines = [f'- **{len(events)} eventos** de toque en {len({e["symbol"] for e in events})} simbolos, '
             f'{len({e["day"] for e in events})} dias, {len(cells)} celdas (tipo x lado).',
             f'- **{len(promising)}** celdas `promising`, **{len(negative)}** `negative`, '
             f'{len(noev)} `no_evidence`. Ninguna se declara validada: es en muestra, 90 dias y los niveles '
             f'estan correlacionados.']
    if ev:
        top = max(ev, key=lambda c: c['lift_pp'])
        bot = min(ev, key=lambda c: c['lift_pp'])
        lines.append(f"- Rango de lifts (n >= 30): de {_pp_s(bot['lift_pp'])} pp "
                     f"({bot['id']}/{bot['side']}) a {_pp_s(top['lift_pp'])} pp ({top['id']}/{top['side']}).")
    if null:
        lines.append(f"- Control de ruido (paseo aleatorio sin niveles con significado): {null['promising']} "
                     f"celdas salen `promising` y {null['negative']} `negative` de {null['cells']}, con lifts "
                     f"de {null['min_pp']:+.1f} a {null['max_pp']:+.1f} pp.")
    if promising:
        lines.append('- Promising: ' + ', '.join(f"{c['id']}/{c['side']} ({_pp_s(c['lift_pp'])} pp, n={c['n']})"
                                                 for c in promising) + '.')
    if negative:
        lines.append('- Negative: ' + ', '.join(f"{c['id']}/{c['side']} ({_pp_s(c['lift_pp'])} pp, n={c['n']})"
                                                for c in negative) + '.')
    return '\n'.join(lines)


def _conclusion_text(cells, promising, negative, patterns, null, window_ret=None):
    big = [c for c in cells if c['n'] >= MIN_N and c['lift_pp'] is not None]
    if not big:
        return 'Con n < 30 en todas las celdas no hay nada que concluir: hace falta mas historia.'
    txt = []
    if window_ret:
        lo = min(window_ret.values())
        hi = max(window_ret.values())
        sup = [c['lift_pp'] for c in big if c['side'] == 'support']
        res = [c['lift_pp'] for c in big if c['side'] == 'resistance']
        txt.append(f'**La ventana no es neutra.** Los {len(window_ret)} pares subieron entre {lo:+.0f} % y '
                   f'{hi:+.0f} % en los 90 dias. El lift medio de las celdas de soporte es '
                   f'{sum(sup) / len(sup):+.1f} pp y el de resistencia {sum(res) / len(res):+.1f} pp: '
                   'esa asimetria es lo que produce una tendencia alcista cuando el azar se mide en toda '
                   'la ventana, y no dice nada del nivel. Por eso el signo de los lifts se lee junto al '
                   '`lift pareado` (que mete la deriva en los dos lados) y al control de ruido; el grado '
                   'se calcula, como estaba pre-registrado, sobre el azar de lado aleatorio.')
    if not promising:
        txt.append('**Ningun nivel supera el filtro de `promising`** (IC95 del lift por encima de 0, las dos '
                   'mitades positivas y 4 de 5 simbolos a la vez). Con estos datos no se puede escribir un '
                   '"porcentaje de que aguante" por nivel como si fuera una ventaja: lo unico honesto es '
                   'mostrar la tasa de reaccion observada con su intervalo y decir que no se distingue del '
                   'azar.')
    else:
        txt.append('Superan el filtro `promising`: ' + ', '.join(f"{c['id']}/{c['side']}" for c in promising) +
                   '. Siguen siendo en muestra: la unica lectura permitida es "vigilar hacia adelante", no '
                   'publicar un porcentaje de acierto. ' +
                   (f"El control de ruido da {null['promising']} de {null['cells']} celdas `promising` "
                    'sin niveles con significado, asi que con tantas pruebas alguno puede ser casualidad.' if null else ''))
    if negative:
        txt.append('Se rompen mas de lo que rebotan frente a una entrada aleatoria con la misma geometria '
                   '(IC95 del lift por debajo de 0): ' + ', '.join(f"{c['id']}/{c['side']}" for c in negative) +
                   '. Ojo: un lift negativo significa "peor que entrar al azar desde ese mismo precio", no '
                   '"el nivel empuja el precio en contra" (el sesgo de seleccion del toque puede explicarlo).')
    txt.append('La tasa de reaccion observada se puede mostrar en el tooltip **solo como historial en '
               'muestra** ("en estos 90 dias, en 5 pares, el precio reacciono N % de las veces que toco el '
               'nivel; el azar da M %"), nunca como probabilidad de que el nivel aguante.')
    if null:
        txt.append(f'El control de ruido fija la escala: en series sin niveles con significado el lift '
                   f'medio es {null["mean_pp"]:+.1f} pp con desviacion {null["sd_pp"]:.1f} pp (de '
                   f'{null["min_pp"]:+.1f} a {null["max_pp"]:+.1f} pp). Cualquier lift dentro de esa banda, '
                   f'incluidos los `negative` cercanos a 0, no se distingue del sesgo de la propia cadena.')
    if patterns:
        txt.append(f'Los patrones del radar re-emitidos ({len(patterns)} celdas) son P&L con costes y se leen '
                   'como en `docs/research/AUDIT_PATRONES_2026-10-18.md`. Que un nivel "reaccione" mas que '
                   'el azar no implica que se pueda operar con beneficio.')
    else:
        txt.append('La parte de patrones del radar se omite: no habia ficheros de auditoria en esta maquina.')
    return '\n\n'.join(txt)


def _patterns_text(patterns, used, audit_glob):
    if not patterns:
        return ('No se encontraron ficheros de auditoria (`' + (audit_glob or '') + '`): esta parte se omite. '
                'Para generarlos: `python3 -m radar.audit_collect SIMBOLO TF 90 salida.jsonl`.')
    s = (f'{len(patterns)} combinaciones patron+direccion de {", ".join(used)} (replay ya existente; el '
         'azar es el del `meta` de cada fichero, bruto y sin costes; `R neto` incluye costes). El grado '
         'exige ademas R neto positivo en las dos mitades.\n\n'
         '| patron | dir | n | acierto 1R (IC95) | R neto | IC95 R | azar | grado |\n'
         '|---|---|---|---|---|---|---|---|')
    for p in patterns:
        ci = f"{p['r_ci'][0]:+.2f}..{p['r_ci'][1]:+.2f}" if p['r_ci'] else 'n/d'
        base = ('%.0f%%' % (p['baseline'] * 100)) if p['baseline'] is not None else 'n/d'
        s += (f"\n| {p['kind']} | {p['direction']} | {p['n']} | "
              f"{p['win_rate']:.0%} ({p['ci_low']:.0%}-{p['ci_high']:.0%}) | "
              f"{p['mean_net_r']:+.2f} | {ci} | {base} | {p['grade']} |")
    return s


def build_stats_doc(cells, patterns, universe, days, generated):
    """The glossary JSON consumed by the extension (schema swal.glossary-stats.v1)."""
    return {
        'schema': 'swal.glossary-stats.v1',
        'generated': generated,
        'method': 'replay_in_sample',
        'universe': list(universe),
        'days': days,
        'caveat': ('Frecuencia de reaccion en muestra (90 dias, 5 mayores): no es una probabilidad de '
                   'que el nivel aguante, no es P&L y no es evidencia hacia adelante.'),
        'levels': [{
            'id': c['id'], 'side': c['side'], 'n': c['n'], 'n_days': c['n_days'],
            'reacted': c['reacted'], 'broke': c['broke'], 'unresolved': c['unresolved'],
            'rate': c['rate'], 'ci_low': c['ci_low'], 'ci_high': c['ci_high'],
            'baseline': c['baseline'], 'lift_pp': c['lift_pp'],
            'lift_ci': [c['lift_ci'][0], c['lift_ci'][1]] if c['lift_ci'][0] is not None else None,
            'grade': c['grade'],
            'with_trend': c['with_trend'], 'against_trend': c['against_trend'],
            'first_half_lift_pp': c['first_half_lift_pp'],
            'second_half_lift_pp': c['second_half_lift_pp'],
            'symbols_agree': c['symbols_agree'],
        } for c in cells],
        'patterns': patterns,
    }


# --------------------------------------------------------------------------- main


def main(argv=None):
    ap = argparse.ArgumentParser(description='Reaction study of the level map (in-sample replay)')
    ap.add_argument('out_md')
    ap.add_argument('out_json')
    ap.add_argument('--symbols', nargs='+', default=list(DEFAULT_SYMBOLS))
    ap.add_argument('--audit-glob', default='/tmp/tn/audit/*.jsonl')
    ap.add_argument('--days', type=int, default=DEFAULT_DAYS)
    ap.add_argument('--sleep', type=float, default=0.35)
    args = ap.parse_args(argv)

    day_ms = 86400 * 1000
    now_ms = int(time.time() * 1000)
    end_ms = now_ms // day_ms * day_ms  # evaluated period ends at today 00:00 UTC
    start_ms = end_ms - args.days * day_ms
    fetch_ms = end_ms - FETCH_DAYS * day_ms
    start_s, end_s = start_ms // 1000, end_ms // 1000
    day_split = (start_s // 86400) + args.days // 2

    t0 = time.time()
    all_events, notes, pools = [], [], {}
    rel_closes, pre_broke, window_ret = [], 0, {}
    used_symbols = []
    total_merged = 0
    for sym in args.symbols:
        t_sym = time.time()
        # fetch up to "now" so that the last events of the evaluated period have their 4h window
        bars = fetch_bars(sym, fetch_ms, now_ms, sleep_s=args.sleep)
        if len(bars) < 5000:
            notes.append(f'{sym}: solo {len(bars)} velas de 5m (se omite)')
            print(f'{sym}: {len(bars)} bars - skipped', flush=True)
            continue
        events, info = build_events(sym, bars, start_s, end_s)
        all_events.extend(events)
        pools[sym] = info['pool']
        used_symbols.append(sym)
        total_merged += info['merged']
        a = next((c['close'] for c in bars if c['time'] >= start_s), None)
        z = next((c['close'] for c in bars if c['time'] >= end_s), None)
        if a and z:
            window_ret[sym] = (z / a - 1) * 100
        rel_closes.extend(e['rel_close'] for e in events)
        pre_broke += sum(1 for e in events if e['pre_broke'])
        span = (bars[-1]['time'] - bars[0]['time']) / 86400
        notes.append(f'{sym}: {len(bars)} velas de 5m ({span:.0f} dias, {count_gaps(bars)} velas ausentes), '
                     f'{info["n_touches"]} toques, {info["merged"]} fusiones, {len(events)} eventos con '
                     f'ventana completa, {info["n_valid_times"]} instantes de azar, deriva de la ventana '
                     f'{window_ret.get(sym, float("nan")):+.1f} %')
        print(f'{sym}: {len(bars)} bars, {len(events)} events ({time.time() - t_sym:.0f}s)', flush=True)
    fetch_s = time.time() - t0

    if not all_events:
        print('NO DATA: no events could be built', flush=True)
        return 1

    cells = cells_from_events(all_events, day_split, pools=pools)
    kinds_seen = sorted({c['id'] for c in cells})
    assert set(kinds_seen) <= set(KIND_ORDER), kinds_seen
    paths = sorted(glob.glob(args.audit_glob)) if args.audit_glob else []
    patterns, used = patterns_from_jsonl(paths)
    if not patterns:
        print(f'no audit files matched {args.audit_glob}: patterns skipped', flush=True)

    t_null = time.time()
    null = None
    try:
        null = synthetic_null_control(start_s, end_s)
    except Exception as exc:  # the control must never break the study
        print(f'null control failed: {exc}', flush=True)
    null_s = time.time() - t_null

    promising = [c for c in cells if c['grade'] == 'promising']
    negative = [c for c in cells if c['grade'] == 'negative']
    noev = [c for c in cells if c['grade'] == 'no_evidence']
    reaction_side = sum(1 for r in rel_closes if r > 0) / len(rel_closes)
    median_rel = sorted(rel_closes)[len(rel_closes) // 2]
    per_kind = defaultdict(lambda: [0, 0])
    for e in all_events:
        per_kind[e['kind']][0] += 1
        per_kind[e['kind']][1] += 1 if e['outcome'] == 'unresolved' else 0
    kind_text = ' '.join(f'{k}={v[0]} ({v[1] / v[0]:.0%} sin resolver)' for k, v in
                         sorted(per_kind.items(), key=lambda kv: -kv[1][0]))
    data_text = (
        '\n'.join(f'- {n}' for n in notes) +
        f'\n\nEventos por tipo (y fraccion sin resolver): {kind_text}. En total {total_merged} toques se '
        f'fusionaron con el toque anterior del mismo tipo y lado.\n\n'
        f'Diagnostico del inicio del evento: en {reaction_side:.0%} de los toques la vela del toque cierra '
        f'del lado de la reaccion (por debajo de una resistencia / por encima de un soporte); mediana de '
        f'(cierre - nivel) en ATR hacia el lado de la reaccion: {median_rel:+.2f}; en '
        f'{pre_broke / len(rel_closes):.1%} de los toques la propia vela del toque ya cierra mas de 0,5 ATR '
        f'al otro lado (esa vela no entra en la ventana de 48, que empieza en la siguiente). El azar '
        f'empieza siempre en distancia 0: esa asimetria se acota con el control de ruido (la columna '
        f'`lift pareado` controla el lado, no la distancia de entrada).\n\n'
        f'Descarga: {args.days} dias evaluados, {FETCH_DAYS} dias descargados por simbolo, '
        f'{len(args.symbols)} simbolos secuenciales con pausa de {args.sleep:.2f} s entre peticiones '
        f'(cache en `~/.cache/swal-trade/klines`). Tiempo de datos y calculo de eventos en esta '
        f'ejecucion: {fetch_s:.0f} s (con la cache tibia es mucho menos que la primera descarga); '
        f'control de ruido: {null_s:.0f} s.')

    generated = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()
    doc = build_stats_doc(cells, patterns, used_symbols, args.days, generated)

    meta = {'symbols': used_symbols, 'days': args.days, 'fetch_days': FETCH_DAYS,
            'summary': _summary_text(cells, all_events, promising, negative, noev, null),
            'conclusion': _conclusion_text(cells, promising, negative, patterns, null, window_ret),
            'patterns_text': _patterns_text(patterns, used, args.audit_glob),
            'null_text': _null_text(null), 'data_text': data_text,
            'date': datetime.date.today().isoformat()}
    md = render_md(cells, meta)

    for path, writer in ((args.out_md, lambda fh: fh.write(md)),
                         (args.out_json, lambda fh: (json.dump(doc, fh, indent=2, ensure_ascii=False),
                                                     fh.write('\n')))):
        os.makedirs(os.path.dirname(os.path.abspath(path)) or '.', exist_ok=True)
        with open(path, 'w') as fh:
            writer(fh)
    print(f'events={len(all_events)} cells={len(cells)} total={time.time() - t0:.0f}s', flush=True)
    print(f'promising={[(c["id"], c["side"]) for c in promising]}', flush=True)
    print(f'negative={[(c["id"], c["side"]) for c in negative]}', flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
