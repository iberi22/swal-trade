import type { AnalysisInput, AnalysisResult } from './types';

/**
 * TODO: quitar este stub cuando exista
 * `workers/public-site/static/analisis/analysis-core.js`.
 * El alias `@swal/analysis-core` apunta a ese archivo si está en disco;
 * si no, apunta aquí. No inventa hallazgos ni porcentajes.
 */
export const ANALYSIS_CORE_STUB = true;

export function analyze(_input: AnalysisInput): AnalysisResult {
  return {
    findings: [],
    trend: null,
    levels: [],
    generatedAt: new Date(0).toISOString(),
  };
}
