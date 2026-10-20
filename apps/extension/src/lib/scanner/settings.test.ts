import { describe, it, expect } from 'vitest';
import {
  defaultScannerSettings, loadScannerSettings, normalizeScannerSettings, saveScannerSettings,
  SCANNER_SETTINGS_KEY, type KeyValueStorage,
} from './settings';

const memStorage = (): KeyValueStorage & { data: Map<string, unknown> } => {
  const data = new Map<string, unknown>();
  return { data, get: async (k) => data.get(k), set: async (k, v) => void data.set(k, v) };
};
const KEY = 'move30|follow|long|5|hi|all';

describe('normalizeScannerSettings', () => {
  it('garbage -> defaults', () => {
    const d = defaultScannerSettings();
    for (const g of [null, undefined, 5, 'x', [], { enabled: 'yes', minQ24: 'a', thresholds: 3, quietHours: 'q' }]) {
      expect(normalizeScannerSettings(g)).toEqual(d);
    }
    expect(d.enabled).toBe(false);
    expect(d.minQ24).toBe(20_000_000);
    expect(d.thresholds).toEqual({ hi: 5, mid: 7, lo: 7 });
    expect(d.quietHours).toEqual({ enabled: false, from: '23:00', to: '07:00' });
    expect(d.maxPerHour).toBe(6);
    expect(d.badge).toBe(true);
    expect(d.sound || d.notifications || d.backgroundMode).toBe(false);
  });
  it('clamps numbers and validates enums', () => {
    const s = normalizeScannerSettings({
      universe: 'USDC', minQ24: 5, maxPerHour: 999, thresholds: { hi: 3, mid: 4, lo: 'x' },
    });
    expect(s.universe).toBe('USDC');
    expect(s.minQ24).toBe(1e6);
    expect(normalizeScannerSettings({ minQ24: 1e12 }).minQ24).toBe(1e10);
    expect(s.maxPerHour).toBe(30);
    expect(normalizeScannerSettings({ maxPerHour: 0 }).maxPerHour).toBe(1);
    expect(s.thresholds).toEqual({ hi: 3, mid: 7, lo: 7 });
    expect(normalizeScannerSettings({ universe: 'EUR' }).universe).toBe('USDT');
    expect(normalizeScannerSettings({ minQ24: NaN }).minQ24).toBe(20_000_000);
  });
  it('validates quiet hours strings', () => {
    expect(normalizeScannerSettings({ quietHours: { enabled: true, from: '25:00', to: '06:30' } }).quietHours)
      .toEqual({ enabled: true, from: '23:00', to: '06:30' });
  });
  it('keeps only valid unique cell keys and lets unmute win', () => {
    const s = normalizeScannerSettings({
      mutedCells: [KEY, KEY, 'nope', 5, 'move30|fade|long|4|hi|all', 'move30|fade|short|3|lo|idio'],
      unmutedCells: [KEY, '../x'],
    });
    expect(s.unmutedCells).toEqual([KEY]);
    expect(s.mutedCells).toEqual(['move30|fade|short|3|lo|idio']);
  });
});

describe('load/save', () => {
  it('uses its own key and round-trips', async () => {
    const st = memStorage();
    expect(await loadScannerSettings(st)).toEqual(defaultScannerSettings());
    const saved = await saveScannerSettings(st, { enabled: true, minQ24: 5e7, evil: 1 });
    expect(st.data.has(SCANNER_SETTINGS_KEY)).toBe(true);
    expect(SCANNER_SETTINGS_KEY).toBe('scanner.settings');
    expect(saved).not.toHaveProperty('evil');
    expect((await loadScannerSettings(st)).minQ24).toBe(5e7);
  });
  it('a throwing storage falls back to defaults', async () => {
    const bad: KeyValueStorage = { get: async () => { throw new Error('x'); }, set: async () => {} };
    expect(await loadScannerSettings(bad)).toEqual(defaultScannerSettings());
  });
});

describe('universe round-trip', () => {
  function memoryStorage(initial: Record<string, unknown> = {}) {
    const data = new Map<string, unknown>(Object.entries(initial));
    return {
      data,
      async get(key: string) {
        return data.get(key);
      },
      async set(key: string, value: unknown) {
        data.set(key, JSON.parse(JSON.stringify(value)));
      },
    };
  }

  it('saves USDC and reads it back unchanged', async () => {
    const storage = memoryStorage();
    const saved = await saveScannerSettings(storage, { universe: 'USDC', enabled: true });
    expect(saved.universe).toBe('USDC');
    expect((await loadScannerSettings(storage)).universe).toBe('USDC');
  });

  it('keeps USDC when another setting changes right after', async () => {
    const storage = memoryStorage();
    await saveScannerSettings(storage, { universe: 'USDC' });
    const next = await saveScannerSettings(storage, {
      ...(await loadScannerSettings(storage)),
      sound: true,
    });
    expect(next.universe).toBe('USDC');
    expect(next.sound).toBe(true);
    expect((await loadScannerSettings(storage)).universe).toBe('USDC');
  });

  it('keeps the stored value when junk fields are around it', async () => {
    const storage = memoryStorage();
    await saveScannerSettings(storage, { universe: 'USDC' });
    storage.data.set('scanner.settings', {
      ...(storage.data.get('scanner.settings') as object),
      universe: 'USDC',
      junk: [1, 2, 3],
    });
    expect((await loadScannerSettings(storage)).universe).toBe('USDC');
  });
});
