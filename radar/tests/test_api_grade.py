import unittest
import tempfile
import os
import json
import threading
import urllib.request
import urllib.error
from radar.store import RadarStore
from radar.api import create_api_server
import time

class TestApiGrade(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp_dir = tempfile.TemporaryDirectory()
        cls.db_path = os.path.join(cls.tmp_dir.name, 'radar_api_grade.db')
        cls.store = RadarStore(cls.db_path)
        cls.token = 'secret_radar_token_test_grade'
        cls.state = {
            'version': '1.0.0',
            'symbols': ['BTCUSDC'],
            'tfs': ['15m'],
            'last_scan': '2026-10-15T18:00:00Z',
        }
        cls.port = 47395
        cls.server = create_api_server(cls.store, cls.token, cls.state, host='127.0.0.1', port=cls.port)
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        
        # Populate store
        
        # Cell 1: 29 winning alerts -> no_evidence
        cls.cell1 = {'source': 'core', 'symbol': 'BTCUSDC', 'tf': '15m', 'kind': 'cell1_pattern', 'direction': 'long'}
        for i in range(29):
            cls.store.create_alert({
                'dedupe_key': f'c1_{i}', 'symbol': 'BTCUSDC', 'tf': '15m', 'kind': 'cell1_pattern',
                'title': 'Test 1', 'direction': 'long', 'entry': 100, 'stop': 90, 'target_1r': 110,
                'target_2r': 120, 'status': 'win_1r', 'created_at': time.time() - 1000
            })
            # update net_r (mocking resolved state)
            c = cls.store.get_connection()
            c.execute("UPDATE alerts SET net_r = 1.0, triggered_at = created_at WHERE dedupe_key = ?", (f'c1_{i}',))
            c.commit()

        # Cell 2: 120 alerts at 70% win rate, positive net R -> validated
        cls.cell2 = {'source': 'core', 'symbol': 'BTCUSDC', 'tf': '15m', 'kind': 'cell2_pattern', 'direction': 'short'}
        # 120 total = 84 wins, 36 losses
        for i in range(84):
            cls.store.create_alert({
                'dedupe_key': f'c2_w_{i}', 'symbol': 'BTCUSDC', 'tf': '15m', 'kind': 'cell2_pattern',
                'title': 'Test 2', 'direction': 'short', 'entry': 100, 'stop': 110, 'target_1r': 90,
                'target_2r': 80, 'status': 'win_1r', 'created_at': time.time() - 1000
            })
            c = cls.store.get_connection()
            c.execute("UPDATE alerts SET net_r = 1.0, triggered_at = created_at WHERE dedupe_key = ?", (f'c2_w_{i}',))
            c.commit()
        for i in range(36):
            cls.store.create_alert({
                'dedupe_key': f'c2_l_{i}', 'symbol': 'BTCUSDC', 'tf': '15m', 'kind': 'cell2_pattern',
                'title': 'Test 2', 'direction': 'short', 'entry': 100, 'stop': 110, 'target_1r': 90,
                'target_2r': 80, 'status': 'loss', 'created_at': time.time() - 1000
            })
            c = cls.store.get_connection()
            c.execute("UPDATE alerts SET net_r = -1.0, triggered_at = created_at WHERE dedupe_key = ?", (f'c2_l_{i}',))
            c.commit()

        # Cell 3: 120 alerts at 70% win rate, negative net R -> not validated
        cls.cell3 = {'source': 'core', 'symbol': 'BTCUSDC', 'tf': '15m', 'kind': 'cell3_pattern', 'direction': 'long'}
        # 84 wins but with net R = 0.1 (low R wins), 36 losses with net R = -1.0
        for i in range(84):
            cls.store.create_alert({
                'dedupe_key': f'c3_w_{i}', 'symbol': 'BTCUSDC', 'tf': '15m', 'kind': 'cell3_pattern',
                'title': 'Test 3', 'direction': 'long', 'entry': 100, 'stop': 90, 'target_1r': 110,
                'target_2r': 120, 'status': 'win_1r', 'created_at': time.time() - 1000
            })
            c = cls.store.get_connection()
            c.execute("UPDATE alerts SET net_r = 0.1, triggered_at = created_at WHERE dedupe_key = ?", (f'c3_w_{i}',))
            c.commit()
        for i in range(36):
            cls.store.create_alert({
                'dedupe_key': f'c3_l_{i}', 'symbol': 'BTCUSDC', 'tf': '15m', 'kind': 'cell3_pattern',
                'title': 'Test 3', 'direction': 'long', 'entry': 100, 'stop': 90, 'target_1r': 110,
                'target_2r': 120, 'status': 'loss', 'created_at': time.time() - 1000
            })
            c = cls.store.get_connection()
            c.execute("UPDATE alerts SET net_r = -1.0, triggered_at = created_at WHERE dedupe_key = ?", (f'c3_l_{i}',))
            c.commit()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.tmp_dir.cleanup()

    def test_29_winning_alerts_no_evidence(self):
        stats = self.store.get_stats()
        c1_stats = next(g for g in stats['by_kind'] if g['kind'] == 'cell1_pattern')
        self.assertEqual(c1_stats['grade'], 'no_evidence')
        self.assertIn('n_below_30', c1_stats['reasons'])
        self.assertEqual(c1_stats['n_resolved'], 29)

    def test_120_alerts_validated(self):
        stats = self.store.get_stats()
        c2_stats = next(g for g in stats['by_kind'] if g['kind'] == 'cell2_pattern')
        self.assertEqual(c2_stats['grade'], 'validated')
        self.assertEqual(c2_stats['n_resolved'], 120)

    def test_120_alerts_negative_net_r_not_validated(self):
        stats = self.store.get_stats()
        c3_stats = next(g for g in stats['by_kind'] if g['kind'] == 'cell3_pattern')
        self.assertNotEqual(c3_stats['grade'], 'validated')
        self.assertEqual(c3_stats['grade'], 'negative')
        self.assertEqual(c3_stats['n_resolved'], 120)

    def test_alerts_min_grade_promising(self):
        url = f'http://127.0.0.1:{self.port}/v1/alerts?min_grade=validated&limit=500'
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            self.assertIn('alerts', data)
            alerts = data['alerts']
            # Only cell2 is validated
            self.assertTrue(len(alerts) > 0)
            for a in alerts:
                self.assertEqual(a['cell_grade'], 'validated')
                self.assertEqual(a['kind'], 'cell2_pattern')

    def test_alerts_sort_grade(self):
        url = f'http://127.0.0.1:{self.port}/v1/alerts?sort=grade&limit=500'
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            self.assertIn('alerts', data)
            alerts = data['alerts']
            # Should have validated first
            self.assertEqual(alerts[0]['cell_grade'], 'validated')
            self.assertEqual(alerts[0]['kind'], 'cell2_pattern')
            
            grades = [a['cell_grade'] for a in alerts]
            weights = {'negative': 0, 'no_evidence': 1, 'promising': 2, 'validated': 3}
            w_list = [weights.get(g, -1) for g in grades]
            self.assertEqual(w_list, sorted(w_list, reverse=True))

    def test_backward_compatibility_get_stats(self):
        stats = self.store.get_stats()
        c1 = next(g for g in stats['by_kind'] if g['kind'] == 'cell1_pattern')
        self.assertIn('n_resolved', c1)
        self.assertIn('triggered_rate', c1)
        self.assertIn('win_rate_1r', c1)
        self.assertIn('ci_1r', c1)
        self.assertIn('win_rate_2r', c1)
        self.assertIn('ci_2r', c1)
        self.assertIn('avg_net_r', c1)
        self.assertIn('label', c1)
        
        self.assertIsInstance(c1['n_resolved'], int)
        self.assertIsInstance(c1['label'], str)
        self.assertIsInstance(c1['ci_1r'], dict)

    def test_stats_grade_policy_matches(self):
        url = f'http://127.0.0.1:{self.port}/v1/stats'
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            self.assertIn('grade_policy', data)
            policy = data['grade_policy']
            self.assertEqual(policy['min_n_validated'], 100)
            self.assertEqual(policy['min_n_promising'], 30)
            self.assertEqual(policy['breakeven_margin'], 0.02)
            self.assertEqual(policy['rr'], 1.0)
            self.assertEqual(policy['cost_r'], 0.0008)

    def test_min_grade_promising_skips_negative(self):
        url = f'http://127.0.0.1:{self.port}/v1/alerts?min_grade=promising'
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            self.assertIn('alerts', data)
            alerts = data['alerts']
            for a in alerts:
                self.assertNotEqual(a['cell_grade'], 'negative')
                
    def test_stats_note_exact_match(self):
        url = f'http://127.0.0.1:{self.port}/v1/stats'
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            self.assertEqual(
                data['note'], 
                "Un alerta es un experimento, nunca una promesa; nuestro backtest no halló evidencia de superar el azar (sin evidencia). Estadísticas muestran intervalos Wilson 95%. Una calificación es una medición de alertas pasadas, no una recomendación. Para la etiqueta 'validated' se requiere n >= 100."
            )
            
    def test_list_alerts_default_status(self):
        url = f'http://127.0.0.1:{self.port}/v1/alerts'
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            self.assertIn('alerts', data)
            self.assertTrue(len(data['alerts']) > 0)

if __name__ == '__main__':
    unittest.main()
