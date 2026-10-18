import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSnapshot } from '../src/worker.js';

test('sanitizeSnapshot: strips research_verdict from bot objects', () => {
  const dirty = {
    schema: 'synapse.public.snapshot/v1',
    generated_at: '2026-09-29T12:00:00Z',
    mode: 'paper',
    engine: {},
    account: {},
    bots: [
      {
        id: 'bot1',
        research_verdict: 'x',
        points: 10
      }
    ]
  };

  const clean = sanitizeSnapshot(dirty);
  assert.ok(!('research_verdict' in clean.bots[0]), 'research_verdict should be stripped');
});

test('sanitizeSnapshot: age filter drops position opened < 15 min ago, keeps one 20 min ago (default)', () => {
  const genAt = new Date('2026-09-29T12:00:00Z').getTime(); // 12:00:00
  const dirty = {
    schema: 'synapse.public.snapshot/v1',
    generated_at: '2026-09-29T12:00:00Z',
    mode: 'paper',
    engine: {},
    account: { open_positions: 2 },
    open_positions: [
      { bot: 'bot1', symbol: 'BTCUSDT', opened_at: new Date(genAt - 5 * 60000).toISOString() }, // 5 min ago
      { bot: 'bot2', symbol: 'ETHUSDT', opened_at: new Date(genAt - 20 * 60000).toISOString() } // 20 min ago
    ]
  };

  const clean = sanitizeSnapshot(dirty); // default env => 15 mins
  assert.equal(clean.open_positions.length, 1);
  assert.equal(clean.open_positions[0].bot, 'bot2');
  assert.equal(clean.account.open_positions, 1);
});

test('sanitizeSnapshot: age filter drops positions with invalid opened_at', () => {
  const genAt = new Date('2026-09-29T12:00:00Z').getTime();
  const dirty = {
    schema: 'synapse.public.snapshot/v1',
    generated_at: '2026-09-29T12:00:00Z',
    mode: 'paper',
    engine: {},
    account: { open_positions: 3 },
    open_positions: [
      { bot: 'bot1', symbol: 'BTCUSDT', opened_at: 'invalid-date' },
      { bot: 'bot2', symbol: 'BTCUSDT' }, // missing opened_at
      { bot: 'bot3', symbol: 'ETHUSDT', opened_at: new Date(genAt - 20 * 60000).toISOString() }
    ]
  };

  const clean = sanitizeSnapshot(dirty);
  assert.equal(clean.open_positions.length, 1);
  assert.equal(clean.open_positions[0].bot, 'bot3');
  assert.equal(clean.account.open_positions, 1);
});

test('sanitizeSnapshot: env var PUBLIC_POSITIONS_MIN_AGE_MIN parses properly (0, abc, 9999)', () => {
  const genAt = new Date('2026-09-29T12:00:00Z').getTime();
  const pos1min = new Date(genAt - 1 * 60000).toISOString();
  const pos10min = new Date(genAt - 10 * 60000).toISOString();
  const pos20min = new Date(genAt - 20 * 60000).toISOString();
  const pos300min = new Date(genAt - 300 * 60000).toISOString();

  const createDirty = () => ({
    schema: 'synapse.public.snapshot/v1',
    generated_at: '2026-09-29T12:00:00Z',
    mode: 'paper',
    engine: {},
    account: { open_positions: 4 },
    open_positions: [
      { bot: 'b1', symbol: 'A', opened_at: pos1min },
      { bot: 'b2', symbol: 'B', opened_at: pos10min },
      { bot: 'b3', symbol: 'C', opened_at: pos20min },
      { bot: 'b4', symbol: 'D', opened_at: pos300min }
    ]
  });

  // '0' keeps everything
  const clean0 = sanitizeSnapshot(createDirty(), { PUBLIC_POSITIONS_MIN_AGE_MIN: '0' });
  assert.equal(clean0.open_positions.length, 4);

  // 'abc' defaults to 15, drops 1min and 10min
  const cleanAbc = sanitizeSnapshot(createDirty(), { PUBLIC_POSITIONS_MIN_AGE_MIN: 'abc' });
  assert.equal(cleanAbc.open_positions.length, 2);
  assert.equal(cleanAbc.open_positions[0].bot, 'b3');
  assert.equal(cleanAbc.open_positions[1].bot, 'b4');

  // '9999' clamps to 240, drops 1min, 10min, 20min
  const clean9999 = sanitizeSnapshot(createDirty(), { PUBLIC_POSITIONS_MIN_AGE_MIN: '9999' });
  assert.equal(clean9999.open_positions.length, 1);
  assert.equal(clean9999.open_positions[0].bot, 'b4');
});
