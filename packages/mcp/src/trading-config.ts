// Configuration for the write tools.
//
// The write tools are off unless the user opts in twice: once with
// SWAL_MCP_TRADING=enabled, and once more for mainnet with
// SWAL_MCP_NETWORK=mainnet plus SWAL_MCP_MAINNET_CONFIRM=yes. Everything else
// (caps, whitelist, daily-loss limit, journal path) has to be readable and
// usable: an unreadable limit is not "no limit", it is a refusal.

import { SYMBOL_RE } from "./symbol.js";
import { positiveOrNull, readNumber } from "./config.js";
import { parseAccountRiskConfig } from "./config.js";
import type { ConfigResult } from "./config.js";
import { homedir } from "node:os";
import path from "node:path";

export const TESTNET_BASE = "https://testnet.binancefuture.com";
export const MAINNET_BASE = "https://fapi.binance.com";

export type TradingNetwork = "testnet" | "mainnet";

/** Defaults from Decision 4: 1x leverage, one open position. */
export const DEFAULT_MAX_LEVERAGE = 1;
export const DEFAULT_MAX_POSITIONS = 1;

/** Default journal location, expanded from the user's home directory. */
export const DEFAULT_JOURNAL_PATH = "~/.swal-trade/journal.jsonl";

export const TRADING_DISABLED_ERROR =
  "Write tools are disabled: set SWAL_MCP_TRADING=enabled to register place_order, close_position and grid_place.";

export interface TradingConfig {
  network: TradingNetwork;
  base: string;
  symbols: string[];
  maxNotionalUsd: number;
  maxLeverage: number;
  maxOpenPositions: number;
  dailyLossUsd: number;
  warnFraction: number;
  tz: number;
  journalPath: string;
}

/**
 * What a closing needs, and nothing else: the flag, a valid network base and a
 * journal path. The notional cap, the whitelist and the daily-loss limit are
 * entry-side limits: a position trapped open because a cap is missing is the
 * opposite of protection, so close_position does not depend on them.
 */
export interface CloseConfig {
  network: TradingNetwork;
  base: string;
  journalPath: string;
}

export function parseCloseConfig(env: NodeJS.ProcessEnv): ConfigResult<CloseConfig> {
  if (!tradingEnabled(env)) return { ok: false, error: TRADING_DISABLED_ERROR };
  const net = networkOf(env);
  if (!net.ok) return net;
  return { ok: true, value: { network: net.value.network, base: net.value.base, journalPath: journalPathOf(env) } };
}

/** `true` only when the user explicitly enabled trading. */
export function tradingEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env.SWAL_MCP_TRADING ?? "").trim().toLowerCase() === "enabled";
}

function networkOf(env: NodeJS.ProcessEnv): ConfigResult<{ network: TradingNetwork; base: string }> {
  const raw = (env.SWAL_MCP_NETWORK ?? "").trim().toLowerCase();
  if (raw === "" || raw === "testnet") return { ok: true, value: { network: "testnet", base: TESTNET_BASE } };
  if (raw === "mainnet") {
    const confirm = (env.SWAL_MCP_MAINNET_CONFIRM ?? "").trim().toLowerCase();
    if (confirm !== "yes") {
      return {
        ok: false,
        error:
          "SWAL_MCP_NETWORK=mainnet also requires SWAL_MCP_MAINNET_CONFIRM=yes. Without both, the write tools stay on testnet; restart the server with both variables set to trade on mainnet.",
      };
    }
    return { ok: true, value: { network: "mainnet", base: MAINNET_BASE } };
  }
  return { ok: false, error: "SWAL_MCP_NETWORK must be 'testnet' or 'mainnet'." };
}

function symbolWhitelist(env: NodeJS.ProcessEnv): ConfigResult<string[]> {
  const raw = env.SWAL_MCP_SYMBOLS ?? "";
  const parts = raw
    .split(/[,\s]+/)
    .map((part) => part.trim().toUpperCase())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return {
      ok: false,
      error: "SWAL_MCP_SYMBOLS must list at least one symbol (for example SWAL_MCP_SYMBOLS=BTCUSDT,ETHUSDT). No symbol is whitelisted, so the guard refuses every order.",
    };
  }
  const unique: string[] = [];
  for (const part of parts) {
    if (!SYMBOL_RE.test(part)) return { ok: false, error: `SWAL_MCP_SYMBOLS entry '${part}' is not a futures symbol (2 to 30 letters or digits).` };
    if (!unique.includes(part)) unique.push(part);
  }
  return { ok: true, value: unique };
}

export function journalPathOf(env: NodeJS.ProcessEnv): string {
  const raw = (env.SWAL_MCP_JOURNAL ?? "").trim() || DEFAULT_JOURNAL_PATH;
  const expanded = raw.startsWith("~/") ? path.join(homedir(), raw.slice(2)) : raw;
  return path.resolve(expanded);
}

function integerOrError(raw: string | undefined, key: string, fallback: number): ConfigResult<number> {
  const read = readNumber({ [key]: raw }, key);
  if (read.state === "unset") return { ok: true, value: fallback };
  if (read.state !== "set" || !Number.isInteger(read.value) || read.value < 1) {
    return { ok: false, error: `${key} must be an integer greater than or equal to 1.` };
  }
  return { ok: true, value: read.value };
}

/**
 * Strict configuration for the write tools. Every field has to be usable: a
 * missing cap, an empty whitelist or an unreadable daily-loss limit is an error
 * here rather than a silent "unlimited" at guard time.
 */
export function parseTradingConfig(env: NodeJS.ProcessEnv): ConfigResult<TradingConfig> {
  if (!tradingEnabled(env)) return { ok: false, error: TRADING_DISABLED_ERROR };
  const net = networkOf(env);
  if (!net.ok) return net;
  const symbols = symbolWhitelist(env);
  if (!symbols.ok) return symbols;
  const risk = parseAccountRiskConfig(env);
  if (!risk.ok) return risk;
  if (risk.value.maxNotional == null) {
    return {
      ok: false,
      error:
        "SWAL_MAX_NOTIONAL_USD is required by place_order and grid_place: it caps the notional of every order. Set it to the largest single position you accept, in USD. close_position does not need it, because closing is protective and must never be blocked.",
    };
  }
  const maxLeverage = risk.value.maxLev ?? DEFAULT_MAX_LEVERAGE;
  if (!Number.isInteger(maxLeverage) || maxLeverage < 1) {
    return { ok: false, error: "SWAL_MAX_LEVERAGE must be an integer greater than or equal to 1: the exchange has no fractional leverage." };
  }
  const positions = integerOrError(env.SWAL_MCP_MAX_POSITIONS, "SWAL_MCP_MAX_POSITIONS", DEFAULT_MAX_POSITIONS);
  if (!positions.ok) return positions;
  return {
    ok: true,
    value: {
      network: net.value.network,
      base: net.value.base,
      symbols: symbols.value,
      maxNotionalUsd: risk.value.maxNotional,
      maxLeverage,
      maxOpenPositions: positions.value,
      dailyLossUsd: risk.value.limit,
      warnFraction: risk.value.warn ?? 0.7,
      tz: risk.value.tz,
      journalPath: journalPathOf(env),
    },
  };
}

export interface GridLimits {
  symbols: string[];
  maxNotionalUsd: number | null;
  maxLeverage: number | null;
  dailyLossUsd: number | null;
  enabled: boolean;
  network: TradingNetwork;
}

/**
 * Lenient read of the same limits, for the read-only `grid_plan`: it reports the
 * caps it can see without requiring the trading flag or the credentials.
 */
export function readGridLimits(env: NodeJS.ProcessEnv): GridLimits {
  const raw = (env.SWAL_MCP_NETWORK ?? "").trim().toLowerCase();
  const network: TradingNetwork = raw === "mainnet" ? "mainnet" : "testnet";
  const notional = positiveOrNull(env, "SWAL_MAX_NOTIONAL_USD");
  const leverage = positiveOrNull(env, "SWAL_MAX_LEVERAGE");
  const daily = readNumber(env, "SWAL_DAILY_LOSS_USD");
  const symbols = symbolWhitelist(env);
  return {
    symbols: symbols.ok ? symbols.value : [],
    maxNotionalUsd: notional.ok ? notional.value : null,
    maxLeverage: leverage.ok ? leverage.value : null,
    dailyLossUsd: daily.state === "set" ? daily.value : null,
    enabled: tradingEnabled(env),
    network,
  };
}
