import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { DEFAULT_HOTKEY_MAP, type HotkeyMap } from './settings';
import {
  comboProblem,
  conflictingSlots,
  formatCombo,
  hotkeyTimeframe,
  isEditableTarget,
  isReservedCombo,
  matchHotkey,
  normalizeCombo,
  parseCombo,
  showTimeframeToast,
} from './hotkeys';

describe('parseCombo / formatCombo', () => {
  it('acepta Alt+Shift+1 y lo devuelve en orden canónico', () => {
    expect(parseCombo('Alt+Shift+1')).toEqual({ ctrl: false, alt: true, shift: true, meta: false, key: '1' });
    expect(formatCombo(parseCombo('Shift+Alt+ArrowLeft')!)).toBe('Alt+Shift+ArrowLeft');
    expect(normalizeCombo('alt+shift+a')).toBe('Alt+Shift+A');
    expect(normalizeCombo('  Ctrl + Alt + Period  ')).toBe('Ctrl+Alt+Period');
  });

  it('exige un modificador de mando: solo Mayús no es un atajo', () => {
    expect(parseCombo('Shift+1')).toBeNull();
    expect(parseCombo('1')).toBeNull();
    expect(normalizeCombo('Shift+A')).toBeNull();
    expect(normalizeCombo('')).toBeNull();
    expect(normalizeCombo(null)).toBeNull();
    expect(normalizeCombo(42)).toBeNull();
  });

  it('rechaza teclas desconocidas y combinaciones ambiguas', () => {
    expect(normalizeCombo('Alt+Shift+NotAKey')).toBeNull();
    expect(normalizeCombo('Alt+Shift+A+B')).toBeNull();
    expect(normalizeCombo('Alt+Alt+A')).toBeNull();
    expect(normalizeCombo('Alt')).toBeNull();
  });

  it('no acepta F1..F12: se retiraron de la extensión', () => {
    expect(normalizeCombo('Alt+F1')).toBeNull();
    expect(normalizeCombo('Alt+Shift+F5')).toBeNull();
    expect(normalizeCombo('Alt+F12')).toBeNull();
    expect(normalizeCombo('Alt+F13')).toBeNull();
  });
});

describe('comboProblem / conflictingSlots', () => {
  it('marca reservados del navegador', () => {
    expect(isReservedCombo('Ctrl+T')).toBe(true);
    expect(isReservedCombo('ctrl+t')).toBe(true);
    expect(isReservedCombo('Alt+ArrowLeft')).toBe(true);
    expect(isReservedCombo('alt+arrowleft')).toBe(true);
    expect(isReservedCombo('Alt+Shift+1')).toBe(false);
    expect(comboProblem('Ctrl+W', DEFAULT_HOTKEY_MAP, '1')).toBe('reserved');
    expect(comboProblem('Alt+ArrowLeft', DEFAULT_HOTKEY_MAP, '1')).toBe('reserved');
  });

  it('marca inválidos y duplicados', () => {
    expect(comboProblem('F3', DEFAULT_HOTKEY_MAP, '1')).toBe('invalid');
    expect(comboProblem('Alt+Shift+2', DEFAULT_HOTKEY_MAP, '1')).toBe('duplicate');
    expect(comboProblem('Alt+Shift+2', DEFAULT_HOTKEY_MAP, '2')).toBeNull();
    expect(comboProblem('Alt+Shift+9', DEFAULT_HOTKEY_MAP, '1')).toBeNull();
  });

  it('encuentra los huecos que chocan entre sí', () => {
    const map: HotkeyMap = {
      ...DEFAULT_HOTKEY_MAP,
      '2': { ...DEFAULT_HOTKEY_MAP['2']!, combo: 'Alt+Shift+1' },
    };
    expect(conflictingSlots(map)).toEqual(['1', '2']);
    expect(conflictingSlots(DEFAULT_HOTKEY_MAP)).toEqual([]);
  });
});

describe('isEditableTarget', () => {
  it('detecta campos editables y foco activo', () => {
    for (const t of ['INPUT', 'TEXTAREA', 'SELECT']) expect(isEditableTarget({ tagName: t })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: 'SPAN', closest: (s: string) => (s.includes('contenteditable') ? {} : null) })).toBe(true);
    expect(isEditableTarget({ tagName: 'BODY', ownerDocument: { activeElement: { tagName: 'INPUT' } } })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV' })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('hotkeyTimeframe', () => {
  it('los defaults son Alt+Mayús+1..6 con las seis temporalidades', () => {
    const keys = ['1', '2', '3', '4', '5', '6'];
    expect(keys.map((key) => DEFAULT_HOTKEY_MAP[key as keyof typeof DEFAULT_HOTKEY_MAP]!.combo)).toEqual([
      'Alt+Shift+1', 'Alt+Shift+2', 'Alt+Shift+3', 'Alt+Shift+4', 'Alt+Shift+5', 'Alt+Shift+6',
    ]);
    expect(hotkeyTimeframe({ key: '1', altKey: true, shiftKey: true }, DEFAULT_HOTKEY_MAP, true)).toBe('1m');
    expect(hotkeyTimeframe({ key: '3', altKey: true, shiftKey: true }, DEFAULT_HOTKEY_MAP, true)).toBe('15m');
    expect(hotkeyTimeframe({ key: '6', altKey: true, shiftKey: true }, DEFAULT_HOTKEY_MAP, true)).toBe('1d');
  });

  it('las teclas de función ya no disparan nada', () => {
    expect(hotkeyTimeframe({ key: 'F1' }, DEFAULT_HOTKEY_MAP, true)).toBeNull();
    expect(hotkeyTimeframe({ key: 'F3', shiftKey: true }, DEFAULT_HOTKEY_MAP, true)).toBeNull();
  });

  it('exige los modificadores exactos', () => {
    expect(hotkeyTimeframe({ key: '1', altKey: true }, DEFAULT_HOTKEY_MAP, true)).toBeNull();
    expect(hotkeyTimeframe({ key: '1', altKey: true, shiftKey: true, ctrlKey: true }, DEFAULT_HOTKEY_MAP, true)).toBeNull();
    expect(hotkeyTimeframe({ key: '1', altKey: true, shiftKey: true }, DEFAULT_HOTKEY_MAP, false)).toBeNull();
  });

  it('no dispara mientras se escribe ni con Mayús sola', () => {
    expect(
      hotkeyTimeframe({ key: '1', altKey: true, shiftKey: true, target: { tagName: 'INPUT' } }, DEFAULT_HOTKEY_MAP, true),
    ).toBeNull();
    expect(hotkeyTimeframe({ key: '1', shiftKey: true }, DEFAULT_HOTKEY_MAP, true)).toBeNull();
  });

  it('respeta la combinación que el usuario haya puesto', () => {
    const map: HotkeyMap = {
      ...DEFAULT_HOTKEY_MAP,
      '1': { combo: 'Ctrl+Alt+7', timeframe: '4h' },
      '2': { combo: 'Alt+Shift+2', timeframe: null },
    };
    expect(hotkeyTimeframe({ key: '7', ctrlKey: true, altKey: true }, map, true)).toBe('4h');
    expect(hotkeyTimeframe({ key: '1', altKey: true, shiftKey: true }, map, true)).toBeNull();
    // Hueco sin temporalidad: el atajo existe pero no hace nada.
    expect(hotkeyTimeframe({ key: '2', altKey: true, shiftKey: true }, map, true)).toBeNull();
    expect(matchHotkey({ key: '7', ctrlKey: true, altKey: true }, map, true)?.combo).toBe('Ctrl+Alt+7');
  });
});

describe('showTimeframeToast', () => {
  it('crea y reemplaza el aviso en el DOM', () => {
    const { document: doc } = parseHTML('<!doctype html><html><body></body></html>');
    expect(showTimeframeToast(doc, '5m')?.textContent).toContain('5m');
    expect(showTimeframeToast(doc, '15m')?.textContent).toContain('15m');
    expect(doc.querySelectorAll('#swal-timeframe-toast')).toHaveLength(1);
  });
});
