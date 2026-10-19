// Convierte las filas de Binance (numeros como texto) en Fill / IncomeRow para metrics.ts.
// Conserva el id del exchange (tranId / id): history.ts lo necesita para paginar y deduplicar.
// Funcion pura, sin red. Una fila rota se descarta y se cuenta, nunca lanza.

import { dedupeById, type IdRow } from './history';
import { buildRoundTrips, type RoundTrip } from './metrics';
import type { Fill, IncomeRow } from './types';

/** Fill + id del trade en el exchange. */
export type FillRow = Fill & { id: string };
/** IncomeRow + tranId del exchange. */
export type IncomeRowId = IncomeRow & { tranId: string };

/** Monedas que se cuentan como USD. Una comision en BNB no se convierte: se cuenta aparte. */
const STABLE = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD', 'USD']);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Numero desde un texto de Binance o un numero. null si no es finito. */
function numOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function idOf(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && /^[0-9]{1,20}$/.test(v)) return v;
  return null;
}

export interface ParsedFills {
  rows: FillRow[];
  skipped: number;
  /** Fills cuya comision esta en una moneda que no es USD: su comision cuenta 0. */
  nonStableFees: number;
}

export interface ParsedIncome {
  rows: IncomeRowId[];
  skipped: number;
}

export function parseUserTrades(raw: unknown): ParsedFills {
  const out: ParsedFills = { rows: [], skipped: 0, nonStableFees: 0 };
  for (const r of Array.isArray(raw) ? raw : []) {
    if (!isRecord(r)) {
      out.skipped++;
      continue;
    }
    const id = idOf(r.id);
    const price = numOf(r.price);
    const qty = numOf(r.qty);
    const time = numOf(r.time);
    const pnl = numOf(r.realizedPnl);
    const symbol = typeof r.symbol === 'string' && /^[A-Z0-9]{2,20}$/.test(r.symbol) ? r.symbol : null;
    const side = r.side === 'BUY' || r.side === 'SELL' ? r.side : null;
    if (id === null || price === null || qty === null || qty <= 0 || time === null || pnl === null || !symbol || !side) {
      out.skipped++;
      continue;
    }
    const commission = numOf(r.commission) ?? 0;
    const asset = typeof r.commissionAsset === 'string' ? r.commissionAsset.toUpperCase() : 'USDT';
    const stable = STABLE.has(asset);
    if (!stable && commission !== 0) out.nonStableFees++;
    out.rows.push({
      id,
      symbol,
      side,
      price,
      qty,
      fee: stable ? Math.abs(commission) : 0,
      realizedPnl: pnl,
      timeMs: time,
      orderId: idOf(r.orderId) ?? '',
    });
  }
  return out;
}

export function parseIncome(raw: unknown): ParsedIncome {
  const out: ParsedIncome = { rows: [], skipped: 0 };
  for (const r of Array.isArray(raw) ? raw : []) {
    if (!isRecord(r)) {
      out.skipped++;
      continue;
    }
    const tranId = idOf(r.tranId);
    const income = numOf(r.income);
    const time = numOf(r.time);
    const type = typeof r.incomeType === 'string' && /^[A-Z_]{2,40}$/.test(r.incomeType) ? r.incomeType : null;
    const asset = typeof r.asset === 'string' ? r.asset.toUpperCase() : '';
    if (tranId === null || income === null || time === null || !type || !STABLE.has(asset)) {
      out.skipped++;
      continue;
    }
    out.rows.push({
      tranId,
      symbol: typeof r.symbol === 'string' ? r.symbol : '',
      incomeType: type,
      income,
      asset,
      timeMs: time,
    });
  }
  return out;
}

/**
 * Filas crudas -> IdRow para `nextPage`. Se calcula sobre lo que Binance devolvio,
 * no sobre lo ya filtrado: una fila descartada no puede hacer pasar por corta una pagina llena.
 */
export function pagingRows(raw: unknown, key: 'tranId' | 'id'): IdRow[] {
  const out: IdRow[] = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    if (!isRecord(r)) {
      out.push({});
      continue;
    }
    const v = idOf(r[key]);
    const time = numOf(r.time);
    out.push({ [key]: v ?? undefined, ...(time !== null ? { timeMs: time } : {}) });
  }
  return out;
}

/** Deduplica por id del exchange y reconstruye los round trips. */
export function tripsFromHistory(fills: FillRow[], income: IncomeRowId[]): RoundTrip[] {
  return buildRoundTrips(dedupeById(fills, 'id'), dedupeById(income, 'tranId'));
}
