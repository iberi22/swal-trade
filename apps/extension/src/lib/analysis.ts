import * as coreModule from '@swal/analysis-core';
import type { AnalysisInput, AnalysisResult } from './types';

/**
 * Punto de integración con el núcleo determinista compartido.
 *
 * El alias `@swal/analysis-core` (wxt.config.ts / vitest.config.ts) resuelve a
 * `workers/public-site/static/analisis/analysis-core.js`.
 * TODO: ese módulo se escribe en paralelo y puede no existir en el build.
 * En ese caso el alias usa `analysis-core-stub.ts`, que devuelve hallazgos
 * vacíos. Sin medición histórica no se muestra un porcentaje de acierto.
 */
interface AnalysisCoreModule {
  /** Sync entry of the shared core. The panel cannot await. */
  analyzeSync?: (input: AnalysisInput) => unknown;
  analyze?: (input: AnalysisInput) => unknown;
  default?:
    | ((input: AnalysisInput) => unknown)
    | { analyze?: (input: AnalysisInput) => unknown; analyzeSync?: (input: AnalysisInput) => unknown };
  ANALYSIS_CORE_STUB?: boolean;
}

const core = coreModule as AnalysisCoreModule;

export const usingAnalysisStub = core.ANALYSIS_CORE_STUB === true;

function pickAnalyze(mod: AnalysisCoreModule): ((input: AnalysisInput) => unknown) | null {
  // analysis-core.js exports `analyze` as async. Calling it here dropped every
  // finding: a Promise has no `findings`, so the panel always rendered empty.
  if (typeof mod.analyzeSync === 'function') return mod.analyzeSync;
  if (typeof mod.analyze === 'function') return mod.analyze;
  const fallback = mod.default;
  if (typeof fallback === 'function') return fallback;
  if (fallback && typeof fallback.analyzeSync === 'function') return fallback.analyzeSync;
  if (fallback && typeof fallback.analyze === 'function') return fallback.analyze;
  return null;
}

function emptyResult(): AnalysisResult {
  return {
    findings: [],
    trend: null,
    levels: [],
    generatedAt: new Date(0).toISOString(),
  };
}

function trendText(trend: unknown): string | null {
  if (typeof trend === 'string') return trend;
  if (trend && typeof trend === 'object' && typeof (trend as { label?: unknown }).label === 'string') {
    return (trend as { label: string }).label;
  }
  return null;
}

function toResult(raw: unknown): AnalysisResult | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof (raw as { then?: unknown }).then === 'function') return null;
  const rec = raw as { findings?: unknown; trend?: unknown; levels?: unknown; generatedAt?: unknown };
  if (!Array.isArray(rec.findings)) return null;
  const levels = Array.isArray(rec.levels)
    ? rec.levels.filter((level): level is number => typeof level === 'number' && Number.isFinite(level))
    : [];
  return {
    findings: rec.findings as AnalysisResult['findings'],
    trend: trendText(rec.trend),
    levels,
    generatedAt: typeof rec.generatedAt === 'string' ? rec.generatedAt : new Date().toISOString(),
  };
}

export function analyze(input: AnalysisInput): AnalysisResult {
  const fn = pickAnalyze(core);
  if (!fn) return emptyResult();
  try {
    return toResult(fn(input)) ?? emptyResult();
  } catch {
    return emptyResult();
  }
}
