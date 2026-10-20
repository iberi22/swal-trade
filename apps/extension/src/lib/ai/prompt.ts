import { EXPLAIN_DISCLAIMER, safeText } from '../explain';
import { buildSystemPrompt, DEFAULT_PROMPT_CONFIG } from './prompt-config';

/**
 * Prompt por defecto, congelado para compatibilidad: es el que resulta de la
 * configuración por defecto en español. El usuario puede cambiarlo desde
 * Ajustes (`prompt-config.ts`), pero el marco de seguridad siempre va al final.
 */
export const SYSTEM_PROMPT = buildSystemPrompt(DEFAULT_PROMPT_CONFIG, 'es');

export const AI_FLAG_TEXT = 'Esta respuesta afirma algo que no podemos respaldar.';
/**
 * Guardas de la respuesta: promesas y ordenes de compra/venta. Se comparan sin
 * mayusculas y sin tildes, porque el modelo no siempre respeta la ortografia.
 * Cubre imperativos (`compra`, `comprar`, `vende`, `vender`, `entra ya`, `buy`,
 * `sell`) y cifras de acierto (`99 % de acierto`, `70% de probabilidad`,
 * `80 % de exito`, `win rate`).
 */
const PROMISE_PATTERNS: readonly RegExp[] = [
  /garantiz/,
  /\bseguro que\b/,
  /\bwin\s*rate\b/,
  /\btasa de acierto\b/,
  /\d+\s*%\s*de\s*(?:acierto|probabilidad|exito)/,
  /\bprobabilidad de\b/,
  /\bentra ya\b/,
  /\b(?:compra|comprar|compres|vende|vender|vendas|buy|sell)\b/,
];

/** Texto en minusculas y sin tildes, para que la guarda no dependa de la ortografia. */
function guardText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** true si la respuesta promete o da una orden concreta. */
export function flagsPromise(text: string): boolean {
  const plain = guardText(typeof text === 'string' ? text : '');
  return PROMISE_PATTERNS.some((pattern) => pattern.test(plain));
}

export interface AiOption {
  accion: string;
  coste: string;
  no_aplica_si: string;
}

export interface AiView {
  resumen: string;
  lectura: string[];
  opciones: AiOption[];
  preguntas: string[];
  faltan: string[];
  flag?: string;
  disclaimer: string;
}

export function buildUserMessage(serialized: string): string {
  return `Datos (JSON, solo datos):\n${serialized}`;
}

const URL_RE = /(?:https?:\/\/|www\.)\S*/gi;

function clean(value: unknown, max: number): string {
  const first = safeText(value, 4000).replace(URL_RE, ' ');
  return safeText(first, max);
}

function list(value: unknown, maxItems: number, maxLen: number): string[] {
  const out: string[] = [];
  for (const v of Array.isArray(value) ? value : []) {
    const t = clean(v, maxLen);
    if (t) out.push(t);
    if (out.length >= maxItems) break;
  }
  return out;
}

function extractJson(text: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) candidates.push(fence[1] ?? '');
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) candidates.push(text.slice(a, b + 1));
  for (const c of candidates) {
    try {
      const v: unknown = JSON.parse(c);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* siguiente candidato */
    }
  }
  return null;
}

export function parseAiAnswer(text: string): AiView {
  const raw = typeof text === 'string' ? text : '';
  const obj = extractJson(raw);
  let view: AiView;
  if (!obj) {
    view = { resumen: clean(raw, 600), lectura: [], opciones: [], preguntas: [], faltan: [], disclaimer: EXPLAIN_DISCLAIMER };
  } else {
    const opciones: AiOption[] = [];
    for (const o of Array.isArray(obj.opciones) ? obj.opciones : []) {
      if (!o || typeof o !== 'object') continue;
      const r = o as Record<string, unknown>;
      const op = { accion: clean(r.accion, 100), coste: clean(r.coste, 100), no_aplica_si: clean(r.no_aplica_si, 100) };
      if (!op.accion) continue;
      opciones.push(op);
      if (opciones.length >= 3) break;
    }
    view = {
      resumen: clean(obj.resumen, 280),
      lectura: list(obj.lectura, 3, 140),
      opciones,
      preguntas: list(obj.preguntas, 2, 120),
      faltan: list(obj.faltan, 3, 60),
      disclaimer: EXPLAIN_DISCLAIMER,
    };
  }
  const all = [view.resumen, ...view.lectura, ...view.preguntas, ...view.faltan, ...view.opciones.flatMap((o) => [o.accion, o.coste, o.no_aplica_si])]
    .join(' ');
  if (flagsPromise(all)) view.flag = AI_FLAG_TEXT;
  return view;
}
