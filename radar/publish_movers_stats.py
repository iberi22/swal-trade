"""Publisher for the movers statistics (contract swal.movers-stats.v1, docs/design/SCANNER.md).

* --study FILE --out OUT   validates and normalizes a study document (only the contract keys, nothing recomputed).
* --forward --out OUT      builds a method 'forward' document from the resolved alerts with source 'movers'.
* --post FILE              posts a document to the public Worker (Bearer token from the ingest token file).

Every document is checked with the Worker's own validator (node) before it is written or posted.
"""
import argparse
import datetime
import json
import math
import os
import random
import re
import shutil
import statistics
import subprocess
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from typing import Any, Callable, Dict, List, Optional, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
WORKER_VALIDATOR = os.path.join(REPO_ROOT, 'workers', 'public-site', 'src', 'movers-stats.js')

SCHEMA = 'swal.movers-stats.v1'
DEFAULT_URL = 'https://trade.swal.network/ingest/movers-stats'
DEFAULT_TOKEN_FILE = os.path.expanduser('~/.config/synapse/public-ingest-token')
COST_ROUND_TRIP = 0.0008
Z95 = 1.959963984540054
MIN_CELL_N = 5
CLUSTER_SECONDS = 1800
BOOTSTRAP_SAMPLES = 1000
BOOTSTRAP_SEED = 20261019

TOP_KEYS = ['schema', 'method', 'spec_version', 'period', 'universe', 'bar', 'cost_round_trip', 'evaluator',
            'generated_at', 'cells', 'note']
REQUIRED_TOP_KEYS = [k for k in TOP_KEYS if k not in ('generated_at', 'note')]
CELL_KEYS = ['signal', 'mode', 'direction', 'threshold', 'vol_tier', 'context', 'n', 'n_clusters', 'wins_1r',
             'win_rate', 'ci_low', 'ci_high', 'breakeven', 'mean_net_r', 'net_r_ci_low', 'net_r_ci_high',
             'median_stop_pct', 'events_per_day', 'grade']

KIND_RE = re.compile(r'^mv_(fade|follow)_(\d+)m_t(\d+)_(hi|mid|lo)$')
WIN_STATUSES = ('win_1r', 'win_2r')
RESOLVED_STATUSES = ('win_1r', 'win_2r', 'loss')

FORWARD_NOTE = ('Medicion hacia adelante de alertas automaticas de movers; no es una promesa ni una '
                'recomendacion. Sin evidencia hasta n_clusters >= 30.')


class PublishError(Exception):
    pass


# ---------------------------------------------------------------- statistics

def wilson_effective(wins: float, n_eff: float) -> Tuple[float, float]:
    """Wilson interval for a proportion with (possibly fractional) effective sample size."""
    if n_eff <= 0:
        return 0.0, 1.0
    p = wins / n_eff
    z2 = Z95 * Z95
    denom = 1 + z2 / n_eff
    center = (p + z2 / (2 * n_eff)) / denom
    margin = (Z95 * math.sqrt((p * (1 - p) + z2 / (4 * n_eff)) / n_eff)) / denom
    return max(0.0, center - margin), min(1.0, center + margin)


def breakeven_rate(median_stop_pct: float, cost: float = COST_ROUND_TRIP) -> float:
    """Win rate at which a 1R trade breaks even once the round-trip cost (a fraction of price) is paid."""
    if median_stop_pct <= 0:
        return 1.0
    return min(1.0, max(0.0, (1 + cost / median_stop_pct) / 2))


def cluster_bootstrap_mean(values_by_day: Dict[int, List[float]], seed: int,
                           samples: int = BOOTSTRAP_SAMPLES) -> Tuple[float, float]:
    """95% percentile interval of the mean net R, resampling whole UTC days with replacement."""
    days = [v for _, v in sorted(values_by_day.items())]
    if len(days) < 2:
        allv = [x for d in days for x in d]
        m = sum(allv) / len(allv) if allv else 0.0
        return m, m
    rng = random.Random(seed)
    means = []
    for _ in range(samples):
        total = 0.0
        count = 0
        for _ in days:
            d = days[rng.randrange(len(days))]
            total += sum(d)
            count += len(d)
        means.append(total / count)
    means.sort()
    lo = means[int(0.025 * (samples - 1))]
    hi = means[int(math.ceil(0.975 * (samples - 1)))]
    return lo, hi


def grade_rules(n_clusters: int, ci_low: float, breakeven: float, net_low: float, net_high: float,
                half_means: Tuple[float, float]) -> str:
    if n_clusters >= 100 and ci_low >= breakeven + 0.02 - 1e-9 and net_low > 0:
        return 'validated'
    if n_clusters >= 30 and net_low > 0 and half_means[0] > 0 and half_means[1] > 0:
        return 'promising'
    if n_clusters >= 30 and net_high < 0:
        return 'negative'
    return 'no_evidence'


def _r6(x: float) -> float:
    return round(float(x), 6)


def build_cell(key: Tuple[str, str, str, int, str], rows: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    signal, mode, direction, threshold, tier = key
    n = len(rows)
    if n < MIN_CELL_N:
        return None
    rows = sorted(rows, key=lambda r: r['created_at'])
    wins = sum(1 for r in rows if r['status'] in WIN_STATUSES)
    net_rs = [float(r['net_r']) for r in rows]
    clusters = {int(r['created_at'] // CLUSTER_SECONDS) for r in rows}
    n_clusters = len(clusters)

    wins_eff = wins * n_clusters / n
    ci_low, ci_high = wilson_effective(wins_eff, n_clusters)
    win_rate = wins / n

    stops = [abs(float(r['entry']) - float(r['stop'])) / float(r['entry']) for r in rows if float(r['entry']) > 0]
    median_stop = statistics.median(stops) if stops else 0.0
    breakeven = breakeven_rate(median_stop)

    mean_r = sum(net_rs) / n
    by_day: Dict[int, List[float]] = defaultdict(list)
    for r, v in zip(rows, net_rs):
        by_day[int(r['created_at'] // 86400)].append(v)
    seed = BOOTSTRAP_SEED + sum(ord(c) for c in f'{signal}{mode}{direction}{threshold}{tier}')
    net_low, net_high = cluster_bootstrap_mean(by_day, seed)

    span_days = max(1.0, (rows[-1]['created_at'] - rows[0]['created_at']) / 86400)
    half = n // 2
    halves = (sum(net_rs[:half]) / half, sum(net_rs[half:]) / (n - half))

    cell = {
        'signal': signal, 'mode': mode, 'direction': direction, 'threshold': threshold,
        'vol_tier': tier, 'context': 'all', 'n': n, 'n_clusters': n_clusters, 'wins_1r': wins,
        'win_rate': _r6(win_rate), 'ci_low': _r6(ci_low), 'ci_high': _r6(ci_high), 'breakeven': _r6(breakeven),
        'mean_net_r': _r6(mean_r), 'net_r_ci_low': _r6(net_low), 'net_r_ci_high': _r6(net_high),
        'median_stop_pct': _r6(median_stop), 'events_per_day': _r6(n / span_days),
    }
    # Keep the intervals ordered after rounding.
    cell['ci_low'] = min(cell['ci_low'], cell['win_rate'])
    cell['ci_high'] = max(cell['ci_high'], cell['win_rate'])
    cell['net_r_ci_low'] = min(cell['net_r_ci_low'], cell['mean_net_r'])
    cell['net_r_ci_high'] = max(cell['net_r_ci_high'], cell['mean_net_r'])
    cell['grade'] = grade_rules(n_clusters, cell['ci_low'], cell['breakeven'], cell['net_r_ci_low'],
                                cell['net_r_ci_high'], halves)
    return {k: cell[k] for k in CELL_KEYS}


def _iso_day(ts: float) -> str:
    return datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc).strftime('%Y-%m-%d')


def build_forward_document(alerts: List[Dict[str, Any]], spec_version: Optional[str] = None,
                           now: Optional[float] = None, quote: str = 'USDT', top_n: int = 100,
                           rank_rule: str = 'q24_volume') -> Dict[str, Any]:
    groups: Dict[Tuple[str, str, str, int, str], List[Dict[str, Any]]] = defaultdict(list)
    times: List[float] = []
    for a in alerts:
        if a.get('source') != 'movers' or a.get('taken_by_user') == 1:
            continue
        if a.get('status') not in RESOLVED_STATUSES or a.get('net_r') is None:
            continue
        m = KIND_RE.match(str(a.get('kind', '')))
        if not m or a.get('direction') not in ('long', 'short'):
            continue
        mode, win, threshold, tier = m.group(1), int(m.group(2)), int(m.group(3)), m.group(4)
        if threshold not in (3, 5, 7):
            continue
        groups[(f'move{win}', mode, a['direction'], threshold, tier)].append(a)
        times.append(float(a['created_at']))

    cells = []
    for key in sorted(groups):
        c = build_cell(key, groups[key])
        if c:
            cells.append(c)

    if spec_version is None:
        from radar.movers import load_spec
        spec_version = str(load_spec()['version'])
    now = now if now is not None else datetime.datetime.now(datetime.timezone.utc).timestamp()
    return {
        'schema': SCHEMA,
        'method': 'forward',
        'spec_version': spec_version,
        'period': {'from': _iso_day(min(times) if times else now), 'to': _iso_day(max(times) if times else now)},
        'universe': {'quote': quote, 'top_n': top_n, 'rank_rule': rank_rule},
        'bar': '5m',
        'cost_round_trip': COST_ROUND_TRIP,
        'evaluator': 'radar.publish_movers_stats',
        'generated_at': datetime.datetime.fromtimestamp(now, tz=datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'cells': cells,
        'note': FORWARD_NOTE,
    }


def load_forward_alerts(db_path: Optional[str]) -> List[Dict[str, Any]]:
    from radar.store import RadarStore
    store = RadarStore(db_path=db_path)
    with store.get_connection() as conn:
        cur = conn.execute("SELECT * FROM alerts WHERE source = 'movers';")
        return [dict(r) for r in cur.fetchall()]


# ---------------------------------------------------------------- study

def normalize_study(doc: Any) -> Dict[str, Any]:
    """Keep only the contract keys (top level and per cell); recompute nothing."""
    if not isinstance(doc, dict):
        raise PublishError('study document must be a JSON object')
    missing = [k for k in REQUIRED_TOP_KEYS if k not in doc]
    if missing:
        raise PublishError(f'study document misses keys: {", ".join(missing)}')
    out = {k: doc[k] for k in TOP_KEYS if k in doc and doc[k] is not None}
    if not isinstance(doc['cells'], list):
        raise PublishError('cells must be a list')
    cells = []
    for i, c in enumerate(doc['cells']):
        if not isinstance(c, dict):
            raise PublishError(f'cell {i} is not an object')
        miss = [k for k in CELL_KEYS if k not in c]
        if miss:
            raise PublishError(f'cell {i} misses keys: {", ".join(miss)}')
        cells.append({k: c[k] for k in CELL_KEYS})
    out['cells'] = cells
    if 'generated_at' not in out:
        out['generated_at'] = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    return out


# ---------------------------------------------------------------- Worker validator

_NODE_SCRIPT = """
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
const mod = await import(pathToFileURL(process.argv[1]).href);
const body = JSON.parse(readFileSync(0, 'utf8'));
const r = mod.validateMoversStats(body);
process.stdout.write(JSON.stringify({ ok: r.ok, error: r.error || null }));
process.exit(r.ok ? 0 : 3);
"""


def validate_with_worker(path: str) -> Tuple[bool, Optional[str]]:
    node = shutil.which('node')
    if not node:
        return False, 'node not found'
    if not os.path.isfile(WORKER_VALIDATOR):
        return False, 'Worker validator not found'
    try:
        with open(path, 'rb') as f:
            data = f.read()
        json.loads(data)
    except (OSError, ValueError) as e:
        return False, f'cannot read JSON: {e}'
    try:
        p = subprocess.run([node, '--input-type=module', '-e', _NODE_SCRIPT, WORKER_VALIDATOR],
                           input=data, capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError) as e:
        return False, f'node failed: {e}'
    try:
        res = json.loads(p.stdout.decode('utf-8') or '{}')
    except ValueError:
        return False, 'node failed: ' + p.stderr.decode('utf-8', 'replace').strip()[-200:]
    if res.get('ok'):
        return True, None
    return False, str(res.get('error') or 'invalid document')


# ---------------------------------------------------------------- posting

def read_token(token_file: Optional[str] = None) -> str:
    path = token_file or DEFAULT_TOKEN_FILE
    try:
        mode = os.stat(path).st_mode & 0o777
    except OSError:
        raise PublishError('ingest token file not found')
    if mode & 0o077:
        raise PublishError(f'insecure permissions ({oct(mode)[2:]}) on the ingest token file; expected chmod 600')
    with open(path, 'r', encoding='utf-8') as f:
        token = f.readline().strip()
    if not token:
        raise PublishError('ingest token file is empty')
    return token


def post_document(path: str, token_file: Optional[str] = None, url: Optional[str] = None,
                  opener: Optional[Callable[..., Any]] = None) -> int:
    """POST the file to the Worker and return the HTTP status (204 = ok)."""
    token = read_token(token_file)
    with open(path, 'rb') as f:
        data = f.read()
    target = url or os.environ.get('PUBLIC_MOVERS_STATS_URL') or DEFAULT_URL
    req = urllib.request.Request(target, data=data, method='POST', headers={
        'Content-Type': 'application/json', 'Authorization': f'Bearer {token}'})
    open_fn = opener or urllib.request.urlopen
    try:
        resp = open_fn(req, timeout=20)
        status = getattr(resp, 'status', None) or resp.getcode()
        close = getattr(resp, 'close', None)
        if close:
            close()
        return int(status)
    except urllib.error.HTTPError as e:
        return int(e.code)
    except (urllib.error.URLError, OSError) as e:
        raise PublishError(f'request failed: {type(e).__name__}')


# ---------------------------------------------------------------- CLI

def _write_json(doc: Dict[str, Any], out: str) -> None:
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write('\n')


def cli_main(args: Optional[List[str]] = None, opener: Optional[Callable[..., Any]] = None,
             token_file: Optional[str] = None) -> int:
    parser = argparse.ArgumentParser(prog='radar.publish_movers_stats')
    parser.add_argument('--study', help='study JSON to validate and normalize')
    parser.add_argument('--forward', action='store_true', help='build the forward document from the radar DB')
    parser.add_argument('--out', help='output file')
    parser.add_argument('--db', default=None)
    parser.add_argument('--post', metavar='FILE', help='post a document to the Worker')
    parsed = parser.parse_args(args)

    try:
        if parsed.post:
            if parsed.study or parsed.forward:
                parser.error('--post cannot be combined with --study/--forward')
            ok, err = validate_with_worker(parsed.post)
            if not ok:
                print(f'validation failed: {err}', file=sys.stderr)
                return 2
            status = post_document(parsed.post, token_file=token_file, opener=opener)
            print(f'movers-stats -> HTTP {status}')
            return 0 if status == 204 else 1

        if bool(parsed.study) == bool(parsed.forward):
            parser.error('use exactly one of --study or --forward (or --post)')
        if not parsed.out:
            parser.error('--out is required')

        if parsed.study:
            with open(parsed.study, 'r', encoding='utf-8') as f:
                doc = normalize_study(json.load(f))
        else:
            doc = build_forward_document(load_forward_alerts(parsed.db))

        tmp = parsed.out + '.tmp'
        _write_json(doc, tmp)
        ok, err = validate_with_worker(tmp)
        if not ok:
            os.remove(tmp)
            print(f'validation failed: {err}', file=sys.stderr)
            return 2
        os.replace(tmp, parsed.out)
        print(f'wrote {parsed.out} ({len(doc["cells"])} cells)')
        return 0
    except (PublishError, OSError, ValueError) as e:
        print(f'error: {e}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(cli_main())
