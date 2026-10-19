// Ciclo del escaner: velas de 5 m por REST, solo velas cerradas segun la hora del servidor.
// Todo se inyecta (fetch, reloj, estado); sin acceso a Svelte ni a almacenamiento.
import {
  barsFromKlines, CooldownTracker, detectEvents, plansForEvent, SPEC,
  type Bar, type CooldownOut, type TrackedEvent, type MoverEvent, type Plans, type Spec,
} from './movers';
import { validSymbol } from './universe';

export const FAPI = 'https://fapi.binance.com';
export const CONCURRENCY = 4;
export const REQUEST_TIMEOUT_MS = 5000;
export const WEIGHT_STOP = 1200;
export const CLOCK_RESYNC_MS = 3600 * 1000;
export const CLOSE_MARGIN_MS = 1000;
export const CYCLE_DELAY_MS = 3000;
const DEFAULT_RETRY_AFTER_S = 60;
const DEFAULT_BAN_S = 300;

export interface ResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}
export type ScanFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<ResponseLike>;

// ---------------------------------------------------------------- reloj

/** Hora del servidor: desfase medido con /fapi/v1/time y vuelto a medir cada hora. */
export class ServerClock {
  private offset = 0;
  private syncedAt: number | null = null;

  constructor(
    private fetchFn: ScanFetch,
    private local: () => number = Date.now,
    private baseUrl: string = FAPI,
  ) {}

  now(): number {
    return this.local() + this.offset;
  }

  get offsetMs(): number {
    return this.offset;
  }

  needsSync(): boolean {
    return this.syncedAt === null || this.local() - this.syncedAt >= CLOCK_RESYNC_MS;
  }

  /** Mide el desfase con el punto medio de la peticion. false si fallo (se conserva el desfase anterior). */
  async sync(): Promise<boolean> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const t0 = this.local();
      const res = await this.fetchFn(`${this.baseUrl}/fapi/v1/time`, { signal: ctl.signal });
      const t1 = this.local();
      if (!res.ok) return false;
      const body = (await res.json()) as { serverTime?: unknown };
      const st = Number(body?.serverTime);
      if (!Number.isFinite(st) || st <= 0) return false;
      this.offset = st - (t0 + t1) / 2;
      this.syncedAt = t1;
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Vuelve a medir solo si hace falta (primera vez o pasada una hora). */
  async ensure(): Promise<void> {
    if (this.needsSync()) await this.sync();
  }
}

/** ms hasta el proximo cierre de 5 minutos + 3 s. */
export function scheduleNextCycle(serverNowMs: number, s: Spec = SPEC): number {
  const bar = s.bar_minutes * 60000;
  let next = Math.floor(serverNowMs / bar) * bar + CYCLE_DELAY_MS;
  if (next <= serverNowMs) next += bar;
  return next - serverNowMs;
}

/** Open time de la ultima vela cerrada: closeTime (open + bar - 1) < serverNow - 1000. */
export function lastClosedOpen(serverNowMs: number, s: Spec = SPEC): number {
  const bar = s.bar_minutes * 60000;
  const cutoff = serverNowMs - CLOSE_MARGIN_MS;
  return Math.floor((cutoff - bar) / bar) * bar;
}

// ---------------------------------------------------------------- ciclo

export interface ScanState {
  /** Open time de la ultima vela procesada con exito (idempotencia por vela). */
  lastBarOpenMs: number | null;
}

export interface ScanProgress {
  done: number;
  total: number;
  failed: number;
}

export interface ScanSettings {
  concurrency?: number;
  timeoutMs?: number;
  weightStop?: number;
}

export interface ScanDeps {
  fetch: ScanFetch;
  /** Hora del servidor (ServerClock.now). */
  now: () => number;
  spec?: Spec;
  universe: ReadonlyArray<string>;
  q24: Record<string, number>;
  cooldown: CooldownTracker;
  settings?: ScanSettings;
  state?: ScanState;
  btcSymbol?: string;
  onProgress?: (p: ScanProgress) => void;
  baseUrl?: string;
}

export interface ScanEvent extends CooldownOut {
  /** null para filas de mercado fundidas. */
  plans: Plans | null;
}

export interface ScanMarket {
  barOpenMs: number;
  barCloseMs: number;
  /** Eventos de movimiento de mercado antes de fundir. */
  marketWideEvents: number;
  collapsed: boolean;
}

export interface ScanStats {
  symbols: number;
  failed: number;
  weight: number;
}

export type ScanStatus = 'ok' | 'same_bar' | 'weight' | 'paused' | 'banned' | 'aborted' | 'empty';

export interface ScanResult {
  status: ScanStatus;
  events: ScanEvent[];
  market: ScanMarket | null;
  stats: ScanStats;
  paused_until?: number;
  banned_until?: number;
}

function retryAfterMs(res: ResponseLike, fallbackS: number): number {
  const v = Number(res.headers.get('Retry-After'));
  return (Number.isFinite(v) && v > 0 ? v : fallbackS) * 1000;
}

export async function runScanCycle(deps: ScanDeps): Promise<ScanResult> {
  const spec = deps.spec ?? SPEC;
  const conc = Math.max(1, Math.min(CONCURRENCY, deps.settings?.concurrency ?? CONCURRENCY));
  const timeoutMs = deps.settings?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const weightStop = deps.settings?.weightStop ?? WEIGHT_STOP;
  const base = deps.baseUrl ?? FAPI;
  const bar = spec.bar_minutes * 60000;

  const serverNow = deps.now();
  const barOpen = lastClosedOpen(serverNow, spec);
  const stats: ScanStats = { symbols: 0, failed: 0, weight: 0 };
  const result = (status: ScanStatus, extra: Partial<ScanResult> = {}): ScanResult => ({
    status, events: [], market: null, stats, ...extra,
  });

  if (deps.state && deps.state.lastBarOpenMs !== null && barOpen <= deps.state.lastBarOpenMs) {
    return result('same_bar');
  }

  const symbols = [...new Set(deps.universe.map(validSymbol).filter((s): s is string => s !== null))].sort();
  if (symbols.length === 0) return result('empty');

  const cutoff = serverNow - CLOSE_MARGIN_MS;
  const barsBySymbol: Record<string, Bar[]> = {};
  let next = 0;
  let done = 0;
  let requests = 0;
  let maxHeaderWeight = 0;
  let stop = null as ScanStatus | null;
  let pausedUntil: number | undefined;
  let bannedUntil: number | undefined;

  const failOne = (): void => {
    stats.failed++;
    if (stats.failed * 2 > symbols.length && stop === null) stop = 'aborted';
  };

  async function one(sym: string): Promise<void> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    requests++;
    try {
      const res = await deps.fetch(`${base}/fapi/v1/klines?symbol=${sym}&interval=5m&limit=40`, { signal: ctl.signal });
      const used = Number(res.headers.get('X-MBX-USED-WEIGHT-1M'));
      if (res.headers.get('X-MBX-USED-WEIGHT-1M') !== null && Number.isFinite(used)) {
        maxHeaderWeight = Math.max(maxHeaderWeight, used);
        if (used > weightStop && stop === null) stop = 'weight';
      }
      if (res.status === 418) {
        bannedUntil = serverNow + retryAfterMs(res, DEFAULT_BAN_S);
        stop = 'banned';
        return;
      }
      if (res.status === 429) {
        pausedUntil = serverNow + retryAfterMs(res, DEFAULT_RETRY_AFTER_S);
        if (stop !== 'banned') stop = 'paused';
        return;
      }
      if (!res.ok) return failOne();
      const rows = await res.json();
      if (!Array.isArray(rows)) return failOne();
      const closed = (rows as Array<Array<string | number>>).filter(
        (r) => Array.isArray(r) && Number(r[6]) < cutoff,
      );
      const bars = barsFromKlines(closed);
      if (bars.some((b) => !Number.isFinite(b.close) || !Number.isFinite(b.open_time_ms))) return failOne();
      barsBySymbol[sym] = bars;
    } catch {
      failOne();
    } finally {
      clearTimeout(timer);
      done++;
      deps.onProgress?.({ done, total: symbols.length, failed: stats.failed });
    }
  }

  async function worker(): Promise<void> {
    while (stop === null) {
      const i = next++;
      if (i >= symbols.length) return;
      await one(symbols[i]!);
    }
  }

  await Promise.all(Array.from({ length: Math.min(conc, symbols.length) }, worker));

  stats.symbols = Object.keys(barsBySymbol).length;
  stats.weight = maxHeaderWeight > 0 ? maxHeaderWeight : requests;

  if (stop === 'banned') return result('banned', { banned_until: bannedUntil });
  if (stop === 'paused') return result('paused', { paused_until: pausedUntil });
  if (stop === 'weight') return result('weight');
  if (stop === 'aborted' || stats.failed * 2 > symbols.length) return result('aborted');

  const btc = deps.btcSymbol ?? 'BTCUSDT';
  const detected: MoverEvent[] = detectEvents(barsBySymbol, barOpen, deps.q24, spec, btc);
  const outs = deps.cooldown.process(detected as unknown as TrackedEvent[]);
  const events: ScanEvent[] = outs.map((o) => {
    const e = o.event as unknown as { market?: boolean; ret?: number; close?: number; atr14?: number | null };
    const plans = e.market || typeof e.ret !== 'number' || typeof e.close !== 'number'
      ? null
      : plansForEvent({ ret: e.ret, close: e.close, atr14: e.atr14 }, spec);
    return { ...o, plans };
  });
  const mw = detected.filter((e) => e.market_wide).length;
  if (deps.state) deps.state.lastBarOpenMs = barOpen;
  return {
    status: 'ok',
    events,
    market: {
      barOpenMs: barOpen,
      barCloseMs: barOpen + bar,
      marketWideEvents: mw,
      collapsed: mw > spec.max_events_per_bar,
    },
    stats,
  };
}
