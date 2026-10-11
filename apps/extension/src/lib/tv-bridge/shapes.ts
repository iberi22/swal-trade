/**
 * De hallazgo a forma del gráfico de Binance.
 *
 * El panel ya calcula los hallazgos; aquí se convierten en formas que el puente
 * MAIN-world se pasa a la API de TradingView. Esta función es pura: no toca el
 * DOM ni la red, así que se prueba sin navegador.
 *
 * Correspondencia (verificado contra la API en `e2e/scripts/investigation/`):
 * - `level`  → `horizontal_line`, sólida o punteada según el estilo;
 * - `trend`  → `trend_line`, dos puntos;
 * - `zone`   → `rectangle`, dos puntos en diagonal;
 * - `label`  → `text`, un punto;
 * - `arrow`  → `arrow_up` / `arrow_down`, un punto.
 *
 * Nada de esto inventa precios: cada punto sale de `finding.levels`, de la
 * línea que trae el nivel o de `priceAt` (la vela más cercana del panel). Si un
 * nivel no trae banda de precios, se pinta una línea, no una zona inventada.
 */

import { CHART_FINDING_LIMIT, kindLabel, rankFindings, roleLabel } from '../findings-view';
import type { Finding, FindingLevel } from '../types';
import { MAX_SHAPE_TEXT, SWAL_MAX_SHAPES, type BridgeShape } from './schema';

/**
 * Precio formateado en español con cifras significativas.
 *
 * Seis cifras significativas, no dos decimales fijos: un shiba a 0.00001234
 * conserva sus dígitos útiles (`0,00001234`) y no colapsa a `0`, y un BTC a
 * 82977.7 se agrupa en `82.977,7`. Un `toFixed(2)` inventaría ceros o perdería
 * precisión según la escala del activo.
 */
export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return new Intl.NumberFormat('es', { maximumSignificantDigits: 6 }).format(value);
}

function shortText(text: string): string {
  return text.slice(0, MAX_SHAPE_TEXT);
}

/**
 * Nivel leído del hallazgo. Se conserva el registro original (`raw`) porque los
 * campos extra del núcleo -`line.from/to` en los triángulos, `time` en los
 * pivotes- son la geometría real de la forma.
 */
interface ShapeLevel {
  role: string;
  price: number | null;
  confirm: number | null;
  invalidate: number | null;
  raw: FindingLevel;
}

/**
 * Lee `finding.levels`. El núcleo actual emite objetos
 * `{ role, price, confirm, invalidate, line?, time? }`; los núcleos viejos,
 * números pelados.
 */
function readLevels(levels: unknown): ShapeLevel[] {
  if (!Array.isArray(levels)) return [];
  const out: ShapeLevel[] = [];
  for (const entry of levels) {
    if (typeof entry === 'number' || typeof entry === 'string') {
      const px = finiteNumber(Number(entry));
      out.push({ role: '', price: px, confirm: null, invalidate: null, raw: { price: px ?? 0 } });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as FindingLevel;
    out.push({
      role: typeof record.role === 'string' ? record.role : '',
      price: finiteNumber(record.price),
      confirm: finiteNumber(record.confirm),
      invalidate: finiteNumber(record.invalidate),
      raw: record,
    });
  }
  return out;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Segundos unix, aceptando milisegundos como entra el núcleo a veces. */
function toSeconds(value: unknown): number | null {
  const n = finiteNumber(value);
  if (n === null || n <= 0) return null;
  return n > 10_000_000_000 ? Math.floor(n / 1000) : Math.floor(n);
}

/**
 * Línea inclinada cuando el nivel trae `line.from` / `line.to` (triángulos) o
 * cuando es un cuello: entonces se pinta de `from` a `to` del hallazgo.
 */
function trendPoints(finding: Finding, level: ShapeLevel): { time: number; price: number }[] | null {
  const raw = level.raw as { line?: { from?: { time?: unknown; price?: unknown }; to?: { time?: unknown; price?: unknown } } };
  const start = raw.line?.from;
  const end = raw.line?.to;
  const startTime = toSeconds(start?.time);
  const endTime = toSeconds(end?.time);
  const startPrice = finiteNumber(start?.price);
  const endPrice = finiteNumber(end?.price);
  if (startTime !== null && endTime !== null && startPrice !== null && endPrice !== null) {
    return [
      { time: startTime, price: startPrice },
      { time: endTime, price: endPrice },
    ];
  }
  const from = toSeconds(finding.from);
  const to = toSeconds(finding.to);
  const price = level.price;
  if (from === null || to === null || price === null || from === to) return null;
  return [
    { time: from, price },
    { time: to, price },
  ];
}

/** Roles cuya geometría natural es una línea entre dos instantes. */
const TREND_ROLES = new Set([
  'neckline',
  'neck',
  'triangle_upper',
  'triangle_lower',
  'wedge_upper',
  'wedge_lower',
  'flag_low',
  'flag_high',
  'structure_level',
]);

/** Banda de precios de una zona: techo, suelo y niveles que la explican. */
export interface ZoneBand {
  top: number;
  bottom: number;
  owners: Set<ShapeLevel>;
}

/**
 * Bandas que el hallazgo trae de verdad: las parejas de niveles
 * fvg_top/fvg_bottom, ob_high/ob_low y vah/val, más los niveles sueltos que ya
 * vienen con `high`/`low` (la zona de soporte/resistencia). Si no hay banda, no
 * hay zona: no se inventa un rectángulo alrededor de un precio.
 */
function zoneBands(levels: ShapeLevel[]): ZoneBand[] {
  const out: ZoneBand[] = [];
  const add = (top: number, bottom: number, owners: ShapeLevel[]) => {
    if (!(top > bottom)) return;
    out.push({ top, bottom, owners: new Set(owners) });
  };
  const byRole = (role: string) => levels.find((level) => level.role === role);
  const pairs: Array<[string, string]> = [
    ['fvg_top', 'fvg_bottom'],
    ['ob_high', 'ob_low'],
    ['vah', 'val'],
  ];
  for (const [topRole, bottomRole] of pairs) {
    const top = byRole(topRole);
    const bottom = byRole(bottomRole);
    if (!top || !bottom || top.price === null || bottom.price === null) continue;
    add(top.price, bottom.price, [top, bottom]);
  }
  for (const level of levels) {
    const raw = level.raw as { high?: unknown; low?: unknown };
    const high = finiteNumber(raw.high);
    const low = finiteNumber(raw.low);
    if (high === null || low === null) continue;
    add(high, low, [level]);
  }
  return out;
}

export interface ShapesOptions {
  /** Cuántos hallazgos se pintan. Por defecto, el mismo límito del panel. */
  limit?: number;
  /** Instantes de las velas del panel, para anclar marcadores. */
  candleTimes?: readonly number[];
  /** Precio de la vela más cercana a un instante. Sin ella no hay flechas. */
  priceAt?: (time: number) => number | null;
}

function nearestPrice(
  candleTimes: readonly number[],
  time: number,
  priceAt: ((time: number) => number | null) | undefined,
): number | null {
  if (!priceAt) return null;
  let bestTime = time;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candleTimes) {
    const distance = Math.abs(candidate - time);
    if (distance < bestDistance) {
      bestTime = candidate;
      bestDistance = distance;
    }
  }
  if (!Number.isFinite(bestDistance)) return null;
  return priceAt(bestTime);
}

/**
 * Formas de un hallazgo. El orden es estable: niveles, decisión, cuellos,
 * zonas y, si la vela lo pide, la flecha del choque.
 */
export function shapesForFinding(finding: Finding, opts?: ShapesOptions): BridgeShape[] {
  const candleTimes = opts?.candleTimes ?? [];
  const levels = readLevels(finding.levels);
  const kind = String(finding.kind ?? '');
  const label = kindLabel(kind, String(finding.label ?? ''));
  const findingId = String(finding.id ?? '');
  const from = toSeconds(finding.from);
  const to = toSeconds(finding.to) ?? from;
  const shapes: BridgeShape[] = [];

  const confirmPrice = levels.find((level) => level.confirm !== null)?.confirm ?? null;
  const invalidatePrice = levels.find((level) => level.invalidate !== null)?.invalidate ?? null;

  // Zonas: solo cuando el hallazgo trae banda de precios de verdad. Los niveles
  // que la forman no se repiten como línea suelta.
  const bands = zoneBands(levels);
  const inBand = new Set<ShapeLevel>();
  for (const band of bands) for (const owner of band.owners) inBand.add(owner);

  for (const level of levels) {
    const price = level.price;
    if (price === null) continue;
    if (inBand.has(level)) continue;
    const role = typeof level.role === 'string' ? level.role : '';
    const roleText = roleLabel(role, kind);
    const id = `${findingId}|${role || 'level'}:${price}`;
    const trend = role && TREND_ROLES.has(role) ? trendPoints(finding, level) : null;
    if (trend) {
      shapes.push({
        id: `${id}|trend`,
        kind: 'trend',
        style: 'solid',
        text: shortText(`${roleText} ${formatPrice(price)}`),
        points: trend,
      });
      continue;
    }
    shapes.push({
      id,
      kind: 'level',
      style: 'solid',
      text: shortText(`${roleText} ${formatPrice(price)}`),
      points: [{ time: to ?? 0, price }],
    });
  }

  if (confirmPrice !== null && !levels.some((level) => level.price === confirmPrice)) {
    shapes.push({
      id: `${findingId}|confirm:${confirmPrice}`,
      kind: 'level',
      style: 'solid',
      text: shortText(`confirma ${formatPrice(confirmPrice)}`),
      points: [{ time: to ?? 0, price: confirmPrice }],
    });
  }
  if (
    invalidatePrice !== null &&
    !levels.some((level) => level.price === invalidatePrice)
  ) {
    shapes.push({
      id: `${findingId}|invalidate:${invalidatePrice}`,
      kind: 'level',
      style: 'dashed',
      text: shortText(`invalida ${formatPrice(invalidatePrice)}`),
      points: [{ time: to ?? 0, price: invalidatePrice }],
    });
  }

  const zoneFrom = from ?? to ?? 0;
  const zoneTo = to ?? zoneFrom;
  bands.forEach((band, index) => {
    shapes.push({
      id: `${findingId}|zone${index}`,
      kind: 'zone',
      style: 'solid',
      text: shortText(`${label} ${formatPrice(band.bottom)}-${formatPrice(band.top)}`),
      points: [
        { time: zoneFrom, price: band.bottom },
        { time: zoneTo, price: band.top },
      ],
    });
  });

  // Flechas: velas de choque y barridos de liquidez. Sin precio de vela
  // cerca no hay flecha: inventar un precio sería fabricar señales. El texto
  // es neutro (nunca "compra"/"venta"): describe la vela y su dirección.
  if (kind === 'shock' || kind === 'liquidity_sweep_high' || kind === 'liquidity_sweep_low') {
    const direction = finding.direction === 'down' ? 'down' : 'up';
    const time = from ?? 0;
    const price = nearestPrice(candleTimes, time, opts?.priceAt);
    if (price !== null) {
      shapes.push({
        id: `${findingId}|arrow`,
        kind: 'arrow',
        style: 'solid',
        text: shortText(`${label} ${direction === 'up' ? 'al alza' : 'a la baja'}`),
        points: [{ time, price }],
        direction,
      });
    }
  }

  return shapes;
}

/**
 * Formas de todos los hallazgos que caben en el gráfico. Las líneas repetidas
 * (mismo id estable) se pintan una vez.
 */
export function shapesForFindings(findings: readonly Finding[], opts?: ShapesOptions): BridgeShape[] {
  const ranked = rankFindings(findings, opts?.limit ?? CHART_FINDING_LIMIT);
  const seen = new Set<string>();
  const out: BridgeShape[] = [];
  for (const finding of ranked) {
    for (const shape of shapesForFinding(finding, opts)) {
      if (seen.has(shape.id)) continue;
      seen.add(shape.id);
      out.push(shape);
      // El mensaje tiene tope: sobra lo que no quepa.
      if (out.length >= SWAL_MAX_SHAPES) return out;
    }
  }
  return out;
}
