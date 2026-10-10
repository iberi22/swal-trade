// Account snapshot shared by `account_risk` and the write tools.
//
// The parsers and the guardian evaluation live in one place so that the daily
// PnL the daily-loss lock trusts is computed exactly like the PnL the read-only
// tool reports: realized income since the day start plus the unrealized PnL of
// the open positions.

import type { ReadOnlyClient } from "./binance.js";
import { dayStartMs, evaluateAccount } from "./risk.js";
import type { AccountSnapshot, AlgoOrder, IncomeRow, Position, PositionRiskRow, RawPosition } from "./risk.js";
import type { RiskCfg } from "./risk.js";
import { isRecord, errorMessage } from "./types.js";

function asNumberString(value: unknown, field: string): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  throw new Error(`missing ${field}`);
}

export function parseAccountPositions(account: unknown): RawPosition[] {
  if (!isRecord(account)) throw new Error("account response is not an object");
  const rows = account.positions ?? [];
  if (!Array.isArray(rows)) throw new Error("account positions is not an array");
  return rows.map((row) => {
    if (!isRecord(row) || typeof row.symbol !== "string") throw new Error("account position is invalid");
    const position: RawPosition = {
      symbol: row.symbol,
      positionAmt: asNumberString(row.positionAmt, "positionAmt"),
      notional: asNumberString(row.notional, "notional"),
      unrealizedProfit: asNumberString(row.unrealizedProfit, "unrealizedProfit"),
    };
    if (typeof row.positionSide === "string") position.positionSide = row.positionSide;
    return position;
  });
}

export function parsePositionRisk(value: unknown): PositionRiskRow[] {
  if (!Array.isArray(value)) throw new Error("positionRisk response is not an array");
  return value.map((row) => {
    if (!isRecord(row) || typeof row.symbol !== "string") throw new Error("positionRisk row is invalid");
    if (typeof row.leverage !== "string" && typeof row.leverage !== "number") throw new Error("positionRisk row missing leverage");
    return {
      symbol: row.symbol,
      positionAmt: asNumberString(row.positionAmt, "positionAmt"),
      leverage: row.leverage,
    };
  });
}

export function parseIncome(value: unknown): IncomeRow[] {
  if (!Array.isArray(value)) throw new Error("income response is not an array");
  return value.map((row) => {
    if (!isRecord(row)) throw new Error("income row is not an object");
    const income: IncomeRow = {};
    if (typeof row.incomeType === "string") income.incomeType = row.incomeType;
    if (typeof row.asset === "string") income.asset = row.asset;
    if (typeof row.income === "string" || typeof row.income === "number") income.income = row.income;
    if (typeof row.time === "number") income.time = row.time;
    return income;
  });
}

export function parseAlgo(value: unknown): AlgoOrder[] {
  if (!Array.isArray(value)) throw new Error("openAlgoOrders response is not an array");
  return value.map((row) => {
    if (!isRecord(row)) throw new Error("algo order is not an object");
    const order: AlgoOrder = {};
    if (typeof row.symbol === "string") order.symbol = row.symbol;
    if (typeof row.side === "string") order.side = row.side;
    if (typeof row.orderType === "string") order.orderType = row.orderType;
    if (typeof row.type === "string") order.type = row.type;
    if ("closePosition" in row) order.closePosition = row.closePosition;
    if ("reduceOnly" in row) order.reduceOnly = row.reduceOnly;
    if (typeof row.positionSide === "string") order.positionSide = row.positionSide;
    return order;
  });
}

export interface AccountRiskView extends AccountSnapshot {}

// ---------------------------------------------------------------------------
// Positions, netted.
// ---------------------------------------------------------------------------

export interface NetPositionRow {
  positionAmt: number;
  positionSide: string;
}

export interface NetPosition {
  /**
   * The signed net quantity of the symbol, or null when positionRisk returned no
   * row for it. In one-way mode the single BOTH row is the net; in hedge mode
   * LONG and SHORT are added, so a 0.4 long and a 0.1 short are a net 0.3.
   */
  amount: number | null;
  rows: NetPositionRow[];
  /** Set when a row for the symbol exists but its quantity cannot be read. */
  error: string | null;
}

/**
 * Nets every positionRisk row of one symbol.
 *
 * Picking the first or the last row is wrong in both directions: in hedge mode
 * it reads a leg as the whole position, and in one-way mode the rows arrive in
 * an order the exchange does not promise, so "the last row" is a coin flip.
 */
export function netPosition(risk: unknown, symbol: string): NetPosition {
  if (!Array.isArray(risk)) return { amount: null, rows: [], error: "positionRisk response is not an array" };
  const rows: NetPositionRow[] = [];
  let amount = 0;
  let error: string | null = null;
  for (const raw of risk) {
    if (!isRecord(raw) || raw.symbol !== symbol) continue;
    const amt = Number(raw.positionAmt);
    if (!Number.isFinite(amt)) {
      error = `positionRisk has a row for ${symbol} whose positionAmt is not a number`;
      continue;
    }
    rows.push({ positionAmt: amt, positionSide: typeof raw.positionSide === "string" ? raw.positionSide : "BOTH" });
    amount += amt;
  }
  if (rows.length === 0) return { amount: null, rows, error: error ?? null };
  return { amount: amount === 0 ? 0 : amount, rows, error };
}

/** Symbols with a non-zero net position, in first-seen order. */
export function openPositionSymbols(positions: readonly Position[]): string[] {
  const out: string[] = [];
  for (const position of positions) if (!out.includes(position.symbol)) out.push(position.symbol);
  return out;
}

// ---------------------------------------------------------------------------
// Exposure: positions plus the orders that would create a position.
// ---------------------------------------------------------------------------

export interface RestingOrder {
  symbol: string;
  side: string;
  type: string;
  price: number;
  quantity: number;
  notionalUsd: number;
  source: "/fapi/v1/openOrders" | "/fapi/v1/openAlgoOrders";
  id: string | null;
  /** True when the order can only reduce a position (stop, take profit). */
  reduces: boolean;
}

export interface Exposure {
  /** Distinct symbols with a position or with a resting order that opens one. */
  openPositions: number;
  positionSymbols: string[];
  pendingSymbols: string[];
  /** USD already committed: positions plus resting entry orders. */
  openNotionalUsd: number;
  restingOrders: RestingOrder[];
  /** Sources that could not be read: exposure is unknown, so it must fail closed. */
  errors: string[];
}

const num = (value: unknown): number => {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

/**
 * Reads the exposure that already exists: the positions, plus every resting
 * order that would open a position (a limit that has not filled yet counts as
 * committed money, and a pending stop-entry counts as a pending position).
 * Protective orders (reduceOnly / closePosition) never count: they close
 * exposure, they do not create it.
 */
export async function readExposure(input: {
  client: Pick<ReadOnlyClient, "account" | "positionRisk" | "openAlgoOrders"> & { openOrders: (symbol: string) => Promise<unknown> };
  symbol: string;
  markPrice: number;
  symbols?: readonly string[] | null;
}): Promise<Exposure> {
  const errors: string[] = [];
  const resting: RestingOrder[] = [];
  const positionSymbols: string[] = [];
  let openNotionalUsd = 0;

  const collect = (rows: unknown, source: RestingOrder["source"]): void => {
    if (!Array.isArray(rows)) {
      errors.push(`${source} did not return an array`);
      return;
    }
    for (const raw of rows) {
      if (!isRecord(raw)) continue;
      const symbol = typeof raw.symbol === "string" ? raw.symbol : null;
      if (!symbol) continue;
      const reduces = raw.reduceOnly === true || String(raw.reduceOnly).toLowerCase() === "true" || raw.closePosition === true || String(raw.closePosition).toLowerCase() === "true";
      const quantity = num(raw.origQty ?? raw.quantity);
      const price = num(raw.price);
      const stopPrice = num(raw.stopPrice ?? raw.triggerPrice);
      const type = typeof raw.type === "string" ? raw.type : typeof raw.orderType === "string" ? raw.orderType : "";
      if (reduces) continue;
      const unit = /MARKET/.test(type) ? (price > 0 ? price : input.markPrice) : price > 0 ? price : stopPrice > 0 ? stopPrice : input.markPrice;
      const notional = Number.isFinite(quantity) && quantity > 0 ? quantity * unit : 0;
      resting.push({
        symbol,
        side: typeof raw.side === "string" ? raw.side : "",
        type,
        price: unit,
        quantity: Number.isFinite(quantity) ? quantity : 0,
        notionalUsd: notional,
        source,
        id: typeof raw.clientOrderId === "string" ? raw.clientOrderId : typeof raw.algoId === "number" ? `algo-${raw.algoId}` : null,
        reduces,
      });
    }
  };

  try {
    const account = await input.client.account();
    const positions = parseAccountPositions(account);
    for (const position of positions) {
      if (!positionSymbols.includes(position.symbol)) positionSymbols.push(position.symbol);
      openNotionalUsd += Math.abs(Number.parseFloat(position.notional) || 0);
    }
  } catch (err) {
    errors.push(`account: ${errorMessage(err)}`);
  }

  // One-way and hedge rows for the symbol are netted, so a leg is never read as
  // the whole position.
  try {
    const risk = await input.client.positionRisk();
    const net = netPosition(risk, input.symbol);
    if (net.error) errors.push(net.error);
    if (net.amount != null && net.amount !== 0 && !positionSymbols.includes(input.symbol)) positionSymbols.push(input.symbol);
  } catch (err) {
    errors.push(`positionRisk: ${errorMessage(err)}`);
  }

  const seen = new Set<string>();
  try {
    const rows = await input.client.openOrders(input.symbol);
    collect(rows, "/fapi/v1/openOrders");
  } catch (err) {
    errors.push(`openOrders: ${errorMessage(err)}`);
  }
  try {
    const rows = await input.client.openAlgoOrders();
    collect(rows, "/fapi/v1/openAlgoOrders");
  } catch (err) {
    errors.push(`openAlgoOrders: ${errorMessage(err)}`);
  }

  const pendingSymbols: string[] = [];
  for (const order of resting) {
    if (seen.has(`${order.source}:${order.id ?? ""}:${order.symbol}:${order.price}`)) continue;
    seen.add(`${order.source}:${order.id ?? ""}:${order.symbol}:${order.price}`);
    openNotionalUsd += order.notionalUsd;
    if (!pendingSymbols.includes(order.symbol)) pendingSymbols.push(order.symbol);
  }

  return {
    openPositions: new Set([...positionSymbols, ...pendingSymbols]).size,
    positionSymbols,
    pendingSymbols,
    openNotionalUsd: Number(openNotionalUsd.toFixed(6)),
    restingOrders: resting,
    errors,
  };
}


export interface LoadAccountInput {
  client: Pick<ReadOnlyClient, "syncTime" | "account" | "positionRisk" | "openAlgoOrders" | "incomeSince">;
  /** RiskCfg plus the timezone offset that fixes the start of the PnL day. */
  cfg: RiskCfg & { tz: number };
  now: () => number;
}

/** Synchronizes the clock and reads the four signed GETs the guardian needs. */
export async function loadAccountRiskView(input: LoadAccountInput): Promise<AccountRiskView> {
  await input.client.syncTime();
  const start = dayStartMs(input.now(), input.cfg.tz);
  const [account, positionRisk, algoOrders, income] = await Promise.all([
    input.client.account(),
    input.client.positionRisk(),
    input.client.openAlgoOrders(),
    input.client.incomeSince(start),
  ]);
  return evaluateAccount({
    account: { positions: parseAccountPositions(account) },
    positionRisk: parsePositionRisk(positionRisk),
    income: parseIncome(income),
    algoOrders: parseAlgo(algoOrders),
    cfg: input.cfg,
  });
}
