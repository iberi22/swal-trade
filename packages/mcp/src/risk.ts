// Pure risk checks. Port of workers/public-site/static/guardian/guardian-core.js
// (itself a port of scripts/guardian/risk_guardian.py). No network, no clock, no env.

export const USD = new Set(["USDT", "USDC", "FDUSD", "BUSD"]);
export const PNL_TYPES = new Set(["REALIZED_PNL", "COMMISSION", "FUNDING_FEE"]);

export interface RiskCfg {
  limit: number;
  warn?: number;
  maxNotional: number | null;
  maxLev: number | null;
}

export interface IncomeRow {
  incomeType?: string;
  asset?: string;
  income?: string | number;
  time?: number;
}

export interface RawPosition {
  symbol: string;
  positionAmt: string;
  notional: string;
  unrealizedProfit: string;
  positionSide?: string;
}

export interface Position {
  symbol: string;
  amt: string;
  notional: number;
  unrealized: number;
  positionSide: string;
}

export interface AlgoOrder {
  symbol?: string;
  side?: string;
  orderType?: string;
  type?: string;
  closePosition?: unknown;
  reduceOnly?: unknown;
  positionSide?: string;
}

export interface PositionRiskRow {
  symbol: string;
  positionAmt: string;
  leverage: string | number;
}

export interface AccountSnapshot {
  dayPnl: number;
  realized: number;
  unrealized: number;
  positions: Position[];
  leverages: Record<string, number>;
  breaches: Record<string, string>;
  unprotected: Position[];
}

export function dayStartMs(nowMs: number, tzH: number): number {
  const off = Math.trunc(tzH * 3_600_000);
  return Math.floor((nowMs + off) / 86_400_000) * 86_400_000 - off;
}

export function realizedUsd(rows: readonly IncomeRow[]): number {
  let sum = 0;
  for (const row of rows) {
    if (row.incomeType !== undefined && PNL_TYPES.has(row.incomeType) && row.asset !== undefined && USD.has(row.asset)) {
      sum += Number.parseFloat(String(row.income));
    }
  }
  return sum;
}

export function positionsFrom(account: { positions?: RawPosition[] }): Position[] {
  return (account.positions ?? [])
    .filter((position) => Number.parseFloat(position.positionAmt) !== 0)
    .map((position) => ({
      symbol: position.symbol,
      amt: String(position.positionAmt),
      notional: Math.abs(Number.parseFloat(position.notional)),
      unrealized: Number.parseFloat(position.unrealizedProfit),
      positionSide: position.positionSide || "BOTH",
    }));
}

const f2 = (n: number): string => n.toFixed(2);

export function breaches(
  dayPnl: number,
  positions: readonly Position[],
  leverages: Readonly<Record<string, number>>,
  cfg: RiskCfg,
): Record<string, string> {
  const out: Record<string, string> = {};
  const lim = cfg.limit;
  const open = positions.reduce((sum, position) => sum + position.unrealized, 0);
  const det = `PnL del dia ${f2(dayPnl)} USD (realizado ${f2(dayPnl - open)}, abierto ${f2(open)}), limite -${f2(lim)}.`;
  if (dayPnl <= -lim) out.daily_hit = `GUARDIAN: limite diario alcanzado. ${det} Para de operar hoy.`;
  else if (dayPnl <= -lim * (cfg.warn ?? 0.7)) out.daily_warn = `GUARDIAN: cerca del limite diario. ${det} Cuidado.`;
  for (const position of positions) {
    const symbol = position.symbol;
    const maxNotional = cfg.maxNotional;
    const maxLev = cfg.maxLev;
    if (maxNotional && position.notional > maxNotional) {
      out[`notional:${symbol}`] = `GUARDIAN: ${symbol} nocional ${position.notional.toFixed(0)} USD supera el maximo ${maxNotional.toFixed(0)}.`;
    }
    if (maxLev && (leverages[symbol] || 0) > maxLev) {
      out[`lev:${symbol}`] = `GUARDIAN: ${symbol} apalancamiento ${leverages[symbol]}x supera el maximo ${maxLev}x.`;
    }
  }
  return out;
}

const isTrue = (value: unknown): boolean => value === true || String(value).toLowerCase() === "true";

export function hasStop(position: Position, algo: readonly AlgoOrder[]): boolean {
  const long = Number.parseFloat(position.amt) > 0;
  for (const order of algo) {
    const typ = order.orderType || order.type;
    if (order.symbol !== position.symbol || typ !== "STOP_MARKET" || order.side !== (long ? "SELL" : "BUY")) continue;
    if (position.positionSide !== "BOTH" && order.positionSide !== position.positionSide) continue;
    if (isTrue(order.closePosition) || isTrue(order.reduceOnly)) return true;
  }
  return false;
}

export const unprotected = (positions: readonly Position[], algo: readonly AlgoOrder[]): Position[] =>
  positions.filter((position) => !hasStop(position, algo));

/** SIN STOP messages due now (at most one per position every everyS seconds). Mutates `last`. */
export function stopAlertsDue(
  missing: readonly Position[],
  last: Map<string, number>,
  now: number,
  everyS: number,
): string[] {
  const out: string[] = [];
  const keys = new Set<string>();
  for (const position of missing) {
    const side = Number.parseFloat(position.amt) > 0 ? "LONG" : "SHORT";
    const key = `${position.symbol}|${side}`;
    keys.add(key);
    if (now - (last.has(key) ? (last.get(key) as number) : -1e18) >= everyS) {
      last.set(key, now);
      out.push(`SIN STOP: ${position.symbol} ${side} ${position.amt.replace(/^-/, "")}`);
    }
  }
  for (const key of [...last.keys()]) if (!keys.has(key)) last.delete(key);
  return out;
}

/** Breach keys not yet alerted. Mutates `alerted`. */
export function newBreaches(breachesFound: Readonly<Record<string, string>>, alerted: Set<string>): string[] {
  const fresh = Object.keys(breachesFound)
    .filter((key) => !alerted.has(key))
    .sort();
  for (const key of fresh) alerted.add(key);
  return fresh;
}

export function evaluateAccount(input: {
  account: { positions?: RawPosition[] };
  positionRisk: readonly PositionRiskRow[];
  income: readonly IncomeRow[];
  algoOrders: readonly AlgoOrder[];
  cfg: RiskCfg;
}): AccountSnapshot {
  const positions = positionsFrom(input.account);
  const leverages: Record<string, number> = {};
  for (const row of input.positionRisk) {
    if (Number.parseFloat(row.positionAmt) !== 0) leverages[row.symbol] = Number.parseFloat(String(row.leverage));
  }
  const realized = realizedUsd(input.income);
  const unrealized = positions.reduce((sum, position) => sum + position.unrealized, 0);
  const dayPnl = realized + unrealized;
  return {
    dayPnl,
    realized,
    unrealized,
    positions,
    leverages,
    breaches: breaches(dayPnl, positions, leverages, input.cfg),
    unprotected: unprotected(positions, input.algoOrders),
  };
}
