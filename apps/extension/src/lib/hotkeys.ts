// Atajos de teclado de la extensión: combinaciones explícitas (Alt+Mayús+1, ...)
// que el usuario puede editar en Ajustes. Nada de F1..F12: esas teclas son del
// navegador y del sistema (F1 abre la ayuda, F5 recarga, F11 pantalla completa)
// y la extensión no debe pelearse con ellas.
//
// El parseo y la canonicidad viven en `key-combo.ts`; aquí se decide qué atajo
// dispara un evento y se avisa en la página. Quien escucha es el content script
// (página de Binance) y el panel (sidepanel); este módulo no registra listeners.

import {
  formatCombo,
  hasCommandModifier,
  isReservedCombo,
  keyFromCode,
  keyLabel,
  normalizeCombo,
  parseCombo,
  type Combo,
} from './key-combo';
import {
  HOTKEY_SLOTS,
  isTimeframeSlot,
  type HotkeyBinding,
  type HotkeyMap,
  type HotkeySlot,
} from './settings';
import type { Timeframe } from './types';

export type { Combo } from './key-combo';
export {
  RESERVED_COMBOS,
  formatCombo,
  hasCommandModifier,
  isReservedCombo,
  keyFromCode,
  normalizeCombo,
  parseCombo,
} from './key-combo';

export interface KeyboardEventLike {
  key: string;
  /** Posición física de la tecla: manda sobre `key` cuando está. */
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  target?: unknown;
  /**
   * Event path. Inside a Shadow DOM the `target` is the host, not the field
   * holding focus: this is how the real element is found.
   */
  composedPath?: () => ArrayLike<unknown>;
}

export type ComboProblem = 'invalid' | 'reserved' | 'duplicate';

/** Quote assets the panel resolves a bare base against. */
export const PAIR_QUOTES = ['USDT', 'USDC', 'BUSD'] as const;

/** Motivo por el que un combo no se puede usar en ese hueco, o null si vale. */
export function comboProblem(
  input: unknown,
  bindings: HotkeyMap,
  slot: HotkeySlot | null = null,
): ComboProblem | null {
  const combo = normalizeCombo(input);
  if (!combo) return 'invalid';
  if (isReservedCombo(combo)) return 'reserved';
  const id = combo.toLowerCase();
  for (const other of HOTKEY_SLOTS) {
    if (other === slot) continue;
    const existing = bindings[other]?.combo;
    if (typeof existing !== 'string') continue;
    if (existing.toLowerCase() === id) return 'duplicate';
  }
  return null;
}

/** Huecos cuyo combo choca con otro hueco. Vacío si no hay choques. */
export function conflictingSlots(bindings: HotkeyMap): HotkeySlot[] {
  const seen = new Map<string, HotkeySlot[]>();
  for (const slot of HOTKEY_SLOTS) {
    const combo = bindings[slot]?.combo;
    if (typeof combo !== 'string' || !combo) continue;
    const id = combo.toLowerCase();
    seen.set(id, [...(seen.get(id) ?? []), slot]);
  }
  const out: HotkeySlot[] = [];
  for (const slots of seen.values()) {
    if (slots.length > 1) out.push(...slots);
  }
  return out;
}

/**
 * First element of the event's composed path, or `target` when there is no
 * `composedPath` (synthetic events, old browsers). Inside a Shadow DOM the
 * `target` is the host: looking at the host let hotkeys fire while typing in a
 * field of the shadow tree.
 */
export function composedTarget(event: KeyboardEventLike | null | undefined): unknown {
  if (!event || typeof event !== 'object') return null;
  try {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : null;
    if (path && typeof path.length === 'number') {
      for (let i = 0; i < path.length; i += 1) {
        const item = path[i];
        if (item && typeof item === 'object') return item;
      }
    }
  } catch {
    // `composedPath` no disponible: se usa el target.
  }
  return event.target;
}

/** `document.activeElement`, descending through `shadowRoot` to the real field. */
function activeElementDeep(start: unknown): unknown {
  if (!start || typeof start !== 'object') return null;
  const seen = new Set<unknown>();
  let active: unknown = start;
  try {
    while (active && typeof active === 'object' && !seen.has(active)) {
      seen.add(active);
      const inner = (active as { shadowRoot?: { activeElement?: unknown } | null }).shadowRoot?.activeElement;
      if (!inner) break;
      active = inner;
    }
  } catch {
    return active;
  }
  return active;
}

/** One concrete element is editable (field, select or contenteditable). */
function isEditableElement(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as {
    tagName?: unknown;
    isContentEditable?: unknown;
    getAttribute?: (attr: string) => string | null;
    closest?: (s: string) => unknown;
  };
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || el.isContentEditable === true) return true;
  if (typeof el.getAttribute === 'function' && ['true', ''].includes(el.getAttribute('contenteditable') ?? 'x')) return true;
  try {
    if (el.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return true;
  } catch {}
  return false;
}

export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  if (isEditableElement(target)) return true;
  const docActive = (target as { ownerDocument?: { activeElement?: unknown } }).ownerDocument?.activeElement;
  const active = activeElementDeep(docActive ?? target);
  return active != null && active !== target && isEditableElement(active);
}

/**
 * Combo del evento, si lo tiene; null si le falta modificador o la tecla no se
 * reconoce.
 *
 * La tecla sale de `event.code` (posición física) para que `Alt+Shift+1`
 * dispare aunque `event.key` diga `'!'` — que es lo que produce Alt+Shift+1 en
 * casi cualquier distribución — y para que la misma tecla valga en AZERTY.
 * `event.key` solo se usa cuando el evento no trae `code` (teclados virtuales,
 * eventos sintéticos).
 */
export function comboFromEvent(event: KeyboardEventLike): Combo | null {
  if (!event) return null;
  const fromCode = keyFromCode(event.code);
  const key = fromCode ?? (typeof event.key === 'string' ? keyLabel(event.key) : null);
  if (!key) return null;
  const combo: Combo = {
    ctrl: event.ctrlKey === true,
    alt: event.altKey === true,
    shift: event.shiftKey === true,
    meta: event.metaKey === true,
    key,
  };
  return hasCommandModifier(combo) ? combo : null;
}

/** Hueco y enlace que dispara el evento, o null. */
function hitFor(event: KeyboardEventLike, map: HotkeyMap, enabled: boolean): { slot: HotkeySlot; binding: HotkeyBinding } | null {
  if (!enabled) return null;
  if (isEditableTarget(composedTarget(event))) return null;
  const combo = comboFromEvent(event);
  if (!combo) return null;
  const wanted = formatCombo(combo).toLowerCase();
  for (const slot of HOTKEY_SLOTS) {
    const binding = map[slot];
    if (!binding || typeof binding.combo !== 'string' || !binding.combo) continue;
    if (binding.combo.toLowerCase() !== wanted) continue;
    return { slot, binding };
  }
  return null;
}

/**
 * Atajo que dispara el evento, o null. Exige los modificadores EXACTOS: si
 * `Alt+Shift+1` está asignado, `Ctrl+Alt+Shift+1` no dispara nada. Nunca
 * dispara mientras se escribe en un campo, tampoco dentro de un Shadow DOM.
 */
export function matchHotkey(
  event: KeyboardEventLike,
  map: HotkeyMap,
  enabled: boolean,
): HotkeyBinding | null {
  return hitFor(event, map, enabled)?.binding ?? null;
}

/** Acción que dispara un hueco. Los huecos de temporalidad se guardan aparte. */
export type HotkeyAction =
  /** Cambia la temporalidad del análisis. */
  | { type: 'timeframe'; timeframe: Timeframe }
  /** Avanza (`1`) o retrocede (`-1`) por la lista de símbolos del usuario. */
  | { type: 'symbol'; direction: 1 | -1 }
  /** Enciende o apaga el pintado de niveles en el gráfico. */
  | { type: 'paint' }
  /** Lleva el foco a la tarjeta «Tu dibujo». */
  | { type: 'drawing' };

/** Acción de un hueco, o null si el hueco no tiene atajo utilizable. */
export function actionOfSlot(slot: HotkeySlot, binding: HotkeyBinding | undefined): HotkeyAction | null {
  if (!binding) return null;
  if (isTimeframeSlot(slot)) {
    return binding.timeframe ? { type: 'timeframe', timeframe: binding.timeframe } : null;
  }
  switch (slot) {
    case 'next-symbol':
      return { type: 'symbol', direction: 1 };
    case 'prev-symbol':
      return { type: 'symbol', direction: -1 };
    case 'toggle-paint':
      return { type: 'paint' };
    case 'focus-drawing':
      return { type: 'drawing' };
    default:
      return null;
  }
}

/**
 * Acción que dispara el evento, o null. Es el despacho puro de los atajos:
 * mismo combo -> misma acción, sin tocar el DOM ni los ajustes.
 */
export function hotkeyAction(
  event: KeyboardEventLike,
  map: HotkeyMap,
  enabled: boolean,
): HotkeyAction | null {
  const hit = hitFor(event, map, enabled);
  return hit ? actionOfSlot(hit.slot, hit.binding) : null;
}

/** Resultado de editar un atajo: el combo canónico a guardar y su problema. */
export interface ComboEdit {
  /** Forma canónica (`Alt+Shift+A`); vacío si el texto era inválido. */
  combo: string;
  problem: ComboProblem | null;
}

/**
 * Valida y canonicaliza lo que el usuario escribe en el editor de atajos.
 * Acepta `shift+alt+a`, `Shift + Alt + A` y `Alt+Shift+A`, y siempre devuelve
 * la forma canónica que se guarda y con la que se compara al escuchar: si se
 * guardara el texto tal cual, `shift+alt+a` nunca dispararía `Alt+Shift+A`.
 */
export function editCombo(input: unknown, bindings: HotkeyMap, slot: HotkeySlot): ComboEdit {
  const problem = comboProblem(input, bindings, slot);
  if (problem) return { combo: '', problem };
  return { combo: normalizeCombo(input) ?? '', problem: null };
}

/** Temporalidad del atajo que dispara el evento, o null. */
export function hotkeyTimeframe(
  event: KeyboardEventLike,
  map: HotkeyMap,
  enabled: boolean,
): Timeframe | null {
  const action = hotkeyAction(event, map, enabled);
  return action?.type === 'timeframe' ? action.timeframe : null;
}

/** Un evento del escáner, con lo mínimo para sacar símbolos. */
export interface ScanSymbolEvent {
  symbol?: unknown;
  symbols?: unknown;
}

/**
 * Lista de símbolos por la que avanzan los atajos: la del usuario si la puso
 * (Ajustes > Símbolos) y, si está vacía, la del escáner (las señales que ya
 * vio). Sin duplicados y en el orden recibido.
 */
export function symbolPool(
  settingsSymbols: readonly string[],
  scannerEvents: readonly ScanSymbolEvent[] = [],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown) => {
    const symbol = typeof value === 'string' ? value.trim().toUpperCase() : '';
    if (!symbol || symbol === 'MARKET' || seen.has(symbol)) return;
    seen.add(symbol);
    out.push(symbol);
  };
  for (const symbol of settingsSymbols) push(symbol);
  for (const event of scannerEvents) {
    push(event?.symbol);
    if (Array.isArray(event?.symbols)) for (const symbol of event.symbols) push(symbol);
  }
  return out;
}

/**
 * Siguiente símbolo del pool, circular. `current` fuera del pool arranca por el
 * primero (`direction: 1`) o por el último (`-1`). Null si el pool está vacío.
 */
export function stepSymbol(
  current: string,
  pool: readonly string[],
  direction: 1 | -1,
): string | null {
  if (pool.length === 0) return null;
  const symbol = typeof current === 'string' ? current.trim().toUpperCase() : '';
  const index = pool.findIndex((candidate) => candidate.toUpperCase() === symbol);
  if (index === -1) return direction === 1 ? pool[0]! : pool[pool.length - 1]!;
  const next = (index + direction + pool.length) % pool.length;
  return pool[next]!;
}

/**
 * Suffix of a full pair, or null. Only the quotes the panel can trade on
 * Binance Futures: anything else is a base that needs a quote appended.
 */
export function quoteAssetOf(symbol: string): string | null {
  const upper = typeof symbol === 'string' ? symbol.trim().toUpperCase() : '';
  return PAIR_QUOTES.find((quote) => upper.endsWith(quote) && upper.length > quote.length) ?? null;
}

/**
 * Full pair for one entry of the user's list. An entry that already is a pair
 * (`ETHUSDC`) is kept; a bare base (`ETH`) takes the quote of the pair the
 * panel is showing (`BTCUSDC` -> `ETHUSDC`), falling back to USDT. Without
 * this, stepping over `BTC, ETH` requested klines for the base itself.
 */
export function resolveSymbolPair(entry: string, currentSymbol: string): string | null {
  if (typeof entry !== 'string') return null;
  const trimmed = entry.trim().toUpperCase().replace(/^\$/, '');
  if (!trimmed) return null;
  const base = trimmed.includes(':') ? (trimmed.split(':').pop() ?? '') : trimmed;
  if (!base) return null;
  const pair = quoteAssetOf(base) ? base : `${base}${quoteAssetOf(currentSymbol) ?? 'USDT'}`;
  return /^[A-Z0-9]{4,30}$/.test(pair) ? pair : null;
}

/**
 * Pool of full pairs in the received order, resolved against the pair the
 * panel is showing and without duplicates. Entries that cannot become a pair
 * are dropped.
 */
export function resolveSymbolPool(pool: readonly string[], currentSymbol: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of pool) {
    const pair = resolveSymbolPair(entry, currentSymbol);
    if (!pair || seen.has(pair)) continue;
    seen.add(pair);
    out.push(pair);
  }
  return out;
}

/** Panel state the hotkeys need to decide their effect. */
export interface HotkeyPanelState {
  symbol: string;
  paintOnChart: boolean;
}

/** What a hotkey asks from the panel. Pure: the panel applies it. */
export type HotkeyEffect =
  | { kind: 'timeframe'; timeframe: Timeframe }
  | { kind: 'symbol'; symbol: string }
  | { kind: 'paint'; paintOnChart: boolean }
  | { kind: 'drawing' };

/**
 * Effect of an action on the panel, or null when there is nothing to do. Pool
 * symbols are resolved to full pairs before stepping, so the panel always
 * requests klines for a real pair.
 */
export function hotkeyEffect(
  action: HotkeyAction | null | undefined,
  state: HotkeyPanelState,
  pool: readonly string[] = [],
): HotkeyEffect | null {
  if (!action) return null;
  if (action.type === 'timeframe') return { kind: 'timeframe', timeframe: action.timeframe };
  if (action.type === 'paint') return { kind: 'paint', paintOnChart: !state.paintOnChart };
  if (action.type === 'drawing') return { kind: 'drawing' };
  const next = stepSymbol(state.symbol, resolveSymbolPool(pool, state.symbol), action.direction);
  return next ? { kind: 'symbol', symbol: next } : null;
}

/** Selector de la tarjeta «Tu dibujo» en el panel. */
export const DRAWING_CARD_SELECTOR = '[data-testid="drawing-card"]';

/** Lleva el foco a «Tu dibujo» y la deja a la vista. Null si no está montada. */
export function focusDrawingCard(doc: Document): Element | null {
  try {
    const card = doc.querySelector(DRAWING_CARD_SELECTOR);
    if (!card) return null;
    card.scrollIntoView?.({ block: 'start' });
    const focusable = card as Element & { focus?: () => void; tabIndex?: number };
    if (typeof focusable.focus === 'function') {
      focusable.tabIndex = -1;
      focusable.focus();
    }
    return card;
  } catch {
    return null;
  }
}

export function showTimeframeToast(doc: Document, timeframe: string): HTMLElement | null {
  try {
    doc.getElementById('swal-timeframe-toast')?.remove();
    const toast = doc.createElement('div');
    toast.id = 'swal-timeframe-toast';
    toast.textContent = `Temporalidad: ${timeframe}`;
    toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#f7f5f0;color:#231f1d;border:1px solid #ddd8cc;border-radius:8px;padding:6px 14px;font:500 13px/1.4 ui-sans-serif,system-ui,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.12);pointer-events:none;transition:opacity .2s;';
    (doc.body ?? doc.documentElement)?.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 200); }, 1200);
    return toast;
  } catch {
    return null;
  }
}

/** true si el evento lo fabricó un script (isTrusted === false): no dispara atajos. */
export function isSyntheticKeyEvent(event: { isTrusted?: boolean } | null | undefined): boolean {
  return !!event && event.isTrusted === false;
}
