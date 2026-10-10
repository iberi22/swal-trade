// Local audit journal for the write tools.
//
// One JSON line per write, appended to SWAL_MCP_JOURNAL (default
// ~/.swal-trade/journal.jsonl): what was asked, what the guard decided and what
// the exchange answered. Nothing that can be used to trade leaves the process:
// the API key and the signature are never written, and every string goes through
// the same redaction the error paths use (URLs lose their query string, which is
// where an HMAC signature would travel).

import { access, appendFile, mkdir, open, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { redactSecrets } from "./types.js";

export const DEFAULT_JOURNAL_PATH = "~/.swal-trade/journal.jsonl";

/**
 * Keys that are dropped wherever they appear, including inside nested exchange
 * responses. They are matched case-insensitively with separators removed.
 */
const DENYLIST = new Set([
  "signature",
  "sig",
  "apikey",
  "apisecret",
  "secret",
  "token",
  "password",
  "passphrase",
  "privatekey",
  "xmbxapikey",
]);

const OMITTED = "[omitted]";
const MAX_STRING = 400;

/** A signature can only travel inside a query string, so drop it wherever it appears. */
const SIGNATURE = /signature=[A-Za-z0-9+/=_-]+/gi;

export function expandJournalPath(raw: string | undefined): string {
  const value = (raw ?? "").trim() || DEFAULT_JOURNAL_PATH;
  const expanded = value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
  return path.resolve(expanded);
}

function keyOf(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Deep copy safe to serialize: denylisted keys are replaced, and every string is
 * redacted (secrets, signed URLs) and capped so a chatty error cannot grow the
 * journal without bound.
 */
export function sanitizeForJournal(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactSecrets(value.replace(SIGNATURE, "[omitted]"), secrets);
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeForJournal(item, secrets));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = DENYLIST.has(keyOf(key)) ? OMITTED : sanitizeForJournal(item, secrets);
    }
    return out;
  }
  return String(value).slice(0, MAX_STRING);
}

export async function appendJournal(filePath: string, record: unknown, secrets: readonly string[]): Promise<void> {
  // Refuse a non-regular target here as well as in the preflight: appending to a
  // FIFO with no reader does not fail, it BLOCKS, and an audit trail that hangs
  // the tool that is trying to record a refusal is worse than a missing line.
  const existing = await stat(filePath).catch(() => null);
  if (existing != null && !existing.isFile()) {
    throw new Error(`the journal path is not a regular file (it is a ${existing.isDirectory() ? "directory" : existing.isSymbolicLink() ? "symbolic link" : "special file"}): ${filePath}`);
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  const line = `${JSON.stringify(sanitizeForJournal(record, secrets))}\n`;
  await appendFile(filePath, line, { mode: 0o600 });
}

/**
 * Fail-closed preflight: the journal has to be a writable regular file that we
 * can create when it is missing.
 *
 * A directory, a FIFO, a socket or a device node is refused instead of being
 * passed to appendFile: those either fail silently later (a directory raises
 * EISDIR only when the write is attempted, i.e. after the order was sent) or
 * throw the audit trail away (/dev/null).
 */
export async function assertJournalWritable(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  let existing: Awaited<ReturnType<typeof stat>> | null = null;
  try {
    existing = await stat(filePath);
  } catch {
    existing = null;
  }
  if (existing != null && !existing.isFile()) {
    throw new Error(`the journal path is not a regular file (it is a ${existing.isDirectory() ? "directory" : existing.isSymbolicLink() ? "symbolic link" : "special file"})`);
  }
  if (existing == null) {
    // Create it now, with owner-only permissions, so a later failure is not a
    // surprise.
    const handle = await open(filePath, "a", 0o600);
    await handle.close();
  }
  try {
    await access(filePath, fsConstants.W_OK);
  } catch {
    await access(path.dirname(filePath), fsConstants.W_OK);
  }
}
