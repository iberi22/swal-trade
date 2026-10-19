// Abre un par en Binance Futures: reutiliza la pestana de futuros del usuario o crea una.
// La URL se construye solo con el simbolo validado y un segmento de idioma validado.
import { assertSymbol } from '../binance';

export const FUTURES_TAB_PATTERN = 'https://www.binance.com/*/futures/*';
const DEFAULT_LOCALE = 'en';
const LOCALE_RE = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/;
const TAB_URL_RE = /^https:\/\/www\.binance\.com\/([^/?#]+)\/futures\//;

export function safeLocale(raw: unknown): string {
  return typeof raw === 'string' && LOCALE_RE.test(raw) ? raw : DEFAULT_LOCALE;
}

/** https://www.binance.com/<idioma>/futures/<SIMBOLO>; lanza si el simbolo no es valido. */
export function openPairUrl(symbol: string, locale?: string): string {
  return `https://www.binance.com/${safeLocale(locale)}/futures/${assertSymbol(symbol)}`;
}

/** Idioma del segmento de la URL de una pestana de futuros de Binance, o null. */
export function localeOfTabUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const m = TAB_URL_RE.exec(url);
  return m ? safeLocale(m[1]) : null;
}

export interface PairTab {
  id?: number;
  url?: string;
  active?: boolean;
}

export interface OpenPairDeps {
  tabs: {
    query(info: { url: string }): Promise<PairTab[]>;
    update(tabId: number, props: { url: string; active: boolean }): Promise<unknown>;
    create(props: { url: string; active: boolean }): Promise<unknown>;
  };
}

export type OpenPairResult = 'updated' | 'created';

export async function openPair(symbol: string, deps: OpenPairDeps): Promise<OpenPairResult> {
  const safe = assertSymbol(symbol);
  let tabs: PairTab[] = [];
  try {
    tabs = await deps.tabs.query({ url: FUTURES_TAB_PATTERN });
  } catch {
    tabs = [];
  }
  const usable = (Array.isArray(tabs) ? tabs : []).filter((t) => typeof t.id === 'number' && localeOfTabUrl(t.url) !== null);
  const tab = usable.find((t) => t.active) ?? usable[0];
  if (tab && typeof tab.id === 'number') {
    try {
      await deps.tabs.update(tab.id, { url: openPairUrl(safe, localeOfTabUrl(tab.url) ?? undefined), active: true });
      return 'updated';
    } catch {
      /* la pestana se cerro: se abre una nueva */
    }
  }
  await deps.tabs.create({ url: openPairUrl(safe), active: true });
  return 'created';
}
