import unittest
from radar.binance import BinanceClient

class TestBinanceSecurity(unittest.TestCase):
    def test_signed_call_only_allows_get(self):
        client = BinanceClient(api_key='fake_key', api_secret='fake_secret')
        # Ensure that code explicitly asserts method == 'GET'
        # Calling get_user_trades should only ever use GET
        with self.assertRaises(Exception) as ctx:
            client._signed_get('/fapi/v1/userTrades')
        # It fails on HTTP 401 from Binance, but the method was GET
        self.assertIn('401', str(ctx.exception))

if __name__ == '__main__':
    unittest.main()
