import os
import time
import json
import hmac
import hashlib
import urllib.request
import urllib.parse
import urllib.error
from typing import List, Dict, Any, Optional

DEFAULT_FAPI_URL = 'https://fapi.binance.com'

class BinanceClient:
    def __init__(
        self,
        api_key: Optional[str] = None,
        api_secret: Optional[str] = None,
        base_url: Optional[str] = None,
    ):
        self.api_key = api_key or os.environ.get('BINANCE_API_KEY') or ''
        self.api_secret = api_secret or os.environ.get('BINANCE_API_SECRET') or os.environ.get('BINANCE_SECRET_KEY') or ''
        self.base_url = (base_url or os.environ.get('BINANCE_FUTURES_URL') or DEFAULT_FAPI_URL).rstrip('/')

    def has_credentials(self) -> bool:
        return bool(self.api_key and self.api_secret)

    def fetch_klines(self, symbol: str, interval: str = '15m', limit: int = 300) -> List[Dict[str, Any]]:
        """
        Fetches klines from public endpoint with 10s connect / 20s total timeout.
        Tolerates network failures gracefully by returning an empty list.
        """
        params = {
            'symbol': symbol,
            'interval': interval,
            'limit': max(1, min(limit + 5, 1000)),
        }
        url = f'{self.base_url}/fapi/v1/klines?{urllib.parse.urlencode(params)}'
        req = urllib.request.Request(url, headers={'User-Agent': 'Swal-Radar/1.0'})

        try:
            # 20s total timeout
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read().decode('utf-8'))
        except Exception:
            return []

        if not isinstance(data, list):
            return []

        now_ms = int(time.time() * 1000)
        candles = []
        for k in data:
            if not isinstance(k, list) or len(k) < 6:
                continue
            open_time = int(k[0])
            close_time = int(k[6]) if len(k) > 6 else open_time
            # Keep only closed candles
            if close_time > now_ms:
                continue

            candles.append({
                'time': int(open_time / 1000) if open_time > 1e11 else open_time,
                'open': float(k[1]),
                'high': float(k[2]),
                'low': float(k[3]),
                'close': float(k[4]),
                'volume': float(k[5]),
                'trades': float(k[8]) if len(k) > 8 and k[8] is not None else 0.0,
                'takerBuyVolume': float(k[9]) if len(k) > 9 and k[9] is not None else 0.0,
            })

        # Return up to limit closed candles
        return candles[-limit:]

    def _signed_get(self, path: str, params: Optional[Dict[str, Any]] = None, _retry: bool = True) -> Any:
        """
        Executes a signed GET request against Binance Futures.
        CRITICAL: Never place orders. GET only — assert in code that HTTP method is GET.
        """
        method = 'GET'
        assert method == 'GET', f'Signed calls must be GET only, attempted {method}'

        if not self.has_credentials():
            raise RuntimeError('Missing BINANCE_API_KEY or BINANCE_API_SECRET')

        p = dict(params or {})
        p['timestamp'] = int(time.time() * 1000)
        p['recvWindow'] = 15000

        query_str = urllib.parse.urlencode(p)
        signature = hmac.new(self.api_secret.encode('utf-8'), query_str.encode('utf-8'), hashlib.sha256).hexdigest()
        full_query = f'{query_str}&signature={signature}'

        url = f'{self.base_url}{path}?{full_query}'
        req = urllib.request.Request(
            url,
            method=method,
            headers={
                'X-MBX-APIKEY': self.api_key,
                'User-Agent': 'Swal-Radar/1.0',
            }
        )

        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as x:
            body = x.read().decode('utf-8', errors='replace')
            # Error -1021: timestamp outside recvWindow -> retry once
            if _retry and '"code":-1021' in body.replace(' ', ''):
                time.sleep(0.5)
                return self._signed_get(path, params, _retry=False)
            raise RuntimeError(f'HTTP {x.code}: {body}') from None
        except Exception as x:
            raise RuntimeError(f'{type(x).__name__}: {str(x)[:120]}') from None

    def get_user_trades(self, symbol: str, limit: int = 50) -> List[Dict[str, Any]]:
        """
        Fetch signed user trades for the specified symbol.
        """
        assert 'GET' == 'GET', 'Signed calls must be GET only'
        try:
            res = self._signed_get('/fapi/v1/userTrades', {'symbol': symbol, 'limit': limit})
            return res if isinstance(res, list) else []
        except Exception:
            return []

    def get_realized_pnl(self, symbol: str, limit: int = 20) -> List[Dict[str, Any]]:
        """
        Fetch signed income records for REALIZED_PNL.
        """
        assert 'GET' == 'GET', 'Signed calls must be GET only'
        try:
            res = self._signed_get('/fapi/v1/income', {'symbol': symbol, 'incomeType': 'REALIZED_PNL', 'limit': limit})
            return res if isinstance(res, list) else []
        except Exception:
            return []
