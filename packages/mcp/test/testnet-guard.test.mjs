import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_TESTNET_ENV_FILE,
  validateTestnetSafety,
  parseTestnetEnv,
  loadTestnetCredentials,
  buildTestnetChildEnv,
} from "../dist/testnet-guard.js";
import { TESTNET_BASE } from "../dist/trading-config.js";

const DUMMY_K = ["test", "key"].join("-");
const DUMMY_S = ["test", "secret"].join("-");
const VAR_K = "BINANCE_TESTNET_API_KEY";
const VAR_S = "BINANCE_TESTNET_API_SECRET";

test("validateTestnetSafety allows testnet and empty network", () => {
  const empty = validateTestnetSafety({});
  assert.equal(empty.ok, true);
  if (empty.ok) assert.equal(empty.base, TESTNET_BASE);

  const explicit = validateTestnetSafety({ SWAL_MCP_NETWORK: "testnet" });
  assert.equal(explicit.ok, true);
  if (explicit.ok) assert.equal(explicit.base, "https://testnet.binancefuture.com");
});

test("validateTestnetSafety strictly refuses mainnet", () => {
  const mainnet = validateTestnetSafety({ SWAL_MCP_NETWORK: "mainnet" });
  assert.equal(mainnet.ok, false);
  if (!mainnet.ok) assert.match(mainnet.error, /prohibit mainnet writes/i);

  const mainnetCase = validateTestnetSafety({ SWAL_MCP_NETWORK: "MAINNET" });
  assert.equal(mainnetCase.ok, false);
  if (!mainnetCase.ok) assert.match(mainnetCase.error, /prohibit mainnet writes/i);

  const other = validateTestnetSafety({ SWAL_MCP_NETWORK: "prod" });
  assert.equal(other.ok, false);
  if (!other.ok) assert.match(other.error, /must be 'testnet'/i);
});

test("validateTestnetSafety refuses any SWAL_MCP_MAINNET_CONFIRM", () => {
  const confirmYes = validateTestnetSafety({ SWAL_MCP_MAINNET_CONFIRM: "yes" });
  assert.equal(confirmYes.ok, false);
  if (!confirmYes.ok) assert.match(confirmYes.error, /must be unset/i);

  const confirmAny = validateTestnetSafety({ SWAL_MCP_MAINNET_CONFIRM: "true" });
  assert.equal(confirmAny.ok, false);
  if (!confirmAny.ok) assert.match(confirmAny.error, /must be unset/i);
});

test("parseTestnetEnv parses valid credentials and ignores comments/quotes", () => {
  const sample = [
    "# Binance Futures Testnet credentials",
    `${VAR_K}="${DUMMY_K}"`,
    `${VAR_S}='${DUMMY_S}'`,
  ].join("\n");
  const parsed = parseTestnetEnv(sample);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.credentials.apiKey, DUMMY_K);
    assert.equal(parsed.credentials.apiSecret, DUMMY_S);
  }
});

test("parseTestnetEnv refuses missing keys without leaking secrets", () => {
  const missingSecret = parseTestnetEnv(`${VAR_K}=some-key`);
  assert.equal(missingSecret.ok, false);
  if (!missingSecret.ok) {
    assert.match(missingSecret.error, /BINANCE_TESTNET_API_SECRET are required/);
    assert.equal(missingSecret.error.includes("some-key"), false);
  }

  const missingKey = parseTestnetEnv(`${VAR_S}=some-secret`);
  assert.equal(missingKey.ok, false);
  if (!missingKey.ok) {
    assert.match(missingKey.error, /BINANCE_TESTNET_API_KEY and BINANCE_TESTNET_API_SECRET are required/);
    assert.equal(missingKey.error.includes("some-secret"), false);
  }
});

test("loadTestnetCredentials refuses missing file safely", () => {
  const nonExistent = path.join(os.tmpdir(), "swal-non-existent-testnet.env");
  const loaded = loadTestnetCredentials(nonExistent);
  assert.equal(loaded.ok, false);
  if (!loaded.ok) {
    assert.match(loaded.error, /missing/);
    assert.match(loaded.error, /file not found/);
  }
});

test("loadTestnetCredentials reads valid file", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "swal-testnet-"));
  const tempFile = path.join(tempDir, "testnet.env");
  fs.writeFileSync(
    tempFile,
    `${VAR_K}=fake-key\n${VAR_S}=fake-val\n`,
    { mode: 0o600 }
  );
  try {
    const loaded = loadTestnetCredentials(tempFile);
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      assert.equal(loaded.credentials.apiKey, "fake-key");
      assert.equal(loaded.credentials.apiSecret, "fake-val");
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildTestnetChildEnv maps credentials and sets strict testnet limits", () => {
  const baseEnv = {
    SWAL_MCP_MAINNET_CONFIRM: "yes",
    SOME_OTHER_VAR: "kept",
  };
  const child = buildTestnetChildEnv({
    credentials: { apiKey: "my-test-key", apiSecret: "my-test-val" },
    baseEnv,
  });

  assert.equal(child.BINANCE_API_KEY, "my-test-key");
  assert.equal(child.BINANCE_API_SECRET, "my-test-val");
  assert.equal(child.SWAL_MCP_TRADING, "enabled");
  assert.equal(child.SWAL_MCP_NETWORK, "testnet");
  assert.equal(child.SWAL_MCP_MAINNET_CONFIRM, undefined);
  assert.equal(child.SWAL_MAX_NOTIONAL_USD, "25");
  assert.equal(child.SWAL_MAX_LEVERAGE, "2");
  assert.equal(child.SWAL_DAILY_LOSS_USD, "10");
  assert.equal(child.SWAL_MCP_SYMBOLS, "BTCUSDT");
  assert.equal(child.SWAL_MCP_JOURNAL, "/tmp/swal-testnet-journal.jsonl");
  assert.equal(child.SOME_OTHER_VAR, "kept");
});
