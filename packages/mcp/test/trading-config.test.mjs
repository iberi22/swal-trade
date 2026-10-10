import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_MAX_LEVERAGE,
  DEFAULT_MAX_POSITIONS,
  MAINNET_BASE,
  TESTNET_BASE,
  journalPathOf,
  parseTradingConfig,
  readGridLimits,
  tradingEnabled,
  TRADING_DISABLED_ERROR,
} from "../dist/trading-config.js";

const enabled = { SWAL_MCP_TRADING: "enabled" };
const base = {
  ...enabled,
  SWAL_MCP_SYMBOLS: "BTCUSDT, ETHUSDT",
  SWAL_MAX_NOTIONAL_USD: "1000",
  SWAL_DAILY_LOSS_USD: "100",
};

test("trading is off unless the flag says enabled", () => {
  assert.equal(tradingEnabled({}), false);
  assert.equal(tradingEnabled({ SWAL_MCP_TRADING: "" }), false);
  assert.equal(tradingEnabled({ SWAL_MCP_TRADING: "disabled" }), false);
  assert.equal(tradingEnabled({ SWAL_MCP_TRADING: "true" }), false);
  assert.equal(tradingEnabled({ SWAL_MCP_TRADING: " enabled " }), true);
  assert.equal(tradingEnabled({ SWAL_MCP_TRADING: "ENABLED" }), true);
  assert.equal(parseTradingConfig({}).ok, false);
  assert.equal(parseTradingConfig({}).ok === false && parseTradingConfig({}).error, TRADING_DISABLED_ERROR);
});

test("testnet is the default network", () => {
  const parsed = parseTradingConfig(base);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.network, "testnet");
  assert.equal(parsed.value.base, TESTNET_BASE);
  assert.equal(parsed.value.base, "https://testnet.binancefuture.com");

  const explicit = parseTradingConfig({ ...base, SWAL_MCP_NETWORK: "testnet" });
  assert.equal(explicit.ok, true);
  if (explicit.ok) assert.equal(explicit.value.base, TESTNET_BASE);
});

test("mainnet needs both the network flag and the confirmation", () => {
  const missing = parseTradingConfig({ ...base, SWAL_MCP_NETWORK: "mainnet" });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /SWAL_MCP_MAINNET_CONFIRM=yes/);

  const wrong = parseTradingConfig({ ...base, SWAL_MCP_NETWORK: "mainnet", SWAL_MCP_MAINNET_CONFIRM: "no" });
  assert.equal(wrong.ok, false);

  const ok = parseTradingConfig({ ...base, SWAL_MCP_NETWORK: "mainnet", SWAL_MCP_MAINNET_CONFIRM: "yes" });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.value.network, "mainnet");
  assert.equal(ok.value.base, MAINNET_BASE);

  const bogus = parseTradingConfig({ ...base, SWAL_MCP_NETWORK: "live" });
  assert.equal(bogus.ok, false);
  if (!bogus.ok) assert.match(bogus.error, /must be 'testnet' or 'mainnet'/);
});

test("the symbol whitelist is required and normalized", () => {
  const missing = parseTradingConfig({ ...enabled, SWAL_MAX_NOTIONAL_USD: "10", SWAL_DAILY_LOSS_USD: "10" });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /SWAL_MCP_SYMBOLS must list at least one symbol/);

  const bad = parseTradingConfig({ ...base, SWAL_MCP_SYMBOLS: "BTC-USDT" });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /not a futures symbol/);

  const parsed = parseTradingConfig({ ...base, SWAL_MCP_SYMBOLS: " btcusdt , ethusdt , BTCUSDT " });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.value.symbols, ["BTCUSDT", "ETHUSDT"]);
});

test("the notional cap and the daily loss limit are required for writes", () => {
  const noNotional = parseTradingConfig({ ...enabled, SWAL_MCP_SYMBOLS: "BTCUSDT", SWAL_DAILY_LOSS_USD: "100" });
  assert.equal(noNotional.ok, false);
  if (!noNotional.ok) assert.match(noNotional.error, /SWAL_MAX_NOTIONAL_USD is required/);

  const badNotional = parseTradingConfig({ ...base, SWAL_MAX_NOTIONAL_USD: "-5" });
  assert.equal(badNotional.ok, false);

  const noDaily = parseTradingConfig({ ...enabled, SWAL_MCP_SYMBOLS: "BTCUSDT", SWAL_MAX_NOTIONAL_USD: "100" });
  assert.equal(noDaily.ok, false);
  if (!noDaily.ok) assert.match(noDaily.error, /SWAL_DAILY_LOSS_USD must be a finite number greater than 0/);
});

test("leverage and open positions default to one and reject unusable values", () => {
  const parsed = parseTradingConfig(base);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.maxLeverage, DEFAULT_MAX_LEVERAGE);
  assert.equal(DEFAULT_MAX_LEVERAGE, 1);
  assert.equal(parsed.value.maxOpenPositions, DEFAULT_MAX_POSITIONS);
  assert.equal(DEFAULT_MAX_POSITIONS, 1);

  for (const value of ["0", "-1", "1.5", "abc"]) {
    assert.equal(parseTradingConfig({ ...base, SWAL_MAX_LEVERAGE: value }).ok, false, `leverage ${value}`);
    assert.equal(parseTradingConfig({ ...base, SWAL_MCP_MAX_POSITIONS: value }).ok, false, `positions ${value}`);
  }
  const custom = parseTradingConfig({ ...base, SWAL_MAX_LEVERAGE: "10", SWAL_MCP_MAX_POSITIONS: "3" });
  assert.equal(custom.ok, true);
  if (custom.ok) {
    assert.equal(custom.value.maxLeverage, 10);
    assert.equal(custom.value.maxOpenPositions, 3);
  }
});

test("the journal path defaults under the home directory and honours the override", () => {
  const home = os.homedir();
  assert.equal(journalPathOf({}), path.resolve(home, ".swal-trade", "journal.jsonl"));
  assert.equal(journalPathOf({ SWAL_MCP_JOURNAL: "/tmp/other.jsonl" }), "/tmp/other.jsonl");
  assert.equal(journalPathOf({ SWAL_MCP_JOURNAL: "  " }), path.resolve(home, ".swal-trade", "journal.jsonl"));
  assert.equal(journalPathOf({ SWAL_MCP_JOURNAL: "~/x/y.jsonl" }), path.resolve(home, "x", "y.jsonl"));
});

test("readGridLimits is lenient: the read-only plan needs no flag and no keys", () => {
  const limits = readGridLimits({});
  assert.equal(limits.enabled, false);
  assert.equal(limits.network, "testnet");
  assert.equal(limits.maxNotionalUsd, null);

  const configured = readGridLimits({
    SWAL_MCP_SYMBOLS: "BTCUSDT",
    SWAL_MAX_NOTIONAL_USD: "500",
    SWAL_MAX_LEVERAGE: "3",
    SWAL_DAILY_LOSS_USD: "50",
    SWAL_MCP_NETWORK: "mainnet",
  });
  assert.equal(configured.enabled, false);
  assert.equal(configured.network, "mainnet");
  assert.equal(configured.maxNotionalUsd, 500);
  assert.equal(configured.maxLeverage, 3);
  assert.equal(configured.dailyLossUsd, 50);
  assert.deepEqual(configured.symbols, ["BTCUSDT"]);
});
