import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { DEFAULT_HOTKEY_MAP, type HotkeyMap } from './settings';
import {
  comboFromEvent,
  comboProblem,
  conflictingSlots,
  editCombo,
  focusDrawingCard,
  formatCombo,
  hotkeyAction,
  hotkeyTimeframe,
  isEditableTarget,
  isReservedCombo,
  matchHotkey,
  normalizeCombo,
  parseCombo,
  showTimeframeToast,
  stepSymbol,
  symbolPool,
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

describe('atajos por posición física (event.code)', () => {
  it('Alt+Shift+1 dispara aunque event.key sea "!"', () => {
    // En un teclado español o inglés, Alt+Mayús+1 produce '!' en `event.key`.
    // Comparando por `key` el atajo no disparaba nunca.
    const event = { key: '!', code: 'Digit1', altKey: true, shiftKey: true };
    expect(hotkeyTimeframe(event, DEFAULT_HOTKEY_MAP, true)).toBe('1m');
    expect(matchHotkey(event, DEFAULT_HOTKEY_MAP, true)?.combo).toBe('Alt+Shift+1');
    // Y sigue exigiendo los modificadores exactos.
    expect(hotkeyTimeframe({ ...event, ctrlKey: true }, DEFAULT_HOTKEY_MAP, true)).toBeNull();
  });

  it('en AZERTY manda la tecla física, no la letra que escribe', () => {
    // La tecla física KeyQ escribe 'a' en AZERTY: el atajo guardado es el de la
    // posición (Alt+Shift+Q), no el de la letra.
    const map: HotkeyMap = {
      ...DEFAULT_HOTKEY_MAP,
      '1': { combo: 'Alt+Shift+A', timeframe: '15m' },
      '2': { combo: 'Alt+Shift+Q', timeframe: '1h' },
    };
    const azerty = { key: 'a', code: 'KeyQ', altKey: true, shiftKey: true };
    expect(matchHotkey(azerty, map, true)?.combo).toBe('Alt+Shift+Q');
    expect(hotkeyTimeframe(azerty, map, true)).toBe('1h');
    const spanish = { key: 'a', code: 'KeyA', altKey: true, shiftKey: true };
    expect(hotkeyTimeframe(spanish, map, true)).toBe('15m');
  });

  it('las flechas y las letras se reconocen por code', () => {
    expect(comboFromEvent({ key: 'Unknown', code: 'ArrowRight', altKey: true, shiftKey: true })).toEqual({
      ctrl: false, alt: true, shift: true, meta: false, key: 'ArrowRight',
    });
    expect(comboFromEvent({ key: 'Dead', code: 'KeyL', altKey: true })).toEqual({
      ctrl: false, alt: true, shift: false, meta: false, key: 'L',
    });
    // Sin `code` (evento sintético) se usa `key`, como antes.
    expect(comboFromEvent({ key: '1', altKey: true, shiftKey: true })?.key).toBe('1');
    expect(comboFromEvent({ key: ' ', altKey: true })?.key).toBe('Space');
  });
});

describe('editCombo: lo que se guarda es canónico', () => {
  it('shift+alt+a se guarda como Alt+Shift+A y entonces sí dispara', () => {
    const edit = editCombo('shift+alt+a', DEFAULT_HOTKEY_MAP, '1');
    expect(edit).toEqual({ combo: 'Alt+Shift+A', problem: null });
    const map: HotkeyMap = { ...DEFAULT_HOTKEY_MAP, '1': { combo: edit.combo, timeframe: '5m' } };
    expect(hotkeyTimeframe({ key: 'a', code: 'KeyA', altKey: true, shiftKey: true }, map, true)).toBe('5m');
    // Guardado tal cual se escribió, el escucha no lo habría encontrado.
    expect(hotkeyTimeframe({ key: 'a', code: 'KeyA', altKey: true, shiftKey: true }, { ...DEFAULT_HOTKEY_MAP, '1': { combo: 'shift+alt+a', timeframe: '5m' } }, true)).toBeNull();
  });

  it('acepta espacios y alias de modificadores, y rechaza lo inválido', () => {
    expect(editCombo('  Control + Alt + Period  ', DEFAULT_HOTKEY_MAP, '1')).toEqual({
      combo: 'Ctrl+Alt+Period',
      problem: null,
    });
    expect(editCombo('nada', DEFAULT_HOTKEY_MAP, '1')).toEqual({ combo: '', problem: 'invalid' });
    expect(editCombo('', DEFAULT_HOTKEY_MAP, '1')).toEqual({ combo: '', problem: 'invalid' });
    expect(editCombo('Alt+Shift+2', DEFAULT_HOTKEY_MAP, '1')).toEqual({ combo: '', problem: 'duplicate' });
  });
});

describe('atajos reservados del navegador', () => {
  it('rechaza los atajos comunes que el navegador ya usa', () => {
    for (const combo of [
      'Ctrl+D', 'Ctrl+H', 'Ctrl+J', 'Ctrl+P', 'Ctrl+S', 'Ctrl+U',
      'Ctrl+Shift+B', 'Ctrl+Shift+Delete', 'Alt+Home', 'Alt+D', 'Alt+E', 'Alt+F',
    ]) {
      expect(isReservedCombo(combo), combo).toBe(true);
      expect(comboProblem(combo, DEFAULT_HOTKEY_MAP, '1'), combo).toBe('reserved');
      expect(editCombo(combo.toLowerCase(), DEFAULT_HOTKEY_MAP, '1').problem, combo).toBe('reserved');
    }
    // Los defaults de las acciones nuevas no chocan con ninguno.
    expect(isReservedCombo('Alt+Shift+ArrowRight')).toBe(false);
    expect(isReservedCombo('Alt+Shift+L')).toBe(false);
    expect(isReservedCombo('Alt+Shift+D')).toBe(false);
  });
});

describe('hotkeyAction: despacho de cada acción', () => {
  it('los defaults de las acciones son los que pidió el dueño', () => {
    expect(DEFAULT_HOTKEY_MAP['next-symbol']).toEqual({ combo: 'Alt+Shift+ArrowRight', timeframe: null });
    expect(DEFAULT_HOTKEY_MAP['prev-symbol']).toEqual({ combo: 'Alt+Shift+ArrowLeft', timeframe: null });
    expect(DEFAULT_HOTKEY_MAP['toggle-paint']).toEqual({ combo: 'Alt+Shift+L', timeframe: null });
    expect(DEFAULT_HOTKEY_MAP['focus-drawing']).toEqual({ combo: 'Alt+Shift+D', timeframe: null });
  });

  it('cada combinación dispara su acción', () => {
    const fire = (code: string, extra: Record<string, boolean> = {}) =>
      hotkeyAction({ key: '', code, altKey: true, shiftKey: true, ...extra }, DEFAULT_HOTKEY_MAP, true);
    expect(fire('ArrowRight')).toEqual({ type: 'symbol', direction: 1 });
    expect(fire('ArrowLeft')).toEqual({ type: 'symbol', direction: -1 });
    expect(fire('KeyL')).toEqual({ type: 'paint' });
    expect(fire('KeyD')).toEqual({ type: 'drawing' });
    expect(fire('Digit1')).toEqual({ type: 'timeframe', timeframe: '1m' });
    // Sin Mayús (o con un modificador de más) no es el atajo.
    expect(fire('ArrowRight', { shiftKey: false })).toBeNull();
    expect(fire('ArrowRight', { ctrlKey: true })).toBeNull();
    // Apagados no disparan nada.
    expect(
      hotkeyAction({ key: '', code: 'KeyL', altKey: true, shiftKey: true }, DEFAULT_HOTKEY_MAP, false),
    ).toBeNull();
    // Ni mientras se escribe en un campo.
    expect(
      hotkeyAction(
        { key: '', code: 'KeyL', altKey: true, shiftKey: true, target: { tagName: 'INPUT' } },
        DEFAULT_HOTKEY_MAP,
        true,
      ),
    ).toBeNull();
  });

  it('un atajo reasignado dispara la acción de su hueco', () => {
    const map: HotkeyMap = {
      ...DEFAULT_HOTKEY_MAP,
      'next-symbol': { combo: 'Ctrl+Alt+N', timeframe: null },
      'focus-drawing': { combo: 'Ctrl+Alt+F', timeframe: null },
    };
    expect(hotkeyAction({ key: 'n', code: 'KeyN', ctrlKey: true, altKey: true }, map, true)).toEqual({
      type: 'symbol',
      direction: 1,
    });
    expect(hotkeyAction({ key: 'f', code: 'KeyF', ctrlKey: true, altKey: true }, map, true)).toEqual({
      type: 'drawing',
    });
    expect(hotkeyAction({ key: '', code: 'ArrowRight', altKey: true, shiftKey: true }, map, true)).toBeNull();
  });

  it('un hueco de temporalidad sin temporalidad no hace nada', () => {
    const map: HotkeyMap = { ...DEFAULT_HOTKEY_MAP, '1': { combo: 'Alt+Shift+1', timeframe: null } };
    expect(hotkeyAction({ key: '', code: 'Digit1', altKey: true, shiftKey: true }, map, true)).toBeNull();
  });

  it('un combo nuevo no puede duplicar el de una acción', () => {
    expect(comboProblem('Alt+Shift+L', DEFAULT_HOTKEY_MAP, '1')).toBe('duplicate');
    expect(comboProblem('Alt+Shift+D', DEFAULT_HOTKEY_MAP, 'focus-drawing')).toBeNull();
  });
});

describe('symbolPool / stepSymbol', () => {
  it('usa los símbolos del usuario y, si no hay, los del escáner', () => {
    expect(symbolPool(['btc', 'ETH'], [{ symbol: 'SOLUSDT' }])).toEqual(['BTC', 'ETH', 'SOLUSDT']);
    expect(symbolPool([], [{ symbol: 'SOLUSDT' }, { symbol: 'MARKET', symbols: ['XRPUSDT', 'SOLUSDT'] }])).toEqual([
      'SOLUSDT',
      'XRPUSDT',
    ]);
    expect(symbolPool([], [])).toEqual([]);
    expect(symbolPool(['BTC'], [{ symbol: 'btc' }])).toEqual(['BTC']);
  });

  it('avanza y retrocede en círculo, y arranca si el símbolo no está', () => {
    const pool = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
    expect(stepSymbol('BTCUSDT', pool, 1)).toBe('ETHUSDT');
    expect(stepSymbol('SOLUSDT', pool, 1)).toBe('BTCUSDT');
    expect(stepSymbol('BTCUSDT', pool, -1)).toBe('SOLUSDT');
    expect(stepSymbol('XRPUSDT', pool, 1)).toBe('BTCUSDT');
    expect(stepSymbol('XRPUSDT', pool, -1)).toBe('SOLUSDT');
    expect(stepSymbol('BTCUSDT', [], 1)).toBeNull();
  });
});

describe('focusDrawingCard', () => {
  it('enfoca la tarjeta «Tu dibujo» y no falla si no está', () => {
    const { document: doc } = parseHTML(
      '<!doctype html><html><body><section data-testid="drawing-card"><h2>Tu dibujo</h2></section></body></html>',
    );
    const card = focusDrawingCard(doc as unknown as Document);
    expect(card).not.toBeNull();
    expect((card as { tabIndex?: number }).tabIndex).toBe(-1);
    const empty = parseHTML('<!doctype html><html><body></body></html>');
    expect(focusDrawingCard(empty.document as unknown as Document)).toBeNull();
  });
});
