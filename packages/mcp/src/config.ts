import type { RiskCfg } from "./risk.js";

export interface Credentials {
  apiKey: string;
  apiSecret: string;
}

export interface ProposalLimits {
  maxLeverage: number | null;
  maxNotionalUsd: number | null;
  dailyLossUsd: number | null;
}

export type ConfigResult<T> = { ok: true; value: T } | { ok: false; error: string };

const DEFAULT_FUTURES_BASE = "https://fapi.binance.com";

type NumberRead = { state: "unset" } | { state: "invalid" } | { state: "set"; value: number };

function readNumber(env: NodeJS.ProcessEnv, key: string): NumberRead {
  const raw = env[key];
  if (raw == null || raw.trim() === "") return { state: "unset" };
  const value = Number(raw);
  if (!Number.isFinite(value)) return { state: "invalid" };
  return { state: "set", value };
}

function positiveOrNull(env: NodeJS.ProcessEnv, key: string): ConfigResult<number | null> {
  const read = readNumber(env, key);
  if (read.state === "unset") return { ok: true, value: null };
  if (read.state === "invalid" || !(read.value > 0)) {
    return { ok: false, error: `${key} must be a finite number greater than 0, or unset.` };
  }
  return { ok: true, value: read.value };
}

export function futuresBase(env: NodeJS.ProcessEnv): ConfigResult<string> {
  const raw = (env.BINANCE_FUTURES_URL?.trim() || DEFAULT_FUTURES_BASE).replace(/\/$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "BINANCE_FUTURES_URL is not a valid URL." };
  }
  if (url.protocol !== "https:") return { ok: false, error: "BINANCE_FUTURES_URL must use https." };
  return { ok: true, value: url.origin };
}

export function readCredentials(env: NodeJS.ProcessEnv): ConfigResult<Credentials> {
  const apiKey = env.BINANCE_API_KEY?.trim() ?? "";
  const apiSecret = env.BINANCE_API_SECRET?.trim() ?? "";
  if (!apiKey || !apiSecret) {
    return {
      ok: false,
      error: "BINANCE_API_KEY and BINANCE_API_SECRET are required for account_risk. This tool is read-only and they are not set.",
    };
  }
  return { ok: true, value: { apiKey, apiSecret } };
}

export interface AccountRiskConfig extends RiskCfg {
  tz: number;
}

export function parseAccountRiskConfig(env: NodeJS.ProcessEnv): ConfigResult<AccountRiskConfig> {
  const limit = readNumber(env, "SWAL_DAILY_LOSS_USD");
  if (limit.state !== "set" || !(limit.value > 0)) {
    return { ok: false, error: "SWAL_DAILY_LOSS_USD must be a finite number greater than 0." };
  }
  const maxNotional = positiveOrNull(env, "SWAL_MAX_NOTIONAL_USD");
  if (!maxNotional.ok) return maxNotional;
  const maxLev = positiveOrNull(env, "SWAL_MAX_LEVERAGE");
  if (!maxLev.ok) return maxLev;
  const warnRead = readNumber(env, "SWAL_WARN_FRACTION");
  const warn = warnRead.state === "unset" ? 0.7 : warnRead.state === "set" ? warnRead.value : Number.NaN;
  if (!(warn > 0 && warn <= 1)) return { ok: false, error: "SWAL_WARN_FRACTION must be in (0, 1]." };
  const tzRead = readNumber(env, "SWAL_TZ_OFFSET_HOURS");
  const tz = tzRead.state === "unset" ? -5 : tzRead.state === "set" ? tzRead.value : Number.NaN;
  if (!(tz >= -12 && tz <= 14)) return { ok: false, error: "SWAL_TZ_OFFSET_HOURS out of range (-12 to 14)." };
  return {
    ok: true,
    value: { limit: limit.value, warn, maxNotional: maxNotional.value, maxLev: maxLev.value, tz },
  };
}

export function parseProposalLimits(env: NodeJS.ProcessEnv): ConfigResult<ProposalLimits> {
  const maxLeverage = positiveOrNull(env, "SWAL_MAX_LEVERAGE");
  if (!maxLeverage.ok) return maxLeverage;
  const maxNotionalUsd = positiveOrNull(env, "SWAL_MAX_NOTIONAL_USD");
  if (!maxNotionalUsd.ok) return maxNotionalUsd;
  const daily = readNumber(env, "SWAL_DAILY_LOSS_USD");
  if (daily.state === "invalid" || (daily.state === "set" && !(daily.value > 0))) {
    return { ok: false, error: "SWAL_DAILY_LOSS_USD must be a finite number greater than 0, or unset." };
  }
  return {
    ok: true,
    value: {
      maxLeverage: maxLeverage.value,
      maxNotionalUsd: maxNotionalUsd.value,
      dailyLossUsd: daily.state === "set" ? daily.value : null,
    },
  };
}
