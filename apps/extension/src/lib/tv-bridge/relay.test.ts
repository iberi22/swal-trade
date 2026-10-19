import { describe, expect, it } from 'vitest';
import {
  MAX_POSITION_TOOLS_SYMBOLS,
  dropTab,
  mergePositionToolsStore,
  parsePositionToolsStore,
  positionToolsKey,
  samePositionTools,
  tabIdFromKey,
  toolsForTab,
} from './relay';
import type { BridgePositionToolsMessage } from './schema';
import { SWAL_MESSAGE_VERSION } from './schema';

const message = (over: Partial<BridgePositionToolsMessage> = {}): BridgePositionToolsMessage => ({
  type: 'swal:position-tools',
  version: SWAL_MESSAGE_VERSION,
  symbol: 'BTCUSDT',
  minmov: 1,
  pricescale: 100,
  tools: [{ id: 'tv-1', name: 'long_position', entry: 100, stopLevel: 1000, profitLevel: 2000 }],
  ...over,
});

describe('positionToolsKey / tabIdFromKey', () => {
  it('compone la clave con pestaña y símbolo en mayúsculas y la vuelve a leer', () => {
    expect(positionToolsKey(7, 'btcusdt')).toBe('7:BTCUSDT');
    expect(tabIdFromKey('7:BTCUSDT')).toBe(7);
    expect(tabIdFromKey('0:ETHUSDT')).toBe(0);
    expect(tabIdFromKey('BTCUSDT')).toBeNull(); // clave de la versión antigua
    expect(tabIdFromKey('x:BTCUSDT')).toBeNull();
    expect(tabIdFromKey('')).toBeNull();
  });
});

describe('parsePositionToolsStore', () => {
  it('acepta un almacén válido y lo reindexa por pestaña y símbolo', () => {
    const store = parsePositionToolsStore({ '7:BTCUSDT': message() });
    expect(Object.keys(store)).toEqual(['7:BTCUSDT']);
    expect(store['7:BTCUSDT']?.tools[0]?.entry).toBe(100);
  });

  it('reindexa por el símbolo del mensaje, no por la parte de la clave', () => {
    const store = parsePositionToolsStore({ '3:BTCUSDT': message({ symbol: 'ETHUSDT' }) });
    expect(Object.keys(store)).toEqual(['3:ETHUSDT']);
  });

  it('tira lo que no cumple el contrato (incluidas claves sin pestaña)', () => {
    const store = parsePositionToolsStore({
      '7:BTCUSDT': message(),
      '7:ETHUSDT': { ...message({ symbol: 'ETHUSDT' }), pricescale: Number.NaN },
      BTCUSDT: message(), // clave antigua sin pestaña
      'x:BTCUSDT': message(),
      nope: 'nope',
      '42': null,
    });
    expect(Object.keys(store)).toEqual(['7:BTCUSDT']);
  });

  it('ante basura devuelve un almacén vacío', () => {
    expect(parsePositionToolsStore(null)).toEqual({});
    expect(parsePositionToolsStore('nope')).toEqual({});
    expect(parsePositionToolsStore([])).toEqual({});
  });

  it('corta el número de entradas guardadas', () => {
    const raw: Record<string, unknown> = {};
    for (let i = 0; i < MAX_POSITION_TOOLS_SYMBOLS + 5; i++) {
      raw[`1:COIN${i}USDT`] = message({ symbol: `COIN${i}USDT` });
    }
    expect(Object.keys(parsePositionToolsStore(raw))).toHaveLength(MAX_POSITION_TOOLS_SYMBOLS);
  });
});

describe('mergePositionToolsStore', () => {
  it('guarda el mensaje por pestaña y símbolo sin tocar otras pestañas', () => {
    const first = mergePositionToolsStore(undefined, message(), 1);
    expect(first.changed).toBe(true);
    expect(Object.keys(first.store)).toEqual(['1:BTCUSDT']);

    const second = mergePositionToolsStore(first.store, message({ symbol: 'ETHUSDT' }), 2);
    expect(second.changed).toBe(true);
    expect(Object.keys(second.store).sort()).toEqual(['1:BTCUSDT', '2:ETHUSDT']);
  });

  it('sin pestaña conocida no guarda nada', () => {
    for (const tabId of [undefined, null, Number.NaN, 1.5, -1]) {
      const next = mergePositionToolsStore(undefined, message(), tabId);
      expect(next.changed).toBe(false);
      expect(next.store).toEqual({});
    }
  });

  it('no marca cambio si el dibujo es idéntico en la misma pestaña (no despierta al panel)', () => {
    const first = mergePositionToolsStore(undefined, message(), 1);
    const again = mergePositionToolsStore(first.store, message(), 1);
    expect(again.changed).toBe(false);
    expect(again.store).toEqual(first.store);
  });

  it('marca cambio cuando se mueve el stop, el objetivo o la entrada', () => {
    const first = mergePositionToolsStore(undefined, message(), 1);
    for (const tool of [
      { id: 'tv-1', name: 'long_position', entry: 100, stopLevel: 1200, profitLevel: 2000 },
      { id: 'tv-1', name: 'long_position', entry: 100, stopLevel: 1000, profitLevel: 2400 },
      { id: 'tv-1', name: 'long_position', entry: 101, stopLevel: 1000, profitLevel: 2000 },
    ]) {
      const next = mergePositionToolsStore(first.store, message({ tools: [tool] }), 1);
      expect(next.changed).toBe(true);
    }
  });

  it('un dibujo borrado del gráfico se refleja (lista vacía)', () => {
    const first = mergePositionToolsStore(undefined, message(), 1);
    const cleared = mergePositionToolsStore(first.store, message({ tools: [] }), 1);
    expect(cleared.changed).toBe(true);
    expect(cleared.store['1:BTCUSDT']?.tools).toEqual([]);
  });

  it('una pestaña enseña un solo gráfico: al llegar otro símbolo tira el anterior', () => {
    const btc = mergePositionToolsStore(undefined, message(), 1);
    const eth = mergePositionToolsStore(btc.store, message({ symbol: 'ETHUSDT' }), 1);
    expect(Object.keys(eth.store)).toEqual(['1:ETHUSDT']);
    // Otra pestaña con el mismo par no se ve afectada.
    const both = mergePositionToolsStore(eth.store, message(), 2);
    expect(Object.keys(both.store).sort()).toEqual(['1:ETHUSDT', '2:BTCUSDT']);
  });

  it('aunque el dibujo sea idéntico, tira los otros símbolos de la pestaña (changed=true)', () => {
    const raw = { '1:BTCUSDT': message(), '1:ETHUSDT': message({ symbol: 'ETHUSDT' }) };
    const next = mergePositionToolsStore(raw, message({ symbol: 'ETHUSDT' }), 1);
    expect(next.changed).toBe(true);
    expect(Object.keys(next.store)).toEqual(['1:ETHUSDT']);
  });

  it('ignora un mensaje inválido sin tocar el almacén', () => {
    const first = mergePositionToolsStore(undefined, message(), 1);
    const next = mergePositionToolsStore(first.store, { ...message(), version: 1 }, 1);
    expect(next.changed).toBe(false);
    expect(next.store).toEqual(first.store);
  });

  it('reemplaza el mismo símbolo de la misma pestaña, no acumula', () => {
    const first = mergePositionToolsStore(undefined, message(), 1);
    const next = mergePositionToolsStore(
      first.store,
      message({ tools: [{ id: 'tv-2', name: 'short_position', entry: 90, stopLevel: 500, profitLevel: 1500 }] }),
      1,
    );
    expect(Object.keys(next.store)).toEqual(['1:BTCUSDT']);
    expect(next.store['1:BTCUSDT']?.tools[0]?.id).toBe('tv-2');
  });
});

describe('toolsForTab', () => {
  it('devuelve el mensaje de esa pestaña sin importar mayúsculas', () => {
    const store = { '7:BTCUSDT': message(), '8:BTCUSDT': message({ pricescale: 1000 }) };
    expect(toolsForTab(store, 7, 'btcusdt')?.pricescale).toBe(100);
    // La misma pareja en otra pestaña es otra entrada.
    expect(toolsForTab(store, 8, 'BTCUSDT')?.pricescale).toBe(1000);
    expect(toolsForTab(store, 9, 'BTCUSDT')).toBeNull();
    expect(toolsForTab(store, 7, 'ETHUSDT')).toBeNull();
    expect(toolsForTab(store, 7, '')).toBeNull();
    expect(toolsForTab(store, null, 'BTCUSDT')).toBeNull();
    expect(toolsForTab(null, 7, 'BTCUSDT')).toBeNull();
  });
});

describe('dropTab', () => {
  it('tira solo las entradas de esa pestaña', () => {
    const raw = { '1:BTCUSDT': message(), '2:BTCUSDT': message(), '2:ETHUSDT': message({ symbol: 'ETHUSDT' }) };
    const dropped = dropTab(raw, 2);
    expect(dropped.changed).toBe(true);
    expect(Object.keys(dropped.store)).toEqual(['1:BTCUSDT']);
  });

  it('no marca cambio si la pestaña no tenía nada (o el id no sirve)', () => {
    const raw = { '1:BTCUSDT': message() };
    expect(dropTab(raw, 9).changed).toBe(false);
    expect(dropTab(raw, 9).store).toEqual({ '1:BTCUSDT': message() });
    expect(dropTab(raw, null).changed).toBe(false);
    expect(dropTab(raw, undefined).changed).toBe(false);
  });
});

describe('samePositionTools', () => {
  it('compara símbolo, escala y cada herramienta en orden', () => {
    expect(samePositionTools(message(), message())).toBe(true);
    expect(samePositionTools(message(), message({ symbol: 'ETHUSDT' }))).toBe(false);
    expect(samePositionTools(message(), message({ pricescale: 1000 }))).toBe(false);
    expect(samePositionTools(message(), message({ tools: [] }))).toBe(false);
    expect(
      samePositionTools(
        message(),
        message({ tools: [{ id: 'tv-1', name: 'long_position', entry: 100, stopLevel: 1000, profitLevel: 2001 }] }),
      ),
    ).toBe(false);
  });
});
