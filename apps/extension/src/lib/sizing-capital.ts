// De dónde sale el capital del dimensionador y de las tarjetas de operación.
//
// Dos fuentes: el valor manual (lo que el usuario escribe) y el saldo de margen
// que muestra su página del exchange. La segunda solo vale si la lectura de
// página está encendida y el activo del saldo casa con el activo de cotización
// del par (BTCUSDC -> USDC, BTCUSDT -> USDT). Si no casa, se cae al manual y se
// dice por qué: nunca se mezcla un saldo en USDT con un par en USDC.
//
// La fuente ELEGIDA es del usuario: si su saldo deja de servir (otro par, otra
// moneda) el panel no la cambia por su cuenta; usa el manual y lo explica.
// Cargar una tarjeta o un dibujo sí la pasa a manual, porque el capital del
// ticket manda y con el saldo de la página la cifra exacta dejaría de valer.

import type { PageBalance } from './page-account/parse-balance';
import {
  MANUAL_CAPITAL_ASSET,
  balanceForSymbol,
  formatBalanceAmount,
  formatPageBalanceLine,
  isBalanceStale,
  quoteAssetOf,
} from './page-account/page-balance';
import type { SizingLoad } from './trade-cards/sizing-bridge';

export type CapitalSource = 'manual' | 'page';

/** Clave de `storage.local` con la fuente elegida (fuera de las prefs numéricas). */
export const CAPITAL_SOURCE_STORAGE_KEY = 'sizing_capital_source';
export const DEFAULT_CAPITAL_SOURCE: CapitalSource = 'manual';

export function normalizeCapitalSource(value: unknown): CapitalSource {
  return value === 'page' ? 'page' : 'manual';
}

export interface CapitalInput {
  /** Fuente pedida por el usuario. */
  source: CapitalSource;
  /** Capital escrito a mano (el que se usa si la página no sirve). */
  manualCapital: number;
  /** Par del panel (`BTCUSDC`). */
  symbol: string;
  balance: PageBalance | null | undefined;
  capturedAtMs: number | null | undefined;
  nowMs: number;
  /** Ajuste `readPageAccount`: sin él ni se ofrece el saldo de la página. */
  readPageAccount: boolean;
  staleMs?: number;
}

export interface ResolvedCapital {
  /** Fuente EFECTIVA: 'manual' cuando la de página no se puede usar. */
  source: CapitalSource;
  capital: number;
  asset: string;
  /** El saldo de la página no casa con el activo del par. */
  assetMismatch: boolean;
  stale: boolean;
  /** Texto `saldo de la página: 71,96 USDC (hace 12 s)` cuando se usa. */
  pageLine: string | null;
  /** Nota cuando se pidió la página y se cayó al manual. */
  fallbackNote: string | null;
}

/** Activo del saldo normalizado, sin validar contra el par. */
function pageAssetOf(balance: PageBalance | null | undefined): string | null {
  const raw = balance?.asset;
  return typeof raw === 'string' && raw.trim() ? raw.trim().toUpperCase() : null;
}

/**
 * ¿Se puede ofrecer «saldo de la página» en el selector? Solo con la lectura
 * encendida y un saldo del activo del par.
 */
export function pageCapitalAvailable(input: {
  readPageAccount: boolean;
  balance: PageBalance | null | undefined;
  symbol: string;
}): boolean {
  if (!input.readPageAccount) return false;
  return balanceForSymbol(input.balance, input.symbol) !== null;
}

/** Resuelve capital, activo, caducidad y nota de respaldo. Función pura. */
export function resolveCapital(input: CapitalInput): ResolvedCapital {
  const manual =
    Number.isFinite(input.manualCapital) && input.manualCapital > 0 ? input.manualCapital : 0;
  const quote = quoteAssetOf(input.symbol);
  const pageAsset = pageAssetOf(input.balance);
  const usable = input.readPageAccount ? balanceForSymbol(input.balance, input.symbol) : null;
  const assetMismatch = Boolean(
    input.readPageAccount &&
      input.balance &&
      quote !== null &&
      pageAsset !== null &&
      pageAsset !== quote,
  );

  if (input.source === 'page' && usable) {
    const stale = isBalanceStale(input.capturedAtMs, input.nowMs, input.staleMs);
    return {
      source: 'page',
      capital: usable.value,
      asset: usable.asset,
      assetMismatch: false,
      stale,
      pageLine: formatPageBalanceLine({
        value: usable.value,
        asset: usable.asset,
        capturedAtMs: input.capturedAtMs,
        nowMs: input.nowMs,
        staleMs: input.staleMs,
      }),
      fallbackNote: null,
    };
  }

  let fallbackNote: string | null = null;
  if (input.source === 'page') {
    if (!input.readPageAccount) {
      fallbackNote = 'la lectura de la página está apagada: se usa el capital manual';
    } else if (!input.balance) {
      fallbackNote = 'la página todavía no muestra el saldo: se usa el capital manual';
    } else if (pageAsset === null && input.balance.unusableReason) {
      // Recuadro con monedas mezcladas: no hay un activo que ofrecer.
      fallbackNote = `${input.balance.unusableReason}: se usa el capital manual`;
    } else if (assetMismatch) {
      fallbackNote = `el saldo de la página está en ${pageAsset} y el par se cotiza en ${quote}: se usa el capital manual`;
    } else if (quote === null) {
      fallbackNote = 'no se conoce el activo de cotización del par: se usa el capital manual';
    } else {
      fallbackNote = 'la página no muestra el saldo de margen: se usa el capital manual';
    }
  }

  return {
    source: 'manual',
    capital: manual,
    asset: MANUAL_CAPITAL_ASSET,
    assetMismatch,
    stale: false,
    pageLine: null,
    fallbackNote,
  };
}

/**
 * Encabezado de las tarjetas de operación: el capital y, si la fuente es de
 * página, la MISMA línea que enseña el dimensionador (con «hace X s» y, pasados
 * 60 s, «dato viejo»). Cuando la página no sirve, enseña el motivo del respaldo.
 */
export function formatCapitalHeadline(resolved: ResolvedCapital): string {
  const amount = `capital ${formatBalanceAmount(resolved.capital, resolved.asset)}`;
  const detail = resolved.pageLine ?? resolved.fallbackNote;
  return detail ? `${amount} · ${detail}` : amount;
}

/** Nota que explica por qué una carga dejó el capital del ticket como manual. */
export function loadedCapitalNote(capital: number): string {
  return `Cargado desde la tarjeta/tu dibujo con su capital (${formatBalanceAmount(capital, '')}). Vuelve a «saldo de la página» para recalcular con tu saldo.`;
}

export interface CapitalOnLoad {
  /** Siempre 'manual': el capital del ticket manda desde que se carga. */
  source: CapitalSource;
  capital: number;
  /** Aviso visible solo cuando la fuente era de página; null si ya era manual. */
  note: string | null;
}

/**
 * Fuente y capital cuando llega una carga (tarjeta o dibujo). El capital del
 * ticket SIEMPRE manda y la fuente pasa a 'manual': con «saldo de la página» el
 * capital efectivo era el de la página (1.000) y `exactSizingFromLoad` devolvía
 * null para un ticket de 100, así que se enseñaba otra cantidad y otra pérdida.
 */
export function resolveCapitalOnLoad(
  source: CapitalSource,
  load: Pick<SizingLoad, 'capital'>,
): CapitalOnLoad {
  return {
    source: 'manual',
    capital: load.capital,
    note: source === 'page' ? loadedCapitalNote(load.capital) : null,
  };
}
