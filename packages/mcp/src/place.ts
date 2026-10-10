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

import { ceilToStep, decimalNumber, floorToStep, shiftStep, toDecimalText } from "./decimal.js";
import { parseAccountRiskConfig, readCredentials } from "./config.js";
import { fetchBookTicker, fetchSymbolFilters } from "./exchange.js";
import { fetchMarkPrice } from "./market-data.js";
import { loadAccountRiskView, netPosition, readExposure } from "./account.js";
import { checkOrder } from "./order-guard.js";
import type { GuardDecision } from "./order-guard.js";
import { normalizeSide } from "./propose.js";
import { normalizeSymbol } from "./symbol.js";
import { parseCloseConfig, parseTradingConfig } from "./trading-config.js";
import { createTradingClient } from "./trade-client.js";
import type { TradingClient } from "./trade-client.js";
import { isAmbiguousError, isRepriceable, newClientOrderId } from "./trade-client.js";
import { fetchLiquidationInputs, readLiquidationEstimate, stopInsideLiquidation } from "./liquidation.js";
import {
  applyLeverageAndMargin,
  averagePriceOf,
  describeFlatten,
  emergencyClose,
  filledQuantityOf,
  flattenPosition,
  guardLimitsFrom,
  isFinalStatus,
  logStep,
  ok,
  orderStatusOf,
  placeProtectiveAlgoOrder,
  refused,
  requireJournal,
  ensureStartupSweep,
  stopPriceTowardEntry,
  sweepWarnings,
  takeProfitAwayFromEntry,
  withJournal,
  withWriteLock,
  writeJournalLine,
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
/** Attempts for a protective algo order before the fail-closed exit. */
const STOP_ATTEMPTS = 2;

interface EntryOutcome {
  ok: boolean;
  order?: unknown;
  /** Aligned limit price of a resting post-only order. */
  price?: string;
  /** The clientOrderId the entry was sent with: the only way to resolve a timeout. */
  clientOrderId?: string;
  error?: string;
  resting?: boolean;
  /** True when the entry filled (fully or partially): a position exists. */
  filled?: boolean;
  filledQty?: number;
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
  input: { symbol: string; side: "BUY" | "SELL"; quantity: string; price: string; tickSize: string; clientOrderId: string },
  journal: JournalRecord,
): Promise<EntryOutcome> {
  let price = input.price;
  let clientOrderId = input.clientOrderId;
  // The id of the order that is actually resting right now. A cancelled attempt
  // is replaced, so this is what a cleanup has to target.
  let lastSent = input.clientOrderId;
  for (let attempt = 1; attempt <= POST_ONLY_ATTEMPTS; attempt += 1) {
    lastSent = clientOrderId;
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
        clientOrderId,
      });
      logStep(journal, `entry_post_only_${attempt}`, order);
      const status = orderStatusOf(order);
      const filled = filledQuantityOf(order);
      if (status === "NEW" || status === "PARTIALLY_FILLED") {
        // EXPIRED or -5022 does not always mean "nothing happened": a GTX limit
        // can fill in the same instant it is rejected, and the answer carries the
        // executedQty. A filled quantity means a position exists, so it must be
        // protected instead of repriced.
        if (filled > 0) return { ok: true, order, price: aligned, clientOrderId, filled: true, filledQty: filled, resting: false };
        return { ok: true, order, price: aligned, clientOrderId, filled: false, resting: true };
      }
      if (status === "FILLED") return { ok: true, order, price: aligned, clientOrderId, filled: true, filledQty: filled > 0 ? filled : decimalNumber(input.quantity) };
      // EXPIRED, REJECTED or a status the exchange did not label: read the
      // executedQty before assuming nothing happened.
      if (filled > 0) return { ok: true, order, price: aligned, clientOrderId, filled: true, filledQty: filled };
    } catch (err) {
      const message = redactSecrets(errorMessage(err), []);
      logStep(journal, `entry_post_only_${attempt}`, { error: message });
      if (isAmbiguousError(err)) {
        // A timeout on a post-only entry: resolve it before retrying, otherwise
        // a second order doubles the position.
        const resolution = await resolveEntry(client, { symbol: input.symbol, side: input.side, clientOrderId, entryPrice: decimalNumber(aligned), quantity: input.quantity }, journal);
        if (resolution.filledQty > 0) {
          return { ok: true, order: resolution.order, price: aligned, clientOrderId, filled: true, filledQty: resolution.filledQty };
        }
      }
      if (!isRepriceable(err)) return { ok: false, error: message };
    }
    const next = repriceAway(price, input.tickSize, input.side);
    if (next == null) return { ok: false, error: `the post-only ${input.side} at ${price} could not be rested and cannot be repriced further.`, clientOrderId: lastSent };
    price = next;
    // A new id per attempt, so a lookup resolves THIS order and not the previous
    // one, and the cancel at the end targets what is actually resting.
    clientOrderId = newClientOrderId();
  }
  return { ok: false, clientOrderId: lastSent, error: `the post-only ${input.side} order could not be rested after ${POST_ONLY_ATTEMPTS} attempts.` };
}

interface StopOutcome {
  ok: boolean;
  response?: unknown;
  algoId?: number;
  error?: string;
}

/**
 * True (set) when a fill exceeded the notional cap by the tolerance and the
 * excess was reduced on the exchange. Set inside the tool, read by
 * `entryPayload`, which is why it lives at module scope: it is written and read
 * inside one awaited call chain, never across two.
 */
let excessNotionalReduced: number | null = null;

/** The success payload of place_order, in one shape for every path that reaches it. */
function entryPayload(input: {
  cfg: { network: string; journalPath: string };
  symbol: string;
  side: "BUY" | "SELL";
  orderType: OrderTypeInput;
  entryPrice: number;
  quantity: string;
  effectiveNotionalUsd: number;
  notionalUsd: number;
  leverage: number;
  entry: unknown;
  filledQty: number;
  stopPrice: string;
  stopLossPct: number;
  stopResponse: unknown;
  resting: boolean;
  restingPrice: string | null;
  journal: JournalRecord;
  warnings: string[];
  takeProfit?: unknown;
  ambiguous?: boolean;
  /** What the startup sweep found, when it found anything. */
  startupSweep?: unknown;
}): Record<string, unknown> {
  const warnings = [...input.warnings];
  if (excessNotionalReduced != null) {
    warnings.push(
      `the fill exceeded SWAL_MAX_NOTIONAL_USD by ${excessNotionalReduced.toFixed(4)} USD and the excess was reduced with a MARKET reduceOnly order.`,
    );
  }
  const filledNotional = input.filledQty > 0 && averagePriceOf(input.entry) != null
    ? Number(((averagePriceOf(input.entry) as number) * input.filledQty).toFixed(4))
    : input.effectiveNotionalUsd;
  return {
    network: input.cfg.network,
    symbol: input.symbol,
    side: input.side,
    orderType: input.orderType,
    entryPrice: input.entryPrice,
    quantity: input.quantity,
    effectiveNotionalUsd: input.effectiveNotionalUsd,
    filledQuantity: input.filledQty,
    filledNotionalUsd: filledNotional,
    requestedNotionalUsd: input.notionalUsd,
    leverage: input.leverage,
    marginMode: "ISOLATED",
    entry: input.entry,
    resting: input.resting,
    restingPrice: input.restingPrice,
    ambiguousOutcome: input.ambiguous ?? false,
    stop: {
      type: "STOP_MARKET",
      side: input.side === "BUY" ? "SELL" : "BUY",
      stopPrice: input.stopPrice,
      stopLossPct: input.stopLossPct,
      workingType: "MARK_PRICE",
      priceProtect: true,
      closePosition: true,
      algoService: "/fapi/v1/algoOrder",
      response: input.stopResponse,
    },
    takeProfit: input.takeProfit ?? null,
    startupSweep: input.startupSweep ?? null,
    warnings,
    journal: input.cfg.journalPath,
    sent: true,
    note: `The entry and its protective stop were sent to ${input.cfg.network}. Nothing else was sent.`,
  };
}

/**
 * Cancels whatever this tool has resting on the symbol, by clientOrderId when
 * there is one. `allOpenOrders` would also cancel another tool's orders: the
 * mutex serializes this process, but the user may have placed orders by hand.
 */
async function cancelEntry(client: TradingClient, clientOrderId: string | null, symbol: string, journal: JournalRecord): Promise<void> {
  try {
    const result =
      clientOrderId != null
        ? await client.cancelOrder(symbol, clientOrderId)
        : await client.cancelAllOpenOrders(symbol);
    logStep(journal, "cancel_after_failed_entry", result);
  } catch (err) {
    logStep(journal, "cancel_after_failed_entry", { error: redactSecrets(errorMessage(err), []) });
  }
}

/**
 * Resolves an ambiguous entry answer: look the order up by clientOrderId, then
 * read the net position. Either one proving a fill is enough, because an order
 * can be filled and cancelled from the query window but still leave a position.
 */
async function resolveEntry(
  client: TradingClient,
  input: { symbol: string; side: "BUY" | "SELL"; clientOrderId: string; entryPrice: number; quantity: string },
  journal: JournalRecord,
): Promise<{ filledQty: number; order: unknown }> {
  let order: unknown = null;
  try {
    const found = await client.queryOrder(input.symbol, input.clientOrderId);
    logStep(journal, "query_by_client_order_id", found);
    order = found;
    const status = orderStatusOf(found);
    const filled = filledQuantityOf(found);
    if (filled > 0 || status === "FILLED") return { filledQty: filled > 0 ? filled : Number(input.quantity), order: found };
    if (isFinalStatus(status)) return { filledQty: filled, order: found };
  } catch (err) {
    logStep(journal, "query_by_client_order_id", { error: redactSecrets(errorMessage(err), []) });
  }
  // Not settled by the lookup: read the position, which is the ground truth.
  try {
    const risk = await client.positionRisk();
    const net = netPosition(risk, input.symbol);
    logStep(journal, "position_after_ambiguous_entry", { net: net.amount, rows: net.rows, error: net.error });
    if (net.error == null && net.amount != null && net.amount !== 0) {
      return { filledQty: Math.abs(net.amount), order };
    }
  } catch (err) {
    logStep(journal, "position_after_ambiguous_entry", { error: redactSecrets(errorMessage(err), []) });
  }
  return { filledQty: 0, order };
}

async function placeProtectiveStop(
  client: TradingClient,
  input: { symbol: string; side: "BUY" | "SELL"; stopPrice: string; entryPrice: number; journal: JournalRecord },
): Promise<StopOutcome> {
  const outcome = await placeProtectiveAlgoOrder(client, {
    symbol: input.symbol,
    side: input.side,
    kind: "STOP_MARKET",
    triggerPrice: input.stopPrice,
    referencePrice: input.entryPrice,
    attempts: STOP_ATTEMPTS,
    journal: input.journal,
    label: "protective_stop",
  });
  return outcome.ok ? { ok: true, response: outcome.response, algoId: outcome.algoId } : { ok: false, error: outcome.error };
}

async function placeTakeProfit(
  client: TradingClient,
  input: { symbol: string; side: "BUY" | "SELL"; takeProfitPrice: string; entryPrice: number; journal: JournalRecord },
): Promise<{ ok: boolean; response?: unknown; algoId?: number; error?: string }> {
  return placeProtectiveAlgoOrder(client, {
    symbol: input.symbol,
    side: input.side,
    kind: "TAKE_PROFIT_MARKET",
    triggerPrice: input.takeProfitPrice,
    referencePrice: input.entryPrice,
    // One attempt: an answer that fails validation with the same parameters
    // fails again, and every extra attempt is another order on the exchange.
    attempts: 1,
    journal: input.journal,
    label: "take_profit",
  });
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
  return withWriteLock(deps, () => withJournal(deps, "place_order", request, async (journal) => {
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

    // Whatever the previous process left behind: an entry journaled as an intent
    // whose outcome never arrived is a position nobody is watching, and opening
    // a new one on top of it is how an unprotected position becomes two.
    const sweep = await ensureStartupSweep(deps);
    const sweepAlerts = sweepWarnings(sweep);
    for (const alert of sweepAlerts) logStep(journal, "startup_sweep", { warning: alert });

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
    const snapshot = await loadAccountRiskView({ client, cfg: riskCfg.value, now: deps.now });
    const view = snapshot.view;
    const viewAccount = snapshot.account;
    const viewPositionRisk = snapshot.positionRisk;
    const viewAlgoOrders = snapshot.algoOrders;
    logStep(journal, "account_risk", {
      dayPnl: view.dayPnl,
      openPositions: view.positions.length,
      unprotected: view.unprotected.map((position) => position.symbol),
    });

    // The whitelist, the notional, the leverage and the stop are all checks that
    // need no exchange call: doing them first means a symbol the user has not
    // whitelisted never reaches exchangeInfo at all.
    const preGuard = checkOrder({ symbol, side, notionalUsd, stopLossPct, takeProfitPct, leverage, orderType }, guardLimitsFrom(cfg.value), {
      dayPnl: view.dayPnl,
      openPositions: 0,
      unprotectedSymbols: [],
      openNotionalUsd: 0,
      pendingSymbols: [],
    });
    journal.guard = preGuard;
    if (!preGuard.allow) {
      const offline = preGuard.reasons.filter((reason) => !/daily-loss lock|max open positions|exposure|has no STOP_MARKET|already committed/.test(reason));
      if (offline.length === preGuard.reasons.length) {
        return refused(`the order guard rejected this order: ${preGuard.reasons.join(" ")}`);
      }
    }

    const filters = await fetchSymbolFilters(cfg.value.base, symbol, deps.fetchFn);
    if (!filters.ok) return refused(`exchangeInfo: ${filters.error}`);
    logStep(journal, "exchangeInfo", filters.value);
    const markPrice = await fetchMarkPrice(cfg.value.base, symbol, deps.fetchFn);
    logStep(journal, "markPrice", { markPrice });

    // The cap is on exposure, not on this one order: a resting entry is money the
    // account has already committed, and so is a pending stop-entry.
    const exposure = await readExposure({
      client,
      symbol,
      markPrice,
      prefetched: { account: viewAccount, positionRisk: viewPositionRisk, algoOrders: viewAlgoOrders },
    });
    logStep(journal, "exposure", {
      openNotionalUsd: exposure.symbolNotionalUsd,
      accountOpenNotionalUsd: exposure.openNotionalUsd,
      openPositions: exposure.openPositions,
      pendingSymbols: exposure.pendingSymbols,
      restingOrders: exposure.restingOrders.length,
      errors: exposure.errors,
    });
    const guard: GuardDecision = checkOrder(
      { symbol, side, notionalUsd, stopLossPct, takeProfitPct, leverage, orderType },
      guardLimitsFrom(cfg.value),
      {
        dayPnl: view.dayPnl,
        openPositions: exposure.openPositions,
        unprotectedSymbols: view.unprotected.map((position) => position.symbol),
        openNotionalUsd: exposure.symbolNotionalUsd,
        pendingSymbols: exposure.pendingSymbols,
      },
    );
    journal.guard = guard;
    if (!guard.allow) return refused(`the order guard rejected this order: ${guard.reasons.join(" ")}`);

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

    // The exchange's own liquidation estimate, not the textbook 100/leverage:
    // positionRisk after the leverage was set, or the maintenance margin ratio of
    // the leverage bracket. A stop beyond that fires after the liquidation.
    const liquidation = await fetchLiquidationInputs(client, { symbol, side, referencePrice: entryPrice, leverage });
    const estimate = readLiquidationEstimate({
      positionRisk: liquidation.positionRisk,
      leverageBracket: liquidation.leverageBracket,
      symbol,
      side,
      referencePrice: entryPrice,
      leverage,
    });
    logStep(journal, "liquidation", estimate);
    const insideLiquidation = stopInsideLiquidation({ side, entryPrice, stopPrice: stopNumber, estimate });
    if (!insideLiquidation.ok) {
      return refused(`the entry was not sent: ${insideLiquidation.reason ?? "the stop is not inside the liquidation estimate"}`);
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

    // The intent is journaled BEFORE the entry is sent: a line that only exists
    // after the exchange answered cannot prove that an ambiguous answer (a
    // timeout, a reset) left a position behind, which is exactly the case the
    // startup sweep has to find.
    const clientOrderId = newClientOrderId();
    const intentFailure = await writeJournalLine(deps, cfg.value.journalPath, {
      ts: new Date(deps.now()).toISOString(),
      event: "place_order_intent",
      network: cfg.value.network,
      symbol,
      side,
      orderType,
      clientOrderId,
      quantity,
      entryPrice,
      notionalUsd,
      stopLossPct,
      leverage,
    });
    if (intentFailure) {
      return refused(`the intent could not be journaled (${intentFailure}): the order was not sent because an ambiguous outcome could not be reconstructed.`);
    }
    const writeOutcome = async (extra: Record<string, unknown>): Promise<void> => {
      const failure = await writeJournalLine(deps, cfg.value.journalPath, {
        ts: new Date(deps.now()).toISOString(),
        event: "place_order_outcome",
        network: cfg.value.network,
        symbol,
        clientOrderId,
        ...extra,
      });
      if (failure) logStep(journal, "journal_outcome", { error: failure });
    };

    let entry: EntryOutcome;
    if (orderType === "post_only") {
      entry = await postOnlyEntry(
        client,
        { symbol, side, quantity, price: bookPrice, tickSize: filters.value.tickSize, clientOrderId },
        journal,
      );
      if (!entry.ok) {
        // Nothing filled: cancel anything resting by clientOrderId and report. No
        // position, so no stop was needed and the fail-closed exit is a cleanup.
        await cancelEntry(client, entry.clientOrderId ?? clientOrderId, symbol, journal);
        await writeOutcome({ filled: false, error: entry.error });
        return refused(`the order was not sent: ${entry.error}`);
      }
    } else {
      try {
        const order = await client.placeOrder({ symbol, side, type: "MARKET", quantity, clientOrderId });
        logStep(journal, "entry_market", order);
        entry = { ok: true, order, clientOrderId, filled: true, filledQty: filledQuantityOf(order) };
      } catch (err) {
        const message = redactSecrets(errorMessage(err), []);
        logStep(journal, "entry_market", { error: message });
        // A network error, a timeout or a 5xx is NOT a rejection: the entry may
        // have been accepted. Resolve it by clientOrderId and by position before
        // reporting anything, so a fill is never left without a stop.
        if (isAmbiguousError(err)) {
          const resolution = await resolveEntry(client, { symbol, side, clientOrderId, entryPrice, quantity }, journal);
          if (resolution.filledQty > 0) {
            const stop = await placeProtectiveStop(client, { symbol, side: side === "BUY" ? "SELL" : "BUY", stopPrice, entryPrice, journal });
            if (!stop.ok) {
              const aborted = await emergencyClose(client, filters.value, symbol, journal);
              await writeOutcome({ filled: true, filledQty: resolution.filledQty, stopPlaced: false, error: stop.error });
              return refused(
                `the entry answer was ambiguous (${message}); ${describeFlatten(aborted)}. The protective stop failed after ${STOP_ATTEMPTS} attempts (${stop.error}).`,
              );
            }
            await writeOutcome({ filled: true, filledQty: resolution.filledQty, stopPlaced: true, order: resolution.order });
            return ok(entryPayload({
              cfg: cfg.value,
              symbol,
              side,
              orderType,
              entryPrice,
              quantity,
              effectiveNotionalUsd: Number(effectiveNotional.toFixed(4)),
              notionalUsd,
              leverage,
              entry: resolution.order,
              filledQty: resolution.filledQty,
              stopPrice,
              stopLossPct,
              stopResponse: stop.response,
              resting: false,
              restingPrice: null,
              journal,
              warnings: [...(sweepAlerts.length > 0 ? sweepAlerts : []), `the entry answer was ambiguous (${message}); it was resolved by clientOrderId and the position is protected.`],
              startupSweep: sweep.findings.length > 0 || sweep.errors.length > 0 ? sweep : null,
              ambiguous: true,
            }));
          }
          await writeOutcome({ filled: false, error: message });
          return refused(`the entry order could not be confirmed (${message}); the lookup by clientOrderId and the position read found no fill, so no stop was armed.`);
        }
        await writeOutcome({ filled: false, error: message });
        return refused(`the entry order was rejected by the exchange: ${message}`);
      }
    }

    // The entry filled (a MARKET answer, or a post-only order that came back
    // with an executedQty). The notional the account really carries is
    // avgPrice * executedQty: rounding can only move it against the cap, never
    // for us.
    if (entry.ok) {
      const fillQty = entry.filledQty ?? 0;
      const avg = averagePriceOf(entry.order) ?? entryPrice;
      const effectiveAfterFill = avg * fillQty;
      if (fillQty > 0 && effectiveAfterFill > Number(cfg.value.maxNotionalUsd) * 1.01) {
        // The excess is in USD, so it is converted to a quantity at the fill price
        // before it is rounded: rounding a USD amount to stepSize sends an order
        // of the wrong size.
        const excessQty = ceilToStep(toDecimalText((effectiveAfterFill - cfg.value.maxNotionalUsd) / avg), filters.value.stepSize);
        if (excessQty != null && decimalNumber(excessQty) > 0) {
          try {
            const reduction = await client.placeOrder({
              symbol,
              side: side === "BUY" ? "SELL" : "BUY",
              type: "MARKET",
              quantity: excessQty,
              reduceOnly: "true",
            });
            logStep(journal, "reduce_excess_notional", reduction);
            excessNotionalReduced = effectiveAfterFill - cfg.value.maxNotionalUsd;
          } catch (err) {
            logStep(journal, "reduce_excess_notional", { error: redactSecrets(errorMessage(err), []) });
          }
        }
      }
    }

    const stop = await placeProtectiveStop(client, { symbol, side: side === "BUY" ? "SELL" : "BUY", stopPrice, entryPrice, journal });
    if (!stop.ok) {
      const aborted = await emergencyClose(client, filters.value, symbol, journal);
      await writeOutcome({ filled: entry.filled ?? false, stopPlaced: false, error: stop.error });
      return refused(`the protective stop failed after ${STOP_ATTEMPTS} attempts (${stop.error}); ${describeFlatten(aborted)}.`);
    }

    let takeProfitResponse: unknown = null;
    let takeProfitWarning: string | null = null;
    if (takeProfitPrice != null) {
      const tp = await placeTakeProfit(client, {
        symbol,
        side: side === "BUY" ? "SELL" : "BUY",
        takeProfitPrice,
        entryPrice,
        journal,
      });
      if (tp.ok) {
        takeProfitResponse = tp.response;
      } else {
        takeProfitWarning = tp.error ?? "the take profit was not placed";
      }
    }
    await writeOutcome({ filled: entry.filled ?? false, stopPlaced: true });

    return ok(
      entryPayload({
        cfg: cfg.value,
        symbol,
        side,
        orderType,
        entryPrice,
        quantity,
        effectiveNotionalUsd: Number(effectiveNotional.toFixed(4)),
        notionalUsd,
        leverage,
        entry: entry.order,
        filledQty: entry.filledQty ?? 0,
        stopPrice,
        stopLossPct,
        stopResponse: stop.response,
        resting: entry.resting ?? false,
        restingPrice: entry.price ?? null,
        journal,
        warnings: [...(takeProfitWarning ? [`the take profit was not placed: ${takeProfitWarning}`] : []), ...sweepAlerts],
        startupSweep: sweep.findings.length > 0 || sweep.errors.length > 0 ? sweep : null,
        takeProfit: takeProfitPrice ? { takeProfitPct, price: takeProfitPrice, response: takeProfitResponse, warning: takeProfitWarning } : null,
      }),
    );
  }));
}

/**
 * Closes a position: MARKET reduceOnly plus the cancellation of the symbol's open
 * orders and open algo orders. This is a reduction, so the daily-loss lock and
 * the position cap do not apply: trapping a position open would be the opposite
 * of protection.
 */
export async function closePosition(deps: WriteDeps, args: ClosePositionArgs): Promise<ToolOutcome> {
  const request = { symbol: args.symbol };
  return withWriteLock(deps, () =>
    withJournal(deps, "close_position", request, async (journal) => {
      const cfg = parseCloseConfig(deps.env);
      if (!cfg.ok) return refused(cfg.error);
      journal.network = cfg.value.network;
      const credentials = readCredentials(deps.env);
      if (!credentials.ok) return refused(credentials.error);
      const symbol = normalizeSymbol(args.symbol);
      if (!symbol) return refused("symbol must be 2 to 30 letters or digits.");

      const journalError = await requireJournal(deps, cfg.value.journalPath);
      if (journalError) return refused(journalError);

      // A close is the natural moment to look for what a previous process left
      // behind: an entry journaled as an intent whose outcome never arrived.
      const sweep = await ensureStartupSweep(deps);
      const sweepAlerts = sweepWarnings(sweep);
      for (const alert of sweepAlerts) logStep(journal, "startup_sweep", { warning: alert });

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

      // Close first, report second. The position is read netting every
      // positionRisk row of the symbol (one-way BOTH, hedge LONG + SHORT), then
      // reduced with a MARKET reduceOnly order rounded UP to stepSize so the
      // whole remainder is covered, then read again: the loop repeats until the
      // net is zero. A single order sized from the first row leaves a leg open.
      const flatten = await flattenPosition(client, filters.value, symbol, journal);
      const notes: string[] = [];
      if (flatten.netBefore == null) {
        notes.push(`positionRisk had no row for ${symbol}: treated as no open position.`);
      } else if (flatten.netBefore === 0) {
        notes.push(`the net position of ${symbol} was already zero.`);
      } else if (flatten.flat) {
        notes.push(`${flatten.netBefore} of ${symbol} was closed with ${flatten.orders.length} MARKET reduceOnly order(s).`);
      }
      if (flatten.error) notes.push(flatten.error);
      if (flatten.dustNote) notes.push(flatten.dustNote);
      notes.push(...sweepAlerts);

      // The orders are cancelled only when the position is actually zero.
      // Cancelling first would remove the stop of a position that is still open.
      let cancelledOrders: unknown = null;
      let cancelledAlgo: unknown = null;
      if (!flatten.flat) {
        notes.push(
          `the open orders and algo orders of ${symbol} were NOT cancelled: the net position is ${flatten.remaining ?? "unknown"}, and cancelling them would leave an open position with no stop.`,
        );
      } else {
        try {
          cancelledOrders = await client.cancelAllOpenOrders(symbol);
          logStep(journal, "cancel_all_open_orders", cancelledOrders);
        } catch (err) {
          const message = redactSecrets(errorMessage(err), []);
          logStep(journal, "cancel_all_open_orders", { error: message });
          notes.push(`the open orders could not be cancelled: ${message}`);
        }
        try {
          cancelledAlgo = await client.cancelAlgoOrders(symbol);
          logStep(journal, "cancel_algo_orders", cancelledAlgo);
        } catch (err) {
          const message = redactSecrets(errorMessage(err), []);
          logStep(journal, "cancel_algo_orders", { error: message });
          notes.push(`the open algo orders could not be cancelled: ${message}`);
        }
      }

      const sent = flatten.orders.length > 0;
      // The note says exactly what happened: a position that could not be
      // closed must not be described as closed.
      const note = flatten.flat
        ? sent
          ? `The net position of ${symbol} was closed on ${cfg.value.network} with MARKET reduceOnly order(s)${cancelledOrders != null || cancelledAlgo != null ? " and its open orders and algo orders were cancelled" : ""}. Nothing else was sent.`
          : `There was no open net position for ${symbol}, so only the symbol's open orders and algo orders were cancelled.`
        : `The position of ${symbol} could NOT be closed (${flatten.error ?? flatten.dustNote ?? "unknown reason"}): ${flatten.remaining ?? "unknown"} is still open. The orders were deliberately NOT cancelled.`;

      return ok({
        network: cfg.value.network,
        symbol,
        positionQuantity: flatten.netBefore,
        remaining: flatten.remaining,
        flat: flatten.flat,
        closeOrders: flatten.orders,
        closeOrder: flatten.orders[flatten.orders.length - 1] ?? null,
        cancelledOrders,
        cancelledAlgoOrders: cancelledAlgo,
        startupSweep: sweep.findings.length > 0 || sweep.errors.length > 0 ? sweep : null,
        notes,
        journal: cfg.value.journalPath,
        sent,
        note,
      });
    }),
  );
}
