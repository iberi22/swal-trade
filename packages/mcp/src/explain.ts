/**
 * Explicador IA para `explain_analysis`. Copia espejo del endpoint alojado
 * `POST /api/explain` de workers/public-site/src/explain.js (el paquete se publica
 * solo y no puede importar el worker).
 *
 * Orden: se analiza el gráfico en local con el mismo núcleo determinista que usa
 * `analyze_chart` y el resultado se manda al endpoint alojado, que añade los titulares
 * del store y llama al modelo. Si no hay URL configurada, no hay red o el hosting
 * contesta con error, la tool devuelve el respaldo determinista: descripción de cada
 * hallazgo con sus niveles, sin interpretación del modelo.
 *
 * Nada de órdenes, nada de porcentajes inventados: strength es calidad del patrón,
 * no probabilidad, y la tasa de acierto histórica no está medida.
 */

import { isRecord } from "./types.js";
import type { FetchLike } from "./types.js";

export const EXPLAIN_URL_DEFAULT = "https://trade.swal.network/api/explain";
export const EXPLAIN_TIMEOUT_MS = 20_000;
/** Nota cuando no hay explicación alojada ni respaldo posible. */
export const EXPLAIN_NOTE = "requires the hosted explain endpoint or SWAL membership";
/** Aviso que viaja en cada respuesta, igual que en el worker y en la UI. */
export const EXPLAIN_DISCLAIMER =
  "Información educativa generada a partir de patrones deterministas. No es asesoría financiera ni una recomendación de inversión.";
export const EXPLAIN_FALLBACK_NOTE =
  "Respuesta construida con reglas fijas, sin modelo de lenguaje: describe los hallazgos y sus niveles, sin interpretación añadida.";
export const EXPLAIN_MAX_SCENARIOS = 5;
export const EXPLAIN_MAX_FINDINGS = 20;

const DEFAULT_RISK_NOTE =
  "Define el stop antes de entrar y usa un tamaño que aguante el fallo; apalancamiento 1x como punto de partida.";
const DEFAULT_CAUTION =
  "La fuerza del patrón no es una probabilidad y la tasa de acierto histórico no está medida. Opera con stop y tamaño pequeño o no operes.";

export interface ExplainFinding {
  id?: unknown;
  kind?: unknown;
  label?: unknown;
  explanation?: unknown;
  direction?: unknown;
  strength?: unknown;
  status?: unknown;
  levels?: unknown;
}

export interface ExplainAnalysis {
  top: ExplainFinding[];
  trend: Record<string, unknown> | null;
  levels: unknown[];
}

export interface ExplainRequest {
  symbol: string;
  timeframe: string;
  analysis: ExplainAnalysis;
}

export interface ExplainPayload {
  source: "ai" | "fallback" | "cache";
  summary: string;
  scenarios: { name: string; condition: string; invalidation: string; risk_note: string }[];
  caution: string;
}

/** URL del endpoint alojado, o null para trabajar solo con el respaldo local. */
export function explainUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = env.SWAL_EXPLAIN_URL?.trim();
  if (raw === "") return null;
  if (!raw) return EXPLAIN_URL_DEFAULT;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  return url.origin + url.pathname;
}

export function explainTimeoutMs(env: NodeJS.ProcessEnv): number {
  const value = Number(env.SWAL_EXPLAIN_TIMEOUT_MS);
  if (!Number.isFinite(value) || value <= 0) return EXPLAIN_TIMEOUT_MS;
  return Math.min(60_000, Math.floor(value));
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function num(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function direction(value: unknown): "up" | "down" | "neutral" {
  return value === "up" || value === "down" ? value : "neutral";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Niveles de confirmación e invalidación, igual que levelsOf() en el worker. */
export function levelsOf(finding: ExplainFinding): { confirm: number; invalidate: number } | null {
  const level = asArray(finding.levels)
    .filter(isRecord)
    .map((row) => ({ confirm: num(row.confirm), invalidate: num(row.invalidate) }))
    .find((row) => row.confirm !== null && row.invalidate !== null);
  return level ? { confirm: level.confirm as number, invalidate: level.invalidate as number } : null;
}

/** true si los hallazgos principales señalan en direcciones opuestas. */
export function directionsConflict(findings: ExplainFinding[]): boolean {
  const ups = findings.filter((finding) => direction(finding.direction) === "up").length;
  const downs = findings.filter((finding) => finding.direction === "down").length;
  return ups > 0 && downs > 0;
}

/**
 * Explicación determinista, sin modelo. Es la respuesta cuando el endpoint alojado no
 * está configurado, no responde o devuelve error: la tool nunca falla por la IA.
 */
export function explainFallback(analysis: ExplainAnalysis, symbol: string, timeframe: string, reason: string): ExplainPayload {
  const top = asArray(analysis.top)
    .filter(isRecord)
    .slice(0, EXPLAIN_MAX_SCENARIOS) as ExplainFinding[];
  const pct = Math.round((num(top[0]?.strength) ?? 0) * 100);
  const summary =
    top.length === 0
      ? `En ${symbol} (${timeframe}) el análisis determinista no ve patrones claros en esta ventana. Sin patrón no hay escenario que explicar: lo coherente es esperar.`
      : `En ${symbol} (${timeframe}) el análisis determinista ve ${top.length} patrón(es). El de mayor fuerza del patrón es ${text(top[0]?.label ?? top[0]?.kind, 120)} (fuerza ${pct}/100). ` +
        (directionsConflict(top) ? "Los patrones no señalan todos en la misma dirección: cuando se contradicen, lo prudente es esperar. " : "");
  const scenarios = top.map((finding) => {
    const levels = levelsOf(finding);
    const above = direction(finding.direction) === "down" ? "por debajo de" : "por encima de";
    const below = direction(finding.direction) === "down" ? "por encima de" : "por debajo de";
    return {
      name: text(finding.label ?? finding.kind, 120) || "Patrón",
      condition: levels
        ? `Se confirma si el precio cierra ${above} ${levels.confirm} y se mantiene ahí.`
        : "El análisis no da un nivel numérico para este hallazgo: se confirmaría solo si el precio mantiene el comportamiento descrito.",
      invalidation: levels
        ? `Deja de valer si el precio cierra ${below} ${levels.invalidate}.`
        : "Deja de valer si el comportamiento descrito desaparece en las siguientes velas.",
      risk_note: `${DEFAULT_RISK_NOTE} El stop va detrás del nivel de invalidación (${levels ? levels.invalidate : "sin nivel definido"}) y el tamaño se calcula desde ese stop, no al revés.`,
    };
  });
  return {
    source: "fallback",
    summary,
    scenarios,
    caution: `${DEFAULT_CAUTION} Sin medición histórica publicada no hay porcentaje de acierto que mostrar. (${reason})`,
  };
}

/** Cuerpo que se manda al hosting: hallazgos ya saneados y topados. */
export function explainRequestBody(result: unknown, symbol: string, timeframe: string): ExplainRequest {
  const record = isRecord(result) ? result : {};
  // `top` es el subconjunto diverso de analysis-core; si un núcleo no lo devuelve, se usa
  // `findings` (que analyze_chart ya ordena por fuerza).
  const top = asArray(record.top ?? record.findings)
    .filter(isRecord)
    .slice(0, EXPLAIN_MAX_FINDINGS)
    .map((finding) => ({
      id: text(finding.id, 64),
      kind: text(finding.kind, 40),
      label: text(finding.label ?? finding.kind, 120),
      direction: direction(finding.direction),
      strength: Math.max(0, Math.min(1, num(finding.strength) ?? 0)),
      status: finding.status === "confirmed" ? "confirmed" : "forming",
      explanation: text(finding.explanation, 400),
      levels: asArray(finding.levels)
        .filter(isRecord)
        .slice(0, 8)
        .map((level) => ({
          role: text(level.role, 40),
          price: num(level.price),
          confirm: num(level.confirm),
          invalidate: num(level.invalidate),
        })),
    }));
  const trend = isRecord(record.trend)
    ? { direction: direction(record.trend.direction), strength: num(record.trend.strength) ?? 0, label: text(record.trend.label, 80) }
    : null;
  const levels = asArray(record.levels).filter(isRecord).slice(0, 200);
  return { symbol, timeframe, analysis: { top, trend, levels } };
}

export interface HostedExplain {
  ok: boolean;
  payload: ExplainPayload | null;
  model: string | null;
  error: string | null;
}

function toPayload(body: unknown): ExplainPayload | null {
  if (!isRecord(body)) return null;
  const summary = text(body.summary, 600);
  const scenarios = asArray(body.scenarios)
    .filter(isRecord)
    .slice(0, EXPLAIN_MAX_SCENARIOS)
    .map((row) => ({
      name: text(row.name, 120),
      condition: text(row.condition, 400),
      invalidation: text(row.invalidation, 400),
      risk_note: text(row.risk_note ?? row.riskNote, 400),
    }))
    .filter((row) => row.name.length > 0);
  const caution = text(body.caution, 300);
  if (!summary && scenarios.length === 0) return null;
  const source = body.source === "fallback" || body.source === "cache" ? body.source : "ai";
  return { source, summary, scenarios, caution };
}

/**
 * POST al endpoint alojado. Sin red, sin URL o con código distinto de 200 devuelve
 * ok:false: el llamador decide si tira de respaldo local.
 */
export async function fetchHostedExplanation(
  base: string,
  body: ExplainRequest,
  fetchFn: FetchLike,
  timeoutMs: number,
): Promise<HostedExplain> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(base, {
      method: "POST",
      redirect: "error",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, payload: null, model: null, error: `hosted explain http ${response.status}` };
    const parsed: unknown = await response.json();
    const payload = toPayload(parsed);
    if (!payload) return { ok: false, payload: null, model: null, error: "hosted explain payload invalido" };
    const model = isRecord(parsed) && typeof parsed.model === "string" ? parsed.model : null;
    return { ok: true, payload, model, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 180) : "red";
    return { ok: false, payload: null, model: null, error: `hosted explain ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Resultado que devuelve la tool, listo para serializar. */
export function explainToolResult(input: {
  symbol: string;
  timeframe: string;
  payload: ExplainPayload;
  model: string | null;
  hosted: boolean;
  note: string | null;
}): Record<string, unknown> {
  return {
    symbol: input.symbol,
    timeframe: input.timeframe,
    source: input.payload.source,
    model: input.model,
    hosted: input.hosted,
    summary: input.payload.summary,
    scenarios: input.payload.scenarios,
    caution: input.payload.caution,
    disclaimer: EXPLAIN_DISCLAIMER,
    // null cuando la explicación viene del hosting: no hay nada que advertir.
    note: input.note,
    asOf: new Date().toISOString(),
    readOnly: true,
  };
}
