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
import { LOCALES } from './i18n/locales';

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
      defaultTimeframe: "5m",
      symbols: [],
      autoSync: true,
      paintOnChart: false,
      readDrawings: false,
      explainWithAi: false,
      readPageAccount: false,
      hotkeysEnabled: true,
      hotkeyMap: DEFAULT_HOTKEY_MAP,
      claudeBridgeEnabled: false,
      claudeBridgePort: 47321,
      claudeBridgeToken: "",
      radarEnabled: true,
      radarPort: 47322,
      rules: { maxRiskPct: 1, maxLeverage: 10, dailyLossUsd: 10, revengeMinutes: 15 },
      ai: { provider: 'opencode', model: '', redaction: 'relative', consentedProviders: [] },
      domPositions: false,
      acctMeta: { configured: false, kind: 'none', last4: '' },
      locale: 'auto',
    });
  });

  it('acepta los valores válidos y descarta el resto', () => {
    expect(
      normalizeSettings({
        defaultTimeframe: "4h",
        symbols: "BTC, ETH",
        autoSync: false,
        hotkeysEnabled: false,
        hotkeys: { '1': { combo: 'Ctrl+Alt+7', timeframe: '15m' } },
      }),
    ).toEqual({
      defaultTimeframe: "4h",
      symbols: ["BTC", "ETH"],
      autoSync: false,
      paintOnChart: false,
      readDrawings: false,
      explainWithAi: false,
      readPageAccount: false,
      hotkeysEnabled: false,
      hotkeyMap: { ...DEFAULT_HOTKEY_MAP, '1': { combo: 'Ctrl+Alt+7', timeframe: '15m' } },
      claudeBridgeEnabled: false,
      claudeBridgePort: 47321,
      claudeBridgeToken: "",
      radarEnabled: true,
      radarPort: 47322,
      rules: { maxRiskPct: 1, maxLeverage: 10, dailyLossUsd: 10, revengeMinutes: 15 },
      ai: { provider: 'opencode', model: '', redaction: 'relative', consentedProviders: [] },
      domPositions: false,
      acctMeta: { configured: false, kind: 'none', last4: '' },
      locale: 'auto',
    });
  });

  it('una temporalidad que el panel no dibuja vuelve al default', () => {
    expect(normalizeSettings({ defaultTimeframe: '45m' }).defaultTimeframe).toBe('5m');
    expect(normalizeSettings({ defaultTimeframe: 3 }).defaultTimeframe).toBe('5m');
    expect(normalizeSettings({ defaultTimeframe: "60", autoSync: "no" })).toEqual({
      defaultTimeframe: "1h",
      symbols: [],
      autoSync: true,
      paintOnChart: false,
      readDrawings: false,
      explainWithAi: false,
      readPageAccount: false,
      hotkeysEnabled: true,
      hotkeyMap: DEFAULT_HOTKEY_MAP,
      claudeBridgeEnabled: false,
      claudeBridgePort: 47321,
      claudeBridgeToken: "",
      radarEnabled: true,
      radarPort: 47322,
      rules: { maxRiskPct: 1, maxLeverage: 10, dailyLossUsd: 10, revengeMinutes: 15 },
      ai: { provider: 'opencode', model: '', redaction: 'relative', consentedProviders: [] },
      domPositions: false,
      acctMeta: { configured: false, kind: 'none', last4: '' },
      locale: 'auto',
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

  it('leer los dibujos de posición solo se enciende con true explícito', () => {
    expect(normalizeSettings({}).readDrawings).toBe(false);
    expect(normalizeSettings({ readDrawings: true }).readDrawings).toBe(true);
    expect(normalizeSettings({ readDrawings: 'true' }).readDrawings).toBe(false);
    expect(normalizeSettings({ readDrawings: 1 }).readDrawings).toBe(false);
    expect(normalizeSettings({ readDrawings: null }).readDrawings).toBe(false);
    expect(DEFAULT_SETTINGS.readDrawings).toBe(false);
  });

  it('leer las posiciones de la página solo se enciende con true explícito', () => {
    expect(normalizeSettings({}).readPageAccount).toBe(false);
    expect(DEFAULT_SETTINGS.readPageAccount).toBe(false);
    expect(normalizeSettings({ readPageAccount: true }).readPageAccount).toBe(true);
    expect(normalizeSettings({ readPageAccount: 'true' }).readPageAccount).toBe(false);
    expect(normalizeSettings({ readPageAccount: 1 }).readPageAccount).toBe(false);
    expect(normalizeSettings({ readPageAccount: null }).readPageAccount).toBe(false);
    expect(settingsFromStorage({ settings: { readPageAccount: true } }).readPageAccount).toBe(true);
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

  it('migra los atajos F1..F12 a Alt+Mayús conservando la temporalidad', () => {
    const migrated = normalizeSettings({ hotkeyMap: { F1: '15m', F3: '4h', F12: '1d' } }).hotkeyMap;
    expect(migrated).toEqual({
      '1': { combo: 'Alt+Shift+1', timeframe: '15m' },
      '2': { combo: 'Alt+Shift+2', timeframe: '5m' },
      '3': { combo: 'Alt+Shift+3', timeframe: '4h' },
      '4': { combo: 'Alt+Shift+4', timeframe: '1h' },
      '5': { combo: 'Alt+Shift+5', timeframe: '4h' },
      '6': { combo: 'Alt+Shift+6', timeframe: '1d' },
    });
    // La tecla de función no sobrevive en ninguna forma.
    expect(JSON.stringify(migrated)).not.toContain('F1');
  });

  it('un atajo guardado inválido o reservado vuelve al default del hueco', () => {
    const map = normalizeSettings({
      hotkeys: {
        '1': { combo: 'F5', timeframe: '1m' },
        '2': { combo: 'Ctrl+T', timeframe: '5m' },
        '3': { combo: 'Alt+Shift+9', timeframe: '15m' },
      },
    }).hotkeyMap;
    expect(map['1']).toEqual({ combo: 'Alt+Shift+1', timeframe: '1m' });
    expect(map['2']).toEqual({ combo: 'Alt+Shift+2', timeframe: '5m' });
    expect(map['3']).toEqual({ combo: 'Alt+Shift+9', timeframe: '15m' });
  });

  it('un hueco sin temporalidad se conserva como tal', () => {
    const map = normalizeSettings({ hotkeys: { '1': { combo: 'Alt+Shift+1', timeframe: null } } }).hotkeyMap;
    expect(map['1']).toEqual({ combo: 'Alt+Shift+1', timeframe: null });
  });

  it('radarEnabled solo se apaga con false explícito', () => {
    expect(normalizeSettings({ radarEnabled: false }).radarEnabled).toBe(false);
    expect(normalizeSettings({ radarEnabled: 'false' }).radarEnabled).toBe(true);
    expect(normalizeSettings({ radarEnabled: 0 }).radarEnabled).toBe(true);
    expect(normalizeSettings({}).radarEnabled).toBe(true);
  });

  it('radarPort normaliza puertos y descarta inválidos', () => {
    expect(normalizeSettings({ radarPort: 8080 }).radarPort).toBe(8080);
    expect(normalizeSettings({ radarPort: 1023 }).radarPort).toBe(47322);
    expect(normalizeSettings({ radarPort: 70000 }).radarPort).toBe(47322);
    expect(normalizeSettings({ radarPort: 8080.5 }).radarPort).toBe(47322);
    expect(normalizeSettings({ radarPort: '47322' }).radarPort).toBe(47322);
    expect(normalizeSettings({}).radarPort).toBe(47322);
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
      'acctMeta',
      'ai',
      'autoSync',
      'claudeBridgeEnabled',
      'claudeBridgePort',
      'claudeBridgeToken',
      'defaultTimeframe',
      'domPositions',
      'explainWithAi',
      'hotkeyMap',
      'hotkeysEnabled',
      'locale',
      'paintOnChart',
      'radarEnabled',
      'radarPort',
      'readDrawings',
      'readPageAccount',
      'rules',
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
      settingsFromStorage({ [SETTINGS_KEY]: { defaultTimeframe: "15m", symbols: "ETH" } }),
    ).toEqual({
      defaultTimeframe: "15m",
      symbols: ["ETH"],
      autoSync: true,
      paintOnChart: false,
      readDrawings: false,
      explainWithAi: false,
      readPageAccount: false,
      hotkeysEnabled: true,
      hotkeyMap: DEFAULT_HOTKEY_MAP,
      claudeBridgeEnabled: false,
      claudeBridgePort: 47321,
      claudeBridgeToken: "",
      radarEnabled: true,
      radarPort: 47322,
      rules: { maxRiskPct: 1, maxLeverage: 10, dailyLossUsd: 10, revengeMinutes: 15 },
      ai: { provider: 'opencode', model: '', redaction: 'relative', consentedProviders: [] },
      domPositions: false,
      acctMeta: { configured: false, kind: 'none', last4: '' },
      locale: 'auto',
    });
  });

  it('acepta el objeto pelado por si el formato cambia', () => {
    expect(settingsFromStorage({ defaultTimeframe: "1d" })).toEqual({
      defaultTimeframe: "1d",
      symbols: [],
      autoSync: true,
      paintOnChart: false,
      readDrawings: false,
      explainWithAi: false,
      readPageAccount: false,
      hotkeysEnabled: true,
      hotkeyMap: DEFAULT_HOTKEY_MAP,
      claudeBridgeEnabled: false,
      claudeBridgePort: 47321,
      claudeBridgeToken: "",
      radarEnabled: true,
      radarPort: 47322,
      rules: { maxRiskPct: 1, maxLeverage: 10, dailyLossUsd: 10, revengeMinutes: 15 },
      ai: { provider: 'opencode', model: '', redaction: 'relative', consentedProviders: [] },
      domPositions: false,
      acctMeta: { configured: false, kind: 'none', last4: '' },
      locale: 'auto',
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
  it('rellena con el mapa por defecto y valida hueco a hueco', () => {
    expect(normalizeHotkeyMap(null)).toEqual(DEFAULT_HOTKEY_MAP);
    const custom = normalizeHotkeyMap({
      '1': { combo: 'Alt+Shift+7', timeframe: '15m' },
      '2': { combo: '', timeframe: null },
      '3': { combo: 'Ctrl+Shift+Q', timeframe: 'ninguno' },
      UNKNOWN: { combo: 'Alt+Shift+8', timeframe: '1m' },
    });
    expect(custom['1']).toEqual({ combo: 'Alt+Shift+7', timeframe: '15m' });
    expect(custom['2']).toEqual({ combo: 'Alt+Shift+2', timeframe: null });
    expect(custom['3']).toEqual({ combo: 'Ctrl+Shift+Q', timeframe: '15m' });
    expect(custom['4']).toEqual(DEFAULT_HOTKEY_MAP['4']);
    expect((custom as Record<string, unknown>).UNKNOWN).toBeUndefined();
  });

  it('migra el mapa de teclas de función al hueco correspondiente', () => {
    const migrated = normalizeHotkeyMap(null, { F1: '15m', F2: null, F3: 'ninguno', F4: 'invalido', F12: '1D' });
    expect(['1', '2', '3', '4', '5', '6'].map((s) => migrated[s as '1'].timeframe)).toEqual([
      '15m', null, null, null, '4h', '1d',
    ]);
  });
});

describe('rules / ai / domPositions / acctMeta', () => {
  it('basura de cualquier tipo vuelve a los defaults', () => {
    for (const junk of [null, 7, 'x', [], { rules: 5, ai: 'x', acctMeta: [] }]) {
      const s = normalizeSettings(
        junk && typeof junk === 'object' && !Array.isArray(junk)
          ? junk
          : { rules: junk, ai: junk, acctMeta: junk, domPositions: junk },
      );
      expect(s.rules).toEqual(DEFAULT_SETTINGS.rules);
      expect(s.ai).toEqual(DEFAULT_SETTINGS.ai);
      expect(s.acctMeta).toEqual(DEFAULT_SETTINGS.acctMeta);
      expect(s.domPositions).toBe(false);
    }
  });

  it('rules se acota', () => {
    const r = normalizeSettings({
      rules: { maxRiskPct: 99, maxLeverage: 500.4, dailyLossUsd: 1e9, revengeMinutes: 0 },
    }).rules;
    expect(r).toEqual({ maxRiskPct: 5, maxLeverage: 125, dailyLossUsd: 1e6, revengeMinutes: 1 });
    const low = normalizeSettings({
      rules: { maxRiskPct: 0, maxLeverage: 0, dailyLossUsd: 0, revengeMinutes: 9999 },
    }).rules;
    expect(low).toEqual({ maxRiskPct: 0.1, maxLeverage: 1, dailyLossUsd: 10, revengeMinutes: 240 });
    expect(normalizeSettings({ rules: { maxRiskPct: NaN, dailyLossUsd: -3, maxLeverage: '5' } }).rules).toEqual(
      DEFAULT_SETTINGS.rules,
    );
    expect(normalizeSettings({ rules: { maxLeverage: 7.6 } }).rules.maxLeverage).toBe(8);
  });

  it('ai valida proveedor, modelo, redaction y consentimientos', () => {
    const ai = normalizeSettings({
      ai: {
        provider: 'gemini',
        model: 'anthropic/claude-3.5:free',
        redaction: 'absolute',
        consentedProviders: ['gemini', 'gemini', 'bogus', 3, 'local'],
      },
    }).ai;
    expect(ai).toEqual({
      provider: 'gemini',
      model: 'anthropic/claude-3.5:free',
      redaction: 'absolute',
      consentedProviders: ['gemini', 'local'],
    });
    const bad = normalizeSettings({
      ai: { provider: 'evil', model: 'bad model!', redaction: 'other', consentedProviders: 'openai' },
    }).ai;
    expect(bad).toEqual(DEFAULT_SETTINGS.ai);
    expect(normalizeSettings({ ai: { model: 'a'.repeat(81) } }).ai.model).toBe('');
    expect(normalizeSettings({ ai: { model: 'a'.repeat(80) } }).ai.model).toHaveLength(80);
  });

  it('domPositions solo con true explícito', () => {
    expect(normalizeSettings({ domPositions: true }).domPositions).toBe(true);
    expect(normalizeSettings({ domPositions: 'true' }).domPositions).toBe(false);
    expect(normalizeSettings({ domPositions: 1 }).domPositions).toBe(false);
  });

  it('acctMeta valida tipo y last4', () => {
    expect(normalizeSettings({ acctMeta: { configured: true, kind: 'hmac', last4: 'aB12' } }).acctMeta).toEqual({
      configured: true,
      kind: 'hmac',
      last4: 'aB12',
    });
    expect(normalizeSettings({ acctMeta: { configured: 'yes', kind: 'rsa', last4: 'abcde' } }).acctMeta).toEqual(
      DEFAULT_SETTINGS.acctMeta,
    );
    expect(normalizeSettings({ acctMeta: { last4: '12-4' } }).acctMeta.last4).toBe('');
  });

  it('ida y vuelta por settingsFromStorage', () => {
    const custom = normalizeSettings({
      rules: { maxRiskPct: 2, maxLeverage: 20, dailyLossUsd: 50, revengeMinutes: 30 },
      ai: { provider: 'local', model: 'llama3:8b', redaction: 'absolute', consentedProviders: ['local'] },
      domPositions: true,
      acctMeta: { configured: true, kind: 'ed25519', last4: 'wxyz' },
    });
    const stored = JSON.parse(JSON.stringify({ [SETTINGS_KEY]: custom }));
    expect(settingsFromStorage(stored)).toEqual(custom);
  });
});

describe('locale', () => {
  it('por defecto es auto', () => {
    expect(normalizeSettings({}).locale).toBe('auto');
    expect(DEFAULT_SETTINGS.locale).toBe('auto');
  });
  it('acepta auto y cualquiera de los 20 códigos', () => {
    expect(normalizeSettings({ locale: 'auto' }).locale).toBe('auto');
    for (const l of LOCALES) expect(normalizeSettings({ locale: l.code }).locale).toBe(l.code);
  });
  it('un valor desconocido vuelve a auto', () => {
    for (const bad of ['xx', 'pt', 'EN', '', 7, null, {}, ['es']]) {
      expect(normalizeSettings({ locale: bad }).locale).toBe('auto');
    }
  });
  it('ida y vuelta por settingsFromStorage', () => {
    expect(settingsFromStorage({ [SETTINGS_KEY]: { locale: 'ar' } }).locale).toBe('ar');
  });
});
