"""Daemon source for the movers scanner (docs/design/SCANNER.md, 'Espejo en el servidor').

Scans the whole USDT/USDC perpetual universe once per closed 5 minute bar and returns radar alert dicts built by
radar/movers.py (nothing is re-implemented here). The caller stores them (RadarStore.create_alert).

Weight: BinanceClient records X-MBX-USED-WEIGHT-1M in `client.used_weight_1m` when the response exposes it. If the
client has no such attribute (or it is None) the guard is skipped and the cycle is capped only by the number of
requests: RADAR_MOVERS_MAX_SYMBOLS (default 250) klines requests plus ticker/exchangeInfo.
"""
import os
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional

from radar import movers

BAR_MS = 300000
CLOSE_GRACE_MS = 3000
UNIVERSE_TTL_MS = 3600 * 1000
WEIGHT_LIMIT = 1200
CONCURRENCY = 4
KLINES_LIMIT = 40
DEFAULT_MIN_Q24 = 20000000.0
DEFAULT_MAX_SYMBOLS = 250


def _env_num(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return float(default)


def movers_enabled(env=None) -> bool:
    return str((env if env is not None else os.environ).get('RADAR_MOVERS', '')).strip().lower() in ('1', 'true', 'yes')


class MoversSource:
    def __init__(self, spec: Optional[Dict[str, Any]] = None, min_q24: Optional[float] = None,
                 max_symbols: Optional[int] = None):
        self.spec = spec or movers.load_spec()
        self.min_q24 = float(min_q24 if min_q24 is not None else _env_num('RADAR_MOVERS_MIN_Q24', DEFAULT_MIN_Q24))
        self.max_symbols = int(max_symbols if max_symbols is not None else _env_num('RADAR_MOVERS_MAX_SYMBOLS', DEFAULT_MAX_SYMBOLS))
        self.universe_cache: Dict[str, Any] = {}
        self.cooldown = movers.CooldownTracker(self.spec)
        self.last_bar_close_ms: Optional[int] = None

    # ------------------------------------------------------------ helpers
    def _universe(self, client, now_ms: int, cache: Dict[str, Any]) -> List[str]:
        if cache.get('symbols') and now_ms - cache.get('ts', 0) < UNIVERSE_TTL_MS:
            return cache['symbols']
        syms = client.fetch_exchange_info_universe(('USDT', 'USDC'))
        if syms:
            cache['symbols'] = list(syms)
            cache['ts'] = now_ms
            return cache['symbols']
        return cache.get('symbols') or []  # stale list beats nothing

    def _tier_rank(self, tier: str) -> int:
        ids = [t['id'] for t in self.spec['vol_tiers']]
        return ids.index(tier) if tier in ids else len(ids)

    # ------------------------------------------------------------ cycle
    def scan_cycle(self, client, now_ms: int, universe_cache: Optional[Dict[str, Any]] = None,
                   cooldown=None, spec: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Returns {'status', 'bar_close_ms', 'alerts': [...], 'market': [...], 'events': n, 'symbols': n, 'failed': n}.
        status: 'ok' | 'not_due' | 'already_done' | 'no_universe' | 'aborted'."""
        spec = spec or self.spec
        cache = universe_cache if universe_cache is not None else self.universe_cache
        cooldown = cooldown if cooldown is not None else self.cooldown
        bar_ms = int(spec['bar_minutes']) * 60000
        res: Dict[str, Any] = {'status': 'ok', 'bar_close_ms': None, 'alerts': [], 'market': [],
                               'events': 0, 'symbols': 0, 'failed': 0}

        bar_close = (now_ms // bar_ms) * bar_ms
        res['bar_close_ms'] = bar_close
        if now_ms < bar_close + CLOSE_GRACE_MS:
            # the bar that closed one bar ago is the latest we could still process; wait for the grace period
            bar_close -= bar_ms
            res['bar_close_ms'] = bar_close
        if self.last_bar_close_ms is not None and bar_close <= self.last_bar_close_ms:
            res['status'] = 'already_done'
            return res
        if now_ms < bar_close + CLOSE_GRACE_MS:
            res['status'] = 'not_due'
            return res
        open_time = bar_close - bar_ms

        universe = self._universe(client, now_ms, cache)
        tickers = client.fetch_ticker_24hr() if universe else {}
        if not universe or not tickers:
            res['status'] = 'no_universe'
            return res
        q24 = {s: tickers[s] for s in universe if s in tickers and tickers[s] >= self.min_q24}
        chosen = sorted(q24, key=lambda s: (-q24[s], s))[:self.max_symbols]
        res['symbols'] = len(chosen)

        bars_by_symbol: Dict[str, list] = {}
        failed = 0
        aborted = False

        def fetch(sym):
            try:
                return sym, client.fetch_klines_raw(sym, '5m', KLINES_LIMIT)
            except Exception:
                return sym, []

        with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
            # submit in slices so a weight breach stops further requests
            for k in range(0, len(chosen), CONCURRENCY * 4):
                w = getattr(client, 'used_weight_1m', None)
                if isinstance(w, (int, float)) and w > WEIGHT_LIMIT:
                    aborted = True
                    break
                for sym, rows in pool.map(fetch, chosen[k:k + CONCURRENCY * 4]):
                    if not rows:
                        failed += 1
                        continue
                    try:
                        bars_by_symbol[sym] = movers.bars_from_klines(rows)
                    except Exception:
                        failed += 1
        res['failed'] = failed
        if aborted or (chosen and failed * 2 > len(chosen)):
            res['status'] = 'aborted'
            return res

        events = movers.detect_events(bars_by_symbol, open_time, q24, spec)
        res['events'] = len(events)
        processed = cooldown.process(events)
        self.last_bar_close_ms = bar_close

        tradable = []
        for item in processed:
            ev = item['event']
            if ev.get('market'):
                res['market'].append(ev)
            else:
                tradable.append(item)
        tradable.sort(key=lambda it: (self._tier_rank(it['event']['tier']), -it['event']['threshold'],
                                      it['event']['symbol'], it['event']['signal']))
        cap = int(spec['max_events_per_bar'])
        alerts: List[Dict[str, Any]] = []
        for item in tradable:
            ev = item['event']
            plans = movers.plans_for_event(ev, spec)
            for mode in ('follow', 'fade'):
                plan = plans.get(mode)
                if plan is None:
                    continue
                if len(alerts) >= cap:
                    break
                a = movers.alert_dict(ev['symbol'], ev, plan, spec)
                a['meta'] = {
                    'spec_sha': movers.spec_sha(spec), 'type': item['type'],
                    'prev_threshold': item['prev_threshold'], 'signal': ev['signal'],
                    'threshold': ev['threshold'], 'ret': ev['ret'], 'tier': ev['tier'], 'q24': ev['q24'],
                    'vol_ratio': ev['vol_ratio'], 'taker_imb': ev['taker_imb'], 'atr14': ev['atr14'],
                    'breadth': ev['breadth'], 'rel_btc': ev['rel_btc'],
                }
                alerts.append(a)
        res['alerts'] = alerts
        return res

    def run(self, store, client, now_ms: Optional[int] = None) -> Dict[str, Any]:
        """scan_cycle + persist. Returns the cycle result with 'created' (count of alerts stored)."""
        now_ms = int(time.time() * 1000) if now_ms is None else now_ms
        res = self.scan_cycle(client, now_ms)
        created = 0
        for a in res['alerts']:
            if store.create_alert(a):
                created += 1
        res['created'] = created
        return res
