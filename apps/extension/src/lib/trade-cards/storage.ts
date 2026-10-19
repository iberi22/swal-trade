import { defaultPresets } from './presets';
import { LEVEL_KINDS, type TradeCardEntry, type TradeCardPreset, type TradeCardStop } from './types';

export const TRADE_CARDS_STORAGE_KEY = 'tradeCards.presets';
export const MAX_PRESETS = 12;
export const MAX_NAME = 40;

interface AreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Texto llano: sin caracteres de control ni marcado, recortado. */
export function cleanName(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
  return text || 'Tarjeta';
}

function normalizeEntry(raw: unknown): TradeCardEntry {
  if (isObj(raw) && raw.kind === 'market') return { kind: 'market' };
  const r = isObj(raw) ? raw : {};
  const pick = r.pick === 'nearest_resistance' || r.pick === 'level_kind' ? r.pick : 'nearest_support';
  const out: TradeCardEntry = { kind: 'limit_level', pick };
  if (pick === 'level_kind') {
    const lk = (LEVEL_KINDS as readonly string[]).includes(r.levelKind as string) ? (r.levelKind as (typeof LEVEL_KINDS)[number]) : null;
    if (!lk) return { kind: 'limit_level', pick: 'nearest_support' };
    out.levelKind = lk;
  }
  if (r.offsetAtr !== undefined) out.offsetAtr = clamp(r.offsetAtr, 0, 3, 0);
  return out;
}

function normalizeStop(raw: unknown): TradeCardStop {
  const r = isObj(raw) ? raw : {};
  if (r.kind === 'atr') return { kind: 'atr', atrMult: clamp(r.atrMult, 0.5, 6, 1.5) };
  if (r.kind === 'pct') return { kind: 'pct', pct: clamp(r.pct, 0.1, 20, 1) };
  return { kind: 'invalidation' };
}

export function normalizePreset(raw: unknown, usedIds: Set<string>): TradeCardPreset | null {
  if (!isObj(raw)) return null;
  const size = isObj(raw.size) ? raw.size : null;
  if (!size) return null;
  const basis = size.basis === 'margin' ? 'margin' : size.basis === 'risk' ? 'risk' : null;
  if (!basis) return null;
  let id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(raw.id) ? raw.id : '';
  while (!id || usedIds.has(id)) id = `u-${Math.random().toString(36).slice(2, 8)}`;
  usedIds.add(id);
  const tp = isObj(raw.tp) ? raw.tp : {};
  const rs = Array.isArray(tp.rMultiples)
    ? tp.rMultiples.map((v) => clamp(v, 0.5, 10, Number.NaN)).filter((v) => Number.isFinite(v)).slice(0, 4)
    : [1, 2];
  const preset: TradeCardPreset = {
    id,
    name: cleanName(raw.name),
    side: raw.side === 'long' || raw.side === 'short' ? raw.side : 'auto',
    entry: normalizeEntry(raw.entry),
    stop: normalizeStop(raw.stop),
    tp: { rMultiples: rs, useNextLevel: tp.useNextLevel === true },
    size: { basis, pct: clamp(size.pct, 0.1, 50, 1) },
    leverage: raw.leverage === 'min' ? 'min' : Math.round(clamp(raw.leverage, 1, 125, Number.NaN)) || 'min',
  };
  if (isObj(raw.scaleIn)) {
    const n = Math.round(clamp(raw.scaleIn.tranches, 2, 4, 3));
    preset.scaleIn = { tranches: n as 2 | 3 | 4 };
  }
  return preset;
}

/** Valida y recorta lo leído de storage. Forma desconocida -> tarjetas por defecto. */
export function normalizePresets(raw: unknown): TradeCardPreset[] {
  if (!Array.isArray(raw)) return defaultPresets();
  const used = new Set<string>();
  const out: TradeCardPreset[] = [];
  for (const item of raw) {
    if (out.length >= MAX_PRESETS) break;
    const p = normalizePreset(item, used);
    if (p) out.push(p);
  }
  if (out.length === 0 && raw.length > 0) return defaultPresets();
  return out;
}

export async function loadPresets(area: AreaLike | undefined | null): Promise<TradeCardPreset[]> {
  if (!area) return defaultPresets();
  try {
    const stored = await area.get(TRADE_CARDS_STORAGE_KEY);
    return normalizePresets(stored?.[TRADE_CARDS_STORAGE_KEY]);
  } catch {
    return defaultPresets();
  }
}

export async function savePresets(area: AreaLike | undefined | null, presets: TradeCardPreset[]): Promise<void> {
  if (!area) return;
  try {
    await area.set({ [TRADE_CARDS_STORAGE_KEY]: normalizePresets(presets) });
  } catch {
    /* sin almacenamiento: las tarjetas siguen en memoria */
  }
}
