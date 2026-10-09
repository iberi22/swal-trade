// Builds a proposed order. This module never calls the network and never sends an order.
// Liquidation distance matches synapse-core sizing.rs: liquidation at 100/leverage percent,
// and a safe stop is 80% of that distance (SAFE_SL_LIQUIDATION_FACTOR).

import type { ProposalLimits } from "./config.js";
import { normalizeSymbol } from "./symbol.js";

export const SAFE_SL_LIQUIDATION_FACTOR = 0.8;
export const PLACEMENT_NOTE = "Order placement tools are disabled in this build. Nothing was sent.";

export const ORDER_SIDES = ["BUY", "SELL", "LONG", "SHORT"] as const;
export type OrderSideInput = (typeof ORDER_SIDES)[number];
export type ExchangeSide = "BUY" | "SELL";

export interface ProposalInput {
  symbol: string;
  side: string;
  notionalUsd: number;
  stopLossPct: number;
  leverage: number;
  markPrice: number;
  limits: ProposalLimits;
}

export interface Proposal {
  symbol: string;
  side: ExchangeSide;
  orderType: "MARKET";
  quantity: number;
  notionalUsd: number;
  markPrice: number;
  leverage: number;
  marginUsd: number;
  stopPrice: number;
  stopLossPct: number;
  stopSide: ExchangeSide;
  stopOrderType: "STOP_MARKET";
  closePosition: true;
  liquidationPct: number;
  safeStopLossPct: number;
  safeFactor: number;
  withinSafeDistance: boolean;
  violations: string[];
  limits: ProposalLimits & { dailyLossEvaluated: false };
  sent: false;
  note: string;
}

export type ProposalResult = { ok: true; proposal: Proposal } | { ok: false; error: string };

export function normalizeSide(side: string): ExchangeSide | null {
  const value = side.trim().toUpperCase();
  if (value === "BUY" || value === "LONG") return "BUY";
  if (value === "SELL" || value === "SHORT") return "SELL";
  return null;
}

function formatNum(value: number): string {
  return Number(value.toFixed(4)).toString();
}

function liquidationViolation(stopLossPct: number, leverage: number, liquidationPct: number, safeStopLossPct: number): string | null {
  if (stopLossPct >= liquidationPct) {
    return `stop is at or beyond the simplified liquidation distance (${formatNum(liquidationPct)}% at ${formatNum(leverage)}x)`;
  }
  if (stopLossPct > safeStopLossPct) {
    return `stop exceeds the safe liquidation distance (${formatNum(safeStopLossPct)}% is 80% of ${formatNum(liquidationPct)}% at ${formatNum(leverage)}x)`;
  }
  return null;
}

export function proposeFromMark(input: ProposalInput): ProposalResult {
  const symbol = normalizeSymbol(input.symbol);
  if (!symbol) return { ok: false, error: "symbol must be 2 to 30 letters or digits." };
  const side = normalizeSide(input.side);
  if (!side) return { ok: false, error: "side must be BUY, SELL, LONG, or SHORT." };
  if (!(Number.isFinite(input.notionalUsd) && input.notionalUsd > 0)) {
    return { ok: false, error: "notional_usd must be a finite number greater than 0." };
  }
  if (!(Number.isFinite(input.stopLossPct) && input.stopLossPct > 0 && input.stopLossPct < 100)) {
    return { ok: false, error: "stop_loss_pct must be a percent greater than 0 and less than 100." };
  }
  if (!(Number.isFinite(input.leverage) && input.leverage >= 1)) {
    return { ok: false, error: "leverage must be a finite number greater than or equal to 1." };
  }
  if (!(Number.isFinite(input.markPrice) && input.markPrice > 0)) {
    return { ok: false, error: "mark price must be a finite number greater than 0." };
  }

  const liquidationPct = 100 / input.leverage;
  const safeStopLossPct = liquidationPct * SAFE_SL_LIQUIDATION_FACTOR;
  const factor = input.stopLossPct / 100;
  const stopPrice = side === "BUY" ? input.markPrice * (1 - factor) : input.markPrice * (1 + factor);
  const violations: string[] = [];
  const distance = liquidationViolation(input.stopLossPct, input.leverage, liquidationPct, safeStopLossPct);
  if (distance) violations.push(distance);
  if (input.limits.maxLeverage != null && input.leverage > input.limits.maxLeverage) {
    violations.push(`leverage ${formatNum(input.leverage)}x exceeds SWAL_MAX_LEVERAGE ${formatNum(input.limits.maxLeverage)}x`);
  }
  if (input.limits.maxNotionalUsd != null && input.notionalUsd > input.limits.maxNotionalUsd) {
    violations.push(
      `notional ${formatNum(input.notionalUsd)} USD exceeds SWAL_MAX_NOTIONAL_USD ${formatNum(input.limits.maxNotionalUsd)}`,
    );
  }

  return {
    ok: true,
    proposal: {
      symbol,
      side,
      orderType: "MARKET",
      quantity: input.notionalUsd / input.markPrice,
      notionalUsd: input.notionalUsd,
      markPrice: input.markPrice,
      leverage: input.leverage,
      marginUsd: input.notionalUsd / input.leverage,
      stopPrice,
      stopLossPct: input.stopLossPct,
      stopSide: side === "BUY" ? "SELL" : "BUY",
      stopOrderType: "STOP_MARKET",
      closePosition: true,
      liquidationPct,
      safeStopLossPct,
      safeFactor: SAFE_SL_LIQUIDATION_FACTOR,
      withinSafeDistance: distance === null,
      violations,
      limits: { ...input.limits, dailyLossEvaluated: false },
      sent: false,
      note: PLACEMENT_NOTE,
    },
  };
}
