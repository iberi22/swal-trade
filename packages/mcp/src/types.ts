/** Minimal fetch surface so tests can inject a mock without hitting the network. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Number of trades in the candle (optional). */
  trades?: number;
  /** Taker buy base volume (optional): enables volume flow / CVD in the core. */
  takerBuyVolume?: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "request failed";
}

/** Drop query strings so a signed URL (which carries a signature) never leaves the process in an error. */
export function stripUrls(message: string): string {
  return message.replace(/https?:\/\/[^\s)]+/g, (url) => {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return "[url]";
    }
  });
}

export function redactSecrets(message: string, secrets: readonly string[]): string {
  let out = stripUrls(message);
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out.slice(0, 400);
}
