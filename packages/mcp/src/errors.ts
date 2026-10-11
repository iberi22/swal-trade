import { randomUUID } from "node:crypto";

// One error type for every exchange answer, shared by the read-only client and
// the signed write client.
// The distinction that matters for safety is not the message but the certainty:
// a 4xx with a code is the exchange saying "nothing was sent", while a timeout,
// a reset connection or a 5xx means the order MAY have been accepted. Treating
// the second as the first is how a fill ends up reported as a rejection and left
// without a stop.

/** One exchange error, with the HTTP status when the answer carried one. */
export class BinanceError extends Error {
  readonly code: number | null;
  readonly msg: string;
  readonly status: number | null;

  constructor(message: string, code: number | null, msg: string, status: number | null = null) {
    super(message);
    this.name = "BinanceError";
    this.code = code;
    this.msg = msg;
    this.status = status;
  }
}

/**
 * True when the outcome of a write is unknown: a timeout, a DNS failure, a reset
 * connection, or an exchange 5xx. The order may have been sent, so the caller
 * must query it by clientOrderId before reporting anything.
 */
export function isAmbiguousError(err: unknown): boolean {
  if (!(err instanceof BinanceError)) return true; // transport error: unknown
  if (err.status == null) return err.code == null;
  return err.status >= 500 || err.status === 408 || err.status === 429;
}

/** A definitive rejection: the exchange answered no, and nothing was sent. */
export function isRejectedError(err: unknown): boolean {
  return err instanceof BinanceError && err.code != null && !isAmbiguousError(err);
}

/** Builds a BinanceError out of an HTTP status and a response body. */
export function httpError(status: number, path: string, body: string): BinanceError {
  const text = body.slice(0, 400);
  let code: number | null = null;
  let msg = text;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.code === "number") code = record.code;
      if (typeof record.msg === "string") msg = String(record.msg);
    }
  } catch {
    // Not JSON: keep the truncated text.
  }
  const hidden = new BinanceError(`HTTP ${status} ${path} ${code == null ? "" : `code ${code} `}${msg}`, code, msg, status);
  return hidden;
}

/** Code of "order does not exist": a lookup that found nothing. */
export const ORDER_NOT_FOUND_CODE = -2013;

/**
 * Client order id for every order this process sends.
 *
 * Binance keeps the id for as long as the order exists and answers lookups by
 * `origClientOrderId` with it, so a new id per attempt is what makes "was my
 * order accepted?" answerable after a timeout. A reused id would make the lookup
 * return an older order, which is how an ambiguous fill gets reported as
 * nothing-sent.
 */
export function newClientOrderId(): string {
  return `swal${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
