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
}

export type ComboProblem = 'invalid' | 'reserved' | 'duplicate';

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

export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as {
    tagName?: unknown; isContentEditable?: unknown; getAttribute?: (attr: string) => string | null;
    closest?: (s: string) => unknown; ownerDocument?: { activeElement?: { tagName?: unknown; isContentEditable?: unknown } };
  };
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || el.isContentEditable === true) return true;
  if (typeof el.getAttribute === 'function' && ['true', ''].includes(el.getAttribute('contenteditable') ?? 'x')) return true;
  try { if (el.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return true; } catch {}
  const active = el.ownerDocument?.activeElement;
  if (active && active !== el) {
    const atag = typeof active.tagName === 'string' ? active.tagName.toUpperCase() : '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(atag) || active.isContentEditable === true) return true;
  }
  return false;
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

/**
 * Atajo que dispara el evento, o null. Exige los modificadores EXACTOS: si
 * `Alt+Shift+1` está asignado, `Ctrl+Alt+Shift+1` no dispara nada. Nunca
 * dispara mientras se escribe en un campo.
 */
export function matchHotkey(
  event: KeyboardEventLike,
  map: HotkeyMap,
  enabled: boolean,
): HotkeyBinding | null {
  if (!enabled) return null;
  if (isEditableTarget(event.target)) return null;
  const combo = comboFromEvent(event);
  if (!combo) return null;
  const wanted = formatCombo(combo).toLowerCase();
  for (const slot of HOTKEY_SLOTS) {
    const binding = map[slot];
    if (!binding || typeof binding.combo !== 'string' || !binding.combo) continue;
    if (binding.combo.toLowerCase() !== wanted) continue;
    return binding;
  }
  return null;
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
  if (!enabled) return null;
  if (isEditableTarget(event.target)) return null;
  const combo = comboFromEvent(event);
  if (!combo) return null;
  const wanted = formatCombo(combo).toLowerCase();
  for (const slot of HOTKEY_SLOTS) {
    const binding = map[slot];
    if (!binding || typeof binding.combo !== 'string' || !binding.combo) continue;
    if (binding.combo.toLowerCase() !== wanted) continue;
    return actionOfSlot(slot, binding);
  }
  return null;
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
