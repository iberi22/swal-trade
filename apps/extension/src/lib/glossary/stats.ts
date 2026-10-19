/**
 * Frecuencias medidas del glosario. El archivo `stats.json` lo produce otro
 * proceso (estudio de 90 días sobre 5 pares); aquí solo se lee, se valida y se
 * formatea. Regla dura: la interfaz NUNCA calcula ni inventa una cifra. Si la
 * entrada no tiene medida, se dice «sin datos suficientes».
 *
 * Esquema (`swal.glossary-stats.v1`):
 * ```json
 * {
 *   "schema": "swal.glossary-stats.v1",
 *   "window_days": 90,
 *   "pairs": ["BTCUSDT", "ETHUSDT"],
 *   "stats": [
 *     {
 *       "type": "level",
 *       "id": "prevDayHigh",
 *       "direction": "long",
 *       "rate": 58.1,        // % de casos que reaccionaron (0-100)
 *       "ci_low": 55.2,      // intervalo de confianza, en %
 *       "ci_high": 61.0,
 *       "baseline": 50,      // % que daría el azar
 *       "lift_pp": 8.1,      // diferencia en puntos porcentuales
 *       "n": 1234,
 *       "grade": "promising" // promising | no_evidence | negative | none
 *     }
 *   ]
 * }
 * ```
 * Todos los porcentajes van ya en tanto por ciento para que la interfaz solo
 * tenga que redondear y añadir «%» o «pp»: nada de aritmética de negocio.
 */
import { glossaryText } from './text';
import type { GlossaryEntry } from './entries';

export const STATS_SCHEMA = 'swal.glossary-stats.v1';

export type StatGrade = 'promising' | 'no_evidence' | 'negative' | 'none';

export interface GlossaryStat {
  type: 'level' | 'pattern';
  id: string;
  direction?: 'long' | 'short';
  /** Porcentajes en tanto por ciento (0-100). `null` en el grado `none`. */
  rate: number | null;
  ci_low: number | null;
  ci_high: number | null;
  baseline: number | null;
  lift_pp: number | null;
  n: number;
  grade: StatGrade;
}

export interface GlossaryStatsFile {
  schema: typeof STATS_SCHEMA;
  window_days?: number;
  pairs?: readonly string[];
  stats: readonly GlossaryStat[];
}

export const EMPTY_STATS: GlossaryStatsFile = { schema: STATS_SCHEMA, stats: [] };

const GRADES: readonly StatGrade[] = ['promising', 'no_evidence', 'negative', 'none'];

const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isPct = (value: unknown): value is number => isNum(value) && value >= 0 && value <= 100;

function parseStat(raw: unknown): GlossaryStat | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const type = rec.type;
  if (type !== 'level' && type !== 'pattern') return null;
  if (typeof rec.id !== 'string' || !rec.id) return null;
  const grade = rec.grade as StatGrade;
  if (!GRADES.includes(grade)) return null;
  if (!isNum(rec.n) || rec.n < 0 || !Number.isInteger(rec.n)) return null;
  const direction =
    rec.direction === 'long' || rec.direction === 'short' ? rec.direction : undefined;
  if (grade === 'none') {
    return { type, id: rec.id, direction, rate: null, ci_low: null, ci_high: null, baseline: null, lift_pp: null, n: rec.n, grade };
  }
  if (!isPct(rec.rate) || !isPct(rec.ci_low) || !isPct(rec.ci_high)) return null;
  if (!isPct(rec.baseline) || !isNum(rec.lift_pp)) return null;
  if (rec.ci_low > rec.ci_high) return null;
  if (rec.rate < rec.ci_low || rec.rate > rec.ci_high) return null;
  return {
    type,
    id: rec.id,
    direction,
    rate: rec.rate,
    ci_low: rec.ci_low,
    ci_high: rec.ci_high,
    baseline: rec.baseline,
    lift_pp: rec.lift_pp,
    n: rec.n,
    grade,
  };
}

/**
 * Valida el archivo completo. Devuelve `null` si no es del esquema esperado;
 * descarta las filas mal formadas en lugar de mostrar cifras dudosas.
 */
export function parseStatsFile(raw: unknown): GlossaryStatsFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  if (rec.schema !== STATS_SCHEMA) return null;
  const rows = Array.isArray(rec.stats) ? rec.stats : [];
  const stats: GlossaryStat[] = [];
  for (const row of rows) {
    const parsed = parseStat(row);
    if (parsed) stats.push(parsed);
  }
  const windowDays = isNum(rec.window_days) ? rec.window_days : undefined;
  const pairs = Array.isArray(rec.pairs)
    ? rec.pairs.filter((pair): pair is string => typeof pair === 'string')
    : undefined;
  return { schema: STATS_SCHEMA, window_days: windowDays, pairs, stats };
}

/**
 * Lee `stats.json` si existe. `import.meta.glob` no falla cuando el archivo no
 * está: el estudio que lo produce puede llegar después y el build sigue igual.
 */
const FILES = import.meta.glob('./stats.json', { eager: true }) as Record<
  string,
  { default?: unknown } | undefined
>;

/** Medidas disponibles en el build. Vacío si `stats.json` no existe o no valida. */
export const GLOSSARY_STATS: GlossaryStatsFile = parseStatsFile(FILES['./stats.json']?.default) ?? EMPTY_STATS;

/**
 * Medida de una entrada del glosario. `side` manda sobre la dirección intrínseca
 * de la entrada (una zona de soporte se puede leer como largos o como cortos).
 */
export function statFor(
  entry: GlossaryEntry | null | undefined,
  side?: 'long' | 'short',
  stats: GlossaryStatsFile = GLOSSARY_STATS,
): GlossaryStat | null {
  const ref = entry?.statRef;
  if (!ref) return null;
  const rows = stats.stats.filter((stat) => stat.type === ref.type && stat.id === ref.id);
  if (rows.length === 0) return null;
  const want = side ?? ref.direction;
  if (want) return rows.find((stat) => stat.direction === want) ?? rows.find((stat) => !stat.direction) ?? null;
  return rows.find((stat) => !stat.direction) ?? rows[0] ?? null;
}

/** Porcentaje con un decimal y coma decimal: 58,1 %. */
export function formatPct(value: number | null): string {
  if (!isNum(value)) return '—';
  return `${value.toFixed(1).replace('.', ',')} %`;
}

/** Puntos porcentuales con signo: +8,1 pp / −2,0 pp. */
export function formatLift(value: number | null): string {
  if (!isNum(value)) return '—';
  const rounded = value.toFixed(1).replace('.', ',');
  const body = rounded === '0,0' ? rounded : rounded.replace('-', '−');
  const sign = value > 0 ? '+' : '';
  return `${sign}${body} pp`;
}

/** Parámetros de plantilla de una medida. Solo formato, nunca cálculo. */
export function statParams(stat: GlossaryStat) {
  return {
    rate: formatPct(stat.rate),
    low: formatPct(stat.ci_low),
    high: formatPct(stat.ci_high),
    baseline: formatPct(stat.baseline),
    lift: formatLift(stat.lift_pp),
    n: String(stat.n),
  };
}

/** Línea medida con la plantilla de su grado (`glossary.stats.<grado>`). */
export function statLine(stat: GlossaryStat): string {
  return glossaryText(`glossary.stats.${stat.grade}`, statParams(stat));
}

/** Texto cuando no hay medida: «sin datos suficientes». */
export function noStatLine(): string {
  return glossaryText('glossary.ui.insufficient');
}
