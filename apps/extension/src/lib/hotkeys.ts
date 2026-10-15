import { HOTKEY_KEYS, type HotkeyKey, type HotkeyMap } from './settings';
import type { Timeframe } from './types';

export interface KeyboardEventLike {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  target?: unknown;
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

export const hasModifiers = (e: { ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }): boolean =>
  Boolean(e.ctrlKey || e.altKey || e.metaKey);

export function resolveHotkeyTimeframe(key: string, map: HotkeyMap, enabled: boolean): Timeframe | null {
  return enabled && (HOTKEY_KEYS as readonly string[]).includes(key) ? map[key as HotkeyKey] ?? null : null;
}

export function shouldHandleHotkey(event: KeyboardEventLike, map: HotkeyMap, enabled: boolean): Timeframe | null {
  return !enabled || hasModifiers(event) || isEditableTarget(event.target) ? null : resolveHotkeyTimeframe(event.key, map, enabled);
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
