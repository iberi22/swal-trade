const SYMBOL_RE = /^[A-Z0-9]{2,30}$/;

export function normalizeSymbol(raw: string): string | null {
  const symbol = raw.trim().toUpperCase();
  return SYMBOL_RE.test(symbol) ? symbol : null;
}
