// Ajustes del escaner en su propia clave de almacenamiento. El almacenamiento se inyecta
// (browser.storage.local en el sitio de uso).
import { isCellKey } from './stats';

export const SCANNER_SETTINGS_KEY = 'scanner.settings';

export interface KeyValueStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface QuietHours {
  enabled: boolean;
  from: string;
  to: string;
}

export interface ScannerSettings {
  enabled: boolean;
  universe: 'USDT' | 'USDC';
  minQ24: number;
  thresholds: { hi: number; mid: number; lo: number };
  sound: boolean;
  badge: boolean;
  notifications: boolean;
  quietHours: QuietHours;
  maxPerHour: number;
  mutedCells: string[];
  unmutedCells: string[];
  backgroundMode: boolean;
}

export const MIN_Q24_RANGE = { min: 1e6, max: 1e10 } as const;
export const MAX_PER_HOUR_RANGE = { min: 1, max: 30 } as const;
const MAX_CELL_LIST = 500;
const THRESHOLDS = [3, 5, 7];

export function defaultScannerSettings(): ScannerSettings {
  return {
    enabled: false,
    universe: 'USDT',
    minQ24: 20_000_000,
    thresholds: { hi: 5, mid: 7, lo: 7 },
    sound: false,
    badge: true,
    notifications: false,
    quietHours: { enabled: false, from: '23:00', to: '07:00' },
    maxPerHour: 6,
    mutedCells: [],
    unmutedCells: [],
    backgroundMode: false,
  };
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const bool = (x: unknown, d: boolean): boolean => (typeof x === 'boolean' ? x : d);

function clamp(x: unknown, lo: number, hi: number, d: number): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) return d;
  return Math.min(hi, Math.max(lo, x));
}

export function isHHMM(x: unknown): x is string {
  return typeof x === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x);
}

function cellList(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  const out = new Set<string>();
  for (const k of x) {
    if (isCellKey(k)) out.add(k);
    if (out.size >= MAX_CELL_LIST) break;
  }
  return [...out];
}

export function normalizeScannerSettings(raw: unknown): ScannerSettings {
  const d = defaultScannerSettings();
  if (!isObj(raw)) return d;
  const th = isObj(raw.thresholds) ? raw.thresholds : {};
  const pick = (v: unknown, def: number): number => (typeof v === 'number' && THRESHOLDS.includes(v) ? v : def);
  const qh = isObj(raw.quietHours) ? raw.quietHours : {};
  const unmuted = cellList(raw.unmutedCells);
  // una celda en las dos listas: gana la que el usuario eligio al final, que aqui es 'desilenciada'
  const muted = cellList(raw.mutedCells).filter((k) => !unmuted.includes(k));
  return {
    enabled: bool(raw.enabled, d.enabled),
    universe: raw.universe === 'USDC' ? 'USDC' : 'USDT',
    minQ24: clamp(raw.minQ24, MIN_Q24_RANGE.min, MIN_Q24_RANGE.max, d.minQ24),
    thresholds: { hi: pick(th.hi, d.thresholds.hi), mid: pick(th.mid, d.thresholds.mid), lo: pick(th.lo, d.thresholds.lo) },
    sound: bool(raw.sound, d.sound),
    badge: bool(raw.badge, d.badge),
    notifications: bool(raw.notifications, d.notifications),
    quietHours: {
      enabled: bool(qh.enabled, d.quietHours.enabled),
      from: isHHMM(qh.from) ? qh.from : d.quietHours.from,
      to: isHHMM(qh.to) ? qh.to : d.quietHours.to,
    },
    maxPerHour: Math.round(clamp(raw.maxPerHour, MAX_PER_HOUR_RANGE.min, MAX_PER_HOUR_RANGE.max, d.maxPerHour)),
    mutedCells: muted,
    unmutedCells: unmuted,
    backgroundMode: bool(raw.backgroundMode, d.backgroundMode),
  };
}

export async function loadScannerSettings(storage: KeyValueStorage): Promise<ScannerSettings> {
  try {
    return normalizeScannerSettings(await storage.get(SCANNER_SETTINGS_KEY));
  } catch {
    return defaultScannerSettings();
  }
}

export async function saveScannerSettings(storage: KeyValueStorage, settings: unknown): Promise<ScannerSettings> {
  const clean = normalizeScannerSettings(settings);
  await storage.set(SCANNER_SETTINGS_KEY, clean);
  return clean;
}
