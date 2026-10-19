import { DRAWING_HONEST_LINE } from './analyze';
import type { DrawingAnalysis } from './types';

/**
 * Payload RELATIVO para la IA a partir del análisis de un dibujo. Solo
 * porcentajes, múltiplos de ATR, R:R y etiquetas de nivel con distancias
 * relativas: NUNCA cantidades, nocional, capital, margen ni USD. Sigue las
 * reglas de `src/lib/ai/payload.ts` (nunca precios absolutos en modo relativo).
 */

export interface DrawingLevelPayload {
  label: string;
  distance_pct: number | null;
  distance_atr: number | null;
}

export interface DrawingCheckPayload {
  code: string;
  sev: 'info' | 'warn';
  text: string;
}

export interface DrawingAiPayload {
  schema: 'swal.drawing.v1';
  symbol: string;
  side: 'long' | 'short';
  entry_mode: 'mercado' | 'limite';
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

const num = (value: number | null | undefined, dp = 2): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10 ** dp) / 10 ** dp : null;

export function drawingAiPayload(analysis: DrawingAnalysis): DrawingAiPayload {
  const g = analysis.geometry;
  const niveles: DrawingLevelPayload[] = analysis.levels.betweenEntryAndTarget.slice(0, MAX_LEVELS).map((l) => ({
    label: l.label,
    distance_pct: num(l.distancePctFromEntry, 2),
    distance_atr: num(l.distanceAtrFromEntry, 2),
  }));

  const checks: DrawingCheckPayload[] = analysis.checks.slice(0, MAX_CHECKS).map((c) => ({
    code: c.code,
    sev: c.severity,
    text: c.text,
  }));

  return {
    schema: 'swal.drawing.v1',
    symbol: analysis.symbol,
    side: analysis.side,
    entry_mode: g.entryMode === 'límite' ? 'limite' : 'mercado',
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
