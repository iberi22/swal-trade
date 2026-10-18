import os
import json
import subprocess
from typing import List, Dict, Any
from radar.sources.base import BaseSource

# Pattern+direction cells whose net R was negative in BOTH halves of a 90-day BTC/ETH replay (n>=100 each,
# 95% interval below zero; docs/research/AUDIT_PATRONES_2026-10-18.md). Defined on the first 60% of the
# time they stay at -0.31R in the last 40%. They are not hidden because they "lose": they are muted
# because a costed measurement says they only add noise. RADAR_EXCLUDE_CELLS= (empty) turns it off.
ROBUST_NEGATIVE_CELLS = (
    'ascending_triangle:long,bear_flag:short,candle_engulfing_bearish:short,candle_engulfing_bullish:long,'
    'candle_evening_star:short,candle_hammer:long,candle_morning_star:long,candle_shooting_star:short,'
    'descending_triangle:short,double_top:short,fvg_bearish:short,fvg_bullish:long,'
    'liquidity_sweep_bearish:short,liquidity_sweep_bullish:long,order_block_bearish:short,'
    'order_block_bullish:long,rising_wedge:short'
)
# A stop tighter than this (as a fraction of price) is eaten by the 0.08% round-trip cost: the replay
# measured -0.78R under 0.15% and -0.30R under 0.30%.
DEFAULT_MIN_RISK_PCT = 0.003

TF_SECONDS = {'1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400}


def round_level(p: float) -> str:
    if p >= 1000:
        return f'{p:.1f}'
    return f'{p:.2f}'

def extract_levels(finding: Dict[str, Any]):
    levels = finding.get('levels') or []
    confirm = None
    invalidate = None

    if isinstance(levels, dict):
        confirm = levels.get('confirm')
        invalidate = levels.get('invalidate')
    elif isinstance(levels, list):
        for lvl in levels:
            if not isinstance(lvl, dict):
                continue
            if lvl.get('confirm') is not None and lvl.get('invalidate') is not None:
                confirm = lvl['confirm']
                invalidate = lvl['invalidate']
                break
            if lvl.get('role') in ('confirm', 'confirmation') and lvl.get('price') is not None:
                confirm = lvl['price']
            if lvl.get('role') in ('invalidate', 'invalidation') and lvl.get('price') is not None:
                invalidate = lvl['price']

    if confirm is None:
        confirm = finding.get('confirm') or finding.get('evidence', {}).get('confirm')
    if invalidate is None:
        invalidate = finding.get('invalidate') or finding.get('evidence', {}).get('invalidate')

    if confirm is not None and invalidate is not None:
        try:
            return float(confirm), float(invalidate)
        except (ValueError, TypeError):
            return None, None
    return None, None

class CoreSource(BaseSource):
    name: str = 'core'

    def __init__(self, detect_script: str = None, core_path: str = None):
        if detect_script is None:
            here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            detect_script = os.path.join(here, 'detect.mjs')
        self.detect_script = detect_script
        self.core_path = core_path or os.environ.get('RADAR_CORE_PATH')

    def scan(self, symbol: str, timeframe: str, candles: list) -> List[Dict[str, Any]]:
        if not candles or len(candles) < 20:
            return []

        payload = json.dumps({
            'symbol': symbol,
            'timeframe': timeframe,
            'candles': candles
        })
        env = os.environ.copy()
        if self.core_path:
            env['RADAR_CORE_PATH'] = self.core_path

        try:
            res = subprocess.run(
                ['node', self.detect_script],
                input=payload,
                text=True,
                capture_output=True,
                check=True,
                timeout=20,
                env=env
            )
            raw_findings = json.loads(res.stdout)
        except Exception:
            return []

        # Solo setups nuevos y con fuerza: el núcleo devuelve todo lo que ve en 300 velas
        # (choques de hace 150 velas, zonas S/R de contexto); como alertas serían ruido.
        max_age = int(os.environ.get('RADAR_MAX_AGE_BARS', '3'))
        min_strength = float(os.environ.get('RADAR_MIN_STRENGTH', '0.6'))
        excluded = {k.strip() for k in os.environ.get('RADAR_EXCLUDE_KINDS', 'sr_zone,volume_profile,shock').split(',') if k.strip()}
        excluded_cells = {k.strip() for k in os.environ.get('RADAR_EXCLUDE_CELLS', ROBUST_NEGATIVE_CELLS).split(',') if k.strip()}
        try:
            min_risk_pct = float(os.environ.get('RADAR_MIN_RISK_PCT', DEFAULT_MIN_RISK_PCT))
        except ValueError:
            min_risk_pct = DEFAULT_MIN_RISK_PCT
        last_time = candles[-1].get('time') if candles and isinstance(candles[-1], dict) else None
        tf_secs = TF_SECONDS.get(timeframe)

        alerts = []
        for f in raw_findings:
            if f.get('kind') in excluded:
                continue
            if float(f.get('strength') or 0) < min_strength:
                continue
            to = f.get('to')
            if isinstance(to, (int, float)) and isinstance(last_time, (int, float)) and tf_secs:
                unit = 1000 if last_time > 1e12 else 1
                if (last_time - to) / (tf_secs * unit) > max_age:
                    continue
            raw_dir = str(f.get('direction', '')).lower()
            if raw_dir in ('up', 'long', 'bullish'):
                direction = 'long'
            elif raw_dir in ('down', 'short', 'bearish'):
                direction = 'short'
            else:
                continue

            confirm, invalidate = extract_levels(f)
            if confirm is None or invalidate is None:
                continue

            entry = float(confirm)
            stop = float(invalidate)
            risk = abs(entry - stop)
            if risk <= 0:
                continue
            if f"{f.get('kind', '')}:{direction}" in excluded_cells:
                continue
            if entry > 0 and risk / entry < min_risk_pct:
                continue

            if direction == 'long' and not (entry > stop):
                continue
            if direction == 'short' and not (entry < stop):
                continue
            # An entry the price already passed is not an alert anyone can take.
            last_close = candles[-1].get('close') if isinstance(candles[-1], dict) else None
            if isinstance(last_close, (int, float)):
                if (direction == 'long' and last_close > entry) or (direction == 'short' and last_close < entry):
                    continue

            if direction == 'long':
                target_1r = entry + risk
                target_2r = entry + 2.0 * risk
            else:
                target_1r = entry - risk
                target_2r = entry - 2.0 * risk

            kind = f.get('kind', 'unknown')
            dedupe_key = f'{symbol}:{timeframe}:{kind}:{direction}:{round_level(entry)}:{round_level(stop)}'
            title = f.get('label') or f.get('kind', 'Patrón').replace('_', ' ').title()
            strength = float(f.get('strength') or 0)

            alerts.append({
                'source': self.name,
                'symbol': symbol,
                'tf': timeframe,
                'kind': kind,
                'title': title,
                'direction': direction,
                'entry': entry,
                'stop': stop,
                'target_1r': target_1r,
                'target_2r': target_2r,
                'strength': strength,
                'status': 'pending',
                'dedupe_key': dedupe_key,
            })
        return alerts
