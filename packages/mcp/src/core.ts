import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import type { Candle } from "./types.js";
import { isRecord } from "./types.js";

export const ANALYSIS_CORE_MISSING = "analysis core not available";

/** Default location relative to the package directory (packages/mcp). */
export const DEFAULT_CORE_RELATIVE = "../../workers/public-site/static/analisis/analysis-core.js";

export interface Finding {
  id: string;
  kind: string;
  label: string;
  explanation: string;
  from: number;
  to: number;
  levels: unknown;
  direction: string;
  strength: number;
  evidence: unknown;
}

export interface AnalysisResult {
  findings: Finding[];
  trend: unknown;
  levels: unknown;
  generatedAt: string;
}

export interface AnalyzeInput {
  symbol: string;
  timeframe: string;
  candles: Candle[];
}

export type AnalyzeFn = (input: AnalyzeInput) => Promise<AnalysisResult>;

export type CoreLoad =
  | { ok: true; analyze: AnalyzeFn; path: string }
  | { ok: false; error: typeof ANALYSIS_CORE_MISSING; path: string };

export function packageRoot(moduleUrl: string = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..");
}

export function resolveCorePath(env: NodeJS.ProcessEnv, root: string = packageRoot()): string {
  const configured = env.SWAL_ANALYSIS_CORE?.trim();
  if (!configured) return path.resolve(root, DEFAULT_CORE_RELATIVE);
  return path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(root, configured);
}

function strengthOf(value: unknown): number {
  if (!isRecord(value)) return Number.NEGATIVE_INFINITY;
  const strength = value.strength;
  return typeof strength === "number" && Number.isFinite(strength) ? strength : Number.NEGATIVE_INFINITY;
}

export function withSortedFindings(
  result: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!isRecord(result) || !Array.isArray(result.findings)) {
    return { ok: false, error: "analysis core returned an unexpected result" };
  }
  const findings = [...result.findings].sort((left, right) => strengthOf(right) - strengthOf(left));
  return { ok: true, value: { ...result, findings } };
}

export async function loadAnalysisCore(env: NodeJS.ProcessEnv, root?: string): Promise<CoreLoad> {
  const resolved = resolveCorePath(env, root);
  try {
    const imported: unknown = await import(pathToFileURL(resolved).href);
    if (!isRecord(imported) || typeof imported.analyze !== "function") {
      return { ok: false, error: ANALYSIS_CORE_MISSING, path: resolved };
    }
    const analyze = imported.analyze as AnalyzeFn;
    return { ok: true, analyze, path: resolved };
  } catch {
    return { ok: false, error: ANALYSIS_CORE_MISSING, path: resolved };
  }
}
