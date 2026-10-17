import os
import json
from typing import List, Dict, Any, Callable, Optional

def load_klines(symbol: str, tf: str, start_ms: int, end_ms: int, fetch: Optional[Callable] = None, cache_dir: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Paginates public klines up to 1500 at a time through an injectable `fetch(symbol, tf, start_ms, limit)` callable,
    caches to JSON files under `cache_dir` (default `~/.cache/swal-trade/klines`, expanded with `os.path.expanduser`),
    and returns closed candles sorted ascending without duplicates.
    """
    if cache_dir is None:
        cache_dir = os.path.expanduser("~/.cache/swal-trade/klines")

    os.makedirs(cache_dir, exist_ok=True)

    if fetch is None:
        return []

    all_candles: Dict[int, Dict[str, Any]] = {}
    current_start = start_ms
    limit = 1500

    while current_start < end_ms:
        cache_file = os.path.join(cache_dir, f"{symbol}_{tf}_{current_start}_{limit}.json")

        if os.path.exists(cache_file):
            try:
                with open(cache_file, "r", encoding="utf-8") as f:
                    batch = json.load(f)
            except Exception:
                batch = None
        else:
            batch = None

        if batch is None:
            batch = fetch(symbol, tf, current_start, limit)
            # Only cache full batches to avoid poisoning cache with partial batches
            if batch and len(batch) == limit:
                try:
                    with open(cache_file, "w", encoding="utf-8") as f:
                        json.dump(batch, f)
                except Exception:
                    pass

        if not batch:
            break

        for c in batch:
            t = c.get("time")
            if t is not None:
                all_candles[t] = c

        last_candle_time = batch[-1].get("time")
        if last_candle_time is None:
            break

        last_ms = int(last_candle_time * 1000) if last_candle_time < 1e11 else int(last_candle_time)

        if last_ms <= current_start:
            next_start = current_start + 1
            if next_start == current_start:
                break
            current_start = next_start
        else:
            current_start = last_ms + 1

        # Break if we fetched less than limit (end of available data)
        if len(batch) < limit:
            break

    unique_candles = list(all_candles.values())
    unique_candles.sort(key=lambda c: c["time"])

    return unique_candles
