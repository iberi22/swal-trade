import unittest
import tempfile
import os
import json
import sqlite3
from unittest.mock import patch
from radar.report import build_report, get_forward_cells

class TestRadarReport(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmp_dir.name, 'radar_test.db')
        self.replay_path = os.path.join(self.tmp_dir.name, 'replay.json')

        # Create a test database using RadarStore logic (mocking init) to ensure compatibility
        from radar.store import RadarStore
        store = RadarStore(self.db_path)
        self.conn = store.get_connection()

    def tearDown(self):
        self.conn.close()
        self.tmp_dir.cleanup()

    def test_get_forward_cells_empty_db(self):
        cells = get_forward_cells(self.db_path)
        self.assertEqual(cells, [])

    def test_get_forward_cells_returns_correct_cells(self):
        # Insert 30 wins
        for i in range(30):
            self.conn.execute("""
                INSERT INTO alerts (symbol, tf, kind, title, direction, entry, stop, target_1r, target_2r, strength, status, created_at, dedupe_key, net_r)
                VALUES ('BTCUSDC', '15m', 'fvg', 'test', 'long', 1.0, 0.9, 1.1, 1.2, 0.5, 'win_1r', ?, ?, 1.0)
            """, (1000 + i, f'k{i}'))
        self.conn.commit()

        cells = get_forward_cells(self.db_path)
        self.assertEqual(len(cells), 1)
        c = cells[0]
        self.assertEqual(c['kind'], 'fvg')
        self.assertEqual(c['tf'], '15m')
        self.assertEqual(c['direction'], 'long')
        self.assertEqual(c['n'], 30)
        self.assertEqual(c['wins_1r'], 30)

    def test_build_report_no_replay_does_not_contain_replay_table(self):
        cells = [{'kind': 'fvg', 'tf': '15m', 'direction': 'long', 'n': 30, 'wins_1r': 15}]
        report = build_report(cells)
        self.assertIn("Forward (tiempo real)", report)
        self.assertNotIn("Replay (en muestra, no es evidencia)", report)
        self.assertNotIn("Confluencia", report)

    def test_build_report_with_replay_contains_replay_table(self):
        cells = [{'kind': 'fvg', 'tf': '15m', 'direction': 'long', 'n': 30, 'wins_1r': 15}]
        replay = {
            'cells': [
                {'kind': 'ob', 'tf': '1h', 'direction': 'short', 'n': 50, 'wins_1r': 30, 'mean_net_r': 0.5, 'features': {}}
            ]
        }
        report = build_report(cells, replay_summary=replay)
        self.assertIn("Replay (en muestra, no es evidencia)", report)
        self.assertIn("Confluencia", report)
        self.assertNotIn("ob | 1h", report.split("## Replay")[0]) # Replay data should not be in forward section

    def test_json_format_output(self):
        cells = [{'kind': 'fvg', 'tf': '15m', 'direction': 'long', 'n': 30, 'wins_1r': 15, 'grade': 'no_evidence'}]
        replay = {'cells': [{'kind': 'ob', 'tf': '1h', 'direction': 'short', 'n': 50, 'wins_1r': 30, 'mean_net_r': 0.5}]}
        report = build_report(cells, replay_summary=replay, fmt='json')
        parsed = json.loads(report)
        self.assertIn('forward', parsed)
        self.assertIn('replay', parsed)
        self.assertEqual(parsed['forward'][0]['kind'], 'fvg')
        self.assertEqual(parsed['replay'][0]['kind'], 'ob')

    def test_grade_no_evidence_for_n_29(self):
        for i in range(29):
            self.conn.execute("""
                INSERT INTO alerts (symbol, tf, kind, title, direction, entry, stop, target_1r, target_2r, strength, status, created_at, dedupe_key, net_r)
                VALUES ('BTCUSDC', '15m', 'fvg', 'test', 'long', 1.0, 0.9, 1.1, 1.2, 0.5, 'win_1r', ?, ?, 1.0)
            """, (1000 + i, f'k{i}'))
        self.conn.commit()
        cells = get_forward_cells(self.db_path)
        self.assertEqual(len(cells), 1)
        self.assertEqual(cells[0]['grade'], 'no_evidence')

        report = build_report(cells)
        self.assertIn("no_evidence", report)
        self.assertIn("sin evidencia", report)

    def test_confluence_section_sin_evidencia_n_below_30(self):
        replay = {
            'cells': [
                {
                    'kind': 'ob', 'tf': '1h', 'direction': 'short', 'n': 50, 'wins_1r': 30,
                    'features': {
                        'trend_4h_aligned': {
                            'true': {'n': 29, 'wins_1r': 15},
                            'false': {'n': 21, 'wins_1r': 5}
                        }
                    }
                }
            ]
        }
        report = build_report([], replay_summary=replay)
        self.assertIn("n=29 (sin evidencia)", report)
        self.assertIn("n=21 (sin evidencia)", report)

    def test_confluence_section_prints_stats_n_30(self):
        replay = {
            'cells': [
                {
                    'kind': 'ob', 'tf': '1h', 'direction': 'short', 'n': 60, 'wins_1r': 30,
                    'features': {
                        'trend_4h_aligned': {
                            'true': {'n': 30, 'wins_1r': 15},
                            'false': {'n': 30, 'wins_1r': 15}
                        }
                    }
                }
            ]
        }
        report = build_report([], replay_summary=replay)
        self.assertNotIn("sin evidencia", report.split("## Confluencia")[1])
        self.assertIn("50.0%", report)

    def test_db_read_only(self):
        # Insert 1 record
        self.conn.execute("""
            INSERT INTO alerts (symbol, tf, kind, title, direction, entry, stop, target_1r, target_2r, strength, status, created_at, dedupe_key, net_r)
            VALUES ('BTCUSDC', '15m', 'fvg', 'test', 'long', 1.0, 0.9, 1.1, 1.2, 0.5, 'win_1r', 1000, 'k1', 1.0)
        """)
        self.conn.commit()

        stat_before = os.stat(self.db_path)
        get_forward_cells(self.db_path)
        stat_after = os.stat(self.db_path)

        self.assertEqual(stat_before.st_size, stat_after.st_size)
        self.assertEqual(stat_before.st_mtime, stat_after.st_mtime)

    @patch('sys.argv', ['report.py', '--help'])
    def test_cli_help(self):
        with self.assertRaises(SystemExit) as cm:
            from radar.report import main
            main()
        self.assertEqual(cm.exception.code, 0)

if __name__ == '__main__':
    unittest.main()
