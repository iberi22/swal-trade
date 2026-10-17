import math
from typing import Dict, Any, List, Optional, Tuple

ROUND_TRIP_COST = 0.0008  # 0.08% round-trip (taker 0.04% x 2)

TF_SECONDS = {
    '1m': 60,
    '3m': 180,
    '5m': 300,
    '15m': 900,
    '30m': 1800,
    '1h': 3600,
    '2h': 7200,
    '4h': 14400,
    '6h': 21600,
    '8h': 28800,
    '12h': 43200,
    '1d': 86400,
}

def tf_to_seconds(tf: str) -> int:
    return TF_SECONDS.get(tf.lower(), 900)

def cost_in_r(entry: float, risk: float, fee_fraction: float = ROUND_TRIP_COST) -> float:
    if risk <= 0:
        return 0.0
    return (fee_fraction * abs(entry)) / risk

def normalize_candle(c: Any) -> Optional[Dict[str, float]]:
    if isinstance(c, (list, tuple)):
        if len(c) < 5:
            return None
        t = float(c[0])
        if t > 1e11:
            t /= 1000.0
        return {
            'time': t,
            'open': float(c[1]),
            'high': float(c[2]),
            'low': float(c[3]),
            'close': float(c[4]),
        }
    if isinstance(c, dict):
        t = float(c.get('time', c.get('t', 0.0)))
        if t > 1e11:
            t /= 1000.0
        return {
            'time': t,
            'open': float(c['open']),
            'high': float(c['high']),
            'low': float(c['low']),
            'close': float(c['close']),
        }
    return None

def evaluate_alert_on_candles(alert: Dict[str, Any], candles: List[Any]) -> Dict[str, Any]:
    """
    Evaluates an alert through a sequence of 1m candles.
    Returns the updated alert state dict with any status transitions,
    MFE/MAE tracking, trigger time, resolution time, outcome_r, and net_r.
    """
    state = dict(alert)
    if state.get('status') in ('win_1r', 'win_2r', 'loss', 'expired', 'missed'):
        return state

    norm_candles = [c for c in (normalize_candle(x) for x in candles) if c is not None]
    if not norm_candles:
        return state

    norm_candles.sort(key=lambda x: x['time'])

    entry = float(state['entry'])
    stop = float(state['stop'])
    risk = abs(entry - stop)
    if risk <= 0:
        return state

    target_1r = float(state['target_1r'])
    target_2r = float(state['target_2r'])
    direction = str(state['direction']).lower()
    is_long = direction == 'long'

    created_at = float(state.get('created_at') or norm_candles[0]['time'])
    tf_sec = tf_to_seconds(state.get('tf', '15m'))
    max_trigger_sec = tf_sec * 24
    max_resolve_sec = tf_sec * 96

    triggered_at = state.get('triggered_at')
    mfe_r = float(state.get('mfe_r') or 0.0)
    mae_r = float(state.get('mae_r') or 0.0)
    # Armed flag is local: it is re-derived each pass from the candles and must never reach the
    # alert row (the persisted dict is written back to SQLite column by column).
    armed = False

    for c in norm_candles:
        c_time = c['time']
        if c_time < created_at:
            continue

        current_status = state.get('status', 'pending')

        # 1. PENDING phase
        if current_status == 'pending':
            # Check untriggered expiration
            if c_time - created_at > max_trigger_sec:
                state['status'] = 'expired'
                state['resolved_at'] = c_time
                state['outcome_r'] = 0.0
                state['net_r'] = 0.0
                return state

            # Trigger = a real CROSS: a 1m close on the near side of the entry first, then a
            # close beyond it ('cierra más allá'). If the very first close after creation is
            # already beyond, the entry was passed before the alert existed: nobody could
            # take it, so it is 'missed' and stays out of the stats.
            beyond = (c['close'] > entry) if is_long else (c['close'] < entry)
            if not armed:
                if beyond:
                    state['status'] = 'missed'
                    state['resolved_at'] = c_time
                    state['outcome_r'] = None
                    state['net_r'] = None
                    return state
                armed = True
                continue
            if not beyond:
                continue
            # The fill is the close of the trigger candle; stop stays, R and targets are
            # measured from the fill. Outcomes start on the NEXT candle (no same-bar peeking).
            fill = c['close']
            risk = abs(fill - stop)
            if risk <= 0:
                continue
            entry = fill
            target_1r = fill + risk if is_long else fill - risk
            target_2r = fill + 2 * risk if is_long else fill - 2 * risk
            state.update({'entry': round(fill, 8), 'target_1r': round(target_1r, 8), 'target_2r': round(target_2r, 8)})
            state['status'] = 'triggered'
            triggered_at = c_time
            state['triggered_at'] = triggered_at
            state['minutes_to_trigger'] = max(0, int((triggered_at - created_at) / 60))
            continue

        # 2. TRIGGERED phase
        if state.get('status') == 'triggered':
            if triggered_at is not None and c_time <= triggered_at:
                continue

            # Check expiration if not resolved within 96 candles
            if c_time - created_at > max_resolve_sec:
                state['status'] = 'expired'
                state['resolved_at'] = c_time
                mtm_r = (c['close'] - entry) / risk if is_long else (entry - c['close']) / risk
                c_cost = cost_in_r(entry, risk)
                state['outcome_r'] = round(mtm_r, 4)
                state['net_r'] = round(mtm_r - c_cost, 4)
                if triggered_at:
                    state['minutes_to_outcome'] = max(0, int((c_time - triggered_at) / 60))
                return state

            # Update MFE / MAE
            fav = (c['high'] - entry) / risk if is_long else (entry - c['low']) / risk
            adv = (entry - c['low']) / risk if is_long else (c['high'] - entry) / risk
            mfe_r = max(mfe_r, fav)
            mae_r = max(mae_r, adv)
            state['mfe_r'] = round(mfe_r, 4)
            state['mae_r'] = round(mae_r, 4)

            # Check touches
            touches_stop = (c['low'] <= stop) if is_long else (c['high'] >= stop)
            touches_1r = (c['high'] >= target_1r) if is_long else (c['low'] <= target_1r)
            touches_2r = (c['high'] >= target_2r) if is_long else (c['low'] <= target_2r)

            # Conservative rule: if stop and target both inside one candle -> loss
            if touches_stop and (touches_1r or touches_2r):
                state['status'] = 'loss'
                state['resolved_at'] = c_time
                state['outcome_r'] = -1.0
                state['net_r'] = round(-1.0 - cost_in_r(entry, risk), 4)
                if triggered_at:
                    state['minutes_to_outcome'] = max(0, int((c_time - triggered_at) / 60))
                return state

            if touches_stop:
                state['status'] = 'loss'
                state['resolved_at'] = c_time
                state['outcome_r'] = -1.0
                state['net_r'] = round(-1.0 - cost_in_r(entry, risk), 4)
                if triggered_at:
                    state['minutes_to_outcome'] = max(0, int((c_time - triggered_at) / 60))
                return state

            if touches_2r:
                state['status'] = 'win_2r'
                state['resolved_at'] = c_time
                state['outcome_r'] = 2.0
                state['net_r'] = round(2.0 - cost_in_r(entry, risk), 4)
                if triggered_at:
                    state['minutes_to_outcome'] = max(0, int((c_time - triggered_at) / 60))
                return state

            if touches_1r:
                state['status'] = 'win_1r'
                state['resolved_at'] = c_time
                state['outcome_r'] = 1.0
                state['net_r'] = round(1.0 - cost_in_r(entry, risk), 4)
                if triggered_at:
                    state['minutes_to_outcome'] = max(0, int((c_time - triggered_at) / 60))
                return state

    return state
