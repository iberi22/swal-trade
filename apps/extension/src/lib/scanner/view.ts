// Texto y filtros del escaner: funciones puras sobre ScannerEvent, sin Svelte ni red.
// Reglas de honestidad (docs/design/SCANNER.md): sin puntuacion inventada, sin la palabra
// "probabilidad" ni "tasa de acierto", sin semantica de color; las cifras medidas llevan su
// intervalo y su origen (estudio en muestra, nunca mezclado con cifras hacia adelante).
import { collapsedLabel, shortPrice } from '../findings-view';
import { formatPct, formatR, formatWilson, gradeView } from '../radar';
import type { ScannerEvent } from './events';
import type { Plan } from './movers';
import { muted, type CellOverrides, type StatsCell } from './stats';
import { validSymbol } from './universe';

export const ROW_MAX = 90;
export const STUDY_LABEL = 'Estudio en muestra (90 d)';
export const GEOMETRY_TITLE = 'Geometría de medición (no es una señal)';
export const ANALYSIS_NOTE = 'En nuestra medición, los patrones del núcleo no superaron al azar tras costes.';

/** ScannerEvent mas campos que solo conoce el ejecutor (fuerza relativa frente a BTC). */
export interface ScannerRowEvent extends ScannerEvent {
  relBtc?: number | null;
}

type Mode = 'follow' | 'fade';
const MODES: Mode[] = ['follow', 'fade'];

// ---------------------------------------------------------------- formato

const dec = (x: number, digits: number): string => x.toFixed(digits).replace('.', ',');
const pct1 = (x: number): string => dec(x * 100, 1);
const signed = (s: string, x: number): string => (x > 0 ? `+${s}` : s);

/** HH:MM en hora local. */
export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Volumen de 24 h en millones: 412 M, 1,2 mil M. */
export function volumeText(q24: number): string {
  if (q24 >= 1e9) return `${dec(q24 / 1e9, 1)} mil M`;
  if (q24 >= 1e6) return `${Math.round(q24 / 1e6)} M`;
  return `${Math.round(q24 / 1e3)} k`;
}

export function windowMin(signal: string): number | null {
  const m = /^move(\d{1,3})$/.exec(signal);
  return m ? Number(m[1]) : null;
}

const verb = (move: 'up' | 'down'): string => (move === 'up' ? 'sube' : 'baja');
const isMarketRow = (e: ScannerEvent): boolean => e.count !== undefined;

// ---------------------------------------------------------------- celdas y grado

const RANK: Record<string, number> = { validated: 3, promising: 2, no_evidence: 1, negative: 0 };

function knownCells(e: Pick<ScannerEvent, 'cells'>): StatsCell[] {
  return [e.cells.follow, e.cells.fade].filter((c): c is StatsCell => c !== null);
}

/** La celda con mejor grado de las dos (la que resume la fila), o null si no hay ninguna. */
export function bestCell(e: Pick<ScannerEvent, 'cells'>): StatsCell | null {
  let best: StatsCell | null = null;
  for (const c of knownCells(e)) {
    if (best === null || (RANK[c.grade] ?? 0) > (RANK[best.grade] ?? 0)) best = c;
  }
  return best;
}

export function gradeLabelOf(e: Pick<ScannerEvent, 'cells'>): string {
  const c = bestCell(e);
  return c ? gradeView(c.grade, c.n).label : gradeView('no_evidence', 0).label;
}

export function hasEvidence(e: Pick<ScannerEvent, 'cells'>): boolean {
  return knownCells(e).some((c) => c.grade === 'promising' || c.grade === 'validated');
}

/** Una fila se silencia solo si todas sus celdas conocidas estan silenciadas (negativas por defecto). */
export function isMutedEvent(e: Pick<ScannerEvent, 'cells'>, overrides: CellOverrides = {}): boolean {
  const cells = knownCells(e);
  return cells.length > 0 && cells.every((c) => muted(c, overrides));
}

// ---------------------------------------------------------------- fila

function clip(text: string, max = ROW_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Una linea de texto plano, <= 90 caracteres. */
export function rowText(e: ScannerEvent): string {
  const time = hhmm(e.updatedAtMs);
  const w = windowMin(e.signal);
  const win = w === null ? '' : ` ${w}m`;
  if (isMarketRow(e)) {
    const base = `${time} Movimiento de mercado ${verb(e.move)} ≥ ${e.threshold} %${win}`;
    return clip(e.count ? `${base} · ${e.count} pares` : base);
  }
  const head =
    e.ret === null
      ? `${time} ${e.symbol} ${verb(e.move)} ≥ ${e.threshold} %${win}`
      : `${time} ${e.symbol} ${verb(e.move)} ${pct1(Math.abs(e.ret))} %${win}`;
  const vol = e.vol_ratio === null ? null : `vol ${dec(e.vol_ratio, 1)}×`;
  const q = e.q24 === null ? null : volumeText(e.q24);
  const grade = gradeLabelOf(e);
  const build = (parts: Array<string | null>): string => [head, ...parts.filter((p): p is string => p !== null)].join(' · ');
  for (const parts of [[vol, q, grade], [vol, grade], [grade]]) {
    const text = build(parts);
    if (text.length <= ROW_MAX) return text;
  }
  return clip(build([grade]));
}

/** Resumen plegado de la seccion de silenciadas. */
export function mutedLabel(n: number): string {
  return collapsedLabel(`Silenciadas (${Math.max(0, Math.floor(n))})`);
}

// ---------------------------------------------------------------- detalle

export function detailLines(e: ScannerRowEvent): string[] {
  const out: string[] = [];
  if (isMarketRow(e)) {
    out.push(`Pares moviéndose a la vez: ${e.count ?? 0}`);
    out.push('Movimiento de mercado: sí');
    return out;
  }
  const w = windowMin(e.signal);
  if (e.ret !== null) {
    const s = signed(dec(e.ret * 100, 1), e.ret);
    out.push(w === null ? `Movimiento: ${s} %` : `Movimiento en ${w} min: ${s} %`);
  }
  out.push(
    e.prevThreshold !== null && e.prevThreshold < e.threshold
      ? `Umbral ${e.threshold} % (escaló desde ${e.prevThreshold} %)`
      : `Umbral ${e.threshold} %`,
  );
  if (e.vol_ratio !== null) out.push(`Volumen ${dec(e.vol_ratio, 1)}× el de las 24 velas previas`);
  if (e.takerImb !== null) {
    out.push(`Desequilibrio taker (compra − venta): ${signed(dec(e.takerImb * 100, 0), e.takerImb)} %`);
  }
  out.push(`Movimiento de todo el mercado: ${e.marketWide ? 'sí' : 'no'}`);
  if (typeof e.relBtc === 'number' && Number.isFinite(e.relBtc)) {
    out.push(`Fuerza relativa frente a BTC: ${signed(dec(e.relBtc * 100, 1), e.relBtc)} puntos`);
  }
  return out;
}

// ---------------------------------------------------------------- planes

export interface PlanRowView {
  mode: Mode;
  modeLabel: string;
  direction: string;
  hasCell: boolean;
  n: string;
  winRate: string;
  breakeven: string;
  meanR: string;
  grade: string;
  source: string;
  /** Solo con celda promising o validated. */
  levels: string | null;
}

export function planDirection(e: Pick<ScannerEvent, 'move'>, mode: Mode): 'long' | 'short' {
  return (mode === 'follow') === (e.move === 'up') ? 'long' : 'short';
}

const MODE_LABEL: Record<Mode, string> = { follow: 'FOLLOW · seguir', fade: 'FADE · contra' };

function levelsText(p: Plan): string {
  return `Entrada ${shortPrice(p.entry)} · Stop ${shortPrice(p.stop)} · Objetivos ${shortPrice(p.t1)} / ${shortPrice(p.t2)}`;
}

export function planRows(e: ScannerEvent): PlanRowView[] {
  return MODES.map((mode) => {
    const direction = planDirection(e, mode) === 'long' ? 'Largo' : 'Corto';
    const cell = e.cells[mode];
    const plan = e.plans?.[mode] ?? null;
    if (!cell) {
      return {
        mode, modeLabel: MODE_LABEL[mode], direction, hasCell: false, n: '—', winRate: '—', breakeven: '—',
        meanR: '—', grade: gradeView('no_evidence', 0).label, source: STUDY_LABEL, levels: null,
      };
    }
    const ci = formatWilson({ rate: cell.win_rate, low: cell.ci_low, high: cell.ci_high });
    const rCi = `[${dec(cell.net_r_ci_low, 2)} a ${dec(cell.net_r_ci_high, 2)}]`;
    const showLevels = (cell.grade === 'promising' || cell.grade === 'validated') && plan !== null;
    return {
      mode,
      modeLabel: MODE_LABEL[mode],
      direction,
      hasCell: true,
      n: String(cell.n),
      winRate: `${formatPct(cell.win_rate)} ${ci}`.trim(),
      breakeven: formatPct(cell.breakeven),
      meanR: `${formatR(cell.mean_net_r)} ${rCi}`,
      grade: gradeView(cell.grade, cell.n).label,
      source: STUDY_LABEL,
      levels: showLevels && plan ? levelsText(plan) : null,
    };
  });
}

/** Los numeros de los planes cuya celda NO es promising/validated: informacion de medicion, no una senal. */
export function geometry(e: ScannerEvent): { title: string; lines: string[] } | null {
  const lines: string[] = [];
  for (const row of planRows(e)) {
    const plan = e.plans?.[row.mode] ?? null;
    if (row.levels !== null || plan === null) continue;
    lines.push(`${row.modeLabel} (${row.direction.toLowerCase()}): ${levelsText(plan)}`);
  }
  return lines.length > 0 ? { title: GEOMETRY_TITLE, lines } : null;
}

// ---------------------------------------------------------------- nucleo de analisis

export type Verdict = 'supports' | 'opposes' | 'neutral';

export function verdictFor(findingDirection: string, planDir: 'long' | 'short'): Verdict {
  if (findingDirection === 'up') return planDir === 'long' ? 'supports' : 'opposes';
  if (findingDirection === 'down') return planDir === 'short' ? 'supports' : 'opposes';
  return 'neutral';
}

const VERDICT_TEXT: Record<Verdict, string> = {
  supports: 'respalda este plan',
  opposes: 'se opone a este plan',
  neutral: 'no apunta a ningún lado',
};

/** Lineas del hallazgo principal del nucleo frente a cada plan; siempre con la nota de que no supero al azar. */
export function analysisLines(top: { label: string; direction: string } | null, e: ScannerEvent): string[] {
  if (!top) return ['Sin hallazgos en 15m para este par.', ANALYSIS_NOTE];
  const label = top.label.replace(/\s+/g, ' ').trim().slice(0, 60);
  const out = [`Hallazgo principal (15m): ${label}`];
  for (const mode of MODES) {
    const dir = planDirection(e, mode);
    out.push(`${MODE_LABEL[mode]}: ${VERDICT_TEXT[verdictFor(top.direction, dir)]}`);
  }
  out.push(ANALYSIS_NOTE);
  return out;
}

// ---------------------------------------------------------------- filtros y orden

export interface ScannerFilters {
  tier: 'all' | 'hi' | 'mid' | 'lo';
  signal: 'all' | 'move30' | 'move15';
  onlyEvidence: boolean;
  hideMarketWide: boolean;
  showMuted: boolean;
}

export const DEFAULT_FILTERS: ScannerFilters = {
  tier: 'all',
  signal: 'all',
  onlyEvidence: false,
  hideMarketWide: false,
  showMuted: true,
};

export function filterEvents<E extends ScannerEvent>(
  events: ReadonlyArray<E>,
  filters: ScannerFilters,
  overrides: CellOverrides = {},
): E[] {
  return events.filter((e) => {
    if (filters.tier !== 'all' && !isMarketRow(e) && e.tier !== filters.tier) return false;
    if (filters.signal !== 'all' && e.signal !== filters.signal) return false;
    if (filters.onlyEvidence && !hasEvidence(e)) return false;
    if (filters.hideMarketWide && e.marketWide) return false;
    if (!filters.showMuted && isMutedEvent(e, overrides)) return false;
    return true;
  });
}

export function sortEvents<E extends ScannerEvent>(events: ReadonlyArray<E>, by: 'recent' | 'volume'): E[] {
  const out = [...events];
  if (by === 'volume') {
    out.sort((a, b) => (b.q24 ?? -1) - (a.q24 ?? -1) || b.updatedAtMs - a.updatedAtMs);
  } else {
    out.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }
  return out;
}

// ---------------------------------------------------------------- avisos

/** Titulo y cuerpo de un aviso: solo cifras y un simbolo validado. null si el simbolo no es valido. */
export function notificationText(e: ScannerEvent): { title: string; message: string } | null {
  const w = windowMin(e.signal);
  const win = w === null ? '' : ` en ${w} min`;
  if (isMarketRow(e)) {
    return { title: `Mercado ${verb(e.move)} ≥ ${e.threshold} %${win}`, message: `${e.count ?? 0} pares a la vez` };
  }
  const sym = validSymbol(e.symbol);
  if (!sym || e.ret === null) return null;
  const parts = [`${sym} ${verb(e.move)} ${pct1(Math.abs(e.ret))} %${win}`];
  const extra = [e.vol_ratio === null ? null : `Volumen ${dec(e.vol_ratio, 1)}×`, gradeLabelOf(e)].filter(Boolean);
  return { title: parts[0]!, message: extra.join(' · ') };
}
