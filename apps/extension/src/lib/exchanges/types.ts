// Contrato de un adaptador de exchange.
//
// La idea: el panel funciona con exchanges cuyos graficos son TradingView. Lo
// unico que cambia entre ellos es (a) como se reconoce su URL, (b) como se saca
// el simbolo de la URL y (c) como se lee su pagina con etiquetas visibles.
//
// Estados:
// - `supported`: hay lectores reales y verificados en vivo (hoy solo Binance).
// - `detected`: solo se reconoce la URL y se saca el simbolo. NO tiene
//   lectores: la UI nunca puede decir que ese exchange esta soportado.
//
// Ver `README.md` en esta carpeta para lo que hace falta para promover un
// exchange de `detected` a `supported`.

import type { ClosedPosition } from '../page-account/parse-history';
import type { PageBalance } from '../page-account/parse-balance';
import type { PagePosition } from '../page-account/parse-positions';
import type { TextNode } from '../page-account/tree';

export type ExchangeAdapterStatus = 'supported' | 'detected';

/** Como se accede al grafico de la pagina. */
export type ExchangeChartKind = 'tradingview-api' | 'tradingview-iframe' | 'unknown';

export interface ExchangeHistoryOptions {
  /** Offset de la pagina en minutos (`Date#getTimezoneOffset`). */
  tzOffsetMinutes?: number;
}

/** Lectores de la pagina. Solo los `supported` los tienen. */
export interface ExchangeReaders {
  balance(root: TextNode | null | undefined): PageBalance | null;
  positions(root: TextNode | null | undefined): PagePosition[];
  history(root: TextNode | null | undefined, opts?: ExchangeHistoryOptions): ClosedPosition[];
}

export interface ExchangeAdapter {
  id: string;
  name: string;
  status: ExchangeAdapterStatus;
  /** Patrones de host donde vive la pagina (documentales; NO son permisos). */
  hostPatterns: string[];
  matchesUrl(url: string): boolean;
  /** Activos de cotizacion que usa el exchange (`USDT`, `USDC`...). */
  quoteAssets: string[];
  /** Simbolo tal como lo entiende la app, o null si la URL no lo dice. */
  symbolFromUrl(url: string): string | null;
  /** Solo en `supported`. Un `detected` nunca lee la pagina. */
  readers?: ExchangeReaders;
  chart: ExchangeChartKind;
}

/** Atajo: solo los `supported` pueden enseñar datos o decir «soportado». */
export function isSupported(adapter: ExchangeAdapter | null | undefined): boolean {
  return adapter?.status === 'supported' && adapter.readers !== undefined;
}
