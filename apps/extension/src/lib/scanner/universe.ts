// Universo del escaner (docs/design/SCANNER.md, 'Datos sin backend'). Funciones puras sobre las
// respuestas de exchangeInfo y ticker/24hr; sin E/S.
import { assertSymbol } from '../binance';
import { SPEC, volTier, type Spec } from './movers';

export type Quote = 'USDT' | 'USDC';

interface ExchangeSymbol {
  symbol?: unknown;
  status?: unknown;
  contractType?: unknown;
  quoteAsset?: unknown;
  underlyingType?: unknown;
}

/** Simbolo valido segun la misma regla que el resto de la extension, o null. */
export function validSymbol(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    return assertSymbol(raw);
  } catch {
    return null;
  }
}

/** Perpetuos TRADING, de la cotizacion pedida y con subyacente COIN; ordenados y sin duplicados. */
export function selectUniverse(exchangeInfo: unknown, quote: Quote): string[] {
  const list = (exchangeInfo as { symbols?: unknown } | null | undefined)?.symbols;
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const row of list as ExchangeSymbol[]) {
    if (!row || typeof row !== 'object') continue;
    if (row.status !== 'TRADING' || row.contractType !== 'PERPETUAL') continue;
    if (row.quoteAsset !== quote || row.underlyingType !== 'COIN') continue;
    const sym = validSymbol(row.symbol);
    if (sym) out.add(sym);
  }
  return [...out].sort();
}

/** ticker/24hr -> {simbolo: quoteVolume} solo con volumen >= minQ24 y simbolos validos. */
export function filterByVolume(tickers: unknown, minQ24: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(tickers)) return out;
  for (const row of tickers as Array<{ symbol?: unknown; quoteVolume?: unknown }>) {
    if (!row || typeof row !== 'object') continue;
    const sym = validSymbol(row.symbol);
    const q = Number(row.quoteVolume);
    if (!sym || !Number.isFinite(q) || q < minQ24) continue;
    out[sym] = q;
  }
  return out;
}

/** Simbolos del universo que ademas pasan el filtro de volumen (orden alfabetico). */
export function scanSymbols(universe: ReadonlyArray<string>, q24: Record<string, number>): string[] {
  return universe.filter((s) => s in q24).sort();
}

export function volTierOf(q24: number, s: Spec = SPEC): string {
  return volTier(q24, s);
}

/** Simbolo de referencia para rel_btc. */
export function btcSymbolFor(quote: Quote): string {
  return quote === 'USDC' ? 'BTCUSDC' : 'BTCUSDT';
}
