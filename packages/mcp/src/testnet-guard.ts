import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TESTNET_BASE } from "./trading-config.js";

export const DEFAULT_TESTNET_ENV_FILE = "~/.config/swal-trade/testnet.env";

export interface TestnetGuardSafety {
  ok: true;
  base: string;
}

export interface GuardFailure {
  ok: false;
  error: string;
}

export type SafetyResult = TestnetGuardSafety | GuardFailure;

/**
 * Validates that the current environment is safe for testnet execution.
 * Refuses mainnet network or any presence of SWAL_MCP_MAINNET_CONFIRM.
 * Asserts write base is https://testnet.binancefuture.com.
 */
export function validateTestnetSafety(env: NodeJS.ProcessEnv = process.env): SafetyResult {
  const network = (env.SWAL_MCP_NETWORK ?? "").trim().toLowerCase();
  if (network === "mainnet") {
    return {
      ok: false,
      error: "Refused: SWAL_MCP_NETWORK is set to 'mainnet'. Testnet operations strictly prohibit mainnet writes.",
    };
  }
  if (network !== "" && network !== "testnet") {
    return {
      ok: false,
      error: `Refused: SWAL_MCP_NETWORK must be 'testnet' (found: '${network}').`,
    };
  }
  const confirm = (env.SWAL_MCP_MAINNET_CONFIRM ?? "").trim();
  if (confirm !== "") {
    return {
      ok: false,
      error: "Refused: SWAL_MCP_MAINNET_CONFIRM must be unset for testnet operations.",
    };
  }
  if (TESTNET_BASE !== "https://testnet.binancefuture.com") {
    return {
      ok: false,
      error: `Assertion failed: TESTNET_BASE is '${TESTNET_BASE}', expected 'https://testnet.binancefuture.com'.`,
    };
  }
  return { ok: true, base: TESTNET_BASE };
}

/**
 * Expands a file path (e.g. ~/ to homedir).
 */
export function expandHome(filePath: string): string {
  if (filePath.startsWith("~/") || filePath === "~") {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return path.resolve(filePath);
}

export interface TestnetCredentials {
  apiKey: string;
  apiSecret: string;
}

export type ParseEnvResult = { ok: true; credentials: TestnetCredentials } | GuardFailure;

/**
 * Parses raw text from a testnet.env file.
 * Expects BINANCE_TESTNET_API_KEY and BINANCE_TESTNET_API_SECRET.
 * Never echoes or leaks the secrets in errors.
 */
export function parseTestnetEnv(content: string): ParseEnvResult {
  let apiKey = "";
  let apiSecret = "";

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes if present
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key === "BINANCE_TESTNET_API_KEY") {
      apiKey = val.trim();
    } else if (key === "BINANCE_TESTNET_API_SECRET") {
      apiSecret = val.trim();
    }
  }

  if (!apiKey || !apiSecret) {
    return {
      ok: false,
      error: "BINANCE_TESTNET_API_KEY and BINANCE_TESTNET_API_SECRET are required in testnet.env.",
    };
  }

  return { ok: true, credentials: { apiKey, apiSecret } };
}

export type LoadEnvResult = { ok: true; credentials: TestnetCredentials; filePath: string } | GuardFailure;

/**
 * Reads testnet credentials strictly from the specified file or default ~/.config/swal-trade/testnet.env.
 * Does not read any other file. Never prints secrets.
 */
export function loadTestnetCredentials(customPath?: string): LoadEnvResult {
  const displayPath = customPath || DEFAULT_TESTNET_ENV_FILE;
  const resolved = expandHome(displayPath);

  if (!fs.existsSync(resolved)) {
    return {
      ok: false,
      error: `missing ${displayPath}: file not found. Create it with BINANCE_TESTNET_API_KEY and BINANCE_TESTNET_API_SECRET.`,
    };
  }

  let content: string;
  try {
    content = fs.readFileSync(resolved, "utf-8");
  } catch (err) {
    return {
      ok: false,
      error: `could not read ${displayPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const parsed = parseTestnetEnv(content);
  if (!parsed.ok) {
    return {
      ok: false,
      error: `missing ${displayPath}: ${parsed.error}`,
    };
  }

  return { ok: true, credentials: parsed.credentials, filePath: resolved };
}

export interface BuildChildEnvOptions {
  credentials: TestnetCredentials;
  baseEnv?: NodeJS.ProcessEnv;
  maxNotionalUsd?: string;
  maxLeverage?: string;
  dailyLossUsd?: string;
  symbols?: string;
  journalPath?: string;
}

/**
 * Builds the child process environment for spawning swal-trade MCP server in testnet mode.
 * Maps BINANCE_TESTNET_API_KEY -> BINANCE_API_KEY and BINANCE_TESTNET_API_SECRET -> BINANCE_API_SECRET.
 * Enforces SWAL_MCP_TRADING=enabled and SWAL_MCP_NETWORK=testnet.
 * Removes SWAL_MCP_MAINNET_CONFIRM.
 */
export function buildTestnetChildEnv(options: BuildChildEnvOptions): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...(options.baseEnv ?? process.env) };

  // Remove any mainnet confirm or testnet keys from child env
  delete childEnv.SWAL_MCP_MAINNET_CONFIRM;
  delete childEnv.BINANCE_TESTNET_API_KEY;
  delete childEnv.BINANCE_TESTNET_API_SECRET;

  // Enforce server flags
  childEnv.SWAL_MCP_TRADING = "enabled";
  childEnv.SWAL_MCP_NETWORK = "testnet";

  // Map credentials to the standard variable names expected by server
  childEnv.BINANCE_API_KEY = options.credentials.apiKey;
  childEnv.BINANCE_API_SECRET = options.credentials.apiSecret;

  // Set conservative limits
  childEnv.SWAL_MAX_NOTIONAL_USD = options.maxNotionalUsd || childEnv.SWAL_MAX_NOTIONAL_USD || "25";
  childEnv.SWAL_MAX_LEVERAGE = options.maxLeverage || childEnv.SWAL_MAX_LEVERAGE || "2";
  childEnv.SWAL_DAILY_LOSS_USD = options.dailyLossUsd || childEnv.SWAL_DAILY_LOSS_USD || "10";
  childEnv.SWAL_MCP_SYMBOLS = options.symbols || childEnv.SWAL_MCP_SYMBOLS || "BTCUSDT";
  childEnv.SWAL_MCP_JOURNAL = options.journalPath || childEnv.SWAL_MCP_JOURNAL || "/tmp/swal-testnet-journal.jsonl";

  return childEnv;
}
