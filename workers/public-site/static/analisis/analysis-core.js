// analysis-core.js — deteccion determinista de patrones sobre velas. PURO: sin DOM, sin red, sin reloj
// (salvo `generatedAt` en analyze()). Pensado para uso humano (grafico) y para agentes (TOOL_SPEC).
//
// Vela: {time (segundos UTC), open, high, low, close, volume}.
// Hallazgo ("finding"): {id, kind, label, explanation (es), from, to (tiempos), levels, direction
//   (up|down|neutral), strength (0..1), status, evidence:{...numeros}}.
//
// IMPORTANTE: `strength` es la "fuerza del patron": una puntuacion geometrica/estadistica transparente
// (toques, simetria, confirmacion por volumen, cercania a la ruptura). NO es una probabilidad ni una tasa
// de acierto. La tasa de acierto solo vendra de backtests: ver historicalHitRate().

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
      ? `Máximo local en ${fmt(p.price)}: el precio subió hasta aquí y luego retrocedió.`
      : `Mínimo local en ${fmt(p.price)}: el precio bajó hasta aquí y luego rebotó.`,
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
/** Agrupa pivotes cercanos (tolerancia 0.6 ATR) en zonas; cada zona cuenta sus toques. */
export function srZones(candles, pivots, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const a = atr(candles, o.atrPeriod);
  if (!a || pivots.length < 2) return [];
  const tol = 0.6 * a;
  const sorted = [...pivots].sort((x, y) => x.price - y.price);
  const clusters = [];
  for (const p of sorted) {
    const c = clusters[clusters.length - 1];
    if (c && p.price - mean(c.map((q) => q.price)) <= tol) c.push(p); else clusters.push([p]);
  }
  const n = candles.length - 1;
  const last = candles[n].close;
  const out = [];
  for (const c of clusters) {
    if (c.length < 2) continue;
    const prices = c.map((p) => p.price);
    const low = Math.min(...prices), high = Math.max(...prices), price = mean(prices);
    const first = Math.min(...c.map((p) => p.index)), lastIdx = Math.max(...c.map((p) => p.index));
    const w = WEIGHTS.sr;
    const touches = c.length;
    const strength = w.touches * clamp01(touches / 5) + w.recency * clamp01(1 - (n - lastIdx) / 200) + w.age * clamp01((lastIdx - first) / 100);
    const role = price < last ? 'support' : 'resistance';
    out.push(finding({
      id: `sr:${role}:${Math.round(price * 100)}`,
      kind: 'sr_zone',
      label: role === 'support' ? 'Zona de soporte' : 'Zona de resistencia',
      explanation: role === 'support'
        ? `El precio rebotó ${touches} veces cerca de ${fmt(price)}. Si lo pierde, esa zona deja de sostenerlo.`
        : `El precio fue frenado ${touches} veces cerca de ${fmt(price)}. Si lo supera, esa zona deja de frenarlo.`,
      from: candles[first].time, to: candles[n].time,
      levels: [{ role, price: r4(price), low: r4(low), high: r4(high), touches }],
      direction: 'neutral', strength, status: 'confirmed',
      evidence: { touches, low: r4(low), high: r4(high), firstIndex: first, lastIndex: lastIdx, tolerance: r4(tol) },
    }));
  }
  return out;
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
    const strength = w.symmetry * clamp01(1 - diff / tol) + w.depth * clamp01(depth / 4)
      + w.proximity * (broken ? clamp01(1 - (distNeck - 0) / 1.5) : clamp01(1 - distNeck))
      + w.volume * (volRatio < 1 ? 1 : 0.4) + w.recency * clamp01(1 - (n - p2.index) / o.lookbackPatterns);
    out.push(finding({
      id: `${top ? 'double_top' : 'double_bottom'}:${p1.time}:${p2.time}`,
      kind: top ? 'double_top' : 'double_bottom',
      label: top ? 'Doble techo' : 'Doble suelo',
      explanation: top
        ? `Dos máximos casi iguales (${fmt(p1.price)} y ${fmt(p2.price)}). ${broken ? 'El precio ya rompió la línea de cuello: señal de giro a la baja.' : `Si el precio rompe ${fmt(neck)} hacia abajo, el patrón se confirma.`}`
        : `Dos mínimos casi iguales (${fmt(p1.price)} y ${fmt(p2.price)}). ${broken ? 'El precio ya rompió la línea de cuello: señal de giro al alza.' : `Si el precio rompe ${fmt(neck)} hacia arriba, el patrón se confirma.`}`,
      from: p1.time, to: candles[n].time,
      levels: [
        { role: 'neckline', price: r4(neck) },
        { role: top ? 'peak' : 'trough', price: r4(p1.price), time: p1.time },
        { role: top ? 'peak' : 'trough', price: r4(p2.price), time: p2.time },
      ],
      direction: top ? 'down' : 'up', strength, status: broken ? 'confirmed' : 'forming',
      evidence: { peak1: p1.price, peak2: p2.price, diffAtr: r4(diff / a), depthAtr: r4(depth), neckline: r4(neck), distToNeckline: r4(distNeck), volumeRatio2vs1: r4(volRatio), broken },
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
  const strength = w.touches * clamp01(touches / 6) + w.fit * fit + w.convergence * convergence + w.proximity * proximity;
  const names = {
    ascending_triangle: ['Triángulo ascendente', 'Techo horizontal y mínimos cada vez más altos: los compradores presionan. Suele resolverse con ruptura al alza, aunque puede fallar.'],
    descending_triangle: ['Triángulo descendente', 'Suelo horizontal y máximos cada vez más bajos: los vendedores presionan. Suele resolverse con ruptura a la baja, aunque puede fallar.'],
    symmetric_triangle: ['Triángulo simétrico', 'El rango se estrecha por ambos lados: el mercado se comprime y se espera una ruptura, sin dirección definida de antemano.'],
  };
  return [finding({
    id: `${kind}:${candles[x0].time}`,
    kind, label: names[kind][0],
    explanation: names[kind][1],
    from: candles[x0].time, to: candles[n].time,
    levels: [
      { role: 'triangle_upper', price: r4(upper), line: { from: { time: candles[x0].time, price: r4(hi(x0)) }, to: { time: candles[n].time, price: r4(upper) } } },
      { role: 'triangle_lower', price: r4(lower), line: { from: { time: candles[x0].time, price: r4(lo(x0)) }, to: { time: candles[n].time, price: r4(lower) } } },
    ],
    direction: bias, strength, status: 'forming',
    evidence: { touchesHigh: hs.length, touchesLow: ls.length, fit: r4(fit), convergence: r4(convergence), widthStart: r4(w0), widthNow: r4(w1), distToBreakout: r4(dist) },
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
    expl = `El precio salió del rango ${fmt(lo)}–${fmt(hi)} hacia ${up ? 'arriba' : 'abajo'}${volRatio >= 1.5 ? ' con volumen alto, lo que refuerza la ruptura' : ' pero sin volumen especial, así que puede ser falsa'}.`;
  } else {
    const dHi = hi - last.close, dLo = last.close - lo;
    if (Math.min(dHi, dLo) > 0.2 * width) return []; // lejos de los bordes: no hay nada que decir
    dir = dHi < dLo ? 'up' : 'down'; status = 'forming';
    distance = clamp01(1 - Math.min(dHi, dLo) / (0.2 * width));
    expl = `El precio lleva ${L} velas en el rango ${fmt(lo)}–${fmt(hi)} y está pegado al borde ${dir === 'up' ? 'superior' : 'inferior'}: vigila una posible ruptura.`;
  }
  const strength = w.tightness * tight + w.touches * clamp01(touches / 6) + w.volume * clamp01(volRatio / 2) + w.distance * distance;
  return [finding({
    id: `range_breakout:${box[0].time}:${status}`,
    kind: 'range_breakout', label: status === 'confirmed' ? 'Ruptura de rango' : 'Rango comprimido',
    explanation: expl, from: box[0].time, to: last.time,
    levels: [{ role: 'range_high', price: r4(hi) }, { role: 'range_low', price: r4(lo) }],
    direction: dir, strength, status,
    evidence: { widthAtr: r4(width / a), touches, volumeRatio: r4(volRatio), bars: L },
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
    const strength = 0.25 + 0.5 * clamp01((ratio - o.shockK) / (2 * o.shockK));
    const up = k.close >= k.open;
    out.push(finding({
      id: `shock:${k.time}`, kind: 'shock', label: 'Vela de choque',
      explanation: `${rTr > o.shockK ? `Rango ${rTr.toFixed(1)} veces el normal` : ''}${rTr > o.shockK && rV > o.shockK ? ' y ' : ''}${rV > o.shockK ? `volumen ${rV.toFixed(1)} veces el normal` : ''}: movimiento anómalo, ${up ? 'empujado al alza' : 'empujado a la baja'}. Suele marcar noticias o liquidaciones.`,
      from: k.time, to: k.time,
      levels: [{ role: 'shock', price: up ? k.high : k.low }],
      direction: up ? 'up' : 'down', strength, status: 'confirmed',
      evidence: { rangeRatio: r4(rTr), volumeRatio: r4(rV), k: o.shockK, index: i },
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
  return [finding({
    id: `volume_profile:${candles[0].time}:${candles[candles.length - 1].time}`,
    kind: 'volume_profile', label: 'Perfil de volumen (POC)',
    explanation: `El precio donde más se negoció es ${fmt(pocP)} (POC). El precio actual está ${last > pocP ? 'por encima' : 'por debajo'}: ese nivel suele actuar como imán o como soporte/resistencia.`,
    from: candles[0].time, to: candles[candles.length - 1].time,
    levels: [{ role: 'poc', price: r4(pocP) }, { role: 'vah', price: r4(lo + (b + 1) * step) }, { role: 'val', price: r4(lo + a * step) }],
    direction: 'neutral', strength: 0.15 + 0.35 * clamp01((vol[poc] / total) * nb / 4), status: 'confirmed',
    evidence: { pocShare: r4(vol[poc] / total), bins: vol.map((v, i) => ({ price: r4(price(i)), volume: r4(v) })), valueAreaLow: r4(lo + a * step), valueAreaHigh: r4(lo + (b + 1) * step) },
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
      const strength = w.rsiGap * clamp01(rsiDiff / 15) + w.priceGap * clamp01(priceDiff / a / 2) + w.extremity * extremity + w.recency * clamp01(1 - (n - p2.index) / 60);
      out.push(finding({
        id: `rsi_div:${bull ? 'bull' : 'bear'}:${p1.time}:${p2.time}`,
        kind: bull ? 'rsi_divergence_bullish' : 'rsi_divergence_bearish',
        label: bull ? 'Divergencia alcista RSI' : 'Divergencia bajista RSI',
        explanation: bull
          ? `El precio hizo un mínimo más bajo, pero el RSI hizo uno más alto (${r[p1.index].toFixed(0)} a ${r[p2.index].toFixed(0)}): la presión vendedora se agota y podría haber un rebote.`
          : `El precio hizo un máximo más alto, pero el RSI hizo uno más bajo (${r[p1.index].toFixed(0)} a ${r[p2.index].toFixed(0)}): la fuerza compradora se agota y podría haber un retroceso.`,
        from: p1.time, to: p2.time,
        levels: [{ role: 'divergence_start', price: r4(p1.price), time: p1.time }, { role: 'divergence_end', price: r4(p2.price), time: p2.time }],
        direction: bull ? 'up' : 'down', strength, status: 'confirmed',
        evidence: { rsi1: r4(r[p1.index]), rsi2: r4(r[p2.index]), price1: p1.price, price2: p2.price, rsiGap: r4(rsiDiff), priceGapAtr: r4(priceDiff / a), barsBetween: gap },
      }));
    }
  }
  return out;
}

// ---------- orquestacion ----------
/** Sincrona y pura. Devuelve hallazgos ordenados por `strength` (desc), luego por recencia. */
export function analyzeSync({ symbol = '', timeframe = '', candles = [], options = {} } = {}) {
  const o = { ...DEFAULTS, ...options };
  if (!Array.isArray(candles) || candles.length < 20) {
    return { symbol, timeframe, findings: [], trend: trendOf(candles || [], o), levels: [], pivots: [], hitRate: null };
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
  const levels = findings.flatMap((f) => f.levels.map((l) => ({ ...l, findingId: f.id, kind: f.kind })));
  return { symbol, timeframe, findings, trend, levels, pivots };
}

/** API tipo herramienta: la misma funcion puede envolverse en un servidor MCP. */
export async function analyze(input) {
  const res = analyzeSync(input);
  return { findings: res.findings, trend: res.trend, levels: res.levels, pivots: res.pivots, symbol: res.symbol, timeframe: res.timeframe, generatedAt: new Date().toISOString() };
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
