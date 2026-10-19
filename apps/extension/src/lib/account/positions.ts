import type { MarginType, PositionStop, PositionView } from './types';

/** Convierte a número finito; rechaza NaN, Infinity, vacío y no numéricos. */
export function safeNum(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const isTrue = (value: unknown): boolean => value === true || String(value).toLowerCase() === 'true';

interface StopCandidate {
  symbol: string;
  side: string;
  positionSide: string;
  price: number;
  kind: 'algo' | 'order';
}

function toCandidate(raw: unknown, kind: 'algo' | 'order'): StopCandidate | null {
  if (!isRow(raw)) return null;
  const type = String(raw.orderType ?? raw.algoType ?? raw.type ?? '');
  if (type !== 'STOP' && type !== 'STOP_MARKET') return null;
  if (!isTrue(raw.closePosition) && !isTrue(raw.reduceOnly)) return null;
  const price = safeNum(raw.triggerPrice) ?? safeNum(raw.stopPrice);
  if (price === null || price <= 0) return null;
  if (typeof raw.symbol !== 'string' || typeof raw.side !== 'string') return null;
  return {
    symbol: raw.symbol,
    side: raw.side.toUpperCase(),
    positionSide: String(raw.positionSide ?? 'BOTH').toUpperCase(),
    price,
    kind,
  };
}

function findStop(
  candidates: readonly StopCandidate[],
  symbol: string,
  side: 'long' | 'short',
  hedgeSide: string,
  entry: number,
): PositionStop | null {
  let best: PositionStop | null = null;
  for (const c of candidates) {
    if (c.symbol !== symbol || c.side !== (side === 'long' ? 'SELL' : 'BUY')) continue;
    if (hedgeSide !== 'BOTH' && c.positionSide !== 'BOTH' && c.positionSide !== hedgeSide) continue;
    const lossSide = side === 'long' ? c.price < entry : c.price > entry;
    if (!lossSide) continue;
    if (best === null || Math.abs(entry - c.price) < Math.abs(entry - best.price)) {
      best = { price: c.price, kind: c.kind };
    }
  }
  return best;
}

export function parsePositions(
  positionRisk: unknown[],
  openOrders: unknown[],
  openAlgoOrders: unknown[],
): PositionView[] {
  const candidates: StopCandidate[] = [];
  for (const raw of Array.isArray(openOrders) ? openOrders : []) {
    const c = toCandidate(raw, 'order');
    if (c) candidates.push(c);
  }
  for (const raw of Array.isArray(openAlgoOrders) ? openAlgoOrders : []) {
    const c = toCandidate(raw, 'algo');
    if (c) candidates.push(c);
  }

  const out: PositionView[] = [];
  for (const raw of Array.isArray(positionRisk) ? positionRisk : []) {
    try {
      if (!isRow(raw) || typeof raw.symbol !== 'string' || raw.symbol === '') continue;
      const amt = safeNum(raw.positionAmt);
      if (amt === null || amt === 0) continue;
      const entry = safeNum(raw.entryPrice);
      const mark = safeNum(raw.markPrice);
      if (entry === null || entry <= 0 || mark === null || mark <= 0) continue;

      const hedgeSide = String(raw.positionSide ?? 'BOTH').toUpperCase();
      const side: 'long' | 'short' =
        hedgeSide === 'LONG' ? 'long' : hedgeSide === 'SHORT' ? 'short' : amt > 0 ? 'long' : 'short';
      const size = Math.abs(amt);

      const liqRaw = safeNum(raw.liquidationPrice);
      const be = safeNum(raw.breakEvenPrice);
      const lev = safeNum(raw.leverage);
      const marginType: MarginType = String(raw.marginType ?? '').toLowerCase() === 'isolated' ? 'isolated' : 'cross';
      const uPnl = safeNum(raw.unRealizedProfit) ?? (side === 'long' ? mark - entry : entry - mark) * size;
      const notionalRaw = safeNum(raw.notional);

      out.push({
        symbol: raw.symbol,
        side,
        size,
        entry,
        mark,
        liq: liqRaw !== null && liqRaw > 0 ? liqRaw : null,
        leverage: lev !== null && lev > 0 ? lev : 1,
        marginType,
        uPnl,
        breakEven: be !== null && be > 0 ? be : null,
        notional: notionalRaw !== null ? Math.abs(notionalRaw) : size * mark,
        stop: findStop(candidates, raw.symbol, side, hedgeSide, entry),
        firstFillMs: null,
      });
    } catch {
      continue;
    }
  }
  return out;
}
