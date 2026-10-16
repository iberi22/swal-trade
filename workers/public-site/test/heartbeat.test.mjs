import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { checkHeartbeats, handleHeartbeatRequest, heartbeatNames } from '../src/worker.js';

// D1 falso: implementa solo las tres sentencias del latido, con la misma semántica que SQLite.
function fakeD1() {
  const rows = new Map();
  let writes = 0;
  return {
    rows,
    get writes() { return writes; },
    prepare(sql) {
      const stmt = (args) => ({
        async run() {
          if (/^INSERT INTO heartbeats/.test(sql)) {
            const [name, now, minS] = args;
            const r = rows.get(name);
            if (!r) { rows.set(name, { name, last_seen: now, state: 'ok' }); writes += 1; }
            else if (r.last_seen <= now - minS) { r.last_seen = now; writes += 1; }
            return;
          }
          if (/^UPDATE heartbeats SET state/.test(sql)) {
            const [state, name] = args;
            rows.get(name).state = state;
            writes += 1;
            return;
          }
          throw new Error(`sentencia inesperada: ${sql}`);
        },
        async all() {
          assert.match(sql, /^SELECT name, last_seen, state FROM heartbeats$/);
          return { results: [...rows.values()].map((r) => ({ ...r })) };
        },
      });
      return { bind: (...args) => stmt(args), all: () => stmt([]).all() };
    },
  };
}

const TOKEN = 'latido-de-prueba';
const ping = (name, { token = TOKEN, method = 'POST' } = {}) =>
  new Request(`https://trade.swal.network/heartbeat/${name}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

test('heartbeatNames: default guardian,radar; drops invalid names', () => {
  assert.deepEqual([...heartbeatNames({})], ['guardian', 'radar']);
  assert.deepEqual([...heartbeatNames({ HEARTBEAT_NAMES: ' Guardian , ../x, bot-2 ' })], ['guardian', 'bot-2']);
});

test('heartbeat: rejects wrong method, missing or wrong token, unknown name', async () => {
  const env = { DB: fakeD1(), HEARTBEAT_TOKEN: TOKEN };
  assert.equal((await handleHeartbeatRequest(ping('guardian', { method: 'GET' }), env, 'guardian')).status, 405);
  assert.equal((await handleHeartbeatRequest(ping('guardian', { token: '' }), env, 'guardian')).status, 401);
  assert.equal((await handleHeartbeatRequest(ping('guardian', { token: 'otro' }), env, 'guardian')).status, 401);
  assert.equal((await handleHeartbeatRequest(ping('otro'), env, 'otro')).status, 404);
  // Sin secret configurado nadie puede latir.
  assert.equal((await handleHeartbeatRequest(ping('guardian'), { DB: env.DB }, 'guardian')).status, 401);
  assert.equal(env.DB.writes, 0);
});

test('heartbeat: writes at most once per 60 s per name', async () => {
  const DB = fakeD1();
  const env = { DB, HEARTBEAT_TOKEN: TOKEN };
  const t0 = Date.parse('2026-10-16T12:00:00Z');
  for (const dt of [0, 15, 30, 45]) {
    assert.equal((await handleHeartbeatRequest(ping('guardian'), env, 'guardian', t0 + dt * 1000)).status, 204);
  }
  assert.equal(DB.writes, 1);
  await handleHeartbeatRequest(ping('guardian'), env, 'guardian', t0 + 60_000);
  assert.equal(DB.writes, 2);
  assert.equal(DB.rows.get('guardian').last_seen, t0 / 1000 + 60);
});

test('heartbeat: routed through fetch with security headers; token in the URL is not accepted', async () => {
  const env = { DB: fakeD1(), HEARTBEAT_TOKEN: TOKEN };
  const ok = await worker.fetch(ping('radar'), env);
  assert.equal(ok.status, 204);
  assert.ok(ok.headers.get('Content-Security-Policy'));
  const viaQuery = await worker.fetch(
    new Request(`https://trade.swal.network/heartbeat/radar?t=${TOKEN}`, { method: 'POST' }), env);
  assert.equal(viaQuery.status, 401);
});

test('checkHeartbeats: one plain-text alert when silent, one on recovery, retries if Telegram fails', async () => {
  const DB = fakeD1();
  const calls = [];
  let telegramOk = true;
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: telegramOk, status: telegramOk ? 200 : 500 };
  };
  const env = { DB, HEARTBEAT_TOKEN: TOKEN, TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '42' };
  const t0 = Date.parse('2026-10-16T12:00:00Z');
  await handleHeartbeatRequest(ping('guardian'), env, 'guardian', t0);
  await handleHeartbeatRequest(ping('radar'), env, 'radar', t0);

  // Dentro del umbral (600 s): nada.
  let r = await checkHeartbeats(env, t0 + 300_000, fetchImpl);
  assert.deepEqual(r.map((x) => x.alert), [null, null]);
  assert.equal(calls.length, 0);

  // El radar sigue latiendo; el guardián se calla 11 min. Telegram falla: sin cambio de estado.
  await handleHeartbeatRequest(ping('radar'), env, 'radar', t0 + 600_000);
  telegramOk = false;
  r = await checkHeartbeats(env, t0 + 660_000, fetchImpl);
  assert.deepEqual(r.find((x) => x.name === 'guardian'), { name: 'guardian', state: 'stale', alert: 'stale', sent: false });
  assert.equal(DB.rows.get('guardian').state, 'ok');

  // Telegram vuelve: un solo aviso, en texto plano.
  telegramOk = true;
  r = await checkHeartbeats(env, t0 + 960_000, fetchImpl);
  assert.equal(calls.length, 2);
  assert.match(calls[1].text, /^GUARDIAN SIN LATIDO: ultimo hace 16 min \(umbral 10 min\)/);
  assert.equal(calls[1].parse_mode, undefined);
  assert.equal(calls[1].chat_id, '42');
  assert.equal(DB.rows.get('guardian').state, 'stale');
  assert.equal(r.find((x) => x.name === 'radar').alert, null);

  // Sigue callado (el radar sí late): sin nuevo aviso.
  await handleHeartbeatRequest(ping('radar'), env, 'radar', t0 + 1_200_000);
  await checkHeartbeats(env, t0 + 1_260_000, fetchImpl);
  assert.equal(calls.length, 2);

  // Vuelve a latir: aviso de recuperación.
  await handleHeartbeatRequest(ping('guardian'), env, 'guardian', t0 + 1_300_000);
  r = await checkHeartbeats(env, t0 + 1_320_000, fetchImpl);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].text, 'GUARDIAN recuperado: vuelve a latir.');
  assert.equal(DB.rows.get('guardian').state, 'ok');
});

test('checkHeartbeats: ignores names outside the allowlist and returns null without D1', async () => {
  const DB = fakeD1();
  DB.rows.set('viejo', { name: 'viejo', last_seen: 0, state: 'ok' });
  const calls = [];
  const env = { DB, TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '42' };
  assert.deepEqual(await checkHeartbeats(env, Date.now(), async () => { calls.push(1); return { ok: true }; }), []);
  assert.equal(calls.length, 0);
  assert.equal(await checkHeartbeats({}, Date.now()), null);
});
