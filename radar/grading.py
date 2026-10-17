"""
Pure grading module for evaluating trading cell strategies.
Grade rules:
- no_evidence: when n < 30.
- negative: when n >= 30 and the upper bound of the mean-net-R interval is < 0.
- validated: only when n >= 100 AND wilson_low >= breakeven + 0.02 AND mean_net_r_ci low > 0 AND (baseline_win_rate is None or wilson_low > baseline_win_rate).
- promising: when 30 <= n < 100 and wilson_low > breakeven and mean_net_r_ci low > 0.
- everything else no_evidence with the failing rule in reasons (e.g., below_breakeven, not_above_random_baseline, n_below_100).
"""

import math
import random
from typing import List, Tuple, Dict, Any, Optional

def breakeven_win_rate(rr: float, cost_r: float) -> float:
    """
    Returns the breakeven win rate for a given risk-reward ratio and cost in R.
    """
    return (1 + cost_r) / (rr + 1)

def wilson_bounds(wins: int, n: int) -> Tuple[Optional[float], Optional[float]]:
    """
    Returns the Wilson score interval lower and upper bounds at 95% confidence.
    """
    if not n or wins is None or n <= 0:
        return None, None
    p = wins / n
    z = 1.95996  # Approximation for 95% confidence
    z2 = z * z
    denom = 1 + z2 / n
    center = (p + z2 / (2 * n)) / denom
    margin = (z * math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom
    return max(0.0, center - margin), min(1.0, center + margin)

def bootstrap_mean_ci(values: List[float], iters: int = 2000, seed: int = 7) -> Optional[Tuple[float, float]]:
    """
    Returns the 95% percentile interval of the mean of `values` using bootstrap.
    Uses random.Random(seed) so two calls give identical results.
    """
    if not values:
        return None
    rng = random.Random(seed)
    n = len(values)
    means = [sum(rng.choice(values) for _ in range(n)) / n for _ in range(iters)]
    means.sort()
    low_idx = int(iters * 0.025)
    high_idx = int(iters * 0.975)
    return means[low_idx], means[high_idx]

def grade_cell(n: int, wins: int, net_rs: List[float], rr: float = 1.0, cost_r: float = 0.0008, baseline_win_rate: Optional[float] = None) -> Dict[str, Any]:
    """
    Evaluates the cell and returns a grading dictionary.
    Keys: grade, reasons, n, win_rate, wilson_low, wilson_high, breakeven, mean_net_r, mean_net_r_ci
    Returns 'no_evidence' as the default with no data. Never raises.
    """
    # Defaults with no data
    if n <= 0:
        return {
            'grade': 'no_evidence',
            'reasons': ['n_below_30'],
            'n': 0,
            'win_rate': 0.0,
            'wilson_low': None,
            'wilson_high': None,
            'breakeven': breakeven_win_rate(rr, cost_r),
            'mean_net_r': 0.0,
            'mean_net_r_ci': None
        }

    reasons = []
    win_rate = wins / n
    wilson_low, wilson_high = wilson_bounds(wins, n)
    breakeven = breakeven_win_rate(rr, cost_r)
    mean_net_r = sum(net_rs) / len(net_rs) if net_rs else 0.0
    ci = bootstrap_mean_ci(net_rs) if net_rs else None

    result = {
        'grade': 'no_evidence',
        'reasons': reasons,
        'n': n,
        'win_rate': win_rate,
        'wilson_low': wilson_low,
        'wilson_high': wilson_high,
        'breakeven': breakeven,
        'mean_net_r': mean_net_r,
        'mean_net_r_ci': list(ci) if ci else None
    }

    if n < 30:
        reasons.append('n_below_30')
        return result

    # n >= 30
    if ci is not None and ci[1] < 0:
        result['grade'] = 'negative'
        return result

    # evaluated conditions for validated
    is_validated = False
    if n >= 100:
        if wilson_low is not None and wilson_low >= breakeven + 0.02:
            if ci is not None and ci[0] > 0:
                if baseline_win_rate is None or wilson_low > baseline_win_rate:
                    is_validated = True

    if is_validated:
        result['grade'] = 'validated'
        return result

    # evaluated conditions for promising
    is_promising = False
    if 30 <= n < 100:
        if wilson_low is not None and wilson_low > breakeven:
            if ci is not None and ci[0] > 0:
                is_promising = True

    if is_promising:
        result['grade'] = 'promising'
        return result

    # default to no_evidence but populate reasons
    if n < 100:
        reasons.append('n_below_100')

    if wilson_low is None or wilson_low <= breakeven:
        reasons.append('below_breakeven')
    elif wilson_low < breakeven + 0.02 and n >= 100:
        reasons.append('not_above_breakeven_margin')

    if ci is None or ci[0] <= 0:
        reasons.append('mean_net_r_not_positive')

    if baseline_win_rate is not None and wilson_low is not None and wilson_low <= baseline_win_rate:
        reasons.append('not_above_random_baseline')

    if not reasons:
        reasons.append('did_not_meet_criteria')

    return result
