import { describe, expect, it } from 'vitest';
import {
  MAX_POSITION_TOOLS_SYMBOLS,
  mergePositionToolsStore,
  parsePositionToolsStore,
  samePositionTools,
  toolsForSymbol,
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

describe('parsePositionToolsStore', () => {
  it('acepta un almacén válido y lo indexa por símbolo', () => {
    const store = parsePositionToolsStore({ BTCUSDT: message() });
    expect(Object.keys(store)).toEqual(['BTCUSDT']);
    expect(store.BTCUSDT?.tools[0]?.entry).toBe(100);
  });

  it('tira lo que no cumple el contrato en lugar de propagarlo', () => {
    const store = parsePositionToolsStore({
      BTCUSDT: message(),
      ETHUSDT: { ...message({ symbol: 'ETHUSDT' }), pricescale: Number.NaN },
      broken: 'nope',
      nulled: null,
      42: message({ symbol: 'BTCUSDT' }),
    });
    expect(Object.keys(store)).toEqual(['BTCUSDT']);
  });

  it('ante basura devuelve un almacén vacío', () => {
    expect(parsePositionToolsStore(null)).toEqual({});
    expect(parsePositionToolsStore('nope')).toEqual({});
    expect(parsePositionToolsStore([])).toEqual({});
  });

  it('corta el número de símbolos guardados', () => {
    const raw: Record<string, unknown> = {};
    for (let i = 0; i < MAX_POSITION_TOOLS_SYMBOLS + 5; i++) {
      const symbol = `COIN${i}USDT`;
      raw[symbol] = message({ symbol });
    }
    expect(Object.keys(parsePositionToolsStore(raw))).toHaveLength(MAX_POSITION_TOOLS_SYMBOLS);
  });
});

describe('mergePositionToolsStore', () => {
  it('guarda el mensaje por símbolo sin tocar los demás', () => {
    const first = mergePositionToolsStore(undefined, message());
    expect(first.changed).toBe(true);
    expect(Object.keys(first.store)).toEqual(['BTCUSDT']);

    const second = mergePositionToolsStore(first.store, message({ symbol: 'ETHUSDT', minmov: 1 }));
    expect(second.changed).toBe(true);
    expect(Object.keys(second.store).sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('no marca cambio si el dibujo es idéntico (no despierta al panel)', () => {
    const first = mergePositionToolsStore(undefined, message());
    const again = mergePositionToolsStore(first.store, message());
    expect(again.changed).toBe(false);
    expect(again.store).toEqual(first.store);
  });

  it('marca cambio cuando se mueve el stop, el objetivo o la entrada', () => {
    const first = mergePositionToolsStore(undefined, message());
    for (const tool of [
      { id: 'tv-1', name: 'long_position', entry: 100, stopLevel: 1200, profitLevel: 2000 },
      { id: 'tv-1', name: 'long_position', entry: 100, stopLevel: 1000, profitLevel: 2400 },
      { id: 'tv-1', name: 'long_position', entry: 101, stopLevel: 1000, profitLevel: 2000 },
    ]) {
      const next = mergePositionToolsStore(first.store, message({ tools: [tool] }));
      expect(next.changed).toBe(true);
    }
  });

  it('un dibujo borrado del gráfico se refleja (lista vacía)', () => {
    const first = mergePositionToolsStore(undefined, message());
    const cleared = mergePositionToolsStore(first.store, message({ tools: [] }));
    expect(cleared.changed).toBe(true);
    expect(cleared.store.BTCUSDT?.tools).toEqual([]);
  });

  it('ignora un mensaje inválido sin tocar el almacén', () => {
    const first = mergePositionToolsStore(undefined, message());
    const next = mergePositionToolsStore(first.store, { ...message(), version: 1 });
    expect(next.changed).toBe(false);
    expect(next.store).toEqual(first.store);
  });

  it('reemplaza el mismo símbolo, no acumula', () => {
    const first = mergePositionToolsStore(undefined, message());
    const next = mergePositionToolsStore(
      first.store,
      message({ tools: [{ id: 'tv-2', name: 'short_position', entry: 90, stopLevel: 500, profitLevel: 1500 }] }),
    );
    expect(Object.keys(next.store)).toEqual(['BTCUSDT']);
    expect(next.store.BTCUSDT?.tools[0]?.id).toBe('tv-2');
  });
});

describe('toolsForSymbol', () => {
  it('devuelve el mensaje del símbolo pedido sin importar mayúsculas', () => {
    const store = parsePositionToolsStore({ BTCUSDT: message() });
    expect(toolsForSymbol(store, 'btcusdt')?.symbol).toBe('BTCUSDT');
    expect(toolsForSymbol(store, 'ETHUSDT')).toBeNull();
    expect(toolsForSymbol(store, '')).toBeNull();
    expect(toolsForSymbol(null, 'BTCUSDT')).toBeNull();
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
