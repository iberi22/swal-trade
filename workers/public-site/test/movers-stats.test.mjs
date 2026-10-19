import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { validateMoversStats } from '../src/movers-stats.js';

function cell(over = {}) {
  return {
    signal: 'ret_5m', mode: 'fade', direction: 'short', threshold: 5, vol_tier: 'hi', context: 'all',
    n: 400, n_clusters: 150, wins_1r: 230,
    win_rate: 0.575, ci_low: 0.54, ci_high: 0.61, breakeven: 0.51,
    mean_net_r: 0.1, net_r_ci_low: 0.02, net_r_ci_high: 0.18,
    median_stop_pct: 0.01, events_per_day: 3.5, grade: 'validated',
    ...over,
  };
}
function body(over = {}) {
  return {
    schema: 'swal.movers-stats.v1', method: 'study', spec_version: 'v1.0',
    period: { from: '2025-01-01', to: '2025-12-31' },
    universe: { quote: 'USDT', top_n: 50, rank_rule: 'volume_24h' },
    bar: '5m', cost_round_trip: 0.0008, evaluator: 'py_study_1',
    cells: [cell()], note: 'nota',
    ...over,
  };
}
const bad = (b, re) => {
  const r = validateMoversStats(b);
  assert.equal(r.ok, false);
  if (re) assert.match(r.error, re);
};

test('valid document passes and is sanitized', () => {
  const r = validateMoversStats(body());
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.value.cells[0]), Object.keys(cell()));
  assert.equal(r.value.note, 'nota');
});

test('rejects extra keys (top and cell)', () => {
  bad(body({ extra: 1 }), /Invalid keys/);
  bad(body({ cells: [cell({ entry_price: 1 })] }), /Invalid cell keys/);
});
test('rejects bad enums', () => {
  bad(body({ method: 'x' }), /method/);
  bad(body({ cells: [cell({ mode: 'x' })] }), /mode/);
  bad(body({ cells: [cell({ threshold: 4 })] }), /threshold/);
  bad(body({ cells: [cell({ vol_tier: 'x' })] }), /vol_tier/);
  bad(body({ cells: [cell({ context: 'x' })] }), /context/);
  bad(body({ cells: [cell({ grade: 'x' })] }), /grade/i);
});
test('rejects counts inconsistent', () => {
  bad(body({ cells: [cell({ wins_1r: 401 })] }), /wins_1r/);
  bad(body({ cells: [cell({ n_clusters: 401 })] }), /n_clusters/);
});
test('rejects wrong ci order and big R', () => {
  bad(body({ cells: [cell({ ci_low: 0.6, win_rate: 0.57 })] }), /confidence/);
  bad(body({ cells: [cell({ net_r_ci_low: 0.2 })] }), /net_r/);
  bad(body({ cells: [cell({ mean_net_r: 11, net_r_ci_high: 12 })] }), /mean_net_r/);
});
test('grade coherence', () => {
  bad(body({ cells: [cell({ n_clusters: 99 })] }), /validated/);
  bad(body({ cells: [cell({ ci_low: 0.52 })] }), /validated/);
  bad(body({ cells: [cell({ grade: 'promising', net_r_ci_low: 0, mean_net_r: 0.05 })] }), /promising/);
  bad(body({ cells: [cell({ grade: 'promising', n_clusters: 29 })] }), /promising/);
  bad(body({ cells: [cell({ grade: 'negative' })] }), /negative/);
  bad(body({ cells: [cell({ grade: 'negative', mean_net_r: -0.1, net_r_ci_low: -0.2, net_r_ci_high: 0 })] }), /negative/);
  assert.equal(validateMoversStats(body({ cells: [cell({ grade: 'no_evidence', n: 0, n_clusters: 0, wins_1r: 0 })] })).ok, true);
  assert.equal(validateMoversStats(body({ cells: [cell({ grade: 'negative', mean_net_r: -0.1, net_r_ci_low: -0.2, net_r_ci_high: -0.01 })] })).ok, true);
});
test('rejects more than 500 cells', () => {
  bad(body({ cells: Array(501).fill(cell()) }), /too large/);
  assert.equal(validateMoversStats(body({ cells: Array(500).fill(cell()) })).ok, true);
});

function buildEnv() {
  const map = new Map();
  return {
    PUBLIC_INGEST_TOKEN: 'secret123',
    SNAPSHOTS: { get: async (k) => map.get(k) || null, put: async (k, v) => map.set(k, v) },
    _map: map,
  };
}
const U = 'http://trade.swal.network';
const post = (b, token = 'secret123', raw) => new Request(`${U}/ingest/movers-stats`, {
  method: 'POST',
  headers: token ? { Authorization: `Bearer ${token}` } : {},
  body: raw ?? JSON.stringify(b),
});

test('POST: 401 without/with wrong token', async () => {
  const env = buildEnv();
  assert.equal((await worker.fetch(post(body(), null), env)).status, 401);
  assert.equal((await worker.fetch(post(body(), 'wrong'), env)).status, 401);
  assert.equal(env._map.size, 0);
});
test('POST: 405 on wrong method', async () => {
  const res = await worker.fetch(new Request(`${U}/ingest/movers-stats`), buildEnv());
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('Allow'), 'POST');
});
test('POST: 400 invalid json and invalid body', async () => {
  const env = buildEnv();
  const r1 = await worker.fetch(post(null, 'secret123', '{nope'), env);
  assert.equal(r1.status, 400);
  assert.equal((await r1.json()).error, 'invalid_json');
  const r2 = await worker.fetch(post(body({ extra: 1 })), env);
  assert.equal(r2.status, 400);
  assert.ok((await r2.json()).error);
});
test('POST: 413 over 128 KB', async () => {
  const env = buildEnv();
  const raw = JSON.stringify(body()) + ' '.repeat(128 * 1024);
  assert.equal((await worker.fetch(post(null, 'secret123', raw), env)).status, 413);
  const small = JSON.stringify(body());
  const req = new Request(`${U}/ingest/movers-stats`, {
    method: 'POST',
    headers: { Authorization: 'Bearer secret123', 'content-length': String(200 * 1024) },
    body: small,
  });
  assert.equal((await worker.fetch(req, env)).status, 413);
});

test('GET default empty, cache header, invalid method', async () => {
  const env = buildEnv();
  const res = await worker.fetch(new Request(`${U}/api/movers-stats`), env);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.schema, 'swal.movers-stats.v1');
  assert.deepEqual(j.cells, []);
  assert.equal(j.note, 'Aun no hay datos publicados.');
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=3600');
  assert.ok(res.headers.get('X-Content-Type-Options'));
  assert.equal((await worker.fetch(new Request(`${U}/api/movers-stats?method=zzz`), env)).status, 400);
  assert.equal((await worker.fetch(new Request(`${U}/api/movers-stats`, { method: 'HEAD' }), env)).status, 200);
});

test('POST then GET round trip per method', async () => {
  const env = buildEnv();
  assert.equal((await worker.fetch(post(body({ method: 'forward' })), env)).status, 204);
  assert.ok(env._map.has('movers-stats:forward'));
  const res = await worker.fetch(new Request(`${U}/api/movers-stats?method=forward`), env);
  const j = await res.json();
  assert.equal(j.method, 'forward');
  assert.equal(j.cells.length, 1);
  assert.ok(j.generated_at);
  const study = await (await worker.fetch(new Request(`${U}/api/movers-stats`), env)).json();
  assert.deepEqual(study.cells, []);
});

test('GET with throwing store returns empty default 200', async () => {
  const env = { DB: { prepare() { throw new Error('no such table'); } } };
  const res = await worker.fetch(new Request(`${U}/api/movers-stats`), env);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).cells, []);
});
