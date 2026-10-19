// Mensajes de la lectura de página (fase 2): el content script manda lo que ya
// se ve en la página de Binance y el background lo guarda en local. Aquí no hay
// secretos, pero tampoco se confía en nada: cada fila se valida campo a campo y
// los topes son duros (50 posiciones, 500 filas por aviso, 2000 guardadas).

import type { HistoryMetrics } from './metrics';
import type { ClosedPosition } from './parse-history';
import type { PagePosition } from './parse-positions';
import { historyMetrics } from './metrics';
import type { MarginType, PositionSide } from '../account/types';

export const PAGE_ACCOUNT_UPDATE = 'page-account:update' as const;
export const PAGE_ACCOUNT_GET = 'page-account:get' as const;
export const PAGE_ACCOUNT_RESULT = 'page-account:result' as const;
export const PAGE_ACCOUNT_CLEAR = 'page-account:clear' as const;
export const PAGE_ACCOUNT_DIAGNOSE = 'page-account:diagnose' as const;
/** Background -> content script: pide el esquema anonimizado de la página. */
export const PAGE_ACCOUNT_DIAGNOSE_REQUEST = 'page-account:diagnose:request' as const;
export const PAGE_ACCOUNT_DIAGNOSE_RESULT = 'page-account:diagnose:result' as const;

/** Clave de `storage.session` con las posiciones abiertas de la página. */
export const PAGE_ACCOUNT_SESSION_KEY = 'pageAccount.positions';

/** Tope de posiciones abiertas por aviso. */
export const PAGE_POSITIONS_MAX = 50;
/** Tope de filas de historial por aviso. */
export const PAGE_HISTORY_MAX = 500;
/** Tope de filas de historial guardadas en total. */
export const PAGE_HISTORY_KEEP = 2000;
/** Tope de caracteres del diagnóstico copiable. */
export const PAGE_DIAGNOSE_MAX_CHARS = 80_000;

const SYMBOL_RE = /^[0-9A-Z]{2,20}$/;
const ASSET_RE = /^[A-Z0-9]{2,20}$/;
const KEY_RE = /^[0-9A-Za-z|._:-]{1,120}$/;
const MAX_TZ_MINUTES = 14 * 60;

export interface PageAccountUpdate {
  positions: PagePosition[];
  history: ClosedPosition[];
  tzOffsetMinutes: number;
  capturedAt: number;
}

export interface PageAccountResult {
  positions: PagePosition[];
  capturedAt: number | null;
  history: ClosedPosition[];
  metrics: HistoryMetrics;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const finitePositive = (value: unknown): number | null => {
  const n = finite(value);
  return n !== null && n > 0 ? n : null;
};

const finiteNonNegative = (value: unknown): number | null => {
  const n = finite(value);
  return n !== null && n >= 0 ? n : null;
};

const side = (value: unknown): PositionSide | null =>
  value === 'long' || value === 'short' ? value : null;

const marginMode = (value: unknown): MarginType | null =>
  value === 'cross' || value === 'isolated' ? value : null;

const symbol = (value: unknown): string | null =>
  typeof value === 'string' && SYMBOL_RE.test(value) ? value : null;

const asset = (value: unknown): string | null =>
  typeof value === 'string' && ASSET_RE.test(value) ? value : null;

/** `0 < leverage <= 125`, o null. */
const leverage = (value: unknown): number | null => {
  const n = finite(value);
  return n !== null && n > 0 && n <= 125 ? n : null;
};

function parseSizeQuote(value: unknown): PagePosition['sizeQuote'] {
  if (!isRecord(value)) return null;
  const amount = finite(value.value);
  const currency = asset(value.asset);
  if (amount === null || currency === null) return null;
  return { value: amount, asset: currency };
}

/** Una posición abierta de la tabla. Null si no pasa el filtro. */
export function parsePagePosition(raw: unknown): PagePosition | null {
  if (!isRecord(raw)) return null;
  const symbolValue = symbol(raw.symbol);
  if (!symbolValue) return null;
  return {
    symbol: symbolValue,
    contract: raw.contract === 'perp' ? 'perp' : null,
    leverage: leverage(raw.leverage),
    marginMode: marginMode(raw.marginMode),
    side: side(raw.side),
    sizeQuote: parseSizeQuote(raw.sizeQuote),
    sizeBase: finite(raw.sizeBase),
    uPnl: finite(raw.uPnl),
    roiPct: finite(raw.roiPct),
    entry: finitePositive(raw.entry),
    breakEven: finitePositive(raw.breakEven),
    mark: finitePositive(raw.mark),
    liq: finitePositive(raw.liq),
  };
}

/** Una fila de historial. Null si no tiene ni símbolo ni clave estable. */
export function parseClosedPosition(raw: unknown): ClosedPosition | null {
  if (!isRecord(raw)) return null;
  const symbolValue = symbol(raw.symbol);
  if (!symbolValue) return null;
  const key = typeof raw.key === 'string' && KEY_RE.test(raw.key) ? raw.key : null;
  if (!key) return null;
  const status =
    raw.status === 'open' || raw.status === 'closed' ? raw.status : null;
  return {
    symbol: symbolValue,
    leverage: leverage(raw.leverage),
    marginMode: marginMode(raw.marginMode),
    side: side(raw.side),
    status,
    openedAtMs: finiteNonNegative(raw.openedAtMs),
    closedAtMs: finiteNonNegative(raw.closedAtMs),
    durationMs: finiteNonNegative(raw.durationMs),
    realizedPnl: finite(raw.realizedPnl),
    pnlAsset: asset(raw.pnlAsset),
    roiPct: finite(raw.roiPct),
    closeVolume: finiteNonNegative(raw.closeVolume),
    closeVolumeAsset: asset(raw.closeVolumeAsset),
    entry: finitePositive(raw.entry),
    avgClose: finitePositive(raw.avgClose),
    maxOpenInterest: finiteNonNegative(raw.maxOpenInterest),
    key,
  };
}

/** Offset de la página en minutos (`Date#getTimezoneOffset`), acotado a ±14 h. */
export function parseTzOffsetMinutes(value: unknown): number | null {
  const n = finite(value);
  if (n === null || !Number.isInteger(n) || Math.abs(n) > MAX_TZ_MINUTES) return null;
  return n;
}

function dedupe<T>(rows: T[], key: (row: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const id = key(row);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

/**
 * Aviso del content script. Valida el sobre y las filas, aplica los topes y
 * descarta duplicados. Null si el mensaje no sirve.
 */
export function parsePageAccountUpdate(raw: unknown): PageAccountUpdate | null {
  if (!isRecord(raw) || raw.type !== PAGE_ACCOUNT_UPDATE) return null;
  if (!Array.isArray(raw.positions) || !Array.isArray(raw.history)) return null;
  const capturedAt = finitePositive(raw.capturedAt);
  const tzOffsetMinutes = parseTzOffsetMinutes(raw.tzOffsetMinutes ?? 0);
  if (capturedAt === null || tzOffsetMinutes === null) return null;
  // Un aviso del futuro no se cree: la página no puede haber leído más tarde que ahora.
  if (capturedAt > Date.now() + 60_000) return null;

  const positions = dedupe(
    raw.positions
      .slice(0, PAGE_POSITIONS_MAX)
      .map(parsePagePosition)
      .filter((row): row is PagePosition => row !== null),
    (row) => `${row.symbol}|${row.side ?? ''}|${row.sizeBase ?? row.sizeQuote?.value ?? ''}`,
  ).slice(0, PAGE_POSITIONS_MAX);

  const history = dedupe(
    raw.history
      .slice(0, PAGE_HISTORY_MAX)
      .map(parseClosedPosition)
      .filter((row): row is ClosedPosition => row !== null),
    (row) => row.key,
  ).slice(0, PAGE_HISTORY_MAX);

  return { positions, history, tzOffsetMinutes, capturedAt };
}

export interface StoredPagePositions {
  positions: PagePosition[];
  capturedAt: number;
  tzOffsetMinutes: number;
}

/** Lo que el background deja en `storage.session` (sin historial). */
export function parseStoredPagePositions(raw: unknown): StoredPagePositions | null {
  if (!isRecord(raw)) return null;
  if (!Array.isArray(raw.positions)) return null;
  const capturedAt = finitePositive(raw.capturedAt);
  const tzOffsetMinutes = parseTzOffsetMinutes(raw.tzOffsetMinutes ?? 0);
  if (capturedAt === null || tzOffsetMinutes === null) return null;
  const positions = dedupe(
    raw.positions
      .slice(0, PAGE_POSITIONS_MAX)
      .map(parsePagePosition)
      .filter((row): row is PagePosition => row !== null),
    (row) => `${row.symbol}|${row.side ?? ''}|${row.sizeBase ?? row.sizeQuote?.value ?? ''}`,
  );
  return { positions, capturedAt, tzOffsetMinutes };
}

/** Respuesta del background a `page-account:get`. */
export function parsePageAccountResult(raw: unknown): PageAccountResult | null {
  if (!isRecord(raw) || raw.type !== PAGE_ACCOUNT_RESULT) return null;
  if (!Array.isArray(raw.positions) || !Array.isArray(raw.history)) return null;
  const positions = raw.positions
    .slice(0, PAGE_POSITIONS_MAX)
    .map(parsePagePosition)
    .filter((row): row is PagePosition => row !== null);
  const history = raw.history
    .slice(0, PAGE_HISTORY_KEEP)
    .map(parseClosedPosition)
    .filter((row): row is ClosedPosition => row !== null);
  const captured = finitePositive(raw.capturedAt);
  return {
    positions,
    capturedAt: captured,
    history,
    // Las métricas se recalculan aquí: el background no manda números de confianza.
    metrics: historyMetrics(history),
  };
}

/** Respuesta del content script con el esquema anonimizado. */
export function parsePageAccountDiagnoseResult(raw: unknown): string | null {
  if (!isRecord(raw) || raw.type !== PAGE_ACCOUNT_DIAGNOSE_RESULT) return null;
  if (typeof raw.outline !== 'string') return null;
  return raw.outline.slice(0, PAGE_DIAGNOSE_MAX_CHARS);
}

export type PageAccountMessage =
  | { type: typeof PAGE_ACCOUNT_UPDATE; update: PageAccountUpdate }
  | { type: typeof PAGE_ACCOUNT_GET }
  | { type: typeof PAGE_ACCOUNT_CLEAR }
  | { type: typeof PAGE_ACCOUNT_DIAGNOSE };

/** Clasifica lo que llega por `runtime.onMessage` para esta función. */
export function parsePageAccountMessage(raw: unknown): PageAccountMessage | null {
  if (!isRecord(raw)) return null;
  if (raw.type === PAGE_ACCOUNT_GET) return { type: PAGE_ACCOUNT_GET };
  if (raw.type === PAGE_ACCOUNT_CLEAR) return { type: PAGE_ACCOUNT_CLEAR };
  if (raw.type === PAGE_ACCOUNT_DIAGNOSE) return { type: PAGE_ACCOUNT_DIAGNOSE };
  if (raw.type === PAGE_ACCOUNT_UPDATE) {
    const update = parsePageAccountUpdate(raw);
    return update ? { type: PAGE_ACCOUNT_UPDATE, update } : null;
  }
  return null;
}
