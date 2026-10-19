import type { Candle } from '../types';

/**
 * Mapa de niveles: referencias de precio calculadas con velas públicas.
 * Cada nivel es una "zona de reacción posible", nunca una predicción: la
 * dirección no está medida (docs/research/AUDIT_PATRONES_2026-10-18.md). Lo
 * único predecible es la volatilidad, por eso el rango se expresa en ATR.
 * Puro: sin red ni DOM. Con historia corta devuelve lo que puede y nunca lanza.
 * Se asume que la última vela de cada serie es la que está en curso.
 */

export type LevelKind =
  | 'dayOpen'
  | 'prevDayHigh'
  | 'prevDayLow'
  | 'weekOpen'
  | 'prevWeekHigh'
  | 'prevWeekLow'
  | 'monthOpen'
  | 'ema20_1h'
  | 'ema50_1h'
  | 'ema50_4h'
  | 'bbUpper'
  | 'bbLower'
  | 'pivot'
  | 'r1'
  | 's1'
  | 'round'
  | 'confirm'
  | 'invalidate';

/** Orden fijo de prioridad: decide el tipo y el orden de las etiquetas al fusionar. */
const KIND_ORDER: readonly LevelKind[] = [
  'prevDayHigh',
  'prevDayLow',
  'prevWeekHigh',
  'prevWeekLow',
  'dayOpen',
  'weekOpen',
  'monthOpen',
  'pivot',
  'r1',
  's1',
  'ema20_1h',
  'ema50_1h',
  'ema50_4h',
  'bbUpper',
  'bbLower',
  'confirm',
  'invalidate',
  'round',
];

const SHORT_LABEL: Record<LevelKind, string> = {
  dayOpen: 'Apertura día',
  prevDayHigh: 'PDH',
  prevDayLow: 'PDL',
  weekOpen: 'Apertura sem.',
  prevWeekHigh: 'PWH',
  prevWeekLow: 'PWL',
  monthOpen: 'Apertura mes',
  ema20_1h: 'EMA20 1h',
  ema50_1h: 'EMA50 1h',
  ema50_4h: 'EMA50 4h',
  bbUpper: 'BB sup 1h',
  bbLower: 'BB inf 1h',
  pivot: 'Pivote',
  r1: 'R1',
  s1: 'S1',
  round: 'Redondo',
  confirm: 'Confirma',
  invalidate: 'Invalida',
};

/** Significado de las siglas, para el título (tooltip) del mapa. */
export const LEVEL_HELP =
  'PDH/PDL = máximo/mínimo de ayer · PWH/PWL = de la semana pasada · R1/S1 = pivote clásico diario';

export interface FindingLevelInput {
  label: string;
  confirm: number | null;
  invalidate: number | null;
}

export interface LevelRow {
  price: number;
  kind: LevelKind;
  /** Tipos fusionados en esta fila (el primero es `kind`). */
  kinds: LevelKind[];
  label: string;
  /** Signada: positiva si el nivel está por encima del precio. */
  distancePct: number;
  /** Distancia en ATR de 1h, signada; null sin ATR. */
  distanceAtr: number | null;
}

export interface BuildLevelsInput {
  price: number;
  d1?: readonly Candle[];
  w1?: readonly Candle[];
  h1?: readonly Candle[];
  h4?: readonly Candle[];
  findingsLevels?: readonly FindingLevelInput[];
}

export const MERGE_PCT = 0.1;
export const MAX_PER_SIDE = 7;

const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isPrice = (value: unknown): value is number => isNum(value) && value > 0;

/** EMA con semilla SMA de las primeras `period` cierres. null con historia corta. */
export function ema(closes: readonly number[], period: number): number | null {
  if (period < 1 || closes.length < period) return null;
  const k = 2 / (period + 1);
  let value = 0;
  for (let i = 0; i < period; i++) value += closes[i] ?? 0;
  value /= period;
  for (let i = period; i < closes.length; i++) value = (closes[i] ?? 0) * k + value * (1 - k);
  return isNum(value) ? value : null;
}

/** Bandas de Bollinger sobre las últimas `period` cierres (desviación poblacional). */
export function bollinger(
  closes: readonly number[],
  period = 20,
  mult = 2,
): { mid: number; upper: number; lower: number } | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid = slice.reduce((sum, c) => sum + c, 0) / period;
  const variance = slice.reduce((sum, c) => sum + (c - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  if (!isNum(mid) || !isNum(sd)) return null;
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd };
}

/** ATR de Wilder. Necesita `period + 1` velas; null si no. */
export function atrWilder(candles: readonly Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    if (!c || !prev) continue;
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  let atr = tr.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  for (let i = period; i < tr.length; i++) atr = (atr * (period - 1) + (tr[i] ?? 0)) / period;
  return isNum(atr) && atr > 0 ? atr : null;
}

/** ATR14 de 1h, 4h y diario sobre velas cerradas (se descarta la vela en curso). */
export function computeAtrs(input: {
  h1?: readonly Candle[];
  h4?: readonly Candle[];
  d1?: readonly Candle[];
}): { atr1h: number | null; atr4h: number | null; atrD: number | null } {
  const closed = (candles?: readonly Candle[]) => (candles ? candles.slice(0, -1) : []);
  return {
    atr1h: atrWilder(closed(input.h1)),
    atr4h: atrWilder(closed(input.h4)),
    atrD: atrWilder(closed(input.d1)),
  };
}

/** Paso del número redondo según la magnitud: 82.000 -> 1000, 3.000 -> 100, 150 -> 10. */
export function roundStep(price: number): number {
  if (!isPrice(price)) return 1;
  return 10 ** (Math.floor(Math.log10(price)) - 1);
}

/** Redondo más cercano por debajo y por encima del precio. */
export function roundNumbers(price: number): { below: number; above: number } | null {
  if (!isPrice(price)) return null;
  const step = roundStep(price);
  const clean = (n: number) => Number(n.toPrecision(12));
  const above = clean((Math.floor(price / step) + 1) * step);
  const below = clean((Math.ceil(price / step) - 1) * step);
  return { below, above };
}

interface RawLevel {
  price: number;
  kind: LevelKind;
  label?: string;
}

function collectRaw(input: BuildLevelsInput): RawLevel[] {
  const out: RawLevel[] = [];
  const push = (price: number | null | undefined, kind: LevelKind, label?: string) => {
    if (isPrice(price)) out.push({ price, kind, label });
  };
  const { d1 = [], w1 = [], h1 = [], h4 = [] } = input;

  const today = d1.at(-1);
  const prev = d1.at(-2);
  if (today) push(today.open, 'dayOpen');
  if (prev) {
    push(prev.high, 'prevDayHigh');
    push(prev.low, 'prevDayLow');
    if (isNum(prev.high) && isNum(prev.low) && isNum(prev.close)) {
      const pivot = (prev.high + prev.low + prev.close) / 3;
      push(pivot, 'pivot');
      push(2 * pivot - prev.low, 'r1');
      push(2 * pivot - prev.high, 's1');
    }
  }
  if (today) {
    const last = new Date(today.time * 1000);
    const monthStart = Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), 1) / 1000;
    const first = d1.find((c) => c.time === monthStart);
    if (first) push(first.open, 'monthOpen');
  }
  const thisWeek = w1.at(-1);
  const lastWeek = w1.at(-2);
  if (thisWeek) push(thisWeek.open, 'weekOpen');
  if (lastWeek) {
    push(lastWeek.high, 'prevWeekHigh');
    push(lastWeek.low, 'prevWeekLow');
  }

  const closes1h = h1.map((c) => c.close);
  push(ema(closes1h, 20), 'ema20_1h');
  push(ema(closes1h, 50), 'ema50_1h');
  push(ema(h4.map((c) => c.close), 50), 'ema50_4h');
  const bb = bollinger(closes1h, 20, 2);
  if (bb) {
    push(bb.upper, 'bbUpper');
    push(bb.lower, 'bbLower');
  }

  const rounds = roundNumbers(input.price);
  if (rounds) {
    push(rounds.below, 'round');
    push(rounds.above, 'round');
  }

  for (const row of input.findingsLevels ?? []) {
    const name = typeof row.label === 'string' && row.label ? ` · ${row.label}` : '';
    push(row.confirm, 'confirm', `Confirma${name}`);
    push(row.invalidate, 'invalidate', `Invalida${name}`);
  }
  return out;
}

function mergeRaw(raw: RawLevel[], reference: number): RawLevel[][] {
  const sorted = [...raw].sort((a, b) => a.price - b.price);
  const threshold = (MERGE_PCT / 100) * reference;
  const groups: RawLevel[][] = [];
  for (const level of sorted) {
    const group = groups[groups.length - 1];
    const anchor = group?.[0];
    if (group && anchor && level.price - anchor.price <= threshold) group.push(level);
    else groups.push([level]);
  }
  return groups;
}

/**
 * Escalera de niveles, del más alto al más bajo: como mucho `MAX_PER_SIDE`
 * por encima y por debajo del precio. Los niveles a menos de 0,1 % se funden.
 */
export function buildLevels(input: BuildLevelsInput): LevelRow[] {
  try {
    const { price } = input;
    if (!isPrice(price)) return [];
    const atr = computeAtrs({ h1: input.h1 }).atr1h;
    const rows: LevelRow[] = mergeRaw(collectRaw(input), price).map((group) => {
      const ordered = [...group].sort(
        (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
      );
      const mean = group.reduce((sum, l) => sum + l.price, 0) / group.length;
      const labels = ordered.map((l) => l.label ?? SHORT_LABEL[l.kind]);
      const head = ordered[0] as RawLevel;
      return {
        price: mean,
        kind: head.kind,
        kinds: ordered.map((l) => l.kind),
        label: labels.join(' + '),
        distancePct: ((mean - price) / price) * 100,
        distanceAtr: atr ? (mean - price) / atr : null,
      };
    });
    const above = rows.filter((r) => r.price >= price).sort((a, b) => a.price - b.price).slice(0, MAX_PER_SIDE);
    const below = rows.filter((r) => r.price < price).sort((a, b) => b.price - a.price).slice(0, MAX_PER_SIDE);
    return [...above, ...below].sort((a, b) => b.price - a.price);
  } catch {
    return [];
  }
}

export const RANGE_LABEL = 'rango típico (1 ATR)';

export interface RangeRow {
  id: '1h' | '4h' | '24h';
  /** Horizonte en texto corto: "próxima 1h". */
  horizon: string;
  label: string;
  low: number;
  high: number;
  atr: number;
  /** ATR como % del precio. */
  pct: number;
}

/** ±1 ATR alrededor del precio para 1h, 4h y 24h. Los horizontes sin ATR se omiten. */
export function expectedRange(input: {
  price: number;
  atr1h?: number | null;
  atr4h?: number | null;
  atrD?: number | null;
}): RangeRow[] {
  if (!isPrice(input.price)) return [];
  const defs: Array<[RangeRow['id'], string, number | null | undefined]> = [
    ['1h', 'próxima 1h', input.atr1h],
    ['4h', 'próximas 4h', input.atr4h],
    ['24h', 'próximas 24h', input.atrD],
  ];
  const rows: RangeRow[] = [];
  for (const [id, horizon, atr] of defs) {
    if (!isPrice(atr)) continue;
    rows.push({
      id,
      horizon,
      label: RANGE_LABEL,
      low: input.price - atr,
      high: input.price + atr,
      atr,
      pct: (atr / input.price) * 100,
    });
  }
  return rows;
}
