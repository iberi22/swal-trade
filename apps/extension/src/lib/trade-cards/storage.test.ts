import { describe, expect, it } from 'vitest';
import { defaultPresets } from './presets';
import { loadPresets, MAX_PRESETS, normalizePresets, savePresets, TRADE_CARDS_STORAGE_KEY } from './storage';

describe('trade card storage validation', () => {
  it('falls back to defaults for unknown shapes', () => {
    for (const raw of [undefined, null, 5, 'x', {}, [{ nope: 1 }]]) {
      expect(normalizePresets(raw)).toEqual(defaultPresets());
    }
  });

  it('round-trips the defaults', () => {
    expect(normalizePresets(defaultPresets())).toEqual(defaultPresets());
  });

  it('clamps numbers and cleans names', () => {
    const [p] = normalizePresets([
      {
        id: 'a b', name: `  <b>${'x'.repeat(80)}</b>\n`, side: 'weird',
        entry: { kind: 'limit_level', pick: 'level_kind', levelKind: 'pdh' },
        stop: { kind: 'atr', atrMult: 99 },
        tp: { rMultiples: [0, 2, 99, 'a'], useNextLevel: 'yes' },
        size: { basis: 'margin', pct: 400 },
        leverage: 9999, scaleIn: { tranches: 9 },
      },
    ]);
    expect(p).toBeDefined();
    if (!p) return;
    expect(p.name.length).toBeLessThanOrEqual(40);
    expect(p.name).not.toMatch(/[<>\n]/);
    expect(p.side).toBe('auto');
    expect(p.entry).toEqual({ kind: 'limit_level', pick: 'nearest_support' });
    expect(p.stop).toEqual({ kind: 'atr', atrMult: 6 });
    expect(p.tp).toEqual({ rMultiples: [0.5, 2, 10], useNextLevel: false });
    expect(p.size).toEqual({ basis: 'margin', pct: 50 });
    expect(p.leverage).toBe(125);
    expect(p.scaleIn).toEqual({ tranches: 4 });
    expect(p.id).toMatch(/^u-/);
  });

  it('clamps low values and tranche count', () => {
    const [p] = normalizePresets([{ id: 'ok', name: 'n', size: { basis: 'risk', pct: 0 }, stop: { kind: 'atr', atrMult: 0 }, scaleIn: { tranches: 1 } }]);
    expect(p?.size.pct).toBe(0.1);
    expect(p?.stop).toEqual({ kind: 'atr', atrMult: 0.5 });
    expect(p?.scaleIn).toEqual({ tranches: 2 });
  });

  it('keeps at most 12 presets and unique ids', () => {
    const many = Array.from({ length: 20 }, () => ({ id: 'same', name: 'n', size: { basis: 'risk', pct: 1 } }));
    const out = normalizePresets(many);
    expect(out).toHaveLength(MAX_PRESETS);
    expect(new Set(out.map((x) => x.id)).size).toBe(MAX_PRESETS);
  });

  it('loads and saves through a storage area, tolerating failures', async () => {
    const mem: Record<string, unknown> = {};
    const area = {
      get: async (k: string) => ({ [k]: mem[k] }),
      set: async (items: Record<string, unknown>) => { Object.assign(mem, items); },
    };
    expect(await loadPresets(area)).toEqual(defaultPresets());
    await savePresets(area, defaultPresets().slice(0, 2));
    expect((mem[TRADE_CARDS_STORAGE_KEY] as unknown[]).length).toBe(2);
    expect(await loadPresets(area)).toHaveLength(2);
    const broken = { get: async () => { throw new Error('x'); }, set: async () => { throw new Error('x'); } };
    expect(await loadPresets(broken)).toEqual(defaultPresets());
    await expect(savePresets(broken, [])).resolves.toBeUndefined();
    expect(await loadPresets(undefined)).toEqual(defaultPresets());
  });
});
