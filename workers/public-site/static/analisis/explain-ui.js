// explain-ui.js — helpers puros del botón "Explicar con IA" de /analisis/.
// SIN DOM: se importa desde analisis.js y desde los tests (node --test). El pintado
// vive en analisis.js, que es el único que toca document.

/** Mismo origen: la CSP de /analisis/ ya permite connect-src 'self'. */
export const EXPLAIN_ENDPOINT = '/api/explain';
/** El worker rechaza más de 20 hallazgos; la UI nunca manda más de 5. */
export const EXPLAIN_MAX_FINDINGS = 5;

/** Texto del pie del resultado. El mismo descargo en el prompt y en el worker. */
export const EXPLAIN_DISCLAIMER =
  'Información educativa generada a partir de patrones deterministas. No es asesoría financiera ni una recomendación de inversión.';

/**
 * Cuerpo de la petición: lo que produjo analysis-core, nada de velas.
 * @param {{symbol: string, timeframe: string, result: object|null}} state
 */
export function explainRequestFrom({ symbol, timeframe, result } = {}) {
  const top = (result && Array.isArray(result.top) ? result.top : []).slice(0, EXPLAIN_MAX_FINDINGS);
  const trend = (result && result.trend && typeof result.trend === 'object') ? result.trend : null;
  const levels = (result && Array.isArray(result.levels) ? result.levels : []).slice(0, 200);
  const analysis = {
    top,
    trend: trend ? { direction: trend.direction, strength: trend.strength, label: trend.label } : null,
    levels,
  };
  return { symbol, timeframe, analysis };
}

const text = (value, max = 400) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/**
 * Convierte la respuesta del endpoint en una estructura lista para pintar.
 * No filtra por lista negra (eso lo hace el servidor): aquí solo se normaliza.
 * @param {unknown} body
 * @returns {{ok: true, view: object}|{ok: false, error: string}}
 */
export function explainView(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Respuesta vacía del explicador.' };
  const summary = text(body.summary, 600);
  const rawScenarios = Array.isArray(body.scenarios) ? body.scenarios : [];
  if (!summary && !rawScenarios.length) return { ok: false, error: 'Respuesta sin contenido.' };
  const scenarios = rawScenarios.slice(0, 5).map((scenario) => ({
    name: text(scenario && scenario.name, 120),
    condition: text(scenario && scenario.condition, 400),
    invalidation: text(scenario && scenario.invalidation, 400),
    riskNote: text(scenario && (scenario.risk_note ?? scenario.riskNote), 400),
  })).filter((scenario) => scenario.name);
  return {
    ok: true,
    view: {
      summary,
      scenarios,
      caution: text(body.caution, 300),
      source: text(body.source, 20) || 'ai',
      reason: text(body.reason, 40),
      repaired: body.repaired === true,
      newsUsed: Number.isFinite(Number(body.newsUsed)) ? Number(body.newsUsed) : 0,
      note: text(body.note, 300),
      disclaimer: text(body.disclaimer, 300) || EXPLAIN_DISCLAIMER,
    },
  };
}

/**
 * Etiqueta de procedencia, en una línea corta.
 * @param {string} source 'ai' | 'fallback' | 'cache'
 * @param {string} reason
 */
export function explainSourceLabel(source, reason = '') {
  if (source === 'cache') return 'Respuesta guardada de hace menos de 5 minutos.';
  if (source === 'fallback') {
    if (reason === 'daily_cap') return 'Cupo diario del modelo agotado: explicación con reglas fijas.';
    if (reason === 'rate_limited') return 'Límite de peticiones alcanzado.';
    return 'Sin modelo disponible ahora: explicación con reglas fijas.';
  }
  return 'Explicación escrita por un modelo de lenguaje a partir del análisis determinista.';
}

/**
 * Mensaje de error para la UI. El 429 trae segundos de espera.
 * @param {number} status
 * @param {unknown} body
 */
export function explainErrorText(status, body) {
  const error = body && typeof body === 'object' ? text(body.error, 40) : '';
  if (status === 429) {
    const seconds = body && Number.isFinite(Number(body.retryAfterS)) ? Number(body.retryAfterS) : 0;
    return seconds
      ? `Has alcanzado el límite de 10 explicaciones por hora. Vuelve a intentarlo en ${Math.ceil(seconds / 60)} min.`
      : 'Has alcanzado el límite de 10 explicaciones por hora.';
  }
  if (status === 400) return 'El análisis no se pudo enviar. Prueba a recargar el gráfico.';
  if (status === 413) return 'El análisis es demasiado grande para enviarlo.';
  if (status === 405) return 'Método no permitido.';
  return `No se pudo explicar (${status || error || 'error de red'}).`;
}

/** @param {boolean} busy */
export function explainButtonLabel(busy) {
  return busy ? 'Explicando…' : 'Explicar con IA';
}
