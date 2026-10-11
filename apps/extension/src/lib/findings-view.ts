import type { AnalysisResult, Finding, FindingLevel } from './types';
import { volumeShockMarkers } from './volume-flow-view';

export interface ChartMarker {
  time: number;
  position: 'aboveBar' | 'belowBar' | 'inBar';
  shape: 'arrowUp' | 'arrowDown' | 'circle';
  text: string;
  /** Hallazgo dueño del marcador: el gráfico lo usa para resaltar. */
  findingId: string;
}

/** Tipo de línea de precio. `invalidate` se dibuja punteada. */
export type PriceLineKind = 'level' | 'confirm' | 'invalidate';

export interface ChartPriceLine {
  price: number;
  title: string;
  kind: PriceLineKind;
  /** Hallazgo dueño de la línea. */
  findingId: string;
}

export interface ChartAnnotation {
  markers: ChartMarker[];
  priceLines: ChartPriceLine[];
}

export interface RenderedFinding {
  id: string;
  label: string;
  explanation: string;
  /** Fracción 0..1. No es una probabilidad. */
  fuerza: number;
  /** Ancho de la barra, 0..100. */
  fuerzaPct: number;
  annotations: ChartAnnotation;
}

export interface LegendLevel {
  price: number;
  kind: PriceLineKind;
  role: string;
}

export interface LegendRow {
  findingId: string;
  label: string;
  kind: string;
  direction: string;
  status: string;
  fuerzaPct: number;
  confirm: number | null;
  invalidate: number | null;
  levels: LegendLevel[];
  markerTimes: number[];
}

export const NO_ANNOTATIONS: ChartAnnotation = { markers: [], priceLines: [] };

/** Cuántos hallazgos se dibujan a la vez. Más estorba al gráfico, no lo mejora. */
export const CHART_FINDING_LIMIT = 5;

/**
 * `strength` del núcleo: fracción 0..1, o 0..100 si el valor es mayor que 1.
 * 1 significa fuerza completa, no 1%.
 */
export function normalizeStrength(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return 0;
  const fraction = n > 1 ? n / 100 : n;
  return Math.min(1, fraction);
}

function asSeconds(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n)) return null;
  const seconds = n > 10_000_000_000 ? Math.floor(n / 1000) : Math.floor(n);
  return seconds > 0 ? seconds : null;
}

export function nearestTime(times: readonly number[], target: number): number | null {
  if (!Number.isFinite(target) || times.length === 0) return null;
  let best = times[0]!;
  let bestDist = Math.abs(best - target);
  for (const time of times) {
    const dist = Math.abs(time - target);
    if (dist < bestDist) {
      best = time;
      bestDist = dist;
    }
  }
  return best;
}

function markerShape(direction: string): Pick<ChartMarker, 'position' | 'shape'> {
  if (direction === 'up') return { position: 'belowBar', shape: 'arrowUp' };
  if (direction === 'down') return { position: 'aboveBar', shape: 'arrowDown' };
  return { position: 'inBar', shape: 'circle' };
}

function price(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

export interface ResolvedLevel {
  price: number;
  confirm: number | null;
  invalidate: number | null;
  role: string;
}

/**
 * Normaliza `finding.levels`. El núcleo actual emite objetos
 * `{ role, price, confirm, invalidate }`; los núcleos viejos, números pelados.
 */
export function resolveLevels(levels: unknown): ResolvedLevel[] {
  if (!Array.isArray(levels)) return [];
  const out: ResolvedLevel[] = [];
  for (const level of levels) {
    if (typeof level === 'number' || typeof level === 'string') {
      const px = price(level);
      if (px === null) continue;
      out.push({ price: px, confirm: null, invalidate: null, role: '' });
      continue;
    }
    if (!level || typeof level !== 'object') continue;
    const record = level as FindingLevel;
    const px = price(record.price);
    if (px === null) continue;
    out.push({
      price: px,
      confirm: price(record.confirm),
      invalidate: price(record.invalidate),
      role: typeof record.role === 'string' ? record.role : '',
    });
  }
  return out;
}

/** Etiqueta corta del papel de un nivel, para el eje de precios. */
export function roleLabel(role: string, kind: string): string {
  const map: Record<string, string> = {
    neckline: 'cuello',
    trough: 'valle',
    peak: 'pico',
    support: 'soporte',
    resistance: 'resistencia',
    poc: 'POC',
    vah: 'vah',
    val: 'val',
    range_high: 'techo',
    range_low: 'suelo',
    pivot_high: 'máx',
    pivot_low: 'mín',
    divergence_start: 'inicio',
    divergence_end: 'fin',
    fvg_top: 'fvg',
    fvg_bottom: 'fvg',
    bos: 'BOS',
    choch: 'CHoCH',
    ob_high: 'OB',
    ob_low: 'OB',
    sweep: 'barrido',
    neck: 'cuello',
    upper: 'techo',
    lower: 'suelo',
    volume_shock: 'choque de volumen',
    absorption: 'absorción',
    climax: 'clímax',
  };
  const short = role ? map[role] ?? role.replace(/_/g, ' ') : '';
  return short || kind || 'nivel';
}

const KIND_LABEL: Record<string, string> = {
  pivot: 'pivote',
  sr_zone: 'zona S/R',
  double_top: 'doble techo',
  double_bottom: 'doble suelo',
  ascending_triangle: 'triángulo asc.',
  descending_triangle: 'triángulo desc.',
  symmetric_triangle: 'triángulo sim.',
  range_breakout: 'ruptura de rango',
  shock: 'vela de choque',
  volume_profile: 'perfil de volumen',
  volume_shock_buy: 'compra agresiva',
  volume_shock_sell: 'venta agresiva',
  delta_divergence_bullish: 'divergencia de delta alcista',
  delta_divergence_bearish: 'divergencia de delta bajista',
  absorption: 'absorción',
  climax: 'clímax de volumen',
  rsi_divergence_bullish: 'divergencia RSI alcista',
  rsi_divergence_bearish: 'divergencia RSI bajista',
  fvg_bullish: 'FVG alcista',
  fvg_bearish: 'FVG bajista',
  bos_bullish: 'BOS alcista',
  bos_bearish: 'BOS bajista',
  choch_bullish: 'CHoCH alcista',
  choch_bearish: 'CHoCH bajista',
  order_block_bullish: 'order block alcista',
  order_block_bearish: 'order block bajista',
  liquidity_sweep_high: 'barrido de máximos',
  liquidity_sweep_low: 'barrido de mínimos',
  head_and_shoulders: 'hombro-cabeza-hombro',
  rising_wedge: 'cuña alcista',
  falling_wedge: 'cuña bajista',
  bull_flag: 'bandera alcista',
  bear_flag: 'bandera bajista',
};

export function kindLabel(kind: string, label: string): string {
  const text = (label || '').trim();
  return text || KIND_LABEL[kind] || kind || 'hallazgo';
}

/** Choques de volumen con sesgo: ▲ compra agresiva, ▼ venta agresiva. */
export function isVolumeShockKind(kind: string): boolean {
  return kind === 'volume_shock_buy' || kind === 'volume_shock_sell';
}

/**
 * Marcadores de `from`/`to` anclados a la vela más cercana. Los choques de
 * volumen llevan su propio glifo (▲/▼) en lugar de la etiqueta.
 */
export function markersForFinding(
  finding: Finding,
  candleTimes: readonly number[] = [],
): ChartMarker[] {
  if (isVolumeShockKind(String(finding.kind ?? ''))) {
    return volumeShockMarkers([finding], candleTimes);
  }
  const shape = markerShape(finding.direction);
  const rawTimes = [asSeconds(finding.from), asSeconds(finding.to)].filter(
    (time): time is number => time !== null,
  );
  const snapped = rawTimes.map((time) => nearestTime(candleTimes, time) ?? time);
  const seen = new Set<number>();
  const id = String(finding.id);
  const markers: ChartMarker[] = [];
  snapped.forEach((time, index) => {
    if (seen.has(time)) return;
    seen.add(time);
    const isLast = index === snapped.length - 1;
    markers.push({
      time,
      position: shape.position,
      shape: shape.shape,
      text: isLast ? String(finding.label || finding.kind || 'hallazgo').slice(0, 18) : '',
      findingId: id,
    });
  });
  return markers;
}

/**
 * Líneas de precio de un hallazgo: una sólida por nivel y las de decisión
 * `confirm` / `invalidate`. `invalidate` se marca para dibujarse punteada.
 */
export function priceLinesForFinding(finding: Finding): ChartPriceLine[] {
  const id = String(finding.id);
  const levels = resolveLevels(finding.levels);
  const kindText = String(finding.kind ?? '');
  const lines: ChartPriceLine[] = [];
  const seenPrice = new Set<number>();

  for (const level of levels) {
    if (seenPrice.has(level.price)) continue;
    seenPrice.add(level.price);
    lines.push({
      price: level.price,
      title: roleLabel(level.role, kindText),
      kind: 'level',
      findingId: id,
    });
  }

  const confirm = levels.find((level) => level.confirm !== null)?.confirm ?? null;
  const invalidate = levels.find((level) => level.invalidate !== null)?.invalidate ?? null;
  if (confirm !== null && !seenPrice.has(confirm)) {
    seenPrice.add(confirm);
    lines.push({ price: confirm, title: 'confirma', kind: 'confirm', findingId: id });
  }
  if (invalidate !== null && !seenPrice.has(invalidate)) {
    seenPrice.add(invalidate);
    lines.push({ price: invalidate, title: 'invalida', kind: 'invalidate', findingId: id });
  }
  return lines;
}

export function annotationsForFinding(
  finding: Finding,
  candleTimes: readonly number[] = [],
): ChartAnnotation {
  return {
    markers: markersForFinding(finding, candleTimes),
    priceLines: priceLinesForFinding(finding),
  };
}

/** Ordena por fuerza y corta en `limit`. Empate: el más reciente primero. */
export function rankFindings(findings: readonly Finding[], limit = CHART_FINDING_LIMIT): Finding[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort(
      (a, b) =>
        normalizeStrength(b.finding.strength) - normalizeStrength(a.finding.strength) ||
        b.finding.to - a.finding.to ||
        a.index - b.index,
    )
    .slice(0, Math.max(1, limit))
    .map(({ finding }) => finding);
}

/**
 * Anotaciones de TODOS los hallazgos del `top`, no solo del seleccionado.
 * Las líneas repetidas (mismo precio y tipo) se dibujan una sola vez.
 */
export function annotationsForFindings(
  findings: readonly Finding[],
  opts?: { candleTimes?: readonly number[]; limit?: number },
): ChartAnnotation {
  const ranked = rankFindings(findings, opts?.limit ?? CHART_FINDING_LIMIT);
  const candleTimes = opts?.candleTimes ?? [];
  const markers: ChartMarker[] = [];
  const priceLines: ChartPriceLine[] = [];
  const seenLine = new Set<string>();
  for (const finding of ranked) {
    markers.push(...markersForFinding(finding, candleTimes));
    for (const line of priceLinesForFinding(finding)) {
      const key = `${line.kind}@${line.price}`;
      if (seenLine.has(key)) continue;
      seenLine.add(key);
      priceLines.push(line);
    }
  }
  return { markers, priceLines };
}

export function renderAnalysis(
  result: AnalysisResult,
  opts?: { limit?: number; candleTimes?: readonly number[] },
): RenderedFinding[] {
  const limit = opts?.limit ?? CHART_FINDING_LIMIT;
  const candleTimes = opts?.candleTimes ?? [];
  return rankFindings(result.top.length > 0 ? result.top : result.findings, limit).map((finding) => {
    const fuerza = normalizeStrength(finding.strength);
    return {
      id: String(finding.id),
      label: kindLabel(String(finding.kind ?? ''), String(finding.label ?? '')).slice(0, 80),
      explanation: String(finding.explanation ?? ''),
      fuerza,
      fuerzaPct: Math.round(fuerza * 100),
      annotations: annotationsForFinding(finding, candleTimes),
    };
  });
}

/**
 * Leyenda del gráfico: qué pinta cada hallazgo y qué precios deciden.
 * Es la fuente que lee el panel, así que no se inventa nada de memoria.
 */
export function findingsLegend(
  findings: readonly Finding[],
  opts?: { limit?: number },
): LegendRow[] {
  return rankFindings(findings, opts?.limit ?? CHART_FINDING_LIMIT).map((finding) => {
    const levels = resolveLevels(finding.levels);
    const confirm = levels.find((level) => level.confirm !== null)?.confirm ?? null;
    const invalidate = levels.find((level) => level.invalidate !== null)?.invalidate ?? null;
    const labels = priceLinesForFinding(finding);
    return {
      findingId: String(finding.id),
      label: kindLabel(String(finding.kind ?? ''), String(finding.label ?? '')),
      kind: String(finding.kind ?? ''),
      direction: String(finding.direction ?? 'neutral'),
      status: String(finding.status ?? ''),
      fuerzaPct: Math.round(normalizeStrength(finding.strength) * 100),
      confirm,
      invalidate,
      levels: labels.map((line) => ({ price: line.price, kind: line.kind, role: line.title })),
      markerTimes: markersForFinding(finding).map((marker) => marker.time),
    };
  });
}
