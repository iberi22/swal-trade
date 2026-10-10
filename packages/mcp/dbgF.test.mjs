import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { textOf, withClient } from "./helpers.mjs";
import { makeExchange, tradeEnv } from "./trading-fixtures.mjs";
const NOW = Date.UTC(2026, 9, 9, 3, 0);
test("dbg append", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swal-journal-"));
  const journal = path.join(dir, "journal.jsonl");
  const exchange = makeExchange();
  let failingWrites = 0;
  const failing = {
    env: tradeEnv({ SWAL_MCP_JOURNAL: journal }),
    fetchFn: exchange.fetchFn,
    now: () => NOW,
    append: async (file, record, secrets) => {
      failingWrites += 1;
      if (failingWrites > 2) throw new Error("ENOSPC");
      const { appendJournal } = await import("../dist/journal.js");
      return appendJournal(file, record, secrets);
    },
  };
  await withClient(failing, async (client) => {
    const text = textOf(await client.callTool({ name: "place_order", arguments: { symbol: "BTCUSDT", side: "BUY", notional_usd: 200, stop_loss_pct: 0.5, leverage: 2 } }));
    console.error(JSON.stringify(JSON.parse(text), null, 1).slice(0, 1200));
  });
  console.error("writes", failingWrites);
  fs.rmSync(dir, { recursive: true, force: true });
});
