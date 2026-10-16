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
//   1) patron de grafico o de estructura ya confirmado (CHART_KINDS): doble techo/suelo, triangulo,
//      ruptura de rango, divergencia RSI, hombro-cabeza-hombro, cuña, bandera, FVG, BOS/CHoCH,
//      order block o barrido de liquidez
//      (una zona S/R, un choque, un pivote, una vela suelta o el perfil de volumen nunca es excepcional);
//   2) cada componente acotado >= 0.97;
//   3) la formacion termina hace 3 velas o menos;
//   4) el precio esta a 0.25 ATR(14) o menos del nivel de decision.
//
// Fuentes de las reglas (codigo propio; no se copia implementacion ajena). Ver docs/PATTERN_SOURCES.md.
// - FVG, BOS/CHoCH, order block, liquidez: definiciones publicas de
//   joshyattridge/smart-money-concepts (MIT) https://github.com/joshyattridge/smart-money-concepts
// - Velas: definiciones CDL* de TA-Lib (BSD-3-Clause) https://github.com/TA-Lib/ta-lib
//   CDLENGULFING, CDLHAMMER, CDLSHOOTINGSTAR, CDLMORNINGSTAR, CDLEVENINGSTAR, CDLDOJI.
//   En cripto 24h no exigimos el hueco de apertura de la estrella de la mañana/tarde.
// - Hombro-cabeza-hombro, cuñas y banderas: geometria clasica (Bulkowski, Encyclopedia of Chart
//   Patterns). PatternPy y TradingPatternScanner son CC BY-NC-SA: no se copia su codigo.
// Las zonas S/R tienen ademas el tope srStrengthCap (0.74): con evidencia comparable quedan por debajo
// de un doble techo/suelo, triangulo, ruptura o divergencia. La recencia decae con las velas desde el
// ultimo toque o la formacion; la distancia al precio actual resta fuerza (mas en las zonas).

export const DEFAULTS = {
  pivotWindow: 3,       // velas a cada lado para un pivote fractal
  atrPeriod: 14,
  shockK: 3,            // umbral k * mediana para velas de choque
  shockWindow: 50,      // ventana de la mediana movil
  shockBuyShare: 0.65,  // participacion del lado comprador (taker) que hace de un choque una compra agresiva
  shockSellShare: 0.35, // participacion del lado comprador por debajo de la cual el choque es venta agresiva
  absorptionMaxRangeAt: 0.7, // rango maximo (x ATR) de una vela de absorcion (rango diminuto)
  climaxLookback: 20,   // velas hacia atras para medir un movimiento extendido
  climaxDrift: 1.5,     // desplazamiento neto (x ATR) que se considera extendido
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
  fvg: { displacement: 0.35, gap: 0.25, proximity: 0.25, recency: 0.15 },
  structure: { breakSize: 0.4, clarity: 0.35, recency: 0.25 },
  orderBlock: { impulse: 0.4, freshness: 0.3, proximity: 0.3 },
  liquidity: { equality: 0.3, sweep: 0.4, recency: 0.3 },
  hs: { symmetry: 0.35, prominence: 0.3, neck: 0.2, recency: 0.15 },
  wedge: { fit: 0.3, convergence: 0.3, proximity: 0.25, recency: 0.15 },
  flag: { pole: 0.4, retrace: 0.3, tightness: 0.2, recency: 0.1 },
  candle: { shape: 0.55, context: 0.25, recency: 0.2 },
  volumeShock: { volume: 0.5, share: 0.2, recency: 0.3 },
  absorption: { volume: 0.4, range: 0.2, context: 0.2, recency: 0.2 },
  delta: { priceGap: 0.3, conviction: 0.3, proximity: 0.15, recency: 0.25 },
  climax: { extension: 0.3, volume: 0.3, reversal: 0.25, recency: 0.15 },
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
export const NO_HISTORY_TEXT = 'no superó al azar en nuestra medición (2026-10)';
export const UNMEASURED_TEXT = 'aún no medido';

/**
 * Tipos de patrones medidos en el estudio público con n >= 30 eventos (HOLDOUT x bucket-all).
 * Fuente: research/hitrates/results/hit-rates.public.json
 */
export const MEASURED_KINDS = Object.freeze(new Set([
  'ascending_triangle',
  'bear_flag',
  'bull_flag',
  'candle_doji',
  'descending_triangle',
  'double_bottom',
  'double_top',
  'falling_wedge',
  'range_breakout',
  'rising_wedge',
  'rsi_divergence_bearish',
  'rsi_divergence_bullish',
  'shock',
  'symmetric_triangle',
]));

export const HIT_RATE_NOTES = Object.freeze(
  Object.fromEntries([...MEASURED_KINDS].map((k) => [k, NO_HISTORY_TEXT]))
);

export function hitRateNote(kind) {
  return (kind && HIT_RATE_NOTES[kind]) ? HIT_RATE_NOTES[kind] : UNMEASURED_TEXT;
}

// ---------- utilidades ----------
const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const r4 = (x) => Math.round(x * 1e4) / 1e4;
/**
 * Decimales de un precio: al menos 4 (como r4, así BTC no cambia) y, para precios bajos,
 * los necesarios para 8 cifras significativas (PEPE ~0.004 necesita 10 decimales).
 */
const priceDecimals = (x) => Math.max(4, 8 - Math.floor(Math.log10(Math.abs(x))) - 1);
/** Redondeo de PRECIOS: nunca destruye los dígitos de un precio bajo. Usar solo para precios. */
const rp = (x) => (Number.isFinite(x) && x !== 0 ? Math.round(x * 10 ** priceDecimals(x)) / 10 ** priceDecimals(x) : x);
/**
 * Formato de la escala de precios (lightweight-charts priceFormat): decimales para 6 cifras
 * significativas del precio actual, mínimo 2 y máximo 10. PEPE ~0,0041 necesita 8 decimales.
 */
export function chartPriceFormat(price) {
  if (!Number.isFinite(price) || price <= 0) return { type: 'price', precision: 2, minMove: 0.01 };
  const precision = Math.min(10, Math.max(2, 5 - Math.floor(Math.log10(price))));
  return { type: 'price', precision, minMove: 10 ** -precision };
}
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
export function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/** Texto de precio: igual que el numero publicado (mismos decimales que rp) para precios bajos. */
const fmt = (p) => {
  if (!Number.isFinite(p) || p === 0) return p.toPrecision(4);
  if (Math.abs(p) >= 100) return p.toFixed(1);
  if (Math.abs(p) >= 1) return p.toFixed(3);
  return rp(p).toFixed(priceDecimals(p)).replace(/\.?0+$/, '');
};

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

/** Copia precios de decision del backtest en cada nivel: `confirm` e `invalidate`. */
function stamp(levels, confirm, invalidate) {
  const c = rp(confirm), inv = rp(invalidate);
  return levels.map((l) => ({ ...l, confirm: c, invalidate: inv }));
}

/** 1-exp(-x): acota en [0, 1) y no se satura con un conteo grande. */
const sat = (x) => 1 - Math.exp(-Math.max(0, Number.isFinite(x) ? x : 0));

/** Recencia acotada: vela actual ≈ 0.98; decae con las velas transcurridas y nunca llega a 1. */
const boundedRecency = (candlesSince, halfLife = 40) => sat(4 * Math.exp(-Math.max(0, candlesSince) / halfLife));

export const CHART_KINDS = new Set([
  'double_top', 'double_bottom',
  'ascending_triangle', 'descending_triangle', 'symmetric_triangle',
  'range_breakout',
  'rsi_divergence_bullish', 'rsi_divergence_bearish',
  'head_shoulders', 'inverse_head_shoulders',
  'rising_wedge', 'falling_wedge',
  'bull_flag', 'bear_flag',
  'fvg_bullish', 'fvg_bearish',
  'bos_bullish', 'bos_bearish', 'choch_bullish', 'choch_bearish',
  'order_block_bullish', 'order_block_bearish',
  'liquidity_sweep_bullish', 'liquidity_sweep_bearish',
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
  if (typeof kind === 'string' && kind.startsWith('candle_')) strength = Math.min(strength, 0.68);
  // Flujo de volumen (agresion del tape): techos propios, por debajo de un patron de grafico.
  // No entran en CHART_KINDS: con evidencia comparable quedan por debajo de doble techo, ruptura o divergencia.
  if (kind === 'volume_shock_buy' || kind === 'volume_shock_sell') strength = Math.min(strength, 0.66);
  if (kind === 'delta_divergence_bullish' || kind === 'delta_divergence_bearish') strength = Math.min(strength, 0.82);
  if (kind === 'absorption') strength = Math.min(strength, 0.7);
  if (kind === 'climax') strength = Math.min(strength, 0.72);
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
    levels: stamp(
      [{ role: p.type === 'high' ? 'pivot_high' : 'pivot_low', price: rp(p.price) }],
      p.price,
      p.price,
    ),
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
    evidence: { ema20: rp(e20[n]), ema50: rp(e50[n]), spread: rp(spread), slope10: r4(slope), structure, votes, close: last },
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
      id: `sr:${role}:${rp(price)}`,
      kind: 'sr_zone',
      label: role === 'support' ? 'Zona de soporte' : 'Zona de resistencia',
      explanation,
      from: candles[first].time, to: candles[n].time,
      levels: stamp(
        [{ role, price: rp(price), low: rp(low), high: rp(high), touches }],
        role === 'support' ? high : low,
        role === 'support' ? low : high,
      ),
      direction: 'neutral', strength: scored.strength, status: 'confirmed',
      evidence: {
        touches, low: rp(low), high: rp(high), firstIndex: first, lastIndex: lastIdx,
        tolerance: rp(tol), mergeGap: rp(mergeGap), mergedFrom: parts,
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
      levels: stamp([
        { role: 'neckline', price: rp(neck) },
        { role: top ? 'peak' : 'trough', price: rp(p1.price), time: p1.time },
        { role: top ? 'peak' : 'trough', price: rp(p2.price), time: p2.time },
      ], neck, extreme),
      direction: top ? 'down' : 'up', strength: scored.strength, status,
      evidence: {
        peak1: rp(p1.price), peak2: rp(p2.price), diffAtr: r4(diff / a), depthAtr: r4(depth), neckline: rp(neck),
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
  const confirmPx = kind === 'descending_triangle' ? lower : upper;
  const invalidatePx = kind === 'descending_triangle' ? upper : lower;
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
    levels: stamp([
      { role: 'triangle_upper', price: rp(upper), line: { from: { time: candles[x0].time, price: rp(hi(x0)) }, to: { time: candles[n].time, price: rp(upper) } } },
      { role: 'triangle_lower', price: rp(lower), line: { from: { time: candles[x0].time, price: rp(lo(x0)) }, to: { time: candles[n].time, price: rp(lower) } } },
    ], confirmPx, invalidatePx),
    direction: bias, strength: scored.strength, status: 'forming',
    evidence: {
      touchesHigh: hs.length, touchesLow: ls.length, fit: r4(fit), convergence: r4(convergence),
      widthStart: rp(w0), widthNow: rp(w1), distToBreakout: r4(dist),
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
  let dir, status, distance, expl, confirmPx, invalidatePx;
  if (up || down) {
    dir = up ? 'up' : 'down'; status = 'confirmed';
    confirmPx = up ? hi + width : lo - width;
    invalidatePx = up ? hi : lo;
    const excess = (up ? last.close - hi : lo - last.close) / a;
    distance = clamp01(1 - excess / 2); // muy extendido = persecucion tardia
    const back = up ? `por debajo de ${fmt(hi)}` : `por encima de ${fmt(lo)}`;
    const hold = up ? `por encima de ${fmt(hi)}` : `por debajo de ${fmt(lo)}`;
    expl = `Ruptura de rango ${fmt(lo)}–${fmt(hi)}: el precio salió hacia ${up ? 'arriba' : 'abajo'}${volRatio >= 1.5 ? ' con volumen alto' : ' sin volumen especial'}. Si sigue y cierra ${hold}, la ruptura se mantiene. Se invalida si cierra de nuevo ${back}, de vuelta dentro del rango.`;
  } else {
    const dHi = hi - last.close, dLo = last.close - lo;
    if (Math.min(dHi, dLo) > 0.2 * width) return []; // lejos de los bordes: no hay nada que decir
    dir = dHi < dLo ? 'up' : 'down'; status = 'forming';
    confirmPx = dir === 'up' ? hi : lo;
    invalidatePx = dir === 'up' ? lo : hi;
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
    levels: stamp([{ role: 'range_high', price: rp(hi) }, { role: 'range_low', price: rp(lo) }], confirmPx, invalidatePx),
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
      levels: stamp([{ role: 'shock', price }], price, k.open),
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
    levels: stamp(
      [{ role: 'poc', price: rp(pocP) }, { role: 'vah', price: rp(vah) }, { role: 'val', price: rp(val) }],
      pocP,
      last >= pocP ? val : vah,
    ),
    direction: 'neutral', strength: scored.strength, status: 'confirmed',
    evidence: {
      pocShare: r4(vol[poc] / total), bins: vol.map((v, i) => ({ price: rp(price(i)), volume: r4(v) })),
      valueAreaLow: rp(val), valueAreaHigh: rp(vah), candlesSince: 0, distAtr: r4(distAtr), exceptional: scored.exceptional,
    },
  })];
}

// ---------- 8b. flujo de volumen: agresión del tape (delta, CVD, absorción, clímax) ----------
// Binance futuros expone por vela el volumen de compra agresiva (taker buy base volume, índice 9)
// y el número de trades (índice 8). Con el taker buy volume se construye el flujo:
//   delta    = 2·takerBuy − volume   (comprador − vendedor por mercado en esa vela)
//   cvd      = suma acumulada de delta (línea de presión compradora neta)
//   buyShare = takerBuy / volume     (fracción del volumen del lado comprador agresivo)
// Sin takerBuyVolume (velas antiguas) NO se inventa nada: volumeFlow devuelve null y los cuatro
// detectores de aquí no publican nada (compatibilidad hacia atrás). strength = calidad de
// evidencia (magnitud, convicción, recencia, cercanía), nunca una probabilidad.

/**
 * Series por vela del flujo de volumen (puro, sin red ni reloj). `null` si ninguna vela trae
 * takerBuyVolume. Las velas sin dato aportan delta 0 y buyShare null (el CVD se mantiene).
 */
export function volumeFlow(candles) {
  if (!Array.isArray(candles) || !candles.length) return null;
  if (!candles.some((k) => Number.isFinite(k.takerBuyVolume) && Number.isFinite(k.volume) && k.volume > 0)) return null;
  const delta = [], cvd = [], buyShare = [];
  let acc = 0;
  for (const k of candles) {
    const has = Number.isFinite(k.takerBuyVolume) && Number.isFinite(k.volume) && k.volume > 0;
    const d = has ? 2 * k.takerBuyVolume - k.volume : 0;
    const share = has ? k.takerBuyVolume / k.volume : null;
    acc += d;
    delta.push(r4(d));
    cvd.push(r4(acc));
    buyShare.push(share == null ? null : r4(share));
  }
  return { delta, cvd, buyShare };
}

/** Mediana móvil del volumen de las `window` velas previas a `i` (sin incluir la vela actual). */
function rollingMedianVolume(candles, i, window) {
  const from = Math.max(0, i - window);
  return median(candles.slice(from, i).map((k) => k.volume));
}

/** Choques de volumen con sesgo de agresión: volumen > k·mediana y el tape sesga compra o venta. */
export function volumeShocks(candles, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const flow = volumeFlow(candles);
  if (!flow) return [];
  const n = candles.length - 1;
  const a = atr(candles, o.atrPeriod);
  if (!a) return [];
  const w = WEIGHTS.volumeShock;
  const groups = { volume_shock_buy: [], volume_shock_sell: [] };
  for (let i = 10; i < candles.length; i++) {
    const medV = rollingMedianVolume(candles, i, o.shockWindow);
    if (!(medV > 0) || !(candles[i].volume > o.shockK * medV)) continue;
    const share = flow.buyShare[i];
    if (share == null) continue;
    const buy = share >= o.shockBuyShare, sell = share <= o.shockSellShare;
    if (buy === sell) continue; // nunca true&&true; si ambos false (sin sesgo claro) se salta
    const k = candles[i];
    const rV = k.volume / medV;
    const magS = sat((rV - o.shockK) / o.shockK);
    const edge = buy ? share - o.shockBuyShare : o.shockSellShare - share;
    const shareS = sat(edge * 5);
    const candlesSince = n - i;
    const price = buy ? k.high : k.low;
    const distAtr = Math.abs(price - candles[n].close) / a;
    const confirmPx = buy ? k.high : k.low;
    const invalidatePx = buy ? k.low : k.high;
    const kind = buy ? 'volume_shock_buy' : 'volume_shock_sell';
    const raw = w.volume * magS + w.share * shareS + w.recency * boundedRecency(candlesSince, 25);
    const scored = scoreStrength(kind, raw, { status: 'confirmed', candlesSince, distAtr, nearWeight: 0.25, nearScale: 4 });
    const sidePct = Math.round((buy ? share : 1 - share) * 100);
    const thPct = Math.round((buy ? o.shockBuyShare : o.shockSellShare) * 100);
    const explanation = buy
      ? `Compra agresiva en ${fmt(k.close)}: volumen ${rV.toFixed(1)}× lo normal con el ${sidePct}% del volumen del lado comprador (por encima de ${thPct}%). La demanda entró con fuerza. Si la vela siguiente cierra por encima de ${fmt(confirmPx)}, el impulso se confirma. Se invalida si cierra por debajo de ${fmt(invalidatePx)}.`
      : `Venta agresiva en ${fmt(k.close)}: volumen ${rV.toFixed(1)}× lo normal con el ${sidePct}% del volumen del lado vendedor (participación de compra por debajo de ${thPct}%). La oferta salió con fuerza. Si la vela siguiente cierra por debajo de ${fmt(confirmPx)}, el impulso se confirma. Se invalida si cierra por encima de ${fmt(invalidatePx)}.`;
    groups[kind].push(finding({
      id: `${kind}:${k.time}`, kind, label: buy ? 'Compra agresiva' : 'Venta agresiva',
      explanation, from: k.time, to: k.time,
      levels: stamp([{ role: 'volume_shock', price: rp(k.close) }], confirmPx, invalidatePx),
      direction: buy ? 'up' : 'down', strength: scored.strength, status: 'confirmed',
      evidence: { index: i, volumeRatio: r4(rV), buyShare: r4(share), k: o.shockK, candlesSince, distAtr: r4(distAtr), exceptional: scored.exceptional },
    }));
  }
  const cap = (arr) => arr.slice(0, o.maxShocks);
  return [...cap(groups.volume_shock_buy), ...cap(groups.volume_shock_sell)];
}

/** Divergencia de delta: el precio hace un nuevo extremo pero el CVD (flujo) no lo acompaña. */
export function deltaDivergence(candles, pivots, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const flow = volumeFlow(candles);
  if (!flow) return [];
  const a = atr(candles, o.atrPeriod);
  const n = candles.length - 1;
  if (!a) return [];
  const cvd = flow.cvd;
  const w = WEIGHTS.delta;
  const out = [];
  for (const type of ['low', 'high']) {
    const bull = type === 'low';
    const ps = pivots.filter((p) => p.type === type).slice(-3);
    for (let k = 1; k < ps.length; k++) {
      const p1 = ps[k - 1], p2 = ps[k];
      const gap = p2.index - p1.index;
      if (gap < 5 || gap > 60 || p2.index < n - o.lookbackPatterns) continue;
      const priceDiff = bull ? p1.price - p2.price : p2.price - p1.price;                 // >0: nuevo extremo en precio
      const cvdDiff = bull ? cvd[p2.index] - cvd[p1.index] : cvd[p1.index] - cvd[p2.index]; // >0: el CVD diverge del precio
      if (priceDiff < 0.1 * a || cvdDiff <= 0) continue;
      const after = candles.slice(p2.index + 1);
      if (after.some((x) => (bull ? x.low < p2.price : x.high > p2.price))) continue; // invalidada: el extremo se superó
      let gross = 0;
      for (let i = p1.index; i <= p2.index; i++) gross += Math.abs(flow.delta[i]);
      const conviction = gross > 0 ? Math.min(1, Math.abs(cvdDiff) / gross) : 0;
      const candlesSince = n - p2.index;
      const between = candles.slice(p1.index, p2.index + 1);
      const confirmPx = bull ? Math.max(...between.map((x) => x.high)) : Math.min(...between.map((x) => x.low));
      const distAtr = Math.abs(candles[n].close - p2.price) / a;
      const components = [sat(priceDiff / a), sat(conviction * 4), sat(3 * Math.exp(-distAtr / 2)), boundedRecency(candlesSince, 35)];
      const raw = w.priceGap * components[0] + w.conviction * components[1] + w.proximity * components[2] + w.recency * components[3];
      const kind = bull ? 'delta_divergence_bullish' : 'delta_divergence_bearish';
      const scored = scoreStrength(kind, raw, { status: 'confirmed', components, candlesSince, distAtr, nearWeight: 0.2, nearScale: 5 });
      const explanation = bull
        ? `Divergencia de delta alcista entre ${fmt(p1.price)} y ${fmt(p2.price)}: el precio hizo un mínimo más bajo, pero el flujo comprador agresivo (CVD) subió de ${cvd[p1.index].toFixed(0)} a ${cvd[p2.index].toFixed(0)}: hay compra sostenida dentro de la caída. Si cierra por encima de ${fmt(confirmPx)}, el rebote se confirma. Se invalida si cierra por debajo de ${fmt(p2.price)}.`
        : `Divergencia de delta bajista entre ${fmt(p1.price)} y ${fmt(p2.price)}: el precio hizo un máximo más alto, pero el flujo comprador agresivo (CVD) bajó de ${cvd[p1.index].toFixed(0)} a ${cvd[p2.index].toFixed(0)}: hay venta sostenida dentro de la subida. Si cierra por debajo de ${fmt(confirmPx)}, el retroceso se confirma. Se invalida si cierra por encima de ${fmt(p2.price)}.`;
      out.push(finding({
        id: `delta_div:${bull ? 'bull' : 'bear'}:${p1.time}:${p2.time}`, kind,
        label: bull ? 'Divergencia de delta alcista' : 'Divergencia de delta bajista',
        explanation, from: p1.time, to: p2.time,
        levels: stamp([
          { role: 'divergence_start', price: rp(p1.price), time: p1.time },
          { role: 'divergence_end', price: rp(p2.price), time: p2.time },
        ], confirmPx, p2.price),
        direction: bull ? 'up' : 'down', strength: scored.strength, status: 'confirmed',
        evidence: {
          price1: rp(p1.price), price2: rp(p2.price), cvd1: r4(cvd[p1.index]), cvd2: r4(cvd[p2.index]),
          cvdGap: r4(cvdDiff), priceGapAtr: r4(priceDiff / a), conviction: r4(conviction),
          barsBetween: gap, candlesSince, distAtr: r4(distAtr), exceptional: scored.exceptional,
        },
      }));
    }
  }
  return out;
}

/** Zona de un rol concreto solapa la vela (tolerancia 0.35 ATR), igual que las velas clásicas. */
function zoneRoleNear(zones, k, a, role) {
  return zones.some((z) => {
    const lv = z.levels?.[0];
    if (!lv || lv.role !== role) return false;
    const low = Number.isFinite(lv.low) ? lv.low : lv.price;
    const high = Number.isFinite(lv.high) ? lv.high : lv.price;
    return k.low <= high + 0.35 * a && k.high >= low - 0.35 * a;
  });
}

/** Absorción: volumen alto con rango mínimo en un swing o en una zona S/R. Un lado frena al otro. */
export function absorption(candles, pivots, zones = [], opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const flow = volumeFlow(candles);
  if (!flow) return [];
  const n = candles.length - 1;
  const a = atr(candles, o.atrPeriod);
  if (!a) return [];
  const w = WEIGHTS.absorption;
  const maxRange = o.absorptionMaxRangeAt * a;
  const best = { buyers: null, sellers: null };
  for (let i = Math.max(5, n - 60); i <= n; i++) {
    const k = candles[i];
    const range = k.high - k.low;
    if (!(range > 0) || range > maxRange) continue;              // rango diminuto
    const medV = rollingMedianVolume(candles, i, o.shockWindow);
    if (!(medV > 0) || !(k.volume >= o.shockK * medV)) continue; // volumen alto
    const rV = k.volume / medV;
    const lowSwing = candleContext(candles, pivots, zones, i, 'low', a).swing;
    const highSwing = candleContext(candles, pivots, zones, i, 'high', a).swing;
    const inSupport = zoneRoleNear(zones, k, a, 'support');
    const inResist = zoneRoleNear(zones, k, a, 'resistance');
    let side = null;
    if (lowSwing && !highSwing) side = 'buyers';
    else if (highSwing && !lowSwing) side = 'sellers';
    else if (inSupport && !inResist) side = 'buyers';
    else if (inResist && !inSupport) side = 'sellers';
    if (!side) continue;
    const buyers = side === 'buyers';
    const share = flow.buyShare[i];
    const volS = sat((rV - o.shockK) / o.shockK);
    const rangeS = sat((1 - range / maxRange) * 3);
    const swing = buyers ? lowSwing : highSwing;
    const zone = buyers ? inSupport : inResist;
    const contextScore = swing && zone ? 1 : swing ? 0.85 : 0.7;
    const candlesSince = n - i;
    const distAtr = Math.abs(candles[n].close - k.close) / a;
    const raw = w.volume * volS + w.range * rangeS + w.context * sat(contextScore * 3) + w.recency * boundedRecency(candlesSince, 25);
    const scored = scoreStrength('absorption', raw, { status: 'confirmed', candlesSince, distAtr, nearWeight: 0.25, nearScale: 3 });
    const item = { i, k, rV, range, share, candlesSince, distAtr, scored, lowSwing, highSwing, inSupport, inResist };
    if (!best[side] || scored.strength > best[side].scored.strength) best[side] = item;
  }
  const out = [];
  for (const side of ['buyers', 'sellers']) {
    const it = best[side];
    if (!it) continue;
    const k = it.k;
    const buyers = side === 'buyers';
    const confirmPx = buyers ? k.high : k.low;
    const invalidatePx = buyers ? k.low : k.high;
    const where = buyers ? 'un mínimo o soporte' : 'un máximo o resistencia';
    const explanation = buyers
      ? `Absorción compradora en ${fmt(k.close)}: volumen ${it.rV.toFixed(1)}× lo normal con un rango mínimo (${fmt(it.range)} frente a ${fmt(a)} de ATR) en ${where}. Los compradores están absorbiendo la oferta: el precio no cae pese al volumen. Si cierra por encima de ${fmt(confirmPx)}, el rechazo se confirma. Se invalida si cierra por debajo de ${fmt(invalidatePx)}.`
      : `Absorción vendedora en ${fmt(k.close)}: volumen ${it.rV.toFixed(1)}× lo normal con un rango mínimo (${fmt(it.range)} frente a ${fmt(a)} de ATR) en ${where}. Los vendedores están absorbiendo la demanda: el precio no sube pese al volumen. Si cierra por debajo de ${fmt(confirmPx)}, el rechazo se confirma. Se invalida si cierra por encima de ${fmt(invalidatePx)}.`;
    out.push(finding({
      id: `absorption:${side}:${k.time}`, kind: 'absorption',
      label: buyers ? 'Absorción compradora' : 'Absorción vendedora',
      explanation, from: k.time, to: k.time,
      levels: stamp([{ role: 'absorption', price: rp(k.close) }], confirmPx, invalidatePx),
      direction: buyers ? 'up' : 'down', strength: it.scored.strength, status: 'confirmed',
      evidence: {
        index: it.i, volumeRatio: r4(it.rV), rangeAtAtr: r4(it.range / a), buyShare: it.share == null ? null : r4(it.share),
        atLowSwing: it.lowSwing, atHighSwing: it.highSwing, atSupport: it.inSupport, atResist: it.inResist,
        candlesSince: it.candlesSince, distAtr: r4(it.distAtr), exceptional: it.scored.exceptional,
      },
    }));
  }
  return out;
}

/** Clímax: choque de volumen al final de un movimiento extendido, con cierre de reversión (agotamiento). */
export function climax(candles, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const flow = volumeFlow(candles);
  if (!flow) return [];
  const n = candles.length - 1;
  const a = atr(candles, o.atrPeriod);
  if (!a) return [];
  const w = WEIGHTS.climax;
  const L = o.climaxLookback;
  const best = { up: null, down: null };
  const consider = (dir, i, k, rV, driftMag, share, rex) => {
    const extS = sat((driftMag - o.climaxDrift) / 1.5);
    const volS = sat((rV - o.shockK) / o.shockK);
    const revS = sat((rex - 0.5) * 4);
    const candlesSince = n - i;
    const distAtr = Math.abs(candles[n].close - k.close) / a;
    const raw = w.extension * extS + w.volume * volS + w.reversal * revS + w.recency * boundedRecency(candlesSince, 25);
    const scored = scoreStrength('climax', raw, { status: 'confirmed', candlesSince, distAtr, nearWeight: 0.25, nearScale: 3 });
    const item = { dir, i, k, rV, driftMag, share, rex, candlesSince, distAtr, scored };
    if (!best[dir] || scored.strength > best[dir].scored.strength) best[dir] = item;
  };
  for (let i = Math.max(L + 2, 10); i <= n; i++) {
    const k = candles[i];
    const medV = rollingMedianVolume(candles, i, o.shockWindow);
    if (!(medV > 0) || !(k.volume >= o.shockK * medV)) continue;
    const rV = k.volume / medV;
    const share = flow.buyShare[i];
    if (share == null) continue;
    const range = k.high - k.low;
    if (!(range > 0)) continue;
    const drift = (k.close - candles[i - L].close) / a; // movimiento neto de las L velas, en ATR
    const rexUp = (k.high - k.close) / range;           // cierre en la parte baja = reversión bajista
    const rexDn = (k.close - k.low) / range;            // cierre en la parte alta = reversión alcista
    if (drift >= o.climaxDrift && share >= o.shockBuyShare && rexUp >= 0.5) consider('down', i, k, rV, drift, share, rexUp);
    if (-drift >= o.climaxDrift && share <= o.shockSellShare && rexDn >= 0.5) consider('up', i, k, rV, -drift, share, rexDn);
  }
  const out = [];
  for (const dir of ['down', 'up']) {
    const it = best[dir];
    if (!it) continue;
    const k = it.k;
    const buying = dir === 'down'; // clímax de compra → giro bajista; clímax de venta → giro alcista
    const confirmPx = buying ? k.low : k.high;
    const invalidatePx = buying ? k.high : k.low;
    const sidePct = Math.round((buying ? it.share : 1 - it.share) * 100);
    const explanation = buying
      ? `Clímax de compra en ${fmt(k.high)}: volumen ${it.rV.toFixed(1)}× lo normal y compra agresiva (${sidePct}% del volumen) al final de una subida de ${L} velas, pero la vela cierra en ${fmt(k.close)}, lejos del máximo. Agotamiento: quienes empujaron el precio están repartiendo. Si cierra por debajo de ${fmt(confirmPx)}, el giro a la baja se confirma. Se invalida si cierra por encima de ${fmt(invalidatePx)}.`
      : `Clímax de venta en ${fmt(k.low)}: volumen ${it.rV.toFixed(1)}× lo normal y venta agresiva (${sidePct}% del volumen) al final de una bajada de ${L} velas, pero la vela cierra en ${fmt(k.close)}, lejos del mínimo. Agotamiento: quienes empujaron el precio están cerrando. Si cierra por encima de ${fmt(confirmPx)}, el rebote se confirma. Se invalida si cierra por debajo de ${fmt(invalidatePx)}.`;
    out.push(finding({
      id: `climax:${dir}:${k.time}`, kind: 'climax',
      label: buying ? 'Clímax de compra' : 'Clímax de venta',
      explanation, from: candles[it.i - L].time, to: k.time,
      levels: stamp([{ role: 'climax', price: rp(k.close) }], confirmPx, invalidatePx),
      direction: buying ? 'down' : 'up', strength: it.scored.strength, status: 'confirmed',
      evidence: {
        index: it.i, volumeRatio: r4(it.rV), driftAtr: r4(it.driftMag), reversal: r4(it.rex),
        buyShare: it.share == null ? null : r4(it.share), lookback: L,
        candlesSince: it.candlesSince, distAtr: r4(it.distAtr), exceptional: it.scored.exceptional,
      },
    }));
  }
  return out;
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
        levels: stamp(
          [{ role: 'divergence_start', price: rp(p1.price), time: p1.time }, { role: 'divergence_end', price: rp(p2.price), time: p2.time }],
          confirmPx,
          p2.price,
        ),
        direction: bull ? 'up' : 'down', strength: scored.strength, status: 'confirmed',
        evidence: {
          rsi1: r4(r[p1.index]), rsi2: r4(r[p2.index]), price1: rp(p1.price), price2: rp(p2.price),
          rsiGap: r4(rsiDiff), priceGapAtr: r4(priceDiff / a), barsBetween: gap,
          candlesSince, distAtr: r4(distAtr), exceptional: scored.exceptional,
        },
      }));
    }
  }
  return out;
}

// ---------- 10. Smart Money: FVG, BOS/CHoCH, order blocks, liquidez ----------
// Reglas reimplementadas desde la descripcion publica de smartmoneyconcepts (MIT):
// FVG = maximo de hace dos velas < minimo actual si la vela intermedia es alcista
// (y el simetrico bajista). BOS continua la tendencia; CHoCH la gira. El order block
// es la ultima vela de color opuesto antes del impulso que rompe estructura.
// La liquidez son maximos o minimos iguales; aqui solo se publica si hubo barrido
// (mecha mas alla del nivel y cierre de vuelta). La tolerancia de "iguales" es 0.25 ATR
// (el 1% fijo de esa libreria mezcla swings distintos en cripto).

function structureEvents(candles, pivots, o) {
  const swings = [...pivots].sort((x, y) => x.index - y.index || (x.type === 'low' ? -1 : 1));
  let trend = 0;
  let lastHigh = null;
  let lastLow = null;
  let hiBroken = false;
  let loBroken = false;
  const events = [];
  let sPtr = 0;
  for (let i = 0; i < candles.length; i++) {
    while (sPtr < swings.length && swings[sPtr].index + o.pivotWindow <= i) {
      const s = swings[sPtr++];
      if (s.type === 'high') { lastHigh = s; hiBroken = false; }
      else { lastLow = s; loBroken = false; }
    }
    const c = candles[i].close;
    if (lastHigh && !hiBroken && c > lastHigh.price) {
      events.push({ i, dir: 'up', bos: trend >= 0, level: lastHigh.price, swing: lastHigh, opposite: lastLow });
      hiBroken = true;
      trend = 1;
    }
    if (lastLow && !loBroken && c < lastLow.price) {
      events.push({ i, dir: 'down', bos: trend <= 0, level: lastLow.price, swing: lastLow, opposite: lastHigh });
      loBroken = true;
      trend = -1;
    }
  }
  return events;
}

function latestLiveEvent(candles, events) {
  const n = candles.length - 1;
  for (let k = events.length - 1; k >= 0; k--) {
    const e = events[k];
    let reclaimed = false;
    for (let j = e.i + 1; j <= n; j++) {
      if (e.dir === 'up' && candles[j].close < e.level) { reclaimed = true; break; }
      if (e.dir === 'down' && candles[j].close > e.level) { reclaimed = true; break; }
    }
    if (!reclaimed) return e;
  }
  return null;
}

/** Huecos de valor aun no rellenados del todo (el precio no ha cerrado el lado lejano). */
export function fairValueGaps(candles, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = candles.length - 1;
  const a = atr(candles, o.atrPeriod);
  if (!a || n < 5) return [];
  const out = [];
  for (let i = 2; i <= n; i++) {
    if (i < n - o.lookbackPatterns) continue;
    const prev = candles[i - 2], mid = candles[i - 1], cur = candles[i];
    let bottom, top, dir;
    if (mid.close > mid.open && prev.high < cur.low) { bottom = prev.high; top = cur.low; dir = 'up'; }
    else if (mid.close < mid.open && prev.low > cur.high) { bottom = cur.high; top = prev.low; dir = 'down'; }
    else continue;
    const height = top - bottom;
    // Por debajo de 0.72 ATR el hueco es ruido de mecha (un zigzag de bandas lo fabrica).
    if (height < 0.72 * a) continue;
    let filled = false;
    let touched = false;
    for (let j = i + 1; j <= n; j++) {
      if (dir === 'up') {
        if (candles[j].low <= top) touched = true;
        if (candles[j].low <= bottom) { filled = true; break; }
      } else {
        if (candles[j].high >= bottom) touched = true;
        if (candles[j].high >= top) { filled = true; break; }
      }
    }
    if (filled) continue;
    const last = candles[n].close;
    const distAtr = dir === 'up'
      ? (last >= top ? (last - top) / a : last <= bottom ? (bottom - last) / a : 0)
      : (last <= bottom ? (bottom - last) / a : last >= top ? (last - top) / a : 0);
    if (distAtr > 6) continue;
    const candlesSince = n - i;
    const disp = Math.abs(mid.close - mid.open) / a;
    const w = WEIGHTS.fvg;
    const components = [sat(disp / 1.2), sat((height / a) / 0.6), sat(3 * Math.exp(-distAtr / 2)), boundedRecency(candlesSince, 40)];
    const raw = w.displacement * components[0] + w.gap * components[1] + w.proximity * components[2] + w.recency * components[3];
    const kind = dir === 'up' ? 'fvg_bullish' : 'fvg_bearish';
    const scored = scoreStrength(kind, raw, { status: 'forming', components, candlesSince, distAtr, nearWeight: 0.2, nearScale: 4 });
    const confirmPx = dir === 'up' ? top : bottom;
    const invalidatePx = dir === 'up' ? bottom : top;
    const where = `${fmt(bottom)}–${fmt(top)}`;
    const explanation = dir === 'up'
      ? `Hueco de valor alcista (FVG) en ${where}: la vela impulsiva dejó sin negociar el tramo entre el máximo de hace dos velas y el mínimo siguiente. Sigue abierto${touched ? ' y el precio ya lo ha tocado' : ''}. Si cierra por encima de ${fmt(confirmPx)} tras visitar el hueco, el rebote se confirma. Se invalida si cierra por debajo de ${fmt(invalidatePx)}.`
      : `Hueco de valor bajista (FVG) en ${where}: la vela impulsiva dejó sin negociar el tramo entre el mínimo de hace dos velas y el máximo siguiente. Sigue abierto${touched ? ' y el precio ya lo ha tocado' : ''}. Si cierra por debajo de ${fmt(confirmPx)} tras visitar el hueco, el rechazo se confirma. Se invalida si cierra por encima de ${fmt(invalidatePx)}.`;
    out.push(finding({
      id: `fvg:${dir}:${candles[i].time}`,
      kind,
      label: dir === 'up' ? 'Hueco de valor alcista' : 'Hueco de valor bajista',
      explanation,
      from: prev.time, to: candles[n].time,
      levels: stamp([
        { role: 'fvg_top', price: rp(top) },
        { role: 'fvg_bottom', price: rp(bottom) },
      ], confirmPx, invalidatePx),
      direction: dir, strength: scored.strength, status: 'forming',
      evidence: {
        top: rp(top), bottom: rp(bottom), heightAtr: r4(height / a), displacementAtr: r4(disp),
        touched, index: i, candlesSince, distAtr: r4(distAtr), exceptional: scored.exceptional,
      },
    }));
  }
  out.sort((x, y) => y.strength - x.strength);
  const kept = [];
  const cnt = {};
  for (const f of out) {
    cnt[f.kind] = (cnt[f.kind] || 0) + 1;
    if (cnt[f.kind] <= 2) kept.push(f);
  }
  return kept;
}

/** Ultima ruptura de estructura (BOS) o cambio de caracter (CHoCH) aun no reclamada. El quiebre es por cierre. */
export function marketStructure(candles, pivots, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = candles.length - 1;
  const a = atr(candles, o.atrPeriod);
  if (!a || n < 20) return [];
  const events = structureEvents(candles, pivots, o).filter((e) => e.i >= n - o.lookbackPatterns);
  const e = latestLiveEvent(candles, events);
  if (!e) return [];
  const breakAtr = Math.abs(candles[e.i].close - e.level) / a;
  if (breakAtr < 0.1) return [];
  const candlesSince = n - e.i;
  const last = candles[n].close;
  const distAtr = Math.abs(last - e.level) / a;
  const opp = e.opposite && (e.dir === 'up' ? e.opposite.price < e.level : e.opposite.price > e.level)
    ? e.opposite.price
    : (e.dir === 'up' ? e.level - a : e.level + a);
  const w = WEIGHTS.structure;
  const components = [sat(breakAtr / 0.6), sat(e.bos ? 2.2 : 2.6), boundedRecency(candlesSince, 35)];
  const raw = w.breakSize * components[0] + w.clarity * components[1] + w.recency * components[2];
  const kind = `${e.bos ? 'bos' : 'choch'}_${e.dir === 'up' ? 'bullish' : 'bearish'}`;
  const scored = scoreStrength(kind, raw, { status: 'confirmed', components, candlesSince, distAtr, nearWeight: 0.25, nearScale: 4 });
  const up = e.dir === 'up';
  const label = e.bos
    ? (up ? 'Ruptura de estructura alcista' : 'Ruptura de estructura bajista')
    : (up ? 'Cambio de carácter alcista' : 'Cambio de carácter bajista');
  const explanation = e.bos
    ? (up
      ? `Ruptura de estructura alcista (BOS) en ${fmt(e.level)}: el cierre superó el último máximo y la tendencia previa ya era alcista. Si cierra por encima de ${fmt(e.level)}, la continuidad se confirma. Se invalida si cierra por debajo de ${fmt(opp)}.`
      : `Ruptura de estructura bajista (BOS) en ${fmt(e.level)}: el cierre perdió el último mínimo y la tendencia previa ya era bajista. Si cierra por debajo de ${fmt(e.level)}, la continuidad se confirma. Se invalida si cierra por encima de ${fmt(opp)}.`)
    : (up
      ? `Cambio de carácter alcista (CHoCH) en ${fmt(e.level)}: el cierre superó el último máximo en contra de la tendencia bajista previa. Si cierra por encima de ${fmt(e.level)}, el giro se confirma. Se invalida si cierra por debajo de ${fmt(opp)}.`
      : `Cambio de carácter bajista (CHoCH) en ${fmt(e.level)}: el cierre perdió el último mínimo de la tendencia alcista previa. Si cierra por debajo de ${fmt(e.level)}, el giro se confirma. Se invalida si cierra por encima de ${fmt(opp)}.`);
  return [finding({
    id: `${kind}:${candles[e.swing.index].time}:${candles[e.i].time}`,
    kind, label, explanation,
    from: candles[e.swing.index].time, to: candles[n].time,
    levels: stamp([{ role: 'structure_level', price: rp(e.level), time: e.swing.time }], e.level, opp),
    direction: e.dir, strength: scored.strength, status: 'confirmed',
    evidence: {
      breakAtr: r4(breakAtr), bos: e.bos, level: rp(e.level), invalidate: rp(opp),
      breakIndex: e.i, candlesSince, distAtr: r4(distAtr), exceptional: scored.exceptional,
    },
  })];
}

/** Order block: ultima vela opuesta antes del quiebre, mientras el cierre no la atraviese. */
export function orderBlocks(candles, pivots, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = candles.length - 1;
  const a = atr(candles, o.atrPeriod);
  if (!a) return [];
  const events = structureEvents(candles, pivots, o);
  const out = [];
  for (const dir of ['up', 'down']) {
    const candidates = events.filter((e) => e.dir === dir && e.i >= n - o.lookbackPatterns).reverse();
    for (const ev of candidates) {
      let obI = -1;
      for (let i = ev.i - 1; i >= Math.max(0, ev.i - 25); i--) {
        const k = candles[i];
        if (dir === 'up' ? k.close < k.open : k.close > k.open) { obI = i; break; }
      }
      if (obI < 0) continue;
      const k = candles[obI];
      const top = k.high, bottom = k.low;
      if (!(top > bottom)) continue;
      let broken = false;
      let tested = false;
      for (let j = ev.i + 1; j <= n; j++) {
        if (dir === 'up') {
          if (candles[j].low <= top) tested = true;
          if (candles[j].close < bottom) { broken = true; break; }
        } else {
          if (candles[j].high >= bottom) tested = true;
          if (candles[j].close > top) { broken = true; break; }
        }
      }
      if (broken) continue;
      const last = candles[n].close;
      const distAtr = dir === 'up'
        ? (last > top ? (last - top) / a : 0)
        : (last < bottom ? (bottom - last) / a : 0);
      // El impulso puede alejar el precio varios ATR y el bloque sigue siendo el nivel.
      if (distAtr > 8) continue;
      const impulse = Math.abs(candles[ev.i].close - k.close) / a;
      const candlesSince = n - ev.i;
      const w = WEIGHTS.orderBlock;
      const components = [sat(impulse / 1.5), sat(tested ? 1.2 : 3), sat(3 * Math.exp(-distAtr / 2.5))];
      const raw = w.impulse * components[0] + w.freshness * components[1] + w.proximity * components[2];
      const kind = dir === 'up' ? 'order_block_bullish' : 'order_block_bearish';
      const scored = scoreStrength(kind, raw, { status: tested ? 'forming' : 'confirmed', components, candlesSince, distAtr, nearWeight: 0.25, nearScale: 4 });
      const confirmPx = dir === 'up' ? top : bottom;
      const invalidatePx = dir === 'up' ? bottom : top;
      const explanation = dir === 'up'
        ? `Order block alcista en ${fmt(bottom)}–${fmt(top)}: última vela bajista antes del impulso que rompió estructura${tested ? ', ya retesteado' : ', todavía sin mitigar'}. Si cierra por encima de ${fmt(confirmPx)} al volver a la zona, la defensa se confirma. Se invalida si cierra por debajo de ${fmt(invalidatePx)}.`
        : `Order block bajista en ${fmt(bottom)}–${fmt(top)}: última vela alcista antes del impulso que rompió estructura${tested ? ', ya retesteado' : ', todavía sin mitigar'}. Si cierra por debajo de ${fmt(confirmPx)} al volver a la zona, la defensa se confirma. Se invalida si cierra por encima de ${fmt(invalidatePx)}.`;
      out.push(finding({
        id: `ob:${dir}:${candles[obI].time}`,
        kind,
        label: dir === 'up' ? 'Order block alcista' : 'Order block bajista',
        explanation,
        from: candles[obI].time, to: candles[n].time,
        levels: stamp([
          { role: 'ob_high', price: rp(top) },
          { role: 'ob_low', price: rp(bottom) },
        ], confirmPx, invalidatePx),
        direction: dir, strength: scored.strength, status: tested ? 'forming' : 'confirmed',
        evidence: {
          impulseAtr: r4(impulse), tested, obIndex: obI, breakIndex: ev.i,
          candlesSince, distAtr: r4(distAtr), exceptional: scored.exceptional,
        },
      }));
      break;
    }
  }
  return out;
}

/** Barrido de liquidez: dos swings casi iguales y una mecha que los perfora con cierre de vuelta. */
export function liquiditySweeps(candles, pivots, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = candles.length - 1;
  const a = atr(candles, o.atrPeriod);
  if (!a) return [];
  const out = [];
  for (const type of ['high', 'low']) {
    const same = pivots.filter((p) => p.type === type && p.index >= n - o.lookbackPatterns);
    let best = null;
    for (let i = 0; i < same.length; i++) {
      for (let j = i + 1; j < same.length; j++) {
        const p1 = same[i], p2 = same[j];
        if (p2.index - p1.index < 5) continue;
        const tol = Math.max(0.25 * a, Math.abs(p2.price) * 0.001);
        if (Math.abs(p1.price - p2.price) > tol) continue;
        const level = (p1.price + p2.price) / 2;
        const start = p2.index + o.pivotWindow;
        for (let k = start; k <= n; k++) {
          const bar = candles[k];
          const swept = type === 'high'
            ? bar.high > Math.max(p1.price, p2.price) && bar.close < level
            : bar.low < Math.min(p1.price, p2.price) && bar.close > level;
          if (!swept) continue;
          const extreme = type === 'high' ? bar.high : bar.low;
          let failed = false;
          for (let q = k + 1; q <= n; q++) {
            if (type === 'high' ? candles[q].close > extreme : candles[q].close < extreme) { failed = true; break; }
          }
          if (failed) continue;
          const sweepAtr = Math.abs(extreme - level) / a;
          if (sweepAtr < 0.08) continue;
          const candlesSince = n - k;
          if (!best || k > best.k) best = { p1, p2, level, k, extreme, sweepAtr, candlesSince, tol };
          break;
        }
      }
    }
    if (!best) continue;
    const bull = type === 'low';
    const last = candles[n].close;
    const distAtr = Math.abs(last - best.level) / a;
    const w = WEIGHTS.liquidity;
    const components = [sat((1 - Math.abs(best.p1.price - best.p2.price) / best.tol) * 3), sat(best.sweepAtr / 0.35), boundedRecency(best.candlesSince, 30)];
    const raw = w.equality * components[0] + w.sweep * components[1] + w.recency * components[2];
    const kind = bull ? 'liquidity_sweep_bullish' : 'liquidity_sweep_bearish';
    const scored = scoreStrength(kind, raw, { status: 'confirmed', components, candlesSince: best.candlesSince, distAtr, nearWeight: 0.25, nearScale: 4 });
    const confirmPx = best.level;
    const invalidatePx = best.extreme;
    const explanation = bull
      ? `Barrido de liquidez alcista en ${fmt(best.level)}: había mínimos iguales y una mecha los perforó hasta ${fmt(best.extreme)}, pero el cierre volvió por encima. Si cierra por encima de ${fmt(confirmPx)}, el rechazo se confirma. Se invalida si cierra por debajo de ${fmt(invalidatePx)}.`
      : `Barrido de liquidez bajista en ${fmt(best.level)}: había máximos iguales y una mecha los perforó hasta ${fmt(best.extreme)}, pero el cierre volvió por debajo. Si cierra por debajo de ${fmt(confirmPx)}, el rechazo se confirma. Se invalida si cierra por encima de ${fmt(invalidatePx)}.`;
    out.push(finding({
      id: `liq:${type}:${best.p2.time}:${candles[best.k].time}`,
      kind,
      label: bull ? 'Barrido de liquidez alcista' : 'Barrido de liquidez bajista',
      explanation,
      from: best.p1.time, to: candles[n].time,
      levels: stamp([
        { role: 'equal_level', price: rp(best.level) },
        { role: 'sweep_extreme', price: rp(best.extreme), time: candles[best.k].time },
      ], confirmPx, invalidatePx),
      direction: bull ? 'up' : 'down', strength: scored.strength, status: 'confirmed',
      evidence: {
        level: rp(best.level), extreme: rp(best.extreme), sweepAtr: r4(best.sweepAtr),
        left: rp(best.p1.price), right: rp(best.p2.price),
        candlesSince: best.candlesSince, distAtr: r4(distAtr), exceptional: scored.exceptional,
      },
    }));
  }
  return out;
}

// ---------- 11. hombro-cabeza-hombro, cuñas, banderas ----------
// Geometria clasica (tres swings, lineas convergentes, mastil + consolidacion).
// No deriva de PatternPy ni de TradingPatternScanner (ambos CC BY-NC-SA 4.0).

function neckAt(t1, t2, x) {
  const span = t2.index - t1.index;
  if (!span) return (t1.price + t2.price) / 2;
  return t1.price + ((t2.price - t1.price) * (x - t1.index)) / span;
}

export function headAndShoulders(candles, pivots, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = candles.length - 1;
  const a = atr(candles, o.atrPeriod);
  if (!a) return [];
  const recent = pivots.filter((p) => p.index >= n - o.lookbackPatterns);
  const highs = recent.filter((p) => p.type === 'high');
  const lows = recent.filter((p) => p.type === 'low');
  const out = [];
  const consider = (peaks, troughs, inverse) => {
    let best = null;
    for (let i = 0; i + 2 < peaks.length; i++) {
      const ls = peaks[i], head = peaks[i + 1], rs = peaks[i + 2];
      if (n - rs.index > 35 || rs.index - ls.index < 8) continue;
      const headBeyond = inverse ? Math.min(ls.price, rs.price) - head.price : head.price - Math.max(ls.price, rs.price);
      if (headBeyond < 1 * a) continue;
      const shoulderDiff = Math.abs(ls.price - rs.price);
      if (shoulderDiff > Math.max(0.8 * a, 0.55 * headBeyond)) continue;
      const between = (from, to) => troughs.filter((p) => p.index > from && p.index < to);
      const t1s = between(ls.index, head.index);
      const t2s = between(head.index, rs.index);
      if (!t1s.length || !t2s.length) continue;
      const t1 = inverse ? t1s.sort((x, y) => y.price - x.price)[0] : t1s.sort((x, y) => x.price - y.price)[0];
      const t2 = inverse ? t2s.sort((x, y) => y.price - x.price)[0] : t2s.sort((x, y) => x.price - y.price)[0];
      if (Math.abs(t1.price - t2.price) > 1.5 * a) continue;
      const after = candles.slice(rs.index + 1);
      if (after.some((k) => (inverse ? k.close < head.price : k.close > head.price))) continue;
      const neck = neckAt(t1, t2, n);
      const last = candles[n].close;
      const broken = inverse ? last > neck : last < neck;
      const candlesSince = n - rs.index;
      const distAtr = Math.abs(last - neck) / a;
      const symmetry = 1 - shoulderDiff / Math.max(0.8 * a, 0.55 * headBeyond);
      const w = WEIGHTS.hs;
      const components = [sat(symmetry * 3), sat(headBeyond / a / 1.2), sat((broken ? 1 : 0.7) * 3), boundedRecency(candlesSince, 30)];
      const raw = w.symmetry * components[0] + w.prominence * components[1] + w.neck * components[2] + w.recency * components[3];
      const kind = inverse ? 'inverse_head_shoulders' : 'head_shoulders';
      const status = broken ? 'confirmed' : 'forming';
      const scored = scoreStrength(kind, raw, { status, components, candlesSince, distAtr, nearWeight: 0.2, nearScale: 5 });
      const confirmPx = neck;
      const invalidatePx = head.price;
      const explanation = inverse
        ? `Hombro-cabeza-hombro invertido con cabeza en ${fmt(head.price)} y cuello en ${fmt(neck)}: hombros en ${fmt(ls.price)} y ${fmt(rs.price)}. Si cierra por encima de ${fmt(confirmPx)}, el giro al alza se confirma. Se invalida si cierra por debajo de ${fmt(invalidatePx)}.`
        : `Hombro-cabeza-hombro con cabeza en ${fmt(head.price)} y cuello en ${fmt(neck)}: hombros en ${fmt(ls.price)} y ${fmt(rs.price)}. Si cierra por debajo de ${fmt(confirmPx)}, el giro a la baja se confirma. Se invalida si cierra por encima de ${fmt(invalidatePx)}.`;
      const item = finding({
        id: `${kind}:${ls.time}:${head.time}:${rs.time}`,
        kind,
        label: inverse ? 'Hombro-cabeza-hombro invertido' : 'Hombro-cabeza-hombro',
        explanation,
        from: ls.time, to: candles[n].time,
        levels: stamp([
          { role: 'neckline', price: rp(neck) },
          { role: 'head', price: rp(head.price), time: head.time },
          { role: 'shoulder', price: rp(ls.price), time: ls.time },
          { role: 'shoulder', price: rp(rs.price), time: rs.time },
        ], confirmPx, invalidatePx),
        direction: inverse ? 'up' : 'down', strength: scored.strength, status,
        evidence: {
          head: rp(head.price), left: rp(ls.price), right: rp(rs.price), neckline: rp(neck),
          prominenceAtr: r4(headBeyond / a), shoulderDiffAtr: r4(shoulderDiff / a), broken,
          candlesSince, distAtr: r4(distAtr), exceptional: scored.exceptional,
        },
      });
      if (!best || item.strength > best.strength) best = item;
    }
    if (best) out.push(best);
  };
  consider(highs, lows, false);
  consider(lows, highs, true);
  return out;
}

export function wedges(candles, pivots, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = candles.length - 1;
  const a = atr(candles, o.atrPeriod);
  if (!a) return [];
  const recent = pivots.filter((p) => p.index >= n - o.lookbackPatterns);
  const hs = recent.filter((p) => p.type === 'high').slice(-3);
  const ls = recent.filter((p) => p.type === 'low').slice(-3);
  if (hs.length < 3 || ls.length < 3) return [];
  const x0 = Math.min(hs[0].index, ls[0].index);
  const x1 = n;
  if (x1 - x0 < 12) return [];
  const H = linreg(hs.map((p) => ({ x: p.index, y: p.price })));
  const L = linreg(ls.map((p) => ({ x: p.index, y: p.price })));
  const hi = (x) => H.slope * x + H.b;
  const lo = (x) => L.slope * x + L.b;
  const w0 = hi(x0) - lo(x0);
  const w1 = hi(x1) - lo(x1);
  if (!(w0 > 0) || !(w1 > 0) || w1 > 0.75 * w0) return [];
  const moveH = (hi(x1) - hi(x0)) / w0;
  const moveL = (lo(x1) - lo(x0)) / w0;
  let kind = null;
  if (H.slope > 0 && L.slope > H.slope && moveH > 0.12 && moveL > 0.28 && H.slope > 0.35 * L.slope) kind = 'rising_wedge';
  else if (H.slope < 0 && L.slope < 0 && H.slope < L.slope && moveH < -0.28 && moveL < -0.12 && Math.abs(L.slope) > 0.35 * Math.abs(H.slope)) kind = 'falling_wedge';
  if (!kind) return [];
  const last = candles[n].close;
  const upper = hi(n), lower = lo(n);
  const rising = kind === 'rising_wedge';
  if (rising ? last > upper + 0.4 * w1 : last < lower - 0.4 * w1) return [];
  const broken = rising ? last < lower : last > upper;
  const fit = 1 - clamp01(((H.res + L.res) / 2) / (0.18 * w0));
  const convergence = clamp01(1 - w1 / w0);
  const target = rising ? lower : upper;
  const proximity = clamp01(1 - Math.abs(last - target) / Math.max(w1, 1e-9));
  const lastPivot = Math.max(hs[hs.length - 1].index, ls[ls.length - 1].index);
  const candlesSince = n - lastPivot;
  const distAtr = Math.abs(last - target) / a;
  const w = WEIGHTS.wedge;
  const components = [sat(fit * 3), sat(convergence * 3.2), sat(proximity * 3), boundedRecency(candlesSince, 35)];
  const raw = (w.fit * components[0] + w.convergence * components[1] + w.proximity * components[2] + w.recency * components[3]);
  const status = broken ? 'confirmed' : 'forming';
  const scored = scoreStrength(kind, raw, { status, components, candlesSince, distAtr, nearWeight: 0.15, nearScale: 5 });
  const confirmPx = rising ? lower : upper;
  const invalidatePx = rising ? upper : lower;
  const explanation = rising
    ? `Cuña ascendente entre ${fmt(lower)} y ${fmt(upper)}: máximos y mínimos suben, pero el rango se estrecha y el sesgo es bajista. Si cierra por debajo de ${fmt(confirmPx)}, la ruptura se confirma. Se invalida si cierra por encima de ${fmt(invalidatePx)}.`
    : `Cuña descendente entre ${fmt(lower)} y ${fmt(upper)}: máximos y mínimos bajan, pero el rango se estrecha y el sesgo es alcista. Si cierra por encima de ${fmt(confirmPx)}, la ruptura se confirma. Se invalida si cierra por debajo de ${fmt(invalidatePx)}.`;
  return [finding({
    id: `${kind}:${candles[x0].time}`,
    kind,
    label: rising ? 'Cuña ascendente' : 'Cuña descendente',
    explanation,
    from: candles[x0].time, to: candles[n].time,
    levels: stamp([
      { role: 'wedge_upper', price: rp(upper) },
      { role: 'wedge_lower', price: rp(lower) },
    ], confirmPx, invalidatePx),
    direction: rising ? 'down' : 'up', strength: scored.strength, status,
    evidence: {
      fit: r4(fit), convergence: r4(convergence), widthStart: rp(w0), widthNow: rp(w1),
      candlesSince, distAtr: r4(distAtr), exceptional: scored.exceptional,
    },
  })];
}

function pathEfficiency(candles, i0, i1) {
  let path = 0;
  for (let i = i0 + 1; i <= i1; i++) path += Math.abs(candles[i].close - candles[i - 1].close);
  const net = Math.abs(candles[i1].close - candles[i0].close);
  return path > 0 ? net / path : 0;
}

export function flags(candles, pivots, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = candles.length - 1;
  const a = atr(candles, o.atrPeriod);
  if (!a) return [];
  const recent = pivots.filter((p) => p.index >= n - o.lookbackPatterns);
  const out = [];
  const tryFlag = (start, end, bull) => {
    const pole = Math.abs(end.price - start.price);
    const bars = end.index - start.index;
    if (pole < 2.5 * a || bars < 4 || bars > 30) return;
    if (bull ? end.price <= start.price : end.price >= start.price) return;
    const eff = pathEfficiency(candles, start.index, end.index);
    if (eff < 0.65) return;
    const flagLen = n - end.index;
    if (flagLen < 4 || flagLen > 28) return;
    const flag = candles.slice(end.index, n + 1);
    const flagLow = Math.min(...flag.map((k) => k.low));
    const flagHigh = Math.max(...flag.map((k) => k.high));
    const retrace = bull ? (end.price - flagLow) / pole : (flagHigh - end.price) / pole;
    if (retrace < 0.15 || retrace > 0.62) return;
    const broke = bull ? candles[n].close > end.price : candles[n].close < end.price;
    if (!broke && (bull ? flagHigh > end.price + 0.2 * a : flagLow < end.price - 0.2 * a)) return;
    const tightness = 1 - clamp01((flagHigh - flagLow) / pole);
    const candlesSince = flagLen;
    const confirmPx = end.price;
    const invalidatePx = bull ? flagLow : flagHigh;
    const distAtr = Math.abs(candles[n].close - confirmPx) / a;
    const w = WEIGHTS.flag;
    const components = [sat((eff * pole) / a / 2), sat(1.1 - Math.abs(retrace - 0.38) * 2), sat(tightness * 3), boundedRecency(candlesSince, 20)];
    const raw = w.pole * components[0] + w.retrace * components[1] + w.tightness * components[2] + w.recency * components[3];
    const kind = bull ? 'bull_flag' : 'bear_flag';
    const status = broke ? 'confirmed' : 'forming';
    const scored = scoreStrength(kind, raw, { status, components, candlesSince, distAtr, nearWeight: 0.2, nearScale: 4 });
    const explanation = bull
      ? `Bandera alcista tras un impulso de ${fmt(start.price)} a ${fmt(end.price)}: la consolidación retrocede hasta ${fmt(flagLow)} sin deshacer el mástil. Si cierra por encima de ${fmt(confirmPx)}, la continuación se confirma. Se invalida si cierra por debajo de ${fmt(invalidatePx)}.`
      : `Bandera bajista tras un impulso de ${fmt(start.price)} a ${fmt(end.price)}: la consolidación rebota hasta ${fmt(flagHigh)} sin deshacer el mástil. Si cierra por debajo de ${fmt(confirmPx)}, la continuación se confirma. Se invalida si cierra por encima de ${fmt(invalidatePx)}.`;
    out.push(finding({
      id: `${kind}:${start.time}:${end.time}`,
      kind,
      label: bull ? 'Bandera alcista' : 'Bandera bajista',
      explanation,
      from: start.time, to: candles[n].time,
      levels: stamp([
        { role: 'pole_end', price: rp(end.price), time: end.time },
        { role: bull ? 'flag_low' : 'flag_high', price: rp(bull ? flagLow : flagHigh) },
      ], confirmPx, invalidatePx),
      direction: bull ? 'up' : 'down', strength: scored.strength, status,
      evidence: {
        poleAtr: r4(pole / a), efficiency: r4(eff), retrace: r4(retrace), tightness: r4(tightness),
        flagLow: rp(flagLow), flagHigh: rp(flagHigh), broken: broke,
        candlesSince, distAtr: r4(distAtr), exceptional: scored.exceptional,
      },
    }));
  };
  const highs = recent.filter((p) => p.type === 'high');
  const lows = recent.filter((p) => p.type === 'low');
  for (const h of highs) {
    const prev = lows.filter((p) => p.index < h.index).at(-1);
    if (prev) tryFlag(prev, h, true);
  }
  for (const l of lows) {
    const prev = highs.filter((p) => p.index < l.index).at(-1);
    if (prev) tryFlag(prev, l, false);
  }
  const pick = (kind) => {
    const xs = out.filter((f) => f.kind === kind);
    if (!xs.length) return [];
    xs.sort((a, b) => b.strength - a.strength);
    return [xs[0]];
  };
  return [...pick('bull_flag'), ...pick('bear_flag')];
}

// ---------- 12. velas de alta fiabilidad, solo en contexto ----------
// Definiciones CDL* de TA-Lib (BSD-3-Clause), resumidas: envolvente de cuerpos
// (el cuerpo que envuelve mide al menos 0.8 ATR),
// martillo / estrella fugaz (sombra >= 2 cuerpos y sombra opuesta corta),
// estrella de la mañana / tarde (sin exigir hueco: el mercado cripto no lo abre)
// y doji (cuerpo <= 10% del rango). Solo cuentan junto a un swing o una zona S/R.

function cBody(k) { return Math.abs(k.close - k.open); }
function cUpper(k) { return k.high - Math.max(k.open, k.close); }
function cLower(k) { return Math.min(k.open, k.close) - k.low; }
function cBull(k) { return k.close > k.open; }
function cBear(k) { return k.close < k.open; }

function candleContext(candles, pivots, zones, i, side, a) {
  const k = candles[i];
  const swing = pivots.some((p) => {
    if (side !== 'either' && p.type !== side) return false;
    if (Math.abs(p.index - i) > 3) return false;
    const ref = p.type === 'high' ? k.high : k.low;
    return Math.abs(p.price - ref) <= 0.6 * a;
  });
  const zone = zones.some((z) => {
    const lv = z.levels?.[0];
    if (!lv || !Number.isFinite(lv.price)) return false;
    const low = Number.isFinite(lv.low) ? lv.low : lv.price;
    const high = Number.isFinite(lv.high) ? lv.high : lv.price;
    return k.low <= high + 0.35 * a && k.high >= low - 0.35 * a;
  });
  return { swing, zone, ok: swing || zone };
}

function pushCandle(out, candles, spec) {
  const { i, kind, label, direction, confirmPx, invalidatePx, shape, ctx, explanation, evidence } = spec;
  const n = candles.length - 1;
  const a = spec.atr;
  const candlesSince = n - i;
  const distAtr = Math.abs(candles[n].close - confirmPx) / a;
  const contextScore = ctx.swing && ctx.zone ? 1 : ctx.swing ? 0.85 : 0.7;
  const w = WEIGHTS.candle;
  const components = [sat(shape * 2.4), sat(contextScore * 3), boundedRecency(candlesSince, 25)];
  const raw = w.shape * components[0] + w.context * components[1] + w.recency * components[2];
  const scored = scoreStrength(kind, raw, { status: 'confirmed', components, candlesSince, distAtr, nearWeight: 0.3, nearScale: 3 });
  out.push(finding({
    id: `${kind}:${candles[i].time}`,
    kind, label, explanation,
    from: candles[Math.max(0, i - 2)].time, to: candles[i].time,
    levels: stamp([{ role: 'candle', price: rp(candles[i].close), time: candles[i].time }], confirmPx, invalidatePx),
    direction, strength: scored.strength, status: 'confirmed',
    evidence: {
      ...evidence, shape: r4(shape), atSwing: ctx.swing, atZone: ctx.zone,
      candlesSince, distAtr: r4(distAtr), exceptional: scored.exceptional,
    },
  }));
}

export function candlestickPatterns(candles, pivots, zones = [], opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = candles.length - 1;
  const a = atr(candles, o.atrPeriod);
  if (!a || n < 5) return [];
  const found = {};
  const remember = (kind, item) => {
    if (!found[kind] || item.i > found[kind].i) found[kind] = item;
  };
  for (let i = n; i >= Math.max(2, n - 40); i--) {
    const k = candles[i];
    const range = k.high - k.low;
    if (!(range > 0)) continue;
    const body = cBody(k);
    const ctxLow = candleContext(candles, pivots, zones, i, 'low', a);
    const ctxHigh = candleContext(candles, pivots, zones, i, 'high', a);
    const ctxEither = candleContext(candles, pivots, zones, i, 'either', a);
    const prev = candles[i - 1];
    if (ctxLow.ok && cBear(prev) && cBull(k) && body >= 0.8 * a && cBody(prev) > 0
      && k.open <= prev.close && k.close >= prev.open && body >= cBody(prev)) {
      const shape = body / cBody(prev);
      remember('candle_engulfing_bullish', {
        i, kind: 'candle_engulfing_bullish', label: 'Envolvente alcista', direction: 'up', atr: a,
        confirmPx: k.high, invalidatePx: Math.min(k.low, prev.low), shape, ctx: ctxLow,
        explanation: `Envolvente alcista en ${fmt(k.close)}: el cuerpo verde cubre el cuerpo rojo anterior, en un mínimo o en soporte. Si cierra por encima de ${fmt(k.high)}, el giro se confirma. Se invalida si cierra por debajo de ${fmt(Math.min(k.low, prev.low))}.`,
        evidence: { bodyRatio: r4(shape) },
      });
    }
    if (ctxHigh.ok && cBull(prev) && cBear(k) && body >= 0.8 * a && cBody(prev) > 0
      && k.open >= prev.close && k.close <= prev.open && body >= cBody(prev)) {
      const shape = body / cBody(prev);
      remember('candle_engulfing_bearish', {
        i, kind: 'candle_engulfing_bearish', label: 'Envolvente bajista', direction: 'down', atr: a,
        confirmPx: k.low, invalidatePx: Math.max(k.high, prev.high), shape, ctx: ctxHigh,
        explanation: `Envolvente bajista en ${fmt(k.close)}: el cuerpo rojo cubre el cuerpo verde anterior, en un máximo o en resistencia. Si cierra por debajo de ${fmt(k.low)}, el giro se confirma. Se invalida si cierra por encima de ${fmt(Math.max(k.high, prev.high))}.`,
        evidence: { bodyRatio: r4(shape) },
      });
    }
    const lower = cLower(k), upper = cUpper(k);
    if (ctxLow.ok && body >= 0.04 * range && lower >= 2 * body && lower >= 0.5 * range && upper <= Math.max(body, 0.15 * range)) {
      remember('candle_hammer', {
        i, kind: 'candle_hammer', label: 'Martillo', direction: 'up', atr: a,
        confirmPx: k.high, invalidatePx: k.low, shape: lower / Math.max(body, 1e-9), ctx: ctxLow,
        explanation: `Martillo en ${fmt(k.low)}: mecha inferior larga y cuerpo pequeño en la parte alta, tras un mínimo o en soporte. Si cierra por encima de ${fmt(k.high)}, el rechazo se confirma. Se invalida si cierra por debajo de ${fmt(k.low)}.`,
        evidence: { lowerWickBody: r4(lower / Math.max(body, 1e-9)) },
      });
    }
    if (ctxHigh.ok && body >= 0.04 * range && upper >= 2 * body && upper >= 0.5 * range && lower <= Math.max(body, 0.15 * range)) {
      remember('candle_shooting_star', {
        i, kind: 'candle_shooting_star', label: 'Estrella fugaz', direction: 'down', atr: a,
        confirmPx: k.low, invalidatePx: k.high, shape: upper / Math.max(body, 1e-9), ctx: ctxHigh,
        explanation: `Estrella fugaz en ${fmt(k.high)}: mecha superior larga y cuerpo pequeño en la parte baja, tras un máximo o en resistencia. Si cierra por debajo de ${fmt(k.low)}, el rechazo se confirma. Se invalida si cierra por encima de ${fmt(k.high)}.`,
        evidence: { upperWickBody: r4(upper / Math.max(body, 1e-9)) },
      });
    }
    if (body <= 0.1 * range && range >= 0.35 * a && ctxEither.ok) {
      const atSupport = ctxLow.ok || zones.some((z) => z.levels?.[0]?.role === 'support' && k.low <= (z.levels[0].high ?? z.levels[0].price) + 0.35 * a && k.high >= (z.levels[0].low ?? z.levels[0].price) - 0.35 * a);
      const atResist = ctxHigh.ok || zones.some((z) => z.levels?.[0]?.role === 'resistance' && k.low <= (z.levels[0].high ?? z.levels[0].price) + 0.35 * a && k.high >= (z.levels[0].low ?? z.levels[0].price) - 0.35 * a);
      const direction = atSupport && !atResist ? 'up' : atResist && !atSupport ? 'down' : 'neutral';
      const confirmPx = direction === 'down' ? k.low : k.high;
      const invalidatePx = direction === 'down' ? k.high : k.low;
      const ctx = direction === 'down' ? ctxHigh : direction === 'up' ? ctxLow : ctxEither;
      if (ctx.ok || atSupport || atResist) {
        remember('candle_doji', {
          i, kind: 'candle_doji', label: 'Doji en nivel', direction, atr: a,
          confirmPx, invalidatePx, shape: 1 - body / range, ctx: ctx.ok ? ctx : { swing: false, zone: true, ok: true },
          explanation: direction === 'down'
            ? `Doji en ${fmt(k.close)}: el cuerpo es mínimo y el precio está en resistencia o en un máximo. Si cierra por debajo de ${fmt(confirmPx)}, el sesgo bajista se confirma. Se invalida si cierra por encima de ${fmt(invalidatePx)}.`
            : direction === 'up'
              ? `Doji en ${fmt(k.close)}: el cuerpo es mínimo y el precio está en soporte o en un mínimo. Si cierra por encima de ${fmt(confirmPx)}, el sesgo alcista se confirma. Se invalida si cierra por debajo de ${fmt(invalidatePx)}.`
              : `Doji en ${fmt(k.close)}: el cuerpo es mínimo y el precio está en un swing o entre soporte y resistencia. Si cierra por encima de ${fmt(confirmPx)}, el empate se resuelve al alza. Se invalida si cierra por debajo de ${fmt(invalidatePx)}.`,
          evidence: { bodyToRange: r4(body / range) },
        });
      }
    }
    if (i >= 2) {
      const a1 = candles[i - 2], a2 = candles[i - 1], a3 = k;
      const midBody = (a1.open + a1.close) / 2;
      const starCtx = candleContext(candles, pivots, zones, i - 1, 'low', a);
      if (starCtx.ok && cBear(a1) && cBull(a3) && cBody(a1) >= 0.45 * a && cBody(a2) <= 0.45 * cBody(a1) && a3.close > midBody) {
        remember('candle_morning_star', {
          i, kind: 'candle_morning_star', label: 'Estrella de la mañana', direction: 'up', atr: a,
          confirmPx: a3.high, invalidatePx: Math.min(a1.low, a2.low, a3.low), shape: (a3.close - midBody) / Math.max(cBody(a1), 1e-9),
          ctx: starCtx,
          explanation: `Estrella de la mañana en ${fmt(Math.min(a2.low, a3.low))}: vela bajista, cuerpo pequeño y vela alcista que cierra por encima de la mitad de la primera, en un mínimo o en soporte. Si cierra por encima de ${fmt(a3.high)}, el giro se confirma. Se invalida si cierra por debajo de ${fmt(Math.min(a1.low, a2.low, a3.low))}.`,
          evidence: { firstBodyAtr: r4(cBody(a1) / a) },
        });
      }
      const starHigh = candleContext(candles, pivots, zones, i - 1, 'high', a);
      if (starHigh.ok && cBull(a1) && cBear(a3) && cBody(a1) >= 0.45 * a && cBody(a2) <= 0.45 * cBody(a1) && a3.close < midBody) {
        remember('candle_evening_star', {
          i, kind: 'candle_evening_star', label: 'Estrella del anochecer', direction: 'down', atr: a,
          confirmPx: a3.low, invalidatePx: Math.max(a1.high, a2.high, a3.high), shape: (midBody - a3.close) / Math.max(cBody(a1), 1e-9),
          ctx: starHigh,
          explanation: `Estrella del anochecer en ${fmt(Math.max(a2.high, a3.high))}: vela alcista, cuerpo pequeño y vela bajista que cierra por debajo de la mitad de la primera, en un máximo o en resistencia. Si cierra por debajo de ${fmt(a3.low)}, el giro se confirma. Se invalida si cierra por encima de ${fmt(Math.max(a1.high, a2.high, a3.high))}.`,
          evidence: { firstBodyAtr: r4(cBody(a1) / a) },
        });
      }
    }
  }
  const out = [];
  for (const item of Object.values(found)) pushCandle(out, candles, item);
  return out;
}

// ---------- orquestacion ----------
/**
 * Hasta `limit` hallazgos, como mucho `perKind` de cada tipo.
 * Primero los patrones de grafico y de estructura con fuerza >= 0.4 (CHART_KINDS:
 * doble techo/suelo, triangulo, hombro-cabeza-hombro, cuña, bandera, ruptura,
 * divergencia, FVG, BOS/CHoCH, order block, barrido de liquidez). Una estructura
 * con mas de 30 velas no lidera: sigue en findings y compite por cercania.
 * Dentro del grupo, y despues en el resto, se prefiere fuerza, cercania y recencia.
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
  const chartLead = (f) => {
    if (!CHART_KINDS.has(f.kind) || f.strength < 0.4) return 0;
    if (/^(fvg|bos|choch|order_block|liquidity_sweep)_/.test(f.kind)) {
      const since = Number.isFinite(f.evidence?.candlesSince) ? f.evidence.candlesSince : Infinity;
      if (since > 30) return 0;
    }
    return 1;
  };
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
    return { symbol, timeframe, findings: [], top: [], trend: trendOf(candles || [], o), levels: [], pivots: [], volumeFlow: null, hitRate: null };
  }
  const pivots = findPivots(candles, o.pivotWindow);
  const trend = trendOf(candles, o);
  const zones = srZones(candles, pivots, o);
  const findings = [
    ...zones,
    ...doubleTopBottom(candles, pivots, o),
    ...triangles(candles, pivots, o),
    ...rangeBreakout(candles, o),
    ...shocks(candles, o),
    ...volumeShocks(candles, o),
    ...absorption(candles, pivots, zones, o),
    ...volumeProfile(candles, o),
    ...deltaDivergence(candles, pivots, o),
    ...climax(candles, o),
    ...rsiDivergence(candles, pivots, o),
    ...fairValueGaps(candles, o),
    ...marketStructure(candles, pivots, o),
    ...orderBlocks(candles, pivots, o),
    ...liquiditySweeps(candles, pivots, o),
    ...headAndShoulders(candles, pivots, o),
    ...wedges(candles, pivots, o),
    ...flags(candles, pivots, o),
    ...candlestickPatterns(candles, pivots, zones, o),
  ].map((f) => ({ ...f, hitRate: historicalHitRate(f.kind, timeframe, symbol), hitRateNote: hitRateNote(f.kind) }));
  findings.sort((a, b) => b.strength - a.strength || b.to - a.to);
  const top = selectTop(findings, o.topLimit, o.topPerKind);
  const levels = findings.flatMap((f) => f.levels.map((l) => ({ ...l, findingId: f.id, kind: f.kind })));
  return { symbol, timeframe, findings, top, trend, levels, pivots, volumeFlow: volumeFlow(candles) };
}

/** API tipo herramienta: la misma funcion puede envolverse en un servidor MCP. */
export async function analyze(input) {
  const res = analyzeSync(input);
  return {
    findings: res.findings, top: res.top, trend: res.trend, levels: res.levels, pivots: res.pivots,
    volumeFlow: res.volumeFlow,
    symbol: res.symbol, timeframe: res.timeframe, generatedAt: new Date().toISOString(),
  };
}

export const TOOL_SPEC = {
  name: 'analyze_chart',
  description: 'Detecta patrones de precio de forma determinista (pivotes, tendencia, soportes/resistencias, doble techo/suelo, hombro-cabeza-hombro, triángulos, cuñas, banderas, estructura: FVG, BOS/CHoCH, order blocks y barridos de liquidez, rupturas de rango, velas de choque, velas clásicas en contexto, perfil de volumen, divergencias RSI y flujo de volumen: choques con agresión compradora/vendedora, divergencias de delta (CVD), absorción y clímax) y los devuelve ordenados por "fuerza del patrón" (puntuación geométrica 0-1; no es una probabilidad ni una tasa de acierto). Cada hallazgo incluye explicación en español, niveles con precios confirm e invalidate, y la evidencia numérica. Con takerBuyVolume por vela expone además volumeFlow {delta, cvd, buyShare}.',
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
          properties: { time: { type: 'integer', description: 'Segundos UTC de apertura' }, open: { type: 'number' }, high: { type: 'number' }, low: { type: 'number' }, close: { type: 'number' }, volume: { type: 'number' }, trades: { type: 'number', description: 'Número de trades (opcional).' }, takerBuyVolume: { type: 'number', description: 'Volumen de compra agresiva (taker buy base). Opcional: sin él no hay flujo de volumen ni hallazgos de agresión.' } },
        },
      },
    },
    required: ['symbol', 'timeframe', 'candles'],
  },
  output: 'Objeto {findings[], trend, levels[], pivots[], volumeFlow, generatedAt}. findings[].strength es la fuerza del patrón (0-1). volumeFlow = {delta[], cvd[], buyShare[]} o null si las velas no traen takerBuyVolume.',
};

// ---------- pulso de mercado (hechos de solo lectura, sin DOM ni red) ----------
export const DEPTH_WALL_DEFAULTS = { wallK: 2.5, wallRangePct: 2, maxWalls: 3 };

/**
 * Muros del libro de ordenes. `depth` es la respuesta publica de
 * `GET /fapi/v1/depth` con filas [precio, cantidad] (bids/asks). Puro: no pide
 * nada y no lanza; con un libro vacio o roto devuelve el hueco.
 * Un nivel es muro si su cantidad es >= wallK x la mediana de TODOS los niveles
 * y esta dentro de wallRangePct % del precio medio. Devuelve
 * {mid, spreadPct, medianSize, bids, asks} y cada muro {price, size, usd,
 * distancePct}, con usd = precio x cantidad y como mucho `maxWalls` por lado.
 * No es una prediccion: son niveles grandes, no una probabilidad.
 */
export function depthWalls(depth, opts = {}) {
  const o = { ...DEPTH_WALL_DEFAULTS, ...opts };
  const empty = { mid: null, spreadPct: null, medianSize: 0, bids: [], asks: [] };
  const read = (rows) => {
    if (!Array.isArray(rows)) return [];
    const out = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const price = Number(row[0]);
      const size = Number(row[1]);
      if (!(price > 0) || !(size > 0)) continue;
      out.push({ price, size });
    }
    return out;
  };
  const bids = read(depth && depth.bids);
  const asks = read(depth && depth.asks);
  if (!bids.length || !asks.length) return empty;
  const bestBid = Math.max(...bids.map((l) => l.price));
  const bestAsk = Math.min(...asks.map((l) => l.price));
  const mid = (bestBid + bestAsk) / 2;
  if (!(mid > 0)) return empty;
  const medianSize = median([...bids, ...asks].map((l) => l.size));
  const threshold = o.wallK * medianSize;
  const wallsOf = (levels, side) => levels
    .map((level) => ({
      price: level.price,
      size: level.size,
      usd: level.price * level.size,
      distancePct: ((side === 'bid' ? mid - level.price : level.price - mid) / mid) * 100,
    }))
    .filter((w) => w.size >= threshold && w.distancePct >= 0 && w.distancePct <= o.wallRangePct)
    .sort((a, b) => b.size - a.size || a.distancePct - b.distancePct)
    .slice(0, o.maxWalls)
    .map((w) => ({ ...w, usd: r4(w.usd), distancePct: r4(w.distancePct) }));
  return {
    mid: rp(mid),
    spreadPct: r4(((bestAsk - bestBid) / mid) * 100),
    medianSize: r4(medianSize),
    bids: wallsOf(bids, 'bid'),
    asks: wallsOf(asks, 'ask'),
  };
}

export const LIQUIDATION_DEFAULTS = { windowsMinutes: [5, 15] };

/**
 * Resumen de liquidaciones. `events` son hechos ya normalizados
 * {at (ms), side: 'long'|'short', usd}. Puro y determinista: `now` entra como
 * argumento. Para cada ventana de `windowsMinutes` suma el USD liquidado de
 * posiciones largas y cortas, cuenta los eventos y guarda el mayor. `largest`
 * es el mayor de la ventana mas amplia. Descarta lo que no sea finito o
 * positivo en vez de lanzar. No calcula probabilidades.
 */
export function liquidationSummary(events, opts = {}, now = Date.now()) {
  const o = { ...LIQUIDATION_DEFAULTS, ...opts };
  const windowsMinutes = Array.isArray(o.windowsMinutes)
    ? o.windowsMinutes.filter((m) => Number.isFinite(m) && m > 0)
    : [];
  const valid = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== 'object') continue;
    const at = Number(e.at);
    const usd = Number(e.usd);
    if (!Number.isFinite(at) || !Number.isFinite(usd) || usd <= 0) continue;
    if (e.side !== 'long' && e.side !== 'short') continue;
    valid.push({ at, side: e.side, usd });
  }
  const windows = windowsMinutes.map((minutes) => {
    const since = now - minutes * 60_000;
    let longUsd = 0, shortUsd = 0, count = 0, largest = null;
    for (const e of valid) {
      if (e.at < since || e.at > now) continue;
      count += 1;
      if (e.side === 'long') longUsd += e.usd; else shortUsd += e.usd;
      if (!largest || e.usd > largest.usd) largest = { usd: r4(e.usd), at: e.at, side: e.side };
    }
    return { minutes, longUsd: r4(longUsd), shortUsd: r4(shortUsd), totalUsd: r4(longUsd + shortUsd), count, largest };
  });
  const widest = windows.length ? windows[windows.length - 1] : null;
  return { count: valid.length, windows, largest: widest ? widest.largest : null };
}
