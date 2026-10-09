import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyze, analyzeSync, TOOL_SPEC, historicalHitRate, findPivots, trendOf, srZones, doubleTopBottom,
  triangles, rangeBreakout, shocks, volumeProfile, rsiDivergence, ema, rsi,
} from '../static/analisis/analysis-core.js';

// Velas sinteticas: cierre lineal entre puntos de paso [indice, precio]; mechas fijas de 0.3.
function path(points, { volume = 100, wick = 0.3 } = {}) {
  const closes = [];
  for (let k = 1; k < points.length; k++) {
    const [i0, p0] = points[k - 1], [i1, p1] = points[k];
    for (let i = i0; i < i1; i++) closes.push(p0 + ((p1 - p0) * (i - i0)) / (i1 - i0));
  }
  closes.push(points[points.length - 1][1]);
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { time: 1_700_000_000 + i * 60, open: o, high: Math.max(o, c) + wick, low: Math.min(o, c) - wick, close: c, volume };
  });
}
const kinds = (fs) => fs.map((f) => f.kind);

test('pivotes fractales: encuentra maximo y minimo de un zigzag', () => {
  const c = path([[0, 100], [10, 110], [20, 100], [30, 110]]);
  const pv = findPivots(c, 3);
  assert.deepEqual(pv.map((p) => [p.type, p.index]), [['high', 10], ['low', 20]]);
});

test('indicadores: ema y rsi acotados', () => {
  const c = path([[0, 100], [60, 160]]).map((k) => k.close);
  assert.ok(ema(c, 20).at(-1) < c.at(-1));
  assert.equal(rsi(c, 14).at(-1), 100);
});

test('tendencia: alcista, bajista y datos insuficientes', () => {
  assert.equal(trendOf(path([[0, 100], [100, 200]])).direction, 'up');
  assert.equal(trendOf(path([[0, 200], [100, 100]])).direction, 'down');
  assert.equal(trendOf(path([[0, 100], [10, 101]])).strength, 0);
});

const dtop = () => path([[0, 90], [30, 110], [45, 100], [60, 110.2], [70, 104]]);
const dbot = () => path([[0, 130], [30, 110], [45, 120], [60, 109.8], [70, 116]]);

test('doble techo limpio', () => {
  const c = dtop();
  const fs = doubleTopBottom(c, findPivots(c, 3));
  assert.deepEqual(kinds(fs), ['double_top']);
  assert.equal(fs[0].direction, 'down');
  assert.equal(fs[0].status, 'forming');
  assert.ok(fs[0].evidence.neckline < 101 && fs[0].evidence.neckline > 99);
  assert.ok(fs[0].strength > 0.4 && fs[0].strength <= 1);
  assert.ok(fs[0].explanation.length > 20);
});

test('doble suelo limpio', () => {
  const c = dbot();
  const fs = doubleTopBottom(c, findPivots(c, 3));
  assert.deepEqual(kinds(fs), ['double_bottom']);
  assert.equal(fs[0].direction, 'up');
});

test('doble techo roto por el cuello queda confirmado', () => {
  const c = path([[0, 90], [30, 110], [45, 100], [60, 110.2], [75, 97]]);
  const fs = doubleTopBottom(c, findPivots(c, 3));
  assert.equal(fs[0].status, 'confirmed');
});

test('triangulo simetrico', () => {
  const c = path([[0, 110], [10, 100], [20, 120], [30, 104], [40, 117], [50, 108], [60, 114], [65, 111]]);
  const fs = triangles(c, findPivots(c, 3));
  assert.deepEqual(kinds(fs), ['symmetric_triangle']);
  assert.equal(fs[0].direction, 'neutral');
  assert.equal(fs[0].levels.length, 2);
});

test('triangulo ascendente y descendente', () => {
  const asc = path([[0, 110], [10, 100], [20, 120], [30, 106], [40, 120], [50, 112], [60, 120], [65, 117]]);
  assert.deepEqual(kinds(triangles(asc, findPivots(asc, 3))), ['ascending_triangle']);
  const desc = path([[0, 110], [10, 120], [20, 100], [30, 114], [40, 100], [50, 108], [60, 100], [65, 103]]);
  const f = triangles(desc, findPivots(desc, 3));
  assert.deepEqual(kinds(f), ['descending_triangle']);
  assert.equal(f[0].direction, 'down');
});

function flatRange(extraLast) {
  const c = [];
  for (let i = 0; i < 40; i++) {
    const p = 100 + ((i % 4) - 1.5) * 0.6;
    c.push({ time: 1_700_000_000 + i * 60, open: p, high: p + 0.3, low: p - 0.3, close: p, volume: 100 });
  }
  if (extraLast) c.push({ time: 1_700_000_000 + 40 * 60, open: 101, high: extraLast + 0.3, low: 100.8, close: extraLast, volume: 300 });
  return c;
}
test('ruptura de rango al alza con volumen', () => {
  const fs = rangeBreakout(flatRange(104));
  assert.equal(fs.length, 1);
  assert.equal(fs[0].kind, 'range_breakout');
  assert.equal(fs[0].status, 'confirmed');
  assert.equal(fs[0].direction, 'up');
  assert.ok(fs[0].evidence.volumeRatio >= 3);
});
test('rango sin ruptura ni cercania a bordes no genera hallazgo', () => {
  const c = flatRange(100);
  assert.equal(rangeBreakout(c).length, 0);
});

test('vela de choque por rango y por volumen', () => {
  const c = flatRange(0);
  c.pop();
  c.push({ time: 1_700_000_000 + 40 * 60, open: 100, high: 112, low: 99, close: 111, volume: 1500 });
  const fs = shocks(c, { shockK: 3 });
  assert.equal(fs.length, 1);
  assert.equal(fs[0].time ?? fs[0].from, c.at(-1).time);
  assert.equal(fs[0].direction, 'up');
  assert.ok(fs[0].evidence.rangeRatio > 3 && fs[0].evidence.volumeRatio > 3);
  assert.equal(shocks(c, { shockK: 1000 }).length, 0); // k configurable
});

test('perfil de volumen: POC en el precio mas negociado', () => {
  const c = path([[0, 100], [40, 100.5], [45, 110]], { volume: 100 });
  const fs = volumeProfile(c, { profileBins: 20 });
  assert.equal(fs.length, 1);
  const poc = fs[0].levels.find((l) => l.role === 'poc').price;
  assert.ok(poc < 103, `poc=${poc}`);
  assert.ok(fs[0].evidence.bins.length === 20);
});

test('divergencia RSI alcista regular', () => {
  const c = path([[0, 110], [20, 90], [35, 100], [55, 89], [62, 93]]);
  const fs = rsiDivergence(c, findPivots(c, 3));
  assert.ok(fs.some((f) => f.kind === 'rsi_divergence_bullish'), JSON.stringify(kinds(fs)));
  const f = fs.find((x) => x.kind === 'rsi_divergence_bullish');
  assert.ok(f.evidence.rsi2 > f.evidence.rsi1);
  assert.ok(f.evidence.price2 < f.evidence.price1);
});

test('divergencia RSI bajista regular', () => {
  const c = path([[0, 90], [20, 110], [35, 100], [55, 111], [62, 107]]);
  const fs = rsiDivergence(c, findPivots(c, 3));
  assert.ok(fs.some((f) => f.kind === 'rsi_divergence_bearish'), JSON.stringify(kinds(fs)));
});

test('zonas de soporte/resistencia con conteo de toques', () => {
  const c = dtop();
  const z = srZones(c, findPivots(c, 3));
  const res = z.find((f) => f.levels[0].role === 'resistance');
  assert.ok(res && res.levels[0].touches >= 2);
});

test('ranking: ordenado por strength descendente y con gancho de acierto nulo', async () => {
  const out = await analyze({ symbol: 'BTCUSDT', timeframe: '1m', candles: dtop() });
  assert.ok(out.findings.length >= 2);
  for (let i = 1; i < out.findings.length; i++) assert.ok(out.findings[i - 1].strength >= out.findings[i].strength);
  for (const f of out.findings) { assert.ok(f.strength >= 0 && f.strength <= 1); assert.equal(f.hitRate, null); }
  assert.equal(historicalHitRate('double_top', '1m', 'BTCUSDT'), null);
  assert.ok(typeof out.generatedAt === 'string');
  assert.ok(Array.isArray(out.levels));
  assert.ok(out.findings.some((f) => f.kind === 'double_top'));
});

test('ningun campo llamado probability / winrate en ninguna salida', async () => {
  const inputs = [dtop(), dbot(), flatRange(104), path([[0, 110], [20, 90], [35, 100], [55, 89], [62, 93]])];
  const bad = /prob|win[_-]?rate|acierto_pct/i;
  const walk = (v, path = '') => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { assert.doesNotMatch(k, bad, `${path}.${k}`); walk(x, `${path}.${k}`); }
  };
  for (const candles of inputs) walk(await analyze({ symbol: 'X', timeframe: '1h', candles }));
  walk(TOOL_SPEC);
});

test('TOOL_SPEC es una descripcion de herramienta utilizable', () => {
  assert.equal(TOOL_SPEC.name, 'analyze_chart');
  assert.deepEqual(TOOL_SPEC.input_schema.required, ['symbol', 'timeframe', 'candles']);
  assert.ok(TOOL_SPEC.input_schema.properties.timeframe.enum.includes('1m'));
  assert.match(TOOL_SPEC.description, /no es una probabilidad/);
});

test('entrada insuficiente no lanza', () => {
  const r = analyzeSync({ symbol: 'X', timeframe: '1m', candles: [] });
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.top, []);
});

// Serie 1m determinista: muchos toques en dos bandas cercanas (se fusionan con k=0.5)
// y un doble suelo limpio al final, cerca del cuello. Sin red.
function clusteredDoubleBottom() {
  const cs = [];
  const pushBar = (close, opt = {}) => {
    const i = cs.length;
    const prev = cs[i - 1];
    const open = prev ? prev.close : close;
    const upW = opt.upW ?? 0.12;
    const dnW = opt.dnW ?? 0.12;
    cs.push({
      time: 1_700_000_000 + i * 60,
      open, high: Math.max(open, close) + upW, low: Math.min(open, close) - dnW, close,
      volume: 120,
    });
  };
  const moveTo = (target, steps, opt) => {
    const start = cs.length ? cs[cs.length - 1].close : target;
    for (let s = 1; s <= steps; s++) pushBar(start + ((target - start) * s) / steps, opt);
  };
  pushBar(106);
  // Dos bandas separadas por mas de la tolerancia inicial de pivotes, pero con hueco < 0.5·ATR.
  for (const p of [102.00, 102.28, 102.55, 103.05, 103.22, 103.40]) {
    moveTo(p, 7, { dnW: 0.08, upW: 0.08 });
    moveTo(106.5, 7, { dnW: 0.08, upW: 0.08 });
  }
  moveTo(96.0, 12, { dnW: 0.1, upW: 0.1 });
  moveTo(100.4, 10, { dnW: 0.1, upW: 0.1 });
  moveTo(96.15, 10, { dnW: 0.1, upW: 0.1 });
  moveTo(99.15, 4, { dnW: 0.1, upW: 0.1 });
  for (let i = 0; i < 16; i++) pushBar(99.15 + i * 0.04, { upW: 0.48, dnW: 0.48 });
  return cs;
}

test('ranking: fusiona zonas cercanas y el doble suelo queda en top por encima', async () => {
  const candles = clusteredDoubleBottom();
  assert.ok(candles.every((c, i) => i === 0 || c.time - candles[i - 1].time === 60));
  const out = analyzeSync({ symbol: 'BTCUSDT', timeframe: '1m', candles });
  const split = analyzeSync({ symbol: 'BTCUSDT', timeframe: '1m', candles, options: { srMergeK: 0 } });
  const zones = (r) => r.findings.filter((f) => f.kind === 'sr_zone');
  assert.ok(zones(split).length > zones(out).length, `sin fusion ${zones(split).length} con fusion ${zones(out).length}`);
  assert.ok(zones(split).every((z) => z.evidence.mergedFrom === 1));
  const fused = zones(out).filter((z) => z.evidence.mergedFrom > 1);
  assert.ok(fused.length >= 1);
  for (const z of fused) {
    const band = z.levels[0];
    const gap = z.evidence.mergeGap;
    const parts = zones(split).filter((s) => {
      const b = s.levels[0];
      if (band.low <= b.high && b.low <= band.high) return true;
      const dist = band.low > b.high ? band.low - b.high : b.low - band.high;
      return dist < gap + 1e-9;
    });
    assert.ok(parts.length >= 2);
    const width = band.high - band.low;
    const minW = Math.min(...parts.map((s) => s.levels[0].high - s.levels[0].low));
    assert.ok(Math.abs(width - minW) < 1e-6, `rango ${width} no es el mas estrecho (${minW})`);
    assert.equal(band.touches, parts.reduce((s, p) => s + p.levels[0].touches, 0));
    assert.ok(band.touches >= 6);
  }
  assert.ok(out.top.length >= 1 && out.top.length <= 5);
  const perKind = {};
  for (const f of out.top) perKind[f.kind] = (perKind[f.kind] || 0) + 1;
  for (const n of Object.values(perKind)) assert.ok(n <= 2);
  assert.ok(zones(out).length > 2);
  assert.equal(out.top.filter((f) => f.kind === 'sr_zone').length, 2);
  const dbAt = out.top.findIndex((f) => f.kind === 'double_bottom');
  const srAt = out.top.findIndex((f) => f.kind === 'sr_zone');
  assert.ok(dbAt >= 0, `top: ${out.top.map((f) => f.kind).join(' ')}`);
  assert.ok(srAt >= 0 && dbAt < srAt);
  for (const f of out.top) assert.ok(out.findings.some((x) => x.id === f.id));
  for (let i = 1; i < out.findings.length; i++) assert.ok(out.findings[i - 1].strength >= out.findings[i].strength);
  // Regla de saturacion (analysis-core.js): strength >= 0.99 solo si evidence.exceptional.
  // Eso exige, a la vez, un patron de grafico confirmado (nunca una zona S/R), cada componente
  // acotado con 1-exp(-x) en >= 0.97, formacion hace <= 3 velas y distancia <= 0.25 ATR(14).
  // Esta serie no llega: el doble suelo esta en formacion y las zonas tienen tope 0.74.
  for (const f of out.findings) {
    if (f.strength >= 0.99) assert.equal(f.evidence.exceptional, true, f.kind);
    assert.ok(f.strength < 0.99, `${f.kind} ${f.strength}`);
    assert.match(f.explanation, /Se invalida/);
    assert.match(f.explanation, /Si cierra|Si sigue|Si se acerca|Si la vela|Si vuelve/);
  }
  for (const z of zones(out)) assert.ok(z.strength <= 0.74);
  const db = out.findings.find((f) => f.kind === 'double_bottom');
  assert.equal(db.hitRate, null);
  assert.equal(db.evidence.exceptional, false);
  assert.match(db.explanation, /Si cierra por encima de/);
  const viaApi = await analyze({ symbol: 'BTCUSDT', timeframe: '1m', candles });
  assert.equal(viaApi.top.length, out.top.length);
  assert.equal(viaApi.top[0].kind, 'double_bottom');
});
