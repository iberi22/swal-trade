import unittest
from unittest import mock

from radar import heartbeat


class Heartbeat(unittest.TestCase):
    def test_posts_with_bearer_header(self):
        opener = mock.MagicMock()
        ok = heartbeat.ping({'RADAR_HEARTBEAT_URL': 'https://trade.example/heartbeat/radar',
                             'RADAR_HEARTBEAT_TOKEN': 'tok'}, opener=opener)
        self.assertTrue(ok)
        req = opener.call_args[0][0]
        self.assertEqual(req.full_url, 'https://trade.example/heartbeat/radar')
        self.assertEqual(req.get_method(), 'POST')
        self.assertEqual(req.get_header('Authorization'), 'Bearer tok')

    def test_needs_url_and_token(self):
        opener = mock.MagicMock()
        self.assertFalse(heartbeat.ping({'RADAR_HEARTBEAT_URL': 'https://x/heartbeat/radar'}, opener=opener))
        self.assertFalse(heartbeat.ping({'RADAR_HEARTBEAT_TOKEN': 'tok'}, opener=opener))
        opener.assert_not_called()

    def test_failure_is_not_fatal_and_does_not_leak(self):
        opener = mock.MagicMock(side_effect=OSError('https://x/heartbeat/radar tok'))
        with mock.patch('builtins.print') as pr:
            ok = heartbeat.ping({'RADAR_HEARTBEAT_URL': 'https://x/heartbeat/radar',
                                 'RADAR_HEARTBEAT_TOKEN': 'tok'}, opener=opener)
        self.assertFalse(ok)
        printed = ' '.join(map(str, pr.call_args[0]))
        self.assertNotIn('tok', printed)
        self.assertNotIn('heartbeat/radar', printed)


if __name__ == '__main__':
    unittest.main()
