// Shared plumbing for the write tools.
//
// One place for the things every write has in common: the journaled record of
// what happened (including the intent written before the entry and the outcome
// written after it), the exchange prelude (leverage and isolated margin, set
// before the entry), the algo-order validation a protective stop has to pass,
// the flatten used to fail closed, and the mutex that keeps two tools from
// interleave-ing their reads and their orders.

import { redactSecrets, errorMessage } from "./types.js";
import type { FetchLike } from "./types.js";
import { appendJournal, assertJournalWritable } from "./journal.js";
import type { SymbolFilters } from "./exchange.js";
import type { TradingClient } from "./trade-client.js";
import { BinanceError, MARGIN_TYPE_ALREADY_SET } from "./trade-client.js";
import { ORDER_NOT_FOUND_CODE } from "./errors.js";
import type { GridPlanStore } from "./grid.js";
import { ceilToStep, floorToStep, decimalNumber } from "./decimal.js";
import { isRecord } from "./types.js";
import { netPosition } from "./account.js";
import type { TradingConfig } from "./trading-config.js";
import { journalPathOf, tradingEnabled } from "./trading-config.js";
import { createWriteMutex } from "./mutex.js";
import type { WriteMutex } from "./mutex.js";
import { runStartupSweep, startupFlattenEnabled } from "./sweep.js";
import type { SweepReport } from "./sweep.js";

export type ToolOutcome<T = unknown> = { ok: true; value: T } | { ok: false; error: string };

export const ok = <T>(value: T): ToolOutcome<T> => ({ ok: true, value });
export const refused = (error: string): ToolOutcome<never> => ({ ok: false, error });

/** Extra journal line, used for the intent and the outcome of one write. */
export type JournalAppender = (path: string, record: unknown, secrets: readonly string[]) => Promise<void>;

export interface WriteDeps {
  env: NodeJS.ProcessEnv;
  fetchFn: FetchLike;
  now: () => number;
  plans: GridPlanStore;
  /** Journal sink, overridable so a failing append can be tested. */
  append?: JournalAppender;
  /** Serializes every write tool: the guard is not atomic on its own. */
  writeLock?: WriteMutex;
  /**
   * The one-per-process startup sweep. The write path awaits it once, after the
   * preflight and before the guard, so whatever a previous process left behind
   * is known before a new position is opened. Memoized so the sweep runs once
   * per server, not once per tool call.
   */
  sweep?: { report: Promise<SweepReport> | null };
}

/**
 * Runs the startup sweep once per process and returns its report.
 *
 * The sweep is a read: it only flattens when the operator explicitly asked for
 * it with SWAL_MCP_STARTUP_FLATTEN=yes. It runs after the configuration, the
 * keys and the journal have been checked, so a misconfigured server never makes
 * an exchange call.
 */
export async function ensureStartupSweep(deps: WriteDeps): Promise<SweepReport> {
  if (!tradingEnabled(deps.env)) return { pending: [], findings: [], errors: [], flattenEnabled: false };
  const slot = (deps.sweep ??= { report: null });
  if (slot.report == null) {
    slot.report = runStartupSweep({ env: deps.env, fetchFn: deps.fetchFn, now: deps.now });
  }
  try {
    return await slot.report;
  } catch (err) {
    // A sweep that cannot run is reported, not silently dropped: the pending
    // intents are exactly the positions nobody is watching.
    return {
      pending: [],
      findings: [],
      errors: [redactSecrets(errorMessage(err), secretsOf(deps.env))],
      flattenEnabled: startupFlattenEnabled(deps.env),
    };
  }
}

/** A one-line warning for every unprotected position the sweep found. */
export function sweepWarnings(report: SweepReport): string[] {
  const warnings: string[] = [];
  for (const finding of report.findings) {
    warnings.push(
      `STARTUP SWEEP: ${finding.symbol} has ${finding.netPosition} open from an entry (clientOrderId ${finding.clientOrderId}) whose outcome was never journaled. ${finding.detail ?? "It was reported; nothing was changed."}`,
    );
  }
  for (const error of report.errors) warnings.push(`STARTUP SWEEP: ${error}`);
  return warnings;
}

/**
 * The lock every write tool falls back to when the caller did not inject one.
 *
 * It is a module-level singleton on purpose: a fresh mutex per call would
 * serialize nothing, which is worse than no lock because it looks like one.
 * Every write tool in this process shares it, so the reads, the guard decision,
 * the entry and the stop of one tool finish before the next one starts.
 */
const DEFAULT_WRITE_LOCK: WriteMutex = createWriteMutex();

/** Runs one write tool with the shared write lock held. */
export async function withWriteLock<T>(deps: WriteDeps, fn: () => Promise<T>): Promise<T> {
  return (deps.writeLock ?? DEFAULT_WRITE_LOCK).run(fn);
}

export interface JournalRecord {
  ts: string;
  event: string;
  network: string;
  request: unknown;
  guard: unknown;
  exchange: unknown[];
  result: unknown;
  error: string | null;
}

export function secretsOf(env: NodeJS.ProcessEnv): string[] {
  return [env.BINANCE_API_KEY, env.BINANCE_API_SECRET].flatMap((value) => (value ? [value, value.trim()] : []));
}

function logJournalFailure(path: string, err: unknown): void {
  try {
    const message = redactSecrets(errorMessage(err), []);
    process.stderr.write(`swal-trade: could not append to the journal ${path}: ${message}\n`);
  } catch {
    // stderr is best effort; never turn a journal failure into a crash.
  }
}

/**
 * Runs one write tool inside a journaled record. The record is written exactly
 * once, whatever happens: a refusal, an exchange error and a success all leave a
 * line, because an audit trail that only records successes is not one. An
 * append that fails AFTER the order was sent is surfaced in the result as a
 * warning: it cannot be undone, and hiding it would leave the operator believing
 * the write was recorded.
 */
export async function withJournal<T>(
  deps: WriteDeps,
  event: string,
  request: unknown,
  run: (record: JournalRecord) => Promise<ToolOutcome<T>>,
): Promise<ToolOutcome<T>> {
  const record: JournalRecord = {
    ts: new Date(deps.now()).toISOString(),
    event,
    network: deps.env.SWAL_MCP_NETWORK?.trim().toLowerCase() || "testnet",
    request,
    guard: null,
    exchange: [],
    result: null,
    error: null,
  };
  const secrets = secretsOf(deps.env);
  const journalPath = journalPathOf(deps.env);
  let outcome: ToolOutcome<T>;
  try {
    outcome = await run(record);
  } catch (err) {
    const message = redactSecrets(errorMessage(err), secrets);
    record.error = message;
    outcome = refused(message);
  }
  record.result = outcome.ok ? outcome.value : null;
  record.error = outcome.ok ? null : outcome.error;
  try {
    await (deps.append ?? appendJournal)(journalPath, record, secrets);
  } catch (err) {
    logJournalFailure(journalPath, err);
    if (outcome.ok) outcome = { ok: true, value: withJournalWarning(outcome.value, journalPath, err) };
  }
  return outcome;
}

/** Adds the journal warning to a successful result without dropping its shape. */
function withJournalWarning<T>(value: T, journalPath: string, err: unknown): T {
  const message = `the order was sent but the journal ${journalPath} could not be appended (${redactSecrets(errorMessage(err), [])}): this write is NOT in the audit trail`;
  if (isRecord(value)) {
    const out = { ...value } as Record<string, unknown> & { journalWarning?: string; warnings?: unknown };
    out.journalWarning = message;
    if (Array.isArray(out.warnings)) out.warnings = [...out.warnings, message];
    else out.warnings = [message];
    return out as T;
  }
  return value;
}

/** Writes one extra journal line (intent, outcome). The caller decides what a failure means. */
export async function writeJournalLine(deps: WriteDeps, journalPath: string, record: unknown): Promise<string | null> {
  try {
    await (deps.append ?? appendJournal)(journalPath, record, secretsOf(deps.env));
    return null;
  } catch (err) {
    return redactSecrets(errorMessage(err), secretsOf(deps.env));
  }
}

/** Fail-closed preflight: no writable journal, no order. */
export async function requireJournal(deps: WriteDeps, journalPath: string): Promise<string | null> {
  try {
    await assertJournalWritable(journalPath);
    return null;
  } catch (err) {
    return `the journal at ${journalPath} is not a writable regular file (${redactSecrets(errorMessage(err), secretsOf(deps.env))}); the order was not sent because it could not be audited.`;
  }
}

export interface MarginPrelude {
  leverage: unknown;
  margin: unknown;
}

/**
 * Sets leverage and ISOLATED margin on the exchange before the entry. An
 * "already ISOLATED" answer is not a failure: the margin mode is what we want.
 */
export async function applyLeverageAndMargin(client: TradingClient, symbol: string, leverage: number): Promise<MarginPrelude> {
  const leverageResponse = await client.setLeverage(symbol, leverage);
  let margin: unknown;
  try {
    margin = await client.setMarginType(symbol, "ISOLATED");
  } catch (err) {
    if (err instanceof BinanceError && err.code === MARGIN_TYPE_ALREADY_SET) {
      margin = { code: MARGIN_TYPE_ALREADY_SET, msg: "already ISOLATED", accepted: true };
    } else {
      throw err;
    }
  }
  return { leverage: leverageResponse, margin };
}

// ---------------------------------------------------------------------------
// Protective algo orders: what is sent, and what an answer has to prove.
// ---------------------------------------------------------------------------

export interface AlgoStopParams {
  symbol: string;
  side: "BUY" | "SELL";
  type: "STOP_MARKET" | "TAKE_PROFIT_MARKET";
  /** The trigger, NOT `price`: the algo service ignores a price on these types. */
  triggerPrice: string;
}

/**
 * The body of one protective algo order.
 *
 * `triggerPrice` and not `price`: sending `price` on a STOP_MARKET is one of the
 * two ways the exchange answers 400 ("Param 'price' or 'stopPrice' sent when not
 * required"), and the other way is worse: the order is accepted with no trigger
 * at all, so it never fires and the position is left bare. `priceProtect=TRUE`
 * makes sure the mark price, not the last trade, triggers it.
 */
export function algoStopBody(params: AlgoStopParams): Record<string, string> {
  return {
    symbol: params.symbol,
    side: params.side,
    algoType: "CONDITIONAL",
    type: params.type,
    triggerPrice: params.triggerPrice,
    workingType: "MARK_PRICE",
    priceProtect: "TRUE",
    closePosition: "true",
    timeInForce: "GTC",
  };
}

/** The trigger the exchange echoed back, in any of the shapes it uses. */
export function echoedTrigger(response: unknown): number | null {
  if (!isRecord(response)) return null;
  for (const key of ["triggerPrice", "stopPrice", "trigger"]) {
    const value = response[key];
    const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

export function algoIdOf(response: unknown): number | null {
  if (!isRecord(response)) return null;
  const value = response.algoId;
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export type StopValidation = { accepted: true; algoId: number } | { accepted: false; reason: string };

export type ProtectiveKind = "STOP_MARKET" | "TAKE_PROFIT_MARKET";

export interface ProtectiveOutcome {
  ok: boolean;
  kind: ProtectiveKind;
  response?: unknown;
  /** The algoId the exchange echoed back, when it did. */
  algoId?: number;
  error?: string;
}

/** Appends one labeled exchange response to a journaled record. */
export function logStep(journal: JournalRecord, step: string, value: unknown): void {
  journal.exchange.push({ step, ...(typeof value === "object" && value !== null ? (value as Record<string, unknown>) : { value }) });
}

/**
 * Sends one protective algo order and only accepts it when the exchange proved
 * it is live: an algoId in the answer plus a trigger echoed back on the side of
 * the reference price that this order is supposed to fire on.
 *
 * A `stop` has to trigger on the LOSS side (a stop above a long entry fires
 * after the profit); a take profit has to trigger on the PROFIT side. An answer
 * without one of those is not a protective order, so the caller has to treat
 * the position as unprotected.
 */
export async function placeProtectiveAlgoOrder(
  client: TradingClient,
  input: {
    symbol: string;
    /** The side that closes the position. */
    side: "BUY" | "SELL";
    kind: ProtectiveKind;
    triggerPrice: string;
    /** Entry price (or worst level) the trigger is measured against. */
    referencePrice: number;
    attempts?: number;
    journal: JournalRecord;
    label: string;
  },
): Promise<ProtectiveOutcome> {
  const attempts = input.attempts ?? 2;
  let lastError = "unknown error";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await client.placeAlgoOrder(
        algoStopBody({ symbol: input.symbol, side: input.side, type: input.kind, triggerPrice: input.triggerPrice }),
      );
      const verdict = validateStopResponse({
        response,
        side: input.side,
        referencePrice: input.referencePrice,
        kind: input.kind,
      });
      if (verdict.accepted) {
        logStep(input.journal, `${input.label}_${attempt}`, { ok: true, algoId: verdict.algoId, response });
        return { ok: true, kind: input.kind, response, algoId: verdict.algoId };
      }
      lastError = verdict.reason;
      logStep(input.journal, `${input.label}_${attempt}`, { rejected: verdict.reason, response });
    } catch (err) {
      lastError = redactSecrets(errorMessage(err), []);
      logStep(input.journal, `${input.label}_${attempt}`, { error: lastError });
    }
  }
  return { ok: false, kind: input.kind, error: lastError };
}

/**
 * A protective algo order counts as placed only when the exchange answered with
 * an algoId AND echoed a trigger on the side of the reference price that this
 * order has to fire on. Anything else (no algoId, no trigger, or a trigger on
 * the wrong side) is a stop that is not protecting anything, and the position
 * has to be closed rather than left bare.
 */
export function validateStopResponse(input: {
  response: unknown;
  /** The side that closes the position: SELL closes a long, BUY closes a short. */
  side: "BUY" | "SELL";
  referencePrice: number;
  kind: ProtectiveKind;
}): StopValidation {
  const algoId = algoIdOf(input.response);
  if (algoId == null) {
    return { accepted: false, reason: `the algo order answer for ${input.kind} carries no algoId, so no stop is live on the exchange` };
  }
  const trigger = echoedTrigger(input.response);
  if (trigger == null) {
    return {
      accepted: false,
      reason: `the algo order answer for ${input.kind} carries no triggerPrice, so the exchange has no price to fire on`,
    };
  }
  const belowReference = input.side === "SELL";
  const required = input.kind === "STOP_MARKET" ? belowReference : !belowReference;
  const onRequiredSide = required ? trigger < input.referencePrice : trigger > input.referencePrice;
  if (!onRequiredSide) {
    const wanted = input.kind === "STOP_MARKET" ? "loss" : "profit";
    return {
      accepted: false,
      reason: `the algo order answer for ${input.kind} echoed a trigger of ${trigger}, which is not on the ${wanted} side of the reference ${input.referencePrice}`,
    };
  }
  return { accepted: true, algoId };
}

// ---------------------------------------------------------------------------
// Flattening: read the net position, reduce it, re-read it.
// ---------------------------------------------------------------------------

/** Close attempts before the remainder is reported instead of retried. */
export const FLATTEN_ATTEMPTS = 3;

export interface FlattenReport {
  /** Net quantity read before the first close order, or null when there was no row. */
  netBefore: number | null;
  /** Close orders actually sent. */
  orders: unknown[];
  /** Net quantity still open after the last attempt. */
  remaining: number | null;
  /** True when the net position is zero. */
  flat: boolean;
  /** Why it could not be flattened, when it could not. */
  error: string | null;
  /** Dust left below minQty: the exchange will not accept an order for it. */
  dustNote: string | null;
}

/**
 * Closes a position: MARKET reduceOnly for the full remaining net size, then a
 * re-read to confirm. The quantity is rounded UP to stepSize so the whole
 * remainder is covered; the remainder is then re-read, and a loop repeats until
 * it is zero or below the exchange minQty, which is reported instead of being
 * silently ignored.
 *
 * The position is read netting EVERY row of the symbol (one-way BOTH, or hedge
 * LONG + SHORT): taking the first row of a hedge pair closes one leg and leaves
 * the other open.
 */
export async function flattenPosition(client: TradingClient, filters: SymbolFilters, symbol: string, record?: JournalRecord): Promise<FlattenReport> {
  const report: FlattenReport = { netBefore: null, orders: [], remaining: null, flat: false, error: null, dustNote: null };
  const minQty = decimalNumber(filters.minQty);
  for (let attempt = 1; attempt <= FLATTEN_ATTEMPTS; attempt += 1) {
    let risk: unknown;
    try {
      risk = await client.positionRisk();
    } catch (err) {
      report.error = redactSecrets(errorMessage(err), []);
      break;
    }
    const net = netPosition(risk, symbol);
    if (attempt === 1) report.netBefore = net.amount;
    if (net.error) {
      report.error = net.error;
      break;
    }
    if (net.amount == null || net.amount === 0) {
      report.flat = true;
      report.remaining = 0;
      break;
    }
    report.remaining = net.amount;
    const quantity = ceilToStep(Math.abs(net.amount), filters.stepSize);
    if (quantity == null || decimalNumber(quantity) <= 0) {
      report.error = `the net position ${net.amount} rounds to zero at stepSize ${filters.stepSize}: it cannot be closed with one order.`;
      break;
    }
    if (decimalNumber(quantity) < minQty) {
      report.dustNote = `${net.amount} of ${symbol} is below the exchange minQty ${filters.minQty}: the exchange will not accept an order for it, so it stays open.`;
      break;
    }
    try {
      const order = await client.placeOrder({
        symbol,
        side: net.amount > 0 ? "SELL" : "BUY",
        type: "MARKET",
        quantity,
        reduceOnly: "true",
      });
      report.orders.push(order);
      if (record) record.exchange.push({ step: `flatten_${attempt}`, response: order });
    } catch (err) {
      report.error = redactSecrets(errorMessage(err), []);
      break;
    }
  }
  if (record) {
    record.exchange.push({
      step: "flatten_report",
      netBefore: report.netBefore,
      remaining: report.remaining,
      flat: report.flat,
      error: report.error,
    });
  }
  return report;
}

export interface EmergencyCloseReport {
  flatten: FlattenReport;
  cancelledOrders: unknown;
  cancelledAlgoOrders: unknown;
  /** True only when the position is flat AND the cancellations were attempted. */
  done: boolean;
}

/**
 * One sentence, exactly as wide as what happened.
 *
 * A failed flatten says so in capitals: a caller that reads "the position was
 * closed" when it was not is a position nobody is watching. When nothing was
 * open, the sentence says that instead of implying a close that never happened.
 */
export function describeFlatten(aborted: EmergencyCloseReport): string {
  if (aborted.flatten.flat) {
    return aborted.flatten.orders.length > 0
      ? "the position was closed with a MARKET reduceOnly order and its orders were cancelled"
      : "there was no open position to close and the symbol's orders were cancelled";
  }
  const why = aborted.flatten.error ?? aborted.flatten.dustNote ?? "the position could not be closed";
  return `the position could NOT be closed automatically (${why}; ${aborted.flatten.remaining ?? "unknown"} still open): MANUAL ACTION REQUIRED`;
}

/**
 * Fail-closed exit for an open position: flatten first, cancel second.
 *
 * The order is deliberate. Cancelling the protective orders before the flatten
 * succeeded leaves an open position with no stop and no exit: if the flatten is
 * rejected (insufficient balance, a reduceOnly conflict) the account is now
 * naked. So the position is reduced and re-read, and the orders are cancelled
 * only once the net position is zero.
 */
export async function emergencyClose(
  client: TradingClient,
  filters: SymbolFilters,
  symbol: string,
  record: JournalRecord,
): Promise<EmergencyCloseReport> {
  const flatten = await flattenPosition(client, filters, symbol, record);
  const report: EmergencyCloseReport = { flatten, cancelledOrders: null, cancelledAlgoOrders: null, done: false };
  if (!flatten.flat) {
    record.exchange.push({
      step: "emergency_close",
      flat: false,
      remaining: flatten.remaining,
      error: flatten.error ?? flatten.dustNote ?? "the position could not be closed",
      cancelledOrders: "not attempted: the position is not flat, so the orders were left in place",
      cancelledAlgoOrders: "not attempted: the position is not flat, so the orders were left in place",
    });
    return report;
  }
  try {
    report.cancelledOrders = await client.cancelAllOpenOrders(symbol);
  } catch (err) {
    report.cancelledOrders = { error: redactSecrets(errorMessage(err), []) };
  }
  try {
    report.cancelledAlgoOrders = await client.cancelAlgoOrders(symbol);
  } catch (err) {
    report.cancelledAlgoOrders = { error: redactSecrets(errorMessage(err), []) };
  }
  report.done = true;
  record.exchange.push({ step: "emergency_close", flat: true, ...report });
  return report;
}

/** Stop price rounded toward the entry, so rounding can only tighten the stop. */
export function stopPriceTowardEntry(rawStop: number, tickSize: string, side: "BUY" | "SELL"): string | null {
  return side === "BUY" ? ceilToStep(rawStop, tickSize) : floorToStep(rawStop, tickSize);
}

/** Take-profit price rounded away from the entry, so rounding cannot skip it. */
export function takeProfitAwayFromEntry(rawTp: number, tickSize: string, side: "BUY" | "SELL"): string | null {
  return side === "BUY" ? ceilToStep(rawTp, tickSize) : floorToStep(rawTp, tickSize);
}

/** Builds the guard inputs shared by place_order and grid_place. */
export function guardLimitsFrom(cfg: TradingConfig) {
  return {
    symbols: cfg.symbols,
    maxNotionalUsd: cfg.maxNotionalUsd,
    maxLeverage: cfg.maxLeverage,
    maxOpenPositions: cfg.maxOpenPositions,
    dailyLossUsd: cfg.dailyLossUsd,
  };
}

/** True when a lookup by clientOrderId answered "no such order". */
export function isOrderNotFound(err: unknown): boolean {
  return err instanceof BinanceError && err.code === ORDER_NOT_FOUND_CODE;
}

/** Reads the quantity actually filled out of any order response. */
export function filledQuantityOf(order: unknown): number {
  if (!isRecord(order)) return 0;
  const raw = order.executedQty ?? order.executed_qty;
  const parsed = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Average fill price of an order response, or null when the exchange did not send one. */
export function averagePriceOf(order: unknown): number | null {
  if (!isRecord(order)) return null;
  const raw = order.avgPrice ?? order.averagePrice ?? order.price;
  const parsed = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function orderStatusOf(order: unknown): string | null {
  if (!isRecord(order) || typeof order.status !== "string") return null;
  // An empty or blank status is the exchange not labelling the order: reading it
  // as a status would let an unlabelled answer pass as a real one.
  return order.status.trim().length > 0 ? order.status : null;
}

/** Final statuses: after one of these nothing else will happen to the order. */
export function isFinalStatus(status: string | null): boolean {
  return status != null && ["FILLED", "CANCELED", "CANCELLED", "REJECTED", "EXPIRED"].includes(status);
}

export { createWriteMutex };
export type { WriteMutex };
