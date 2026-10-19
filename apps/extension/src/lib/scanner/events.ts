// Politica del almacen de eventos del escaner: filas con enfriamiento, avisos limitados y contador de no vistos.
import type { Plans } from './movers';
import type { ScanEvent } from './scan-cycle';
import type { StatsCell } from './stats';

export const MAX_ROWS = 200;
export const DEFAULT_MAX_PER_HOUR = 6;
const HOUR_MS = 3600 * 1000;

export interface ScannerEvent {
  id: string;
  symbol: string;
  signal: string;
  threshold: number;
  move: 'up' | 'down';
  ret: number | null;
  vol_ratio: number | null;
  tier: string | null;
  q24: number | null;
  takerImb: number | null;
  marketWide: boolean;
  createdAtMs: number;
  /** Ultima escalada del umbral (igual a createdAtMs si nunca escalo). */
  updatedAtMs: number;
  prevThreshold: number | null;
  plans: Plans | null;
  /** Celdas medidas de cada modo; las rellena stats.ts. */
  cells: { follow: StatsCell | null; fade: StatsCell | null };
  seen: boolean;
  /** Solo filas de mercado fundidas. */
  count?: number;
  symbols?: string[];
}

export const eventKey = (e: { symbol: string; signal: string; move: string }): string =>
  `${e.symbol}\u0000${e.signal}\u0000${e.move}`;

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

export function toScannerEvent(o: ScanEvent): ScannerEvent {
  const e = o.event as Record<string, unknown>;
  const market = e.market === true;
  const close = Number(e.close_time_ms);
  return {
    id: `${e.symbol}:${e.signal}:${e.move}:${close}`,
    symbol: String(e.symbol),
    signal: String(e.signal),
    threshold: Number(e.threshold),
    move: e.move === 'down' ? 'down' : 'up',
    ret: market ? null : num(e.ret),
    vol_ratio: market ? null : num(e.vol_ratio),
    tier: market || typeof e.tier !== 'string' ? null : e.tier,
    q24: market ? null : num(e.q24),
    takerImb: market ? null : num(e.taker_imb),
    marketWide: e.market_wide === true,
    createdAtMs: close,
    updatedAtMs: close,
    prevThreshold: o.prev_threshold,
    plans: o.plans,
    cells: { follow: null, fade: null },
    seen: false,
    ...(market ? { count: Number(e.count) || 0, symbols: Array.isArray(e.symbols) ? (e.symbols as string[]) : [] } : {}),
  };
}

export class EventLog {
  private rows: ScannerEvent[] = [];

  constructor(private max: number = MAX_ROWS, initial: ReadonlyArray<ScannerEvent> = []) {
    this.rows = initial.slice(0, max).map((r) => ({ ...r }));
  }

  /** Filas, la mas reciente primero. */
  list(): ScannerEvent[] {
    return this.rows;
  }

  /**
   * Inserta resultados de un ciclo. 'new' agrega una fila; 'update' (escalada de umbral dentro del
   * enfriamiento) actualiza la fila existente y la vuelve a marcar como no vista.
   * Devuelve las filas nuevas y las actualizadas.
   */
  apply(outs: ReadonlyArray<ScanEvent>): { inserted: ScannerEvent[]; updated: ScannerEvent[] } {
    const inserted: ScannerEvent[] = [];
    const updated: ScannerEvent[] = [];
    for (const o of outs) {
      const fresh = toScannerEvent(o);
      if (o.type === 'update') {
        const idx = this.rows.findIndex((r) => eventKey(r) === eventKey(fresh));
        if (idx >= 0) {
          const old = this.rows[idx]!;
          const merged: ScannerEvent = {
            ...fresh,
            id: old.id,
            createdAtMs: old.createdAtMs,
            updatedAtMs: fresh.createdAtMs,
            prevThreshold: o.prev_threshold ?? old.threshold,
            cells: fresh.cells,
            seen: false,
          };
          this.rows.splice(idx, 1);
          this.rows.unshift(merged);
          updated.push(merged);
          continue;
        }
        // la fila original ya salio del almacen: se trata como nueva
      }
      this.rows.unshift(fresh);
      inserted.push(fresh);
    }
    if (this.rows.length > this.max) this.rows.length = this.max;
    return { inserted, updated };
  }

  unseenCount(): number {
    return this.rows.filter((r) => !r.seen).length;
  }

  markAllSeen(): void {
    for (const r of this.rows) r.seen = true;
  }

  clear(): void {
    this.rows = [];
  }
}

// ---------------------------------------------------------------- avisos

export interface QuietWindow {
  enabled: boolean;
  from: string;
  to: string;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Hora local de `at`; la ventana puede cruzar la medianoche (23:00-07:00). from == to -> nunca. */
export function inQuietHours(q: QuietWindow, at: Date): boolean {
  if (!q.enabled) return false;
  const from = minutesOf(q.from);
  const to = minutesOf(q.to);
  if (from === to) return false;
  const now = at.getHours() * 60 + at.getMinutes();
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/** Un evento sin celdas medidas es informacion; solo se calla si todas sus celdas conocidas son negativas. */
export function notifiable(e: Pick<ScannerEvent, 'cells'>): boolean {
  const cells = [e.cells.follow, e.cells.fade].filter((c): c is StatsCell => c !== null);
  return cells.length === 0 || cells.some((c) => c.grade !== 'negative');
}

export interface GateResult {
  notify: ScannerEvent[];
  /** "+N más" cuando se supero el tope; a lo sumo uno por hora. */
  summary: string | null;
  suppressed: { quiet: number; negative: number; cap: number };
}

export class NotificationGate {
  private sent: number[] = [];
  private summaryAt: number | null = null;

  constructor(
    private opts: { maxPerHour?: number; quietHours?: QuietWindow } = {},
  ) {}

  setOptions(opts: { maxPerHour?: number; quietHours?: QuietWindow }): void {
    this.opts = { ...this.opts, ...opts };
  }

  /** Decide que avisar de las filas de UN ciclo. La lista nunca se filtra: esto solo gobierna avisos y sonido. */
  process(events: ReadonlyArray<ScannerEvent>, nowMs: number, muteCheck?: (e: ScannerEvent) => boolean): GateResult {
    const max = Math.max(1, this.opts.maxPerHour ?? DEFAULT_MAX_PER_HOUR);
    const res: GateResult = { notify: [], summary: null, suppressed: { quiet: 0, negative: 0, cap: 0 } };
    this.sent = this.sent.filter((t) => nowMs - t < HOUR_MS);
    if (this.summaryAt !== null && nowMs - this.summaryAt >= HOUR_MS) this.summaryAt = null;
    const quiet = this.opts.quietHours ? inQuietHours(this.opts.quietHours, new Date(nowMs)) : false;
    const eligible: ScannerEvent[] = [];
    for (const e of events) {
      if (!notifiable(e) || muteCheck?.(e)) res.suppressed.negative++;
      else if (quiet) res.suppressed.quiet++;
      else eligible.push(e);
    }
    const room = Math.max(0, max - this.sent.length);
    res.notify = eligible.slice(0, room);
    for (let i = 0; i < res.notify.length; i++) this.sent.push(nowMs);
    const over = eligible.length - res.notify.length;
    res.suppressed.cap = over;
    if (over > 0 && this.summaryAt === null) {
      res.summary = `+${over} más`;
      this.summaryAt = nowMs;
    }
    return res;
  }
}
