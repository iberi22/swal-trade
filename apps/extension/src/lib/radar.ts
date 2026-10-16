import type { BridgeShape } from './tv-bridge/schema';
import { formatPrice } from './tv-bridge/shapes';

export const RADAR_TIMEOUT_MS = 4000;
export type RadarDirection = 'long' | 'short';
export type RadarAlertStatus = 'pending' | 'triggered' | 'win_1r' | 'win_2r' | 'loss' | 'expired';

export interface RadarAlert {
  id: number | string;
  source: string;
  symbol: string;
  tf: string;
  kind: string;
  title: string;
  direction: RadarDirection;
  entry: number;
  stop: number;
  target_1r: number;
  target_2r: number;
  strength: number;
  status: RadarAlertStatus;
  created_at: string;
  triggered_at: string | null;
  resolved_at: string | null;
  outcome_r: number | null;
  mfe_r: number | null;
  mae_r: number | null;
  taken_by_user: boolean;
  user_entry: number | null;
  user_pnl: number | null;
}

export interface WilsonInterval { rate: number | null; low: number | null; high: number | null }
export interface RadarStatSummary {
  n_resolved: number; triggered_rate: number; win_rate_1r: number; ci_1r: WilsonInterval;
  win_rate_2r: number; ci_2r: WilsonInterval; avg_net_r: number; label: string;
}
export interface RadarKindStat extends RadarStatSummary { source: string; kind: string; tf: string }
export interface RadarStats { overall: RadarStatSummary; by_kind: RadarKindStat[]; taken: RadarStatSummary; note: string }
export interface RadarSnapshot { reachable: boolean; version?: string; alerts: RadarAlert[]; stats: RadarStats | null; error?: string }

export const RADAR_STATUS_LABELS: Record<RadarAlertStatus, string> = {
  pending: 'Pendiente', triggered: 'Activada', win_1r: 'Ganó 1R', win_2r: 'Ganó 2R', loss: 'Perdió', expired: 'Caducó',
};
export const RADAR_DIRECTION_LABELS: Record<RadarDirection, string> = { long: 'Largo', short: 'Corto' };
export const radarStatusLabel = (s: string) => RADAR_STATUS_LABELS[s as RadarAlertStatus] ?? s;
export const radarDirectionLabel = (d: string) => RADAR_DIRECTION_LABELS[d as RadarDirection] ?? d;

export function formatWilson(ci: WilsonInterval | null | undefined): string {
  if (!ci || ci.low === null || ci.high === null) return '';
  return `[${(ci.low * 100).toFixed(1).replace('.', ',')}% - ${(ci.high * 100).toFixed(1).replace('.', ',')}%]`;
}
export function formatPct(rate: number | null | undefined): string {
  return `${((Number.isFinite(rate) ? (rate as number) : 0) * 100).toFixed(1).replace('.', ',')} %`;
}
export function formatR(r: number | null | undefined): string {
  const val = Number.isFinite(r) ? (r as number) : 0;
  return `${val > 0 ? '+' : ''}${val.toFixed(2).replace('.', ',')} R`;
}

const num = (v: unknown, def: number | null = null) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
const txt = (v: unknown, max: number, def = '') => (typeof v === 'string' ? v.trim().slice(0, max) : def);
const STATUSES = new Set(['pending', 'triggered', 'win_1r', 'win_2r', 'loss', 'expired']);

export function sanitizeRadarAlert(raw: unknown): RadarAlert | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const entry = num(r.entry), stop = num(r.stop), t1 = num(r.target_1r), t2 = num(r.target_2r);
  if (entry === null || stop === null || t1 === null || t2 === null) return null;
  return {
    id: typeof r.id === 'number' || typeof r.id === 'string' ? r.id : 'unknown',
    source: txt(r.source, 32, 'core'),
    symbol: txt(r.symbol, 20, 'UNKNOWN').toUpperCase(),
    tf: txt(r.tf, 10, '15m'),
    kind: txt(r.kind, 64, ''),
    title: txt(r.title, 100, txt(r.kind, 64) || 'Alerta'),
    direction: r.direction === 'short' ? 'short' : 'long',
    entry, stop, target_1r: t1, target_2r: t2,
    strength: Math.min(1, Math.max(0, num(r.strength, 0.5) ?? 0.5)),
    status: (typeof r.status === 'string' && STATUSES.has(r.status) ? r.status : 'pending') as RadarAlertStatus,
    created_at: txt(r.created_at, 40, new Date().toISOString()),
    triggered_at: typeof r.triggered_at === 'string' ? txt(r.triggered_at, 40) : null,
    resolved_at: typeof r.resolved_at === 'string' ? txt(r.resolved_at, 40) : null,
    outcome_r: num(r.outcome_r), mfe_r: num(r.mfe_r), mae_r: num(r.mae_r),
    taken_by_user: r.taken_by_user === true, user_entry: num(r.user_entry), user_pnl: num(r.user_pnl),
  };
}

const sanitizeWilson = (r: unknown): WilsonInterval => {
  const w = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
  return { rate: num(w.rate), low: num(w.low), high: num(w.high) };
};

const sanitizeSummary = (raw: unknown): RadarStatSummary => {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const n = Math.max(0, Math.floor(num(r.n_resolved, 0) ?? 0));
  return {
    n_resolved: n, triggered_rate: num(r.triggered_rate, 0) ?? 0,
    win_rate_1r: num(r.win_rate_1r, 0) ?? 0, ci_1r: sanitizeWilson(r.ci_1r),
    win_rate_2r: num(r.win_rate_2r, 0) ?? 0, ci_2r: sanitizeWilson(r.ci_2r),
    avg_net_r: num(r.avg_net_r, 0) ?? 0,
    label: n < 30 ? 'sin evidencia (n<30)' : txt(r.label, 50, 'sin etiqueta'),
  };
};

export function sanitizeRadarStats(raw: unknown): RadarStats {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const byKindRaw = Array.isArray(r.by_kind) ? r.by_kind : [];
  return {
    overall: sanitizeSummary(r.overall), taken: sanitizeSummary(r.taken),
    by_kind: byKindRaw.filter((k): k is Record<string, unknown> => !!k && typeof k === 'object').map((k) => ({
      ...sanitizeSummary(k), source: txt(k.source, 32, 'core'), kind: txt(k.kind, 64, 'patrón'), tf: txt(k.tf, 10, '15m'),
    })),
    note: txt(r.note, 300, 'Un alerta es un experimento, nunca una promesa.'),
  };
}

export function shapesForRadarAlert(alert: RadarAlert): BridgeShape[] {
  const id = String(alert.id);
  const time = alert.created_at ? Math.floor(Date.parse(alert.created_at) / 1000) || 0 : 0;
  return [
    { id: `radar:${id}:entry`, kind: 'level', style: 'solid', text: `Radar: Entrada ${formatPrice(alert.entry)}`, points: [{ time, price: alert.entry }] },
    { id: `radar:${id}:stop`, kind: 'level', style: 'dashed', text: `Radar: Stop ${formatPrice(alert.stop)}`, points: [{ time, price: alert.stop }] },
    { id: `radar:${id}:t1`, kind: 'level', style: 'solid', text: `Radar: Obj 1R ${formatPrice(alert.target_1r)}`, points: [{ time, price: alert.target_1r }] },
    { id: `radar:${id}:t2`, kind: 'level', style: 'solid', text: `Radar: Obj 2R ${formatPrice(alert.target_2r)}`, points: [{ time, price: alert.target_2r }] },
  ];
}

export async function fetchWithTimeout(url: string, timeoutMs = RADAR_TIMEOUT_MS, fetchFn = fetch): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try { return await fetchFn(url, { signal: c.signal }); } finally { clearTimeout(t); }
}

export async function fetchRadarSnapshot(port = 47322, fetchFn = fetch): Promise<RadarSnapshot> {
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await fetchWithTimeout(`${base}/v1/health`, RADAR_TIMEOUT_MS, fetchFn);
    if (!health.ok) return { reachable: false, alerts: [], stats: null };
    const hJson = (await health.json()) as { ok?: boolean; version?: string };
    if (hJson?.ok !== true) return { reachable: false, alerts: [], stats: null };

    const [alertsRes, statsRes] = await Promise.all([
      fetchWithTimeout(`${base}/v1/alerts?status=active&limit=50`, RADAR_TIMEOUT_MS, fetchFn).catch(() => null),
      fetchWithTimeout(`${base}/v1/stats`, RADAR_TIMEOUT_MS, fetchFn).catch(() => null),
    ]);

    let alerts: RadarAlert[] = [];
    if (alertsRes?.ok) {
      const j = (await alertsRes.json()) as { alerts?: unknown[] };
      if (Array.isArray(j?.alerts)) alerts = j.alerts.map(sanitizeRadarAlert).filter((a): a is RadarAlert => a !== null);
    }
    const stats = statsRes?.ok ? sanitizeRadarStats(await statsRes.json()) : null;
    return { reachable: true, version: typeof hJson.version === 'string' ? hJson.version : undefined, alerts, stats };
  } catch (err) {
    return { reachable: false, alerts: [], stats: null, error: err instanceof Error ? err.message : String(err) };
  }
}
