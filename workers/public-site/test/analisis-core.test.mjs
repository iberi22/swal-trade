import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyze, analyzeSync, TOOL_SPEC, historicalHitRate, findPivots, trendOf, srZones, doubleTopBottom,
  triangles, rangeBreakout, shocks, volumeProfile, rsiDivergence, ema, rsi, CHART_KINDS,
  fairValueGaps, marketStructure, orderBlocks, liquiditySweeps, headAndShoulders, wedges, flags,
  candlestickPatterns,
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
