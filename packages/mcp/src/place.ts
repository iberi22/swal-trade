// place_order and close_position.
//
// The order of operations is the safety property, so it is written down here:
//
//   1. read the flag, the caps and the keys;
//   2. make sure the write can be journaled (no audit trail, no order);
//   3. read the account with the same signed GETs account_risk uses, and run the
//      order guard against it;
//   4. read the exchange filters and the market, round quantity to stepSize and
//      MIN_NOTIONAL, and price to tickSize;
//   5. set leverage and ISOLATED margin;
//   6. send the entry;
//   7. send the protective STOP_MARKET through the Algo Service. If it fails
//      twice, the position is closed with a MARKET reduceOnly order and the tool
//      reports an error: an open position is never left without a stop.
//
// close_position is the exception to the guard: closing is protective, so the
// daily-loss lock and the position cap must not be able to trap a position open.

import { decimalNumber, floorToStep, shiftStep } from "./decimal.js";
import { parseAccountRiskConfig, readCredentials } from "./config.js";
import { fetchBookTicker, fetchSymbolFilters } from "./exchange.js";
import { fetchMarkPrice } from "./market-data.js";
import { loadAccountRiskView } from "./account.js";
import { checkOrder } from "./order-guard.js";
import type { GuardDecision } from "./order-guard.js";
import { normalizeSide } from "./propose.js";
import { normalizeSymbol } from "./symbol.js";
import { parseTradingConfig } from "./trading-config.js";
import { createTradingClient } from "./trade-client.js";
import type { TradingClient } from "./trade-client.js";
import { BinanceError, isRepriceable } from "./trade-client.js";
import {
  applyLeverageAndMargin,
  emergencyClose,
  guardLimitsFrom,
  ok,
  refused,
  requireJournal,
  stopPriceTowardEntry,
  takeProfitAwayFromEntry,
  withJournal,
} from "./write.js";
import type { JournalRecord, ToolOutcome, WriteDeps } from "./write.js";
import { redactSecrets, errorMessage } from "./types.js";

export type OrderTypeInput = "market" | "post_only";

export interface PlaceOrderArgs {
  symbol: string;
  side: string;
  notional_usd: number;
  stop_loss_pct: number;
  take_profit_pct?: number;
  leverage?: number;
  type?: OrderTypeInput;
}

export interface ClosePositionArgs {
  symbol: string;
}

/** Attempts for a post-only entry before giving up and cancelling. */
const POST_ONLY_ATTEMPTS = 3;
/** Attempts for the protective stop before the fail-closed exit. */
const STOP_ATTEMPTS = 2;

interface EntryOutcome {
  ok: boolean;
  order?: unknown;
  /** Aligned limit price of a resting post-only order. */
  price?: string;
  error?: string;
  resting?: boolean;
}

/** One labeled exchange response, appended to the journaled record. */
function logStep(journal: JournalRecord, step: string, value: unknown): void {
  journal.exchange.push({ step, ...(typeof value === "object" && value !== null ? (value as Record<string, unknown>) : { value }) });
}

/**
 * Reprices a post-only order one tick away from the book so the next attempt
 * rests. The shift is done in decimal space: 99999.9 - 0.1 in binary floating
 * point is 99999.79999999, which floors to the wrong tick.
 */
function repriceAway(price: string, tickSize: string, side: "BUY" | "SELL"): string | null {
  const moved = shiftStep(price, tickSize, side === "BUY" ? -1 : 1);
  return moved != null && decimalNumber(moved) > 0 ? moved : null;
}

async function postOnlyEntry(
  client: TradingClient,
  input: { symbol: string; side: "BUY" | "SELL"; quantity: string; price: string; tickSize: string },
  journal: JournalRecord,
): Promise<EntryOutcome> {
  let price = input.price;
  for (let attempt = 1; attempt <= POST_ONLY_ATTEMPTS; attempt += 1) {
    const aligned = floorToStep(price, input.tickSize);
    if (aligned == null) return { ok: false, error: `price ${price} cannot be aligned to tickSize ${input.tickSize}.` };
    try {
      const order = await client.placeOrder({
        symbol: input.symbol,
        side: input.side,
        type: "LIMIT",
        timeInForce: "GTX",
        quantity: input.quantity,
        price: aligned,
      });
      logStep(journal, `entry_post_only_${attempt}`, order);
      const status = typeof order === "object" && order !== null && "status" in order ? String((order as { status: unknown }).status) : "";
      if (status === "NEW" || status === "PARTIALLY_FILLED" || status === "FILLED") {
        return { ok: true, order, price: aligned, resting: status === "NEW" };
      }
      // EXPIRED or REJECTED: reprice away from the book and try again.
    } catch (err) {
      const message = redactSecrets(errorMessage(err), []);
      logStep(journal, `entry_post_only_${attempt}`, { error: message });
      if (!isRepriceable(err)) return { ok: false, error: message };
    }
    const next = repriceAway(price, input.tickSize, input.side);
    if (next == null) return { ok: false, error: `the post-only ${input.side} at ${price} could not be rested and cannot be repriced further.` };
    price = next;
  }
  return { ok: false, error: `the post-only ${input.side} order could not be rested after ${POST_ONLY_ATTEMPTS} attempts.` };
}

interface StopOutcome {
  ok: boolean;
  response?: unknown;
  error?: string;
}

async function placeProtectiveStop(
  client: TradingClient,
  input: { symbol: string; side: "BUY" | "SELL"; stopPrice: string },
  journal: JournalRecord,
): Promise<StopOutcome> {
  let lastError = "unknown error";
  for (let attempt = 1; attempt <= STOP_ATTEMPTS; attempt += 1) {
    try {
      const response = await client.placeAlgoOrder({
        symbol: input.symbol,
        side: input.side,
        type: "STOP_MARKET",
        algoType: "CONDITIONAL",
        workingType: "MARK_PRICE",
        closePosition: "true",
        price: input.stopPrice,
        timeInForce: "GTC",
      });
      logStep(journal, `protective_stop_${attempt}`, response);
      return { ok: true, response };
    } catch (err) {
      lastError = redactSecrets(errorMessage(err), []);
      logStep(journal, `protective_stop_${attempt}`, { error: lastError });
    }
  }
  return { ok: false, error: lastError };
}

/**
 * Places one entry order with a mandatory protective stop.
 */
export async function placeOrder(deps: WriteDeps, args: PlaceOrderArgs): Promise<ToolOutcome> {
  const request = {
    symbol: args.symbol,
    side: args.side,
    notional_usd: args.notional_usd,
    stop_loss_pct: args.stop_loss_pct,
    take_profit_pct: args.take_profit_pct ?? null,
    leverage: args.leverage ?? 1,
    type: args.type ?? "market",
  };
  return withJournal(deps, "place_order", request, async (journal) => {
    const cfg = parseTradingConfig(deps.env);
    if (!cfg.ok) return refused(cfg.error);
    journal.network = cfg.value.network;
    const credentials = readCredentials(deps.env);
    if (!credentials.ok) return refused(credentials.error);

    const symbol = normalizeSymbol(args.symbol);
    if (!symbol) return refused("symbol must be 2 to 30 letters or digits.");
    const side = normalizeSide(args.side);
    if (!side) return refused("side must be BUY, SELL, LONG, or SHORT.");
    const orderType: OrderTypeInput = args.type === "post_only" ? "post_only" : "market";
    const notionalUsd = Number(args.notional_usd);
    const stopLossPct = Number(args.stop_loss_pct);
    const leverage = Number(args.leverage ?? 1);
    const takeProfitPct = args.take_profit_pct == null ? null : Number(args.take_profit_pct);

    const journalError = await requireJournal(deps, cfg.value.journalPath);
    if (journalError) return refused(journalError);

    const client = createTradingClient({
      apiKey: credentials.value.apiKey,
      apiSecret: credentials.value.apiSecret,
      fetchFn: deps.fetchFn,
      now: deps.now,
      base: cfg.value.base,
    });
    await client.syncTime();

    const riskCfg = parseAccountRiskConfig(deps.env);
    if (!riskCfg.ok) return refused(riskCfg.error);
    const view = await loadAccountRiskView({ client, cfg: riskCfg.value, now: deps.now });
    logStep(journal, "account_risk", {
      dayPnl: view.dayPnl,
      openPositions: view.positions.length,
      unprotected: view.unprotected.map((position) => position.symbol),
    });

    const guard: GuardDecision = checkOrder(
      { symbol, side, notionalUsd, stopLossPct, takeProfitPct, leverage, orderType },
      guardLimitsFrom(cfg.value),
      {
        dayPnl: view.dayPnl,
        openPositions: view.positions.length,
        unprotectedSymbols: view.unprotected.map((position) => position.symbol),
      },
    );
    journal.guard = guard;
    if (!guard.allow) return refused(`the order guard rejected this order: ${guard.reasons.join(" ")}`);

    const filters = await fetchSymbolFilters(cfg.value.base, symbol, deps.fetchFn);
    if (!filters.ok) return refused(`exchangeInfo: ${filters.error}`);
    logStep(journal, "exchangeInfo", filters.value);
    const markPrice = await fetchMarkPrice(cfg.value.base, symbol, deps.fetchFn);
    logStep(journal, "markPrice", { markPrice });

    let entryPrice = markPrice;
    let bookPrice = String(markPrice);
    if (orderType === "post_only") {
      const book = await fetchBookTicker(cfg.value.base, symbol, deps.fetchFn);
      if (!book.ok) return refused(`bookTicker: ${book.error} (a post-only order is priced at the best bid or ask).`);
      entryPrice = decimalNumber(side === "BUY" ? book.value.bidPrice : book.value.askPrice);
      bookPrice = side === "BUY" ? book.value.bidPrice : book.value.askPrice;
      logStep(journal, "bookTicker", book.value);
      if (!(entryPrice > 0)) return refused("the best bid or ask is not a usable price for a post-only order.");
    }

    const quantity = floorToStep(notionalUsd / entryPrice, filters.value.stepSize);
    if (quantity == null) return refused(`quantity for ${notionalUsd} USD cannot be aligned to stepSize ${filters.value.stepSize}.`);
    const quantityNumber = decimalNumber(quantity);
    const minQty = decimalNumber(filters.value.minQty);
    if (quantityNumber < minQty) {
      return refused(`quantity ${quantity} is below the exchange minQty ${filters.value.minQty}: raise notional_usd.`);
    }
    const effectiveNotional = quantityNumber * entryPrice;
    const minNotional = decimalNumber(filters.value.minNotional);
    if (minNotional > 0 && effectiveNotional < minNotional) {
      return refused(`order notional ${effectiveNotional.toFixed(4)} USD is below the exchange MIN_NOTIONAL ${filters.value.minNotional} USD: raise notional_usd.`);
    }

    const factor = stopLossPct / 100;
    const rawStop = side === "BUY" ? entryPrice * (1 - factor) : entryPrice * (1 + factor);
    const stopPrice = stopPriceTowardEntry(rawStop, filters.value.tickSize, side);
    if (stopPrice == null) return refused(`stop ${rawStop} cannot be aligned to tickSize ${filters.value.tickSize}.`);
    const stopNumber = decimalNumber(stopPrice);
    if (side === "BUY" ? !(stopNumber < entryPrice) : !(stopNumber > entryPrice)) {
      return refused(`the stop rounds to ${stopPrice}, which is not on the loss side of the entry price ${entryPrice}: the stop distance is smaller than one tickSize.`);
    }

    let takeProfitPrice: string | null = null;
    if (takeProfitPct != null) {
      const rawTp = side === "BUY" ? entryPrice * (1 + takeProfitPct / 100) : entryPrice * (1 - takeProfitPct / 100);
      const aligned = takeProfitAwayFromEntry(rawTp, filters.value.tickSize, side);
      if (aligned == null) return refused(`take profit ${rawTp} cannot be aligned to tickSize ${filters.value.tickSize}.`);
      const alignedNumber = decimalNumber(aligned);
      if (side === "BUY" ? !(alignedNumber > entryPrice) : !(alignedNumber < entryPrice)) {
        return refused(`the take profit rounds to ${aligned}, which is not on the profit side of the entry price ${entryPrice}: the distance is smaller than one tickSize.`);
      }
      takeProfitPrice = aligned;
    }

    const prelude = await applyLeverageAndMargin(client, symbol, leverage);
    logStep(journal, "leverage", prelude.leverage);
    logStep(journal, "marginType", prelude.margin);

    let entry: EntryOutcome;
    if (orderType === "post_only") {
      entry = await postOnlyEntry(client, { symbol, side, quantity, price: bookPrice, tickSize: filters.value.tickSize }, journal);
      if (!entry.ok) {
        // Nothing filled: cancel anything resting and report. No position, so no
        // stop was needed and the fail-closed exit is only a cleanup.
        try {
          logStep(journal, "cancel_after_failed_entry", await client.cancelAllOpenOrders(symbol));
        } catch (err) {
          logStep(journal, "cancel_after_failed_entry", { error: redactSecrets(errorMessage(err), []) });
        }
        return refused(`the order was not sent: ${entry.error}`);
      }
    } else {
      try {
        const order = await client.placeOrder({ symbol, side, type: "MARKET", quantity });
        logStep(journal, "entry_market", order);
        entry = { ok: true, order };
      } catch (err) {
        const message = redactSecrets(errorMessage(err), []);
        logStep(journal, "entry_market", { error: message });
        return refused(`the entry order was rejected by the exchange: ${message}`);
      }
    }

    const stop = await placeProtectiveStop(client, { symbol, side: side === "BUY" ? "SELL" : "BUY", stopPrice }, journal);
    if (!stop.ok) {
      const aborted = await emergencyClose(client, filters.value, symbol, journal);
      const closed = aborted.closeOrder
        ? "the position was closed with a MARKET reduceOnly order"
        : `the position could not be closed automatically (${aborted.closeError ?? "no position was open"}): MANUAL ACTION REQUIRED`;
      return refused(`the protective stop failed after ${STOP_ATTEMPTS} attempts (${stop.error}); ${closed}.`);
    }

    let takeProfitResponse: unknown = null;
    let takeProfitWarning: string | null = null;
    if (takeProfitPrice != null) {
      try {
        takeProfitResponse = await client.placeAlgoOrder({
          symbol,
          side: side === "BUY" ? "SELL" : "BUY",
          type: "TAKE_PROFIT_MARKET",
          algoType: "CONDITIONAL",
          workingType: "MARK_PRICE",
          closePosition: "true",
          price: takeProfitPrice,
          timeInForce: "GTC",
        });
        logStep(journal, "take_profit", takeProfitResponse);
      } catch (err) {
        takeProfitWarning = redactSecrets(errorMessage(err instanceof BinanceError ? err.msg : err), []);
        logStep(journal, "take_profit", { error: takeProfitWarning });
      }
    }

    return ok({
      network: cfg.value.network,
      symbol,
      side,
      orderType,
      entryPrice,
      quantity,
      effectiveNotionalUsd: Number(effectiveNotional.toFixed(4)),
      requestedNotionalUsd: notionalUsd,
      leverage,
      marginMode: "ISOLATED",
      entry: entry.order,
      resting: entry.resting ?? false,
      restingPrice: entry.price ?? null,
      stop: {
        type: "STOP_MARKET",
        side: side === "BUY" ? "SELL" : "BUY",
        stopPrice,
        stopLossPct,
        workingType: "MARK_PRICE",
        closePosition: true,
        algoService: "/fapi/v1/algoOrder",
        response: stop.response,
      },
      takeProfit: takeProfitPrice ? { takeProfitPct, price: takeProfitPrice, response: takeProfitResponse, warning: takeProfitWarning } : null,
      warnings: takeProfitWarning ? [`the take profit was not placed: ${takeProfitWarning}`] : [],
      journal: cfg.value.journalPath,
      sent: true,
      note: `The entry and its protective stop were sent to ${cfg.value.network}. Nothing else was sent.`,
    });
  });
}

/**
 * Closes a position: MARKET reduceOnly plus the cancellation of the symbol's open
 * orders and open algo orders. This is a reduction, so the daily-loss lock and
 * the position cap do not apply: trapping a position open would be the opposite
 * of protection.
 */
export async function closePosition(deps: WriteDeps, args: ClosePositionArgs): Promise<ToolOutcome> {
  const request = { symbol: args.symbol };
  return withJournal(deps, "close_position", request, async (journal) => {
    const cfg = parseTradingConfig(deps.env);
    if (!cfg.ok) return refused(cfg.error);
    journal.network = cfg.value.network;
    const credentials = readCredentials(deps.env);
    if (!credentials.ok) return refused(credentials.error);
    const symbol = normalizeSymbol(args.symbol);
    if (!symbol) return refused("symbol must be 2 to 30 letters or digits.");

    const journalError = await requireJournal(deps, cfg.value.journalPath);
    if (journalError) return refused(journalError);

    const client = createTradingClient({
      apiKey: credentials.value.apiKey,
      apiSecret: credentials.value.apiSecret,
      fetchFn: deps.fetchFn,
      now: deps.now,
      base: cfg.value.base,
    });
    await client.syncTime();

    const filters = await fetchSymbolFilters(cfg.value.base, symbol, deps.fetchFn);
    if (!filters.ok) return refused(`exchangeInfo: ${filters.error}`);
    logStep(journal, "exchangeInfo", filters.value);

    const risk: unknown = await client.positionRisk();
    logStep(journal, "positionRisk", Array.isArray(risk) ? { rows: risk.length } : risk);
    let amount: number | null = null;
    if (Array.isArray(risk)) {
      for (const row of risk) {
        if (typeof row === "object" && row !== null && "symbol" in row && row.symbol === symbol) {
          const value = Number((row as { positionAmt: unknown }).positionAmt);
          amount = Number.isFinite(value) ? value : null;
        }
      }
    }
    const notes: string[] = [];
    if (amount == null) notes.push(`positionRisk has no row for ${symbol}: treated as no open position.`);

    let closeOrder: unknown = null;
    if (amount != null && amount !== 0) {
      const quantity = floorToStep(Math.abs(amount), filters.value.stepSize);
      if (quantity == null || decimalNumber(quantity) <= 0) {
        notes.push(`the position ${amount} rounds to zero at stepSize ${filters.value.stepSize}: it cannot be closed with one order.`);
      } else {
        try {
          closeOrder = await client.placeOrder({
            symbol,
            side: amount > 0 ? "SELL" : "BUY",
            type: "MARKET",
            quantity,
            reduceOnly: "true",
          });
          logStep(journal, "close_market_reduce_only", closeOrder);
        } catch (err) {
          const message = redactSecrets(errorMessage(err), []);
          logStep(journal, "close_market_reduce_only", { error: message });
          return refused(`the reduceOnly close order was rejected by the exchange: ${message}. The position may still be open.`);
        }
      }
    } else {
      notes.push(`there was no open position for ${symbol}: only the open orders were cancelled.`);
    }

    let cancelledOrders: unknown = null;
    try {
      cancelledOrders = await client.cancelAllOpenOrders(symbol);
      logStep(journal, "cancel_all_open_orders", cancelledOrders);
    } catch (err) {
      const message = redactSecrets(errorMessage(err), []);
      logStep(journal, "cancel_all_open_orders", { error: message });
      notes.push(`the open orders could not be cancelled: ${message}`);
    }
    let cancelledAlgo: unknown = null;
    try {
      cancelledAlgo = await client.cancelAlgoOrders(symbol);
      logStep(journal, "cancel_algo_orders", cancelledAlgo);
    } catch (err) {
      const message = redactSecrets(errorMessage(err), []);
      logStep(journal, "cancel_algo_orders", { error: message });
      notes.push(`the open algo orders could not be cancelled: ${message}`);
    }

    return ok({
      network: cfg.value.network,
      symbol,
      positionQuantity: amount,
      closeOrder,
      cancelledOrders,
      cancelledAlgoOrders: cancelledAlgo,
      notes,
      journal: cfg.value.journalPath,
      sent: closeOrder != null,
      note: `The position was closed on ${cfg.value.network} with a MARKET reduceOnly order and the symbol's open orders and algo orders were cancelled. Nothing else was sent.`,
    });
  });
}
