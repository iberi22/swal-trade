import random
from typing import List, Dict, Any, Optional

def random_baseline_rate(
    candles_1m: List[Dict[str, float]],
    risk_pct_samples: List[float],
    rr: float = 1.0,
    cost_r: float = 0.0008,
    samples: int = 2000,
    seed: int = 11
) -> Optional[float]:
    """
    Computes the fraction of random entries that reach +rr*R before -1R on the given 1m candles.
    The baseline is computed with the same geometry and costs, meaning target and stop distances
    are adjusted by the cost_r to simulate the net R achieved.
    Returns None if fewer than 200 usable starts exist.
    """
    if len(candles_1m) < 200 or not risk_pct_samples:
        return None

    rng = random.Random(seed)

    hits = 0
    max_start_idx = len(candles_1m) - 2 # need at least one candle after entry

    for _ in range(samples):
        # Pick random start index and direction
        start_idx = rng.randint(0, max_start_idx)
        is_long = rng.choice([True, False])

        # Pick a random risk fraction
        risk_pct = rng.choice(risk_pct_samples)

        entry = candles_1m[start_idx]['close']
        risk = entry * risk_pct
        if risk <= 0:
            continue

        # Adjust distances for costs to reach a net +rr or net -1
        # To hit a net +rr, price must move risk * rr + cost_r * entry
        target_dist = risk * rr + entry * cost_r
        # To hit a net -1, price only needs to move against us by risk - cost_r * entry
        stop_dist = risk - entry * cost_r

        if stop_dist <= 0:
            # Cost alone consumes the entire risk, instant loss
            continue

        target = entry + target_dist if is_long else entry - target_dist
        stop = entry - stop_dist if is_long else entry + stop_dist

        # Simulate trade
        for i in range(start_idx + 1, len(candles_1m)):
            c = candles_1m[i]

            touches_stop = (c['low'] <= stop) if is_long else (c['high'] >= stop)
            touches_target = (c['high'] >= target) if is_long else (c['low'] <= target)

            # Conservative rule: if stop and target both inside one candle -> loss
            if touches_stop and touches_target:
                break

            if touches_stop:
                break

            if touches_target:
                hits += 1
                break

    return hits / samples
