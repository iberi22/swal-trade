// Startup sweep: what the previous process left behind.
//
// A process that dies between sending an entry and recording its outcome leaves
// exactly one trace: an `intent` journal line with no matching `outcome` line.
// That combination is not proof of a position, so the sweep does not assume
// one; it asks the exchange. If the exchange says the position is there, the
// sweep reports it as UNPROTECTED and, only when the operator explicitly opted
// in with SWAL_MCP_STARTUP_FLATTEN=yes, flattens it.
//
// Reporting is the default because flattening is a write: an account the user is
// holding by hand could have been closed deliberately, and a sweep that closes
// positions on its own would take that decision away. The default is therefore
// "say so loudly", not "act".

import { readFile } from "node:fs/promises";

import { fetchSymbolFilters } from "./exchange.js";
import { readCredentials } from "./config.js";
import { normalizeSymbol } from "./symbol.js";
import { journalPathOf, tradingEnabled } from "./trading-config.js";
import { createTradingClient } from "./trade-client.js";
import type { TradingClient } from "./trade-client.js";
import { netPosition } from "./account.js";
import { describeFlatten, flattenPosition } from "./write.js";
import { errorMessage, isRecord, redactSecrets } from "./types.js";
import type { FetchLike } from "./types.js";

/** The env var that turns a report into an action. */
export const STARTUP_FLATTEN_ENV = "SWAL_MCP_STARTUP_FLATTEN";

export interface UnprotectedIntent {
  clientOrderId: string;
  symbol: string;
  side: string;
  quantity: string;
  notionalUsd: number;
  leverage: number;
}

export interface SweepFinding extends UnprotectedIntent {
  /** Net position the exchange reports, or null when it could not be read. */
  netPosition: number | null;
  /** What the sweep did about it. */
  action: "reported" | "flattened" | "flatten-failed" | "unknown";
  detail: string | null;
}

export interface SweepReport {
  /** Intents found without an outcome. */
  pending: UnprotectedIntent[];
  /** Of those, the ones with an open position on the exchange. */
  findings: SweepFinding[];
  /** Sources that could not be read. */
  errors: string[];
  /** True when the operator opted into flattening. */
  flattenEnabled: boolean;
}

export function startupFlattenEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env[STARTUP_FLATTEN_ENV] ?? "").trim().toLowerCase() === "yes";
}

/**
 * Reads the journal and returns the intents whose outcome was never written.
 *
 * A line that cannot be parsed is skipped rather than failing the sweep: one
 * truncated line (a crash mid-append) must not hide every other intent behind
 * it. The same applies to a journal that no longer exists: nothing was written,
 * so nothing is pending.
 */
export function findUnprotectedIntents(rows: readonly unknown[]): UnprotectedIntent[] {
  const intents = new Map<string, UnprotectedIntent>();
  const resolved = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const event = typeof row.event === "string" ? row.event : "";
    const id = typeof row.clientOrderId === "string" ? row.clientOrderId : "";
    if (!id) continue;
    if (event === "place_order_intent") {
      intents.set(id, {
        clientOrderId: id,
        symbol: typeof row.symbol === "string" ? row.symbol : "",
        side: typeof row.side === "string" ? row.side : "",
        quantity: typeof row.quantity === "string" ? row.quantity : "0",
        notionalUsd: typeof row.notionalUsd === "number" ? row.notionalUsd : 0,
        leverage: typeof row.leverage === "number" ? row.leverage : 1,
      });
    } else if (event === "place_order_outcome") {
      resolved.add(id);
    }
  }
  return [...intents.values()].filter((intent) => !resolved.has(intent.clientOrderId) && intent.symbol.length > 0);
}

/** Reads a JSONL journal, returning [] when it does not exist or cannot be read. */
export async function readJournalRows(journalPath: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(journalPath, "utf8");
  } catch {
    return [];
  }
  const rows: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      rows.push(JSON.parse(line) as unknown);
    } catch {
      // One truncated line must not hide the rest of the trail.
    }
  }
  return rows;
}

export interface SweepInput {
  env: NodeJS.ProcessEnv;
  fetchFn: FetchLike;
  now: () => number;
  /** Pre-read journal rows, so a test does not have to write a file. */
  rows?: readonly unknown[];
  /** Pre-read pending intents, so a test can skip the journal entirely. */
  intents?: readonly UnprotectedIntent[];
}

/**
 * Asks the exchange about every intent whose outcome is missing.
 *
 * The reads are the same signed GETs the rest of the client uses, so the sweep
 * needs the same keys. A read that fails is reported, not treated as "no
 * position": an unknown position is the case the sweep exists for.
 */
export async function runStartupSweep(input: SweepInput): Promise<SweepReport> {
  const report: SweepReport = {
    pending: [],
    findings: [],
    errors: [],
    flattenEnabled: startupFlattenEnabled(input.env),
  };
  if (!tradingEnabled(input.env)) return report;

  const rows = input.rows ?? (await readJournalRows(journalPathOf(input.env)));
  const intents = input.intents ?? findUnprotectedIntents(rows);
  report.pending = [...intents];
  if (report.pending.length === 0) return report;

  const credentials = readCredentials(input.env);
  if (!credentials.ok) {
    report.errors.push(credentials.error);
    return report;
  }
  const base = (input.env.SWAL_MCP_NETWORK ?? "").trim().toLowerCase() === "mainnet" ? "https://fapi.binance.com" : "https://testnet.binancefuture.com";
  const client: TradingClient = createTradingClient({
    apiKey: credentials.value.apiKey,
    apiSecret: credentials.value.apiSecret,
    fetchFn: input.fetchFn,
    now: input.now,
    base,
  });
  try {
    await client.syncTime();
  } catch (err) {
    report.errors.push(`the sweep could not synchronize the clock: ${errorMessage(err)}`);
    return report;
  }

  let risk: unknown = null;
  try {
    risk = await client.positionRisk();
  } catch (err) {
    report.errors.push(redactSecrets(errorMessage(err), [credentials.value.apiKey, credentials.value.apiSecret]));
    return report;
  }

  for (const intent of report.pending) {
    const symbol = normalizeSymbol(intent.symbol);
    if (!symbol) {
      report.errors.push(`the intent ${intent.clientOrderId} has no usable symbol.`);
      continue;
    }
    const net = netPosition(risk, symbol);
    if (net.error) report.errors.push(net.error);
    if (net.amount == null || net.amount === 0) continue;
    const finding: SweepFinding = {
      ...intent,
      symbol,
      netPosition: net.amount,
      action: "reported",
      detail: null,
    };
    if (report.flattenEnabled) {
      const filters = await fetchSymbolFilters(base, symbol, input.fetchFn);
      if (!filters.ok) {
        finding.action = "flatten-failed";
        finding.detail = `exchangeInfo: ${filters.error}`;
      } else {
        const flatten = await flattenPosition(client, filters.value, symbol);
        if (flatten.flat) {
          finding.action = "flattened";
          finding.detail = describeFlatten({ flatten, cancelledOrders: null, cancelledAlgoOrders: null, done: true });
        } else {
          finding.action = "flatten-failed";
          finding.detail = flatten.error ?? flatten.dustNote ?? "the position could not be closed";
        }
      }
    }
    report.findings.push(finding);
  }
  return report;
}
