"""Latido del radar hacia el dead-man del Worker (POST /heartbeat/radar).

Lo leen RADAR_HEARTBEAT_URL y RADAR_HEARTBEAT_TOKEN (Authorization: Bearer). El token nunca va en
la URL. Un fallo se registra sin la URL ni el token y nunca detiene el radar.
"""
import os
import urllib.request


def ping(env=None, opener=urllib.request.urlopen) -> bool:
    env = os.environ if env is None else env
    url = env.get('RADAR_HEARTBEAT_URL', '')
    token = env.get('RADAR_HEARTBEAT_TOKEN', '')
    if not url or not token:
        return False
    req = urllib.request.Request(url, data=b'', method='POST', headers={
        'Authorization': f'Bearer {token}', 'User-Agent': 'Swal-Radar/1.0'})
    try:
        opener(req, timeout=10).read()
        return True
    except Exception as x:
        print('heartbeat fallo:', type(x).__name__, flush=True)
        return False
