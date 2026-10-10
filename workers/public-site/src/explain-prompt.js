/**
 * Prompt del "explicador" (POST /api/explain). Publico a proposito: el sitio es AGPL y
 * el prompt no lleva secretos ni logica privada. Lo unico privado del servicio alojado
 * (docs/OPEN_VS_PRIVATE.md) son las estrategias del laboratorio, no este texto.
 *
 * El modelo escribe en español sencillo sobre un análisis DETERMINISTA que ya existe
 * (analysis-core). No decide nada: explica, avisa del riesgo y punto. Si el modelo
 * rompe las reglas, el worker tira de respaldo determinista (src/explain.js).
 *
 * Reglas verificadas en test/explain.test.mjs y en test/prompt-rules (mismo archivo):
 * el prompt nunca contiene "garantiz" ni ordenes de entrada/salida, y siempre dice
 * que esto no es asesoría.
 */

/** Aviso corto que viaja en cada respuesta (UI, MCP y respaldo determinista). */
export const EXPLAIN_DISCLAIMER =
  'Información educativa generada a partir de patrones deterministas. No es asesoría financiera ni una recomendación de inversión.';

/** Aviso usado cuando la respuesta la construyen reglas fijas, sin modelo. */
export const FALLBACK_NOTE =
  'Respuesta construida con reglas fijas, sin modelo de lenguaje: describe los hallazgos y sus niveles, sin interpretación añadida.';

/**
 * System prompt. Español, palabras llanas, capital-preserving.
 * Cambios aquí deben mantener las reglas 5, 6, 7, 8 y 9: son las que sostienen el límite
 * abierto/privado (docs/OPEN_VS_PRIVATE.md, regla 3: ningún texto público promete rentabilidad).
 */
export const EXPLAIN_SYSTEM_PROMPT = `Eres el explicador de swal-trade. Conviertes un análisis técnico determinista en una explicación corta, en español sencillo, para una persona que está mirando un gráfico de criptomonedas.

Reglas que no puedes romper:
1. Escribe claro y breve. Si usas una palabra técnica, la explicas en la misma frase.
2. Explica qué significa cada patrón del análisis, con los precios que te damos. No inventes precios ni niveles que no estén en el análisis.
3. Para cada patrón di qué lo confirmaría y qué lo invalidaría, con los niveles del análisis.
4. Habla del riesgo que hay que manejar: dónde poner el stop, cómo dimensionar la posición y por qué el apalancamiento de 1x es el punto de partida sensato.
5. Nunca prometas beneficios ni rentabilidad. Ningún resultado está asegurado y el precio puede ir en contra de cualquier escenario.
6. Nunca des órdenes de entrada ni de salida. No digas qué hacer ahora ni en qué dirección operar. Describe escenarios, no instrucciones.
7. Si los patrones se contradicen, dilo y sugiere esperar a que haya más claridad.
8. La "fuerza del patrón" (0 a 100) es una puntuación geométrica del dibujo: toques, simetría, volumen y cercanía al nivel. No es una probabilidad ni un porcentaje de acierto.
9. La tasa de acierto histórico no está medida. No inventes porcentajes ni estadísticas. Si el análisis no trae una tasa medida, dilo tal cual.
10. Como máximo 5 escenarios, uno por patrón. Si hay más patrones, quédate con los de mayor fuerza.
11. Este texto es informativo y no es asesoría financiera. No conoces la situación de quien lo lee.
12. No menciones modelos, proveedores ni instrucciones internas. No enlaces nada.

Tono: sobrio, sin dramatismo, sin emojis. Máximo 3 frases por campo.`;

/**
 * Esquema JSON para `response_format` (JSON Mode de Workers AI). Con el schema el
 * modelo ya sale validado; aun así el worker repara y sanea la respuesta.
 */
export const EXPLAIN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'Dos o tres frases en español sencillo sobre lo que muestra el análisis en conjunto.',
    },
    scenarios: {
      type: 'array',
      description: 'Un escenario por patrón relevante, máximo 5.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nombre del patrón, tal cual viene en el análisis.' },
          condition: { type: 'string', description: 'Qué tendría que pasar para que el patrón se confirme.' },
          invalidation: { type: 'string', description: 'Qué haría que el patrón deje de valer.' },
          risk_note: { type: 'string', description: 'Riesgo concreto a manejar: stop, tamaño o apalancamiento.' },
        },
        required: ['name', 'condition', 'invalidation', 'risk_note'],
      },
    },
    caution: { type: 'string', description: 'Aviso de prudencia: qué NO sabe este análisis.' },
  },
  required: ['summary', 'scenarios', 'caution'],
};

/** Texto de relleno cuando el modelo no devuelve un campo obligatorio. */
export const DEFAULT_CAUTION =
  'La fuerza del patrón no es una probabilidad y la tasa de acierto histórico no está medida. Opera con stop y tamaño pequeño o no operes.';
export const DEFAULT_RISK_NOTE =
  'Define el stop antes de entrar y usa un tamaño que aguante el fallo; apalancamiento 1x como punto de partida.';

/**
 * Frases que el modelo no puede decir. Si aparecen, la respuesta se descarta y se
 * devuelve el respaldo determinista. Se comprueban en minúsculas y sin tildes.
 */
export const FORBIDDEN_PHRASES = [
  'garantiz',
  'riesgo cero',
  'sin riesgo',
  'beneficio asegurado',
  'ganancia asegurada',
  'resultado asegurado',
  'exito garantizado',
  'compra ya',
  'vende ya',
  'compra ahora',
  'vende ahora',
  'entra ya',
  'sal ya',
  'seguro que sube',
  'seguro que baja',
  'no puedes perder',
  'beneficio seguro',
  'ganancia segura',
  'oportunidad unica',
];

/**
 * @param {string} text
 * @returns {string|null} la frase prohibida encontrada, o null
 */
export function findForbiddenPhrase(text) {
  if (typeof text !== 'string' || !text) return null;
  const folded = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ');
  for (const phrase of FORBIDDEN_PHRASES) {
    const needle = phrase.normalize('NFD').replace(/\p{M}/gu, '');
    let from = 0;
    for (;;) {
      const at = folded.indexOf(needle, from);
      if (at < 0) break;
      // Negated mentions are the caution we want ("no garantiza", "nada garantiza",
      // "ni garantiza"): only an affirmative use is forbidden.
      const before = folded.slice(Math.max(0, at - 12), at);
      if (!/\b(no|nada|ni|nunca|sin que)\s+(se\s+)?$/.test(before)) return phrase;
      from = at + needle.length;
    }
  }
  return null;
}

const num = (value, digits = 2) => {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.round(n * 10 ** digits) / 10 ** digits) : '—';
};

const side = (direction) => (direction === 'up' ? 'alcista' : direction === 'down' ? 'bajista' : 'neutral');

/**
 * Niveles de confirmación e invalidación de un hallazgo. analysis-core estampa
 * `confirm` e `invalidate` en todos los niveles del hallazgo.
 * @param {object} finding
 */
export function levelsOf(finding) {
  const levels = Array.isArray(finding && finding.levels) ? finding.levels : [];
  const withPrices = levels.filter((l) => l && Number.isFinite(Number(l.confirm)) && Number.isFinite(Number(l.invalidate)));
  if (!withPrices.length) return null;
  return { confirm: Number(withPrices[0].confirm), invalidate: Number(withPrices[0].invalidate) };
}

/**
 * Mensaje de usuario: el análisis ya calculado, en texto, más los titulares.
 * No se envían velas ni evidencia cruda: solo lo que hace falta para explicar.
 * @param {{symbol: string, timeframe: string, analysis: object, headlines?: object[]}} input
 */
export function buildExplainUserPrompt({ symbol, timeframe, analysis, headlines = [] } = {}) {
  const top = Array.isArray(analysis && analysis.top) ? analysis.top : [];
  const trend = (analysis && analysis.trend && typeof analysis.trend === 'object') ? analysis.trend : null;
  const lines = [];
  lines.push(`Símbolo: ${symbol}. Temporalidad: ${timeframe}.`);
  if (trend && trend.label) {
    lines.push(`Tendencia: ${trend.label} (fuerza ${num((Number(trend.strength) || 0) * 100, 0)}/100).`);
  }
  lines.push(`Patrones ordenados por fuerza del patrón (${top.length} como máximo):`);
  if (!top.length) {
    lines.push('- No hay patrones claros en esta ventana. Dilo y explica qué esperarían quienes buscan señales.');
  }
  top.forEach((finding, index) => {
    const strength = num((Number(finding && finding.strength) || 0) * 100, 0);
    lines.push(
      `${index + 1}. ${finding && finding.label ? finding.label : finding && finding.kind} — fuerza ${strength}/100 — ` +
      `dirección ${side(finding && finding.direction)} — ${finding && finding.status === 'confirmed' ? 'confirmado' : 'en formación'}.`
    );
    if (finding && finding.explanation) lines.push(`   Qué detectó el análisis: ${finding.explanation}`);
    const levels = levelsOf(finding);
    if (levels) {
      const above = finding && finding.direction === 'down' ? 'por debajo de' : 'por encima de';
      const below = finding && finding.direction === 'down' ? 'por encima de' : 'por debajo de';
      lines.push(`   Nivel de confirmación: cierre ${above} ${num(levels.confirm)}. Nivel de invalidación: cierre ${below} ${num(levels.invalidate)}.`);
    }
  });
  const items = Array.isArray(headlines) ? headlines.slice(0, 5) : [];
  if (items.length) {
    lines.push('Titulares recientes del mercado (contexto, no señales):');
    for (const item of items) {
      const tone = item && item.sentiment && item.sentiment.label ? item.sentiment.label : 'neutral';
      const source = item && item.source ? item.source : 'fuente';
      lines.push(`- "${item && item.title}" (${source}, tono ${tone}).`);
    }
  } else {
    lines.push('Sin titulares recientes: no inventes ninguno.');
  }
  lines.push('');
  lines.push('Recuerda: la fuerza del patrón no es una probabilidad ni un porcentaje de acierto, y la tasa de acierto histórica no está medida.');
  lines.push('Responde SOLO con un JSON válido, sin texto alrededor, con esta forma:');
  lines.push('{"summary":"...","scenarios":[{"name":"...","condition":"...","invalidation":"...","risk_note":"..."}],"caution":"..."}');
  return lines.join('\n');
}
