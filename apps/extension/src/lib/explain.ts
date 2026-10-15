/**
 * Explicador del panel lateral: POST /api/explain.
 *
 * Envía SOLO el análisis determinista (símbolo, temporalidad, patrones
 * detectados, tendencia y niveles). Nunca datos de cuenta: la extensión no los
 * lee. La respuesta se valida y se sanea campo a campo; si el servicio falla,
 * contesta 429, devuelve JSON inválido o rompe el contrato, se pinta una
 * explicación local construida con los hallazgos (reglas fijas), con un motivo
 * corto. Esta función nunca lanza hacia el panel.
 *
 * Nunca se muestra una probabilidad de acierto: la "fuerza" es la calidad
 * geométrica del patrón, no una tasa medida, y el aviso educativo viaja siempre.
 */

import { normalizeStrength, rankFindings, resolveLevels } from './findings-view';
import type { AnalysisResult, Finding } from './types';

export const EXPLAIN_ENDPOINT = 'https://trade.swal.network/api/explain';
/** Tope de espera de una petición: por encima, respaldo local. */
export const EXPLAIN_TIMEOUT_MS = 15_000;
/** La caché en memoria dura 5 minutos, igual que la del endpoint. */
export const EXPLAIN_CACHE_MS = 5 * 60 * 1000;
/** El worker acepta 20; la tarjeta manda como máximo 5. */
export const EXPLAIN_MAX_FINDINGS = 5;
export const EXPLAIN_MAX_SCENARIOS = 5;
export const EXPLAIN_MAX_LEVELS = 200;
/** Línea que se enseña siempre, también antes de pedir nada. */
export const EXPLAIN_DISCLAIMER = 'Explicación educativa. No es una recomendación de compra o venta.';
/** Aviso de privacidad del interruptor. */
export const EXPLAIN_OPT_IN_NOTE =
  'Envía el símbolo, la temporalidad y los patrones detectados a trade.swal.network; nunca datos de tu cuenta.';

const DEFAULT_RISK_NOTE =
  'Define el stop antes de entrar y usa un tamaño que aguante el fallo; apalancamiento 1x como punto de partida.';

export interface ExplainFinding {
  id: string;
  kind: string;
  label: string;
  direction: 'up' | 'down' | 'neutral';
  strength: number;
  status: 'confirmed' | 'forming';
  explanation: string;
  levels: Array<{ role: string; price: number; confirm: number | null; invalidate: number | null }>;
}

export interface ExplainTrend {
  direction: 'up' | 'down' | 'neutral';
  strength: number;
  label: string;
}

export interface ExplainRequest {
  symbol: string;
  timeframe: string;
  analysis: {
    top: ExplainFinding[];
    trend: ExplainTrend | null;
    levels: Array<{ price: number }>;
  };
}

export interface ExplainScenario {
  name: string;
  condition: string;
  invalidation: string;
  riskNote: string;
}

export interface ExplainView {
  source: 'ai' | 'fallback' | 'cache';
  summary: string;
  scenarios: ExplainScenario[];
  caution: string;
  /** Motivo corto cuando la explicación la construyeron reglas fijas; '' si vino del modelo. */
  reason: string;
  /** true si la construyó el cliente (opt-in apagado, red, límite o contrato roto). */
  local: boolean;
  /** true si salió de la caché en memoria (5 min). */
  fromCache: boolean;
}

export interface ExplainInput {
  symbol: string;
  timeframe: string;
  result: AnalysisResult;
  /** El interruptor de ajustes. Apagado: ni red ni caché, respaldo local. */
  enabled: boolean;
}

export interface ExplainDeps {
  fetchImpl?: typeof fetch;
  nowMs?: number;
  timeoutMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const num = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Texto de la respuesta del servicio. Se quitan los ángulos para que nada
 * pueda interpretarse como marcado y los caracteres de control para que no
 * rompan la línea. Se corta al tope del contrato.
 */
export function safeText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function direction(value: unknown): 'up' | 'down' | 'neutral' {
  return value === 'up' || value === 'down' ? value : 'neutral';
}

/** La tendencia llega al panel como texto; se deduce la dirección de la palabra. */
function trendDirection(label: string): 'up' | 'down' | 'neutral' {
  const folded = label.toLowerCase();
  if (/bajist|bear|baja\b/.test(folded)) return 'down';
  if (/alcist|bull|sube\b/.test(folded)) return 'up';
  return 'neutral';
}

function requestFinding(finding: Finding): ExplainFinding {
  return {
    id: safeText(finding.id, 64),
    kind: safeText(finding.kind, 40),
    label: safeText(finding.label || finding.kind, 120),
    direction: direction(finding.direction),
    strength: normalizeStrength(finding.strength),
    status: finding.status === 'confirmed' ? 'confirmed' : 'forming',
    explanation: safeText(finding.explanation, 400),
    levels: resolveLevels(finding.levels)
      .slice(0, 8)
      .map((level) => ({
        role: safeText(level.role, 40),
        price: level.price,
        confirm: level.confirm,
        invalidate: level.invalidate,
      })),
  };
}

/**
 * Cuerpo que sale del navegador: solo el análisis determinista, ya saneado y
 * topado. Nada de velas, cuenta, claves ni identificadores.
 */
export function explainRequestFrom(input: {
  symbol: string;
  timeframe: string;
  result: AnalysisResult;
}): ExplainRequest {
  const ranked = rankFindings(
    input.result.top.length > 0 ? input.result.top : input.result.findings,
    EXPLAIN_MAX_FINDINGS,
  );
  const trendLabel = safeText(input.result.trend, 80);
  const levels: Array<{ price: number }> = [];
  for (const level of Array.isArray(input.result.levels) ? input.result.levels : []) {
    const price = typeof level === 'number' && Number.isFinite(level) ? level : null;
    if (price === null) continue;
    levels.push({ price });
    if (levels.length >= EXPLAIN_MAX_LEVELS) break;
  }
  return {
    symbol: safeText(input.symbol, 30).toUpperCase(),
    timeframe: safeText(input.timeframe, 8),
    analysis: {
      top: ranked.map(requestFinding),
      trend: trendLabel
        ? { direction: trendDirection(trendLabel), strength: 0, label: trendLabel }
        : null,
      levels,
    },
  };
}

/** Clave determinista: símbolo, temporalidad y hash de los hallazgos. */
export function explainCacheKey(request: ExplainRequest): string {
  const basis = JSON.stringify({
    symbol: request.symbol,
    timeframe: request.timeframe,
    analysis: request.analysis,
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < basis.length; index += 1) {
    hash ^= basis.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${request.symbol}@${request.timeframe}:${(hash >>> 0).toString(16)}`;
}

/** Motivo corto que se enseña bajo la explicación. */
export function explainReasonText(code: string): string {
  if (!code) return '';
  if (code === 'opt_in') return 'explicaciones con IA desactivadas';
  if (code === 'offline') return 'sin conexión';
  if (code === 'timeout') return 'tiempo de espera agotado';
  if (code === 'rate_limited') return 'límite por hora alcanzado';
  if (code === 'daily_cap') return 'cupo diario del modelo agotado';
  if (code === 'invalid_json' || code === 'invalid_payload') return 'respuesta no válida del servicio';
  if (code.startsWith('http_')) return 'el servicio no respondió bien';
  return 'sin modelo disponible ahora: explicación con reglas fijas';
}

const pct = (strength: number): number => Math.round(strength * 100);
const dirWord = (value: 'up' | 'down' | 'neutral'): string =>
  value === 'up' ? 'alcista' : value === 'down' ? 'bajista' : 'neutral';

function decisionLevels(finding: ExplainFinding): { confirm: number; invalidate: number } | null {
  for (const level of finding.levels) {
    if (typeof level.confirm === 'number' && typeof level.invalidate === 'number') {
      return { confirm: level.confirm, invalidate: level.invalidate };
    }
  }
  return null;
}

/** true si los hallazgos principales señalan en direcciones opuestas. */
export function directionsConflict(top: readonly ExplainFinding[]): boolean {
  const ups = top.filter((finding) => finding.direction === 'up').length;
  const downs = top.filter((finding) => finding.direction === 'down').length;
  return ups > 0 && downs > 0;
}

/**
 * Explicación con reglas fijas, sin red. Espejo del respaldo del endpoint: describe
 * los hallazgos y sus niveles, sin interpretación añadida.
 */
export function localFallbackExplain(request: ExplainRequest, reasonCode: string): ExplainView {
  const symbol = request.symbol || 'el activo';
  const timeframe = request.timeframe || '—';
  const top = request.analysis.top.slice(0, EXPLAIN_MAX_SCENARIOS);
  let summary: string;
  if (top.length === 0) {
    summary =
      `En ${symbol} (${timeframe}) el análisis no ve patrones claros en esta ventana. ` +
      'Sin patrón no hay escenario que explicar: lo coherente es esperar a que el gráfico muestre niveles definidos.';
  } else {
    const first = top[0]!;
    summary =
      `En ${symbol} (${timeframe}) el análisis determinista ve ${top.length} patrón(es). ` +
      `El de mayor fuerza del patrón es ${first.label || first.kind || 'un patrón'} ` +
      `(fuerza ${pct(first.strength)}/100, dirección ${dirWord(first.direction)}). ` +
      (directionsConflict(top)
        ? 'Los patrones no señalan todos en la misma dirección: cuando se contradicen, lo prudente es esperar y no forzar una lectura. '
        : '');
  }
  const scenarios: ExplainScenario[] = top.map((finding) => {
    const levels = decisionLevels(finding);
    const above = finding.direction === 'down' ? 'por debajo de' : 'por encima de';
    const below = finding.direction === 'down' ? 'por encima de' : 'por debajo de';
    return {
      name: finding.label || finding.kind || 'Patrón',
      condition: levels
        ? `Se confirma si el precio cierra ${above} ${levels.confirm} y se mantiene ahí.`
        : 'El análisis no da un nivel numérico para este hallazgo: se confirmaría solo si el precio mantiene el comportamiento descrito.',
      invalidation: levels
        ? `Deja de valer si el precio cierra ${below} ${levels.invalidate}.`
        : 'Deja de valer si el comportamiento descrito desaparece en las siguientes velas.',
      riskNote:
        `${DEFAULT_RISK_NOTE} El stop va detrás del nivel de invalidación ` +
        `(${levels ? levels.invalidate : 'sin nivel definido'}) y el tamaño se calcula desde ese stop, no al revés.`,
    };
  });
  return {
    source: 'fallback',
    summary,
    scenarios,
    caution:
      'La fuerza del patrón mide la calidad del dibujo, no una tasa de acierto. ' +
      'La tasa de acierto histórica no está medida: no hay porcentaje que mostrar. ' +
      'Opera con stop y un tamaño pequeño, o no operes.',
    reason: explainReasonText(reasonCode),
    local: true,
    fromCache: false,
  };
}

/**
 * Valida y sanea la respuesta del endpoint. Cualquier campo que no encaje se
 * descarta; si no queda contenido, la respuesta no vale y se tira del respaldo local.
 */
export function parseExplainResponse(
  body: unknown,
): { ok: true; view: ExplainView } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: 'invalid_payload' };
  const rawSource = body.source;
  if (rawSource !== undefined && rawSource !== 'ai' && rawSource !== 'fallback' && rawSource !== 'cache') {
    return { ok: false, error: 'invalid_payload' };
  }
  const source: ExplainView['source'] =
    rawSource === 'fallback' || rawSource === 'cache' ? rawSource : 'ai';

  const summary = safeText(body.summary, 600);
  const scenarios: ExplainScenario[] = [];
  const rows = Array.isArray(body.scenarios) ? body.scenarios : [];
  for (const row of rows.slice(0, EXPLAIN_MAX_SCENARIOS)) {
    if (!isRecord(row)) continue;
    const name = safeText(row.name, 120);
    if (!name) continue;
    scenarios.push({
      name,
      condition:
        safeText(row.condition, 400) || 'El análisis no fija una condición concreta para este patrón.',
      invalidation:
        safeText(row.invalidation, 400) ||
        'Sin nivel de invalidación definido: se descarta si el patrón deja de verse en el gráfico.',
      riskNote: safeText(row.risk_note ?? row.riskNote, 400) || DEFAULT_RISK_NOTE,
    });
  }
  if (!summary && scenarios.length === 0) return { ok: false, error: 'invalid_payload' };
  const caution = safeText(body.caution, 300);
  const reasonCode = safeText(body.reason, 40);
  return {
    ok: true,
    view: {
      source,
      summary,
      scenarios,
      caution,
      reason: source === 'fallback' ? explainReasonText(reasonCode) : '',
      local: false,
      fromCache: false,
    },
  };
}

interface CachedView {
  at: number;
  view: ExplainView;
}

const cache = new Map<string, CachedView>();
let inFlight: { key: string; promise: Promise<ExplainView> } | null = null;

/** Solo para pruebas: vacía la caché y la petición en vuelo. */
export function resetExplainCache(): void {
  cache.clear();
  inFlight = null;
}

async function runExplain(
  request: ExplainRequest,
  deps: ExplainDeps,
): Promise<{ view: ExplainView; cacheable: boolean }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = Math.max(1, deps.timeoutMs ?? EXPLAIN_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(EXPLAIN_ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!response.ok) {
      const code = response.status === 429 ? 'rate_limited' : `http_${response.status}`;
      return { view: localFallbackExplain(request, code), cacheable: false };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { view: localFallbackExplain(request, 'invalid_json'), cacheable: false };
    }
    const parsed = parseExplainResponse(body);
    if (!parsed.ok) return { view: localFallbackExplain(request, parsed.error), cacheable: false };
    return { view: parsed.view, cacheable: true };
  } catch {
    return {
      view: localFallbackExplain(request, controller.signal.aborted ? 'timeout' : 'offline'),
      cacheable: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Explicación de los patrones actuales. Nunca lanza: ante cualquier fallo
 * devuelve la explicación local. Con `enabled: false` (interruptor apagado) no
 * se toca la red.
 */
export async function explainPatterns(input: ExplainInput, deps: ExplainDeps = {}): Promise<ExplainView> {
  const nowMs = deps.nowMs ?? Date.now();
  const request = explainRequestFrom(input);
  if (!input.enabled) return localFallbackExplain(request, 'opt_in');

  const key = explainCacheKey(request);
  const hit = cache.get(key);
  if (hit && nowMs - hit.at < EXPLAIN_CACHE_MS) return { ...hit.view, fromCache: true };

  if (inFlight) {
    // Una sola petición en vuelo a la vez. La misma clave se reutiliza; otra espera.
    if (inFlight.key === key) return inFlight.promise;
    try {
      await inFlight.promise;
    } catch {
      /* la petición anterior nunca rechaza; si lo hiciera, se sigue igual */
    }
  }

  const promise = (async (): Promise<ExplainView> => {
    const outcome = await runExplain(request, deps);
    if (outcome.cacheable) cache.set(key, { at: nowMs, view: outcome.view });
    return outcome.view;
  })();
  inFlight = { key, promise };
  const clear = () => {
    if (inFlight && inFlight.key === key && inFlight.promise === promise) inFlight = null;
  };
  void promise.then(clear, clear);
  return promise;
}
