// Order guard for the MCP write tools.
//
// Pure: no network, no clock, no environment. It is the last barrier before an
// order is signed, and it is the TypeScript port of the rules in
// crates/synapse-core/src/order_guard.rs (`check_order`) together with the daily
// kill switch of crates/synapse-core/src/risk.rs (`RiskEngine::check_trade`).
//
// The inputs are the ones the MCP actually receives: a notional in USD, a stop
// in percent of the reference price, and a side. Two properties are copied from
// the Rust version on purpose:
//
//   1. Every rule is evaluated and the reasons are accumulated, so the caller
//      sees everything that is wrong at once instead of one error per round trip.
//   2. It fails closed. A non-finite number, a missing cap, an empty whitelist or
//      an unreadable daily PnL is a rejection, never a "no limit" reading: with
//      NaN every comparison is false and an unguarded order would sail through.

export const SAFE_SL_LIQUIDATION_FACTOR = 0.8;
export const REQUIRE_STOP_LOSS = true;

export type GuardSide = "BUY" | "SELL";
export type GuardOrderType = "market" | "post_only";

export interface GuardLimits {
  symbols: readonly string[];
  maxNotionalUsd: number;
  maxLeverage: number;
  maxOpenPositions: number;
  dailyLossUsd: number;
}

export interface GuardAccount {
  dayPnl: number;
  openPositions: number;
  unprotectedSymbols: readonly string[];
  /** USD already committed: positions plus resting entry orders. */
  openNotionalUsd?: number;
  /** Symbols with resting entry orders, for the refusal message. */
  pendingSymbols?: readonly string[];
}

export interface GuardInput {
  symbol: string;
  side: GuardSide;
  notionalUsd: number;
  stopLossPct: number;
  takeProfitPct?: number | null;
  leverage: number;
  orderType?: GuardOrderType;
}

export type GuardDecision = { allow: true; reasons: [] } | { allow: false; reasons: string[] };

const fmt = (value: number): string => (Number.isFinite(value) ? String(Number(value.toFixed(8))) : String(value));

const isPositive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** Rule: the symbol has to be in the user's whitelist. An empty whitelist allows nothing. */
export function symbolReason(symbol: string, whitelist: readonly string[]): string | null {
  if (whitelist.length === 0) {
    return "SWAL_MCP_SYMBOLS is empty: no symbol is whitelisted, so no order can be placed.";
  }
  if (!whitelist.includes(symbol)) {
    return `symbol ${symbol} is not in the SWAL_MCP_SYMBOLS whitelist (allowed: ${whitelist.join(", ")}).`;
  }
  return null;
}

/**
 * Rule: the stop is mandatory and its distance has to be inside the safe
 * liquidation distance, the same 80% factor that `propose_order` reports.
 */
export function stopReason(stopLossPct: number, leverage: number): string | null {
  if (!(Number.isFinite(stopLossPct) && stopLossPct > 0 && stopLossPct < 100)) {
    return "a stop is mandatory: stop_loss_pct must be a finite percent greater than 0 and less than 100.";
  }
  const liquidationPct = 100 / leverage;
  if (stopLossPct >= liquidationPct) {
    return `stop distance ${fmt(stopLossPct)}% is at or beyond the simplified liquidation distance (${fmt(liquidationPct)}% at ${fmt(leverage)}x).`;
  }
  const safePct = liquidationPct * SAFE_SL_LIQUIDATION_FACTOR;
  if (stopLossPct > safePct) {
    return `stop distance ${fmt(stopLossPct)}% exceeds the safe liquidation distance (${fmt(safePct)}% is 80% of ${fmt(liquidationPct)}% at ${fmt(leverage)}x).`;
  }
  return null;
}

export function takeProfitReason(takeProfitPct: number | null | undefined): string | null {
  if (takeProfitPct == null) return null;
  if (!(Number.isFinite(takeProfitPct) && takeProfitPct > 0 && takeProfitPct < 1000)) {
    return "take_profit_pct must be a finite percent greater than 0, or unset.";
  }
  return null;
}

export function notionalReason(notionalUsd: number, maxNotionalUsd: number): string | null {
  if (!isPositive(notionalUsd)) return "notional_usd must be a finite number greater than 0.";
  if (!isPositive(maxNotionalUsd)) {
    return "SWAL_MAX_NOTIONAL_USD is not a usable positive limit, so the guard refuses the order instead of trading without a cap.";
  }
  if (notionalUsd > maxNotionalUsd) {
    return `notional ${fmt(notionalUsd)} USD exceeds SWAL_MAX_NOTIONAL_USD ${fmt(maxNotionalUsd)} USD.`;
  }
  return null;
}

/**
 * Rule: the cap is on exposure, not on the size of this one order. Positions
 * already open and resting entry orders that have not filled yet are both money
 * the account has committed, so the new notional is added to them.
 */
export function exposureReason(input: { openNotionalUsd: number; newNotionalUsd: number; maxNotionalUsd: number }): string | null {
  if (!isPositive(input.maxNotionalUsd)) return null; // notionalReason already refuses this
  const open = Number.isFinite(input.openNotionalUsd) && input.openNotionalUsd > 0 ? input.openNotionalUsd : 0;
  if (open === 0) return null;
  const total = open + input.newNotionalUsd;
  if (total <= input.maxNotionalUsd) return null;
  return `the account already has ${fmt(open)} USD committed (open positions plus resting open orders) and this order adds ${fmt(input.newNotionalUsd)} USD, ${fmt(total)} USD in total, which exceeds SWAL_MAX_NOTIONAL_USD ${fmt(input.maxNotionalUsd)} USD.`;
}

export function leverageReason(leverage: number, maxLeverage: number): string | null {
  if (!Number.isInteger(leverage) || leverage < 1) {
    return `leverage must be an integer greater than or equal to 1 (received ${fmt(leverage)}); the exchange has no fractional leverage.`;
  }
  if (!Number.isInteger(maxLeverage) || maxLeverage < 1) {
    return "SWAL_MAX_LEVERAGE is not a usable positive integer, so the guard refuses the order instead of trading without a cap.";
  }
  if (leverage > maxLeverage) return `leverage ${leverage}x exceeds SWAL_MAX_LEVERAGE ${maxLeverage}x.`;
  return null;
}

/** Rule: the daily-loss lock refuses every new order once today's PnL hits it. */
export function dailyLockReason(dayPnl: number, dailyLossUsd: number): string | null {
  if (!Number.isFinite(dayPnl)) {
    return "today's PnL could not be read as a finite number, so the daily-loss lock cannot be cleared: refusing a new position.";
  }
  if (!isPositive(dailyLossUsd)) {
    return "SWAL_DAILY_LOSS_USD is not a usable positive limit, so the daily-loss lock cannot be evaluated: refusing a new position.";
  }
  if (dayPnl <= -dailyLossUsd) {
    return `daily-loss lock: today's PnL is ${fmt(dayPnl)} USD, at or beyond the SWAL_DAILY_LOSS_USD limit of ${fmt(dailyLossUsd)} USD. No new orders today.`;
  }
  return null;
}

export function openPositionsReason(openPositions: number, maxOpenPositions: number, pendingSymbols: readonly string[] = []): string | null {
  if (!Number.isInteger(openPositions) || openPositions < 0) {
    return `the open position count is not usable (${fmt(openPositions)}).`;
  }
  if (!Number.isInteger(maxOpenPositions) || maxOpenPositions < 1) {
    return "SWAL_MCP_MAX_POSITIONS is not a usable positive integer, so the guard refuses the order instead of raising exposure without a cap.";
  }
  if (openPositions >= maxOpenPositions) {
    const pending = pendingSymbols.length > 0 ? ` including resting open orders on ${pendingSymbols.join(", ")}` : "";
    return `max open positions reached: ${openPositions} open${pending}, SWAL_MCP_MAX_POSITIONS is ${maxOpenPositions}.`;
  }
  return null;
}

/** Guardian rule: never add exposure while another position has no stop. */
export function unprotectedReasons(symbols: readonly string[]): string[] {
  return symbols.map((symbol) => `open position ${symbol} has no STOP_MARKET algo order on the exchange: refuse to add exposure until it is protected.`);
}

/**
 * Full check. Reasons are accumulated and ordered by rule, matching
 * `order_guard::check_order`.
 */
export function checkOrder(input: GuardInput, limits: GuardLimits, account: GuardAccount): GuardDecision {
  const reasons: string[] = [];
  const symbol = symbolReason(input.symbol, limits.symbols);
  if (symbol) reasons.push(symbol);
  const notional = notionalReason(input.notionalUsd, limits.maxNotionalUsd);
  if (notional) reasons.push(notional);
  const exposure = exposureReason({
    openNotionalUsd: account.openNotionalUsd ?? 0,
    newNotionalUsd: input.notionalUsd,
    maxNotionalUsd: limits.maxNotionalUsd,
  });
  if (exposure) reasons.push(exposure);
  const takeProfit = takeProfitReason(input.takeProfitPct);
  if (takeProfit) reasons.push(takeProfit);
  const leverage = leverageReason(input.leverage, limits.maxLeverage);
  if (leverage) reasons.push(leverage);

  if (REQUIRE_STOP_LOSS) {
    if (input.stopLossPct == null) {
      reasons.push("a stop is mandatory: this configuration requires a stop loss on every order.");
    } else if (!Number.isFinite(input.leverage) || input.leverage < 1) {
      reasons.push(`leverage must be an integer greater than or equal to 1 (received ${fmt(input.leverage)}); the stop distance cannot be checked against liquidation.`);
    } else {
      const stop = stopReason(input.stopLossPct, input.leverage);
      if (stop) reasons.push(stop);
    }
  }

  const daily = dailyLockReason(account.dayPnl, limits.dailyLossUsd);
  if (daily) reasons.push(daily);
  const slots = openPositionsReason(account.openPositions, limits.maxOpenPositions, account.pendingSymbols ?? []);
  if (slots) reasons.push(slots);
  reasons.push(...unprotectedReasons(account.unprotectedSymbols));

  return reasons.length === 0 ? { allow: true, reasons: [] } : { allow: false, reasons };
}
