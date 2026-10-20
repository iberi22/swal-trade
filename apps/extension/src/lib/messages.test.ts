import { describe, expect, it } from 'vitest';
import { pageHotkeyMessage, parsePrivilegedMessage, parseRuntimeMessage } from './messages';
import { SWAL_MESSAGE_VERSION, SWAL_POSITION_TOOLS } from './tv-bridge/schema';
import { TV_POSITION_TOOLS } from './tv-paint';

const tools = {
  type: SWAL_POSITION_TOOLS,
  version: SWAL_MESSAGE_VERSION,
  symbol: 'BTCUSDT',
  minmov: 1,
  pricescale: 100,
  tools: [{ id: 'tv-1', name: 'long_position', entry: 100, stopLevel: 1000, profitLevel: 2000 }],
};

describe('parseRuntimeMessage · herramientas de posición', () => {
  it('acepta el relevo del content script', () => {
    expect(parseRuntimeMessage({ type: TV_POSITION_TOOLS, tools })).toEqual({
      type: TV_POSITION_TOOLS,
      tools,
    });
  });

  it('rechaza el relevo si el payload no cumple el contrato', () => {
    expect(parseRuntimeMessage({ type: TV_POSITION_TOOLS })).toBeNull();
    expect(
      parseRuntimeMessage({ type: TV_POSITION_TOOLS, tools: { ...tools, pricescale: 'x' } }),
    ).toBeNull();
  });

  it('no confunde un privilegiado con un mensaje de página', () => {
    expect(parseRuntimeMessage({ type: 'ai:analyze' })).toBeNull();
    expect(parsePrivilegedMessage({ type: TV_POSITION_TOOLS, tools })).toBeNull();
  });
});

describe('parseRuntimeMessage · atajos reenviados desde la página', () => {
  it('acepta las cuatro acciones que la página manda al panel', () => {
    expect(parseRuntimeMessage({ type: 'swal:hotkey-action', action: { type: 'symbol', direction: 1 } })).toEqual({
      type: 'swal:hotkey-action',
      action: { type: 'symbol', direction: 1 },
    });
    expect(parseRuntimeMessage({ type: 'swal:hotkey-action', action: { type: 'symbol', direction: -1 } })).toEqual({
      type: 'swal:hotkey-action',
      action: { type: 'symbol', direction: -1 },
    });
    expect(parseRuntimeMessage({ type: 'swal:hotkey-action', action: { type: 'paint' } })).toEqual({
      type: 'swal:hotkey-action',
      action: { type: 'paint' },
    });
    expect(parseRuntimeMessage({ type: 'swal:hotkey-action', action: { type: 'drawing' } })).toEqual({
      type: 'swal:hotkey-action',
      action: { type: 'drawing' },
    });
  });

  it('rechaza cualquier acción fuera del contrato', () => {
    expect(parseRuntimeMessage({ type: 'swal:hotkey-action' })).toBeNull();
    expect(parseRuntimeMessage({ type: 'swal:hotkey-action', action: null })).toBeNull();
    expect(parseRuntimeMessage({ type: 'swal:hotkey-action', action: 'paint' })).toBeNull();
    expect(parseRuntimeMessage({ type: 'swal:hotkey-action', action: ['paint'] })).toBeNull();
    expect(parseRuntimeMessage({ type: 'swal:hotkey-action', action: { type: 'timeframe', timeframe: '1m' } })).toBeNull();
    expect(parseRuntimeMessage({ type: 'swal:hotkey-action', action: { type: 'symbol' } })).toBeNull();
    expect(parseRuntimeMessage({ type: 'swal:hotkey-action', action: { type: 'symbol', direction: 2 } })).toBeNull();
    expect(parseRuntimeMessage({ type: 'swal:hotkey-action', action: { type: 'symbol', direction: 0 } })).toBeNull();
  });

  it('no confunde el atajo de la página con el de la temporalidad', () => {
    expect(parseRuntimeMessage({ type: 'swal:hotkey-set-timeframe', timeframe: '1m' })).toEqual({
      type: 'swal:hotkey-set-timeframe',
      timeframe: '1m',
    });
    expect(parseRuntimeMessage({ type: 'swal:hotkey-set-timeframe' })).toBeNull();
  });
});

describe('pageHotkeyMessage · lo que la página reenvía', () => {
  it('la temporalidad sigue su camino y las cuatro acciones van al panel', () => {
    expect(pageHotkeyMessage({ type: 'timeframe', timeframe: '4h' })).toEqual({
      type: 'swal:hotkey-set-timeframe',
      timeframe: '4h',
    });
    expect(pageHotkeyMessage({ type: 'symbol', direction: 1 })).toEqual({
      type: 'swal:hotkey-action',
      action: { type: 'symbol', direction: 1 },
    });
    expect(pageHotkeyMessage({ type: 'symbol', direction: -1 })).toEqual({
      type: 'swal:hotkey-action',
      action: { type: 'symbol', direction: -1 },
    });
    expect(pageHotkeyMessage({ type: 'paint' })).toEqual({
      type: 'swal:hotkey-action',
      action: { type: 'paint' },
    });
    expect(pageHotkeyMessage({ type: 'drawing' })).toEqual({
      type: 'swal:hotkey-action',
      action: { type: 'drawing' },
    });
    expect(pageHotkeyMessage(null)).toBeNull();
  });

  it('el mensaje reenviado se vuelve a leer con el mismo contrato', () => {
    // Ida y vuelta: lo que la página manda, el panel lo entiende.
    for (const action of [
      { type: 'symbol', direction: 1 } as const,
      { type: 'symbol', direction: -1 } as const,
      { type: 'paint' } as const,
      { type: 'drawing' } as const,
    ]) {
      const message = pageHotkeyMessage(action);
      expect(parseRuntimeMessage(message)).toEqual(message);
    }
  });
});
