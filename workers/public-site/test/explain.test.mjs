import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import {
  buildFallbackExplain,
  balanceJson,
  bumpDailyBudget,
  checkIpBudget,
  coerceExplainPayload,
  directionsConflict,
  explainDailyCap,
  explainMaxTokens,
  explainModel,
  explainStore,
  EXPLAIN_DAILY_CAP_DEFAULT,
  EXPLAIN_MAX_FINDINGS,
  EXPLAIN_MODEL_DEFAULT,
  handleExplainRequest,
  headlinesFor,
  parseExplainBody,
  repairExplainJson,
} from '../src/explain.js';
import {
  buildExplainUserPrompt,
  EXPLAIN_DISCLAIMER,
  EXPLAIN_JSON_SCHEMA,
  EXPLAIN_SYSTEM_PROMPT,
  findForbiddenPhrase,
} from '../src/explain-prompt.js';
import { explainButtonLabel, explainErrorText, explainRequestFrom, explainView } from '../static/analisis/explain-ui.js';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');

// Una petición válida cualquiera, reutilizada por los tests.
function body(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    timeframe: '15m',
    analysis: {
      top: [
        {
          id: 'double_bottom:1:2',
          kind: 'double_bottom',
          label: 'Doble suelo',
          explanation: 'Doble suelo en 98.850 y 98.740, con cuello en 106.6.',
          direction: 'up',
          strength: 0.7985,
          status: 'forming',
          from: 1700153000,
          to: 1700269100,
          levels: [{ role: 'neckline', price: 106.58, confirm: 106.58, invalidate: 98.74 }],
        },
      ],
      trend: { direction: 'up', strength: 0.42, label: 'Alcista' },
      levels: [{ role: 'neckline', price: 106.58, confirm: 106.58, invalidate: 98.74 }],
    },
    ...overrides,
  };
}

// IA falsa: ningún test llama a un modelo real. Graba la última petición.
function fakeAi(response, { throws = false } = {}) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      if (throws) throw new Error('ai down');
      return response;
    },
  };
}

const goodModelJson = JSON.stringify({
  summary: 'El gráfico muestra un doble suelo en formación sobre 98,7 con cuello en 106,6.',
  scenarios: [
    {
      name: 'Doble suelo',
      condition: 'El precio cierra por encima de 106,6 y lo mantiene.',
      invalidation: 'El precio cierra por debajo de 98,74.',
      risk_note: 'Stop por debajo del nivel de invalidación y tamaño pequeño; apalancamiento 1x.',
    },
  ],
  caution: 'La fuerza del patrón no es una probabilidad y no hay medición histórica.',
});

const post = (payload, env, deps = {}) =>
  handleExplainRequest(
    new Request('https://trade.swal.network/api/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    }),
    env,
    deps,
  );

// ---------- prompt ----------

test('prompt: reglas de seguridad presentes y sin promesas ni órdenes', () => {
  assert.match(EXPLAIN_SYSTEM_PROMPT, /no es asesoría financiera/);
  assert.match(EXPLAIN_SYSTEM_PROMPT, /fuerza del patrón/i);
  assert.match(EXPLAIN_SYSTEM_PROMPT, /probabilidad/);
  assert.match(EXPLAIN_SYSTEM_PROMPT, /apalancamiento de 1x/);
  assert.match(EXPLAIN_SYSTEM_PROMPT, /stop/);
  assert.match(EXPLAIN_SYSTEM_PROMPT, /tasa de acierto histórico no está medida/);
  assert.match(EXPLAIN_SYSTEM_PROMPT, /se contradicen/);
  // Nada de promesas ni órdenes de entrada/salida en el texto del prompt.
  assert.doesNotMatch(EXPLAIN_SYSTEM_PROMPT, /garantiz/i);
  assert.doesNotMatch(EXPLAIN_SYSTEM_PROMPT, /compra (ya|ahora)|vende (ya|ahora)|entra ya|sal ya/i);
  assert.equal(findForbiddenPhrase(EXPLAIN_SYSTEM_PROMPT), null);
  assert.doesNotMatch(EXPLAIN_DISCLAIMER, /garantiz/i);
  assert.match(EXPLAIN_DISCLAIMER, /no es asesoría financiera/i);
});

test('prompt: el esquema JSON del modelo es el contrato público', () => {
  assert.equal(EXPLAIN_JSON_SCHEMA.type, 'object');
  assert.deepEqual(EXPLAIN_JSON_SCHEMA.required, ['summary', 'scenarios', 'caution']);
  assert.deepEqual(EXPLAIN_JSON_SCHEMA.properties.scenarios.items.required, ['name', 'condition', 'invalidation', 'risk_note']);
});

test('prompt: el mensaje de usuario lleva los niveles y ningún precio inventado', () => {
  const text = buildExplainUserPrompt({
    symbol: 'BTCUSDT',
    timeframe: '15m',
    analysis: body().analysis,
    headlines: [{ title: 'Bitcoin roza máximos', source: 'Ejemplo', sentiment: { label: 'positivo' } }],
  });
  assert.match(text, /Símbolo: BTCUSDT\. Temporalidad: 15m\./);
  assert.match(text, /Doble suelo — fuerza 80\/100/);
  assert.match(text, /Nivel de confirmación: cierre por encima de 106\.58/);
  assert.match(text, /Nivel de invalidación: cierre por debajo de 98\.74/);
  assert.match(text, /Bitcoin roza máximos/);
  assert.match(text, /la fuerza del patrón no es una probabilidad/);
});

test('prompt: sin patrones y sin titulares no se inventa nada', () => {
  const text = buildExplainUserPrompt({ symbol: 'ETHUSDT', timeframe: '1h', analysis: { top: [], trend: null, levels: [] } });
  assert.match(text, /No hay patrones claros/);
  assert.match(text, /Sin titulares recientes: no inventes ninguno/);
});

// ---------- validación ----------

test('validación: símbolo, temporalidad, análisis y topes', () => {
  assert.equal(parseExplainBody(body()).ok, true);
  assert.equal(parseExplainBody({ ...body(), symbol: 'btcusdt' }).value.symbol, 'BTCUSDT');
  for (const bad of [
    { ...body(), symbol: 'X' },
    { ...body(), symbol: 'verylongsymbolnamethatexceedslimit' },
    { ...body(), timeframe: '2m' },
    { ...body(), analysis: null },
    { ...body(), analysis: { top: 'nope' } },
    { ...body(), analysis: { levels: {} } },
    null,
    'string',
  ]) {
    assert.equal(parseExplainBody(bad).ok, false, JSON.stringify(bad).slice(0, 60));
  }
  const many = body({ analysis: { top: new Array(EXPLAIN_MAX_FINDINGS + 1).fill({ label: 'zona', direction: 'neutral', strength: 0.1, levels: [] }) } });
  assert.equal(parseExplainBody(many).ok, false);
  assert.equal(parseExplainBody(many).error, 'too_many_findings');
});

test('validación: 20 hallazgos caben y se sanenan campos basura', () => {
  const raw = body({
    analysis: {
      top: new Array(EXPLAIN_MAX_FINDINGS).fill(null).map((_, index) => ({
        label: `Patrón ${index} <script>`,
        direction: 'lateral',
        strength: 12,
        status: 'otra cosa',
        explanation: 'x'.repeat(900),
        levels: new Array(30).fill({ price: 1, confirm: Number.NaN, secret: 'no' }),
        extra: { deep: 'se descarta' },
      })),
      trend: { direction: 'up', strength: 1, label: 'Alcista', evidence: { secret: 1 } },
      levels: [],
    },
  });
  const parsed = parseExplainBody(raw);
  assert.equal(parsed.ok, true);
  const finding = parsed.value.analysis.top[0];
  assert.equal(finding.label, `Patrón 0 <script>`); // el HTML lo escapa la UI, no el worker
  assert.equal(finding.direction, 'neutral');
  assert.equal(finding.strength, 1);
  assert.equal(finding.status, 'forming');
  assert.ok(finding.explanation.length <= 400);
  assert.equal(finding.levels.length, 8);
  assert.equal('extra' in finding, false);
  assert.equal('secret' in finding.levels[0], false);
  assert.equal(parsed.value.analysis.trend.evidence, undefined);
});

test('endpoint: método, JSON inválido y cuerpo grande', async () => {
  const env = { AI: fakeAi({ response: goodModelJson }) };
  const get = await handleExplainRequest(new Request('https://trade.swal.network/api/explain'), env);
  assert.equal(get.status, 405);

  const bad = await post('{no json', env);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'invalid_json');

  const huge = await post(JSON.stringify({ ...body(), extra: 'x'.repeat(40 * 1024) }), env);
  assert.equal(huge.status, 413);
});

// ---------- IA y reparación de JSON ----------

test('endpoint: con IA devuelve el payload validado y el modelo usado', async () => {
  const AI = fakeAi({ response: goodModelJson });
  const res = await post(body(), { AI });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Explain-Source'), 'ai');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  const payload = await res.json();
  assert.equal(payload.source, 'ai');
  assert.equal(payload.model, EXPLAIN_MODEL_DEFAULT);
  assert.equal(payload.symbol, 'BTCUSDT');
  assert.equal(payload.timeframe, '15m');
  assert.equal(payload.scenarios.length, 1);
  assert.equal(payload.scenarios[0].name, 'Doble suelo');
  assert.match(payload.summary, /doble suelo/i);
  assert.match(payload.caution, /fuerza del patrón no es una probabilidad/);
  assert.match(payload.disclaimer, /no es asesoría financiera/i);
  assert.equal(payload.repaired, false);
  // La llamada lleva system prompt, tope de tokens y esquema JSON.
  assert.equal(AI.calls.length, 1);
  const call = AI.calls[0];
  assert.equal(call.input.messages[0].content, EXPLAIN_SYSTEM_PROMPT);
  assert.match(call.input.messages[1].content, /Doble suelo/);
  assert.ok(call.input.max_tokens > 0 && call.input.max_tokens <= 2000);
  assert.equal(call.input.response_format.json_schema, EXPLAIN_JSON_SCHEMA);
});

test('reparación de JSON: vallas markdown, texto alrededor, envoltura y truncado', () => {
  const fenced = `Claro, aquí lo tienes:\n\`\`\`json\n${goodModelJson}\n\`\`\`\nEspero que ayude.`;
  assert.equal(repairExplainJson(fenced).value.summary, JSON.parse(goodModelJson).summary);

  const wrapped = { response: goodModelJson };
  assert.equal(repairExplainJson(wrapped).value.scenarios.length, 1);

  const objectResponse = { response: JSON.parse(goodModelJson) };
  assert.equal(repairExplainJson(objectResponse).value.summary, JSON.parse(goodModelJson).summary);

  const truncated = goodModelJson.slice(0, goodModelJson.length - 40);
  const repaired = repairExplainJson(truncated);
  assert.equal(repaired.ok, true);
  assert.match(repaired.value.summary, /doble suelo/i);
  // El escenario truncado se descarta, pero la advertencia sobrevive.
  assert.equal(Array.isArray(repaired.value.scenarios), true);

  const trailing = '{"summary":"a","scenarios":[{"name":"n","condition":"c","invalidation":"i","risk_note":"r",}],"caution":"c"}';
  assert.equal(repairExplainJson(trailing).value.summary, 'a');

  assert.equal(repairExplainJson('no hay json aquí').ok, false);
  assert.equal(repairExplainJson('').ok, false);
  assert.equal(repairExplainJson(null).ok, false);
});

test('balanceJson cierra objetos truncados y quita comas colgantes', () => {
  assert.equal(balanceJson('{"a":1,}'), '{"a":1}');
  assert.equal(balanceJson('{"a":"texto sin cerrar'), '{"a":"texto sin cerrar"}');
  assert.equal(balanceJson('{"a":[1,2'), '{"a":[1,2]}');
  assert.equal(JSON.parse(balanceJson('{"summary":"ok"')).summary, 'ok');
});

test('validación del payload: rellena huecos y rechaza lo que no tiene nada', () => {
  const coerced = coerceExplainPayload({
    summary: '  Resumen con   espacios  ',
    scenarios: [
      { name: 'Doble suelo', condition: 'cierra encima', invalidation: 'cierra debajo' },
      { name: '', condition: 'se descarta' },
      'basura',
      { name: 'Zona', condition: 'c', invalidation: 'i', risk_note: 'r' },
    ],
    caution: '',
  });
  assert.equal(coerced.ok, true);
  assert.equal(coerced.repaired, true);
  assert.equal(coerced.value.scenarios.length, 2);
  assert.equal(coerced.value.summary, 'Resumen con espacios');
  assert.match(coerced.value.scenarios[0].risk_note, /stop/);
  assert.equal(coerced.value.caution.length > 0, true);

  for (const bad of [{}, { summary: 'x' }, { scenarios: [] }, { summary: 'x', scenarios: [{ name: 'n' }] }]) {
    const result = coerceExplainPayload(bad);
    // Un único escenario sin campos se rellena: solo falla lo verdaderamente vacío.
    if (bad.scenarios && bad.scenarios.length) assert.equal(result.ok, true);
    else assert.equal(result.ok, false, JSON.stringify(bad));
  }
});

test('validación del payload: una frase prohibida manda al respaldo', () => {
  for (const summary of [
    'Te garantiz una subida',
    'Compra ya, es oportunidad única',
    'Vende ahora que no puedes perder',
    'Es una ganancia asegurada',
  ]) {
    const result = coerceExplainPayload({
      summary,
      scenarios: [{ name: 'n', condition: 'c', invalidation: 'i', risk_note: 'r' }],
      caution: 'c',
    });
    assert.equal(result.ok, false, summary);
    assert.match(result.error, /^forbidden/);
  }
});

test('endpoint: JSON irrecuperable, frase prohibida o IA caída devuelven respaldo determinista', async () => {
  const cases = [
    { AI: fakeAi({ response: 'esto no es json' }), reason: 'invalid_json' },
    { AI: fakeAi({ response: JSON.stringify({ summary: 'Te garantiz beneficios', scenarios: [{ name: 'n', condition: 'c', invalidation: 'i', risk_note: 'r' }], caution: 'c' }) }), reason: 'forbidden_phrase' },
    { AI: fakeAi(null, { throws: true }), reason: 'ai_error' },
    { AI: undefined, reason: 'no_ai_binding' },
    { AI: {}, reason: 'no_ai_binding' },
    { AI: fakeAi({ response: '   ' }), reason: 'empty_response' },
  ];
  for (const { AI, reason } of cases) {
    const res = await post(body(), { AI });
    assert.equal(res.status, 200, reason);
    assert.equal(res.headers.get('X-Explain-Source'), 'fallback', reason);
    const payload = await res.json();
    assert.equal(payload.source, 'fallback', reason);
    assert.equal(payload.reason, reason, reason);
    assert.match(payload.summary, /BTCUSDT/);
    assert.equal(payload.scenarios.length, 1);
    assert.equal(payload.scenarios[0].name, 'Doble suelo');
    assert.match(payload.scenarios[0].condition, /106\.58/);
    assert.match(payload.scenarios[0].invalidation, /98\.74/);
    assert.match(payload.scenarios[0].risk_note, /stop/);
    assert.match(payload.caution, /no es una probabilidad/);
    assert.equal(findForbiddenPhrase(JSON.stringify(payload)), null);
  }
});

// ---------- respaldo determinista ----------

test('respaldo: explica, avisa del conflicto y del cupo', () => {
  const analysis = body().analysis;
  const fallback = buildFallbackExplain({ symbol: 'BTCUSDT', timeframe: '15m', analysis, reason: 'daily_cap' });
  assert.match(fallback.summary, /mayor fuerza del patrón es Doble suelo/);
  assert.equal(fallback.reason, 'daily_cap');
  assert.match(fallback.note, /sin modelo de lenguaje/);

  const conflict = buildFallbackExplain({
    symbol: 'ETHUSDT',
    timeframe: '1h',
    analysis: {
      top: [
        { label: 'Zona de resistencia', direction: 'down', strength: 0.5, levels: [{ confirm: 1, invalidate: 2 }] },
        { label: 'Doble suelo', direction: 'up', strength: 0.4, levels: [{ confirm: 3, invalidate: 4 }] },
      ],
      trend: null,
      levels: [],
    },
  });
  assert.equal(directionsConflict(conflict.scenarios.map((s) => ({ direction: 'up' }))), false);
  assert.equal(directionsConflict([{ direction: 'up' }, { direction: 'down' }]), true);
  assert.match(conflict.summary, /no señalan todos en la misma dirección/);

  const empty = buildFallbackExplain({ symbol: 'SOLUSDT', timeframe: '4h', analysis: { top: [], trend: null, levels: [] } });
  assert.match(empty.summary, /no ve patrones claros/);
  assert.deepEqual(empty.scenarios, []);
});

// ---------- abusos: límite por IP ----------

test('abuso: el binding de Rate Limiting corta la ráfaga antes del contador', async () => {
  const AI = fakeAi({ response: goodModelJson });
  const blocked = { calls: 0, async limit({ key }) { this.calls += 1; assert.equal(key, '203.0.113.9'); return { success: false }; } };
  const res = await post(body(), { AI, EXPLAIN_RATE_LIMITER: blocked });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'rate_limited');
  assert.equal(blocked.calls, 1);
  assert.equal(AI.calls.length, 0);

  // Si el binding falla, se sigue con el contador D1/KV/memoria.
  const broken = { async limit() { throw new Error('limiter down'); } };
  assert.equal((await post(body(), { AI, EXPLAIN_RATE_LIMITER: broken })).status, 200);

  // success true deja pasar.
  const open = { async limit() { return { success: true }; } };
  assert.equal((await post(body({ symbol: 'ETHUSDT' }), { AI, EXPLAIN_RATE_LIMITER: open })).status, 200);
});

test('abuso: 10 por hora por IP y 429 con Retry-After', async () => {
  const env = { AI: fakeAi({ response: goodModelJson }), EXPLAIN_DAILY_CAP: '100' };
  for (let index = 0; index < 10; index += 1) {
    const res = await post(body(), env, { nowMs: NOW + index * 1000 });
    assert.equal(res.status, 200, `petición ${index}`);
  }
  const limited = await post(body(), env, { nowMs: NOW + 11_000 });
  assert.equal(limited.status, 429);
  const payload = await limited.json();
  assert.equal(payload.error, 'rate_limited');
  assert.ok(payload.retryAfterS > 3000 && payload.retryAfterS <= 3600);
  assert.equal(limited.headers.get('Retry-After'), String(payload.retryAfterS));

  // Otra IP no se ve afectada.
  const other = await post(
    body(),
    env,
    { nowMs: NOW + 12_000, ipKey: '198.51.100.7' },
  );
  assert.equal(other.status, 200);

  // La ventana es móvil: una hora después vuelve a haber hueco.
  const later = await post(body(), env, { nowMs: NOW + 61 * 60 * 1000 });
  assert.equal(later.status, 200);
});

test('checkIpBudget: sin store no limita y con memoria cuenta', async () => {
  const free = await checkIpBudget(null, 'ip', NOW);
  assert.equal(free.allowed, true);
  const store = explainStore({});
  const first = await checkIpBudget(store, 'ip', NOW, 2, 60_000);
  const second = await checkIpBudget(store, 'ip', NOW + 1000, 2, 60_000);
  const third = await checkIpBudget(store, 'ip', NOW + 2000, 2, 60_000);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(third.allowed, false);
});

// ---------- abuso: caché ----------

test('caché: la segunda petición idéntica no llama al modelo', async () => {
  const AI = fakeAi({ response: goodModelJson });
  const env = { AI };
  const first = await post(body(), env, { nowMs: NOW });
  assert.equal(first.headers.get('X-Explain-Source'), 'ai');
  const second = await post(body(), env, { nowMs: NOW + 60_000 });
  assert.equal(second.headers.get('X-Explain-Source'), 'cache');
  const cached = await second.json();
  assert.equal(cached.source, 'cache');
  assert.equal(cached.origin, 'ai');
  assert.equal(AI.calls.length, 1);

  // Otro símbolo es otra clave.
  await post(body({ symbol: 'ETHUSDT' }), env, { nowMs: NOW + 61_000 });
  assert.equal(AI.calls.length, 2);

  // A los 5 minutos caduca.
  const third = await post(body(), env, { nowMs: NOW + 6 * 60 * 1000 });
  assert.equal(third.headers.get('X-Explain-Source'), 'ai');
  assert.equal(AI.calls.length, 3);
});

// ---------- abuso: cupo diario ----------

test('cupo diario: al agotarse responde respaldo sin llamar al modelo', async () => {
  const AI = fakeAi({ response: goodModelJson });
  const env = { AI, EXPLAIN_DAILY_CAP: '2' };
  assert.equal(explainDailyCap(env), 2);
  const first = await post(body(), env, { nowMs: NOW });
  assert.equal(first.headers.get('X-Explain-Source'), 'ai');
  const second = await post(body({ symbol: 'ETHUSDT' }), env, { nowMs: NOW + 1000 });
  assert.equal(second.headers.get('X-Explain-Source'), 'ai');
  const third = await post(body({ symbol: 'SOLUSDT' }), env, { nowMs: NOW + 2000 });
  assert.equal(third.headers.get('X-Explain-Source'), 'fallback');
  const payload = await third.json();
  assert.equal(payload.reason, 'daily_cap');
  assert.equal(payload.model, null);
  assert.equal(AI.calls.length, 2);

  // El contador es por día UTC.
  const nextDay = await post(body({ symbol: 'SOLUSDT' }), env, { nowMs: NOW + 24 * 3600 * 1000 });
  assert.equal(nextDay.headers.get('X-Explain-Source'), 'ai');
});

test('cupo diario: 0 desactiva el modelo y el defecto es 500', async () => {
  const AI = fakeAi({ response: goodModelJson });
  const off = await post(body(), { AI, EXPLAIN_DAILY_CAP: '0' }, { nowMs: NOW });
  assert.equal(off.headers.get('X-Explain-Source'), 'fallback');
  assert.equal(AI.calls.length, 0);
  assert.equal(explainDailyCap({}), EXPLAIN_DAILY_CAP_DEFAULT);
  assert.equal(explainDailyCap({ EXPLAIN_DAILY_CAP: 'no-es-numero' }), EXPLAIN_DAILY_CAP_DEFAULT);
});

test('bumpDailyBudget cuenta y marca el exceso', async () => {
  const store = explainStore({});
  assert.deepEqual(await bumpDailyBudget(store, NOW, 1), { used: 1, cap: 1, exceeded: false });
  const second = await bumpDailyBudget(store, NOW, 1);
  assert.deepEqual(second, { used: 2, cap: 1, exceeded: true });
});

// ---------- configuración y stores ----------

test('configuración: modelo y tokens por variable de entorno', () => {
  assert.equal(explainModel({}), EXPLAIN_MODEL_DEFAULT);
  assert.equal(explainModel({ EXPLAIN_MODEL: '  ' }), EXPLAIN_MODEL_DEFAULT);
  assert.equal(explainModel({ EXPLAIN_MODEL: '@cf/qwen/qwen3-30b-a3b-fp8' }), '@cf/qwen/qwen3-30b-a3b-fp8');
  assert.equal(explainMaxTokens({}), 480);
  assert.equal(explainMaxTokens({ EXPLAIN_MAX_TOKENS: '120' }), 120);
  assert.equal(explainMaxTokens({ EXPLAIN_MAX_TOKENS: '99999' }), 2000);
});

test('stores: D1 cuando hay DB, KV cuando no, y memoria como último recurso', async () => {
  const rows = new Map();
  const DB = {
    prepare(sql) {
      const text = sql.replace(/\s+/g, ' ').trim();
      return {
        bind(...args) {
          return {
            async first() {
              assert.match(text, /^SELECT value FROM explain_kv/);
              const row = rows.get(args[0]);
              return row && (row.expires_at === null || row.expires_at > args[1]) ? { value: row.value } : null;
            },
            async run() {
              assert.match(text, /^INSERT INTO explain_kv/);
              rows.set(args[0], { value: args[1], expires_at: args[2] });
            },
          };
        },
      };
    },
  };
  const d1 = explainStore({ DB });
  assert.equal(d1.kind, 'd1');
  await d1.put('k', 'v', 60_000);
  assert.equal(await d1.get('k', Date.now()), 'v');

  const kv = { puts: [], async get(key) { return this.puts.find((p) => p[0] === key)?.[1] ?? null; }, async put(key, value) { this.puts.push([key, value]); } };
  const kvStore = explainStore({ SNAPSHOTS: kv });
  assert.equal(kvStore.kind, 'kv');
  await kvStore.put('k', 'v', 60_000);
  assert.deepEqual(kv.puts[0], ['explain:k', 'v']);
  assert.equal(await kvStore.get('k'), 'v');

  const memory = explainStore({});
  assert.equal(memory.kind, 'memory');
  await memory.put('k', 'v', 60_000);
  assert.equal(await memory.get('k'), 'v');
  assert.notEqual(memory, explainStore({}), 'cada env tiene su memoria');
});

// ---------- titulares ----------

test('titulares: solo BTC/ETH, saneados y sin romper si el store falla', async () => {
  // Sin store de noticias no hay titulares y tampoco error.
  assert.deepEqual(await headlinesFor({}, 'BTCUSDT', NOW), []);
  assert.deepEqual(await headlinesFor({}, 'SOLUSDT', NOW), []);

  // Con un store que revienta, el explicador sigue en pie.
  const broken = { DB: { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('db down'); }, all: async () => { throw new Error('db down'); } }) }) } };
  assert.deepEqual(await headlinesFor(broken, 'ETHUSDT', NOW), []);
});

test('worker: /api/explain está enrutado y con cabeceras de seguridad', async () => {
  const env = { AI: fakeAi({ response: goodModelJson }) };
  const res = await worker.fetch(
    new Request('https://trade.swal.network/api/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.55' },
      body: JSON.stringify(body()),
    }),
    env,
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Security-Policy'), /default-src 'self'/);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal((await res.json()).source, 'ai');
});

test('wrangler.toml declara el binding de IA y las vars del explicador', () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(toml, /\[ai\]\nbinding = "AI"/);
  assert.match(toml, /EXPLAIN_MODEL/);
  assert.match(toml, /EXPLAIN_DAILY_CAP/);
  const migration = readFileSync(new URL('../migrations/0003_explain.sql', import.meta.url), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS explain_kv/);
});

// ---------- UI ----------

test('UI: la petición que manda el navegador cabe en el contrato', () => {
  const request = explainRequestFrom({
    symbol: 'BTCUSDT',
    timeframe: '15m',
    result: { top: body().analysis.top, trend: body().analysis.trend, levels: body().analysis.levels },
  });
  assert.equal(parseExplainBody(request).ok, true);
  assert.equal(request.analysis.top.length, 1);
  assert.equal(request.analysis.levels.length, 1);

  const empty = explainRequestFrom({ symbol: 'BTCUSDT', timeframe: '1h', result: null });
  assert.deepEqual(empty.analysis, { top: [], trend: null, levels: [] });
  assert.equal(parseExplainBody(empty).ok, true);
});

test('UI: la vista normaliza la respuesta del endpoint', () => {
  const parsed = explainView({
    summary: '  Resumen  ',
    scenarios: [
      { name: 'Doble suelo', condition: 'c', invalidation: 'i', risk_note: 'r' },
      { name: '', condition: 'se descarta' },
      'basura',
    ],
    caution: 'cuidado',
    source: 'fallback',
    reason: 'daily_cap',
    newsUsed: 2,
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.view.summary, 'Resumen');
  assert.equal(parsed.view.scenarios.length, 1);
  assert.equal(parsed.view.scenarios[0].riskNote, 'r');
  assert.equal(parsed.view.source, 'fallback');
  assert.equal(explainView({}).ok, false);
  assert.equal(explainView(null).ok, false);
});

test('UI: errores legibles para 429, 400 y red', () => {
  assert.match(explainErrorText(429, { retryAfterS: 1800 }), /10 explicaciones por hora/);
  assert.match(explainErrorText(429, {}), /10 explicaciones por hora/);
  assert.match(explainErrorText(400, {}), /no se pudo enviar/);
  assert.match(explainErrorText(0, {}), /No se pudo explicar/);
  assert.equal(explainButtonLabel(true), 'Explicando…');
  assert.equal(explainButtonLabel(false), 'Explicar con IA');
});

test('UI: la página tiene el botón y el descargo, y el CSS usa un solo tono', () => {
  const html = readFileSync(new URL('../static/analisis/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="explain"[^>]*>Explicar con IA</);
  assert.match(html, /no es asesoría financiera/);
  assert.match(html, /id="explain-out"/);
  assert.doesNotMatch(html, /rentabilidad|garantiz|\bROI\b/i);
  const css = readFileSync(new URL('../static/analisis/analisis.css', import.meta.url), 'utf8');
  assert.match(css, /\.explain\b/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,6}/i);
  const js = readFileSync(new URL('../static/analisis/analisis.js', import.meta.url), 'utf8');
  assert.match(js, /explainRequestFrom\(state\)/);
});
