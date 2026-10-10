// The exchange's own liquidation estimate, instead of the textbook 100 / leverage.
//
// The order guard keeps its simplified check (80% of 100/leverage), which is the
// Rust rule, but before an entry is sent the write path asks the exchange where
// this symbol would actually be liquidated: the liquidationPrice of an existing
// position in positionRisk (after the leverage is set), or the maintenance
// margin ratio of /fapi/v1/leverageBracket for a fresh one. A stop that is not
// inside that estimate with a cushion is a stop that fires in the same second as
// the liquidation, so the entry is refused.

import { isRecord } from "./types.js";

/** The same 80% factor the guard and propose_order use. */
export const SAFE_STOP_LIQUIDATION_FACTOR = 0.8;

export interface LiquidationEstimate {
  /** Where the exchange says (or computes) this position would be liquidated. */
  price: number | null;
  /** Distance from the entry, in percent. */
  distancePct: number | null;
  source: "positionRisk" | "leverageBracket" | "simplified" | null;
  /** Maintenance margin ratio read from the bracket, when there was one. */
  maintenanceMarginRatio: number | null;
  /** Set when only the simplified check could be applied. */
  note: string | null;
}

/** Isolated-margin drop to liquidation: (1/lev - mmr) / (1 - mmr). */
export function liquidationFraction(leverage: number, maintenanceMarginRatio: number | null): number | null {
  if (!(Number.isFinite(leverage) && leverage >= 1)) return null;
  const mmr = maintenanceMarginRatio == null ? 0 : maintenanceMarginRatio;
  if (!(mmr >= 0) || mmr >= 1) return null;
  return (1 / leverage - mmr) / (1 - mmr);
}

/** Pulls the maintenance margin ratio of the first bracket of one symbol. */
export function parseLeverageBracket(body: unknown, symbol: string): number | null {
  if (!Array.isArray(body)) return null;
  for (const raw of body) {
    if (!isRecord(raw) || raw.symbol !== symbol) continue;
    const brackets = raw.brackets;
    if (!Array.isArray(brackets)) continue;
    for (const bracket of brackets) {
      if (!isRecord(bracket)) continue;
      const raw2 = bracket.maintMarginRatio;
      const ratio = typeof raw2 === "string" || typeof raw2 === "number" ? Number(raw2) : Number.NaN;
      if (Number.isFinite(ratio) && ratio >= 0 && ratio < 1) return ratio;
    }
  }
  return null;
}

export interface LiquidationInput {
  /** positionRisk rows, when there was an existing position to read. */
  positionRisk: unknown;
  leverageBracket: unknown;
  symbol: string;
  side: "BUY" | "SELL";
  /** Reference price the stop was computed from (entry or the worst level). */
  referencePrice: number;
  leverage: number;
}

/**
 * Best available liquidation estimate for a position that is about to be open.
 * The real liquidationPrice of an existing position wins; otherwise the
 * maintenance margin ratio of the bracket gives the estimate.
 */
export function readLiquidationEstimate(input: LiquidationInput): LiquidationEstimate {
  const mmr = parseLeverageBracket(input.leverageBracket, input.symbol);
  if (Array.isArray(input.positionRisk)) {
    let best: number | null = null;
    for (const raw of input.positionRisk) {
      if (!isRecord(raw) || raw.symbol !== input.symbol) continue;
      const amt = Number(raw.positionAmt);
      if (!Number.isFinite(amt) || amt === 0) continue;
      const price = Number(raw.liquidationPrice);
      if (!Number.isFinite(price) || price <= 0) continue;
      // The row closest to the entry is the most binding one.
      if (best == null || Math.abs(price - input.referencePrice) < Math.abs(best - input.referencePrice)) best = price;
    }
    if (best != null) {
      const distancePct = (Math.abs(input.referencePrice - best) / input.referencePrice) * 100;
      return { price: best, distancePct, source: "positionRisk", maintenanceMarginRatio: mmr, note: null };
    }
  }
  const fraction = liquidationFraction(input.leverage, mmr);
  if (fraction == null || !(fraction > 0)) {
    return {
      price: null,
      distancePct: null,
      source: "simplified",
      maintenanceMarginRatio: mmr,
      note: "the exchange liquidation estimate is not usable, so only the simplified 100/leverage check applies",
    };
  }
  const price = input.side === "BUY" ? input.referencePrice * (1 - fraction) : input.referencePrice * (1 + fraction);
  return { price, distancePct: fraction * 100, source: "leverageBracket", maintenanceMarginRatio: mmr, note: null };
}

export interface StopInsideLiquidation {
  ok: boolean;
  reason: string | null;
}

/**
 * Requires the stop to sit inside the liquidation estimate with a cushion: a
 * stop at or beyond liquidation never triggers, the position is liquidated
 * first and the whole stop-loss was decoration.
 */
export function stopInsideLiquidation(input: {
  side: "BUY" | "SELL";
  entryPrice: number;
  stopPrice: number;
  estimate: LiquidationEstimate;
  factor?: number;
}): StopInsideLiquidation {
  const factor = input.factor ?? SAFE_STOP_LIQUIDATION_FACTOR;
  const estimate = input.estimate;
  if (estimate.price == null || estimate.distancePct == null || !(estimate.distancePct > 0)) {
    return { ok: true, reason: null };
  }
  if (!(input.entryPrice > 0) || !(input.stopPrice > 0)) return { ok: false, reason: "the entry or the stop price is not usable" };
  const onLossSide = input.side === "BUY" ? input.stopPrice < input.entryPrice : input.stopPrice > input.entryPrice;
  const onLossSideOfEstimate =
    input.side === "BUY" ? input.estimate.price! < input.entryPrice : input.estimate.price! > input.entryPrice;
  if (!onLossSide) {
    return { ok: false, reason: `the stop at ${input.stopPrice} is not on the loss side of the entry ${input.entryPrice}.` };
  }
  if (!onLossSideOfEstimate) {
    return { ok: false, reason: `the liquidation estimate ${input.estimate.price} is not on the loss side of the entry ${input.entryPrice}.` };
  }
  const distance = Math.abs(input.entryPrice - input.stopPrice);
  const toLiquidation = Math.abs(input.entryPrice - estimate.price);
  const cushion = toLiquidation - distance;
  if (cushion < factor * toLiquidation) {
    return {
      ok: false,
      reason: `the stop at ${input.stopPrice} is ${distance.toFixed(4)} USD from the entry ${input.entryPrice}, but the exchange liquidation estimate (${estimate.source}) is only ${toLiquidation.toFixed(4)} USD away: the stop would not fire before the liquidation, tighten it`,
    };
  }
  return { ok: true, reason: null };
}

export interface LiquidationClient {
  positionRisk: () => Promise<unknown>;
  leverageBracket: (symbol: string) => Promise<unknown>;
}

/**
 * Reads positionRisk and the leverage bracket, tolerating a read failure.
 *
 * A read that fails returns null for that source, not a throw: an estimate that
 * cannot be read degrades to the simplified check, which the guard applies
 * anyway. Throwing here would refuse an entry for a reason that has nothing to
 * do with the order.
 */
export async function fetchLiquidationInputs(
  client: LiquidationClient,
  input: { symbol: string; side: "BUY" | "SELL"; referencePrice: number; leverage: number },
): Promise<LiquidationInput> {
  const read = async (fn: () => Promise<unknown>): Promise<unknown> => {
    try {
      return await fn();
    } catch {
      return null;
    }
  };
  const [positionRisk, leverageBracket] = await Promise.all([read(() => client.positionRisk()), read(() => client.leverageBracket(input.symbol))]);
  return { positionRisk, leverageBracket, symbol: input.symbol, side: input.side, referencePrice: input.referencePrice, leverage: input.leverage };
}
