import io
import json
import unittest
from unittest import mock

from radar.binance import BinanceClient


class _FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class TestBinanceSecurity(unittest.TestCase):
    def test_signed_call_only_allows_get(self):
        # Hermetic: the request is captured instead of sent (a live call fails with HTTP 451 on
        # runners in restricted regions, and a unit test must not depend on the exchange).
        client = BinanceClient(api_key='fake_key', api_secret='fake_secret')
        captured = []

        def fake_urlopen(req, timeout=None):
            captured.append(req)
            return _FakeResponse(json.dumps([]).encode('utf-8'))

        with mock.patch('radar.binance.urllib.request.urlopen', fake_urlopen):
            self.assertEqual(client._signed_get('/fapi/v1/userTrades'), [])

        self.assertEqual(len(captured), 1)
        req = captured[0]
        self.assertEqual(req.get_method(), 'GET')
        self.assertIsNone(req.data)
        self.assertIn('signature=', req.full_url)
        self.assertEqual(req.get_header('X-mbx-apikey'), 'fake_key')

    def test_no_credentials_means_no_request(self):
        client = BinanceClient(api_key='', api_secret='')
        with mock.patch('radar.binance.urllib.request.urlopen') as urlopen:
            with self.assertRaises(RuntimeError):
                client._signed_get('/fapi/v1/userTrades')
        urlopen.assert_not_called()


if __name__ == '__main__':
    unittest.main()
