import { assertSymbol } from '../binance';
import type { SymbolFilters } from './ticket';

const cache = new Map<string, SymbolFilters | null>();
const inflight = new Map<string, Promise<SymbolFilters | null>>();

const num = (v: unknown): number => (typeof v === 'string' || typeof v === 'number' ? Number(v) : Number.NaN);

/**
 * exchangeInfo?symbol=X -> symbols[0].filters. Forma verificada en vivo (futuros USD-M):
 * PRICE_FILTER.tickSize, LOT_SIZE.stepSize/minQty, MIN_NOTIONAL.notional (en spot sería minNotional).
 */
export function parseSymbolFilters(payload: unknown, symbol: string): SymbolFilters | null {
  const list = (payload as { symbols?: unknown } | null | undefined)?.symbols;
  if (!Array.isArray(list)) return null;
  const row = list.find((s) => s && typeof s === 'object' && (s as { symbol?: unknown }).symbol === symbol) as
    | { filters?: unknown }
    | undefined;
  if (!row || !Array.isArray(row.filters)) return null;
  const byType = (type: string) =>
    (row.filters as Array<Record<string, unknown>>).find((f) => f && typeof f === 'object' && f.filterType === type);
  const tickSize = num(byType('PRICE_FILTER')?.tickSize);
  const lot = byType('LOT_SIZE');
  const stepSize = num(lot?.stepSize);
  const minQty = num(lot?.minQty);
  const mn = byType('MIN_NOTIONAL');
  const minNotional = num(mn?.notional ?? mn?.minNotional);
  if (![tickSize, stepSize].every((n) => Number.isFinite(n) && n > 0)) return null;
  return {
    tickSize,
    stepSize,
    minQty: Number.isFinite(minQty) && minQty > 0 ? minQty : 0,
    minNotional: Number.isFinite(minNotional) && minNotional > 0 ? minNotional : 0,
  };
}

/** Pide los filtros una sola vez por símbolo. Nunca lanza: null si no se pueden leer. */
export async function fetchSymbolFilters(symbol: string, fetchImpl: typeof fetch = fetch): Promise<SymbolFilters | null> {
  let sym: string;
  try {
    sym = assertSymbol(symbol);
  } catch {
    return null;
  }
  if (cache.has(sym)) return cache.get(sym) ?? null;
  const pending = inflight.get(sym);
  if (pending) return pending;
  const job = (async () => {
    try {
      const res = await fetchImpl(`https://fapi.binance.com/fapi/v1/exchangeInfo?symbol=${sym}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      const parsed = parseSymbolFilters(await res.json(), sym);
      if (parsed) cache.set(sym, parsed);
      return parsed;
    } catch {
      return null;
    } finally {
      inflight.delete(sym);
    }
  })();
  inflight.set(sym, job);
  return job;
}

export function clearFiltersCache(): void {
  cache.clear();
  inflight.clear();
}
