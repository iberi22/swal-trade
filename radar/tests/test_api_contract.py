import unittest
import tempfile
import os
import json
import threading
import urllib.request
import urllib.error
from radar.store import RadarStore
from radar.api import create_api_server

class TestApiContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp_dir = tempfile.TemporaryDirectory()
        cls.db_path = os.path.join(cls.tmp_dir.name, 'radar_api.db')
        cls.store = RadarStore(cls.db_path)
        cls.token = 'secret_radar_token_test_12345678'
        cls.state = {
            'version': '1.0.0',
            'symbols': ['BTCUSDC', 'ETHUSDC'],
            'tfs': ['15m', '1h'],
            'last_scan': '2026-10-15T18:00:00Z',
        }
        cls.port = 47391
        cls.server = create_api_server(cls.store, cls.token, cls.state, host='127.0.0.1', port=cls.port)
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()

        # Seed sample alert
        cls.aid = cls.store.create_alert({
            'dedupe_key': 'k_api_1',
            'symbol': 'BTCUSDC',
            'tf': '15m',
            'kind': 'double_top',
            'title': 'Doble techo',
            'direction': 'short',
            'entry': 82000.0,
            'stop': 82500.0,
            'target_1r': 81500.0,
            'target_2r': 81000.0,
            'strength': 0.85,
            'status': 'pending',
        })

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.tmp_dir.cleanup()

    def test_health_contract_and_no_cors_headers(self):
        url = f'http://127.0.0.1:{self.port}/v1/health'
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=5) as resp:
            self.assertEqual(resp.status, 200)
            headers = dict(resp.headers)
            # CRITICAL CHECK: NO CORS headers at all
            for h in headers:
                self.assertNotIn('access-control', h.lower(), f'Forbidden CORS header detected: {h}')
            data = json.loads(resp.read().decode('utf-8'))
            self.assertTrue(data['ok'])
            self.assertEqual(data['version'], '1.0.0')
            self.assertEqual(data['symbols'], ['BTCUSDC', 'ETHUSDC'])
            self.assertEqual(data['tfs'], ['15m', '1h'])

    def test_alerts_endpoint(self):
        url = f'http://127.0.0.1:{self.port}/v1/alerts?status=active&limit=10'
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            self.assertIn('alerts', data)
            self.assertEqual(len(data['alerts']), 1)
            alert = data['alerts'][0]
            for key in ('id', 'source', 'symbol', 'tf', 'kind', 'title', 'direction',
                        'entry', 'stop', 'target_1r', 'target_2r', 'strength', 'status'):
                self.assertIn(key, alert)

    def test_stats_endpoint(self):
        url = f'http://127.0.0.1:{self.port}/v1/stats'
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            self.assertIn('overall', data)
            self.assertIn('by_kind', data)
            self.assertIn('taken', data)
            self.assertIn('note', data)

    def test_post_note_token_auth_and_length(self):
        url = f'http://127.0.0.1:{self.port}/v1/alerts/{self.aid}/note'

        # 1. Missing token -> 401
        req1 = urllib.request.Request(url, data=b'{"taken": true}', headers={'Content-Type': 'application/json'}, method='POST')
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req1, timeout=5)
        self.assertEqual(ctx.exception.code, 401)

        # 2. Wrong token -> 401
        req2 = urllib.request.Request(url, data=b'{"taken": true}', headers={'X-Radar-Token': 'wrong', 'Content-Type': 'application/json'}, method='POST')
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req2, timeout=5)
        self.assertEqual(ctx.exception.code, 401)

        # 3. Note exceeding 200 chars -> 400
        long_note = json.dumps({'note': 'x' * 201}).encode('utf-8')
        req3 = urllib.request.Request(url, data=long_note, headers={'X-Radar-Token': self.token, 'Content-Type': 'application/json'}, method='POST')
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req3, timeout=5)
        self.assertEqual(ctx.exception.code, 400)

        # 4. Valid note and taken -> 200
        valid_payload = json.dumps({'taken': True, 'note': 'Tomada manualmente en 82000'}).encode('utf-8')
        req4 = urllib.request.Request(url, data=valid_payload, headers={'X-Radar-Token': self.token, 'Content-Type': 'application/json'}, method='POST')
        with urllib.request.urlopen(req4, timeout=5) as resp:
            self.assertEqual(resp.status, 200)
            res_data = json.loads(resp.read().decode('utf-8'))
            self.assertTrue(res_data['ok'])
            alert = self.store.get_alert(self.aid)
            self.assertEqual(alert['taken_by_user'], 1)
            self.assertEqual(alert['user_note'], 'Tomada manualmente en 82000')

if __name__ == '__main__':
    unittest.main()
