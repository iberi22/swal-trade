import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  directionsConflict,
  explainFallback,
  explainRequestBody,
  explainTimeoutMs,
  explainToolResult,
  explainUrl,
  fetchHostedExplanation,
  EXPLAIN_DISCLAIMER,
  EXPLAIN_URL_DEFAULT,
} from '../dist/explain.js';
import { ANALYSIS_CORE_MISSING } from '../dist/core.js';
import { callOrCatch, jsonResponse, textOf, withClient } from './helpers.mjs';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const CORE = fixture('explain-core.js');
const HOSTED = 'https://trade.swal.network/api/explain';

function kline() {
  return [1_700_000_000_000, '10', '12', '9', '11', '100', 0, '0', 0, '0', '0', '0'];
}

const hostedBody = {
  source: 'ai',
  model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  symbol: 'BTCUSDT',
  timeframe: '15m',
  asOf: '2026-10-10T12:00:00.000Z',
  summary: 'El gráfico muestra un doble suelo en formación y una resistencia por encima.',
  scenarios: [
    {
      name: 'Doble suelo',
      condition: 'El precio cierra por encima de 106,58 y lo mantiene.',
      invalidation: 'El precio cierra por debajo de 98,74.',
      risk_note: 'Stop por debajo del nivel de invalidación y tamaño pequeño; apalancamiento 1x.',
    },
  ],
  caution: 'La fuerza del patrón no es una probabilidad y la tasa de acierto histórica no está medida.',
  disclaimer: EXPLAIN_DISCLAIMER,
};

test('explainUrl: https obligatorio, vacío desactiva y el defecto es el hosting', () => {
  assert.equal(explainUrl({}), EXPLAIN_URL_DEFAULT);
  assert.equal(explainUrl({ SWAL_EXPLAIN_URL: '' }), null);
  assert.equal(explainUrl({ SWAL_EXPLAIN_URL: 'http://inseguro.example/api/explain' }), null);
  assert.equal(explainUrl({ SWAL_EXPLAIN_URL: 'no-es-url' }), null);
  assert.equal(explainUrl({ SWAL_EXPLAIN_URL: 'https://otro.example/api/explain' }), 'https://otro.example/api/explain');
  assert.equal(explainTimeoutMs({}), 20000);
  assert.equal(explainTimeoutMs({ SWAL_EXPLAIN_TIMEOUT_MS: '5000' }), 5000);
  assert.equal(explainTimeoutMs({ SWAL_EXPLAIN_TIMEOUT_MS: '-1' }), 20000);
});

test('explainFallback: describe los hallazgos con sus niveles y avisa del conflicto', () => {
  const body = explainRequestBody(
    {
      top: [
        { label: 'Doble suelo', direction: 'up', strength: 0.7985, levels: [{ confirm: 106.58, invalidate: 98.74 }] },
        { label: 'Zona de resistencia', direction: 'down', strength: 0.61, levels: [{ confirm: 110, invalidate: 105 }] },
      ],
      trend: { direction: 'up', strength: 0.4, label: 'Alcista' },
      levels: [],
    },
    'BTCUSDT',
    '15m',
  );
  const fallback = explainFallback(body.analysis, 'BTCUSDT', '15m', 'prueba');
  assert.equal(fallback.source, 'fallback');
  assert.equal(fallback.scenarios.length, 2);
  assert.match(fallback.summary, /Doble suelo \(fuerza 80\/100\)/);
  assert.match(fallback.summary, /no señalan todos en la misma dirección/);
  assert.match(fallback.scenarios[0].condition, /por encima de 106\.58/);
  assert.match(fallback.scenarios[0].invalidation, /por debajo de 98\.74/);
  assert.match(fallback.scenarios[0].risk_note, /stop/);
  assert.match(fallback.scenarios[1].condition, /por debajo de 110/);
  assert.match(fallback.caution, /no es una probabilidad/);
  assert.equal(fallback.summary.includes('garantiz'), false);

  const vacio = explainFallback({ top: [], trend: null, levels: [] }, 'SOLUSDT', '4h', 'prueba');
  assert.match(vacio.summary, /no ve patrones claros/);
  assert.deepEqual(vacio.scenarios, []);
  assert.equal(directionsConflict([{ direction: 'up' }, { direction: 'down' }]), true);
  assert.equal(directionsConflict([{ direction: 'up' }]), false);
});

test('explainRequestBody: topa a 20 hallazgos y descarta niveles que no son objetos', () => {
  const body = explainRequestBody(
    {
      top: new Array(25).fill(null).map((_, index) => ({
        id: `f${index}`,
        label: `Patrón ${index}`,
        direction: 'lateral',
        strength: 5,
        status: 'raro',
        explanation: 'x'.repeat(900),
        levels: new Array(20).fill({ price: 1, confirm: 1, invalidate: 2 }),
      })),
      trend: { direction: 'up', strength: 1, label: 'Alcista' },
      levels: [1, 'texto', { price: 3 }],
    },
    'BTCUSDT',
    '15m',
  );
  assert.equal(body.analysis.top.length, 20);
  assert.equal(body.analysis.top[0].levels.length, 8);
  assert.equal(body.analysis.top[0].direction, 'neutral');
  assert.equal(body.analysis.top[0].strength, 1);
  assert.equal(body.analysis.top[0].status, 'forming');
  assert.ok(body.analysis.top[0].explanation.length <= 400);
  assert.deepEqual(body.analysis.levels, [{ price: 3 }]);
});

test('fetchHostedExplanation: 200 válido, http error y red caída', async () => {
  const ok = await fetchHostedExplanation(HOSTED, explainRequestBody({}, 'BTCUSDT', '15m'), async () => jsonResponse(hostedBody), 1000);
  assert.equal(ok.ok, true);
  assert.equal(ok.payload?.summary, hostedBody.summary);
  assert.equal(ok.payload?.source, 'ai');

  const http = await fetchHostedExplanation(HOSTED, {}, async () => jsonResponse({ error: 'x' }, 429), 1000);
  assert.equal(http.ok, false);
  assert.match(http.error ?? '', /http 429/);

  const red = await fetchHostedExplanation(HOSTED, {}, async () => {
    throw new Error('sin red');
  }, 1000);
  assert.equal(red.ok, false);
  assert.match(red.error ?? '', /sin red/);

  const vacio = await fetchHostedExplanation(HOSTED, {}, async () => jsonResponse({ error: 'x' }), 1000);
  assert.equal(vacio.ok, false);
  assert.match(vacio.error ?? '', /payload invalido/);
});

test('explainToolResult: forma estable del resultado', () => {
  const result = explainToolResult({
    symbol: 'BTCUSDT',
    timeframe: '15m',
    payload: { source: 'ai', summary: 's', scenarios: [], caution: 'c' },
    model: 'modelo',
    hosted: true,
    note: 'nota de prueba',
  });
  assert.equal(result.readOnly, true);
  assert.equal(result.symbol, 'BTCUSDT');
  assert.equal(result.source, 'ai');
  assert.equal(result.disclaimer, EXPLAIN_DISCLAIMER);
  assert.equal(result.note, 'nota de prueba');
});

test('tool: explain_analysis pide velas y manda el análisis al hosting', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), method: String(init?.method ?? 'GET'), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (String(url).includes('/fapi/v1/klines')) return jsonResponse([kline()]);
    return jsonResponse(hostedBody);
  };
  await withClient({ env: { SWAL_ANALYSIS_CORE: CORE }, fetchFn }, async (client) => {
    const result = JSON.parse(textOf(await client.callTool({ name: 'explain_analysis', arguments: { symbol: 'BTCUSDT', timeframe: '15m' } })));
    assert.equal(result.hosted, true);
    assert.equal(result.source, 'ai');
    assert.equal(result.model, hostedBody.model);
    assert.equal(result.symbol, 'BTCUSDT');
    assert.equal(result.timeframe, '15m');
    assert.equal(result.scenarios.length, 1);
    assert.equal(result.scenarios[0].name, 'Doble suelo');
    assert.match(result.caution, /no es una probabilidad/);
    assert.match(result.disclaimer, /no es asesoría financiera/i);
    assert.equal(result.note, null);
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].url, HOSTED);
  assert.equal(calls[1].method, 'POST');
  const sent = calls[1].body;
  assert.equal(sent.symbol, 'BTCUSDT');
  assert.equal(sent.timeframe, '15m');
  assert.deepEqual(sent.analysis.top.map((finding) => finding.label), ['Doble suelo', 'Zona de resistencia']);
  assert.equal(sent.analysis.top[0].levels[0].confirm, 106.58);
  assert.equal(sent.analysis.trend.label, 'Alcista');
});

test('tool: sin SWAL_EXPLAIN_URL devuelve el respaldo y no llama a la red', async () => {
  let calls = 0;
  const fetchFn = async (url) => {
    calls += 1;
    if (String(url).includes('/fapi/v1/klines')) return jsonResponse([kline()]);
    throw new Error('no debería llamar al hosting');
  };
  await withClient({ env: { SWAL_ANALYSIS_CORE: CORE, SWAL_EXPLAIN_URL: '' }, fetchFn }, async (client) => {
    const result = JSON.parse(textOf(await client.callTool({ name: 'explain_analysis', arguments: { symbol: 'BTCUSDT', timeframe: '15m' } })));
    assert.equal(result.hosted, false);
    assert.equal(result.source, 'fallback');
    assert.equal(result.model, null);
    assert.equal(result.scenarios.length, 2);
    assert.match(result.summary, /Doble suelo/);
    assert.match(result.scenarios[0].condition, /106\.58/);
    assert.match(result.note, /SWAL_EXPLAIN_URL vacío/);
  });
  assert.equal(calls, 1);
});

test('tool: hosting caído o con error devuelve el respaldo con el motivo', async () => {
  for (const [label, fetchImpl] of [
    ['http', async () => jsonResponse({ error: 'rate_limited' }, 429)],
    ['red', async () => { throw new Error('sin red'); }],
    ['vacío', async () => jsonResponse({ source: 'ai' })],
  ]) {
    const fetchFn = async (url) => (String(url).includes('/fapi/v1/klines') ? jsonResponse([kline()]) : fetchImpl());
    await withClient({ env: { SWAL_ANALYSIS_CORE: CORE }, fetchFn }, async (client) => {
      const result = JSON.parse(textOf(await client.callTool({ name: 'explain_analysis', arguments: { symbol: 'ETHUSDT', timeframe: '1h' } })));
      assert.equal(result.hosted, false, label);
      assert.equal(result.source, 'fallback', label);
      assert.match(result.note, /no respondió/, label);
      assert.match(result.summary, /ETHUSDT/, label);
      assert.equal(result.readOnly, true);
    });
  }
});

test('tool: rechaza símbolo y temporalidad inválidos y un núcleo ausente', async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    throw new Error('should not fetch');
  };
  await withClient({ env: { SWAL_ANALYSIS_CORE: CORE }, fetchFn }, async (client) => {
    assert.equal((await callOrCatch(client, 'explain_analysis', { symbol: 'BTCUSDT', timeframe: '2m' })).isError, true);
    assert.equal((await callOrCatch(client, 'explain_analysis', { symbol: 'x', timeframe: '1h' })).isError, true);
    assert.equal((await callOrCatch(client, 'explain_analysis', { timeframe: '1h' })).isError, true);
  });
  assert.equal(calls, 0);
  await withClient({ env: { SWAL_ANALYSIS_CORE: fixture('does-not-exist.js') }, fetchFn }, async (client) => {
    assert.equal(errorTextOf(await callOrCatch(client, 'explain_analysis', { symbol: 'BTCUSDT', timeframe: '1h' })), ANALYSIS_CORE_MISSING);
  });
});

function errorTextOf(result) {
  const block = result.content.find((item) => item.type === 'text');
  return block && 'text' in block ? block.text : '';
}
