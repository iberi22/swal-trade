import json
import os
import subprocess
import unittest
from unittest import mock

from radar.sources.core import CoreSource, ROBUST_NEGATIVE_CELLS


def finding(kind, direction, confirm, invalidate, strength=0.8, to=None):
    return {'kind': kind, 'direction': 'up' if direction == 'long' else 'down', 'strength': strength,
            'to': to, 'levels': {'confirm': confirm, 'invalidate': invalidate}}


def run_scan(findings, env=None):
    candles = [{'time': 1000 + i * 900, 'open': 100, 'high': 101, 'low': 99, 'close': 100} for i in range(30)]
    proc = subprocess.CompletedProcess([], 0, stdout=json.dumps(findings), stderr='')
    with mock.patch.dict(os.environ, env or {}, clear=False), mock.patch('subprocess.run', return_value=proc):
        return CoreSource().scan('BTCUSDC', '15m', candles)


class CoreFilterTests(unittest.TestCase):
    def test_default_cells_list_is_well_formed(self):
        cells = ROBUST_NEGATIVE_CELLS.split(',')
        self.assertEqual(len(cells), 17)
        for c in cells:
            kind, direction = c.split(':')
            self.assertIn(direction, ('long', 'short'))

    def test_a_muted_cell_is_dropped_but_the_other_direction_is_kept(self):
        # double_top:short is muted; double_top:long is not in the list.
        out = run_scan([finding('double_top', 'short', 99, 101), finding('double_top', 'long', 101, 99)])
        self.assertEqual([(a['kind'], a['direction']) for a in out], [('double_top', 'long')])

    def test_empty_exclude_cells_turns_the_mute_off(self):
        out = run_scan([finding('double_top', 'short', 99, 101)], {'RADAR_EXCLUDE_CELLS': ''})
        self.assertEqual(len(out), 1)

    def test_stop_tighter_than_the_cost_floor_is_dropped(self):
        # risk 0.1 on a price of 100 is 0.1%, below the 0.3% default floor.
        tight = finding('range_breakout', 'long', 100.5, 100.4)
        wide = finding('range_breakout', 'long', 101, 99.5)
        self.assertEqual(len(run_scan([tight])), 0)
        self.assertEqual(len(run_scan([wide])), 1)

    def test_min_risk_floor_can_be_lowered(self):
        tight = finding('range_breakout', 'long', 100.5, 100.4)
        self.assertEqual(len(run_scan([tight], {'RADAR_MIN_RISK_PCT': '0'})), 1)


if __name__ == '__main__':
    unittest.main()
