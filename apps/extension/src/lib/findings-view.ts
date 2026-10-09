import type { Finding, AnalysisResult } from './types';

export interface ChartMarker {
  time: number;
  position: 'aboveBar' | 'belowBar' | 'inBar';
  shape: 'arrowUp' | 'arrowDown' | 'circle';
  text: string;
}

export interface ChartPriceLine {
  price: number;
  title: string;
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

export const NO_ANNOTATIONS: ChartAnnotation = { markers: [], priceLines: [] };

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

export function annotationsForFinding(
  finding: Finding,
  candleTimes: readonly number[] = [],
): ChartAnnotation {
  const shape = markerShape(finding.direction);
  const label = (finding.label || finding.kind || 'hallazgo').slice(0, 18);
  const rawTimes = [asSeconds(finding.from), asSeconds(finding.to)].filter(
    (time): time is number => time !== null,
  );
  const snapped = rawTimes.map((time) => nearestTime(candleTimes, time) ?? time);
  const seen = new Set<number>();
  const markers: ChartMarker[] = [];
  snapped.forEach((time, index) => {
    if (seen.has(time)) return;
    seen.add(time);
    const isLast = index === snapped.length - 1;
    markers.push({
      time,
      position: shape.position,
      shape: shape.shape,
      text: isLast ? label : '',
    });
  });

  const levels = Array.isArray(finding.levels) ? finding.levels : [];
  const prices = new Set<number>();
  const priceLines: ChartPriceLine[] = [];
  for (const level of levels) {
    if (typeof level !== 'number' || !Number.isFinite(level) || prices.has(level)) continue;
    prices.add(level);
    priceLines.push({ price: level, title: label });
  }
  return { markers, priceLines };
}

export function renderAnalysis(
  result: AnalysisResult,
  opts?: { limit?: number; candleTimes?: readonly number[] },
): RenderedFinding[] {
  const limit = opts?.limit ?? 5;
  const candleTimes = opts?.candleTimes ?? [];
  const ranked = result.findings.map((finding, index) => ({ finding, index }));
  ranked.sort(
    (a, b) =>
      normalizeStrength(b.finding.strength) - normalizeStrength(a.finding.strength) ||
      a.index - b.index,
  );
  return ranked.slice(0, limit).map(({ finding }) => {
    const fuerza = normalizeStrength(finding.strength);
    return {
      id: String(finding.id),
      label: String(finding.label ?? '').slice(0, 80),
      explanation: String(finding.explanation ?? ''),
      fuerza,
      fuerzaPct: Math.round(fuerza * 100),
      annotations: annotationsForFinding(finding, candleTimes),
    };
  });
}
