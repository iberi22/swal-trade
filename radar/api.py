import json
import re
import hmac
import urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Optional, Dict, Any
from radar.store import RadarStore, get_or_create_token

class RadarApiHandler(BaseHTTPRequestHandler):
    store: RadarStore
    token: str
    state: Dict[str, Any]

    def log_message(self, format, *args):
        # Silence default access logs to stdout/stderr
        pass

    def _send_json(self, status_code: int, data: Any):
        # CRITICAL CONTRACT: Bind 127.0.0.1 only, NO CORS headers at all.
        body = json.dumps(data).encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip('/')
        query = urllib.parse.parse_qs(parsed.query)

        if path == '/v1/health':
            res = {
                'ok': True,
                'version': self.state.get('version', '1.0.0'),
                'symbols': self.state.get('symbols', ['BTCUSDC', 'ETHUSDC']),
                'tfs': self.state.get('tfs', ['15m', '1h']),
                'last_scan': self.state.get('last_scan'),
                'db': self.store.db_path,
            }
            self._send_json(200, res)
            return

        if path == '/v1/alerts':
            status = query.get('status', ['all'])[0]
            try:
                limit = int(query.get('limit', ['50'])[0])
            except ValueError:
                limit = 50
            alerts = self.store.list_alerts(status=status, limit=limit)
            self._send_json(200, {'alerts': alerts})
            return

        if path == '/v1/stats':
            stats = self.store.get_stats()
            self._send_json(200, stats)
            return

        self._send_json(404, {'ok': False, 'error': 'not found'})

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip('/')

        match = re.match(r'^/v1/alerts/(\d+)/note$', path)
        if not match:
            self._send_json(404, {'ok': False, 'error': 'not found'})
            return

        alert_id = int(match.group(1))

        # Check token header
        req_token = self.headers.get('X-Radar-Token', '').strip()
        if not req_token or not hmac.compare_digest(req_token, self.token):
            self._send_json(401, {'ok': False, 'error': 'unauthorized'})
            return

        # Check alert exists
        alert = self.store.get_alert(alert_id)
        if not alert:
            self._send_json(404, {'ok': False, 'error': 'alert not found'})
            return

        content_length = int(self.headers.get('Content-Length', 0))
        body_bytes = self.rfile.read(content_length) if content_length > 0 else b'{}'
        try:
            body = json.loads(body_bytes.decode('utf-8'))
        except Exception:
            self._send_json(400, {'ok': False, 'error': 'invalid json'})
            return

        updates = {}
        if 'taken' in body:
            updates['taken_by_user'] = 1 if body['taken'] else 0
        if 'note' in body:
            note_str = str(body['note'])
            if len(note_str) > 200:
                self._send_json(400, {'ok': False, 'error': 'note must be <= 200 chars'})
                return
            updates['user_note'] = note_str

        if updates:
            self.store.update_alert(alert_id, updates)

        updated_alert = self.store.get_alert(alert_id)
        self._send_json(200, {'ok': True, 'alert': updated_alert})

def create_api_server(
    store: RadarStore,
    token: str,
    state: Dict[str, Any],
    host: str = '127.0.0.1',
    port: int = 47322,
) -> HTTPServer:
    handler = type('RadarHandler', (RadarApiHandler,), {
        'store': store,
        'token': token,
        'state': state,
    })
    return HTTPServer((host, port), handler)
