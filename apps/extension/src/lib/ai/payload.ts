import type { AccountSnapshot, PositionView } from '../account/types';

// rules.ts / metrics.ts no existen aun en main: tipos estructurales locales.
export interface PayloadRule {
  code: string;
  sev: string;
}

export interface PayloadFinding {
  kind: string;
  dir: 'up' | 'down';
  fuerza: number;
  invalida_pct: number;
}

export interface PositionPayloadInput {
  symbol: string;
  tf: string;
  position: PositionView;
  snapshot: AccountSnapshot;
  atr: number | null;
  rules: PayloadRule[];
  contexto?: { trend?: string; findings?: PayloadFinding[] };
  /** Tope de riesgo por operacion de las reglas del usuario (% de equity). */
  ruleMaxRiskPct?: number;
}

export type Redaction = 'relative' | 'absolute';

export interface AiPositionPayload {
  schema: 'swal.position.v1';
  symbol: string;
  tf: string;
  side: 'long' | 'short';
  leverage: number;
  marginType: 'cross' | 'isolated';
  r_current: number | null;
  r_initial: number | null;
  dist_stop_pct: number | null;
  dist_liq_pct: number | null;
  liq_in_atr: number | null;
  stop: 'present' | 'absent';
  risk_pct_equity: number | null;
  rule_max_risk_pct: number;
  funding_rate: number | null;
  funding_min: number | null;
  held_min: number | null;
  reglas: PayloadRule[];
  contexto?: { trend?: string; findings: PayloadFinding[] };
  redaction: Redaction;
  /** Solo en modo absolute. */
  precios?: { entry: number; mark: number; stop: number | null; liq: number | null; notional: number };
}

export interface HistoryBucketInput {
  by: 'symbol' | 'side' | 'hour';
  key: string | number;
  n: number;
}

export interface HistoryMetricsInput {
  n: number;
  wins: number;
  meanR?: number | null;
  meanRCi?: [number, number] | null;
  profitFactor?: number | null;
  feesPctGross?: number | null;
  fundingPctGross?: number | null;
  maxDrawdownPct?: number | null;
  buckets?: HistoryBucketInput[];
  revenge?: number;
  sizeUpAfterLoss?: number;
  grade?: string | null;
}

export interface AiHistoryPayload {
  schema: 'swal.history.v1';
  n: number;
  win_rate: number | null;
  wilson_lo: number | null;
  wilson_hi: number | null;
  mean_r: number | null;
  mean_r_ci: [number, number] | null;
  profit_factor: number | null;
  fees_pct_gross: number | null;
  funding_pct_gross: number | null;
  max_drawdown_pct: number | null;
  buckets: { by: 'symbol' | 'side' | 'hour'; key: string | number; n: number }[];
  revenge: number;
  size_up_after_loss: number;
  grade: string | null;
  redaction: Redaction;
}

export const PAYLOAD_MAX_CHARS = 2800;
export const DEFAULT_RULE_MAX_RISK_PCT = 2;

const SYMBOL_RE = /^[A-Z0-9]{2,20}$/;
const KIND_RE = /^[a-z_]{1,40}$/;
const TF_RE = /^[0-9]{1,3}[smhdwM]$/;
const CODE_RE = /^[a-z0-9_.-]{1,40}$/i;
const SEV_RE = /^[a-z]{1,12}$/i;
const GRADE_RE = /^[A-F][+-]?$/;

const num = (v: unknown, dp = 2): number | null => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};
const count = (v: unknown): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0;
  return Math.max(0, Math.min(n, 1_000_000));
};

function cleanFindings(list: PayloadFinding[] | undefined): PayloadFinding[] {
  const out: PayloadFinding[] = [];
  for (const f of Array.isArray(list) ? list : []) {
    if (!f || typeof f.kind !== 'string' || !KIND_RE.test(f.kind)) continue;
    if (f.dir !== 'up' && f.dir !== 'down') continue;
    const fuerza = num(f.fuerza, 2);
    const inv = num(f.invalida_pct, 2);
    if (fuerza === null || inv === null) continue;
    out.push({ kind: f.kind, dir: f.dir, fuerza, invalida_pct: inv });
    if (out.length >= 3) break;
  }
  return out;
}

export function buildPositionPayload(input: PositionPayloadInput, redaction: Redaction): AiPositionPayload {
  if (typeof input.symbol !== 'string' || !SYMBOL_RE.test(input.symbol)) {
    throw new Error('invalid symbol');
  }
  const p = input.position;
  const snap = input.snapshot;
  const stop = p.stop?.price ?? null;
  const mark = p.mark;
  const riskUnit = stop !== null ? Math.abs(p.entry - stop) : 0;
  const dir = p.side === 'long' ? 1 : -1;
  const rCurrent = riskUnit > 0 ? ((mark - p.entry) * dir) / riskUnit : null;
  const equity = snap.equity;
  const riskPct =
    riskUnit > 0 && equity !== null && equity > 0 ? ((p.size * riskUnit) / equity) * 100 : null;
  const distLiq = p.liq !== null && mark > 0 ? (Math.abs(mark - p.liq) / mark) * 100 : null;
  const liqAtr =
    p.liq !== null && input.atr !== null && input.atr > 0 ? Math.abs(mark - p.liq) / input.atr : null;
  const fundingMin =
    snap.nextFundingMs !== null ? Math.max(0, Math.round((snap.nextFundingMs - snap.fetchedAt) / 60000)) : null;
  const heldMin =
    p.firstFillMs !== null ? Math.max(0, Math.round((snap.fetchedAt - p.firstFillMs) / 60000)) : null;

  const reglas: PayloadRule[] = [];
  for (const r of Array.isArray(input.rules) ? input.rules : []) {
    if (r && typeof r.code === 'string' && typeof r.sev === 'string' && CODE_RE.test(r.code) && SEV_RE.test(r.sev)) {
      reglas.push({ code: r.code, sev: r.sev });
    }
    if (reglas.length >= 10) break;
  }

  const payload: AiPositionPayload = {
    schema: 'swal.position.v1',
    symbol: input.symbol,
    tf: TF_RE.test(input.tf) ? input.tf : '15m',
    side: p.side === 'short' ? 'short' : 'long',
    leverage: num(p.leverage, 1) ?? 1,
    marginType: p.marginType === 'isolated' ? 'isolated' : 'cross',
    r_current: num(rCurrent, 2),
    // El stop puede haberse movido; el inicial no es conocible desde el snapshot.
    r_initial: null,
    dist_stop_pct: stop !== null && mark > 0 ? num((Math.abs(mark - stop) / mark) * 100, 2) : null,
    dist_liq_pct: num(distLiq, 2),
    liq_in_atr: num(liqAtr, 2),
    stop: stop !== null ? 'present' : 'absent',
    risk_pct_equity: num(riskPct, 2),
    rule_max_risk_pct: num(input.ruleMaxRiskPct, 2) ?? DEFAULT_RULE_MAX_RISK_PCT,
    funding_rate: num(snap.fundingRate, 6),
    funding_min: fundingMin,
    held_min: heldMin,
    reglas,
    redaction: redaction === 'absolute' ? 'absolute' : 'relative',
  };
  if (input.contexto) {
    const ctx: { trend?: string; findings: PayloadFinding[] } = { findings: cleanFindings(input.contexto.findings) };
    const t = input.contexto.trend;
    if (typeof t === 'string' && KIND_RE.test(t)) ctx.trend = t;
    payload.contexto = ctx;
  }
  if (payload.redaction === 'absolute') {
    payload.precios = {
      entry: p.entry,
      mark: p.mark,
      stop,
      liq: p.liq,
      notional: Math.round(p.notional * 100) / 100,
    };
  }
  return payload;
}

function wilson(wins: number, n: number): [number, number] | null {
  if (n <= 0) return null;
  const z = 1.96;
  const ph = wins / n;
  const d = 1 + (z * z) / n;
  const c = ph + (z * z) / (2 * n);
  const m = z * Math.sqrt((ph * (1 - ph)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

export function buildHistoryPayload(metrics: HistoryMetricsInput, redaction: Redaction): AiHistoryPayload {
  const n = count(metrics.n);
  const wins = Math.min(count(metrics.wins), n);
  const w = wilson(wins, n);
  const buckets: AiHistoryPayload['buckets'] = [];
  for (const b of Array.isArray(metrics.buckets) ? metrics.buckets : []) {
    if (!b) continue;
    let key: string | number | null = null;
    if (b.by === 'symbol' && typeof b.key === 'string' && SYMBOL_RE.test(b.key)) key = b.key;
    else if (b.by === 'side' && (b.key === 'long' || b.key === 'short')) key = b.key;
    else if (b.by === 'hour' && typeof b.key === 'number' && Number.isInteger(b.key) && b.key >= 0 && b.key <= 23) key = b.key;
    if (key === null) continue;
    buckets.push({ by: b.by, key, n: count(b.n) });
  }
  buckets.sort((a, b) => b.n - a.n);
  const ci = metrics.meanRCi;
  const lo = ci ? num(ci[0], 2) : null;
  const hi = ci ? num(ci[1], 2) : null;
  const grade = typeof metrics.grade === 'string' && GRADE_RE.test(metrics.grade) ? metrics.grade : null;
  return {
    schema: 'swal.history.v1',
    n,
    win_rate: n > 0 ? num(wins / n, 3) : null,
    wilson_lo: w ? num(w[0], 3) : null,
    wilson_hi: w ? num(w[1], 3) : null,
    mean_r: num(metrics.meanR, 2),
    mean_r_ci: lo !== null && hi !== null ? [lo, hi] : null,
    profit_factor: num(metrics.profitFactor, 2),
    fees_pct_gross: num(metrics.feesPctGross, 1),
    funding_pct_gross: num(metrics.fundingPctGross, 1),
    max_drawdown_pct: num(metrics.maxDrawdownPct, 1),
    buckets: buckets.slice(0, 3),
    revenge: count(metrics.revenge),
    size_up_after_loss: count(metrics.sizeUpAfterLoss),
    grade,
    redaction: redaction === 'absolute' ? 'absolute' : 'relative',
  };
}

/**
 * JSON para el LLM con tope duro; descarta lo menos prioritario hasta caber.
 * También acepta el payload de un dibujo (`swal.drawing.v1`), que ya es relativo
 * por construcción: si hiciera falta, se tiran sus listas de niveles y checks.
 */
export function serializeForLlm(
  payload: AiPositionPayload | AiHistoryPayload | { schema: 'swal.drawing.v1' },
): string {
  const work: Record<string, unknown> = { ...payload };
  let s = JSON.stringify(work);
  const drops =
    payload.schema === 'swal.position.v1'
      ? ['contexto', 'precios', 'reglas']
      : payload.schema === 'swal.history.v1'
        ? ['buckets']
        : ['niveles', 'checks'];
  for (const key of drops) {
    if (s.length <= PAYLOAD_MAX_CHARS) break;
    delete work[key];
    s = JSON.stringify(work);
  }
  if (s.length > PAYLOAD_MAX_CHARS) throw new Error('payload too large');
  return s;
}
