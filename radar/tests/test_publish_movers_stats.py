import io
import json
import os
import shutil
import sqlite3
import stat
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stderr, redirect_stdout

from radar import publish_movers_stats as pm
from radar.store import RadarStore

T0 = 1760000000.0  # 2025-10-09
MARKER = 'fake-visible-marker-a'
HAS_NODE = shutil.which('node') is not None
NODE_MSG = 'node not found: the Worker validator cannot be exercised'


def row(i, status='win_1r', net_r=0.99, kind='mv_fade_30m_t5_hi', direction='long', source='movers',
        taken=0, entry=100.0, stop=99.0, step=1800.0 * 2, created_at=None):
    return {'source': source, 'symbol': f'S{i}USDT', 'tf': '5m', 'kind': kind, 'direction': direction,
            'entry': entry, 'stop': stop, 'status': status, 'net_r': net_r, 'taken_by_user': taken,
            'created_at': created_at if created_at is not None else T0 + i * step}


def mixed_rows(n, wins, **kw):
    """n rows with `wins` wins, interleaved so that both time halves are alike."""
    out = []
    for i in range(n):
        win = (i * wins) // n != ((i + 1) * wins) // n
        out.append(row(i, 'win_1r' if win else 'loss', 0.99 if win else -1.0, **kw))
    return out


KEY = ('move30', 'fade', 'long', 5, 'hi')


def insert(db, r):
    with sqlite3.connect(db) as c:
        c.execute(
            'INSERT INTO alerts (source,symbol,tf,kind,title,direction,entry,stop,target_1r,target_2r,strength,'
            'status,created_at,net_r,taken_by_user,dedupe_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            (r['source'], r['symbol'], r['tf'], r['kind'], 't', r['direction'], r['entry'], r['stop'], 101, 102, 0.5,
             r['status'], r['created_at'], r['net_r'], r['taken_by_user'], f"k{r['symbol']}{r['created_at']}{r['kind']}"))


class TestCells(unittest.TestCase):
    def test_breakeven_formula(self):
        self.assertAlmostEqual(pm.breakeven_rate(0.01), 0.54)
        self.assertAlmostEqual(pm.breakeven_rate(0.04), 0.51)
        cell = pm.build_cell(KEY, mixed_rows(10, 5))
        self.assertAlmostEqual(cell['breakeven'], 0.54, places=5)
        self.assertAlmostEqual(cell['median_stop_pct'], 0.01, places=6)

    def test_cluster_counting(self):
        rows = [row(i, created_at=T0 + i * 60) for i in range(10)]  # all inside 30 minutes or two buckets
        cell = pm.build_cell(KEY, rows)
        self.assertEqual(cell['n'], 10)
        self.assertLessEqual(cell['n_clusters'], 2)
        spread = pm.build_cell(KEY, [row(i) for i in range(10)])
        self.assertEqual(spread['n_clusters'], 10)

    def test_small_cell_omitted(self):
        self.assertIsNone(pm.build_cell(KEY, mixed_rows(4, 2)))

    def test_grade_validated(self):
        c = pm.build_cell(KEY, mixed_rows(120, 96, step=3600.0))
        self.assertEqual(c['grade'], 'validated')
        self.assertGreaterEqual(c['ci_low'], c['breakeven'] + 0.02)

    def test_grade_promising(self):
        c = pm.build_cell(KEY, mixed_rows(40, 34, step=86400.0))
        self.assertEqual(c['grade'], 'promising')

    def test_grade_negative(self):
        c = pm.build_cell(KEY, mixed_rows(40, 4, step=86400.0))
        self.assertEqual(c['grade'], 'negative')

    def test_grade_no_evidence_small_clusters(self):
        c = pm.build_cell(KEY, mixed_rows(20, 20, step=86400.0))
        self.assertEqual(c['grade'], 'no_evidence')

    def test_halves_rule(self):
        self.assertEqual(pm.grade_rules(40, 0.5, 0.54, 0.1, 0.9, (0.5, 0.4)), 'promising')
        self.assertEqual(pm.grade_rules(40, 0.5, 0.54, 0.1, 0.9, (0.5, -0.1)), 'no_evidence')
        self.assertEqual(pm.grade_rules(40, 0.5, 0.54, 0.1, 0.9, (-0.1, 0.5)), 'no_evidence')
        self.assertEqual(pm.grade_rules(29, 0.5, 0.54, 0.1, 0.9, (0.5, 0.5)), 'no_evidence')
        self.assertEqual(pm.grade_rules(30, 0.1, 0.54, -0.9, -0.1, (-0.5, -0.5)), 'negative')
        self.assertEqual(pm.grade_rules(100, 0.55, 0.54, 0.1, 0.9, (0.5, 0.5)), 'promising')

    def test_bootstrap_deterministic_and_ordered(self):
        c1 = pm.build_cell(KEY, mixed_rows(40, 30, step=86400.0))
        c2 = pm.build_cell(KEY, mixed_rows(40, 30, step=86400.0))
        self.assertEqual(c1, c2)
        self.assertLessEqual(c1['net_r_ci_low'], c1['mean_net_r'])
        self.assertLessEqual(c1['mean_net_r'], c1['net_r_ci_high'])
        self.assertLessEqual(c1['ci_low'], c1['win_rate'])
        self.assertLessEqual(c1['win_rate'], c1['ci_high'])


class TestForward(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, 'r.db')
        RadarStore(self.db)
        for r in mixed_rows(12, 8):
            insert(self.db, r)
        for i in range(12):  # core alerts, other kind: ignored
            insert(self.db, row(100 + i, source='core', kind='mv_fade_30m_t5_hi'))
        for i in range(12):  # taken by the user: ignored
            insert(self.db, row(200 + i, taken=1, kind='mv_follow_30m_t3_lo'))
        for i in range(12):  # unresolved or without net_r: ignored
            insert(self.db, row(300 + i, status='pending', net_r=None, kind='mv_follow_30m_t7_mid'))

    def tearDown(self):
        self.tmp.cleanup()

    def test_document_from_db(self):
        doc = pm.build_forward_document(pm.load_forward_alerts(self.db), spec_version='2026-10-19.1', now=T0 + 1e6)
        self.assertEqual(doc['method'], 'forward')
        self.assertEqual(doc['schema'], 'swal.movers-stats.v1')
        self.assertEqual(len(doc['cells']), 1)
        c = doc['cells'][0]
        self.assertEqual((c['signal'], c['mode'], c['direction'], c['threshold'], c['vol_tier'], c['context']),
                         ('move30', 'fade', 'long', 5, 'hi', 'all'))
        self.assertEqual(c['n'], 12)
        self.assertEqual(c['wins_1r'], 8)
        self.assertEqual(list(c), pm.CELL_KEYS)

    @unittest.skipUnless(HAS_NODE, NODE_MSG)
    def test_forward_passes_worker_validator(self):
        out = os.path.join(self.tmp.name, 'f.json')
        with redirect_stdout(io.StringIO()):
            code = pm.cli_main(['--forward', '--db', self.db, '--out', out])
        self.assertEqual(code, 0)
        ok, err = pm.validate_with_worker(out)
        self.assertTrue(ok, err)

    @unittest.skipUnless(HAS_NODE, NODE_MSG)
    def test_validated_cell_passes_worker(self):
        doc = pm.build_forward_document(mixed_rows(120, 96, step=3600.0), spec_version='v1', now=T0 + 1e7)
        self.assertEqual(doc['cells'][0]['grade'], 'validated')
        p = os.path.join(self.tmp.name, 'v.json')
        pm._write_json(doc, p)
        ok, err = pm.validate_with_worker(p)
        self.assertTrue(ok, err)


def dump(obj, path):
    with open(path, 'w') as f:
        json.dump(obj, f)


def study_doc():
    cell = pm.build_cell(KEY, mixed_rows(12, 8))
    cell['r_first_half'] = 0.3
    return {'schema': 'swal.movers-stats.v1', 'method': 'study', 'spec_version': 'v1',
            'period': {'from': '2025-01-01', 'to': '2025-06-30'},
            'universe': {'quote': 'USDT', 'top_n': 50, 'rank_rule': 'q24_volume'}, 'bar': '5m',
            'cost_round_trip': 0.0008, 'evaluator': 'study', 'extra_top': 1, 'cells': [cell]}


class TestStudy(unittest.TestCase):
    def test_normalize_drops_extra_keys(self):
        out = pm.normalize_study(study_doc())
        self.assertNotIn('extra_top', out)
        self.assertNotIn('r_first_half', out['cells'][0])
        self.assertIn('generated_at', out)

    def test_missing_cell_key_rejected(self):
        d = study_doc()
        del d['cells'][0]['grade']
        with self.assertRaises(pm.PublishError):
            pm.normalize_study(d)

    @unittest.skipUnless(HAS_NODE, NODE_MSG)
    def test_cli_study_and_invalid_cell(self):
        with tempfile.TemporaryDirectory() as t:
            src, out = os.path.join(t, 's.json'), os.path.join(t, 'o.json')
            dump(study_doc(), src)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(pm.cli_main(['--study', src, '--out', out]), 0)
            with open(out) as f:
                self.assertNotIn('r_first_half', f.read())
            bad = study_doc()
            bad['cells'][0]['threshold'] = 4
            dump(bad, src)
            os.remove(out)
            with redirect_stderr(io.StringIO()):
                self.assertEqual(pm.cli_main(['--study', src, '--out', out]), 2)
            self.assertFalse(os.path.exists(out))
            bad = study_doc()
            bad['cells'][0]['grade'] = 'validated'
            dump(bad, src)
            with redirect_stderr(io.StringIO()):
                self.assertEqual(pm.cli_main(['--study', src, '--out', out]), 2)


class FakeResp:
    def __init__(self, status):
        self.status = status

    def close(self):
        pass


class TestPost(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tok = os.path.join(self.tmp.name, 'token')
        with open(self.tok, 'w') as f:
            f.write(MARKER + '\n')
        os.chmod(self.tok, 0o600)
        self.doc = os.path.join(self.tmp.name, 'd.json')
        pm._write_json(pm.build_forward_document(mixed_rows(12, 8), spec_version='v1', now=T0 + 1e6), self.doc)
        self.calls = []

    def tearDown(self):
        self.tmp.cleanup()

    def opener(self, status):
        def f(req, timeout=None):
            self.calls.append(req)
            return FakeResp(status)
        return f

    def test_post_ok(self):
        status = pm.post_document(self.doc, token_file=self.tok, url='https://example.test/x',
                                  opener=self.opener(204))
        self.assertEqual(status, 204)
        self.assertEqual(self.calls[0].full_url, 'https://example.test/x')
        self.assertEqual(self.calls[0].get_header('Authorization'), f'Bearer {MARKER}')

    def test_http_error_returns_status(self):
        def bad(req, timeout=None):
            raise urllib.error.HTTPError(req.full_url, 401, 'no', {}, None)
        self.assertEqual(pm.post_document(self.doc, token_file=self.tok, opener=bad), 401)

    def test_env_url(self):
        os.environ['PUBLIC_MOVERS_STATS_URL'] = 'https://env.test/y'
        try:
            pm.post_document(self.doc, token_file=self.tok, opener=self.opener(204))
        finally:
            del os.environ['PUBLIC_MOVERS_STATS_URL']
        self.assertEqual(self.calls[0].full_url, 'https://env.test/y')

    def test_permissions_refused_without_leak(self):
        os.chmod(self.tok, 0o644)
        with self.assertRaises(pm.PublishError) as cm:
            pm.post_document(self.doc, token_file=self.tok, opener=self.opener(204))
        self.assertNotIn(MARKER, str(cm.exception))
        self.assertEqual(self.calls, [])

    def test_missing_token(self):
        with self.assertRaises(pm.PublishError):
            pm.read_token(os.path.join(self.tmp.name, 'none'))

    @unittest.skipUnless(HAS_NODE, NODE_MSG)
    def test_cli_post_exit_codes_and_no_token_in_output(self):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = pm.cli_main(['--post', self.doc], opener=self.opener(204), token_file=self.tok)
        self.assertEqual(code, 0)
        with redirect_stdout(out), redirect_stderr(err):
            code = pm.cli_main(['--post', self.doc], opener=self.opener(401), token_file=self.tok)
        self.assertEqual(code, 1)
        os.chmod(self.tok, 0o664)
        with redirect_stdout(out), redirect_stderr(err):
            code = pm.cli_main(['--post', self.doc], opener=self.opener(204), token_file=self.tok)
        self.assertEqual(code, 1)
        self.assertNotIn(MARKER, out.getvalue() + err.getvalue())

    def test_cli_usage_errors(self):
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as cm:
                pm.cli_main(['--out', 'x'])
        self.assertNotEqual(cm.exception.code, 0)


if __name__ == '__main__':
    unittest.main()
