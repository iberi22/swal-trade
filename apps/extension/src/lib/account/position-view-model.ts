import { shortPrice } from '../findings-view';
import type { RulesSettings } from '../settings';
import type { Candle } from '../types';
import { liqDistancePct } from './panel-controller';
import type { RuleInput, RuleResult } from './rules';
import type { AccountSnapshot, PositionView } from './types';

/** ATR de Wilder; null con menos de `period + 1` velas o datos no finitos. */
export function atrFromCandles(candles: readonly Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    if (!Number.isFinite(tr)) return null;
    trs.push(tr);
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]!) / period;
  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

/** R actual con el stop actual: (marca - entrada) / |entrada - stop|, con signo de la posición. */
export function currentR(position: PositionView): number | null {
  if (!position.stop) return null;
  const risk = Math.abs(position.entry - position.stop.price);
  if (!(risk > 0) || !Number.isFinite(risk)) return null;
  const s = position.side === 'long' ? 1 : -1;
  const r = (s * (position.mark - position.entry)) / risk;
  return Number.isFinite(r) ? r : null;
}

/** Distancia de la marca al stop en % de la marca; null sin stop. */
export function stopDistancePct(position: PositionView): number | null {
  if (!position.stop || !(position.mark > 0)) return null;
  return (Math.abs(position.mark - position.stop.price) / position.mark) * 100;
}

// --- Stop inicial recordado durante la sesión ----------------------------

/** Almacén inyectado (el componente lo conecta a `storage.session`). */
export interface InitialStopStore {
  get(key: string): Promise<number | null>;
  set(key: string, price: number): Promise<void>;
}

export function initialStopKey(position: PositionView, salt = ''): string {
  return `initialStop:${position.symbol}:${position.side}:${position.firstFillMs ?? 'na'}${salt ? `:${salt}` : ''}`;
}

/**
 * Devuelve el primer stop observado de esta posición. Si aún no se guardó uno y
 * la posición ya tiene stop, lo guarda. Sin stop y sin registro: null.
 */
export async function rememberInitialStop(
  store: InitialStopStore,
  position: PositionView,
  salt = '',
): Promise<number | null> {
  const key = initialStopKey(position, salt);
  try {
    const known = await store.get(key);
    if (known !== null && Number.isFinite(known) && known > 0) return known;
    if (position.stop) {
      await store.set(key, position.stop.price);
      return position.stop.price;
    }
  } catch {
    // sin almacén: la regla STOP_WIDENED simplemente no se evalúa
  }
  return null;
}

// --- Entradas de reglas ---------------------------------------------------

export interface RuleInputParts {
  position: PositionView;
  snapshot: AccountSnapshot;
  candles: readonly Candle[];
  rules: RulesSettings;
  initialStopPrice: number | null;
  now: number;
}

export function buildRuleInput(parts: RuleInputParts): RuleInput {
  return {
    position: parts.position,
    snapshot: parts.snapshot,
    atr: atrFromCandles(parts.candles),
    rules: parts.rules,
    initialStopPrice: parts.initialStopPrice,
    now: parts.now,
  };
}

// --- Texto ----------------------------------------------------------------

const MAX_LINE = 90;
const PREFIX = { critical: '!!', warn: '!', info: 'i' } as const;

/** Línea de una regla: la gravedad va en el prefijo, no en el color. */
export function ruleLine(rule: Pick<RuleResult, 'sev' | 'text'>): string {
  const line = `${PREFIX[rule.sev]} ${rule.text}`;
  return line.length <= MAX_LINE ? line : line.slice(0, MAX_LINE - 1) + '.';
}

/** Las `n` primeras (ya vienen ordenadas por gravedad) y el total. */
export function topRules(results: readonly RuleResult[], n = 3): { top: RuleResult[]; rest: RuleResult[] } {
  return { top: results.slice(0, n), rest: results.slice(n) };
}

function num(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '—';
  const fixed = value.toFixed(digits);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

export function fundingCountdown(nextFundingMs: number, now: number): string {
  const ms = nextFundingMs - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'ahora';
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export interface PositionCardView {
  lines: string[];
  /** Línea de stop sin stop: se pinta en negrita. */
  noStop: boolean;
}

/** Tarjeta de posición: 6 líneas como máximo. */
export function positionCardView(
  position: PositionView,
  snapshot: AccountSnapshot | null,
  now: number,
  opts: { stale?: boolean; manual?: boolean } = {},
): PositionCardView {
  const side = position.side === 'long' ? 'LARGO' : 'CORTO';
  const margin = position.marginType === 'isolated' ? 'aislado' : 'cruzado';
  let header = `${side} · ${num(position.size, 6)} ${position.symbol} · ${num(position.leverage, 0)}x · ${margin}`;
  if (opts.manual) header += ' · MANUAL';
  if (opts.stale) header += ' · CADUCADO';

  const r = currentR(position);
  const pnl = `${position.uPnl > 0 ? '+' : ''}${num(position.uPnl, 2)}`;
  const rText = r === null ? 'R —' : `${r > 0 ? '+' : ''}${num(r, 2)}R`;
  const lines = [header, `${shortPrice(position.entry)} → ${shortPrice(position.mark)} · uPnL ${pnl} USD · ${rText}`];

  const sd = stopDistancePct(position);
  lines.push(sd === null ? 'SIN STOP' : `Stop a ${num(sd, 2)} % (${shortPrice(position.stop!.price)})`);

  const ld = liqDistancePct(position);
  lines.push(ld === null ? 'Liquidación: sin dato' : `Liquidación a ${num(ld, 1)} % (${shortPrice(position.liq)})`);

  if (snapshot && snapshot.fundingRate !== null && Number.isFinite(snapshot.fundingRate)) {
    const eta = snapshot.nextFundingMs !== null ? ` · cobro en ${fundingCountdown(snapshot.nextFundingMs, now)}` : '';
    lines.push(`Funding ${snapshot.fundingRate > 0 ? '+' : ''}${num(snapshot.fundingRate * 100, 4)} %${eta}`);
  }
  return { lines: lines.slice(0, 6), noStop: sd === null };
}
