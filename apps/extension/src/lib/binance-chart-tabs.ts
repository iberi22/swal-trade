/**
 * Localización y cambio de pestañas en el encabezado del gráfico de Binance Futures.
 *
 * En Binance Futures las pestañas del gráfico son:
 * - "Original" (gráfico canvas propio de Binance, sin API pública)
 * - "Trading View" (iframe sameorigin con la Charting Library y API de dibujo)
 * - "Depth" / "Profundidad" (libro de órdenes en profundidad)
 *
 * El usuario normal vive en "Original"; para pintar sobre el gráfico se cambia
 * automáticamente a "Trading View" y se ofrece volver a "Original".
 */

export type BinanceChartTab = 'tradingView' | 'original' | 'depth';

export const TAB_LABELS: Record<BinanceChartTab, string> = {
  tradingView: 'Trading View',
  original: 'Original',
  depth: 'Depth',
};

const TAB_MATCHERS: Record<BinanceChartTab, RegExp> = {
  tradingView: /^\s*Trading\s*View\s*$/i,
  original: /^\s*Original\s*$/i,
  depth: /^\s*(Depth|Profundidad)\s*$/i,
};

const ACTIVE_ATTRS = [
  'aria-selected',
  'aria-checked',
  'aria-pressed',
  'data-active',
  'data-selected',
];

const ACTIVE_CLASS = /(^|\s)(active|is-active|selected|current|tab-active)(\s|$)/i;

/** Comprueba si el elemento o su contenedor inmediato está marcado como activo. */
export function isTabActive(element: Element): boolean {
  for (const attr of ACTIVE_ATTRS) {
    if (element.getAttribute(attr) === 'true') return true;
    if (element.parentElement?.getAttribute(attr) === 'true') return true;
  }
  if (element.getAttribute('data-state') === 'active') return true;
  if (element.parentElement?.getAttribute('data-state') === 'active') return true;

  const classNames = `${typeof element.className === 'string' ? element.className : ''} ${
    typeof element.parentElement?.className === 'string' ? element.parentElement.className : ''
  }`;

  if (ACTIVE_CLASS.test(classNames)) return true;

  // En Binance Tailwind: pestaña activa usa textPrimary / primaryText / text-[--color-PrimaryText];
  // la inactiva usa textSecondary o text-[--color-TertiaryText] (ambas tienen hover:text-[--color-PrimaryText]).
  if (/(?:^|\s)text-(?:textPrimary|primaryText|text-primary|\[--color-PrimaryText\])(?:\s|$)/i.test(classNames)) {
    return true;
  }

  return false;
}

/**
 * Busca el elemento interactivo de una pestaña del gráfico dentro del DOM.
 * Prioriza elementos dentro del área de pestañas del gráfico (hermanos con otras pestañas).
 */
export function findChartTabElement(
  doc: Document | Element,
  targetTab: BinanceChartTab,
): HTMLElement | null {
  const matcher = TAB_MATCHERS[targetTab];
  if (!matcher) return null;

  // Buscar todos los elementos candidatos con texto coincidente
  const candidates: HTMLElement[] = [];
  const elements = doc.querySelectorAll('div, span, button, a, li, [role="tab"]');
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i] as HTMLElement;
    // Evitar contenedores grandes que incluyen múltiples hijos
    if (el.childElementCount > 1) continue;
    const text = (el.textContent ?? '').trim();
    if (matcher.test(text)) {
      candidates.push(el);
    }
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;

  // Si hay varios, elegir el que comparte ancestro con otra pestaña del gráfico
  const otherMatchers = Object.entries(TAB_MATCHERS)
    .filter(([k]) => k !== targetTab)
    .map(([, m]) => m);

  for (const candidate of candidates) {
    const parent = candidate.parentElement;
    const grandparent = parent?.parentElement;
    const container = grandparent ?? parent;
    if (container) {
      const containerText = container.textContent ?? '';
      if (otherMatchers.some((m) => m.test(containerText))) {
        return candidate;
      }
    }
  }

  return candidates[candidates.length - 1]!;
}

/** Devuelve la pestaña actualmente activa en el gráfico, o null si no se detecta. */
export function getActiveChartTab(doc: Document | Element): BinanceChartTab | null {
  const tabs: BinanceChartTab[] = ['tradingView', 'original', 'depth'];
  for (const tab of tabs) {
    const el = findChartTabElement(doc, tab);
    if (el && isTabActive(el)) {
      return tab;
    }
  }
  return null;
}

export interface SwitchChartTabResult {
  ok: boolean;
  switched: boolean;
  error?: string;
}

/**
 * Cambia a la pestaña indicada haciendo clic en su control si no está activa.
 */
export function switchChartTab(
  doc: Document | Element,
  targetTab: BinanceChartTab,
): SwitchChartTabResult {
  const element = findChartTabElement(doc, targetTab);
  if (!element) {
    return {
      ok: false,
      switched: false,
      error: `no se encontró la pestaña ${TAB_LABELS[targetTab] ?? targetTab}`,
    };
  }

  if (isTabActive(element)) {
    return { ok: true, switched: false };
  }

  try {
    element.click();
    return { ok: true, switched: true };
  } catch (err) {
    return { ok: false, switched: false, error: String(err) };
  }
}
