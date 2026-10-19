import { LEVEL_KINDS, type LevelKind } from '../context/levels';
import { DRAWING_HONEST_LINE } from './analyze';
import type { DrawingAnalysis } from './types';

/**
 * Payload RELATIVO para la IA a partir del análisis de un dibujo. Solo
 * porcentajes, múltiplos de ATR, R:R, códigos de nivel y códigos de check:
 * NUNCA cantidades, nocional, capital, margen, USD ni texto libre (ni
 * etiquetas de nivel ni textos de check, que podrían venir de fuera). Sigue
 * las reglas de `src/lib/ai/payload.ts` (nunca precios absolutos en modo
 * relativo) y construye el payload desde listas blancas.
 */

export interface DrawingLevelPayload {
  /** Tipo de nivel (código de `LEVEL_KINDS`), nunca la etiqueta visible. */
  kind: LevelKind;
  /** Todos los tipos fusionados en la fila, también como códigos. */
  kinds: LevelKind[];
  distance_pct: number | null;
  distance_atr: number | null;
}

export interface DrawingCheckPayload {
  /** Código del check (lista blanca), nunca su texto. */
  code: string;
  sev: 'info' | 'warn';
}

export interface DrawingAiPayload {
  schema: 'swal.drawing.v1';
  symbol: string;
  side: 'long' | 'short';
  entry_mode: 'mercado' | 'limite' | 'stop';
  entry_distance_pct: number | null;
  risk_pct: number | null;
  reward_pct: number | null;
  rr: number | null;
  rr_neto: number | null;
  stop_atr1h: number | null;
  target_atr1h: number | null;
  target_atr4h: number | null;
  target_atr_d: number | null;
  fee_share_of_risk: number | null;
  funding_cost_pct_risk_8h: number | null;
  funding_side_pays: boolean;
  smallest_horizon: '1h' | '4h' | '24h' | null;
  niveles: DrawingLevelPayload[];
  checks: DrawingCheckPayload[];
  honest_line: string;
}

const MAX_LEVELS = 7;
const MAX_CHECKS = 8;
const SYMBOL_RE = /^[A-Z0-9]{2,20}$/;
const CODE_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** Códigos de check que el análisis puede emitir; cualquier otro se descarta. */
const ALLOWED_CHECK_CODES: ReadonlySet<string> = new Set([
  'fees_eat_risk',
  'tiny_stop',
  'entry_stop',
  'stop_near_level',
  'target_near_level',
  'target_vs_4h',
  'leverage_breach',
  'daily_loss_breach',
  'stop_wide',
]);

const ALLOWED_LEVEL_KINDS: ReadonlySet<string> = new Set(LEVEL_KINDS);

const num = (value: number | null | undefined, dp = 2): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10 ** dp) / 10 ** dp : null;

const levelKind = (value: unknown): LevelKind | null =>
  typeof value === 'string' && ALLOWED_LEVEL_KINDS.has(value) ? (value as LevelKind) : null;

export function drawingAiPayload(analysis: DrawingAnalysis): DrawingAiPayload {
  const g = analysis.geometry;
  const niveles: DrawingLevelPayload[] = [];
  for (const level of analysis.levels.betweenEntryAndTarget) {
    if (niveles.length >= MAX_LEVELS) break;
    const kind = levelKind(level.kind);
    if (kind === null) continue;
    const kinds = (Array.isArray(level.kinds) ? level.kinds : []).filter(
      (k): k is LevelKind => levelKind(k) !== null,
    );
    niveles.push({
      kind,
      kinds: kinds.length > 0 ? kinds : [kind],
      distance_pct: num(level.distancePctFromEntry, 2),
      distance_atr: num(level.distanceAtrFromEntry, 2),
    });
  }

  const checks: DrawingCheckPayload[] = [];
  for (const check of analysis.checks) {
    if (checks.length >= MAX_CHECKS) break;
    if (typeof check.code !== 'string' || !ALLOWED_CHECK_CODES.has(check.code) || !CODE_RE.test(check.code)) continue;
    checks.push({ code: check.code, sev: check.severity === 'warn' ? 'warn' : 'info' });
  }

  return {
    schema: 'swal.drawing.v1',
    symbol: typeof analysis.symbol === 'string' && SYMBOL_RE.test(analysis.symbol) ? analysis.symbol : 'UNKNOWN',
    side: analysis.side === 'short' ? 'short' : 'long',
    entry_mode: g.entryMode === 'límite' ? 'limite' : g.entryMode === 'stop' ? 'stop' : 'mercado',
    entry_distance_pct: num(g.entryDistancePct, 2),
    risk_pct: num(g.riskPct, 2),
    reward_pct: num(g.rewardPct, 2),
    rr: num(g.rr, 2),
    rr_neto: num(analysis.costs.netRr, 2),
    stop_atr1h: num(g.stopAtr1h, 2),
    target_atr1h: num(g.targetAtr1h, 2),
    target_atr4h: num(analysis.reach.targetAtr4h, 2),
    target_atr_d: num(analysis.reach.targetAtrD, 2),
    fee_share_of_risk: num(analysis.costs.feeShareOfRisk, 2),
    funding_cost_pct_risk_8h: num(analysis.funding.pctOfRiskPer8h, 2),
    funding_side_pays: analysis.funding.sidePays,
    smallest_horizon: analysis.reach.smallestHorizon,
    niveles,
    checks,
    honest_line: DRAWING_HONEST_LINE,
  };
}
