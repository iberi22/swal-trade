import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyze, analyzeSync, TOOL_SPEC, historicalHitRate, findPivots, trendOf, srZones, doubleTopBottom,
  triangles, rangeBreakout, shocks, volumeProfile, rsiDivergence, ema, rsi, CHART_KINDS,
  fairValueGaps, marketStructure, orderBlocks, liquiditySweeps, headAndShoulders, wedges, flags,
  candlestickPatterns, pivotFindings,
  volumeFlow, volumeShocks, deltaDivergence, absorption, climax,
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

function ohlc(rows) {
  return rows.map((r, i) => ({
    time: 1_700_000_000 + i * 60,
    open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4] ?? 100,
  }));
}

function decisionOk(f) {
  assert.ok(f.levels.length >= 1, f.kind);
  for (const l of f.levels) {
    assert.equal(typeof l.confirm, 'number', `${f.kind} confirm`);
    assert.equal(typeof l.invalidate, 'number', `${f.kind} invalidate`);
    assert.ok(Number.isFinite(l.confirm) && Number.isFinite(l.invalidate), f.kind);
  }
  assert.match(f.explanation, /Se invalida/);
  assert.match(f.explanation, /Si cierra|Si sigue|Si se acerca|Si la vela|Si vuelve/);
}

test('FVG alcista sin rellenar y FVG bajista', () => {
  const up = [];
  for (let i = 0; i < 22; i++) {
    const p = 100 + (i % 2) * 0.3;
    up.push([p, p + 0.7, p - 0.7, p + 0.15]);
  }
  up.push([100, 101.2, 99.5, 100.3]);
  up.push([100.3, 108, 100.1, 107.2]);
  up.push([107.2, 110, 104, 109]);
  for (let i = 0; i < 6; i++) up.push([109, 110, 105.6, 109.1]);
  const bull = fairValueGaps(ohlc(up));
  assert.ok(bull.some((f) => f.kind === 'fvg_bullish'), kinds(bull).join(','));
  const f = bull.find((x) => x.kind === 'fvg_bullish');
  assert.equal(f.direction, 'up');
  assert.equal(f.evidence.touched, false);
  decisionOk(f);

  const dn = [];
  for (let i = 0; i < 22; i++) {
    const p = 100 + (i % 2) * 0.3;
    dn.push([p, p + 0.7, p - 0.7, p - 0.1]);
  }
  dn.push([100, 100.6, 98.8, 99.7]);
  dn.push([99.7, 99.8, 92, 92.6]);
  dn.push([92.6, 96, 90, 91]);
  for (let i = 0; i < 6; i++) dn.push([91, 94.2, 90.4, 91.2]);
  const bear = fairValueGaps(ohlc(dn));
  assert.ok(bear.some((f) => f.kind === 'fvg_bearish'), kinds(bear).join(','));
  const filled = ohlc(up);
  filled.push({ time: filled.at(-1).time + 60, open: 106, high: 106.5, low: 100, close: 100.5, volume: 100 });
  assert.equal(fairValueGaps(filled).some((f) => f.kind === 'fvg_bullish' && f.evidence.bottom >= 101), false);
});

test('BOS alcista y CHoCH bajista', () => {
  const bos = path([[0, 100], [8, 110], [16, 105], [24, 115], [32, 108], [40, 122]]);
  const up = marketStructure(bos, findPivots(bos, 3));
  assert.equal(up.length, 1);
  assert.equal(up[0].kind, 'bos_bullish');
  assert.equal(up[0].direction, 'up');
  assert.ok(up[0].levels[0].confirm > up[0].levels[0].invalidate);
  decisionOk(up[0]);

  // El minimo de 108 tiene que rebotar: si el precio sigue cayendo, no hay higher-low que romper.
  const choch = path([[0, 100], [8, 110], [16, 105], [24, 115], [32, 108], [36, 113], [44, 98]]);
  const down = marketStructure(choch, findPivots(choch, 3));
  assert.equal(down.length, 1, kinds(down).join(','));
  assert.equal(down[0].kind, 'choch_bearish');
  assert.equal(down[0].direction, 'down');
  decisionOk(down[0]);
});

test('order block alcista sin atravesar y barrido de maximos iguales', () => {
  const bos = path([[0, 100], [8, 110], [16, 105], [24, 115], [32, 108], [40, 122]]);
  const obs = orderBlocks(bos, findPivots(bos, 3));
  assert.ok(obs.some((f) => f.kind === 'order_block_bullish'), kinds(obs).join(','));
  decisionOk(obs[0]);
  assert.ok(obs[0].levels[0].confirm !== obs[0].levels[0].invalidate);

  const sweep = path([[0, 100], [10, 120], [18, 108], [28, 120.15], [36, 112]]);
  const i = sweep.length;
  sweep.push({ time: 1_700_000_000 + i * 60, open: 114, high: 123.5, low: 113, close: 116, volume: 180 });
  const liq = liquiditySweeps(sweep, findPivots(sweep, 3));
  assert.ok(liq.some((f) => f.kind === 'liquidity_sweep_bearish'), kinds(liq).join(','));
  const s = liq.find((f) => f.kind === 'liquidity_sweep_bearish');
  assert.equal(s.direction, 'down');
  assert.ok(s.levels[0].invalidate > s.levels[0].confirm);
  decisionOk(s);

  const sweepUp = path([[0, 140], [10, 110], [18, 122], [28, 109.8], [36, 118]]);
  const j = sweepUp.length;
  sweepUp.push({ time: 1_700_000_000 + j * 60, open: 116, high: 117, low: 106, close: 115, volume: 180 });
  const liqUp = liquiditySweeps(sweepUp, findPivots(sweepUp, 3));
  assert.ok(liqUp.some((f) => f.kind === 'liquidity_sweep_bullish'), kinds(liqUp).join(','));
});

test('hombro-cabeza-hombro y su inverso', () => {
  const hs = path([[0, 90], [10, 110], [18, 100], [28, 120], [36, 101], [46, 111], [54, 104]]);
  const fs = headAndShoulders(hs, findPivots(hs, 3));
  assert.ok(fs.some((f) => f.kind === 'head_shoulders'), kinds(fs).join(','));
  const f = fs.find((x) => x.kind === 'head_shoulders');
  assert.equal(f.direction, 'down');
  assert.equal(f.status, 'forming');
  decisionOk(f);
  assert.ok(f.evidence.head > f.evidence.left && f.evidence.head > f.evidence.right);

  const ihs = path([[0, 130], [10, 100], [18, 112], [28, 90], [36, 111], [46, 101], [54, 108]]);
  const inv = headAndShoulders(ihs, findPivots(ihs, 3));
  assert.ok(inv.some((f) => f.kind === 'inverse_head_shoulders'), kinds(inv).join(','));
  assert.equal(inv.find((x) => x.kind === 'inverse_head_shoulders').direction, 'up');
});

test('cuña ascendente y descendente', () => {
  const up = path([[0, 100], [10, 110], [18, 100], [25, 114], [32, 108], [40, 116], [48, 112], [56, 114]]);
  const rising = wedges(up, findPivots(up, 3));
  assert.deepEqual(kinds(rising), ['rising_wedge'], JSON.stringify(rising.map((f) => f.evidence)));
  assert.equal(rising[0].direction, 'down');
  decisionOk(rising[0]);

  const dn = path([[0, 120], [8, 130], [16, 112], [24, 124], [32, 108], [40, 118], [48, 106], [56, 112]]);
  const falling = wedges(dn, findPivots(dn, 3));
  assert.deepEqual(kinds(falling), ['falling_wedge']);
  assert.equal(falling[0].direction, 'up');
  decisionOk(falling[0]);
});

test('bandera alcista y bajista', () => {
  const bull = path([[0, 110], [6, 100], [18, 145], [22, 138], [26, 142], [30, 136], [34, 140], [38, 134]]);
  const bf = flags(bull, findPivots(bull, 3));
  assert.ok(bf.some((f) => f.kind === 'bull_flag'), kinds(bf).join(','));
  const f = bf.find((x) => x.kind === 'bull_flag');
  assert.equal(f.direction, 'up');
  assert.equal(f.status, 'forming');
  decisionOk(f);
  assert.ok(f.evidence.retrace > 0.15 && f.evidence.retrace < 0.62);

  const bear = path([[0, 100], [6, 150], [18, 105], [22, 114], [26, 107], [30, 116], [34, 108], [38, 113]]);
  const sf = flags(bear, findPivots(bear, 3));
  assert.ok(sf.some((f) => f.kind === 'bear_flag'), kinds(sf).join(','));
  assert.equal(sf.find((x) => x.kind === 'bear_flag').direction, 'down');
});

test('velas solo en swing o en zona: envolvente, martillo, estrellas y doji', () => {
  const c = [];
  const push = (o, h, l, cl) => {
    c.push({ time: 1_700_000_000 + c.length * 60, open: o, high: h, low: l, close: cl, volume: 100 });
  };
  let p = 130;
  for (let i = 0; i < 18; i++) { const n = p - 1.1; push(p, p + 0.25, n - 0.15, n); p = n; }
  push(p, p + 0.2, p - 4.2, p - 3.6);
  const bearClose = p - 3.6;
  push(bearClose - 0.15, bearClose + 4.2, bearClose - 0.5, bearClose + 3.8);
  let q = bearClose + 3.8;
  for (let i = 0; i < 6; i++) { push(q, q + 0.35, q - 0.25, q + 0.15); q += 0.15; }
  const eng = candlestickPatterns(c, findPivots(c, 3), srZones(c, findPivots(c, 3)));
  assert.ok(eng.some((f) => f.kind === 'candle_engulfing_bullish'), kinds(eng).join(','));
  decisionOk(eng.find((f) => f.kind === 'candle_engulfing_bullish'));

  const hammer = [];
  let h = 120;
  for (let i = 0; i < 16; i++) {
    const n = h - 0.8;
    hammer.push({ time: 1_700_000_000 + i * 60, open: h, high: h + 0.2, low: n - 0.1, close: n, volume: 90 });
    h = n;
  }
  hammer.push({ time: 1_700_000_000 + 16 * 60, open: 106.2, high: 106.6, low: 101.5, close: 106.45, volume: 140 });
  for (let i = 0; i < 6; i++) {
    const px = 107 + i * 0.7;
    hammer.push({ time: 1_700_000_000 + (17 + i) * 60, open: px - 0.4, high: px + 0.25, low: px - 0.45, close: px, volume: 90 });
  }
  const hm = candlestickPatterns(hammer, findPivots(hammer, 3), []);
  assert.ok(hm.some((f) => f.kind === 'candle_hammer'), kinds(hm).join(','));
  decisionOk(hm.find((f) => f.kind === 'candle_hammer'));

  const star = [];
  const sp = (o, hi, lo, cl) => star.push({ time: 1_700_000_000 + star.length * 60, open: o, high: hi, low: lo, close: cl, volume: 100 });
  for (let i = 0; i < 12; i++) sp(112 - i * 0.3, 112.2 - i * 0.3, 111.4 - i * 0.3, 111.6 - i * 0.3);
  sp(108, 108.4, 100.5, 101.2);
  sp(101, 101.6, 99.4, 100.7);
  sp(100.8, 107.2, 100.5, 106.6);
  for (let i = 0; i < 5; i++) sp(106.4 + i * 0.2, 106.8 + i * 0.2, 105.8 + i * 0.2, 106.6 + i * 0.2);
  const ms = candlestickPatterns(star, findPivots(star, 3), []);
  assert.ok(ms.some((f) => f.kind === 'candle_morning_star'), kinds(ms).join(','));
  decisionOk(ms.find((f) => f.kind === 'candle_morning_star'));

  const eve = [];
  const ep = (o, hi, lo, cl) => eve.push({ time: 1_700_000_000 + eve.length * 60, open: o, high: hi, low: lo, close: cl, volume: 100 });
  for (let i = 0; i < 12; i++) ep(90 + i * 0.3, 90.6 + i * 0.3, 89.7 + i * 0.3, 90.4 + i * 0.3);
  ep(94, 101.5, 93.6, 101);
  ep(101.2, 102.4, 100.6, 101.5);
  ep(101.4, 101.6, 95.2, 95.6);
  for (let i = 0; i < 5; i++) ep(95.4 - i * 0.2, 95.8 - i * 0.2, 94.8 - i * 0.2, 95.2 - i * 0.2);
  const es = candlestickPatterns(eve, findPivots(eve, 3), []);
  assert.ok(es.some((f) => f.kind === 'candle_evening_star'), kinds(es).join(','));

  const starHigh = [];
  let sh = 100;
  for (let i = 0; i < 16; i++) {
    const n = sh + 0.7;
    starHigh.push({ time: 1_700_000_000 + i * 60, open: sh, high: n + 0.15, low: sh - 0.15, close: n, volume: 90 });
    sh = n;
  }
  starHigh.push({ time: 1_700_000_000 + 16 * 60, open: 111.2, high: 116, low: 110.9, close: 111.45, volume: 150 });
  for (let i = 0; i < 6; i++) {
    const px = 110.5 - i * 0.5;
    starHigh.push({ time: 1_700_000_000 + (17 + i) * 60, open: px + 0.3, high: px + 0.45, low: px - 0.25, close: px, volume: 90 });
  }
  const ss = candlestickPatterns(starHigh, findPivots(starHigh, 3), []);
  assert.ok(ss.some((f) => f.kind === 'candle_shooting_star'), kinds(ss).join(','));

  const dojis = [];
  for (let i = 0; i < 24; i++) {
    dojis.push({ time: 1_700_000_000 + i * 60, open: 100, high: 101, low: 99, close: 100.2, volume: 80 });
  }
  dojis.push({ time: 1_700_000_000 + 24 * 60, open: 100.05, high: 100.7, low: 99.4, close: 100.08, volume: 80 });
  const zone = [{ levels: [{ role: 'support', price: 100, low: 99.3, high: 100.6 }] }];
  const dj = candlestickPatterns(dojis, findPivots(dojis, 3), zone);
  assert.ok(dj.some((f) => f.kind === 'candle_doji'), kinds(dj).join(','));
  decisionOk(dj.find((f) => f.kind === 'candle_doji'));
  assert.equal(candlestickPatterns(dojis, findPivots(dojis, 3), []).some((f) => f.kind === 'candle_doji'), false);
});

test('cada hallazgo trae levels.confirm y levels.invalidate', () => {
  const hs = path([[0, 90], [10, 110], [18, 100], [28, 120], [36, 101], [46, 111], [54, 104]]);
  const flag = path([[0, 110], [6, 100], [18, 145], [22, 138], [26, 142], [30, 136], [34, 140], [38, 134]]);
  for (const candles of [dtop(), dbot(), flatRange(104), hs, flag, path([[0, 110], [20, 90], [35, 100], [55, 89], [62, 93]])]) {
    const out = analyzeSync({ symbol: 'BTCUSDT', timeframe: '1h', candles });
    assert.ok(out.findings.length >= 1);
    for (const f of out.findings) decisionOk(f);
    const counts = {};
    let sawPlain = false;
    for (const f of out.top) {
      counts[f.kind] = (counts[f.kind] || 0) + 1;
      const lead = CHART_KINDS.has(f.kind) && f.strength >= 0.4;
      if (!lead) sawPlain = true;
      else assert.equal(sawPlain, false, `top fuera de orden: ${out.top.map((x) => x.kind).join(' ')}`);
    }
    for (const n of Object.values(counts)) assert.ok(n <= 2);
  }
});

// ---------- flujo de volumen: agresión del tape (takerBuyVolume) ----------
// Velas sintéticas con dato de agresión. [open, high, low, close, volume, takerBuyVolume?, trades?]
function flowRows(rows) {
  return rows.map((r, i) => {
    const c = { time: 1_700_000_000 + i * 60, open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4] };
    if (r[5] != null) c.takerBuyVolume = r[5];
    if (r[6] != null) c.trades = r[6];
    return c;
  });
}
// Tramo tranquilo: sube/baja poco, volumen constante 100, taker 55 (buyShare 0.55, sin sesgo).
function calmRun(n, start = 100, step = 0) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const p = start + step * i;
    rows.push([p, p + 0.2, p - 0.2, p, 100, 55, 12]);
  }
  return flowRows(rows);
}

test('flujo de volumen: delta, cvd y buyShare; null sin takerBuyVolume', () => {
  const f = volumeFlow([
    { time: 1, open: 10, high: 11, low: 9, close: 10, volume: 100, takerBuyVolume: 80 },
    { time: 2, open: 10, high: 12, low: 9, close: 11, volume: 100, takerBuyVolume: 40 },
    { time: 3, open: 11, high: 13, low: 10, close: 12, volume: 100, takerBuyVolume: 55 },
  ]);
  assert.deepEqual(f.delta, [60, -20, 10]);    // 2·taker − volume
  assert.deepEqual(f.cvd, [60, 40, 50]);       // acumulado
  assert.deepEqual(f.buyShare, [0.8, 0.4, 0.55]);
  assert.equal(volumeFlow(path([[0, 100], [30, 110], [45, 100], [60, 110.2], [70, 104]])), null);
  assert.equal(volumeFlow([]), null);
});

test('compatibilidad hacia atrás: sin takerBuyVolume no hay flujo ni hallazgos nuevos', () => {
  const c = path([[0, 90], [30, 110], [45, 100], [60, 110.2], [70, 104]]);
  const out = analyzeSync({ symbol: 'BTCUSDT', timeframe: '15m', candles: c });
  assert.equal(out.volumeFlow, null);
  assert.ok(!out.findings.some((k) => /volume_shock|delta_divergence|absorption|climax/.test(k.kind)));
});

test('choque de volumen compra/venta agresiva y k configurable', () => {
  const buy = calmRun(40);
  buy.push({ time: buy.at(-1).time + 60, open: 100, high: 101.5, low: 99.9, close: 101.2, volume: 900, takerBuyVolume: 810, trades: 500 });
  const fs = volumeShocks(buy);
  const b = fs.find((f) => f.kind === 'volume_shock_buy');
  assert.ok(b, fs.map((f) => f.kind).join(','));
  assert.equal(b.direction, 'up');
  assert.ok(b.evidence.buyShare >= 0.65);
  assert.ok(b.explanation.includes('compra agresiva') || /La demanda/.test(b.explanation));
  decisionOk(b);
  assert.equal(volumeShocks(buy, { shockK: 100 }).length, 0); // k configurable apaga el detector

  const sell = calmRun(40);
  sell.push({ time: sell.at(-1).time + 60, open: 100, high: 100.1, low: 98.5, close: 98.8, volume: 900, takerBuyVolume: 90, trades: 500 });
  const s = volumeShocks(sell).find((f) => f.kind === 'volume_shock_sell');
  assert.ok(s);
  assert.equal(s.direction, 'down');
  assert.ok(s.evidence.buyShare <= 0.35);
  decisionOk(s);
  assert.equal(volumeShocks(calmRun(40)).length, 0); // sin choque real: nada
});

test('divergencia de delta alcista: mínimo más bajo con CVD más alto', () => {
  const base = path([[0, 100], [10, 96], [22, 100], [34, 94.5], [46, 99]]);
  const c = base.map((k, i) => {
    const tb = (i >= 22 && i <= 34) ? 80 : (i <= 10 ? 45 : 55); // compra fuerte dentro de la caída final
    return { ...k, takerBuyVolume: tb, trades: 20 };
  });
  const fs = deltaDivergence(c, findPivots(c, 3));
  const b = fs.find((f) => f.kind === 'delta_divergence_bullish');
  assert.ok(b, fs.map((f) => f.kind).join(','));
  assert.equal(b.direction, 'up');
  assert.ok(b.evidence.price2 < b.evidence.price1, 'precio debe hacer mínimo más bajo');
  assert.ok(b.evidence.cvd2 > b.evidence.cvd1, 'CVD debe hacer mínimo más alto');
  assert.ok(b.evidence.conviction > 0);
  decisionOk(b);
});

test('divergencia de delta bajista: máximo más alto con CVD más bajo', () => {
  const base = path([[0, 100], [10, 104], [22, 100], [34, 105.5], [46, 101]]);
  const c = base.map((k, i) => {
    const tb = (i >= 22 && i <= 34) ? 20 : (i <= 10 ? 55 : 45); // venta fuerte dentro de la subida final
    return { ...k, takerBuyVolume: tb, trades: 20 };
  });
  const s = deltaDivergence(c, findPivots(c, 3)).find((f) => f.kind === 'delta_divergence_bearish');
  assert.ok(s);
  assert.equal(s.direction, 'down');
  assert.ok(s.evidence.price2 > s.evidence.price1);
  assert.ok(s.evidence.cvd2 < s.evidence.cvd1);
  decisionOk(s);
});

test('absorción: volumen alto y rango mínimo en un mínimo', () => {
  const c = [];
  const push = (o, h, l, cl, v, tb) => c.push({ time: 1_700_000_000 + c.length * 60, open: o, high: h, low: l, close: cl, volume: v, takerBuyVolume: tb });
  for (let i = 0; i < 14; i++) { const p = 120 - i * 1.2; push(p, p + 0.2, p - 0.2, p, 100, 55); }
  push(104.3, 104.6, 103.9, 104.35, 900, 430); // vela de rango ínfimo (0.7) con volumen 9x, justo en el mínimo
  for (let i = 0; i < 6; i++) { const p = 104.35 + i * 0.5; push(p, p + 0.2, p - 0.2, p, 100, 60); }
  const pv = findPivots(c, 3);
  const fs = absorption(c, pv, srZones(c, pv));
  const a = fs.find((f) => f.kind === 'absorption' && f.direction === 'up');
  assert.ok(a, fs.map((f) => `${f.kind}:${f.direction}`).join(','));
  assert.ok(a.evidence.rangeAtAtr <= 0.7 && a.evidence.volumeRatio >= 3);
  decisionOk(a);
  assert.equal(absorption(calmRun(40), findPivots(calmRun(40), 3), []).length, 0);
});

test('clímax de compra: subida extendida, volumen y cierre de reversión', () => {
  const c = [];
  const push = (o, h, l, cl, v, tb) => c.push({ time: 1_700_000_000 + c.length * 60, open: o, high: h, low: l, close: cl, volume: v, takerBuyVolume: tb });
  for (let i = 0; i < 25; i++) { const p = 100 + i * 0.6; push(p, p + 0.2, p - 0.2, p, 100, 55); }
  push(114.5, 116, 112.5, 113.6, 900, 800); // abre alto, cierra bajo: mecha alta, compra agresiva
  const fs = climax(c);
  const d = fs.find((f) => f.kind === 'climax' && f.direction === 'down');
  assert.ok(d, fs.map((f) => `${f.kind}:${f.direction}`).join(','));
  assert.ok(d.evidence.driftAtr >= 1.5 && d.evidence.volumeRatio >= 3 && d.evidence.reversal >= 0.5);
  decisionOk(d);
});

test('clímax de venta: bajada extendida, volumen y cierre de reversión', () => {
  const c = [];
  const push = (o, h, l, cl, v, tb) => c.push({ time: 1_700_000_000 + c.length * 60, open: o, high: h, low: l, close: cl, volume: v, takerBuyVolume: tb });
  for (let i = 0; i < 25; i++) { const p = 140 - i * 0.6; push(p, p + 0.2, p - 0.2, p, 100, 45); }
  push(124, 124.5, 116, 121.5, 900, 100); // abre bajo, cierra alto: mecha inferior, venta agresiva
  const u = climax(c).find((f) => f.kind === 'climax' && f.direction === 'up');
  assert.ok(u);
  assert.ok(u.evidence.reversal >= 0.5 && u.evidence.buyShare <= 0.35);
  decisionOk(u);
});

// Serie con varios flujos a la vez: choque agresivo + divergencia de delta.
function richTakerSeries() {
  const c = [];
  const push = (o, h, l, cl, v, tb) => c.push({ time: 1_700_000_000 + c.length * 60, open: o, high: h, low: l, close: cl, volume: v, takerBuyVolume: tb, trades: 30 });
  for (let i = 0; i < 10; i++) { const p = 100 - i * 0.3; push(p, p + 0.2, p - 0.2, p, 100, 45); }   // 100 -> 97
  for (let i = 0; i < 12; i++) { const p = 97 + i * 0.4; push(p, p + 0.2, p - 0.2, p, 100, 55); }    // sube a ~101.4
  for (let i = 0; i < 12; i++) { const p = 101.4 - i * 0.35; push(p, p + 0.2, p - 0.2, p, 100, 80); } // baja a ~97.5 con compra fuerte
  for (let i = 0; i < 6; i++) { const p = 97.5 + i * 0.3; push(p, p + 0.2, p - 0.2, p, 100, 60); }
  c.push({ time: c.at(-1).time + 60, open: 99.3, high: 100.6, low: 99.2, close: 100.4, volume: 950, takerBuyVolume: 880, trades: 400 }); // choque de compra
  for (let i = 0; i < 4; i++) { const p = 100.4 + i * 0.2; c.push({ time: c.at(-1).time + 60, open: p, high: p + 0.2, low: p - 0.2, close: p, volume: 100, takerBuyVolume: 55, trades: 20 }); }
  return c;
}

test('analyze expone volumeFlow y los nuevos hallazgos; el top sigue siendo diverso', async () => {
  const c = richTakerSeries();
  const out = analyzeSync({ symbol: 'BTCUSDT', timeframe: '15m', candles: c });
  assert.ok(out.volumeFlow && Array.isArray(out.volumeFlow.cvd) && out.volumeFlow.cvd.length === c.length);
  assert.ok(out.volumeFlow.delta.length === c.length && out.volumeFlow.buyShare.length === c.length);
  assert.ok(out.findings.some((f) => /volume_shock|delta_divergence|absorption|climax/.test(f.kind)), out.findings.map((f) => f.kind).join(','));
  for (const f of out.findings) decisionOk(f);
  const perKind = {};
  for (const f of out.top) perKind[f.kind] = (perKind[f.kind] || 0) + 1;
  for (const n of Object.values(perKind)) assert.ok(n <= 2, `perKind ${JSON.stringify(perKind)}`);
  // Ningún campo prohibido (probabilidad / tasa de acierto) en la salida completa, con flujo incluido.
  const bad = /prob|win[_-]?rate|acierto_pct/i;
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { assert.doesNotMatch(k, bad); walk(x); }
  };
  walk(await analyze({ symbol: 'BTCUSDT', timeframe: '15m', candles: c }));
});

// ---------- pulso de mercado: muros del libro y liquidaciones ----------
import { depthWalls, liquidationSummary, DEPTH_WALL_DEFAULTS, LIQUIDATION_DEFAULTS } from '../static/analisis/analysis-core.js';

test('depthWalls: muros grandes y cercanos al precio medio, con USD y distancia', () => {
  const depth = {
    bids: [['99.9', '1'], ['99.8', '1'], ['99.7', '1'], ['99.6', '1'], ['99.5', '20'], ['95.0', '50']],
    asks: [['100.1', '1'], ['100.2', '1'], ['100.3', '1'], ['100.4', '10'], ['100.5', '40']],
  };
  const out = depthWalls(depth);
  assert.equal(out.mid, 100);
  assert.equal(out.spreadPct, 0.2);
  assert.equal(out.medianSize, 1);
  // 95.0 está al 5 %: fuera del rango por defecto (2 %). 99.9 pesa 1: no es muro.
  assert.deepEqual(out.bids, [{ price: 99.5, size: 20, usd: 1990, distancePct: 0.5 }]);
  // Los asks se ordenan por tamaño: primero el de 40 y después el de 10.
  assert.deepEqual(out.asks, [
    { price: 100.5, size: 40, usd: 4020, distancePct: 0.5 },
    { price: 100.4, size: 10, usd: 1004, distancePct: 0.4 },
  ]);
});

test('depthWalls: sin niveles dominantes no hay muros', () => {
  const out = depthWalls({ bids: [['99.9', '5'], ['99.8', '5']], asks: [['100.1', '5'], ['100.2', '5']] });
  assert.equal(out.medianSize, 5);
  assert.deepEqual(out.bids, []);
  assert.deepEqual(out.asks, []);
  // Con wallK más bajo el mismo libro sí tiene muros: el umbral es configurable.
  const loose = depthWalls({ bids: [['99.9', '5'], ['99.8', '5']], asks: [['100.1', '5'], ['100.2', '5']] }, { wallK: 0.5 });
  assert.equal(loose.asks.length, 2);
});

test('depthWalls: corta en maxWalls y ordena por tamaño', () => {
  const asks = [['100.1', '10'], ['100.2', '50'], ['100.3', '30'], ['100.4', '20'], ['100.5', '40']];
  const bids = [['99.9', '1'], ['99.8', '1'], ['99.7', '1'], ['99.6', '1'], ['99.5', '1']];
  const out = depthWalls({ bids, asks }, { maxWalls: 3 });
  assert.deepEqual(out.asks.map((w) => w.size), [50, 40, 30]);
});

test('depthWalls: libro vacío o basura no lanza y devuelve el hueco', () => {
  const empty = { mid: null, spreadPct: null, medianSize: 0, bids: [], asks: [] };
  assert.deepEqual(depthWalls(null), empty);
  assert.deepEqual(depthWalls({}), empty);
  assert.deepEqual(depthWalls({ bids: [], asks: [] }), empty);
  assert.deepEqual(depthWalls({ bids: [['0', '1'], ['x', '2']], asks: [['100.1', '1']] }), empty);
  assert.equal(DEPTH_WALL_DEFAULTS.wallRangePct, 2);
});

test('liquidationSummary: totales por lado en 5 y 15 min y el mayor evento', () => {
  const now = 1_700_000_000_000;
  const events = [
    { at: now - 60_000, side: 'long', usd: 1000 },
    { at: now - 4 * 60_000, side: 'short', usd: 2000 },
    { at: now - 10 * 60_000, side: 'long', usd: 3000 },
    { at: now - 20 * 60_000, side: 'short', usd: 9000 }, // fuera de las dos ventanas
  ];
  const out = liquidationSummary(events, {}, now);
  assert.equal(out.count, 4);
  assert.deepEqual(out.windows.map((w) => w.minutes), [5, 15]);
  const [five, fifteen] = out.windows;
  assert.deepEqual(
    { long: five.longUsd, short: five.shortUsd, total: five.totalUsd, count: five.count },
    { long: 1000, short: 2000, total: 3000, count: 2 },
  );
  assert.deepEqual(
    { long: fifteen.longUsd, short: fifteen.shortUsd, total: fifteen.totalUsd, count: fifteen.count },
    { long: 4000, short: 2000, total: 6000, count: 3 },
  );
  assert.deepEqual(five.largest, { usd: 2000, at: now - 4 * 60_000, side: 'short' });
  assert.deepEqual(out.largest, { usd: 3000, at: now - 10 * 60_000, side: 'long' });
});

test('liquidationSummary: descarta basura y aguanta la lista vacía', () => {
  const now = 1_700_000_000_000;
  const events = [
    { at: now - 1000, side: 'long', usd: 500 },
    { at: now - 1000, side: 'neutral', usd: 10_000 }, // lado desconocido
    { at: now - 1000, side: 'long', usd: -5 },        // USD no positivo
    { at: now - 1000, side: 'short', usd: Number.NaN },
    { side: 'long', usd: 100 },                        // sin instante
    null,
  ];
  const out = liquidationSummary(events, {}, now);
  assert.equal(out.count, 1);
  assert.equal(out.windows[0].totalUsd, 500);
  const none = liquidationSummary([], {}, now);
  assert.equal(none.count, 0);
  assert.equal(none.largest, null);
  assert.deepEqual(none.windows.map((w) => w.totalUsd), [0, 0]);
  assert.deepEqual(LIQUIDATION_DEFAULTS.windowsMinutes, [5, 15]);
});

// ---------- precio bajo (tipo PEPE) y precio alto (tipo BTC): los niveles no pierden digitos ----------
// Las mismas formas de precio a dos escalas: ~100 (referencia), ~0.004 (PEPE) y ~1e5 (BTC).
const PRICE_SHAPES = [
  [[0, 90], [30, 110], [45, 100], [60, 110.2], [70, 104]],
  [[0, 130], [30, 110], [45, 120], [60, 109.8], [70, 116]],
  [[0, 90], [10, 110], [18, 100], [28, 120], [36, 101], [46, 111], [54, 104]],
  [[0, 110], [6, 100], [18, 145], [22, 138], [26, 142], [30, 136], [34, 140], [38, 134]],
];
const PEPE_K = 3.8e-5; // 110 -> 0.00418
const BTC_K = 1023.4567891; // 110 -> 112,579 aprox.
const scaledShape = (pts, k) => path(pts.map(([i, p]) => [i, p * k]), { wick: 0.3 * k });

test('precio bajo tipo PEPE: confirm, invalidate y precio conservan >= 6 cifras significativas', () => {
  for (const pts of PRICE_SHAPES) {
    const base = analyzeSync({ symbol: 'BTCUSDT', timeframe: '1h', candles: path(pts) }).findings;
    const pepe = analyzeSync({ symbol: '1000PEPEUSDC', timeframe: '5m', candles: scaledShape(pts, PEPE_K) }).findings;
    assert.ok(base.length >= 1);
    const pool = new Map();
    for (const g of pepe) {
      const key = `${g.kind}|${g.from}|${g.to}`;
      if (!pool.has(key)) pool.set(key, []);
      pool.get(key).push(g);
    }
    for (const f of base) {
      // El perfil de volumen usa celdas de precio: con velas planas, la celda del POC empata y el desempate
      // depende de redondeo de punto flotante al cambiar de escala. Ese caso se cubre abajo, con el texto.
      if (f.kind === 'volume_profile') continue;
      const list = pool.get(`${f.kind}|${f.from}|${f.to}`) || [];
      const g = list.shift();
      assert.ok(g, `falta ${f.kind} en la serie PEPE`);
      assert.equal(g.levels.length, f.levels.length, f.kind);
      f.levels.forEach((l, j) => {
        for (const field of ['price', 'confirm', 'invalidate']) {
          if (!Number.isFinite(l[field])) continue;
          const want = l[field] * PEPE_K;
          const got = g.levels[j][field];
          // La referencia a ~100 ya trae 4 decimales (error relativo <= 6e-7); el nivel PEPE debe quedar dentro de 1e-6.
          assert.ok(Math.abs(got - want) <= Math.abs(want) * 1e-6, `${g.kind}.${l.role}.${field}: ${got} frente a ${want}`);
        }
      });
    }
  }
});

test('precio bajo tipo PEPE: el texto del hallazgo muestra los mismos digitos que el numero', () => {
  const pepe = analyzeSync({ symbol: '1000PEPEUSDC', timeframe: '5m', candles: scaledShape(PRICE_SHAPES[0], PEPE_K) }).findings;
  const c = scaledShape(PRICE_SHAPES[0], PEPE_K);
  const texts = [...pepe.filter((f) => f.kind === 'sr_zone'), ...pivotFindings(c, findPivots(c, 3))];
  assert.ok(texts.some((f) => f.kind === 'pivot') && texts.some((f) => f.kind === 'sr_zone'));
  for (const f of texts) {
    assert.ok(f.explanation.includes(String(f.levels[0].price)), `${f.explanation} sin ${f.levels[0].price}`);
  }
});

test('precio bajo: las zonas sr tienen id distinto por precio (no colapsan a 0)', () => {
  const c = scaledShape(PRICE_SHAPES[0], PEPE_K);
  const zones = srZones(c, findPivots(c, 3));
  assert.ok(zones.length >= 1);
  for (const z of zones) {
    assert.ok(z.id.endsWith(`:${z.levels[0].price}`), z.id);
    assert.notEqual(z.id, `sr:${z.levels[0].role}:0`);
  }
});

test('precio alto tipo BTC: los niveles no cambian respecto a la version con redondeo de 4 decimales', () => {
  const rows = [];
  for (const [name, pts] of [['dtop', PRICE_SHAPES[0]], ['dbot', PRICE_SHAPES[1]], ['hs', PRICE_SHAPES[2]], ['flag', PRICE_SHAPES[3]]]) {
    const candles = path(pts.map(([i, p]) => [i, p * BTC_K]), { wick: 0.3 * BTC_K });
    const out = analyzeSync({ symbol: 'BTCUSDT', timeframe: '1h', candles });
    for (const f of out.findings) for (const l of f.levels) rows.push([name, f.kind, l.role, l.confirm, l.invalidate]);
  }
  // Golden tomado del core antes del cambio (r4 en todos los precios).
  assert.deepEqual(rows, BTC_GOLDEN);
});

const BTC_GOLDEN = [
  ['dtop', 'double_top', 'neckline', 102038.6419, 113091.9752],
  ['dtop', 'double_top', 'peak', 102038.6419, 113091.9752],
  ['dtop', 'double_top', 'peak', 102038.6419, 113091.9752],
  ['dtop', 'rsi_divergence_bearish', 'divergence_start', 102038.6419, 113091.9752],
  ['dtop', 'rsi_divergence_bearish', 'divergence_end', 102038.6419, 113091.9752],
  ['dtop', 'sr_zone', 'resistance', 112887.2838, 113091.9752],
  ['dtop', 'volume_profile', 'poc', 109100.4937, 112204.9793],
  ['dtop', 'volume_profile', 'vah', 109100.4937, 112204.9793],
  ['dtop', 'volume_profile', 'val', 109100.4937, 112204.9793],
  ['dbot', 'double_bottom', 'neckline', 123121.8517, 112068.5184],
  ['dbot', 'double_bottom', 'trough', 123121.8517, 112068.5184],
  ['dbot', 'double_bottom', 'trough', 123121.8517, 112068.5184],
  ['dbot', 'rsi_divergence_bullish', 'divergence_start', 123121.8517, 112068.5184],
  ['dbot', 'rsi_divergence_bullish', 'divergence_end', 123121.8517, 112068.5184],
  ['dbot', 'sr_zone', 'support', 112273.2098, 112068.5184],
  ['dbot', 'volume_profile', 'poc', 116059.9999, 112955.5143],
  ['dbot', 'volume_profile', 'vah', 116059.9999, 112955.5143],
  ['dbot', 'volume_profile', 'val', 116059.9999, 112955.5143],
  ['hs', 'head_shoulders', 'neckline', 104085.5555, 123121.8517],
  ['hs', 'head_shoulders', 'head', 104085.5555, 123121.8517],
  ['hs', 'head_shoulders', 'shoulder', 104085.5555, 123121.8517],
  ['hs', 'head_shoulders', 'shoulder', 104085.5555, 123121.8517],
  ['hs', 'order_block_bullish', 'ob_high', 103932.0369, 102038.6419],
  ['hs', 'order_block_bullish', 'ob_low', 103932.0369, 102038.6419],
  ['hs', 'bear_flag', 'pole_end', 103062.0987, 113910.7406],
  ['hs', 'bear_flag', 'flag_high', 103062.0987, 113910.7406],
  ['hs', 'candle_morning_star', 'candle', 105723.0863, 103062.0987],
  ['hs', 'candle_engulfing_bullish', 'candle', 104699.6295, 102038.6419],
  ['hs', 'candle_engulfing_bearish', 'candle', 120077.0678, 123121.8517],
  ['hs', 'fvg_bullish', 'fvg_top', 102038.6419, 100605.8024],
  ['hs', 'fvg_bullish', 'fvg_bottom', 102038.6419, 100605.8024],
  ['hs', 'fvg_bearish', 'fvg_top', 113399.0122, 115215.648],
  ['hs', 'fvg_bearish', 'fvg_bottom', 113399.0122, 115215.648],
  ['hs', 'fvg_bullish', 'fvg_top', 99991.7283, 98558.8888],
  ['hs', 'fvg_bullish', 'fvg_bottom', 99991.7283, 98558.8888],
  ['hs', 'volume_profile', 'poc', 110725.2314, 113987.4999],
  ['hs', 'volume_profile', 'vah', 110725.2314, 113987.4999],
  ['hs', 'volume_profile', 'val', 110725.2314, 113987.4999],
  ['flag', 'fvg_bullish', 'fvg_top', 136580.3085, 133356.4196],
  ['flag', 'fvg_bullish', 'fvg_bottom', 136580.3085, 133356.4196],
  ['flag', 'fvg_bullish', 'fvg_top', 132742.3455, 129518.4567],
  ['flag', 'fvg_bullish', 'fvg_bottom', 132742.3455, 129518.4567],
  ['flag', 'order_block_bearish', 'ob_high', 141953.4566, 143590.9875],
  ['flag', 'order_block_bearish', 'ob_low', 141953.4566, 143590.9875],
  ['flag', 'bull_flag', 'pole_end', 148708.2715, 136836.1727],
  ['flag', 'bull_flag', 'flag_low', 148708.2715, 136836.1727],
  ['flag', 'candle_engulfing_bullish', 'candle', 106490.6789, 102038.6419],
  ['flag', 'bos_bearish', 'structure_level', 138883.0863, 143590.9875],
  ['flag', 'bear_flag', 'pole_end', 140929.9999, 145637.9011],
  ['flag', 'bear_flag', 'flag_high', 140929.9999, 145637.9011],
  ['flag', 'volume_profile', 'poc', 141902.2838, 148708.2715],
  ['flag', 'volume_profile', 'vah', 141902.2838, 148708.2715],
  ['flag', 'volume_profile', 'val', 141902.2838, 148708.2715],
];

// ---------- escala de precios de la pagina /analisis (lightweight-charts priceFormat) ----------
test('chartPriceFormat: PEPE necesita 8 decimales; BTC y entradas no validas, 2', async () => {
  const { chartPriceFormat } = await import('../static/analisis/analysis-core.js');
  assert.deepEqual(chartPriceFormat(0.0041558), { type: 'price', precision: 8, minMove: 1e-8 });
  assert.deepEqual(chartPriceFormat(82313.85), { type: 'price', precision: 2, minMove: 0.01 });
  assert.deepEqual(chartPriceFormat(0), { type: 'price', precision: 2, minMove: 0.01 });
  assert.deepEqual(chartPriceFormat(Number.NaN), { type: 'price', precision: 2, minMove: 0.01 });
});

test('analisis.js aplica el formato de precio a la serie de velas (regresion PEPE)', async () => {
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../static/analisis/analisis.js', import.meta.url), 'utf8');
  assert.match(page, /series\.applyOptions\(\{ priceFormat: chartPriceFormat\(last\.close\) \}\)/);
});
