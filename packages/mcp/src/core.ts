import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import type { Candle } from "./types.js";
import { isRecord } from "./types.js";

export const ANALYSIS_CORE_MISSING = "analysis core not available";

/** Default location relative to the package directory (packages/mcp), valid in a repo checkout. */
export const DEFAULT_CORE_RELATIVE = "../../workers/public-site/static/analisis/analysis-core.js";

/**
 * Copy of the core shipped inside the npm package (`npm pack` runs scripts/bundle-core.mjs).
 * An installed package has no repo around it, so the checkout path above does not exist there.
 */
export const PACKAGED_CORE_RELATIVE = "core/analysis-core.js";

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
  if (configured) return path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(root, configured);
  // A checkout keeps using the repo's own file (so it is never stale); an installed package
  // falls back to the copy bundled at pack time. If neither exists the repo path is returned so
  // the "analysis core not available" error still names the expected location.
  const repoCore = path.resolve(root, DEFAULT_CORE_RELATIVE);
  if (existsSync(repoCore)) return repoCore;
  const packaged = path.resolve(root, PACKAGED_CORE_RELATIVE);
  return existsSync(packaged) ? packaged : repoCore;
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
