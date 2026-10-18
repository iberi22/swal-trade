import unittest
from unittest import mock
import urllib.error
import urllib.request
import time
import json
from radar.notify import Notifier

class TestNotifier(unittest.TestCase):
    def test_disabled_without_env(self):
        notifier = Notifier.from_env({})
        self.assertFalse(notifier.enabled)

    def test_disabled_performs_no_http(self):
        notifier = Notifier.from_env({})
        mock_post = mock.MagicMock()
        notifier.notify_new([{'id': 1, 'symbol': 'BTC', 'grade': 'validated'}], post_fn=mock_post)
        mock_post.assert_not_called()

    def test_enabled_from_env(self):
        notifier = Notifier.from_env({
            'RADAR_TELEGRAM_BOT_TOKEN': 'secret_token',
            'RADAR_TELEGRAM_CHAT_ID': '12345'
        })
        self.assertTrue(notifier.enabled)

    def test_plain_text_formatting(self):
        notifier = Notifier('tok', 'chat')
        alert = {
            'symbol': '*BTC*',
            'tf': '_15m_',
            'direction': '`long`',
            'title': '<bull_flag>',
            'entry': 60000,
            'stop': 59000,
            'target_1r': 61000,
            'n': 12,
            'grade': 'no_evidence'
        }
        text = notifier.format_alert(alert, 'no_evidence')
        self.assertNotIn('*', text)
        self.assertNotIn('_', text)
        self.assertNotIn('`', text)
        self.assertNotIn('<', text)
        self.assertNotIn('>', text)
        self.assertIn('RADAR (experimental) BTC 15m long - bullflag', text)
        self.assertIn('sin evidencia (n=12)', text)
        self.assertIn('Esto es una medicion, no una recomendacion.', text)

    def test_no_parse_mode_in_payload(self):
        notifier = Notifier('tok', 'chat')
        mock_post = mock.MagicMock()
        notifier.notify_new([{'id': 1, 'symbol': 'BTC', 'grade': 'no_evidence'}], post_fn=mock_post)

        req = mock_post.call_args[0][0]
        payload = json.loads(req.data.decode('utf-8'))
        self.assertNotIn('parse_mode', payload)
        self.assertIn('text', payload)

    def test_deduplication(self):
        notifier = Notifier('tok', 'chat', max_per_hour=10)
        mock_post = mock.MagicMock()
        alert = {'id': 1, 'symbol': 'BTC', 'grade': 'no_evidence'}
        notifier.notify_new([alert, alert], post_fn=mock_post)
        self.assertEqual(mock_post.call_count, 1)

    def test_rate_limiting_with_summary(self):
        notifier = Notifier('tok', 'chat', max_per_hour=6)
        mock_post = mock.MagicMock()

        # Send 10 new alerts
        alerts = [{'id': i, 'symbol': 'BTC', 'grade': 'no_evidence'} for i in range(10)]
        notifier.notify_new(alerts, post_fn=mock_post)

        # Should send 6 individual + 1 summary
        self.assertEqual(mock_post.call_count, 7)

        reqs = [call[0][0] for call in mock_post.call_args_list]
        payloads = [json.loads(req.data.decode('utf-8')) for req in reqs]

        summary_payload = payloads[-1]
        self.assertIn('+4 alertas mas (limite por hora)', summary_payload['text'])
        self.assertIn('Esto es una medicion, no una recomendacion.', summary_payload['text'])

    def test_rate_limiting_sliding_window(self):
        notifier = Notifier('tok', 'chat', max_per_hour=2)
        mock_post = mock.MagicMock()

        notifier.notify_new([{'id': 1, 'symbol': 'BTC', 'grade': 'no_evidence'}], post_fn=mock_post)
        notifier.notify_new([{'id': 2, 'symbol': 'BTC', 'grade': 'no_evidence'}], post_fn=mock_post)
        self.assertEqual(mock_post.call_count, 2)

        notifier.notify_new([{'id': 3, 'symbol': 'BTC', 'grade': 'no_evidence'}], post_fn=mock_post)
        # Should be a summary message, call_count = 3
        self.assertEqual(mock_post.call_count, 3)
        last_req = mock_post.call_args_list[-1][0][0]
        self.assertIn('+1', json.loads(last_req.data.decode('utf-8'))['text'])

    def test_min_grade_filtering(self):
        notifier = Notifier('tok', 'chat', min_grade='promising')
        mock_post = mock.MagicMock()

        alerts = [
            {'id': 1, 'symbol': 'A', 'grade': 'no_evidence'},
            {'id': 2, 'symbol': 'B', 'grade': 'negative'},
            {'id': 3, 'symbol': 'C', 'grade': 'promising'},
            {'id': 4, 'symbol': 'D', 'grade': 'validated'}
        ]

        notifier.notify_new(alerts, post_fn=mock_post)
        self.assertEqual(mock_post.call_count, 2)  # promising and validated

    def test_no_token_leaked_on_exception(self):
        notifier = Notifier('secret_token', 'chat')
        mock_post = mock.MagicMock(side_effect=urllib.error.URLError('token leaked secret_token url=https://botsecret_token'))

        with mock.patch('builtins.print') as mock_print:
            notifier.notify_new([{'id': 1, 'symbol': 'A', 'grade': 'no_evidence'}], post_fn=mock_post)

        printed = " ".join([str(call) for call in mock_print.call_args_list])
        self.assertNotIn('secret_token', printed)
        self.assertIn('telegram notification failed', printed)

    def test_missing_alert_id(self):
        # Even without id, should send, but skip deduplication
        notifier = Notifier('tok', 'chat')
        mock_post = mock.MagicMock()
        notifier.notify_new([{'symbol': 'A', 'grade': 'no_evidence'}], post_fn=mock_post)
        self.assertEqual(mock_post.call_count, 1)

    def test_no_recommendation_phrase_present(self):
        notifier = Notifier('tok', 'chat')
        text = notifier.format_alert({'symbol': 'A'})
        self.assertIn('no una recomendacion', text)

if __name__ == '__main__':
    unittest.main()
