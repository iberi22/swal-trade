import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendJournal, assertJournalWritable, expandJournalPath, sanitizeForJournal } from "../dist/journal.js";

const SECRET = "supersecretvalue";
const SECRET_ENV_KEY = "AK-secret-key";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "swal-journal-"));
}

test("appendJournal writes one sanitized JSON line per write", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "nested", "journal.jsonl");
  await appendJournal(
    file,
    {
      ts: "2026-10-09T00:00:00.000Z",
      event: "place_order",
      network: "testnet",
      request: { symbol: "BTCUSDT", notional_usd: 200 },
      guard: { allow: true, reasons: [] },
      exchange: [{ step: "entry_market", response: { orderId: 1 } }],
      result: { sent: true },
      error: null,
    },
    [SECRET],
  );
  await appendJournal(file, { event: "close_position", error: "boom" }, [SECRET]);
  const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.event, "place_order");
  assert.equal(first.request.symbol, "BTCUSDT");
  assert.equal(first.guard.allow, true);
  assert.equal(first.exchange[0].response.orderId, 1);
  assert.equal(JSON.parse(lines[1]).event, "close_position");
});

test("the journal never carries the key, the signature or a signed URL", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "journal.jsonl");
  await appendJournal(
    file,
    {
      headers: { "X-MBX-APIKEY": SECRET_ENV_KEY },
      exchange: [
        { step: "entry", signature: "deadbeef", apiKey: SECRET_ENV_KEY, secret: SECRET },
        { step: "boom", error: `network error /fapi/v1/order?symbol=BTCUSDT&signature=${SECRET} https://testnet.binancefuture.com/fapi/v1/order?timestamp=1&signature=abc` },
        { step: "nested", deep: [{ clientOrderId: "x", token: SECRET }] },
      ],
    },
    [SECRET, SECRET_ENV_KEY],
  );
  const raw = await fs.readFile(file, "utf8");
  assert.equal(raw.includes(SECRET), false);
  assert.equal(raw.includes(SECRET_ENV_KEY), false);
  // No signature value survives: the key is kept so the line still makes sense,
  // but its value is always [omitted].
  assert.equal(raw.includes("deadbeef"), false);
  assert.equal(raw.includes("signature="), false);
  const record = JSON.parse(raw.trim());
  assert.equal(record.headers["X-MBX-APIKEY"], "[omitted]");
  assert.equal(record.exchange[0].signature, "[omitted]");
  assert.equal(record.exchange[0].apiKey, "[omitted]");
  assert.equal(record.exchange[0].secret, "[omitted]");
  assert.equal(record.exchange[2].deep[0].token, "[omitted]");
  // URLs lose their query string, so a signature can never travel in one.
  assert.equal(record.exchange[1].error.includes("signature="), false);
  assert.equal(record.exchange[1].error.includes("https://testnet.binancefuture.com/fapi/v1/order"), true);
});

test("sanitizeForJournal caps long strings and keeps scalars", () => {
  const long = "x".repeat(2000);
  const value = sanitizeForJournal({ a: long, b: 1, c: true, d: null, e: [1, "y"] }, []);
  assert.equal(value.a.length, 400);
  assert.equal(value.b, 1);
  assert.equal(value.c, true);
  assert.equal(value.d, null);
  assert.deepEqual(value.e, [1, "y"]);
  assert.equal(sanitizeForJournal("plain", []), "plain");
});

test("expandJournalPath resolves ~ and defaults under the home directory", () => {
  assert.equal(expandJournalPath(undefined), path.join(os.homedir(), ".swal-trade", "journal.jsonl"));
  assert.equal(expandJournalPath("/tmp/a/b.jsonl"), "/tmp/a/b.jsonl");
  assert.equal(expandJournalPath("~/a/b.jsonl"), path.join(os.homedir(), "a/b.jsonl"));
});

test("assertJournalWritable accepts a writable directory and rejects a missing parent", async () => {
  const dir = await tempDir();
  await assertJournalWritable(path.join(dir, "a", "b.jsonl"));
  await fs.mkdir(path.join(dir, "blocked"), { recursive: true });
  await fs.chmod(path.join(dir, "blocked"), 0o500);
  await assert.rejects(assertJournalWritable(path.join(dir, "blocked", "x.jsonl")), /EACCES|permission/);
  await fs.chmod(path.join(dir, "blocked"), 0o700);
});

// ---------------------------------------------------------------------------
// Item 13: the FILE has to be writable, not just its directory.
// ---------------------------------------------------------------------------

test("assertJournalWritable refuses a read-only journal FILE", async () => {
  // The directory is writable, so an access(dirname, W_OK) check passes and the
  // preflight lets the order through: the append then fails with EACCES after the
  // exchange has already accepted it. Appending is what has to be proven.
  const dir = await tempDir();
  const file = path.join(dir, "journal.jsonl");
  await fs.writeFile(file, "");
  await fs.chmod(file, 0o444);
  await assert.rejects(assertJournalWritable(file), /EACCES|permission/);
  await fs.chmod(file, 0o644);
  // And the same file writable again is accepted, without being recreated.
  await assertJournalWritable(file);
});
