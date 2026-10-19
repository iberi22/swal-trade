// Port a TypeScript de radar/movers.py (docs/design/SCANNER.md, 'Especificacion compartida').
// Funciones puras sobre velas cerradas, sin E/S. Mismas formulas y orden de operaciones que Python;
// los campos de datos conservan los nombres snake_case de la referencia (los goldens los usan asi).
import spec from './spec/movers-spec.json';

export const MARKET_SYMBOL = 'MARKET';

export type Spec = typeof spec;
export type Signal = { window_min: number; bar_minutes?: number; measured?: boolean };

export interface Bar {
  open_time_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quote_volume: number;
  taker_buy_volume: number;
}

export interface MoverEvent {
  symbol: string;
  signal: string;
  window_min: number;
  threshold: number;
  move: 'up' | 'down';
  ret: number;
  open_time_ms: number;
  close_time_ms: number;
  close: number;
  q24: number;
  tier: string;
  vol_ratio: number | null;
  taker_imb: number | null;
  atr14: number | null;
  breadth: number | null;
  market_wide: boolean;
  rel_btc: number | null;
}

export interface Plan {
  mode: 'follow' | 'fade';
  direction: 'long' | 'short';
  entry: number;
  stop: number;
  t1: number;
  t2: number;
  stop_dist: number;
}

export type Plans = { follow: Plan | null; fade: Plan | null };

/** Evento minimo que entiende CooldownTracker (los reales de detectEvents y los de mercado). */
export interface TrackedEvent {
  symbol: string;
  signal: string;
  move: string;
  threshold: number;
  window_min?: number;
  open_time_ms: number;
  close_time_ms: number;
  market_wide?: boolean;
  market?: boolean;
  count?: number;
  symbols?: string[];
  [k: string]: unknown;
}

export interface CooldownOut<E = TrackedEvent> {
  type: 'new' | 'update';
  event: E;
  prev_threshold: number | null;
}

export const SPEC: Spec = spec;

// ---------------------------------------------------------------- spec

function canon(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(canon);
  if (o && typeof o === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o as object).sort()) out[k] = canon((o as Record<string, unknown>)[k]);
    return out;
  }
  return o;
}

/** Texto canonico: claves ordenadas, sin espacios; los enteros no llevan decimal (igual que Python). */
export function canonicalJson(s: unknown = spec): string {
  return JSON.stringify(canon(s));
}

export async function specSha(s: unknown = spec): Promise<string> {
  const data = new TextEncoder().encode(canonicalJson(s));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- bars

/** Arreglos kline de Binance -> velas (indices 0,1,2,3,4,5,7,9). */
export function barsFromKlines(rows: ReadonlyArray<ReadonlyArray<string | number>>): Bar[] {
  return rows.map((r) => ({
    open_time_ms: Math.trunc(Number(r[0])),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
    quote_volume: Number(r[7]),
    taker_buy_volume: Number(r[9]),
  }));
}

function barMs(s: Spec): number {
  return s.bar_minutes * 60000;
}

export function indexOf(bars: ReadonlyArray<Bar>, openTimeMs: number): number | null {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].open_time_ms < openTimeMs) lo = mid + 1;
    else hi = mid;
  }
  return lo < bars.length && bars[lo].open_time_ms === openTimeMs ? lo : null;
}

// ---------------------------------------------------------------- metrics

export function retW(bars: ReadonlyArray<Bar>, i: number, W: number, barMsV = 300000): number | null {
  if (i - W < 0 || i >= bars.length) return null;
  for (let k = i - W + 1; k <= i; k++) {
    if (bars[k].open_time_ms - bars[k - 1].open_time_ms !== barMsV) return null;
  }
  return bars[i].close / bars[i - W].close - 1;
}

export function volTier(q24: number, s: Spec = spec): string {
  for (const t of s.vol_tiers) {
    if (q24 >= t.min_q24) return t.id;
  }
  return s.vol_tiers[s.vol_tiers.length - 1].id;
}

export function volRatio(bars: ReadonlyArray<Bar>, i: number, W: number, s: Spec = spec): number | null {
  const n = s.vol_baseline_bars;
  if (i - W - n + 1 < 0) return null;
  let recent = 0;
  for (let k = i - W + 1; k <= i; k++) recent += bars[k].quote_volume;
  let sumBase = 0;
  for (let k = i - W - n + 1; k <= i - W; k++) sumBase += bars[k].quote_volume;
  const base = sumBase / n;
  if (base <= 0) return null;
  return recent / (W * base);
}

export function takerImb(bars: ReadonlyArray<Bar>, i: number, W: number): number | null {
  if (i - W + 1 < 0) return null;
  let vol = 0;
  for (let k = i - W + 1; k <= i; k++) vol += bars[k].volume;
  if (vol <= 0) return null;
  let tb = 0;
  for (let k = i - W + 1; k <= i; k++) tb += bars[k].taker_buy_volume;
  return (2 * tb) / vol - 1;
}

/** Media simple de los ultimos `period` rangos verdaderos que terminan en la vela i. */
export function atr14(bars: ReadonlyArray<Bar>, i: number, period = 14): number | null {
  if (i - period < 0 || i >= bars.length) return null;
  let total = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const b = bars[k];
    const pc = bars[k - 1].close;
    total += Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  }
  return total / period;
}

/** Fraccion del universo (simbolos con ret valido) que se mueve igual con abs(ret) >= T/2 %. */
export function breadth(rets: Record<string, number | null>, sign: number, T: number): number | null {
  const valid = Object.values(rets).filter((r): r is number => r !== null);
  if (valid.length === 0) return null;
  let same = 0;
  for (const r of valid) {
    if (r > 0 === sign > 0 && r !== 0 && Math.abs(r) * 100 >= T / 2) same++;
  }
  return same / valid.length;
}

export function marketWide(b: number | null, s: Spec = spec): boolean {
  return b !== null && b >= s.market_wide_breadth;
}

export function relBtc(retSym: number | null, retBtc: number | null): number | null {
  if (retSym === null || retBtc === null) return null;
  return retSym - retBtc;
}

// ---------------------------------------------------------------- detection

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Eventos con disparo por flanco en la vela cuyo open time es `iTime`. Un evento por cruce y umbral. */
export function detectEvents(
  barsBySymbol: Record<string, ReadonlyArray<Bar>>,
  iTime: number,
  q24BySymbol: Record<string, number>,
  s: Spec = spec,
  btcSymbol = 'BTCUSDT',
): MoverEvent[] {
  const out: MoverEvent[] = [];
  const signals = s.signals as Record<string, Signal>;
  for (const sname of Object.keys(signals).sort(cmpStr)) {
    const sig = signals[sname];
    if ((sig.bar_minutes ?? s.bar_minutes) !== s.bar_minutes) continue;
    const W = Math.floor(sig.window_min / s.bar_minutes);
    const bms = barMs(s);
    const idx: Record<string, number> = {};
    const rets: Record<string, number | null> = {};
    const prevs: Record<string, number | null> = {};
    for (const sym of Object.keys(barsBySymbol)) {
      const bars = barsBySymbol[sym];
      const i = indexOf(bars, iTime);
      if (i === null) continue;
      idx[sym] = i;
      rets[sym] = retW(bars, i, W, bms);
      prevs[sym] = i >= 1 ? retW(bars, i - 1, W, bms) : null;
    }
    for (const sym of Object.keys(idx).sort(cmpStr)) {
      const r = rets[sym];
      const rp = prevs[sym];
      if (r === null || rp === null) continue;
      const i = idx[sym];
      const bars = barsBySymbol[sym];
      const sign = r > 0 ? 1 : -1;
      const q24 = Number(q24BySymbol[sym] ?? 0);
      for (const T of s.thresholds_pct) {
        if (!(Math.abs(r) * 100 >= T && Math.abs(rp) * 100 < T)) continue;
        const br = breadth(rets, sign, T);
        out.push({
          symbol: sym,
          signal: sname,
          window_min: sig.window_min,
          threshold: T,
          move: sign > 0 ? 'up' : 'down',
          ret: r,
          open_time_ms: bars[i].open_time_ms,
          close_time_ms: bars[i].open_time_ms + bms,
          close: bars[i].close,
          q24,
          tier: volTier(q24, s),
          vol_ratio: volRatio(bars, i, W, s),
          taker_imb: takerImb(bars, i, W),
          atr14: atr14(bars, i, s.atr_period),
          breadth: br,
          market_wide: marketWide(br, s),
          rel_btc: relBtc(r, rets[btcSymbol] ?? null),
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- plans and alerts

/** {follow, fade}. Un plan es null si falta atr o el stop supera max_stop_frac de la entrada. */
export function plansForEvent(
  event: { ret: number; close: number; atr14?: number | null },
  s: Spec = spec,
): Plans {
  const atr = event.atr14;
  const moveSign = event.ret > 0 ? 1 : -1;
  const plans: Plans = { follow: null, fade: null };
  const modes: Array<['follow' | 'fade', number]> = [
    ['follow', moveSign],
    ['fade', -moveSign],
  ];
  for (const [mode, d] of modes) {
    if (!atr || atr <= 0) {
      plans[mode] = null;
      continue;
    }
    const entry = event.close + d * s.entry_atr * atr;
    const st = Math.max(s.stop_atr * atr, s.min_stop_frac * entry);
    if (st / entry > s.max_stop_frac) {
      plans[mode] = null;
      continue;
    }
    plans[mode] = {
      mode,
      direction: d > 0 ? 'long' : 'short',
      entry,
      stop: entry - d * st,
      t1: entry + d * st,
      t2: entry + 2 * d * st,
      stop_dist: st,
    };
  }
  return plans;
}

/** x con 1 decimal y coma, redondeo como Python (empate exacto -> par). */
function es(x: number): string {
  let str = x.toFixed(1);
  const q = x * 4; // un empate exacto en 1 decimal solo es representable si x = impar/4
  if (Number.isInteger(q) && Math.abs(q) % 2 === 1) {
    const m = Math.floor(x * 10);
    str = ((m % 2 === 0 ? m : m + 1) / 10).toFixed(1);
  }
  return str.replace('.', ',');
}

export interface AlertDict {
  source: 'movers';
  symbol: string;
  tf: string;
  kind: string;
  title: string;
  direction: 'long' | 'short';
  entry: number;
  stop: number;
  target_1r: number;
  target_2r: number;
  strength: number;
  status: 'pending';
  dedupe_key: string;
  created_at: number;
}

/** Alerta del radar. strength es un 0.5 fijo: NO es un puntaje ni una probabilidad. */
export function alertDict(
  symbol: string,
  event: Pick<MoverEvent, 'move' | 'window_min' | 'threshold' | 'tier' | 'ret' | 'signal' | 'close_time_ms'>,
  plan: Plan,
  s: Spec = spec,
): AlertDict {
  const up = event.move === 'up';
  const win = event.window_min;
  const T = event.threshold;
  const mode = plan.mode;
  const verb = up ? 'Sube' : 'Baja';
  const how = mode === 'follow' ? 'seguir el movimiento' : 'ir contra el movimiento';
  return {
    source: 'movers',
    symbol,
    tf: s.tf_label,
    kind: `mv_${mode}_${win}m_t${T}_${event.tier}`,
    title: `${verb} ${es(Math.abs(event.ret) * 100)} % en ${win} min (${how})`,
    direction: plan.direction,
    entry: plan.entry,
    stop: plan.stop,
    target_1r: plan.t1,
    target_2r: plan.t2,
    strength: 0.5,
    status: 'pending',
    dedupe_key: `mv:${symbol}:${event.signal}:${T}:${event.move}:${mode}`,
    created_at: event.close_time_ms / 1000.0,
  };
}

// ---------------------------------------------------------------- cooldown

function cmpKey(a: string[], b: string[]): number {
  for (let n = 0; n < a.length; n++) {
    const c = cmpStr(a[n], b[n]);
    if (c !== 0) return c;
  }
  return 0;
}

/**
 * Cooldown por (symbol, signal, move) y colapso de rafagas de mercado.
 * process(events) recibe los eventos de UNA vela y devuelve [{type:'new'|'update', event, prev_threshold}].
 */
export class CooldownTracker {
  private state = new Map<string, { t0: number; max_t: number }>();

  constructor(private spec: Spec = SPEC) {}

  private apply(key: string[], ev: TrackedEvent, out: CooldownOut[]): void {
    const k = key.join('\u0000');
    const t = ev.close_time_ms;
    const st = this.state.get(k);
    if (st !== undefined && t - st.t0 < this.spec.cooldown_min * 60000) {
      if (ev.threshold > st.max_t) {
        out.push({ type: 'update', event: ev, prev_threshold: st.max_t });
        st.max_t = ev.threshold;
      }
      return;
    }
    this.state.set(k, { t0: t, max_t: ev.threshold });
    out.push({ type: 'new', event: ev, prev_threshold: null });
  }

  process(eventsIn: ReadonlyArray<TrackedEvent>): CooldownOut[] {
    const events = [...eventsIn];
    const mw = events.filter((e) => e.market_wide);
    let rest = events;
    const collapsed: TrackedEvent[] = [];
    if (mw.length > this.spec.max_events_per_bar) {
      rest = events.filter((e) => !e.market_wide);
      const groups = new Map<string, { key: string[]; g: TrackedEvent[] }>();
      for (const e of mw) {
        const gk = e.signal + '\u0000' + e.move;
        let grp = groups.get(gk);
        if (!grp) {
          grp = { key: [e.signal, e.move], g: [] };
          groups.set(gk, grp);
        }
        grp.g.push(e);
      }
      for (const { key, g } of [...groups.values()].sort((a, b) => cmpKey(a.key, b.key))) {
        let top = g[0];
        for (const e of g) {
          if (e.threshold > top.threshold || (e.threshold === top.threshold && e.symbol > top.symbol)) top = e;
        }
        collapsed.push({
          symbol: MARKET_SYMBOL,
          signal: key[0],
          move: key[1],
          market: true,
          threshold: top.threshold,
          window_min: top.window_min,
          open_time_ms: top.open_time_ms,
          close_time_ms: top.close_time_ms,
          count: g.length,
          symbols: [...new Set(g.map((e) => e.symbol))].sort(cmpStr),
          market_wide: true,
        });
      }
    }
    const best = new Map<string, { key: string[]; ev: TrackedEvent }>();
    for (const e of rest) {
      const key = [e.symbol, e.signal, e.move];
      const k = key.join('\u0000');
      const cur = best.get(k);
      if (!cur || e.threshold > cur.ev.threshold) best.set(k, { key, ev: e });
    }
    const out: CooldownOut[] = [];
    for (const { key, ev } of [...best.values()].sort((a, b) => cmpKey(a.key, b.key))) this.apply(key, ev, out);
    for (const e of collapsed) this.apply([e.symbol, e.signal, e.move], e, out);
    return out;
  }
}
