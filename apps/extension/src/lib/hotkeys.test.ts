import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { DEFAULT_HOTKEY_MAP, type HotkeyMap } from './settings';
import { hasModifiers, isEditableTarget, resolveHotkeyTimeframe, shouldHandleHotkey, showTimeframeToast } from './hotkeys';

describe('hotkeys', () => {
  it('isEditableTarget detecta campos editables y foco activo', () => {
    for (const t of ['INPUT', 'TEXTAREA', 'SELECT']) expect(isEditableTarget({ tagName: t })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: 'SPAN', closest: (s: string) => (s.includes('contenteditable') ? {} : null) })).toBe(true);
    expect(isEditableTarget({ tagName: 'BODY', ownerDocument: { activeElement: { tagName: 'INPUT' } } })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV' })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it('hasModifiers detecta Ctrl, Alt y Meta', () => {
    expect(hasModifiers({ ctrlKey: true })).toBe(true);
    expect(hasModifiers({ altKey: true })).toBe(true);
    expect(hasModifiers({ metaKey: true })).toBe(true);
    expect(hasModifiers({ ctrlKey: false })).toBe(false);
  });

  it('resolveHotkeyTimeframe y shouldHandleHotkey respetan atajos, modificadores y edición', () => {
    expect(resolveHotkeyTimeframe('F1', DEFAULT_HOTKEY_MAP, true)).toBe('1m');
    expect(resolveHotkeyTimeframe('F3', DEFAULT_HOTKEY_MAP, true)).toBe('15m');
    expect(resolveHotkeyTimeframe('F6', DEFAULT_HOTKEY_MAP, true)).toBeNull();
    expect(resolveHotkeyTimeframe('F3', DEFAULT_HOTKEY_MAP, false)).toBeNull();
    const custom: HotkeyMap = { ...DEFAULT_HOTKEY_MAP, F6: '1d' };
    expect(resolveHotkeyTimeframe('F6', custom, true)).toBe('1d');
    expect(shouldHandleHotkey({ key: 'F3', ctrlKey: true }, DEFAULT_HOTKEY_MAP, true)).toBeNull();
    expect(shouldHandleHotkey({ key: 'F3', target: { tagName: 'INPUT' } }, DEFAULT_HOTKEY_MAP, true)).toBeNull();
    expect(shouldHandleHotkey({ key: 'F3', target: { tagName: 'DIV' } }, DEFAULT_HOTKEY_MAP, true)).toBe('15m');
    expect(shouldHandleHotkey({ key: 'F6', target: { tagName: 'DIV' } }, DEFAULT_HOTKEY_MAP, true)).toBeNull();
  });

  it('showTimeframeToast crea y reemplaza el aviso en el DOM', () => {
    const { document: doc } = parseHTML('<!doctype html><html><body></body></html>');
    expect(showTimeframeToast(doc, '5m')?.textContent).toContain('5m');
    expect(showTimeframeToast(doc, '15m')?.textContent).toContain('15m');
    expect(doc.querySelectorAll('#swal-timeframe-toast')).toHaveLength(1);
  });
});
