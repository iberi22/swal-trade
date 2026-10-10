import { parseIntervalLabel } from './market-context';
import type { Timeframe } from './types';

export type PageSource = 'binance' | 'tradingview';

/**
 * Instantánea de un control de intervalo de la página. La construye
 * `collectIntervalControls`; decidir con ella es puro (`intervalFromControls`).
 */
export interface IntervalControl {
  /** Temporalidad normalizada del control (una de las seis del panel). */
  text: Timeframe;
  /** La página marca el control como el elegido. */
  active: boolean;
  /** Índice del grupo de hermanos al que pertenece. */
  group: number;
}

/** Un `Document` de navegador y el de linkedom (tests) sirven. */
export type ProbeDocument = {
  querySelectorAll(selectors: string): ArrayLike<Element>;
  querySelector(selectors: string): Element | null;
};

/**
 * Controles que pueden ser un botón de intervalo. Se mantiene estrecho a
 * propósito: en Binance el DOM tiene miles de nodos y barrer `div` genéricos
 * recorrería la página entera en cada mutación del gráfico.
 */
export const CONTROL_SELECTOR = [
  'button',
  '[role="tab"]',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="button"]',
].join(', ');

/** Igual, pero para mirar DENTRO de una barra que ya sabemos que es de intervalos. */
export const TOOLBAR_TOOL_SELECTOR = [
  'button',
  '[role]',
  '[data-value]',
  '[data-interval]',
  '[data-resolution]',
  '[data-active]',
  'span',
  'div',
].join(', ');

/** Atributos de los que se puede leer la etiqueta, en orden de preferencia. */
const LABEL_ATTRS = ['data-value', 'data-interval', 'data-resolution', 'data-name', 'aria-label', 'title'];

/** Atributos con los que la página marca el control activo. */
const ACTIVE_ATTRS: Readonly<Record<string, readonly string[]>> = {
  'aria-pressed': ['true'],
  'aria-checked': ['true'],
  'aria-selected': ['true'],
  'data-active': ['true'],
  'data-selected': ['true'],
  'data-state': ['active', 'selected', 'checked'],
};

/** Clases con las que las SPAs marcan el botón elegido. */
const ACTIVE_CLASS = /(?:^|[\s_-])(?:is-)?(?:active|selected|checked|current)(?:$|[\s_-])/i;

/** Contenedores cuyo nombre habla de intervalo: atajo para dropdowns compactos. */
export const TOOLBAR_SELECTOR = [
  '[id*="interval" i]',
  '[class*="interval" i]',
  '[data-testid*="interval" i]',
  '[data-testid*="timeframe" i]',
  '[data-bni-type*="interval" i]',
  '[aria-label*="interval" i]',
  '[aria-label*="timeframe" i]',
].join(', ');

/**
 * Claves de storage que pueden guardar el intervalo del gráfico. Se leen SOLO
 * estas y SOLO su valor: nunca se enumera el almacenamiento de la página, que
 * ahí sí vive información de cuenta.
 */
export const STORAGE_KEYS: readonly string[] = [
  'binance_futures_kline_interval',
  'binance_futures_chart_interval',
  'binance_kline_interval',
  'binance_chart_interval',
  'futures_kline_interval',
  'futures_chart_interval',
  'last_kline_interval',
  'trading_kline_interval',
  'kline_interval',
  'chart_interval',
  'klineInterval',
  'chartInterval',
  'futures_interval',
  'futuresInterval',
  'tradingview_chart_interval',
  'tradingview_chart_resolution',
  'chart_resolution',
  'timeframe',
  'interval',
];

/** Envuelve el parser único de etiquetas con el modo desnudo de cada sitio. */
export function labelFromText(text: unknown, source: PageSource): Timeframe | null {
  return parseIntervalLabel(typeof text === 'string' ? text : null, { bare: source === 'tradingview' });
}

function readLabel(element: Element, source: PageSource): Timeframe | null {
  const own = (element.textContent ?? '').trim();
  const fromText = labelFromText(own, source);
  if (fromText) return fromText;
  for (const attr of LABEL_ATTRS) {
    const value = element.getAttribute?.(attr);
    const fromAttr = labelFromText(value, source);
    if (fromAttr) return fromAttr;
  }
  return null;
}

function isActive(element: Element): boolean {
  for (const [attr, values] of Object.entries(ACTIVE_ATTRS)) {
    const value = element.getAttribute?.(attr);
    if (typeof value === 'string' && values.includes(value.toLowerCase())) return true;
  }
  const className = typeof element.className === 'string' ? element.className : '';
  return ACTIVE_CLASS.test(className);
}

function groupOf(element: Element, groups: Map<Element, number>): number {
  const parent = element.parentElement ?? element;
  let index = groups.get(parent);
  if (index === undefined) {
    index = groups.size;
    groups.set(parent, index);
  }
  return index;
}

/**
 * Recorre el DOM y devuelve los controles cuya etiqueta es una temporalidad.
 * Puro respecto al árbol que recibe: el content script le pasa el suyo y los
 * tests el que linkedom construye desde los fixtures HTML.
 */
export function collectIntervalControls(
  doc: ProbeDocument,
  source: PageSource,
  selector: string = CONTROL_SELECTOR,
): IntervalControl[] {
  const groups = new Map<Element, number>();
  const out: IntervalControl[] = [];
  for (const element of Array.from(doc.querySelectorAll(selector)) as Element[]) {
    const text = readLabel(element, source);
    if (!text) continue;
    out.push({ text, active: isActive(element), group: groupOf(element, groups) });
  }
  return out;
}

/**
 * Grupo con más temporalidades distintas. Una barra de intervalos real tiene
 * las seis; un botón suelto con "1h" en otro sitio no forma grupo.
 */
export function bestIntervalGroup(controls: readonly IntervalControl[]): IntervalControl[] {
  const byGroup = new Map<number, IntervalControl[]>();
  for (const control of controls) {
    const list = byGroup.get(control.group);
    if (list) list.push(control);
    else byGroup.set(control.group, [control]);
  }
  let best: IntervalControl[] = [];
  let bestDistinct = 0;
  for (const list of byGroup.values()) {
    const distinct = new Set(list.map((control) => control.text)).size;
    if (distinct > bestDistinct) {
      best = list;
      bestDistinct = distinct;
    }
  }
  return bestDistinct >= 2 ? best : [];
}

/**
 * Decide la temporalidad a partir de los controles recogidos:
 * 1. el grupo de intervalos con su botón activo,
 * 2. un único control activo que diga una temporalidad,
 * 3. nada. Nunca adivina: si la página no marca ninguno, devuelve null.
 */
export function intervalFromControls(controls: readonly IntervalControl[]): Timeframe | null {
  const group = bestIntervalGroup(controls);
  const activeInGroup = group.find((control) => control.active);
  if (activeInGroup) return activeInGroup.text;
  const activeOnly = controls.filter((control) => control.active);
  if (activeOnly.length === 1) return activeOnly[0]!.text;
  return null;
}

/**
 * Barra compacta: un desplegable que solo enseña el intervalo elegido. Se mira
 * dentro de contenedores que se llaman intervalo y solo se acepta si hay un
 * descendiente marcado como activo, o un único control que no sea él mismo.
 * Un boton suelto de intervalo no es una barra: no se acepta como grupo de uno.
 */
export function toolbarInterval(doc: ProbeDocument, source: PageSource): Timeframe | null {
  for (const toolbar of Array.from(doc.querySelectorAll(TOOLBAR_SELECTOR)) as Element[]) {
    const selfControl = typeof toolbar.matches === 'function' && toolbar.matches(CONTROL_SELECTOR);
    const controls = collectIntervalControls(
      {
        querySelectorAll: (selectors: string) => toolbar.querySelectorAll(selectors),
        querySelector: (selectors: string) => toolbar.querySelector(selectors),
      },
      source,
      TOOLBAR_TOOL_SELECTOR,
    );
    const active = controls.find((control) => control.active);
    if (active) return active.text;
    if (!selfControl && controls.length === 1) return controls[0]!.text;
  }
  return null;
}

/** Temporalidad que la página tiene seleccionada en su DOM, o null. */
export function probeDomInterval(doc: ProbeDocument, source: PageSource): Timeframe | null {
  return (
    intervalFromControls(collectIntervalControls(doc, source)) ?? toolbarInterval(doc, source)
  );
}

/**
 * Lee un valor de storage. Acepta el texto pelado (`15m`) o un envuelto en JSON
 * (`{"interval":"1h"}`). Fuera de TradingView un número pelado no cuenta.
 */
export function parseStoredInterval(raw: unknown, source: PageSource): Timeframe | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.length > 400) return null;
  const direct = labelFromText(text, source);
  if (direct) return direct;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const found: unknown[] = [];
  const walk = (value: unknown, depth: number) => {
    if (depth > 4 || found.length > 8) return;
    if (typeof value === 'string' || typeof value === 'number') {
      found.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 20)) walk(item, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
        // La clave de storage ya era de intervalo: en la raíz se baja por
        // cualquier campo; más abajo solo por los que hablan de intervalo.
        if (depth === 0 || /interval|kline|timeframe|resolution|tf/i.test(key)) {
          walk(item, depth + 1);
        }
      }
    }
  };
  walk(parsed, 0);
  for (const candidate of found) {
    const label = labelFromText(candidate, source);
    if (label) return label;
  }
  return null;
}

/** Primera clave permitida que contenga una temporalidad. */
export function probeStorageInterval(
  read: (key: string) => string | null,
  source: PageSource,
): Timeframe | null {
  for (const key of STORAGE_KEYS) {
    let value: string | null = null;
    try {
      value = read(key);
    } catch {
      return null;
    }
    const parsed = parseStoredInterval(value, source);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * Une DOM y storage. El DOM manda: es lo que el usuario acaba de pulsar. El
 * storage solo rellena cuando la página no pinta la barra de intervalos.
 */
export function resolvePageInterval(input: {
  source: PageSource;
  dom?: string | null;
  storage?: string | null;
}): Timeframe | null {
  return parseStoredInterval(input.dom, input.source) ?? parseStoredInterval(input.storage, input.source);
}
