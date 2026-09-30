import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { snapshotStore } from '../src/worker.js';

// D1 falso: implementa solo las dos sentencias que usa snapshotStore.
function fakeD1() {
  const rows = new Map();
  let writes = 0;
  return {
    rows,
    get writes() { return writes; },
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              assert.match(sql, /^SELECT value FROM snapshots/);
              const [key, now] = args;
              const r = rows.get(key);
              return r && (r.expires_at === null || r.expires_at > now) ? { value: r.value } : null;
            },
            async run() {
              assert.match(sql, /^INSERT INTO snapshots/);
              const [key, value, updated_at, expires_at] = args;
              rows.set(key, { value, updated_at, expires_at });
              writes += 1;
            },
          };
        },
      };
    },
  };
}

const TOKEN = 'token-de-prueba';
const snapshot = () => ({
  schema: 'synapse.public.snapshot/v1',
  generated_at: new Date().toISOString(),
  mode: 'paper',
  engine: { status: 'running', feed_ok: true },
  account: {},
  bots: [],
  open_positions: [],
  recent_trades: [],
  equity_curve: [],
});
const ingest = (env) =>
  worker.fetch(
    new Request('https://trade.swal.network/ingest', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot()),
    }),
    env,
  );

test('D1: ingest guarda latest e historial del día, y GET lo devuelve', async () => {
  const DB = fakeD1();
  const env = { DB, PUBLIC_INGEST_TOKEN: TOKEN };
  assert.equal((await ingest(env)).status, 204);
  const day = new Date().toISOString().slice(0, 10);
  assert.ok(DB.rows.has('latest'));
  assert.ok(DB.rows.get(`history:${day}`).expires_at > Math.floor(Date.now() / 1000));
  const res = await worker.fetch(new Request('https://trade.swal.network/public/v1/snapshot'), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).schema, 'synapse.public.snapshot/v1');
});

test('D1: el historial del día se escribe una sola vez (2 escrituras la 1ª vez, 1 después)', async () => {
  const DB = fakeD1();
  const env = { DB, PUBLIC_INGEST_TOKEN: TOKEN };
  await ingest(env);
  assert.equal(DB.writes, 2);
  await ingest(env);
  assert.equal(DB.writes, 3);
});

test('D1 tiene prioridad sobre KV cuando existen los dos bindings', async () => {
  const DB = fakeD1();
  const kvWrites = [];
  const env = { DB, SNAPSHOTS: { get: async () => null, put: async (k) => kvWrites.push(k) }, PUBLIC_INGEST_TOKEN: TOKEN };
  await ingest(env);
  assert.equal(kvWrites.length, 0, 'no debe gastar escrituras de KV');
  assert.ok(DB.rows.has('latest'));
});

test('snapshotStore: sin bindings devuelve null (503 no_snapshot)', async () => {
  assert.equal(snapshotStore({}), null);
  const res = await worker.fetch(new Request('https://trade.swal.network/public/v1/snapshot'), {});
  assert.equal(res.status, 503);
});

test('D1: una fila caducada no se devuelve', async () => {
  const DB = fakeD1();
  DB.rows.set('latest', { value: '{}', updated_at: 0, expires_at: 1 });
  assert.equal(await snapshotStore({ DB }).get('latest'), null);
});
