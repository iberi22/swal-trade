/**
 * Modelo PURO de la tarjeta «Tu dibujo»: qué se enseña para cada herramienta
 * Long/Short Position leída del gráfico. Sin Svelte, sin DOM y sin red, para
 * poder afirmarlo en tests sin montar el componente.
 *
 * Lenguaje: «largo» y «corto», nunca «comprar»/«vender»; ninguna probabilidad.
 * Todo lo que se afirma sale de `analyzeDrawing` (geometría y costes), y la
 * línea honesta viaja siempre con el resumen y con el ticket copiado.
 */

import { DRAWING_HONEST_LINE } from './analyze';
import type { DrawingAnalysis, DrawingCheck, DrawingSide } from './types';

/** Cuántas herramientas se enseñan a la vez (la última y la anterior). */
export const DRAWING_MAX_SHOWN = 2;

export const DRAWING_OFF_TEXT =
  'Lee las posiciones que dibujas con la herramienta Long/Short Position en la pestaña Trading View de Binance. Solo lectura: no crea ni mueve dibujos.';

export const DRAWING_EMPTY_HINT =
  'Abre la pestaña Trading View de Binance y dibuja una posición larga o corta.';

export const DRAWING_AI_NOT_CONFIGURED = 'Configura un proveedor de IA en Ajustes';

const decimals = (value: number, dp: number): string => {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(dp).replace('.', ',');
};

/** Precio con coma decimal; los precios pequeños conservan cifras significativas. */
export function formatDrawingPrice(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1) return decimals(value, 2);
  return String(Number(value.toPrecision(6))).replace('.', ',');
}

/** Número plano para el portapapeles: punto decimal, sin separador de miles. */
function plain(value: number): string {
  if (!Number.isFinite(value)) return '-';
  return String(Number(value.toPrecision(10)));
}

const sideLabel = (side: DrawingSide): string => (side === 'short' ? 'Corto' : 'Largo');

export interface DrawingNumber {
  label: string;
  value: string;
}

export interface DrawingCheckLine {
  code: string;
  severity: DrawingCheck['severity'];
  text: string;
}

export interface DrawingCardTool {
  id: string;
  sideLabel: string;
  summary: string;
  checks: DrawingCheckLine[];
  numbers: DrawingNumber[];
  /** Niveles que el objetivo tiene que cruzar, con distancia desde la entrada. */
  levels: string[];
  reach: string;
  funding: string;
  honestLine: string;
  /** Texto plano para el portapapeles. */
  ticket: string;
  /** Lo que se carga en el dimensionador. */
  load: { direction: DrawingSide; entry: number; stop: number };
}

export type DrawingCardModel =
  | { state: 'off'; text: string }
  | { state: 'empty'; hint: string }
  | { state: 'ready'; tools: DrawingCardTool[] };

export interface DrawingCardInput {
  /** `settings.readDrawings`. */
  enabled: boolean;
  /** Símbolo del panel: solo se enseña lo dibujado sobre él. */
  symbol: string;
  /** Análisis ya calculados, en el orden en que llegaron del gráfico. */
  analyses: readonly DrawingAnalysis[];
}

/** Niveles que el objetivo cruza, de más cerca a más lejos de la entrada. */
export function levelLines(analysis: DrawingAnalysis): string[] {
  return analysis.levels.betweenEntryAndTarget.map((level) => {
    const atr = level.distanceAtrFromEntry;
    const suffix = atr !== null ? ` (${decimals(atr, 1)} ATR)` : '';
    return `${level.label} a ${decimals(level.distancePctFromEntry, 2)} %${suffix}`;
  });
}

/** Alcance del objetivo frente al rango típico (±1 ATR) de cada horizonte. */
export function reachText(analysis: DrawingAnalysis): string {
  const horizon = analysis.reach.smallestHorizon;
  if (horizon === '1h') return 'el objetivo cabe en el rango típico de 1 hora';
  if (horizon === '4h') return 'el objetivo cabe en el rango típico de 4 horas';
  if (horizon === '24h') return 'el objetivo cabe en el rango típico de 24 horas';
  const hasAtr =
    analysis.geometry.targetAtr1h !== null ||
    analysis.reach.targetAtr4h !== null ||
    analysis.reach.targetAtrD !== null;
  if (!hasAtr) return 'sin datos de ATR para comparar el alcance del objetivo';
  return 'el objetivo queda fuera de los rangos típicos de 1 h, 4 h y 24 h';
}

/** Funding por 8 h: cuánto paga (o cobra) el lado dibujado y su peso en el riesgo. */
export function fundingText(analysis: DrawingAnalysis): string {
  const rate = analysis.funding.ratePct8h;
  if (rate === null) return 'sin dato de funding';
  const side = analysis.funding.sidePays ? 'lo paga tu lado' : 'lo cobra tu lado';
  const share =
    analysis.funding.pctOfRiskPer8h !== null
      ? ` · ${decimals(analysis.funding.pctOfRiskPer8h, 2)} % del riesgo cada 8 h`
      : '';
  return `${decimals(rate, 4)} % cada 8 h · ${side}${share}`;
}

/** Cifras clave: entrada, stop, objetivo, R:R, distancia del stop y tamaño. */
export function numberLines(analysis: DrawingAnalysis): DrawingNumber[] {
  const g = analysis.geometry;
  const size = analysis.size;
  const stopAtr = g.stopAtr1h !== null ? ` = ${decimals(g.stopAtr1h, 2)} ATR(1h)` : '';
  return [
    {
      label: 'Entrada',
      value: `${formatDrawingPrice(analysis.drawing.entry)} · ${g.entryMode === 'límite' ? 'límite' : 'mercado'}`,
    },
    { label: 'Stop', value: formatDrawingPrice(analysis.drawing.stop) },
    { label: 'Objetivo', value: formatDrawingPrice(analysis.drawing.target) },
    { label: 'R:R bruto / neto', value: `${decimals(g.rr, 2)} / ${decimals(analysis.costs.netRr, 2)}` },
    { label: 'Distancia del stop', value: `${decimals(g.riskPct, 2)} %${stopAtr}` },
    {
      label: 'Pérdida a tu regla',
      value:
        size.lossUsd > 0
          ? `${decimals(size.lossUsd, 2)} USD`
          : 'el mínimo del contrato no cabe en tu regla',
    },
    { label: 'Cantidad', value: size.qty > 0 ? plain(size.qty) : '—' },
  ];
}

/** Ticket en texto plano: se copia tal cual, sin markdown. */
export function drawingTicketText(analysis: DrawingAnalysis): string {
  const lines = [
    `DIBUJO · ${analysis.symbol} · ${sideLabel(analysis.side)}`,
    `Entrada: ${plain(analysis.drawing.entry)} (${analysis.geometry.entryMode})`,
    `Stop: ${plain(analysis.drawing.stop)}`,
    `Objetivo: ${plain(analysis.drawing.target)}`,
    `R:R: ${plain(analysis.geometry.rr)} (neto ${plain(analysis.costs.netRr)})`,
    `Stop: ${plain(analysis.geometry.riskPct)} % del precio`,
    `Cantidad a tu regla: ${analysis.size.qty > 0 ? plain(analysis.size.qty) : 'no cabe en el mínimo del contrato'}`,
    `Pérdida en el stop: ${plain(analysis.size.lossUsd)} USD`,
    DRAWING_HONEST_LINE,
  ];
  return lines.join('\n');
}

export function toolFromAnalysis(analysis: DrawingAnalysis): DrawingCardTool {
  return {
    id: analysis.drawing.id,
    sideLabel: sideLabel(analysis.side),
    summary: analysis.summary,
    checks: analysis.checks.map((check) => ({
      code: check.code,
      severity: check.severity,
      text: check.text,
    })),
    numbers: numberLines(analysis),
    levels: levelLines(analysis),
    reach: reachText(analysis),
    funding: fundingText(analysis),
    honestLine: DRAWING_HONEST_LINE,
    ticket: drawingTicketText(analysis),
    load: {
      direction: analysis.side,
      entry: analysis.drawing.entry,
      stop: analysis.drawing.stop,
    },
  };
}

/**
 * Construye lo que enseña la tarjeta. Del más nuevo al más viejo se muestran
 * como mucho `DRAWING_MAX_SHOWN`; el orden de llegada del gráfico se respeta
 * (las formas nuevas van al final de `getAllShapes`).
 */
export function buildDrawingCardModel(input: DrawingCardInput): DrawingCardModel {
  if (!input.enabled) return { state: 'off', text: DRAWING_OFF_TEXT };
  const symbol = typeof input.symbol === 'string' ? input.symbol.toUpperCase() : '';
  const mine = (input.analyses ?? []).filter(
    (analysis) => analysis && analysis.symbol.toUpperCase() === symbol,
  );
  if (mine.length === 0) return { state: 'empty', hint: DRAWING_EMPTY_HINT };
  const shown = mine.slice(-DRAWING_MAX_SHOWN).reverse();
  return { state: 'ready', tools: shown.map(toolFromAnalysis) };
}
