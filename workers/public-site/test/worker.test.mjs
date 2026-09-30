import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker, { sanitizeSnapshot } from '../src/worker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('sanitizeSnapshot: drops unknown and secret keys across all levels', () => {
  const dirty = {
    schema: 'synapse.public.snapshot/v1',
    generated_at: '2026-09-29T12:00:00Z',
    mode: 'paper',
    api_key: 'dummy-not-a-real-key',
    database_url: 'postgres://root:secret@localhost:5432/trading',
    private_seed: 'abandon abandon abandon',
    engine: {
      status: 'running',
      feed_ok: true,
      last_price_update_at: '2026-09-29T11:59:58Z',
      uptime_s: 1000,
      strategies_registered: 5,
      internal_ip: '192.168.1.100',
      raw_logs: 'Exception at line 42...'
    },
    account: {
      initial_capital: 100.0,
      equity_pct: 2.5,
      daily_pnl_pct: 0.5,
      max_drawdown_pct: 1.0,
      open_positions: 1,
      total_trades: 10,
      win_rate: 60.0,
      balance_usdt: 99999.50,
      secret_margin_level: 0.12,
      exchange_account_id: 'EXCH-88219'
    },
    bots: [
      {
        id: 'bot1',
        name: 'Bot 1',
        status: 'active',
        points: 50,
        api_token: 'secret_bot_token',
        private_weights: [0.1, 0.2]
      }
    ],
    open_positions: [
      {
        bot: 'bot1',
        symbol: 'BTCUSDT',
        side: 'long',
        entry_price: 60000,
        upnl_pct: 1.5,
        opened_at: '2026-09-29T11:00:00Z',
        order_id: 'ORDER-123456',
        position_size_usd: 50000
      }
    ],
    recent_trades: [
      {
        bot: 'bot1',
        symbol: 'BTCUSDT',
        side: 'long',
        entry_price: 59000,
        exit_price: 60000,
        pnl_pct: 1.69,
        exit_reason: 'TP',
        opened_at: '2026-09-29T10:00:00Z',
        closed_at: '2026-09-29T11:00:00Z',
        fill_id: 'FILL-999',
        fee_paid_usd: 2.50
      }
    ],
    equity_curve: [
      { t: '2026-09-29T00:00:00Z', equity_pct: 0.0, internal_tick: 1 }
    ]
  };

  const clean = sanitizeSnapshot(dirty);

  // Top-level secrets stripped
  assert.equal(clean.api_key, undefined);
  assert.equal(clean.database_url, undefined);
  assert.equal(clean.private_seed, undefined);

  // Engine secrets stripped
  assert.equal(clean.engine.internal_ip, undefined);
  assert.equal(clean.engine.raw_logs, undefined);
  assert.equal(clean.engine.status, 'running');
  assert.equal(clean.engine.feed_ok, true);

  // Account secrets stripped
  assert.equal(clean.account.balance_usdt, undefined);
  assert.equal(clean.account.secret_margin_level, undefined);
  assert.equal(clean.account.exchange_account_id, undefined);
  assert.equal(clean.account.initial_capital, 100.0);
  assert.equal(clean.account.equity_pct, 2.5);

  // Bot secrets stripped
  assert.equal(clean.bots[0].api_token, undefined);
  assert.equal(clean.bots[0].private_weights, undefined);
  assert.equal(clean.bots[0].id, 'bot1');

  // Open position secrets stripped
  assert.equal(clean.open_positions[0].order_id, undefined);
  assert.equal(clean.open_positions[0].position_size_usd, undefined);
  assert.equal(clean.open_positions[0].symbol, 'BTCUSDT');

  // Recent trade secrets stripped
  assert.equal(clean.recent_trades[0].fill_id, undefined);
  assert.equal(clean.recent_trades[0].fee_paid_usd, undefined);
  assert.equal(clean.recent_trades[0].symbol, 'BTCUSDT');

  // Equity curve extra keys stripped
  assert.equal(clean.equity_curve[0].internal_tick, undefined);
  assert.equal(clean.equity_curve[0].equity_pct, 0.0);
});

test('sanitizeSnapshot: caps arrays (bots 100, open_positions 100, recent_trades 50, equity_curve 500)', () => {
  const bigSnapshot = {
    schema: 'synapse.public.snapshot/v1',
    generated_at: '2026-09-29T12:00:00Z',
    mode: 'paper',
    engine: {},
    account: {},
    bots: Array.from({ length: 150 }, (_, i) => ({ id: `bot_${i}`, points: i })),
    open_positions: Array.from({ length: 150 }, (_, i) => ({ bot: `bot_${i}`, symbol: 'SOLUSDT', side: 'long' })),
    recent_trades: Array.from({ length: 80 }, (_, i) => ({ bot: `bot_${i}`, symbol: 'ETHUSDT' })),
    equity_curve: Array.from({ length: 600 }, (_, i) => ({ t: '2026-09-29T12:00:00Z', equity_pct: i * 0.1 }))
  };

  const clean = sanitizeSnapshot(bigSnapshot);
  assert.equal(clean.bots.length, 100);
  assert.equal(clean.open_positions.length, 100);
  assert.equal(clean.recent_trades.length, 50);
  assert.equal(clean.equity_curve.length, 500);
});

test('sanitizeSnapshot: nulls initial_capital when mode is live or testnet, preserves on paper', () => {
  const base = {
    schema: 'synapse.public.snapshot/v1',
    generated_at: '2026-09-29T12:00:00Z',
    account: { initial_capital: 50000.0, equity_pct: 12.3 }
  };

  // mode = live
  const liveClean = sanitizeSnapshot({ ...base, mode: 'live' });
  assert.equal(liveClean.mode, 'live');
  assert.equal(liveClean.account.initial_capital, null);
  assert.equal(liveClean.account.equity_pct, 12.3);

  // mode = testnet
  const testnetClean = sanitizeSnapshot({ ...base, mode: 'testnet' });
  assert.equal(testnetClean.mode, 'testnet');
  assert.equal(testnetClean.account.initial_capital, null);

  // mode = paper
  const paperClean = sanitizeSnapshot({ ...base, mode: 'paper' });
  assert.equal(paperClean.mode, 'paper');
  assert.equal(paperClean.account.initial_capital, 50000.0);
});

test('sanitizeSnapshot: rejects wrong schema or non-object snapshot', () => {
  const invalidSchema = {
    schema: 'synapse.wrong.snapshot/v99',
    generated_at: '2026-09-29T12:00:00Z'
  };
  assert.throws(() => sanitizeSnapshot(invalidSchema), /Invalid schema/);

  const missingSchema = {
    generated_at: '2026-09-29T12:00:00Z'
  };
  assert.throws(() => sanitizeSnapshot(missingSchema), /Invalid schema/);

  assert.throws(() => sanitizeSnapshot(null), /Invalid snapshot/);
  assert.throws(() => sanitizeSnapshot([]), /Invalid snapshot/);
  assert.throws(() => sanitizeSnapshot('not-an-object'), /Invalid snapshot/);
});

test('sanitizeSnapshot: rejects unparseable or missing generated_at', () => {
  const badDate = {
    schema: 'synapse.public.snapshot/v1',
    generated_at: 'not-a-valid-date'
  };
  assert.throws(() => sanitizeSnapshot(badDate), /generated_at/);

  const missingDate = {
    schema: 'synapse.public.snapshot/v1'
  };
  assert.throws(() => sanitizeSnapshot(missingDate), /generated_at/);
});

test('worker.fetch: enforces security headers on all responses', async () => {
  const req = new Request('http://trade.swal.network/public/v1/snapshot');
  const res = await worker.fetch(req, { SNAPSHOTS: { get: async () => null } });

  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(res.headers.get('Content-Security-Policy'), /default-src 'self'/);
});

test('worker.fetch: GET /public/v1/snapshot returns 503 if no snapshot in KV, 200 with headers if present', async () => {
  // 1. Missing snapshot -> 503
  const req1 = new Request('http://trade.swal.network/public/v1/snapshot');
  const res1 = await worker.fetch(req1, { SNAPSHOTS: { get: async () => null } });
  assert.equal(res1.status, 503);
  const body1 = await res1.json();
  assert.equal(body1.error, 'no_snapshot');

  // 2. Present snapshot -> 200
  const mockSnapshot = JSON.stringify({
    schema: 'synapse.public.snapshot/v1',
    generated_at: new Date(Date.now() - 15000).toISOString(),
    mode: 'paper'
  });
  const res2 = await worker.fetch(req1, { SNAPSHOTS: { get: async (k) => (k === 'latest' ? mockSnapshot : null) } });
  assert.equal(res2.status, 200);
  assert.equal(res2.headers.get('Cache-Control'), 'public, max-age=30');
  assert.equal(res2.headers.get('Content-Type'), 'application/json; charset=utf-8');
  const age = parseInt(res2.headers.get('X-Snapshot-Age-S'), 10);
  assert.ok(age >= 10 && age <= 30);
});

test('worker.fetch: POST /ingest authenticates, sanitizes, and writes to KV and history', async () => {
  const mockKV = new Map();
  const env = {
    PUBLIC_INGEST_TOKEN: 'super-secret-token-12345',
    SNAPSHOTS: {
      get: async (k) => mockKV.get(k) || null,
      put: async (k, v, opts) => mockKV.set(k, { val: v, opts })
    }
  };

  // Wrong token -> 401 with no detail
  const wrongReq = new Request('http://trade.swal.network/ingest', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer wrong-token' },
    body: JSON.stringify({ schema: 'synapse.public.snapshot/v1' })
  });
  const wrongRes = await worker.fetch(wrongReq, env);
  assert.equal(wrongRes.status, 401);

  // Method not allowed for GET /ingest -> 405
  const getReq = new Request('http://trade.swal.network/ingest', { method: 'GET' });
  const getRes = await worker.fetch(getReq, env);
  assert.equal(getRes.status, 405);

  // Valid ingest
  const validSnapshot = {
    schema: 'synapse.public.snapshot/v1',
    generated_at: '2026-09-29T12:00:00Z',
    mode: 'paper',
    api_key: 'should-be-stripped',
    engine: { status: 'running', feed_ok: true },
    account: { initial_capital: 100.0, equity_pct: 1.0 },
    bots: [],
    open_positions: [],
    recent_trades: [],
    equity_curve: []
  };

  const goodReq = new Request('http://trade.swal.network/ingest', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer super-secret-token-12345',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(validSnapshot)
  });

  const goodRes = await worker.fetch(goodReq, env);
  assert.equal(goodRes.status, 204);

  // Verify KV storage
  assert.ok(mockKV.has('latest'));
  const storedLatest = JSON.parse(mockKV.get('latest').val);
  assert.equal(storedLatest.schema, 'synapse.public.snapshot/v1');
  assert.equal(storedLatest.api_key, undefined);

  // Verify history key (history:2026-09-29)
  assert.ok(mockKV.has('history:2026-09-29'));
  assert.equal(mockKV.get('history:2026-09-29').opts.expirationTtl, 90 * 86400);
});

test('honest sample-snapshot fixture: passes sanitizeSnapshot and asserts no bot has fidelity "verified"', () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'sample-snapshot.json');
  const rawText = fs.readFileSync(fixturePath, 'utf8');
  const raw = JSON.parse(rawText);

  const clean = sanitizeSnapshot(raw);
  assert.equal(clean.mode, 'paper');
  assert.ok(Array.isArray(clean.bots));
  assert.ok(clean.bots.length > 0);
  for (const bot of clean.bots) {
    assert.notEqual(bot.fidelity, 'verified', `Bot ${bot.id} must not have fidelity "verified"`);
  }
});
