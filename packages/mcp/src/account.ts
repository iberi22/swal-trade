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

/** The snapshot plus the raw answers it was computed from, so a caller that needs the exposure does not fetch twice. */
export interface LoadAccountResult {
  view: AccountSnapshot;
  account: unknown;
  positionRisk: unknown;
  algoOrders: unknown;
}

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
  // Round away the binary-float noise of adding decimal strings: 0.4 + (-0.1)
  // is 0.30000000000000004 in IEEE754, and a quantity the close order rounds
  // UP from is an over-close the exchange refuses.
  return { amount: amount === 0 ? 0 : Number(amount.toFixed(12)), rows, error };
}

/**
 * The flat-symbol invariant, as a refusal sentence.
 *
 * `place_order` and `grid_place` OPEN a position, so they may only run on a
 * symbol that is flat: no net position, and no resting order that would create
 * one (a limit that has not filled, a pending stop-entry, a non-reduce algo
 * order). Protective orders (reduceOnly, closePosition) are exempt: they close
 * exposure, they do not open it.
 *
 * The alternative was to keep going and reconcile afterwards, and reconciliation
 * is exactly what used to go wrong: an ambiguous entry answered with a confirmed
 * cancel of zero executed was read as "this order's fill", so a pre-existing
 * position became this order's fill; the protective stop was then armed with
 * `closePosition` over the USER's whole position, and when that stop failed the
 * emergency close MARKET-closed the user's position and cancelled the user's
 * orders. Refusing up front needs no reconciliation at all.
 *
 * The check is made against the exposure the guard already read (the same
 * account/positionRisk/openOrders/openAlgoOrders answers), so it costs no extra
 * call and cannot disagree with the numbers the order was explained with.
 */
export function flatSymbolRefusal(exposure: Exposure, symbol: string): string | null {
  const openPosition = exposure.positionSymbols.includes(symbol);
  const resting = exposure.restingOrders.filter((order) => order.symbol === symbol && !order.reduces);
  if (!openPosition && resting.length === 0) return null;
  return `${symbol} already has an open position or orders; this tool only opens a position on a flat symbol. Use close_position or manage it manually.`;
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
  /** USD already committed: positions plus resting entry orders, every symbol. */
  openNotionalUsd: number;
  /**
   * USD already committed on the symbol being traded. The notional cap is per
   * position, so this is the number the guard compares against: summing every
   * symbol would refuse a second, independent position that the cap allows.
   */
  symbolNotionalUsd: number;
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
  /** Already-read answers, so a caller that has them does not fetch twice. */
  prefetched?: {
    account?: unknown;
    positionRisk?: unknown;
    algoOrders?: unknown;
  };
}): Promise<Exposure> {
  const errors: string[] = [];
  const resting: RestingOrder[] = [];
  const positionSymbols: string[] = [];
  let openNotionalUsd = 0;
  let symbolPositionUsd = 0;
  let symbolRestingUsd = 0;

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
    const account = input.prefetched?.account ?? (await input.client.account());
    const positions = parseAccountPositions(account);
    for (const position of positions) {
      // GET /fapi/v3/account lists a row for every symbol on the market, almost
      // all of them with positionAmt "0". Counting a closed row made every
      // symbol an open position, so the max-open-positions cap refused orders on
      // an account with nothing open. A position is an open one only when its
      // amount is a non-zero number.
      const amount = Number.parseFloat(position.positionAmt);
      if (!Number.isFinite(amount) || amount === 0) continue;
      if (!positionSymbols.includes(position.symbol)) positionSymbols.push(position.symbol);
      const notional = Math.abs(Number.parseFloat(position.notional) || 0);
      openNotionalUsd += notional;
      if (position.symbol === input.symbol) symbolPositionUsd += notional;
    }
  } catch (err) {
    errors.push(`account: ${errorMessage(err)}`);
  }

  // One-way and hedge rows for the symbol are netted, so a leg is never read as
  // the whole position.
  try {
    const risk = input.prefetched?.positionRisk ?? (await input.client.positionRisk());
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
    const rows = input.prefetched?.algoOrders ?? (await input.client.openAlgoOrders());
    collect(rows, "/fapi/v1/openAlgoOrders");
  } catch (err) {
    errors.push(`openAlgoOrders: ${errorMessage(err)}`);
  }

  const pendingSymbols: string[] = [];
  for (const order of resting) {
    if (seen.has(`${order.source}:${order.id ?? ""}:${order.symbol}:${order.price}`)) continue;
    seen.add(`${order.source}:${order.id ?? ""}:${order.symbol}:${order.price}`);
    openNotionalUsd += order.notionalUsd;
    if (order.symbol === input.symbol) symbolRestingUsd += order.notionalUsd;
    if (!pendingSymbols.includes(order.symbol)) pendingSymbols.push(order.symbol);
  }

  const symbolNotionalUsd = Number((symbolPositionUsd + symbolRestingUsd).toFixed(6));
  return {
    openPositions: new Set([...positionSymbols, ...pendingSymbols]).size,
    positionSymbols,
    pendingSymbols,
    openNotionalUsd: Number(openNotionalUsd.toFixed(6)),
    symbolNotionalUsd,
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

/**
 * Synchronizes the clock and reads the four signed GETs the guardian needs.
 *
 * The raw answers are returned alongside the snapshot: the write path needs the
 * exposure (positions plus resting orders) as well, and re-reading the same
 * endpoints a moment later is how a decision ends up made against a different
 * account state than the one it was explained with.
 */
export async function loadAccountRiskView(input: LoadAccountInput): Promise<LoadAccountResult> {
  await input.client.syncTime();
  const start = dayStartMs(input.now(), input.cfg.tz);
  const [account, positionRisk, algoOrders, income] = await Promise.all([
    input.client.account(),
    input.client.positionRisk(),
    input.client.openAlgoOrders(),
    input.client.incomeSince(start),
  ]);
  return {
    view: evaluateAccount({
      account: { positions: parseAccountPositions(account) },
      positionRisk: parsePositionRisk(positionRisk),
      income: parseIncome(income),
      algoOrders: parseAlgo(algoOrders),
      cfg: input.cfg,
    }),
    account,
    positionRisk,
    algoOrders,
  };
}
