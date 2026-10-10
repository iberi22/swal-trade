// Grid: plan math, the in-memory plan store, and the two grid tools.
//
// `grid_plan` is read-only and always available: it prices the ladder against the
// exchange filters, reports the worst-case loss to the stop and flags the levels
// that could not rest as post-only orders. `grid_place` is a write tool behind
// the same flag and the same order guard as `place_order`: it places the ladder
// as post-only limits with one protective STOP_MARKET below or above the range.
//
// The server provides no strategy and no signal: it does not choose the range,
// the number of levels or the stop. It only checks them and executes them.

import { createHash } from "node:crypto";

import { ceilToStep, decimalNumber, floorToStep, nearestStep, shiftStep } from "./decimal.js";
import type { ConfigResult } from "./config.js";
import { readCredentials } from "./config.js";
import type { SymbolFilters } from "./exchange.js";
import { fetchBookTicker, fetchSymbolFilters } from "./exchange.js";
import { fetchMarkPrice } from "./market-data.js";
import {
  dailyLockReason,
  leverageReason,
  notionalReason,
  openPositionsReason,
  stopReason,
  symbolReason,
  unprotectedReasons,
} from "./order-guard.js";
import type { GuardAccount, GuardDecision, GuardLimits, GuardSide } from "./order-guard.js";
import { normalizeSymbol } from "./symbol.js";
import { parseTradingConfig, readGridLimits, TESTNET_BASE, MAINNET_BASE } from "./trading-config.js";
import type { GridLimits } from "./trading-config.js";
import { createTradingClient } from "./trade-client.js";
import type { TradingClient } from "./trade-client.js";
import { isAmbiguousError, isRepriceable, newClientOrderId } from "./trade-client.js";
import { fetchLiquidationInputs, readLiquidationEstimate, stopInsideLiquidation } from "./liquidation.js";
import { loadAccountRiskView, readExposure } from "./account.js";
import { parseAccountRiskConfig } from "./config.js";
import {
  applyLeverageAndMargin,
  describeFlatten,
  emergencyClose,
  filledQuantityOf,
  guardLimitsFrom,
  isFinalStatus,
  ok,
  orderStatusOf,
  placeProtectiveAlgoOrder,
  refused,
  withWriteLock,
  requireJournal,
  withJournal,
} from "./write.js";
import type { JournalRecord, ToolOutcome, WriteDeps } from "./write.js";
import { redactSecrets, errorMessage } from "./types.js";

export const MIN_GRID_LEVELS = 2;
export const MAX_GRID_LEVELS = 20;

/** Attempts per post-only level, and for the protective stop. */
const POST_ONLY_ATTEMPTS = 3;
const STOP_ATTEMPTS = 2;

const PLAN_TTL_MS = 60 * 60 * 1000;
const PLAN_STORE_LIMIT = 32;

export interface GridPlanArgs {
  symbol: string;
  lower: number;
  upper: number;
  levels: number;
  total_notional_usd: number;
  stop_loss_price: number;
}

export interface GridLevel {
  index: number;
  side: GuardSide;
  price: string;
  quantity: string;
  notionalUsd: number;
}

export interface GridPlan {
  planId: string;
  symbol: string;
  direction: "long" | "short";
  entrySide: GuardSide;
  stopSide: GuardSide;
  stopPrice: string;
  /** Distance from the worst (closest to the stop) level, in percent. */
  stopDistancePct: number;
  /** The level the stop distance and the liquidation check are measured from. */
  worstLevel: GridLevel;
  levels: GridLevel[];
  totalQuantity: string;
  totalNotionalUsd: number;
  averageEntryUsd: number;
  worstCaseLossUsd: number;
  /** The parameters the user asked for, kept verbatim so grid_place can match them. */
  request: GridPlanArgs;
  warnings: string[];
}

function planIdOf(args: GridPlanArgs, symbol: string): string {
  const canonical = [symbol, args.lower, args.upper, args.levels, args.total_notional_usd, args.stop_loss_price].join("|");
  return `g${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
}

function sumQuantity(quantities: readonly string[], stepSize: string): string {
  const total = quantities.reduce((sum, value) => sum + decimalNumber(value), 0);
  return floorToStep(total, stepSize) ?? "0";
}

/**
 * Prices the ladder. Deterministic and offline apart from the filters and the
 * mark price it is given, so the same inputs always produce the same plan.
 */
export function buildGridPlan(input: {
  args: GridPlanArgs;
  filters: SymbolFilters;
  markPrice?: number | null;
  bestBid?: string | null;
  bestAsk?: string | null;
}): ConfigResult<GridPlan> {
  const symbol = normalizeSymbol(input.args.symbol);
  if (!symbol) return { ok: false, error: "symbol must be 2 to 30 letters or digits." };
  const { lower, upper, levels, total_notional_usd: totalNotional, stop_loss_price: stopPriceRaw } = input.args;
  if (!(Number.isFinite(lower) && lower > 0)) return { ok: false, error: "lower must be a finite number greater than 0." };
  if (!(Number.isFinite(upper) && upper > 0)) return { ok: false, error: "upper must be a finite number greater than 0." };
  if (!(upper > lower)) return { ok: false, error: "upper must be greater than lower." };
  if (!Number.isInteger(levels) || levels < MIN_GRID_LEVELS || levels > MAX_GRID_LEVELS) {
    return { ok: false, error: `levels must be an integer from ${MIN_GRID_LEVELS} to ${MAX_GRID_LEVELS}.` };
  }
  if (!(Number.isFinite(totalNotional) && totalNotional > 0)) {
    return { ok: false, error: "total_notional_usd must be a finite number greater than 0." };
  }
  if (!(Number.isFinite(stopPriceRaw) && stopPriceRaw > 0)) {
    return { ok: false, error: "stop_loss_price must be a finite number greater than 0." };
  }

  const direction: "long" | "short" = stopPriceRaw < lower ? "long" : stopPriceRaw > upper ? "short" : "long";
  if (stopPriceRaw >= lower && stopPriceRaw <= upper) {
    return {
      ok: false,
      error: `stop_loss_price ${stopPriceRaw} is inside the [${lower}, ${upper}] range: it must be below the range for a long grid or above it for a short grid.`,
    };
  }
  const entrySide: GuardSide = direction === "long" ? "BUY" : "SELL";
  const stopSide: GuardSide = direction === "long" ? "SELL" : "BUY";
  const stopPrice = direction === "long" ? floorToStep(stopPriceRaw, input.filters.tickSize) : ceilToStep(stopPriceRaw, input.filters.tickSize);
  if (stopPrice == null) return { ok: false, error: `stop_loss_price ${stopPriceRaw} cannot be aligned to tickSize ${input.filters.tickSize}.` };

  const warnings: string[] = [];
  const seen = new Map<string, GridLevel>();
  for (let index = 0; index < levels; index += 1) {
    const rawPrice = lower + ((upper - lower) * index) / (levels - 1);
    const price = nearestStep(rawPrice, input.filters.tickSize);
    if (price == null || decimalNumber(price) <= 0) {
      warnings.push(`level ${index + 1} at ${rawPrice} cannot be aligned to tickSize ${input.filters.tickSize} and was dropped.`);
      continue;
    }
    const notionalPerLevel = totalNotional / levels;
    const quantity = floorToStep(notionalPerLevel / decimalNumber(price), input.filters.stepSize);
    if (quantity == null || decimalNumber(quantity) <= 0) {
      warnings.push(`level ${index + 1} at ${price} was dropped: its quantity rounds to zero at stepSize ${input.filters.stepSize}.`);
      continue;
    }
    // Two levels on the same tick are not a grid: they are one order for double
    // the size, which quietly doubles the exposure of that price.
    const previous = seen.get(price);
    if (previous) {
      return {
        ok: false,
        error:
          `levels ${previous.index} and ${index + 1} both round to ${price} at tickSize ${input.filters.tickSize}: the grid would place one order of double the size instead of two levels. ` +
          `Widen the range, lower the level count, or raise total_notional_usd.`,
      };
    }
    seen.set(price, {
      index: index + 1,
      side: entrySide,
      price,
      quantity,
      notionalUsd: Number((decimalNumber(quantity) * decimalNumber(price)).toFixed(6)),
    });
  }
  const planLevels = [...seen.values()];
  if (planLevels.length === 0) {
    return { ok: false, error: `no level survives rounding at stepSize ${input.filters.stepSize} and tickSize ${input.filters.tickSize}: widen the range, raise total_notional_usd, or lower the level count.` };
  }

  const lowest = Math.min(...planLevels.map((level) => decimalNumber(level.price)));
  const highest = Math.max(...planLevels.map((level) => decimalNumber(level.price)));
  const stopNumber = decimalNumber(stopPrice);
  // The WORST level is the one the stop distance has to be measured from: the
  // level closest to the stop loses the most when price runs through it, and an
  // average of the levels understates every one of them.
  const worstLevel = direction === "long"
    ? planLevels.reduce((worst, level) => (decimalNumber(level.price) < decimalNumber(worst.price) ? level : worst))
    : planLevels.reduce((worst, level) => (decimalNumber(level.price) > decimalNumber(worst.price) ? level : worst));
  const worstLevelPrice = decimalNumber(worstLevel.price);
  const worstCaseLossUsd = Number(
    planLevels
      .reduce((sum, level) => {
        const distance = direction === "long" ? decimalNumber(level.price) - stopNumber : stopNumber - decimalNumber(level.price);
        return sum + distance * decimalNumber(level.quantity);
      }, 0)
      .toFixed(2),
  );
  const worstLevelDistancePct = worstLevelPrice > 0 ? (Math.abs(worstLevelPrice - stopNumber) / worstLevelPrice) * 100 : 0;
  if (direction === "long" && !(stopNumber < lowest)) {
    return { ok: false, error: `stop ${stopPrice} is not below the lowest level ${lowest}: rounding to tickSize moved it inside the grid.` };
  }
  if (direction === "short" && !(stopNumber > highest)) {
    return { ok: false, error: `stop ${stopPrice} is not above the highest level ${highest}: rounding to tickSize moved it inside the grid.` };
  }

  const quantities = planLevels.map((level) => level.quantity);
  const totalQuantity = sumQuantity(quantities, input.filters.stepSize);
  const totalNotionalUsd = Number(planLevels.reduce((sum, level) => sum + level.notionalUsd, 0).toFixed(2));
  const quantityNumber = decimalNumber(totalQuantity);
  const averageEntryUsd = quantityNumber > 0 ? Number((planLevels.reduce((sum, level) => sum + decimalNumber(level.quantity) * decimalNumber(level.price), 0) / quantityNumber).toFixed(6)) : 0;
  const stopDistancePct = Number(worstLevelDistancePct.toFixed(6));

  if (input.markPrice != null) {
    const mark = input.markPrice;
    for (const level of planLevels) {
      const price = decimalNumber(level.price);
      if (direction === "long" && input.bestAsk != null && price >= decimalNumber(input.bestAsk)) {
        warnings.push(`level ${level.index} at ${level.price} is at or above the best ask ${input.bestAsk}: a post-only BUY there would cross the book and be rejected.`);
      } else if (direction === "long" && price >= mark) {
        warnings.push(`level ${level.index} at ${level.price} is at or above the mark price ${mark}: it may cross the book and be rejected as post-only.`);
      }
      if (direction === "short" && input.bestBid != null && price <= decimalNumber(input.bestBid)) {
        warnings.push(`level ${level.index} at ${level.price} is at or below the best bid ${input.bestBid}: a post-only SELL there would cross the book and be rejected.`);
      } else if (direction === "short" && price <= mark) {
        warnings.push(`level ${level.index} at ${level.price} is at or below the mark price ${mark}: it may cross the book and be rejected as post-only.`);
      }
    }
  }

  return {
    ok: true,
    value: {
      planId: planIdOf(input.args, symbol),
      symbol,
      direction,
      entrySide,
      stopSide,
      stopPrice,
      stopDistancePct,
      worstLevel,
      levels: planLevels,
      totalQuantity,
      totalNotionalUsd,
      averageEntryUsd,
      worstCaseLossUsd,
      request: input.args,
      warnings,
    },
  };
}

export function checkGridPlan(plan: GridPlan, limits: GuardLimits, account: GuardAccount, maxLeverage: number, minNotional: number): GuardDecision {
  const reasons: string[] = [];
  const symbol = symbolReason(plan.symbol, limits.symbols);
  if (symbol) reasons.push(symbol);
  const notional = notionalReason(plan.totalNotionalUsd, limits.maxNotionalUsd);
  if (notional) reasons.push(notional);
  const leverage = leverageReason(maxLeverage, limits.maxLeverage);
  if (leverage) reasons.push(leverage);
  const stop = stopReason(plan.stopDistancePct, maxLeverage);
  if (stop) reasons.push(stop);
  const daily = dailyLockReason(account.dayPnl, limits.dailyLossUsd);
  if (daily) reasons.push(daily);
  const slots = openPositionsReason(account.openPositions, limits.maxOpenPositions);
  if (slots) reasons.push(slots);
  reasons.push(...unprotectedReasons(account.unprotectedSymbols));
  if (minNotional > 0) {
    for (const level of plan.levels) {
      if (level.notionalUsd < minNotional) {
        reasons.push(`level ${level.index} has a notional of ${level.notionalUsd} USD, below the exchange MIN_NOTIONAL of ${minNotional} USD.`);
      }
    }
  }
  return reasons.length === 0 ? { allow: true, reasons: [] } : { allow: false, reasons };
}

export interface GridChecks {
  levelsWithinCap: boolean;
  notionalWithinCap: boolean | null;
  placeable: boolean;
  failures: string[];
}

export function gridChecks(plan: GridPlan, limits: GridLimits): GridChecks {
  const failures: string[] = [];
  const levelsWithinCap = plan.levels.length <= MAX_GRID_LEVELS;
  if (!levelsWithinCap) failures.push(`the plan has ${plan.levels.length} levels, above the ${MAX_GRID_LEVELS} cap.`);
  const notionalWithinCap = limits.maxNotionalUsd == null ? null : plan.totalNotionalUsd <= limits.maxNotionalUsd;
  if (notionalWithinCap === false) {
    failures.push(`grid notional ${plan.totalNotionalUsd} USD exceeds SWAL_MAX_NOTIONAL_USD ${limits.maxNotionalUsd} USD.`);
  }
  if (plan.warnings.some((warning) => /cross the book/.test(warning))) {
    failures.push("at least one level would cross the book: a post-only order there is rejected by the exchange.");
  }
  return { levelsWithinCap, notionalWithinCap, placeable: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// Plan store: the id grid_plan returns is the one grid_place accepts.
// ---------------------------------------------------------------------------

export interface GridPlanStore {
  save: (plan: GridPlan) => void;
  get: (planId: string) => GridPlan | null;
  size: () => number;
}

export function createGridPlanStore(now: () => number, ttlMs: number = PLAN_TTL_MS, limit: number = PLAN_STORE_LIMIT): GridPlanStore {
  const entries = new Map<string, { plan: GridPlan; at: number }>();
  return {
    save(plan) {
      entries.set(plan.planId, { plan, at: now() });
      while (entries.size > limit) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    get(planId) {
      const entry = entries.get(planId);
      if (!entry) return null;
      if (now() - entry.at > ttlMs) {
        entries.delete(planId);
        return null;
      }
      return entry.plan;
    },
    size: () => entries.size,
  };
}

function samePlan(plan: GridPlan, args: Partial<GridPlanArgs>): boolean {
  const request = plan.request;
  const lower = Number(args.lower);
  const upper = Number(args.upper);
  const levels = Number(args.levels);
  const total = Number(args.total_notional_usd);
  const stop = Number(args.stop_loss_price);
  if (Number.isFinite(lower) && lower !== request.lower) return false;
  if (Number.isFinite(upper) && upper !== request.upper) return false;
  if (Number.isFinite(levels) && levels !== request.levels) return false;
  if (Number.isFinite(total) && total !== request.total_notional_usd) return false;
  if (Number.isFinite(stop) && stop !== request.stop_loss_price) return false;
  return true;
}

// ---------------------------------------------------------------------------
// grid_plan: read-only.
// ---------------------------------------------------------------------------

export async function gridPlan(deps: Pick<WriteDeps, "env" | "fetchFn" | "now" | "plans">, args: Partial<GridPlanArgs>): Promise<ToolOutcome> {
  const symbol = normalizeSymbol(args.symbol ?? "");
  if (!symbol) return refused("symbol must be 2 to 30 letters or digits.");
  const request: GridPlanArgs = {
    symbol,
    lower: Number(args.lower),
    upper: Number(args.upper),
    levels: Number(args.levels),
    total_notional_usd: Number(args.total_notional_usd),
    stop_loss_price: Number(args.stop_loss_price),
  };
  const limits = readGridLimits(deps.env);
  const base = limits.network === "mainnet" ? MAINNET_BASE : TESTNET_BASE;
  try {
    const [filters, markPrice, book] = await Promise.all([
      fetchSymbolFilters(base, symbol, deps.fetchFn),
      fetchMarkPrice(base, symbol, deps.fetchFn),
      fetchBookTicker(base, symbol, deps.fetchFn),
    ]);
    if (!filters.ok) return refused(`exchangeInfo: ${filters.error}`);
    const built = buildGridPlan({
      args: request,
      filters: filters.value,
      markPrice,
      bestBid: book.ok ? book.value.bidPrice : null,
      bestAsk: book.ok ? book.value.askPrice : null,
    });
    if (!built.ok) return refused(built.error);
    const plan = built.value;
    deps.plans.save(plan);
    const checks = gridChecks(plan, limits);
    return ok({
      planId: plan.planId,
      symbol: plan.symbol,
      direction: plan.direction,
      network: limits.network,
      entrySide: plan.entrySide,
      stopSide: plan.stopSide,
      stop: { type: "STOP_MARKET", side: plan.stopSide, stopPrice: plan.stopPrice, workingType: "MARK_PRICE", closePosition: true },
      stopDistancePct: plan.stopDistancePct,
      levels: plan.levels,
      levelCount: plan.levels.length,
      totalQuantity: plan.totalQuantity,
      totalNotionalUsd: plan.totalNotionalUsd,
      averageEntryUsd: plan.averageEntryUsd,
      worstCaseLossUsd: plan.worstCaseLossUsd,
      filters: filters.value,
      markPrice,
      checks,
      warnings: plan.warnings,
      limits: {
        maxNotionalUsd: limits.maxNotionalUsd,
        maxLeverage: limits.maxLeverage,
        symbols: limits.symbols,
      },
      tradingEnabled: limits.enabled,
      readOnly: true,
      note: limits.enabled
        ? "Read-only plan: nothing was sent. Call grid_place with this plan_id to place it, and explain the grid to the user first."
        : "Read-only plan: nothing was sent. grid_place is disabled because SWAL_MCP_TRADING is not 'enabled'.",
    });
  } catch (err) {
    return refused(redactSecrets(errorMessage(err), []));
  }
}

// ---------------------------------------------------------------------------
// grid_place: write tool.
// ---------------------------------------------------------------------------

export interface GridPlaceArgs extends Partial<GridPlanArgs> {
  plan_id?: string;
}

export async function gridPlace(deps: WriteDeps, args: GridPlaceArgs): Promise<ToolOutcome> {
  const request = {
    plan_id: args.plan_id ?? null,
    symbol: args.symbol ?? null,
    lower: args.lower ?? null,
    upper: args.upper ?? null,
    levels: args.levels ?? null,
    total_notional_usd: args.total_notional_usd ?? null,
    stop_loss_price: args.stop_loss_price ?? null,
  };
  return withWriteLock(deps, () => withJournal(deps, "grid_place", request, async (record) => {
    const cfg = parseTradingConfig(deps.env);
    if (!cfg.ok) return refused(cfg.error);
    record.network = cfg.value.network;
    const credentials = readCredentials(deps.env);
    if (!credentials.ok) return refused(credentials.error);

    const stored = args.plan_id ? deps.plans.get(args.plan_id) : null;
    if (args.plan_id && !stored) {
      return refused(`plan_id ${args.plan_id} is unknown or expired (plans live for one hour): call grid_plan again.`);
    }
    if (args.symbol) {
      const given = normalizeSymbol(args.symbol);
      if (!given) return refused("symbol must be 2 to 30 letters or digits.");
      if (stored && stored.symbol !== given) return refused(`plan_id ${args.plan_id} is for ${stored.symbol}, not ${given}.`);
    }
    const symbol = normalizeSymbol(args.symbol ?? stored?.symbol ?? "");
    if (!symbol) return refused("symbol must be 2 to 30 letters or digits.");

    const journalError = await requireJournal(deps, cfg.value.journalPath);
    if (journalError) return refused(journalError);

    let args2: GridPlanArgs;
    if (stored) {
      if (!samePlan(stored, args)) {
        return refused("the parameters in this call do not match the stored plan: send the same values, or call grid_plan again for a new plan.");
      }
      args2 = { ...stored.request, symbol: stored.symbol };
    } else {
      args2 = {
        symbol,
        lower: Number(args.lower),
        upper: Number(args.upper),
        levels: Number(args.levels),
        total_notional_usd: Number(args.total_notional_usd),
        stop_loss_price: Number(args.stop_loss_price),
      };
    }

    const client = createTradingClient({
      apiKey: credentials.value.apiKey,
      apiSecret: credentials.value.apiSecret,
      fetchFn: deps.fetchFn,
      now: deps.now,
      base: cfg.value.base,
    });
    await client.syncTime();

    const [filters, markPrice, book] = await Promise.all([
      fetchSymbolFilters(cfg.value.base, symbol, deps.fetchFn),
      fetchMarkPrice(cfg.value.base, symbol, deps.fetchFn),
      fetchBookTicker(cfg.value.base, symbol, deps.fetchFn),
    ]);
    if (!filters.ok) return refused(`exchangeInfo: ${filters.error}`);
    if (!book.ok) return refused(`bookTicker: ${book.error} (the post-only levels are priced against the best bid and ask).`);

    const built = buildGridPlan({
      args: args2,
      filters: filters.value,
      markPrice,
      bestBid: book.value.bidPrice,
      bestAsk: book.value.askPrice,
    });
    if (!built.ok) return refused(built.error);
    const plan = built.value;
    record.exchange.push({ step: "exchangeInfo", filters: filters.value }, { step: "bookTicker", ...book.value }, { step: "markPrice", markPrice });

    const checks = gridChecks(plan, readGridLimits(deps.env));
    if (!checks.placeable) {
      return refused(`the grid was not placed: ${checks.failures.join(" ")} ${plan.warnings.join(" ")}`.trim());
    }

    const riskCfg = parseAccountRiskConfig(deps.env);
    if (!riskCfg.ok) return refused(riskCfg.error);
    const snapshot = await loadAccountRiskView({ client, cfg: riskCfg.value, now: deps.now });
    const view = snapshot.view;
    record.exchange.push({
      step: "account_risk",
      dayPnl: view.dayPnl,
      openPositions: view.positions.length,
      unprotected: view.unprotected.map((position) => position.symbol),
    });

    // The cap is on exposure, not on this one order: a resting entry is money the
    // account has already committed, and so is a pending stop-entry.
    const exposure = await readExposure({
      client,
      symbol,
      markPrice,
      prefetched: { account: snapshot.account, positionRisk: snapshot.positionRisk, algoOrders: snapshot.algoOrders },
    });
    record.exchange.push({
      step: "exposure",
      openNotionalUsd: exposure.symbolNotionalUsd,
      accountOpenNotionalUsd: exposure.openNotionalUsd,
      openPositions: exposure.openPositions,
      pendingSymbols: exposure.pendingSymbols,
      restingOrders: exposure.restingOrders.length,
      errors: exposure.errors,
    });
    const guard = checkGridPlan(plan, guardLimitsFrom(cfg.value), {
      dayPnl: view.dayPnl,
      openPositions: exposure.openPositions,
      unprotectedSymbols: view.unprotected.map((position) => position.symbol),
      openNotionalUsd: exposure.symbolNotionalUsd,
      pendingSymbols: exposure.pendingSymbols,
    }, cfg.value.maxLeverage, decimalNumber(filters.value.minNotional));
    record.guard = guard;
    if (!guard.allow) return refused(`the order guard rejected this grid: ${guard.reasons.join(" ")}`);

    const prelude = await applyLeverageAndMargin(client, symbol, cfg.value.maxLeverage);
    record.exchange.push({ step: "leverage", response: prelude.leverage }, { step: "marginType", response: prelude.margin });

    // The exchange's own liquidation estimate, read from the worst level the
    // stop is measured from: a grid stop closer than the liquidation price never
    // fires, because the position is liquidated first.
    const liquidation = await fetchLiquidationInputs(client, {
      symbol,
      side: plan.direction === "long" ? "BUY" : "SELL",
      referencePrice: decimalNumber(plan.worstLevel.price),
      leverage: cfg.value.maxLeverage,
    });
    const estimate = readLiquidationEstimate({
      positionRisk: liquidation.positionRisk,
      leverageBracket: liquidation.leverageBracket,
      symbol,
      side: plan.direction === "long" ? "BUY" : "SELL",
      referencePrice: decimalNumber(plan.worstLevel.price),
      leverage: cfg.value.maxLeverage,
    });
    record.exchange.push({ step: "liquidation", ...estimate });
    const insideLiquidation = stopInsideLiquidation({
      side: plan.direction === "long" ? "BUY" : "SELL",
      entryPrice: decimalNumber(plan.worstLevel.price),
      stopPrice: decimalNumber(plan.stopPrice),
      estimate,
    });
    if (!insideLiquidation.ok) {
      return refused(`the grid was not placed: ${insideLiquidation.reason ?? "the stop is not inside the liquidation estimate"}`);
    }

    const placed: unknown[] = [];
    let filledQuantity = 0;

    const rejected: { level: number; price: string; error: string }[] = [];
    for (const level of plan.levels) {
      const outcome = await postOnlyLevel(client, {
        symbol,
        level,
        filters: filters.value,
        stopPrice: plan.stopPrice,
        direction: plan.direction,
        record,
      });
      if (!outcome.ok) {
        rejected.push({ level: level.index, price: level.price, error: outcome.error ?? "unknown" });
        break;
      }
      placed.push(outcome.order);
      // A level that filled is already exposure: the grid is not finished, but
      // the account is on the hook, and the report has to say so.
      if (outcome.filled && outcome.filledQty != null) filledQuantity = Number((filledQuantity + outcome.filledQty).toFixed(12));
    }
    const failure = rejected[0];
    if (failure) {
      const aborted = await emergencyClose(client, filters.value, symbol, record);
      return refused(
        `level ${failure.level} at ${failure.price} could not be rested as a post-only order (${failure.error}). The grid was not placed. ${describeFlatten(aborted)}.`,
      );
    }

    const stop = await placeProtectiveStop(client, plan, record);
    if (!stop.ok) {
      const aborted = await emergencyClose(client, filters.value, symbol, record);
      return refused(
        `the protective stop ${plan.direction === "long" ? "below" : "above"} the grid failed after ${STOP_ATTEMPTS} attempts (${stop.error}). The grid was cancelled. ${describeFlatten(aborted)}.`,
      );
    }

    return ok({
      network: cfg.value.network,
      planId: plan.planId,
      symbol,
      direction: plan.direction,
      leverage: cfg.value.maxLeverage,
      marginMode: "ISOLATED",
      orders: placed,
      levelCount: placed.length,
      filledQuantity,
      totalQuantity: plan.totalQuantity,
      totalNotionalUsd: plan.totalNotionalUsd,
      worstCaseLossUsd: plan.worstCaseLossUsd,
      stop: {
        type: "STOP_MARKET",
        side: plan.stopSide,
        stopPrice: plan.stopPrice,
        direction: plan.direction === "long" ? "below the range" : "above the range",
        workingType: "MARK_PRICE",
        closePosition: true,
        algoService: "/fapi/v1/algoOrder",
        algoId: stop.algoId ?? null,
        priceProtect: true,
        triggerPrice: plan.stopPrice,
        response: stop.response,
      },
      warnings: plan.warnings,
      journal: cfg.value.journalPath,
      sent: true,
      note: `The grid was sent to ${cfg.value.network} as ${placed.length} post-only limit orders plus one STOP_MARKET. Nothing else was sent.`,
    });
  }));
}

/**
 * The grid's protective stop: one STOP_MARKET through the Algo Service, accepted
 * only when the exchange echoes an algoId and a trigger on the loss side of the
 * WORST level, which is the level the stop is measured from.
 */
async function placeProtectiveStop(client: TradingClient, plan: GridPlan, record: JournalRecord): Promise<StopOutcome> {
  const outcome = await placeProtectiveAlgoOrder(client, {
    symbol: plan.symbol,
    side: plan.stopSide,
    kind: "STOP_MARKET",
    triggerPrice: plan.stopPrice,
    referencePrice: decimalNumber(plan.worstLevel.price),
    attempts: STOP_ATTEMPTS,
    journal: record,
    label: "protective_stop",
  });
  return outcome.ok ? { ok: true, response: outcome.response, algoId: outcome.algoId } : { ok: false, error: outcome.error };
}

interface StopOutcome {
  ok: boolean;
  response?: unknown;
  algoId?: number;
  error?: string;
}

interface LevelOutcome {
  ok: boolean;
  order?: unknown;
  /** The clientOrderId of the order that is actually resting, when it failed. */
  clientOrderId?: string;
  /** True when the level filled: the grid already has exposure. */
  filled?: boolean;
  filledQty?: number;
  error?: string;
}

/**
 * Places one grid level as a post-only LIMIT.
 *
 * Three rules, in order of how much damage breaking them does:
 *
 *  1. the level counts as placed only when the exchange answers NEW. An EXPIRED
 *     or REJECTED answer with an executedQty means it filled in the same instant
 *     it was rejected, and that quantity has to be reported, not repriced away;
 *  2. a reprice only happens when the answer is actually repriceable (-5022, an
 *     EXPIRED post-only, "would immediately match"), never on a balance error,
 *     a filter error or a timeout;
 *  3. a reprice never crosses the protective stop. Repricing a BUY below the
 *     stop puts an entry order on the far side of the exit: it would be filled
 *     only after the position was already stopped out.
 *
 * A timeout is resolved by querying the order by clientOrderId before anything
 * is retried, because retrying blind doubles the level.
 */async function postOnlyLevel(
  client: TradingClient,
  input: { symbol: string; level: GridLevel; filters: SymbolFilters; stopPrice: string; direction: "long" | "short"; record: JournalRecord },
): Promise<LevelOutcome> {
  const level = input.level;
  const stopNumber = decimalNumber(input.stopPrice);
  const beyondStop = (price: string): boolean =>
    input.direction === "long" ? decimalNumber(price) <= stopNumber : decimalNumber(price) >= stopNumber;
  let price = level.price;
  let clientOrderId = newClientOrderId();
  let lastSent = clientOrderId;
  for (let attempt = 1; attempt <= POST_ONLY_ATTEMPTS; attempt += 1) {
    lastSent = clientOrderId;
    if (beyondStop(price)) {
      return {
        ok: false,
        error: `the reprice ${price} would cross the protective stop ${input.stopPrice}: the level cannot be rested closer to the stop.`,
      };
    }
    try {
      const order = await client.placeOrder({
        symbol: input.symbol,
        side: level.side,
        type: "LIMIT",
        timeInForce: "GTX",
        quantity: level.quantity,
        price,
        clientOrderId,
      });
      input.record.exchange.push({ step: `level_${level.index}_${attempt}`, response: order });
      const filled = filledQuantityOf(order);
      if (filled > 0) return { ok: true, order, filled: true, filledQty: filled };
      if (orderStatusOf(order) === "NEW") return { ok: true, order, filled: false };
      // EXPIRED, REJECTED or an unlabelled status with no fill: reprice only if
      // the exchange actually said so.
    } catch (err) {
      const message = redactSecrets(errorMessage(err), []);
      input.record.exchange.push({ step: `level_${level.index}_${attempt}`, error: message });
      if (isAmbiguousError(err)) {
        // A timeout: resolve it before anything is retried.
        try {
          const found = await client.queryOrder(input.symbol, clientOrderId);
          input.record.exchange.push({ step: `level_${level.index}_query`, response: found });
          const filled = filledQuantityOf(found);
          if (filled > 0) return { ok: true, order: found, filled: true, filledQty: filled };
          if (isFinalStatus(orderStatusOf(found))) return { ok: false, error: message };
        } catch (queryError) {
          input.record.exchange.push({ step: `level_${level.index}_query`, error: redactSecrets(errorMessage(queryError), []) });
        }
        return { ok: false, error: `${message}; the lookup by clientOrderId did not settle it, so the level was not retried.` };
      }
      if (!isRepriceable(err)) return { ok: false, error: message };
    }
    const next = repriceAway(price, input.filters.tickSize, level.side);
    if (next == null) {
      return {
        ok: false,
        error: `level ${level.index} at ${price} could not be rested and cannot be repriced further (tickSize ${input.filters.tickSize}).`,
      };
    }
    price = next;
    clientOrderId = newClientOrderId();
  }
  return {
    ok: false,
    error: `level ${level.index} could not be rested after ${POST_ONLY_ATTEMPTS} attempts.`,
    clientOrderId: lastSent,
  };
}

/** Moves a post-only price one tick away from the book so the next attempt rests. */
export function repriceAway(price: string, tickSize: string, side: GuardSide): string | null {
  const moved = shiftStep(price, tickSize, side === "BUY" ? -1 : 1);
  return moved != null && decimalNumber(moved) > 0 ? moved : null;
}
