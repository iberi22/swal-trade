import type { LevelRow } from '../context/levels';
import type { RulesSettings } from '../settings';
import {
  calculatePositionSizeWithFees,
  defaultScaleEntries,
  floorLossUsdForDisplay,
  floorToDecimals,
  floorToStep,
  formatQuantityPlain,
  planScaleIn,
  roundToDecimals,
  roundToTick,
} from '../sizing';
import type {
  TicketEntry,
  TicketResult,
  TicketTp,
  TicketWarning,
  TradeCardPreset,
  TradeSide,
  TradeTicket,
} from './types';

export const HONEST_R_LINE = 'R:R no es probabilidad: ninguna combinación de stop y objetivo tiene ventaja medida.';
export const CARDS_FOOTER = 'Referencias de tamaño y precio. No abre órdenes: las colocas tú en Binance.';
export const SCALE_IN_SHORT_NOTE = 'Promediar acota el riesgo, no da ventaja.';
/** Comisión estimada: límite en reposo (maker) y stop/mercado (taker). Son estimaciones. */
export const MAKER_FEE_RATE = 0.0002;
export const TAKER_FEE_RATE = 0.0005;
export const FEES_NOTE = 'estimación: límite en reposo 0,02 % maker; stop y mercado 0,05 % taker';
const MIN_STOP_PCT = 0.15;
const FAR_ENTRY_ATR = 3;
const MAX_TPS = 4;
/** Una entrada solo reposa (maker) si está a más de este % del precio, del lado correcto. */
const RESTING_ENTRY_PCT = 0.05;

export interface SymbolFilters {
  tickSize: number;
  stepSize: number;
  minNotional: number;
  minQty: number;
}

export interface BuildTicketInput {
  preset: TradeCardPreset;
  symbol: string;
  price: number;
  levels: readonly LevelRow[];
  atrs: { atr1h: number | null; atr4h?: number | null; atrD?: number | null };
  capital: number;
  rules: RulesSettings;
  filters?: SymbolFilters | null;
  sideOverride?: TradeSide;
  /** Pérdida diaria que te queda según la regla, si se conoce. */
  dailyLossRemainingUsd?: number | null;
}

/** Formato corto con coma decimal para los avisos. */
function fmt(value: number, digits = 2): string {
  return String(roundToDecimals(value, digits)).replace('.', ',');
}

/** Presupuesto en USD para un aviso: recortado, nunca por encima del elegido. */
function fmtUsdBudget(value: number): string {
  return String(floorLossUsdForDisplay(value)).replace('.', ',');
}

/** Formato para el portapapeles: punto decimal, sin separador de miles. */
function plain(value: number): string {
  if (!Number.isFinite(value)) return '-';
  return String(Number(value.toPrecision(10)));
}

const fail = (reason: string): TicketResult => ({ ok: false, reason });

function warn(code: string, text: string): TicketWarning {
  return { code, text: text.length > 90 ? `${text.slice(0, 89)}…` : text };
}

function nearestResting(levels: readonly LevelRow[], price: number, side: TradeSide, kind?: string): LevelRow | null {
  const pool = levels.filter((l) => (side === 'long' ? l.price < price : l.price > price) && (!kind || l.kinds.includes(kind as never)));
  pool.sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));
  return pool[0] ?? null;
}

const TRANCHE_SPLITS: Record<2 | 3 | 4, { depth: number[]; weights: number[] }> = {
  2: { depth: [0.6], weights: [0.35, 0.65] },
  3: { depth: [0.4, 0.8], weights: [0.25, 0.35, 0.4] },
  4: { depth: [0.25, 0.5, 0.75], weights: [0.1, 0.2, 0.3, 0.4] },
};

/** Ticket completo para una tarjeta. Puro: sin red ni DOM. Nunca lanza. */
export function buildTicket(input: BuildTicketInput): TicketResult {
  try {
    return build(input);
  } catch {
    return fail('No se pudo calcular el ticket.');
  }
}

/** Con side 'auto' calcula las dos direcciones; si no, solo la fijada. */
export function buildTicketSides(input: Omit<BuildTicketInput, 'sideOverride'>): Array<{ side: TradeSide; result: TicketResult }> {
  const sides: TradeSide[] = input.preset.side === 'auto' ? ['long', 'short'] : [input.preset.side];
  return sides.map((side) => ({ side, result: buildTicket({ ...input, sideOverride: side }) }));
}

function build(input: BuildTicketInput): TicketResult {
  const { preset, symbol, price, levels, atrs, capital, rules } = input;
  const filters = input.filters ?? null;
  if (!(price > 0) || !(capital > 0)) return fail('Faltan precio o capital.');
  if (preset.entry.kind === 'limit_level' && levels.length === 0) return fail('Sin niveles todavía');
  const side: TradeSide = input.sideOverride ?? (preset.side === 'auto' ? 'long' : preset.side);
  const long = side === 'long';
  const tick = filters?.tickSize;
  const atr = atrs.atr1h && atrs.atr1h > 0 ? atrs.atr1h : null;
  const round = (p: number) => roundToTick(p, tick);

  /* Entrada */
  let entry1 = price;
  let entryLabel = 'precio actual';
  if (preset.entry.kind === 'limit_level') {
    const level = nearestResting(levels, price, side, preset.entry.pick === 'level_kind' ? preset.entry.levelKind : undefined);
    if (!level) return fail(long ? 'No hay nivel por debajo del precio.' : 'No hay nivel por encima del precio.');
    const offset = atr && preset.entry.offsetAtr ? preset.entry.offsetAtr * atr : 0;
    entry1 = level.price + (long ? -offset : offset);
    entryLabel = level.label;
  }
  entry1 = round(entry1);

  /* Stop */
  let stop: number;
  let stopSource: TradeTicket['stopSource'] = preset.stop.kind;
  const atrStop = (): number | null => (atr ? entry1 + (long ? -1 : 1) * (preset.stop.atrMult ?? 1.5) * atr : null);
  if (preset.stop.kind === 'pct') {
    stop = entry1 * (1 + (long ? -1 : 1) * ((preset.stop.pct ?? 1) / 100));
  } else if (preset.stop.kind === 'invalidation') {
    const inv = levels
      .filter((l) => l.kinds.includes('invalidate') && (long ? l.price < entry1 : l.price > entry1))
      .sort((a, b) => Math.abs(a.price - entry1) - Math.abs(b.price - entry1))[0];
    if (inv) stop = inv.price;
    else {
      const s = atr ? entry1 + (long ? -1 : 1) * 1.5 * atr : null;
      if (s === null) return fail('Sin invalidación ni ATR para el stop.');
      stop = s;
      stopSource = 'atr';
    }
  } else {
    const s = atrStop();
    if (s === null) return fail('Sin ATR para calcular el stop.');
    stop = s;
  }
  stop = round(stop);
  if (!(stop > 0) || (long ? stop >= entry1 : stop <= entry1)) return fail('El stop queda del lado equivocado de la entrada.');

  /* Tamaño */
  const marketOnly = preset.entry.kind === 'market' && !preset.scaleIn;
  // Maker solo si la entrada reposa del lado correcto del precio (> 0,05 %).
  // Si el redondeo la deja en el otro lado, al enviarla cruzaría: taker (stop).
  const entryDistancePct = price > 0 ? ((entry1 - price) / price) * 100 : 0;
  const entryRests = long ? entryDistancePct < -RESTING_ENTRY_PCT : entryDistancePct > RESTING_ENTRY_PCT;
  const entryIsTaker = marketOnly || !entryRests;
  const entryFeeRate = entryIsTaker ? TAKER_FEE_RATE : MAKER_FEE_RATE;
  const feeRate = entryFeeRate + TAKER_FEE_RATE;
  const budgetRule = capital * (rules.maxRiskPct / 100);
  const direction = side;
  const tranchesN = preset.scaleIn?.tranches;
  const filterOpts = filters
    ? { tickSize: filters.tickSize, stepSize: filters.stepSize, minQty: filters.minQty, minNotional: filters.minNotional }
    : {};
  const warnings: TicketWarning[] = [];

  let entries: TicketEntry[] = [];
  let leverage: number;
  let degradedNote = false;

  // Precios de los tramos: el primero es la entrada; el resto, a fracciones de la distancia al stop.
  let prices: number[] = [entry1];
  let weights: number[] = [1];
  if (tranchesN) {
    const split = TRANCHE_SPLITS[tranchesN];
    const depths = tranchesN === 3
      ? (() => {
          const d = defaultScaleEntries({ direction, entry: entry1, stop, tickSize: tick });
          return d ? [d.entry2, d.entry3] : null;
        })()
      : split.depth.map((f) => round(entry1 + f * (stop - entry1)));
    if (!depths) return fail('No se pueden repartir los tramos con este stop.');
    prices = [entry1, ...depths];
    weights = split.weights;
    const ordered = prices.every((p, i) => i === 0 || (long ? p < (prices[i - 1] as number) && p > stop : p > (prices[i - 1] as number) && p < stop));
    if (!ordered) return fail('Los tramos no caben entre la entrada y el stop.');
  }

  if (preset.size.basis === 'risk') {
    if (!tranchesN) {
      const sized = calculatePositionSizeWithFees({
        capital, riskPct: preset.size.pct, direction, entry: entry1, stop,
        entryFeeRate, exitFeeRate: TAKER_FEE_RATE,
      });
      if (!sized.valid) return fail(sized.error);
      const qty = floorToStep(sized.quantity, filters?.stepSize);
      entries = [{ price: entry1, qty, weightPct: 100 }];
      leverage = preset.leverage === 'min' ? Math.min(sized.minLeverage, Math.max(1, Math.floor(rules.maxLeverage))) : preset.leverage;
    } else if (tranchesN === 3) {
      const plan = planScaleIn({
        capital, riskPct: preset.size.pct, direction,
        entry1: prices[0] as number, entry2: prices[1] as number, entry3: prices[2] as number,
        stop, feeRate, ...filterOpts,
      });
      if (!plan.valid) return fail(plan.error);
      degradedNote = plan.degraded;
      entries = plan.tranches.map((t, i) => ({ price: t.price, qty: t.qty, weightPct: Math.round((plan.weights[i] as number) * 100) }));
      leverage = preset.leverage === 'min' ? Math.min(plan.minLeverage, Math.max(1, Math.floor(rules.maxLeverage))) : preset.leverage;
    } else {
      const avg = prices.reduce((s, p, i) => s + (weights[i] as number) * p, 0);
      const riskMax = capital * (preset.size.pct / 100);
      const qTotal = riskMax / (Math.abs(stop - avg) + avg * entryFeeRate + stop * TAKER_FEE_RATE);
      entries = prices.map((p, i) => ({ price: p, qty: floorToStep((weights[i] as number) * qTotal, filters?.stepSize), weightPct: Math.round((weights[i] as number) * 100) }));
      const notional = entries.reduce((s, e) => s + e.qty * e.price, 0);
      leverage = preset.leverage === 'min' ? Math.min(Math.max(1, Math.ceil(notional / capital)), Math.max(1, Math.floor(rules.maxLeverage))) : preset.leverage;
    }
  } else {
    const marginUsd = capital * (preset.size.pct / 100);
    // Pérdida en el stop por unidad de nocional, comisiones incluidas.
    const lossPerNotional = prices.reduce(
      (s, p, i) => s + (weights[i] as number) * ((Math.abs(p - stop) + p * entryFeeRate + stop * TAKER_FEE_RATE) / p),
      0,
    );
    if (preset.leverage === 'min') {
      // Con margen fijo, 'min' = el mayor apalancamiento (hasta tu máximo) cuya pérdida en el stop cabe en tu regla.
      const fit = Math.floor(budgetRule / (marginUsd * lossPerNotional) + 1e-9);
      leverage = Math.min(Math.max(1, Math.floor(rules.maxLeverage)), Math.max(1, fit));
    } else {
      leverage = preset.leverage;
    }
    const notional = marginUsd * leverage;
    entries = prices.map((p, i) => ({
      price: p,
      qty: floorToStep(((weights[i] as number) * notional) / p, filters?.stepSize),
      weightPct: Math.round((weights[i] as number) * 100),
    }));
  }

  const totalQty = entries.reduce((s, e) => s + e.qty, 0);
  if (!(totalQty > 0)) return fail('La cantidad queda por debajo del mínimo del par.');
  const notionalRaw = entries.reduce((s, e) => s + e.qty * e.price, 0);
  const avgEntry = notionalRaw / totalQty;
  const priceLoss = entries.reduce((s, e) => s + e.qty * Math.abs(e.price - stop), 0);
  const entryFeeUsd = entries.reduce((s, e) => s + e.qty * e.price * entryFeeRate, 0);
  const exitFeeUsd = totalQty * stop * TAKER_FEE_RATE;
  const feeUsd = roundToDecimals(entryFeeUsd + exitFeeUsd, 2);
  // La pérdida se enseña recortada hacia abajo: redondearla al céntimo más
  // cercano podía mostrar más de lo que realmente cuesta el stop.
  const lossAtStopUsd = floorLossUsdForDisplay(priceLoss + entryFeeUsd + exitFeeUsd);
  const lossIncludesFees = true;
  // Exacto para las reglas; recortado (nunca hacia arriba) para enseñarlo.
  const exactLossPct = (lossAtStopUsd / capital) * 100;
  const lossPct = floorToDecimals(exactLossPct, 2);
  const notionalUsd = roundToDecimals(notionalRaw, 2);
  const marginUsd = roundToDecimals(notionalRaw / leverage, 2);
  const weightsOut = entries.map((e) => ({ ...e, weightPct: Math.round(((e.qty * e.price) / notionalRaw) * 100) }));

  /* Objetivos: solo múltiplos de R, nunca una probabilidad. */
  const unit = Math.abs(avgEntry - stop);
  const dirSign = long ? 1 : -1;
  const tps: TicketTp[] = [];
  const rs = [...preset.tp.rMultiples].filter((r) => Number.isFinite(r) && r > 0).sort((a, b) => a - b);
  for (const r of rs) {
    const p = round(avgEntry + dirSign * r * unit);
    tps.push({ price: p, rMultiple: roundToDecimals(Math.abs(p - avgEntry) / unit, 2), source: 'r' });
  }
  if (preset.tp.useNextLevel) {
    const next = levels
      .filter((l) => (long ? l.price > avgEntry : l.price < avgEntry) && Math.abs(l.price - avgEntry) / unit > 1)
      .sort((a, b) => Math.abs(a.price - avgEntry) - Math.abs(b.price - avgEntry))[0];
    if (next) {
      const r = roundToDecimals(Math.abs(next.price - avgEntry) / unit, 2);
      if (!tps.some((t) => Math.abs(t.rMultiple - r) < 0.05)) {
        tps.push({ price: round(next.price), rMultiple: r, source: 'level', label: next.label });
      }
    }
  }
  tps.sort((a, b) => (long ? a.price - b.price : b.price - a.price));
  tps.splice(MAX_TPS);

  /* Avisos (texto llano, sin lenguaje de compra/venta). */
  if (exactLossPct > rules.maxRiskPct + 1e-9) {
    warnings.push(warn('risk_above_rule', `supera tu regla de riesgo (${fmt(rules.maxRiskPct)} %)`));
  }
  if (leverage > rules.maxLeverage) {
    warnings.push(warn('leverage_above_rule', `apalancamiento ${leverage}× por encima de tu regla (${fmt(rules.maxLeverage, 0)}×)`));
  }
  if (marginUsd > capital) warnings.push(warn('margin_over_capital', 'el margen necesario supera tu capital'));
  const dailyLeft = input.dailyLossRemainingUsd ?? (rules.dailyLossUsd > 0 ? rules.dailyLossUsd : null);
  if (dailyLeft !== null && lossAtStopUsd > dailyLeft) {
    warnings.push(warn('daily_loss', `la pérdida en el stop supera tu límite diario (${fmtUsdBudget(dailyLeft)} USD)`));
  }
  const stopPct = (unit / avgEntry) * 100;
  if (stopPct < MIN_STOP_PCT) {
    warnings.push(warn('stop_too_close', `stop a ${fmt(stopPct)} % del precio: el coste ya se come el stop`));
  }
  if (preset.entry.kind === 'limit_level' && atr && Math.abs(entry1 - price) > FAR_ENTRY_ATR * atr) {
    warnings.push(warn('entry_far', `entrada a ${fmt(Math.abs(entry1 - price) / atr, 1)} ATR(1h): el precio puede no llegar`));
  }
  if (degradedNote) warnings.push(warn('scale_degraded', 'tramos reducidos a 2 por el mínimo del par'));
  if (preset.entry.kind === 'limit_level' && !entryRests) {
    warnings.push(
      warn(
        'entry_stop',
        long
          ? 'la entrada redondeada queda por encima del precio: sería una orden stop (comisión taker)'
          : 'la entrada redondeada queda por debajo del precio: sería una orden stop (comisión taker)',
      ),
    );
  }
  if (!filters) {
    warnings.push(warn('no_filters', 'redondea a los pasos del par'));
  } else if (entries.some((e) => e.qty < filters.minQty || e.qty * e.price < filters.minNotional)) {
    warnings.push(warn('below_min', 'por debajo del mínimo del par'));
  }

  const ticket: TradeTicket = {
    presetName: preset.name,
    symbol,
    side,
    orderType: marketOnly ? 'MARKET' : 'LIMIT',
    entries: weightsOut,
    entryLabel,
    avgEntry: roundToDecimals(avgEntry, 8),
    stop,
    stopSource,
    tps,
    leverage,
    marginUsd,
    notionalUsd,
    lossAtStopUsd,
    lossIncludesFees,
    lossAtStopPctOfCapital: lossPct,
    highRisk: exactLossPct > 2,
    feeUsd,
    fees: {
      makerRate: MAKER_FEE_RATE,
      takerRate: TAKER_FEE_RATE,
      entryRate: entryFeeRate,
      exitRate: TAKER_FEE_RATE,
      note: FEES_NOTE,
    },
    rrToFirstTp: tps[0]?.rMultiple ?? null,
    warnings,
    basis: { basis: preset.size.basis, pct: preset.size.pct },
    capital,
    scaleInNote: tranchesN ? SCALE_IN_SHORT_NOTE : undefined,
  };
  return { ok: true, ticket };
}

/** Texto llano del ticket para el portapapeles. Incluye siempre la línea honesta. */
export function formatTicketText(t: TradeTicket): string {
  const dir = t.side === 'long' ? 'Largo' : 'Corto';
  const lines: string[] = [
    `TICKET · ${t.presetName}`,
    `Par: ${t.symbol} · ${dir} · ${t.orderType === 'LIMIT' ? 'Límite' : 'Mercado'} (${t.orderType})`,
  ];
  t.entries.forEach((e, i) => {
    lines.push(`Entrada ${t.entries.length > 1 ? i + 1 : ''}`.trim() + `: precio ${plain(e.price)} · cantidad ${formatQuantityPlain(e.qty)} (${e.weightPct} %)`);
  });
  if (t.entries.length > 1) lines.push(`Entrada media: ${plain(t.avgEntry)}`);
  lines.push(`Stop: ${plain(t.stop)} (${t.stopSource === 'invalidation' ? 'invalidación' : t.stopSource === 'atr' ? 'ATR' : '%'})`);
  t.tps.forEach((tp, i) => lines.push(`Objetivo ${i + 1}: ${plain(tp.price)} (${plain(tp.rMultiple)}R${tp.label ? ` · ${tp.label}` : ''})`));
  lines.push(`Apalancamiento: ${t.leverage}× · Margen: ${plain(t.marginUsd)} USD · Nocional: ${plain(t.notionalUsd)} USD`);
  lines.push(
    `Pérdida en el stop: ${String(t.lossAtStopUsd)} USD (${plain(t.lossAtStopPctOfCapital)} % de la cuenta${t.lossIncludesFees ? ', con comisiones' : ''})`,
  );
  lines.push(`Comisiones: ~${plain(t.feeUsd)} USD (${t.fees.note})`);
  if (t.scaleInNote) lines.push(t.scaleInNote);
  if (t.warnings.length > 0) {
    lines.push('Avisos:');
    for (const w of t.warnings) lines.push(`- ${w.text}`);
  }
  lines.push(HONEST_R_LINE, CARDS_FOOTER);
  return lines.join('\n');
}

