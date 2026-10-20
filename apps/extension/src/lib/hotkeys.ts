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
  keyLabel,
  normalizeCombo,
  parseCombo,
  type Combo,
} from './key-combo';
import { HOTKEY_SLOTS, type HotkeyBinding, type HotkeyMap, type HotkeySlot } from './settings';
import type { Timeframe } from './types';

export type { Combo } from './key-combo';
export {
  RESERVED_COMBOS,
  formatCombo,
  hasCommandModifier,
  isReservedCombo,
  normalizeCombo,
  parseCombo,
} from './key-combo';

export interface KeyboardEventLike {
  key: string;
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

/** Combo del evento, si lo tiene; null si le falta modificador o la tecla no se reconoce. */
export function comboFromEvent(event: KeyboardEventLike): Combo | null {
  if (!event || typeof event.key !== 'string') return null;
  const key = keyLabel(event.key);
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
    if (!binding || binding.timeframe === null) continue;
    if (binding.combo.toLowerCase() !== wanted) continue;
    return binding;
  }
  return null;
}

/** Temporalidad del atajo que dispara el evento, o null. */
export function hotkeyTimeframe(
  event: KeyboardEventLike,
  map: HotkeyMap,
  enabled: boolean,
): Timeframe | null {
  return matchHotkey(event, map, enabled)?.timeframe ?? null;
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
