// analysis-core.js — deteccion determinista de patrones sobre velas. PURO: sin DOM, sin red, sin reloj
// (salvo `generatedAt` en analyze()). Pensado para uso humano (grafico) y para agentes (TOOL_SPEC).
//
// Vela: {time (segundos UTC), open, high, low, close, volume}.
// Hallazgo ("finding"): {id, kind, label, explanation (es), from, to (tiempos), levels, direction
//   (up|down|neutral), strength (0..1), status, evidence:{...numeros}}.
//
// IMPORTANTE: `strength` es la "fuerza del patron": una puntuacion geometrica/estadistica transparente
// (toques, simetria, confirmacion por volumen, cercania a la ruptura, recencia, distancia al precio).
// NO es una probabilidad ni una tasa de acierto. La tasa de acierto solo vendra de backtests: ver historicalHitRate().
//
// Regla de saturacion (strength >= 0.99 solo con evidencia excepcional):
// Cada componente entra por una transformacion acotada 1-exp(-x), que se acerca a 1 sin alcanzarla.
// Despues se aplica el peso de WEIGHTS. El valor publicado tiene un tope ordinario de 0.98.
// strength >= 0.99 solo si evidence.exceptional === true. Eso exige las cuatro cosas a la vez:
//   1) patron de grafico ya confirmado: doble techo/suelo, triangulo, ruptura de rango o divergencia RSI
//      (una zona S/R, un choque, un pivote o el perfil de volumen nunca es excepcional);
//   2) cada componente acotado >= 0.97;
//   3) la formacion termina hace 3 velas o menos;
//   4) el precio esta a 0.25 ATR(14) o menos del nivel de decision.
// Las zonas S/R tienen ademas el tope srStrengthCap (0.74): con evidencia comparable quedan por debajo
// de un doble techo/suelo, triangulo, ruptura o divergencia. La recencia decae con las velas desde el
// ultimo toque o la formacion; la distancia al precio actual resta fuerza (mas en las zonas).

export const DEFAULTS = {
  pivotWindow: 3,       // velas a cada lado para un pivote fractal
  atrPeriod: 14,
  shockK: 3,            // umbral k * mediana para velas de choque
  shockWindow: 50,      // ventana de la mediana movil
  maxShocks: 20,
  profileBins: 24,
  rsiPeriod: 14,
  lookbackPatterns: 120, // los patrones deben terminar dentro de las ultimas N velas
  rangeLookback: 30,
  rangeMaxAtr: 8,
  srMergeK: 0.5,        // fusiona zonas S/R si sus rangos se solapan o distan menos de k·ATR(14)
  srStrengthCap: 0.74,  // tope de una zona: por debajo de un patron de grafico con evidencia comparable
  topLimit: 5,
  topPerKind: 2,
};

// Pesos de cada componente de `strength` (cada conjunto suma 1). Visibles para que sean auditables.
export const WEIGHTS = {
  sr: { touches: 0.6, recency: 0.2, age: 0.2 },
  double: { symmetry: 0.3, depth: 0.25, proximity: 0.25, volume: 0.1, recency: 0.1 },
  triangle: { touches: 0.3, fit: 0.25, convergence: 0.25, proximity: 0.2 },
  range: { tightness: 0.3, touches: 0.25, volume: 0.25, distance: 0.2 },
  divergence: { rsiGap: 0.35, priceGap: 0.2, extremity: 0.2, recency: 0.25 },
};

/**
 * Gancho para la futura tasa de acierto historica por (tipo de patron, temporalidad, simbolo).
 * Hoy NO hay medicion: devuelve null ("sin medicion historica todavia"). Cuando existan backtests,
 * debe devolver {hits, total, rate, from, to} calculado fuera de esta libreria; nunca inventarlo aqui.
 * @returns {null}
 */
export function historicalHitRate(kind, timeframe, symbol) { // eslint-disable-line no-unused-vars
  return null;
}
export const NO_HISTORY_TEXT = 'sin medición histórica todavía';

// ---------- utilidades ----------
const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
export function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const fmt = (p) => (Math.abs(p) >= 100 ? p.toFixed(1) : Math.abs(p) >= 1 ? p.toFixed(3) : p.toPrecision(4));

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let e = mean(values.slice(0, period));
  out[period - 1] = e;
  for (let i = period; i < values.length; i++) { e = values[i] * k + e * (1 - k); out[i] = e; }
  return out;
}

export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= period; l /= period;
  out[period] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (period - 1) + Math.max(d, 0)) / period;
    l = (l * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

export function trueRanges(c) {
  return c.map((k, i) => (i === 0 ? k.high - k.low : Math.max(k.high - k.low, Math.abs(k.high - c[i - 1].close), Math.abs(k.low - c[i - 1].close))));
}

export function atr(c, period = 14) {
  const tr = trueRanges(c);
  const tail = tr.slice(-period);
  return mean(tail) || 0;
}

function finding(f) {
  return { levels: [], direction: 'neutral', status: 'forming', evidence: {}, ...f, strength: r4(clamp01(f.strength)) };
}

/** 1-exp(-x): acota en [0, 1) y no se satura con un conteo grande. */
const sat = (x) => 1 - Math.exp(-Math.max(0, Number.isFinite(x) ? x : 0));

/** Recencia acotada: vela actual ≈ 0.98; decae con las velas transcurridas y nunca llega a 1. */
const boundedRecency = (candlesSince, halfLife = 40) => sat(4 * Math.exp(-Math.max(0, candlesSince) / halfLife));

const CHART_KINDS = new Set([
  'double_top', 'double_bottom',
  'ascending_triangle', 'descending_triangle', 'symmetric_triangle',
  'range_breakout',
  'rsi_divergence_bullish', 'rsi_divergence_bearish',
]);

/**
 * Publica `strength` con tope ordinario 0.98.
 * `components` (opcional) son las puntuaciones ya acotadas; sirven solo para la regla exceptional.
 * La distancia al precio, si nearWeight > 0, reduce la fuerza: exp(-distAtr / nearScale).
 */
function scoreStrength(kind, raw, { status = 'forming', components = null, candlesSince = Infinity, distAtr = Infinity, nearWeight = 0, nearScale = 4, srCap = DEFAULTS.srStrengthCap } = {}) {
  const near = Math.exp(-Math.max(0, Number.isFinite(distAtr) ? distAtr : 0) / nearScale);
  let strength = clamp01(raw) * ((1 - nearWeight) + nearWeight * near);
  const parts = Array.isArray(components) ? components : [];
  const exceptional = CHART_KINDS.has(kind)
    && status === 'confirmed'
    && parts.length >= 3
    && parts.every((c) => c >= 0.97)
    && candlesSince <= 3
    && distAtr <= 0.25;
  if (kind === 'sr_zone') strength = Math.min(strength, srCap);
  if (kind === 'shock') strength = Math.min(strength, 0.62);
  if (kind === 'volume_profile') strength = Math.min(strength, 0.5);
  if (!exceptional) strength = Math.min(strength, 0.98);
  else strength = Math.min(strength, 0.999);
  return { strength, exceptional };
}

// ---------- 1. pivotes ----------
/** Pivotes fractales: maximo/minimo local con `w` velas a cada lado (confirmados: necesitan w velas despues). */
export function findPivots(candles, w = DEFAULTS.pivotWindow) {
  const out = [];
  for (let i = w; i < candles.length - w; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= w; j++) {
      if (!(candles[i].high > candles[i - j].high && candles[i].high >= candles[i + j].high)) isHigh = false;
      if (!(candles[i].low < candles[i - j].low && candles[i].low <= candles[i + j].low)) isLow = false;
    }
    if (isHigh) out.push({ index: i, time: candles[i].time, price: candles[i].high, type: 'high' });
    if (isLow) out.push({ index: i, time: candles[i].time, price: candles[i].low, type: 'low' });
  }
  return out;
}

export function pivotFindings(candles, pivots) {
  return pivots.map((p) => finding({
    id: `pivot:${p.type}:${p.time}`,
    kind: 'pivot',
    label: p.type === 'high' ? 'Máximo local' : 'Mínimo local',
    explanation: p.type === 'high'
      ? `Máximo local en ${fmt(p.price)}: el precio subió hasta aquí y luego retrocedió. Sigue vigente si las velas vecinas no lo superan. Se invalida si cierra por encima de ${fmt(p.price)}.`
      : `Mínimo local en ${fmt(p.price)}: el precio bajó hasta aquí y luego rebotó. Sigue vigente si las velas vecinas no lo pierden. Se invalida si cierra por debajo de ${fmt(p.price)}.`,
    from: p.time, to: p.time,
    levels: [{ role: p.type === 'high' ? 'pivot_high' : 'pivot_low', price: p.price }],
    direction: 'neutral',
    strength: 0.05,
    status: 'confirmed',
    evidence: { index: p.index },
  }));
}

// ---------- 2. tendencia ----------
/** Tendencia por EMA20/EMA50 (cruce y pendiente) + estructura de pivotes (HH/HL o LH/LL). */
export function trendOf(candles, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const closes = candles.map((k) => k.close);
  if (candles.length < 55) {
    return { direction: 'neutral', strength: 0, label: 'Sin datos suficientes', evidence: { candles: candles.length, needed: 55 } };
  }
  const e20 = ema(closes, 20), e50 = ema(closes, 50);
  const n = candles.length - 1;
  const last = closes[n];
  const spread = e20[n] - e50[n];
  const slope = (e20[n] - e20[n - 10]) / e20[n - 10]; // variacion relativa de la EMA20 en 10 velas
  const pv = findPivots(candles, o.pivotWindow);
  const highs = pv.filter((p) => p.type === 'high').slice(-2);
  const lows = pv.filter((p) => p.type === 'low').slice(-2);
  let structure = 0;
  if (highs.length === 2 && lows.length === 2) {
    if (highs[1].price > highs[0].price && lows[1].price > lows[0].price) structure = 1;
    else if (highs[1].price < highs[0].price && lows[1].price < lows[0].price) structure = -1;
  }
  const votes = [Math.sign(spread), Math.sign(slope), structure];
  const sum = votes.reduce((s, v) => s + v, 0);
  const direction = sum >= 2 ? 'up' : sum <= -2 ? 'down' : 'neutral';
  const a = atr(candles, o.atrPeriod) || last * 0.001;
  const strength = clamp01(0.6 * (Math.abs(sum) / 3) + 0.4 * clamp01(Math.abs(spread) / (2 * a)));
  const label = direction === 'up' ? 'Alcista' : direction === 'down' ? 'Bajista' : 'Lateral / mixta';
  return {
    direction, strength: r4(strength), label,
    evidence: { ema20: r4(e20[n]), ema50: r4(e50[n]), spread: r4(spread), slope10: r4(slope), structure, votes, close: last },
  };
}

// ---------- 3. soportes / resistencias ----------
/** Dos zonas se fusionan si sus rangos se solapan o el hueco entre ellos es menor que `gap`. */
function rangesClose(a, b, gap) {
  if (a.low <= b.high && b.low <= a.high) return true;
  const dist = a.low > b.high ? a.low - b.high : b.low - a.high;
  return dist < gap;
}

/**
 * Une zonas conectadas (solape o cercania). La zona resultante suma los toques y se queda
 * con el rango mas estrecho del grupo (en empate, el de mas toques).
 */
function mergeSrClusters(zones, gap) {
  const parent = zones.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const unite = (i, j) => {
    const ri = find(i), rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  };
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      if (rangesClose(zones[i], zones[j], gap)) unite(i, j);
    }
  }
  const groups = new Map();
  zones.forEach((z, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(z);
  });
  return [...groups.values()].map((g) => {
    let tight = g[0];
    for (const z of g.slice(1)) {
      const w = z.high - z.low, tw = tight.high - tight.low;
      if (w < tw - 1e-9 || (Math.abs(w - tw) <= 1e-9 && z.touches > tight.touches)) tight = z;
    }
    return {
      low: tight.low,
      high: tight.high,
      price: (tight.low + tight.high) / 2,
      touches: g.reduce((s, z) => s + z.touches, 0),
      first: Math.min(...g.map((z) => z.first)),
      lastIdx: Math.max(...g.map((z) => z.lastIdx)),
      parts: g.length,
    };
  });
}

/** Agrupa pivotes cercanos (tolerancia 0.6 ATR) y fusiona zonas a menos de srMergeK·ATR. */
export function srZones(candles, pivots, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const a = atr(candles, o.atrPeriod);
  if (!a || pivots.length < 2) return [];
  const tol = 0.6 * a;
  const mergeGap = Math.max(0, o.srMergeK) * a;
  const sorted = [...pivots].sort((x, y) => x.price - y.price);
  const clusters = [];
  for (const p of sorted) {
    const c = clusters[clusters.length - 1];
    if (c && p.price - mean(c.map((q) => q.price)) <= tol) c.push(p); else clusters.push([p]);
  }
  const raw = [];
  for (const c of clusters) {
    if (c.length < 2) continue;
    const prices = c.map((p) => p.price);
    raw.push({
      low: Math.min(...prices),
      high: Math.max(...prices),
      touches: c.length,
      first: Math.min(...c.map((p) => p.index)),
      lastIdx: Math.max(...c.map((p) => p.index)),
    });
  }
  const n = candles.length - 1;
  const last = candles[n].close;
  const w = WEIGHTS.sr;
  return mergeSrClusters(raw, mergeGap).map((z) => {
    const { price, low, high, touches, first, lastIdx, parts } = z;
    const candlesSince = n - lastIdx;
    const distAtr = Math.abs(price - last) / a;
    const touchS = sat(touches / 2.2);
    const recS = boundedRecency(candlesSince, 45);
    const ageS = sat((lastIdx - first) / 25);
    const nearS = sat(4 * Math.exp(-distAtr / 2.5));
    // nearS no esta en WEIGHTS: una zona lejos del precio pierde fuerza aunque sume muchos toques.
    const rawScore = (w.touches * touchS + w.recency * recS + w.age * ageS) * (0.5 + 0.5 * nearS);
    const scored = scoreStrength('sr_zone', rawScore, { status: 'confirmed', candlesSince, distAtr, srCap: o.srStrengthCap });
    const role = price < last ? 'support' : 'resistance';
    const band = `${fmt(low)}–${fmt(high)}`;
    const explanation = role === 'support'
      ? `Zona de soporte en ${fmt(price)} (rango ${band}): el precio rebotó ${touches} veces aquí. Si cierra por encima de ${fmt(low)} al volver a la zona, el soporte se confirma. Se invalida si cierra por debajo de ${fmt(low)}.`
      : `Zona de resistencia en ${fmt(price)} (rango ${band}): el precio fue frenado ${touches} veces aquí. Si cierra por debajo de ${fmt(high)} al volver a la zona, la resistencia se confirma. Se invalida si cierra por encima de ${fmt(high)}.`;
    return finding({
      id: `sr:${role}:${Math.round(price * 100)}`,
      kind: 'sr_zone',
      label: role === 'support' ? 'Zona de soporte' : 'Zona de resistencia',
      explanation,
      from: candles[first].time, to: candles[n].time,
      levels: [{ role, price: r4(price), low: r4(low), high: r4(high), touches }],
      direction: 'neutral', strength: scored.strength, status: 'confirmed',
      evidence: {
        touches, low: r4(low), high: r4(high), firstIndex: first, lastIndex: lastIdx,
        tolerance: r4(tol), mergeGap: r4(mergeGap), mergedFrom: parts,
        candlesSince, distAtr: r4(distAtr), exceptional: scored.exceptional,
      },
    });
  });
}

// ---------- 4. doble techo / doble suelo ----------
function doubleExtreme(candles, pivots, type, o) {
  const a = atr(candles, o.atrPeriod);
  const n = candles.length - 1;
  const last = candles[n].close;
  if (!a) return [];
  const same = pivots.filter((p) => p.type === type).slice(-3);
  const top = type === 'high';
  const out = [];
  for (let k = 1; k < same.length; k++) {
    const p1 = same[k - 1], p2 = same[k];
    if (p2.index < n - o.lookbackPatterns || p2.index - p1.index < 5) continue;
    const tol = 0.6 * a;
    const diff = Math.abs(p1.price - p2.price);
    if (diff > tol) continue;
    const between = candles.slice(p1.index, p2.index + 1);
    const neck = top ? Math.min(...between.map((x) => x.low)) : Math.max(...between.map((x) => x.high));
    const level = (p1.price + p2.price) / 2;
    const depth = Math.abs(level - neck) / a;
    if (depth < 1.5) continue;
    const extreme = top ? Math.max(p1.price, p2.price) : Math.min(p1.price, p2.price);
    if (top ? last > extreme + a : last < extreme - a) continue; // invalidado
    const broken = top ? last < neck : last > neck;
    const distNeck = Math.abs(last - neck) / Math.max(depth * a, 1e-12); // 0 = en el cuello
    const vol1 = mean(candles.slice(Math.max(0, p1.index - 1), p1.index + 2).map((x) => x.volume));
    const vol2 = mean(candles.slice(Math.max(0, p2.index - 1), p2.index + 2).map((x) => x.volume));
    const volRatio = vol1 ? vol2 / vol1 : 1;
    const w = WEIGHTS.double;
    const candlesSince = n - p2.index;
    const distAtr = Math.abs(last - neck) / a;
    const proxRaw = broken ? clamp01(1.4 - distNeck) : clamp01(1 - distNeck * 0.85);
    const components = [
      sat((1 - diff / tol) * 4),
      sat(depth / 2),
      sat(proxRaw * 3.2),
      sat(volRatio < 1 ? 3.5 : 1.4),
      boundedRecency(candlesSince, 40),
    ];
    const rawScore = w.symmetry * components[0] + w.depth * components[1] + w.proximity * components[2]
      + w.volume * components[3] + w.recency * components[4];
    const kind = top ? 'double_top' : 'double_bottom';
    const status = broken ? 'confirmed' : 'forming';
    const scored = scoreStrength(kind, rawScore, { status, components, candlesSince, distAtr, nearWeight: 0.2, nearScale: 6 });
    const where = `${fmt(p1.price)} y ${fmt(p2.price)}`;
    const explanation = top
      ? (broken
        ? `Doble techo en ${where}, con cuello en ${fmt(neck)}: dos máximos casi iguales. El precio ya cerró por debajo del cuello. Si cierra por debajo de ${fmt(neck)}, el giro a la baja sigue confirmado. Se invalida si cierra por encima de ${fmt(extreme)}.`
        : `Doble techo en ${where}, con cuello en ${fmt(neck)}: dos máximos casi iguales. Si cierra por debajo de ${fmt(neck)}, el giro a la baja se confirma. Se invalida si cierra por encima de ${fmt(extreme)}.`)
      : (broken
        ? `Doble suelo en ${where}, con cuello en ${fmt(neck)}: dos mínimos casi iguales. El precio ya cerró por encima del cuello. Si cierra por encima de ${fmt(neck)}, el giro al alza sigue confirmado. Se invalida si cierra por debajo de ${fmt(extreme)}.`
        : `Doble suelo en ${where}, con cuello en ${fmt(neck)}: dos mínimos casi iguales. Si cierra por encima de ${fmt(neck)}, el giro al alza se confirma. Se invalida si cierra por debajo de ${fmt(extreme)}.`);
    out.push(finding({
      id: `${kind}:${p1.time}:${p2.time}`,
      kind,
      label: top ? 'Doble techo' : 'Doble suelo',
      explanation,
      from: p1.time, to: candles[n].time,
      levels: [
        { role: 'neckline', price: r4(neck) },
        { role: top ? 'peak' : 'trough', price: r4(p1.price), time: p1.time },
        { role: top ? 'peak' : 'trough', price: r4(p2.price), time: p2.time },
      ],
      direction: top ? 'down' : 'up', strength: scored.strength, status,
      evidence: {
        peak1: p1.price, peak2: p2.price, diffAtr: r4(diff / a), depthAtr: r4(depth), neckline: r4(neck),
        distToNeckline: r4(distNeck), volumeRatio2vs1: r4(volRatio), broken,
        candlesSince, distAtr: r4(distAtr), exceptional: scored.exceptional,
      },
    }));
  }
  return out;
}
export function doubleTopBottom(candles, pivots, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  return [...doubleExtreme(candles, pivots, 'high', o), ...doubleExtreme(candles, pivots, 'low', o)];
}

// ---------- 5. triangulos ----------
function linreg(pts) { // pts: [{x,y}]
  const n = pts.length;
  const mx = mean(pts.map((p) => p.x)), my = mean(pts.map((p) => p.y));
  let sxx = 0, sxy = 0;
  for (const p of pts) { sxx += (p.x - mx) ** 2; sxy += (p.x - mx) * (p.y - my); }
  const slope = sxx ? sxy / sxx : 0;
  const b = my - slope * mx;
  const res = mean(pts.map((p) => Math.abs(p.y - (slope * p.x + b))));
  return { slope, b, res, n };
}
export function triangles(candles, pivots, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = candles.length - 1;
  const recent = pivots.filter((p) => p.index >= n - o.lookbackPatterns);
  const hs = recent.filter((p) => p.type === 'high').slice(-3);
  const ls = recent.filter((p) => p.type === 'low').slice(-3);
  if (hs.length < 2 || ls.length < 2) return [];
  const x0 = Math.min(hs[0].index, ls[0].index), x1 = n;
  if (x1 - x0 < 10) return [];
  const H = linreg(hs.map((p) => ({ x: p.index, y: p.price })));
  const L = linreg(ls.map((p) => ({ x: p.index, y: p.price })));
  const hi = (x) => H.slope * x + H.b, lo = (x) => L.slope * x + L.b;
  const w0 = hi(x0) - lo(x0), w1 = hi(x1) - lo(x1);
  if (!(w0 > 0) || !(w1 > 0) || w1 > 0.85 * w0) return []; // debe converger
  const moveH = (hi(x1) - hi(x0)) / w0, moveL = (lo(x1) - lo(x0)) / w0; // movimiento relativo al ancho inicial
  const flat = 0.2, move = 0.3;
  let kind = null;
  if (Math.abs(moveH) <= flat && moveL >= move) kind = 'ascending_triangle';
  else if (Math.abs(moveL) <= flat && moveH <= -move) kind = 'descending_triangle';
  else if (moveH <= -flat && moveL >= flat) kind = 'symmetric_triangle';
  if (!kind) return [];
  const last = candles[n].close;
  const upper = hi(n), lower = lo(n);
  if (last > upper + 0.5 * w1 || last < lower - 0.5 * w1) return []; // ya rompio y se alejo
  const touches = hs.length + ls.length;
  const fit = 1 - clamp01(((H.res + L.res) / 2) / (0.15 * w0));
  const convergence = clamp01(1 - w1 / w0);
  const bias = kind === 'ascending_triangle' ? 'up' : kind === 'descending_triangle' ? 'down' : 'neutral';
  const target = bias === 'down' ? lower : upper;
  const dist = Math.abs(target - last) / w1;
  const proximity = bias === 'neutral' ? clamp01(1 - Math.min(Math.abs(upper - last), Math.abs(last - lower)) / w1 * 2) : clamp01(1 - dist);
  const w = WEIGHTS.triangle;
  const a = atr(candles, o.atrPeriod) || Math.abs(last) * 0.001 || 1;
  const lastPivot = Math.max(hs[hs.length - 1].index, ls[ls.length - 1].index);
  const candlesSince = n - lastPivot;
  const distAtr = Math.min(Math.abs(upper - last), Math.abs(last - lower)) / a;
  const components = [sat(touches / 2.5), sat(fit * 3.2), sat(convergence * 3.2), sat(proximity * 3.2)];
  const rawScore = (w.touches * components[0] + w.fit * components[1] + w.convergence * components[2] + w.proximity * components[3])
    * (0.72 + 0.28 * boundedRecency(candlesSince, 40));
  const scored = scoreStrength(kind, rawScore, { status: 'forming', components, candlesSince, distAtr, nearWeight: 0.15, nearScale: 6 });
  const upPx = fmt(upper), loPx = fmt(lower);
  const copy = {
    ascending_triangle: ['Triángulo ascendente', `Triángulo ascendente entre ${loPx} y ${upPx}: techo horizontal y mínimos cada vez más altos. Si cierra por encima de ${upPx}, la ruptura al alza se confirma. Se invalida si cierra por debajo de ${loPx}.`],
    descending_triangle: ['Triángulo descendente', `Triángulo descendente entre ${loPx} y ${upPx}: suelo horizontal y máximos cada vez más bajos. Si cierra por debajo de ${loPx}, la ruptura a la baja se confirma. Se invalida si cierra por encima de ${upPx}.`],
    symmetric_triangle: ['Triángulo simétrico', `Triángulo simétrico entre ${loPx} y ${upPx}: el rango se estrecha por ambos lados y el mercado se comprime. Si cierra por encima de ${upPx}, se confirma la ruptura al alza; si cierra por debajo de ${loPx}, a la baja. Se invalida ese intento si, después de salir, cierra de nuevo entre ${loPx} y ${upPx}.`],
  };
  return [finding({
    id: `${kind}:${candles[x0].time}`,
    kind, label: copy[kind][0],
    explanation: copy[kind][1],
    from: candles[x0].time, to: candles[n].time,
    levels: [
      { role: 'triangle_upper', price: r4(upper), line: { from: { time: candles[x0].time, price: r4(hi(x0)) }, to: { time: candles[n].time, price: r4(upper) } } },
      { role: 'triangle_lower', price: r4(lower), line: { from: { time: candles[x0].time, price: r4(lo(x0)) }, to: { time: candles[n].time, price: r4(lower) } } },
    ],
    direction: bias, strength: scored.strength, status: 'forming',
    evidence: {
      touchesHigh: hs.length, touchesLow: ls.length, fit: r4(fit), convergence: r4(convergence),
      widthStart: r4(w0), widthNow: r4(w1), distToBreakout: r4(dist),
      candlesSince, distAtr: r4(distAtr), exceptional: scored.exceptional,
    },
  })];
}

// ---------- 6. ruptura de rango ----------
export function rangeBreakout(candles, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = candles.length - 1;
  const L = o.rangeLookback;
  if (n < L + 2) return [];
  const a = atr(candles, o.atrPeriod);
  if (!a) return [];
  const box = candles.slice(n - L, n); // excluye la ultima vela
  const hi = Math.max(...box.map((k) => k.high)), lo = Math.min(...box.map((k) => k.low));
  const width = hi - lo;
  if (!(width > 0) || width / a > o.rangeMaxAtr) return [];
  if (Math.abs(box[0].close - box[box.length - 1].close) > 0.5 * width) return []; // no es lateral
  const edge = 0.15 * width;
  const touches = box.filter((k) => k.high >= hi - edge).length + box.filter((k) => k.low <= lo + edge).length;
  const last = candles[n];
  const medVol = median(box.map((k) => k.volume));
  const volRatio = medVol ? last.volume / medVol : 1;
  const up = last.close > hi, down = last.close < lo;
  const w = WEIGHTS.range;
  const tight = clamp01(1 - (width / a) / o.rangeMaxAtr);
  let dir, status, distance, expl;
  if (up || down) {
    dir = up ? 'up' : 'down'; status = 'confirmed';
    const excess = (up ? last.close - hi : lo - last.close) / a;
    distance = clamp01(1 - excess / 2); // muy extendido = persecucion tardia
    const back = up ? `por debajo de ${fmt(hi)}` : `por encima de ${fmt(lo)}`;
    const hold = up ? `por encima de ${fmt(hi)}` : `por debajo de ${fmt(lo)}`;
    expl = `Ruptura de rango ${fmt(lo)}–${fmt(hi)}: el precio salió hacia ${up ? 'arriba' : 'abajo'}${volRatio >= 1.5 ? ' con volumen alto' : ' sin volumen especial'}. Si sigue y cierra ${hold}, la ruptura se mantiene. Se invalida si cierra de nuevo ${back}, de vuelta dentro del rango.`;
  } else {
    const dHi = hi - last.close, dLo = last.close - lo;
    if (Math.min(dHi, dLo) > 0.2 * width) return []; // lejos de los bordes: no hay nada que decir
    dir = dHi < dLo ? 'up' : 'down'; status = 'forming';
    distance = clamp01(1 - Math.min(dHi, dLo) / (0.2 * width));
    expl = `Rango comprimido ${fmt(lo)}–${fmt(hi)}: el precio lleva ${L} velas dentro y está pegado al borde ${dir === 'up' ? 'superior' : 'inferior'}. Si cierra por encima de ${fmt(hi)}, se confirma al alza; si cierra por debajo de ${fmt(lo)}, a la baja. Se invalida el intento si el precio se aleja del borde y cierra otra vez en el centro, sin salir del rango.`;
  }
  const candlesSince = 0; // la senal es la ultima vela
  const distAtr = status === 'confirmed'
    ? Math.abs(last.close - (up ? hi : lo)) / a
    : Math.min(Math.abs(hi - last.close), Math.abs(last.close - lo)) / a;
  const components = [sat(tight * 3), sat(touches / 2.5), sat(volRatio / 1.2), sat(distance * 3)];
  const rawScore = w.tightness * components[0] + w.touches * components[1] + w.volume * components[2] + w.distance * components[3];
  const scored = scoreStrength('range_breakout', rawScore, { status, components, candlesSince, distAtr, nearWeight: 0.2, nearScale: 4 });
  return [finding({
    id: `range_breakout:${box[0].time}:${status}`,
    kind: 'range_breakout', label: status === 'confirmed' ? 'Ruptura de rango' : 'Rango comprimido',
    explanation: expl, from: box[0].time, to: last.time,
    levels: [{ role: 'range_high', price: r4(hi) }, { role: 'range_low', price: r4(lo) }],
    direction: dir, strength: scored.strength, status,
    evidence: { widthAtr: r4(width / a), touches, volumeRatio: r4(volRatio), bars: L, candlesSince, distAtr: r4(distAtr), exceptional: scored.exceptional },
  })];
}

// ---------- 7. choques ----------
/** Velas con rango verdadero o volumen > k * mediana movil de las `shockWindow` velas previas. */
export function shocks(candles, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const tr = trueRanges(candles);
  const out = [];
  for (let i = 10; i < candles.length; i++) {
    const from = Math.max(0, i - o.shockWindow);
    const mTr = median(tr.slice(from, i)), mV = median(candles.slice(from, i).map((k) => k.volume));
    const rTr = mTr ? tr[i] / mTr : 0, rV = mV ? candles[i].volume / mV : 0;
    const ratio = Math.max(rTr, rV);
    if (ratio <= o.shockK) continue;
    const k = candles[i];
    const n = candles.length - 1;
    const up = k.close >= k.open;
    const price = up ? k.high : k.low;
    const a = atr(candles, o.atrPeriod) || Math.abs(candles[n].close) * 0.001 || 1;
    const candlesSince = n - i;
    const distAtr = Math.abs(price - candles[n].close) / a;
    const mag = sat((ratio - o.shockK) / o.shockK);
    const rawScore = 0.6 * mag + 0.4 * boundedRecency(candlesSince, 25);
    const scored = scoreStrength('shock', rawScore, { status: 'confirmed', candlesSince, distAtr, nearWeight: 0.25, nearScale: 4 });
    const extreme = fmt(price);
    const openPx = fmt(k.open);
    out.push(finding({
      id: `shock:${k.time}`, kind: 'shock', label: 'Vela de choque',
      explanation: `Vela de choque en ${extreme}: ${rTr > o.shockK ? `rango ${rTr.toFixed(1)} veces el normal` : ''}${rTr > o.shockK && rV > o.shockK ? ' y ' : ''}${rV > o.shockK ? `volumen ${rV.toFixed(1)} veces el normal` : ''}, movimiento anómalo ${up ? 'al alza' : 'a la baja'}. Si la vela siguiente cierra por ${up ? 'encima' : 'debajo'} de ${extreme}, el impulso se confirma. Se invalida si el precio devuelve el movimiento y cierra por ${up ? 'debajo' : 'encima'} de ${openPx}.`,
      from: k.time, to: k.time,
      levels: [{ role: 'shock', price }],
      direction: up ? 'up' : 'down', strength: scored.strength, status: 'confirmed',
      evidence: { rangeRatio: r4(rTr), volumeRatio: r4(rV), k: o.shockK, index: i, candlesSince, distAtr: r4(distAtr), exceptional: scored.exceptional },
    }));
  }
  return out.sort((x, y) => y.evidence.index - x.evidence.index).slice(0, o.maxShocks);
}

// ---------- 8. perfil de volumen ----------
export function volumeProfile(candles, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (candles.length < 10) return [];
  const lo = Math.min(...candles.map((k) => k.low)), hi = Math.max(...candles.map((k) => k.high));
  if (!(hi > lo)) return [];
  const nb = o.profileBins, step = (hi - lo) / nb;
  const vol = new Array(nb).fill(0);
  for (const k of candles) {
    const b0 = Math.min(nb - 1, Math.floor((k.low - lo) / step)), b1 = Math.min(nb - 1, Math.floor((k.high - lo) / step));
    const share = k.volume / (b1 - b0 + 1);
    for (let b = b0; b <= b1; b++) vol[b] += share;
  }
  const total = vol.reduce((s, v) => s + v, 0);
  let poc = 0;
  vol.forEach((v, i) => { if (v > vol[poc]) poc = i; });
  let a = poc, b = poc, acc = vol[poc];
  while (acc < 0.7 * total && (a > 0 || b < nb - 1)) { // area de valor 70%
    const up = b < nb - 1 ? vol[b + 1] : -1, dn = a > 0 ? vol[a - 1] : -1;
    if (up >= dn) { b++; acc += vol[b]; } else { a--; acc += vol[a]; }
  }
  const price = (i) => lo + (i + 0.5) * step;
  const last = candles[candles.length - 1].close;
  const pocP = price(poc);
  const val = lo + a * step, vah = lo + (b + 1) * step;
  const atrNow = atr(candles, o.atrPeriod) || Math.abs(last) * 0.001 || 1;
  const distAtr = Math.abs(pocP - last) / atrNow;
  const rawScore = 0.2 + 0.45 * sat(((vol[poc] / total) * nb) / 2);
  const scored = scoreStrength('volume_profile', rawScore, { status: 'confirmed', candlesSince: 0, distAtr, nearWeight: 0.35, nearScale: 4 });
  return [finding({
    id: `volume_profile:${candles[0].time}:${candles[candles.length - 1].time}`,
    kind: 'volume_profile', label: 'Perfil de volumen (POC)',
    explanation: `Perfil de volumen: el precio donde más se negoció es ${fmt(pocP)} (POC), dentro del área de valor ${fmt(val)}–${fmt(vah)}. El precio actual está ${last > pocP ? 'por encima' : 'por debajo'}. Si se acerca y cierra respetando ${fmt(pocP)} como ${last > pocP ? 'soporte' : 'resistencia'}, el nivel se confirma. Se invalida como imán si cierra fuera del área de valor y no regresa.`,
    from: candles[0].time, to: candles[candles.length - 1].time,
    levels: [{ role: 'poc', price: r4(pocP) }, { role: 'vah', price: r4(vah) }, { role: 'val', price: r4(val) }],
    direction: 'neutral', strength: scored.strength, status: 'confirmed',
    evidence: {
      pocShare: r4(vol[poc] / total), bins: vol.map((v, i) => ({ price: r4(price(i)), volume: r4(v) })),
      valueAreaLow: r4(val), valueAreaHigh: r4(vah), candlesSince: 0, distAtr: r4(distAtr), exceptional: scored.exceptional,
    },
  })];
}

// ---------- 9. divergencia RSI ----------
export function rsiDivergence(candles, pivots, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const r = rsi(candles.map((k) => k.close), o.rsiPeriod);
  const a = atr(candles, o.atrPeriod);
  const n = candles.length - 1;
  if (!a) return [];
  const out = [];
  for (const type of ['low', 'high']) {
    const bull = type === 'low';
    const ps = pivots.filter((p) => p.type === type && r[p.index] != null).slice(-3);
    for (let k = 1; k < ps.length; k++) {
      const p1 = ps[k - 1], p2 = ps[k];
      const gap = p2.index - p1.index;
      if (gap < 5 || gap > 60 || p2.index < n - 60) continue;
      const priceDiff = bull ? p1.price - p2.price : p2.price - p1.price;      // >0: nuevo extremo en precio
      const rsiDiff = bull ? r[p2.index] - r[p1.index] : r[p1.index] - r[p2.index]; // >0: el RSI no confirma
      if (priceDiff < 0.1 * a || rsiDiff < 2) continue;
      const after = candles.slice(p2.index + 1);
      if (after.some((x) => (bull ? x.low < p2.price : x.high > p2.price))) continue; // invalidada
      const w = WEIGHTS.divergence;
      const extremity = bull ? clamp01((40 - r[p2.index]) / 20) : clamp01((r[p2.index] - 60) / 20);
      const candlesSince = n - p2.index;
      const between = candles.slice(p1.index, p2.index + 1);
      const confirmPx = bull ? Math.max(...between.map((x) => x.high)) : Math.min(...between.map((x) => x.low));
      const distAtr = Math.abs(candles[n].close - p2.price) / a;
      const components = [sat(rsiDiff / 8), sat(priceDiff / a), sat(extremity * 3.2), boundedRecency(candlesSince, 30)];
      const rawScore = w.rsiGap * components[0] + w.priceGap * components[1] + w.extremity * components[2] + w.recency * components[3];
      const kind = bull ? 'rsi_divergence_bullish' : 'rsi_divergence_bearish';
      const scored = scoreStrength(kind, rawScore, { status: 'confirmed', components, candlesSince, distAtr, nearWeight: 0.2, nearScale: 5 });
      const explanation = bull
        ? `Divergencia alcista del RSI entre ${fmt(p1.price)} y ${fmt(p2.price)}: el precio hizo un mínimo más bajo, pero el RSI subió de ${r[p1.index].toFixed(0)} a ${r[p2.index].toFixed(0)}. Si cierra por encima de ${fmt(confirmPx)}, el rebote se confirma. Se invalida si cierra por debajo de ${fmt(p2.price)}.`
        : `Divergencia bajista del RSI entre ${fmt(p1.price)} y ${fmt(p2.price)}: el precio hizo un máximo más alto, pero el RSI bajó de ${r[p1.index].toFixed(0)} a ${r[p2.index].toFixed(0)}. Si cierra por debajo de ${fmt(confirmPx)}, el retroceso se confirma. Se invalida si cierra por encima de ${fmt(p2.price)}.`;
      out.push(finding({
        id: `rsi_div:${bull ? 'bull' : 'bear'}:${p1.time}:${p2.time}`,
        kind,
        label: bull ? 'Divergencia alcista RSI' : 'Divergencia bajista RSI',
        explanation,
        from: p1.time, to: p2.time,
        levels: [{ role: 'divergence_start', price: r4(p1.price), time: p1.time }, { role: 'divergence_end', price: r4(p2.price), time: p2.time }],
        direction: bull ? 'up' : 'down', strength: scored.strength, status: 'confirmed',
        evidence: {
          rsi1: r4(r[p1.index]), rsi2: r4(r[p2.index]), price1: p1.price, price2: p2.price,
          rsiGap: r4(rsiDiff), priceGapAtr: r4(priceDiff / a), barsBetween: gap,
          candlesSince, distAtr: r4(distAtr), exceptional: scored.exceptional,
        },
      }));
    }
  }
  return out;
}

// ---------- orquestacion ----------
/**
 * Hasta `limit` hallazgos, como mucho `perKind` de cada tipo.
 * Primero los patrones de grafico con fuerza >= 0.4 (doble techo/suelo, triangulo,
 * ruptura, divergencia): son los que pueden completarse. Dentro de ese grupo, y despues
 * en el resto, se prefiere fuerza, cercania al precio y recencia.
 * `findings` sigue siendo la lista completa ordenada solo por strength.
 */
function selectTop(findings, limit, perKind) {
  const tendency = (f) => {
    const since = Number.isFinite(f.evidence?.candlesSince) ? f.evidence.candlesSince : 0;
    const dist = Number.isFinite(f.evidence?.distAtr) ? f.evidence.distAtr : 0;
    const near = Math.exp(-Math.max(0, dist) / 4);
    const recent = Math.exp(-Math.max(0, since) / 40);
    return f.strength * (0.6 + 0.4 * near) * (0.6 + 0.4 * recent);
  };
  const chartLead = (f) => (CHART_KINDS.has(f.kind) && f.strength >= 0.4 ? 1 : 0);
  const ranked = [...findings].sort((a, b) => chartLead(b) - chartLead(a) || tendency(b) - tendency(a) || b.strength - a.strength || b.to - a.to);
  const top = [];
  const counts = new Map();
  for (const f of ranked) {
    const n = counts.get(f.kind) || 0;
    if (n >= perKind) continue;
    top.push(f);
    counts.set(f.kind, n + 1);
    if (top.length >= limit) break;
  }
  return top;
}

/** Sincrona y pura. `findings` va ordenado por `strength` (desc), luego por recencia. `top` es el subconjunto diverso. */
export function analyzeSync({ symbol = '', timeframe = '', candles = [], options = {} } = {}) {
  const o = { ...DEFAULTS, ...options };
  if (!Array.isArray(candles) || candles.length < 20) {
    return { symbol, timeframe, findings: [], top: [], trend: trendOf(candles || [], o), levels: [], pivots: [], hitRate: null };
  }
  const pivots = findPivots(candles, o.pivotWindow);
  const trend = trendOf(candles, o);
  const findings = [
    ...srZones(candles, pivots, o),
    ...doubleTopBottom(candles, pivots, o),
    ...triangles(candles, pivots, o),
    ...rangeBreakout(candles, o),
    ...shocks(candles, o),
    ...volumeProfile(candles, o),
    ...rsiDivergence(candles, pivots, o),
  ].map((f) => ({ ...f, hitRate: historicalHitRate(f.kind, timeframe, symbol), hitRateNote: NO_HISTORY_TEXT }));
  findings.sort((a, b) => b.strength - a.strength || b.to - a.to);
  const top = selectTop(findings, o.topLimit, o.topPerKind);
  const levels = findings.flatMap((f) => f.levels.map((l) => ({ ...l, findingId: f.id, kind: f.kind })));
  return { symbol, timeframe, findings, top, trend, levels, pivots };
}

/** API tipo herramienta: la misma funcion puede envolverse en un servidor MCP. */
export async function analyze(input) {
  const res = analyzeSync(input);
  return {
    findings: res.findings, top: res.top, trend: res.trend, levels: res.levels, pivots: res.pivots,
    symbol: res.symbol, timeframe: res.timeframe, generatedAt: new Date().toISOString(),
  };
}

export const TOOL_SPEC = {
  name: 'analyze_chart',
  description: 'Detecta patrones de precio de forma determinista (pivotes, tendencia, soportes/resistencias, doble techo/suelo, triángulos, rupturas de rango, velas de choque, perfil de volumen, divergencias RSI) y los devuelve ordenados por "fuerza del patrón" (puntuación geométrica 0-1; no es una probabilidad ni una tasa de acierto). Cada hallazgo incluye explicación en español y la evidencia numérica.',
  input_schema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Par de futuros USDⓈ-M, p. ej. BTCUSDT.' },
      timeframe: { type: 'string', enum: ['1m', '5m', '15m', '1h', '4h', '1d'] },
      candles: {
        type: 'array', minItems: 20,
        description: 'Velas ordenadas de la más antigua a la más reciente.',
        items: {
          type: 'object', required: ['time', 'open', 'high', 'low', 'close', 'volume'],
          properties: { time: { type: 'integer', description: 'Segundos UTC de apertura' }, open: { type: 'number' }, high: { type: 'number' }, low: { type: 'number' }, close: { type: 'number' }, volume: { type: 'number' } },
        },
      },
    },
    required: ['symbol', 'timeframe', 'candles'],
  },
  output: 'Objeto {findings[], trend, levels[], pivots[], generatedAt}. findings[].strength es la fuerza del patrón (0-1).',
};
