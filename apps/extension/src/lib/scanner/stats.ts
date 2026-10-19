// Estadisticas por celda del contrato swal.movers-stats.v1 (workers/public-site/src/movers-stats.js).
// Se vuelven a validar aqui con las mismas reglas: lo que no encaja se descarta.
import { gradeView } from '../radar';
import type { KeyValueStorage } from './settings';

export const STATS_URL = 'https://trade.swal.network/api/movers-stats';
export const STATS_TTL_MS = 6 * 3600 * 1000;
export const STATS_TIMEOUT_MS = 5000;
export const MAX_CELLS = 500;

export type Grade = 'no_evidence' | 'negative' | 'promising' | 'validated';
const GRADES: Grade[] = ['no_evidence', 'negative', 'promising', 'validated'];
const EPS = 1e-9;

export interface StatsCell {
  signal: string;
  mode: 'fade' | 'follow';
  direction: 'long' | 'short';
  threshold: 3 | 5 | 7;
  vol_tier: 'hi' | 'mid' | 'lo';
  context: 'all' | 'market_wide' | 'idio';
  n: number;
  n_clusters: number;
  wins_1r: number;
  win_rate: number;
  ci_low: number;
  ci_high: number;
  breakeven: number;
  mean_net_r: number;
  net_r_ci_low: number;
  net_r_ci_high: number;
  median_stop_pct: number;
  events_per_day: number;
  grade: Grade;
}

export interface MoversStats {
  schema: 'swal.movers-stats.v1';
  method: 'study' | 'forward';
  /** '' cuando no hay documento (vacio o inalcanzable). */
  spec_version: string;
  cost_round_trip: number;
  generated_at?: string;
  cells: StatsCell[];
  note?: string;
}

export interface CellQuery {
  mode: 'fade' | 'follow';
  direction: 'long' | 'short';
  threshold: number;
  tier: string;
  signal: string;
  context: string;
}

// ---------------------------------------------------------------- clave de celda

const KEY_RE = /^[a-z0-9_]{1,24}\|(fade|follow)\|(long|short)\|(3|5|7)\|(hi|mid|lo)\|(all|market_wide|idio)$/;

export function cellKey(c: { signal: string; mode: string; direction: string; threshold: number; tier?: string; vol_tier?: string; context: string }): string {
  return [c.signal, c.mode, c.direction, c.threshold, c.tier ?? c.vol_tier, c.context].join('|');
}

export function isCellKey(x: unknown): x is string {
  return typeof x === 'string' && KEY_RE.test(x);
}

// ---------------------------------------------------------------- sanear

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isUnit = (x: unknown): x is number => isNum(x) && x >= 0 && x <= 1;
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);

const CELL_KEYS = [
  'signal', 'mode', 'direction', 'threshold', 'vol_tier', 'context', 'n', 'n_clusters', 'wins_1r',
  'win_rate', 'ci_low', 'ci_high', 'breakeven', 'mean_net_r', 'net_r_ci_low', 'net_r_ci_high',
  'median_stop_pct', 'events_per_day', 'grade',
];

export function sanitizeCell(raw: unknown): StatsCell | null {
  if (!isObj(raw)) return null;
  const c = raw;
  const keys = Object.keys(c);
  if (keys.length !== CELL_KEYS.length || !keys.every((k) => CELL_KEYS.includes(k))) return null;
  if (typeof c.signal !== 'string' || !/^[a-z0-9_]{1,24}$/.test(c.signal)) return null;
  if (c.mode !== 'fade' && c.mode !== 'follow') return null;
  if (c.direction !== 'long' && c.direction !== 'short') return null;
  if (![3, 5, 7].includes(c.threshold as number)) return null;
  if (!['hi', 'mid', 'lo'].includes(c.vol_tier as string)) return null;
  if (!['all', 'market_wide', 'idio'].includes(c.context as string)) return null;
  if (!isInt(c.n) || c.n < 0) return null;
  if (!isInt(c.n_clusters) || c.n_clusters < 0 || c.n_clusters > c.n) return null;
  if (!isInt(c.wins_1r) || c.wins_1r < 0 || c.wins_1r > c.n) return null;
  for (const k of ['win_rate', 'ci_low', 'ci_high', 'breakeven']) if (!isUnit(c[k])) return null;
  if ((c.ci_low as number) > (c.win_rate as number) || (c.win_rate as number) > (c.ci_high as number)) return null;
  for (const k of ['mean_net_r', 'net_r_ci_low', 'net_r_ci_high']) {
    if (!isNum(c[k]) || Math.abs(c[k] as number) > 10) return null;
  }
  if ((c.net_r_ci_low as number) > (c.mean_net_r as number) || (c.mean_net_r as number) > (c.net_r_ci_high as number)) return null;
  if (!isNum(c.median_stop_pct) || c.median_stop_pct < 0 || c.median_stop_pct > 0.2) return null;
  if (!isNum(c.events_per_day) || c.events_per_day < 0) return null;
  if (!GRADES.includes(c.grade as Grade)) return null;
  const nc = c.n_clusters as number;
  if (c.grade === 'validated') {
    if (nc < 100 || (c.ci_low as number) < (c.breakeven as number) + 0.02 - EPS || !((c.net_r_ci_low as number) > 0)) return null;
  } else if (c.grade === 'promising') {
    if (nc < 30 || !((c.net_r_ci_low as number) > 0)) return null;
  } else if (c.grade === 'negative') {
    if (nc < 30 || !((c.net_r_ci_high as number) < 0)) return null;
  }
  const out = {} as Record<string, unknown>;
  for (const k of CELL_KEYS) out[k] = c[k];
  return out as unknown as StatsCell;
}

export function emptyStats(method: 'study' | 'forward' = 'study'): MoversStats {
  return { schema: 'swal.movers-stats.v1', method, spec_version: '', cost_round_trip: 0, cells: [] };
}

/** Documento valido -> copia saneada (celdas invalidas descartadas); documento malo -> null. */
export function sanitizeMoversStats(raw: unknown): MoversStats | null {
  if (!isObj(raw)) return null;
  if (raw.schema !== 'swal.movers-stats.v1') return null;
  if (raw.method !== 'study' && raw.method !== 'forward') return null;
  const sv = raw.spec_version;
  // un documento vacio publicado ({schema, cells:[], note}) no trae spec_version: se trata como vacio
  if (!Array.isArray(raw.cells) || raw.cells.length > MAX_CELLS) return null;
  const hasSpec = typeof sv === 'string' && sv.length > 0 && sv.length <= 40 && /^[A-Za-z0-9._-]+$/.test(sv);
  if (sv !== undefined && !hasSpec) return null;
  if (raw.cost_round_trip !== undefined && (!isNum(raw.cost_round_trip) || raw.cost_round_trip < 0 || raw.cost_round_trip > 0.05)) return null;
  const out: MoversStats = {
    schema: 'swal.movers-stats.v1',
    method: raw.method,
    spec_version: hasSpec ? (sv as string) : '',
    cost_round_trip: isNum(raw.cost_round_trip) ? raw.cost_round_trip : 0,
    cells: [],
  };
  if (typeof raw.generated_at === 'string' && raw.generated_at.length <= 64 && !isNaN(Date.parse(raw.generated_at))) {
    out.generated_at = raw.generated_at;
  }
  if (typeof raw.note === 'string' && raw.note.length <= 300) out.note = raw.note;
  if (!hasSpec) return out; // sin version de especificacion no hay celdas de las que fiarse
  for (const c of raw.cells) {
    const cell = sanitizeCell(c);
    if (cell) out.cells.push(cell);
  }
  return out;
}

// ---------------------------------------------------------------- red + cache

export type FetchFn = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface CacheEntry {
  at: number;
  doc: unknown;
}

export async function fetchMoversStats(
  fetchFn: FetchFn,
  method: 'study' | 'forward' = 'study',
  opts: { storage?: KeyValueStorage; now?: () => number; timeoutMs?: number; baseUrl?: string } = {},
): Promise<MoversStats> {
  const now = opts.now ?? Date.now;
  const cacheKey = `scanner.stats.${method}`;
  const storage = opts.storage;
  if (storage) {
    try {
      const hit = (await storage.get(cacheKey)) as CacheEntry | undefined;
      if (hit && isNum(hit.at) && now() - hit.at >= 0 && now() - hit.at < STATS_TTL_MS) {
        const doc = sanitizeMoversStats(hit.doc);
        if (doc && doc.method === method) return doc;
      }
    } catch {
      /* cache ilegible: se pide de nuevo */
    }
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? STATS_TIMEOUT_MS);
  try {
    const res = await fetchFn(`${opts.baseUrl ?? STATS_URL}?method=${method}`, { signal: ctl.signal });
    if (!res.ok) return emptyStats(method);
    const raw = await res.json();
    const doc = sanitizeMoversStats(raw);
    if (!doc || doc.method !== method) return emptyStats(method);
    if (storage) {
      try {
        await storage.set(cacheKey, { at: now(), doc } satisfies CacheEntry);
      } catch {
        /* sin cache */
      }
    }
    return doc;
  } catch {
    return emptyStats(method);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- consulta

export function cellFor(stats: MoversStats | null | undefined, q: CellQuery): StatsCell | null {
  if (!stats) return null;
  return (
    stats.cells.find(
      (c) =>
        c.signal === q.signal && c.mode === q.mode && c.direction === q.direction &&
        c.threshold === q.threshold && c.vol_tier === q.tier && c.context === q.context,
    ) ?? null
  );
}

export interface GradeResult {
  grade: Grade;
  cell: StatsCell | null;
  note: string | null;
  view: { label: string; tone: string; hint: string };
}

/** Grado de una celda; otra version de la especificacion, sin celda o sin estadisticas -> no_evidence. */
export function gradeFor(stats: MoversStats | null | undefined, specVersion: string, q: CellQuery): GradeResult {
  const none = (note: string): GradeResult => ({ grade: 'no_evidence', cell: null, note, view: gradeView('no_evidence', 0) });
  if (!stats || stats.cells.length === 0 || !stats.spec_version) return none('Sin estadísticas disponibles');
  if (stats.spec_version !== specVersion) return none('Estadísticas de otra versión de la especificación');
  const cell = cellFor(stats, q);
  if (!cell) return none('Sin celda medida para este evento');
  return { grade: cell.grade, cell, note: null, view: gradeView(cell.grade, cell.n) };
}

export interface CellOverrides {
  mutedCells?: ReadonlyArray<string>;
  unmutedCells?: ReadonlyArray<string>;
}

/** Celdas negativas silenciadas por defecto; el usuario puede desilenciar o silenciar por clave. */
export function muted(cell: StatsCell | null | undefined, overrides: CellOverrides = {}): boolean {
  if (!cell) return false;
  const key = cellKey(cell);
  if (overrides.unmutedCells?.includes(key)) return false;
  if (overrides.mutedCells?.includes(key)) return true;
  return cell.grade === 'negative';
}
