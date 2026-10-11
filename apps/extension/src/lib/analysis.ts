import * as coreModule from '@swal/analysis-core';
import type { AnalysisInput, AnalysisResult, Candle, Finding, VolumeFlow } from './types';

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
  /** Flujo de volumen (delta/CVD). El núcleo sin datos taker no lo expone. */
  volumeFlow?: (candles: readonly Candle[]) => VolumeFlow | null;
  default?:
    | ((input: AnalysisInput) => unknown)
    | { analyze?: (input: AnalysisInput) => unknown; analyzeSync?: (input: AnalysisInput) => unknown };
  ANALYSIS_CORE_STUB?: boolean;
}

const core = coreModule as AnalysisCoreModule;

/** Fallback de `top` si el núcleo no lo devuelve: fuerza primero, máx. 2 por tipo. */
export const TOP_LIMIT = 5;
export const TOP_PER_KIND = 2;

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asFindings(value: unknown): Finding[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Finding => isRecordLike(item) && typeof item.id === 'string');
}

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
    top: [],
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
  const rec = raw as { findings?: unknown; top?: unknown; trend?: unknown; levels?: unknown; generatedAt?: unknown; volumeFlow?: unknown };
  if (!Array.isArray(rec.findings)) return null;
  const levels = Array.isArray(rec.levels)
    ? rec.levels.filter((level): level is number => typeof level === 'number' && Number.isFinite(level))
    : [];
  return {
    findings: asFindings(rec.findings),
    top: asFindings(rec.top),
    trend: trendText(rec.trend),
    levels,
    volumeFlow: volumeFlow(rec.volumeFlow),
    generatedAt: typeof rec.generatedAt === 'string' ? rec.generatedAt : new Date().toISOString(),
  };
}

/** Acepta el flujo del núcleo o `null`; cualquier otra forma se descarta. */
function volumeFlow(value: unknown): VolumeFlow | null {
  if (!value || typeof value !== 'object') return null;
  const flow = value as Partial<VolumeFlow>;
  if (!Array.isArray(flow.delta) || !Array.isArray(flow.cvd)) return null;
  return {
    delta: flow.delta,
    cvd: flow.cvd,
    buyShare: Array.isArray(flow.buyShare) ? flow.buyShare : [],
  };
}

/**
 * Flujo de volumen calculado por el núcleo sobre `candles`. Es la única fuente
 * del panel de CVD: si el núcleo no expone `volumeFlow` (stub, velas sin dato
 * taker) devuelve `null` y el panel no pinta nada en lugar de inventar.
 */
export function volumeFlowOf(candles: readonly Candle[]): VolumeFlow | null {
  const fn = core.volumeFlow;
  if (typeof fn !== 'function') return null;
  try {
    return volumeFlow(fn(candles));
  } catch {
    return null;
  }
}

/**
 * `analyzeSync` devuelve `top`; `analyze` también. Si un núcleo antiguo solo
 * trae `findings`, el panel deriva un `top` diverso para no perder el gráfico.
 */
function selectTopFallback(findings: readonly Finding[]): Finding[] {
  const ranked = findings
    .map((finding, index) => ({ finding, index }))
    .sort(
      (a, b) =>
        Number(b.finding.strength ?? 0) - Number(a.finding.strength ?? 0) || a.index - b.index,
    );
  const perKind = new Map<string, number>();
  const out: Finding[] = [];
  for (const { finding } of ranked) {
    const kind = String(finding.kind ?? '');
    const seen = perKind.get(kind) ?? 0;
    if (seen >= TOP_PER_KIND) continue;
    perKind.set(kind, seen + 1);
    out.push(finding);
    if (out.length >= TOP_LIMIT) break;
  }
  return out;
}

export function analyze(input: AnalysisInput): AnalysisResult {
  const fn = pickAnalyze(core);
  if (!fn) return emptyResult();
  try {
    const result = toResult(fn(input)) ?? emptyResult();
    return { ...result, top: result.top.length > 0 ? result.top : selectTopFallback(result.findings) };
  } catch {
    return emptyResult();
  }
}
