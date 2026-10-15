import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOTKEY_MAP,
  DEFAULT_SETTINGS,
  HOTKEY_KEYS,
  SETTINGS_KEY,
  normalizeHotkeyMap,
  normalizeSettings,
  normalizeSettingsTimeframe,
  normalizeSymbolList,
  settingsFromStorage,
  settingsToInputs,
  symbolAllowed,
} from './settings';

describe('normalizeSymbolList', () => {
  it('acepta una lista o un texto separado por comas y espacios', () => {
    expect(normalizeSymbolList(['btcusdt', 'ETHUSDT'])).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(normalizeSymbolList('BTC, ETH')).toEqual(['BTC', 'ETH']);
    expect(normalizeSymbolList('  BTCUSDT   ETHUSDT  ')).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(normalizeSymbolList('btcusdt;sol; xrp')).toEqual(['BTCUSDT', 'SOL', 'XRP']);
  });

  it('quita duplicados y lo que no es un símbolo', () => {
    expect(normalizeSymbolList('BTC, BTC, BTC')).toEqual(['BTC']);
    expect(normalizeSymbolList('1,234.50 USDT, ?!')).toEqual([]);
    expect(normalizeSymbolList('1')).toEqual([]);
    expect(normalizeSymbolList('')).toEqual([]);
    // Palabras sueltas se guardan como entradas, pero son inertes: no coinciden
    // con ningún par real, así que la lista blanca no deja pasar nada.
    expect(normalizeSymbolList('MY API KEY')).toEqual(['MY', 'API', 'KEY']);
    expect(symbolAllowed('BTCUSDT', ['MY', 'API', 'KEY'])).toBe(false);
    expect(normalizeSymbolList(null)).toEqual([]);
    expect(normalizeSymbolList(42)).toEqual([]);
    expect(normalizeSymbolList([1, 2, null])).toEqual([]);
  });

  it('corta en 50 entradas', () => {
    const many = Array.from({ length: 80 }, (_, i) => `SYM${i}`);
    expect(normalizeSymbolList(many)).toHaveLength(50);
  });
});

describe('symbolAllowed', () => {
  it('una lista vacía deja pasar todo', () => {
    expect(symbolAllowed('SOLUSDT', [])).toBe(true);
    expect(symbolAllowed('SOLUSDT', DEFAULT_SETTINGS.symbols)).toBe(true);
  });

  it('el activo cubre todos sus pares', () => {
    expect(symbolAllowed('BTCUSDT', ['BTC'])).toBe(true);
    expect(symbolAllowed('BTCUSDC', ['btc'])).toBe(true);
    expect(symbolAllowed('1000PEPEUSDT', ['PEPE'])).toBe(true);
  });

  it('el par completo solo cubre ese par', () => {
    expect(symbolAllowed('BTCUSDT', ['BTCUSDT'])).toBe(true);
    expect(symbolAllowed('BTCUSDC', ['BTCUSDT'])).toBe(false);
    expect(symbolAllowed('ETHUSDT', ['BTC', 'ETH'])).toBe(true);
    expect(symbolAllowed('SOLUSDT', ['BTC', 'ETH'])).toBe(false);
  });

  it('no confunde SOL con SOLV', () => {
    expect(symbolAllowed('SOLVUSDT', ['SOL'])).toBe(false);
    expect(symbolAllowed('SOLUSDT', ['SOL'])).toBe(true);
  });

  it('acepta las entradas en minúsculas y con signo de dólar', () => {
    expect(symbolAllowed('BTCUSDC', ['btc'])).toBe(true);
    expect(symbolAllowed('BTCUSDT', ['$BTC'])).toBe(true);
    expect(symbolAllowed('1000PEPEUSDT', ['PEPE'])).toBe(true);
    expect(symbolAllowed('ETHUSDT', ['ETHUSDT'])).toBe(true);
    expect(symbolAllowed('ETHUSDT', ['ETH'])).toBe(true);
  });
});

describe('normalizeSettings', () => {
  it('rellena los defaults cuando no hay nada', () => {
    expect(normalizeSettings(undefined)).toEqual({
      defaultTimeframe: '5m',
      symbols: [],
      autoSync: true,
      paintOnChart: false,
      explainWithAi: false,
      hotkeysEnabled: true,
      hotkeyMap: DEFAULT_HOTKEY_MAP,
    });
  });

  it('acepta los valores válidos y descarta el resto', () => {
    expect(
      normalizeSettings({
        defaultTimeframe: '4h',
        symbols: 'BTC, ETH',
        autoSync: false,
        hotkeysEnabled: false,
        hotkeyMap: { F1: '15m' },
      }),
    ).toEqual({
      defaultTimeframe: '4h',
      symbols: ['BTC', 'ETH'],
      autoSync: false,
      paintOnChart: false,
      explainWithAi: false,
      hotkeysEnabled: false,
      hotkeyMap: { ...DEFAULT_HOTKEY_MAP, F1: '15m' },
    });
  });

  it('una temporalidad que el panel no dibuja vuelve al default', () => {
    expect(normalizeSettings({ defaultTimeframe: '45m' }).defaultTimeframe).toBe('5m');
    expect(normalizeSettings({ defaultTimeframe: 3 }).defaultTimeframe).toBe('5m');
    expect(normalizeSettings({ defaultTimeframe: '60', autoSync: 'no' })).toEqual({
      defaultTimeframe: '1h',
      symbols: [],
      autoSync: true,
      paintOnChart: false,
      explainWithAi: false,
      hotkeysEnabled: true,
      hotkeyMap: DEFAULT_HOTKEY_MAP,
    });
  });

  it('autoSync solo se apaga con false explícito', () => {
    expect(normalizeSettings({ autoSync: false }).autoSync).toBe(false);
    expect(normalizeSettings({ autoSync: 'false' }).autoSync).toBe(true);
    expect(normalizeSettings({ autoSync: 0 }).autoSync).toBe(true);
  });

  it('pintar en el gráfico solo se enciende con true explícito', () => {
    expect(normalizeSettings({}).paintOnChart).toBe(false);
    expect(normalizeSettings({ paintOnChart: true }).paintOnChart).toBe(true);
    expect(normalizeSettings({ paintOnChart: 'true' }).paintOnChart).toBe(false);
    expect(normalizeSettings({ paintOnChart: 1 }).paintOnChart).toBe(false);
    expect(DEFAULT_SETTINGS.paintOnChart).toBe(false);
  });

  it('las explicaciones con IA solo se encienden con true explícito', () => {
    expect(normalizeSettings({}).explainWithAi).toBe(false);
    expect(normalizeSettings({ explainWithAi: true }).explainWithAi).toBe(true);
    expect(normalizeSettings({ explainWithAi: 'true' }).explainWithAi).toBe(false);
    expect(normalizeSettings({ explainWithAi: 1 }).explainWithAi).toBe(false);
    expect(DEFAULT_SETTINGS.explainWithAi).toBe(false);
  });


  it('hotkeysEnabled solo se apaga con false explícito', () => {
    expect(normalizeSettings({ hotkeysEnabled: false }).hotkeysEnabled).toBe(false);
    expect(normalizeSettings({ hotkeysEnabled: 'false' }).hotkeysEnabled).toBe(true);
    expect(normalizeSettings({ hotkeysEnabled: 0 }).hotkeysEnabled).toBe(true);
    expect(normalizeSettings({}).hotkeysEnabled).toBe(true);
  });

  it('no se deja intoxicar con campos inventados', () => {
    const settings = normalizeSettings({
      defaultTimeframe: '1d',
      symbols: ['BTC'],
      autoSync: true,
      isAdmin: true,
      host: 'https://evil.example',
    });
    expect(Object.keys(settings).sort()).toEqual([
      'autoSync',
      'defaultTimeframe',
      'explainWithAi',
      'hotkeyMap',
      'hotkeysEnabled',
      'paintOnChart',
      'symbols',
    ]);
  });
});

describe('normalizeSettingsTimeframe', () => {
  it('solo acepta las seis temporalidades del panel', () => {
    expect(normalizeSettingsTimeframe('1m')).toBe('1m');
    expect(normalizeSettingsTimeframe('1D')).toBe('1d');
    expect(normalizeSettingsTimeframe('240')).toBe('4h');
    expect(normalizeSettingsTimeframe('2h')).toBeNull();
    expect(normalizeSettingsTimeframe(null)).toBeNull();
  });
});

describe('settingsFromStorage', () => {
  it('lee la clave settings', () => {
    expect(
      settingsFromStorage({ [SETTINGS_KEY]: { defaultTimeframe: '15m', symbols: 'ETH' } }),
    ).toEqual({
      defaultTimeframe: '15m',
      symbols: ['ETH'],
      autoSync: true,
      paintOnChart: false,
      explainWithAi: false,
      hotkeysEnabled: true,
      hotkeyMap: DEFAULT_HOTKEY_MAP,
    });
  });

  it('acepta el objeto pelado por si el formato cambia', () => {
    expect(settingsFromStorage({ defaultTimeframe: '1d' })).toEqual({
      defaultTimeframe: '1d',
      symbols: [],
      autoSync: true,
      paintOnChart: false,
      explainWithAi: false,
      hotkeysEnabled: true,
      hotkeyMap: DEFAULT_HOTKEY_MAP,
    });
  });

  it('ante basura devuelve los defaults', () => {
    expect(settingsFromStorage(null)).toEqual({ ...DEFAULT_SETTINGS, symbols: [] });
    expect(settingsFromStorage('nope')).toEqual({ ...DEFAULT_SETTINGS, symbols: [] });
    expect(settingsFromStorage({ settings: 7 })).toEqual({ ...DEFAULT_SETTINGS, symbols: [] });
  });
});

describe('settingsToInputs', () => {
  it('vuelve a poner la lista en el campo de texto', () => {
    expect(settingsToInputs({ ...DEFAULT_SETTINGS, symbols: ['BTC', 'ETH'] })).toBe('BTC, ETH');
    expect(settingsToInputs(DEFAULT_SETTINGS)).toBe('');
  });
});

describe('normalizeHotkeyMap', () => {
  it('rellena con el mapa por defecto y normaliza teclas', () => {
    expect(normalizeHotkeyMap(null)).toEqual(DEFAULT_HOTKEY_MAP);
    const custom = normalizeHotkeyMap({ F1: '15m', F2: null, F3: 'ninguno', F4: 'invalido', F12: '1D', UNKNOWN: '1m' });
    expect([custom.F1, custom.F2, custom.F3, custom.F4, custom.F12]).toEqual(['15m', null, null, null, '1d']);
    expect((custom as Record<string, unknown>).UNKNOWN).toBeUndefined();
  });
});
