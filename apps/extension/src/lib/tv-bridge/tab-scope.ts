/**
 * Alcance por pestaña del panel: qué pestaña de Binance Futures manda.
 *
 * Los dibujos de posición se guardan por pestaña (ver `relay.ts`), así que el
 * panel tiene que saber de qué pestaña está hablando. Se reutiliza el mismo
 * criterio que el background usa para mandar órdenes al gráfico: la pestaña
 * ACTIVA de futures y, si no hay ninguna activa, la primera.
 *
 * No se pide el permiso `tabs` (prohibido en este proyecto): `tabs.query` con
 * patrón de URL funciona con el host permiso de binance.com, y los eventos
 * `onActivated`/`onUpdated`/`onRemoved`/`onCreated` no lo necesitan.
 */

import { browser } from 'wxt/browser';
import { FUTURES_TAB_PATTERN } from '../scanner/open-pair';

export interface ScopedTab {
  id?: number;
  active?: boolean;
  url?: string;
}

/**
 * Id de la pestaña que debe enseñar el panel: la activa de las que se pasan o,
 * si ninguna está activa, la primera con id. null si no hay ninguna.
 */
export function pickActiveTabId(tabs: readonly ScopedTab[] | null | undefined): number | null {
  if (!Array.isArray(tabs)) return null;
  const usable = tabs.filter((tab) => tab && typeof tab.id === 'number' && Number.isInteger(tab.id));
  const chosen = usable.find((tab) => tab.active === true) ?? usable[0];
  return chosen && typeof chosen.id === 'number' ? chosen.id : null;
}

/** Pestaña activa de Binance Futures del navegador (null si no hay ninguna). */
export async function resolveActiveBinanceTabId(): Promise<number | null> {
  try {
    const tabs = (await browser.tabs?.query({ url: FUTURES_TAB_PATTERN })) ?? [];
    return pickActiveTabId(tabs as ScopedTab[]);
  } catch {
    return null;
  }
}

/** Avisa cuando cambia la pestaña relevante (activación, navegación, cierre). */
export function onActiveBinanceTabChange(listener: () => void): () => void {
  const tabs = browser.tabs;
  if (!tabs) return () => {};
  const onActivated = () => listener();
  const onUpdated = (_tabId: number, change: { url?: string; status?: string }) => {
    if (change?.url || change?.status === 'complete') listener();
  };
  const onRemoved = () => listener();
  const onCreated = () => listener();
  try {
    tabs.onActivated?.addListener(onActivated as never);
    tabs.onUpdated?.addListener(onUpdated as never);
    tabs.onRemoved?.addListener(onRemoved as never);
    tabs.onCreated?.addListener(onCreated as never);
  } catch {
    return () => {};
  }
  return () => {
    try {
      tabs.onActivated?.removeListener(onActivated as never);
      tabs.onUpdated?.removeListener(onUpdated as never);
      tabs.onRemoved?.removeListener(onRemoved as never);
      tabs.onCreated?.removeListener(onCreated as never);
    } catch {
      // Sin eventos de pestañas no hay nada que soltar.
    }
  };
}
