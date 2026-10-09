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
  analyze?: (input: AnalysisInput) => AnalysisResult;
  default?:
    | ((input: AnalysisInput) => AnalysisResult)
    | { analyze?: (input: AnalysisInput) => AnalysisResult };
  ANALYSIS_CORE_STUB?: boolean;
}

const core = coreModule as AnalysisCoreModule;

export const usingAnalysisStub = core.ANALYSIS_CORE_STUB === true;

function pickAnalyze(
  mod: AnalysisCoreModule,
): ((input: AnalysisInput) => AnalysisResult) | null {
  if (typeof mod.analyze === 'function') return mod.analyze;
  const fallback = mod.default;
  if (typeof fallback === 'function') return fallback;
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

export function analyze(input: AnalysisInput): AnalysisResult {
  const fn = pickAnalyze(core);
  if (!fn) return emptyResult();
  try {
    const result = fn(input);
    if (!result || !Array.isArray(result.findings)) return emptyResult();
    return {
      findings: result.findings,
      trend: typeof result.trend === 'string' ? result.trend : null,
      levels: Array.isArray(result.levels) ? result.levels : [],
      generatedAt: typeof result.generatedAt === 'string' ? result.generatedAt : emptyResult().generatedAt,
    };
  } catch {
    return emptyResult();
  }
}
