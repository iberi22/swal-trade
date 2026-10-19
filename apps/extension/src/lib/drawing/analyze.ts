import type { LevelRow } from '../context/levels';
import { expectedRange } from '../context/levels';
import { calculatePositionSize, floorToStep, roundToDecimals } from '../sizing';
import type {
  AnalyzeDrawingInput,
  DrawingAnalysis,
  DrawingCheck,
  DrawingFilters,
  DrawingLevelContext,
  DrawingSide,
  DrawingSize,
} from './types';

/**
 * Análisis determinista de un dibujo Long/Short Position: geometría, costes,
 * tamaño al riesgo de la regla, niveles, alcance y funding. Puro (sin red ni
 * DOM). No predice dirección: ningún nivel ni R:R tiene ventaja medida.
 */

/** Comisión maker de entrada (0,02 %) y taker de entrada/salida (0,05 %). */
export const MAKER_ENTRY_FEE_PCT = 0.02;
export const TAKER_ENTRY_FEE_PCT = 0.05;
export const TAKER_EXIT_FEE_PCT = 0.05;

/** Umbrales del contrato. */
export const MARKET_ENTRY_PCT = 0.05;
export const TINY_STOP_PCT = 0.3;
export const FEE_SHARE_WARN_PCT = 10;
export const NEAR_STOP_ATR = 0.3;
export const TARGET_NEAR_LEVEL_ATR = 0.2;
export const MAX_CHECKS = 8;

export const DRAWING_HONEST_LINE =
  'Lectura de geometría y costes, no una predicción: ningún nivel ni R:R tiene ventaja medida.';

const r2 = (n: number): number => Math.round(n * 100) / 100;
const r4 = (n: number): number => roundToDecimals(n, 4);

/** Formatea un número con coma decimal y `dp` decimales, para el texto en castellano. */
const fmt = (n: number, dp = 1): string => {
  if (!Number.isFinite(n)) return '0';
  const fixed = n.toFixed(dp);
  return dp === 0 ? fixed : fixed.replace('.', ',');
};

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : text.slice(0, max - 1).trimEnd();

const toSide = (side: DrawingSide): DrawingSide => (side === 'short' ? 'short' : 'long');

function levelContext(level: LevelRow, entry: number, atr1h: number | null): DrawingLevelContext {
  const dist = Math.abs(level.price - entry);
  return {
    price: level.price,
    kind: level.kind,
    label: level.label,
    distancePctFromEntry: r4((dist / entry) * 100),
    distanceAtrFromEntry: atr1h && atr1h > 0 ? r2(dist / atr1h) : null,
  };
}

const emptySize = (riskUsd: number): DrawingSize => ({
  qty: 0,
  notionalUsd: 0,
  marginUsd: 0,
  minLeverage: 1,
  lossUsd: 0,
  lossPct: 0,
  riskUsd,
});

/**
 * Tamaño de la posición al riesgo de la regla (riesgo = maxRiskPct), con los
 * filtros de redondeo del contrato. `buildTicket` no acepta un stop explícito
 * (solo ATR, % o invalidación), así que se usa el helper previsto en el
 * contrato: `calculatePositionSize` y los helpers de `sizing.ts`. No duplica
 * fórmulas ni modifica el ticket. Si el mínimo del contrato obligara a
 * arriesgar más que la regla, devuelve 0 en lugar de inflar el tamaño.
 */
function sizeAtRule(input: {
  capital: number;
  riskPct: number;
  direction: DrawingSide;
  entry: number;
  stop: number;
  filters?: DrawingFilters;
}): DrawingSize {
  const { capital, riskPct, direction, entry, stop, filters } = input;
  const riskUsd = r2(capital * (riskPct / 100));
  const base = calculatePositionSize({ capital, riskPct, direction, entry, stop });
  if (!base.valid) return emptySize(riskUsd);

  const step = filters?.stepSize;
  const qty = step && Number.isFinite(step) && step > 0 ? floorToStep(base.quantity, step) : base.quantity;
  if (!(qty > 0)) return emptySize(riskUsd);

  const minQty = filters?.minQty;
  const minNotional = filters?.minNotional;
  const belowMinQty = !!minQty && Number.isFinite(minQty) && minQty > 0 && qty < minQty;
  const belowMinNotional =
    !!minNotional && Number.isFinite(minNotional) && minNotional > 0 && qty * entry < minNotional;
  if (belowMinQty || belowMinNotional) return emptySize(riskUsd);

  const notionalUsd = r2(qty * entry);
  const lossUsd = r2(qty * Math.abs(entry - stop));
  const minLeverage = Math.max(1, Math.ceil(notionalUsd / capital));
  const marginUsd = r2(notionalUsd / minLeverage);
  const lossPct = r4((lossUsd / capital) * 100);
  return {
    qty: roundToDecimals(qty, 8),
    notionalUsd,
    marginUsd,
    minLeverage,
    lossUsd,
    lossPct,
    riskUsd,
  };
}

export function analyzeDrawing(input: AnalyzeDrawingInput): DrawingAnalysis {
  const { drawing, capital, rules } = input;
  const side = toSide(drawing.side);
  const dir = side === 'long' ? 1 : -1;
  const entry = drawing.entry;
  const stop = drawing.stop;
  const target = drawing.target;
  const price = input.price;
  const atr1h = input.atrs?.atr1h ?? null;
  const atr4h = input.atrs?.atr4h ?? null;
  const atrD = input.atrs?.atrD ?? null;

  const riskPct = entry > 0 ? r4((Math.abs(entry - stop) / entry) * 100) : 0;
  const rewardPct = entry > 0 ? r4((Math.abs(target - entry) / entry) * 100) : 0;
  const rr = riskPct > 0 ? r2(rewardPct / riskPct) : 0;

  const stopAtr1h = atr1h && atr1h > 0 ? r2(Math.abs(entry - stop) / atr1h) : null;
  const targetAtr1h = atr1h && atr1h > 0 ? r2(Math.abs(target - entry) / atr1h) : null;

  const entryDistanceRaw =
    Number.isFinite(price) && price > 0 ? ((entry - price) / price) * 100 : 0;
  const entryDistancePct = r4(entryDistanceRaw);
  const entryMode = Math.abs(entryDistanceRaw) <= MARKET_ENTRY_PCT ? 'mercado' : 'límite';

  const entryFeePct = entryMode === 'límite' ? MAKER_ENTRY_FEE_PCT : TAKER_ENTRY_FEE_PCT;
  const exitFeePct = TAKER_EXIT_FEE_PCT;
  const totalFeePct = r4(entryFeePct + exitFeePct);
  const feeShareOfRisk = riskPct > 0 ? r2((totalFeePct / riskPct) * 100) : 0;
  const netRr = riskPct > 0 ? r2((rewardPct - totalFeePct) / (riskPct + totalFeePct)) : 0;

  const size = sizeAtRule({
    capital,
    riskPct: rules.maxRiskPct,
    direction: side,
    entry,
    stop,
    filters: input.filters,
  });

  const levels = Array.isArray(input.levels) ? input.levels : [];
  const betweenEntryAndTarget = levels
    .filter(
      (l) =>
        Number.isFinite(l?.price) &&
        l.price > Math.min(entry, target) &&
        l.price < Math.max(entry, target),
    )
    .map((l) => levelContext(l, entry, atr1h))
    .sort((a, b) => a.distancePctFromEntry - b.distancePctFromEntry);

  const nearStop =
    atr1h && atr1h > 0
      ? levels
          .filter((l) => Number.isFinite(l?.price) && Math.abs(l.price - stop) <= NEAR_STOP_ATR * atr1h)
          .map((l) => levelContext(l, entry, atr1h))
          .sort((a, b) => Math.abs(a.price - stop) - Math.abs(b.price - stop))
      : [];

  const beyond = levels
    .filter((l) => Number.isFinite(l?.price) && (side === 'long' ? l.price < stop : l.price > stop))
    .sort((a, b) => (side === 'long' ? b.price - a.price : a.price - b.price))[0];
  const beyondStop = beyond ? levelContext(beyond, entry, atr1h) : null;

  let targetNearLevel: DrawingLevelContext | null = null;
  let targetNearLevelSide: 'before' | 'after' | null = null;
  if (atr1h && atr1h > 0) {
    let best = Infinity;
    for (const l of levels) {
      if (!Number.isFinite(l?.price)) continue;
      const abs = Math.abs(target - l.price);
      if (abs <= TARGET_NEAR_LEVEL_ATR * atr1h && abs < best) {
        best = abs;
        targetNearLevel = levelContext(l, entry, atr1h);
        // En la dirección de la operación: si el nivel queda más allá del
        // objetivo, el objetivo se alcanza antes ('before').
        targetNearLevelSide = (l.price - target) * dir > 0 ? 'before' : 'after';
      }
    }
  }

  const targetDist = Math.abs(target - entry);
  const targetAtr4h = atr4h && atr4h > 0 ? r2(targetDist / atr4h) : null;
  const targetAtrD = atrD && atrD > 0 ? r2(targetDist / atrD) : null;

  // Rangos típicos (±1 ATR) de levels.ts: el horizonte más pequeño que cubre
  // la distancia al objetivo. Sin ATR de un horizonte, ese horizonte se omite.
  const ranges = expectedRange({ price: entry, atr1h, atr4h, atrD });
  const rangeAtr = new Map<string, number>(ranges.map((row) => [row.id, row.atr]));
  let smallestHorizon: '1h' | '4h' | '24h' | null = null;
  for (const horizon of ['1h', '4h', '24h'] as const) {
    const atr = rangeAtr.get(horizon);
    if (atr && targetDist <= atr) {
      smallestHorizon = horizon;
      break;
    }
  }

  const fundingRatePct8h =
    input.fundingRatePct8h !== null &&
    input.fundingRatePct8h !== undefined &&
    Number.isFinite(input.fundingRatePct8h)
      ? input.fundingRatePct8h
      : null;
  const sidePays =
    fundingRatePct8h !== null ? (side === 'long' ? fundingRatePct8h > 0 : fundingRatePct8h < 0) : false;
  // Coste por 8 h como % del riesgo: (tipo % / riesgo %) * 100.
  const pctOfRiskPer8h =
    fundingRatePct8h !== null && riskPct > 0 ? r2(((dir * fundingRatePct8h) / riskPct) * 100) : null;

  const maxLeverageBreached = size.minLeverage > rules.maxLeverage;
  const dailyLossBreached = size.lossUsd > rules.dailyLossUsd;
  const stopWiderThanDaily = !!atrD && atrD > 0 && Math.abs(entry - stop) > atrD;

  const checks: DrawingCheck[] = [];
  const push = (code: string, severity: 'info' | 'warn', text: string) => {
    if (checks.length >= MAX_CHECKS) return;
    checks.push({ code, severity, text: truncate(text, 90) });
  };

  if (feeShareOfRisk > FEE_SHARE_WARN_PCT) {
    push('fees_eat_risk', 'warn', `las comisiones se comen ${fmt(feeShareOfRisk, 0)} % del riesgo`);
  }
  if (riskPct < TINY_STOP_PCT) {
    push('tiny_stop', 'warn', 'stop menor a 0,3 %: en nuestra medición, los costes se comen esos stops');
  }
  if (nearStop.length > 0) {
    push('stop_near_level', 'warn', 'stop pegado a un nivel visible: muchos traders ponen stops ahí');
  }
  if (targetNearLevel) {
    const where = targetNearLevelSide === 'before' ? 'justo antes' : 'justo después';
    push('target_near_level', 'info', `el objetivo queda ${where} de un nivel`);
  }
  if (targetAtr4h !== null) {
    push('target_vs_4h', 'info', `el objetivo pide ${fmt(targetAtr4h)} veces el rango típico de 4 h`);
  }
  if (maxLeverageBreached) {
    push(
      'leverage_breach',
      'warn',
      `el tamaño exige ${size.minLeverage}x de apalancamiento: más que tu máximo (${rules.maxLeverage}x)`,
    );
  }
  if (dailyLossBreached) {
    push('daily_loss_breach', 'warn', 'el tamaño arriesga más USD que tu pérdida diaria máxima');
  }
  if (stopWiderThanDaily) {
    push('stop_wide', 'warn', 'el stop es más ancho que el rango típico de 24 h');
  }

  const sideLabel = side === 'long' ? 'Largo' : 'Corto';
  const crossed =
    betweenEntryAndTarget.length > 0
      ? `cruza ${betweenEntryAndTarget.length} ${betweenEntryAndTarget.length === 1 ? 'nivel' : 'niveles'}`
      : 'sin niveles en el camino';
  const parts = [
    `${sideLabel} · R:R ${fmt(rr)} (${fmt(netRr)} neto)`,
    `stop ${fmt(riskPct)} %${stopAtr1h !== null ? ` = ${fmt(stopAtr1h)} ATR` : ''}`,
    crossed,
  ];
  const summary = truncate(parts.join(' · '), 110);

  return {
    drawing,
    symbol: drawing.symbol,
    side,
    geometry: { riskPct, rewardPct, rr, stopAtr1h, targetAtr1h, entryDistancePct, entryMode },
    costs: { entryFeePct, exitFeePct, totalFeePct, feeShareOfRisk, netRr },
    size,
    levels: { betweenEntryAndTarget, nearStop, beyondStop, targetNearLevel, targetNearLevelSide },
    reach: { targetAtr4h, targetAtrD, smallestHorizon },
    funding: {
      ratePct8h: fundingRatePct8h !== null ? r4(fundingRatePct8h) : null,
      pctOfRiskPer8h,
      sidePays,
    },
    rules: { maxLeverageBreached, dailyLossBreached, stopWiderThanDaily },
    checks,
    summary,
  };
}
