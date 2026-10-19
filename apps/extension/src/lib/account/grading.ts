// Port de radar/grading.py. Mismas reglas y umbrales.
// El bootstrap usa mulberry32 con semilla: es determinista pero NO coincide
// bit a bit con random.Random de Python; solo el intervalo es comparable.

export const MIN_N_VALIDATED = 100;
export const MIN_N_PROMISING = 30;
export const BREAKEVEN_MARGIN = 0.02;
export const DEFAULT_RR = 1.0;
export const DEFAULT_COST_R = 0.0008;

export type CellGrade = 'no_evidence' | 'negative' | 'promising' | 'validated';

export type GradeReason =
  | 'n_below_30'
  | 'n_below_100'
  | 'below_breakeven'
  | 'not_above_breakeven_margin'
  | 'mean_net_r_not_positive'
  | 'not_above_random_baseline'
  | 'did_not_meet_criteria';

export interface GradeCellInput {
  n: number;
  wins: number;
  netRs: number[];
  rr?: number;
  costR?: number;
  baselineWinRate?: number | null;
}

export interface CellGradeResult {
  grade: CellGrade;
  reasons: GradeReason[];
  n: number;
  winRate: number;
  wilsonLow: number | null;
  wilsonHigh: number | null;
  breakeven: number;
  meanNetR: number;
  meanNetRCi: [number, number] | null;
}

export function breakevenWinRate(rr: number, costR: number): number {
  return (1 + costR) / (rr + 1);
}

export function wilsonBounds(wins: number, n: number): [number | null, number | null] {
  if (!Number.isFinite(n) || !Number.isFinite(wins) || n <= 0) return [null, null];
  const p = wins / n;
  const z = 1.95996;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bootstrapMeanCi(
  values: number[],
  iters = 2000,
  seed = 7,
): [number, number] | null {
  if (values.length === 0) return null;
  const rng = mulberry32(seed);
  const n = values.length;
  const means: number[] = [];
  for (let i = 0; i < iters; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += values[Math.floor(rng() * n)];
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(iters * 0.025)], means[Math.floor(iters * 0.975)]];
}

export function gradeCell(input: GradeCellInput): CellGradeResult {
  const rr = input.rr ?? DEFAULT_RR;
  const costR = input.costR ?? DEFAULT_COST_R;
  const baseline = input.baselineWinRate ?? null;
  const breakeven = breakevenWinRate(rr, costR);
  const reasons: GradeReason[] = [];

  const n = Number.isFinite(input.n) ? input.n : 0;
  if (n <= 0) {
    return {
      grade: 'no_evidence',
      reasons: ['n_below_30'],
      n: 0,
      winRate: 0,
      wilsonLow: null,
      wilsonHigh: null,
      breakeven,
      meanNetR: 0,
      meanNetRCi: null,
    };
  }

  const netRs = (input.netRs ?? []).filter((v) => Number.isFinite(v));
  const wins = Number.isFinite(input.wins) ? input.wins : 0;
  const [wilsonLow, wilsonHigh] = wilsonBounds(wins, n);
  const meanNetR = netRs.length ? netRs.reduce((s, v) => s + v, 0) / netRs.length : 0;
  const ci = netRs.length ? bootstrapMeanCi(netRs) : null;

  const result: CellGradeResult = {
    grade: 'no_evidence',
    reasons,
    n,
    winRate: wins / n,
    wilsonLow,
    wilsonHigh,
    breakeven,
    meanNetR,
    meanNetRCi: ci,
  };

  if (n < MIN_N_PROMISING) {
    reasons.push('n_below_30');
    return result;
  }

  if (ci !== null && ci[1] < 0) {
    result.grade = 'negative';
    return result;
  }

  if (
    n >= MIN_N_VALIDATED &&
    wilsonLow !== null &&
    wilsonLow >= breakeven + BREAKEVEN_MARGIN &&
    ci !== null &&
    ci[0] > 0 &&
    (baseline === null || wilsonLow > baseline)
  ) {
    result.grade = 'validated';
    return result;
  }

  if (
    n < MIN_N_VALIDATED &&
    wilsonLow !== null &&
    wilsonLow > breakeven &&
    ci !== null &&
    ci[0] > 0
  ) {
    result.grade = 'promising';
    return result;
  }

  if (n < MIN_N_VALIDATED) reasons.push('n_below_100');
  if (wilsonLow === null || wilsonLow <= breakeven) {
    reasons.push('below_breakeven');
  } else if (wilsonLow < breakeven + BREAKEVEN_MARGIN && n >= MIN_N_VALIDATED) {
    reasons.push('not_above_breakeven_margin');
  }
  if (ci === null || ci[0] <= 0) reasons.push('mean_net_r_not_positive');
  if (baseline !== null && wilsonLow !== null && wilsonLow <= baseline) {
    reasons.push('not_above_random_baseline');
  }
  if (reasons.length === 0) reasons.push('did_not_meet_criteria');
  return result;
}
