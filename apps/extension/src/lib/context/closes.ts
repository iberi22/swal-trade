/**
 * Próximos cierres y aperturas: matemática pura sobre UTC, sin red ni DOM.
 * Las rejillas de Binance (15m, 1h, 4h, diario, semanal, mensual) son UTC; la
 * hora local solo se usa para mostrar. Al llegar exactamente a un cierre, el
 * "próximo" ya es el siguiente (el estrictamente posterior a `nowMs`).
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export type CloseKind = 'close' | 'funding' | 'session';

export interface CloseItem {
  id: string;
  label: string;
  kind: CloseKind;
  atMs: number;
  remainingMs: number;
  /** Cierre diario, semanal o mensual. */
  major: boolean;
  /** Hora local del evento: "HH:MM", o "dd/mm HH:MM" si no es hoy. */
  clock: string;
}

export interface NextClosesOptions {
  /** `nextFundingTime` de Binance (ms). Se usa solo si es futuro y a menos de 8 h. */
  nextFundingTimeMs?: number | null;
}

const FUNDING_HOURS_UTC = [0, 8, 16];
const SESSIONS: ReadonlyArray<{ id: string; label: string; minutesUtc: number }> = [
  { id: 'open-asia', label: 'Apertura Asia', minutesUtc: 0 },
  { id: 'open-europa', label: 'Apertura Europa', minutesUtc: 7 * 60 },
  { id: 'open-eeuu', label: 'Apertura EE.UU.', minutesUtc: 13 * 60 + 30 },
];

/** Siguiente múltiplo de `stepMs` estrictamente posterior a `nowMs`. */
function nextGrid(nowMs: number, stepMs: number): number {
  return Math.floor(nowMs / stepMs) * stepMs + stepMs;
}

function dayStartUtc(nowMs: number): number {
  return Math.floor(nowMs / DAY) * DAY;
}

/** Siguiente instante con esa hora UTC del día, estrictamente posterior a `nowMs`. */
function nextDailyAt(nowMs: number, minutesUtc: number): number {
  const today = dayStartUtc(nowMs) + minutesUtc * MIN;
  return today > nowMs ? today : today + DAY;
}

function nextWeekClose(nowMs: number): number {
  const start = dayStartUtc(nowMs);
  const dow = new Date(start).getUTCDay(); // 0 = domingo
  const days = (1 - dow + 7) % 7 || 7;
  return start + days * DAY;
}

function nextMonthClose(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function nextFunding(nowMs: number, provided: number | null | undefined): number {
  if (
    typeof provided === 'number' &&
    Number.isFinite(provided) &&
    provided > nowMs &&
    provided - nowMs <= 8 * HOUR
  ) {
    return provided;
  }
  let best = Infinity;
  for (const hour of FUNDING_HOURS_UTC) best = Math.min(best, nextDailyAt(nowMs, hour * 60));
  return best;
}

const pad2 = (value: number) => String(value).padStart(2, '0');

/** Offset local en minutos al este de UTC (Madrid verano = 120). */
function defaultOffsetMinutes(nowMs: number): number {
  return -new Date(nowMs).getTimezoneOffset();
}

function clockLabel(atMs: number, nowMs: number, offsetMinutes: number): string {
  const local = new Date(atMs + offsetMinutes * MIN);
  const today = new Date(nowMs + offsetMinutes * MIN);
  const time = `${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}`;
  const sameDay =
    local.getUTCFullYear() === today.getUTCFullYear() &&
    local.getUTCMonth() === today.getUTCMonth() &&
    local.getUTCDate() === today.getUTCDate();
  return sameDay ? time : `${pad2(local.getUTCDate())}/${pad2(local.getUTCMonth() + 1)} ${time}`;
}

export function nextCloses(
  nowMs: number,
  timeZoneOffsetMinutes?: number,
  options: NextClosesOptions = {},
): CloseItem[] {
  if (!Number.isFinite(nowMs)) return [];
  const offset =
    typeof timeZoneOffsetMinutes === 'number' && Number.isFinite(timeZoneOffsetMinutes)
      ? timeZoneOffsetMinutes
      : defaultOffsetMinutes(nowMs);

  const raw: Array<{ id: string; label: string; kind: CloseKind; atMs: number; major: boolean }> = [
    { id: 'c15m', label: 'Vela 15m', kind: 'close', atMs: nextGrid(nowMs, 15 * MIN), major: false },
    { id: 'c1h', label: 'Cierre 1h', kind: 'close', atMs: nextGrid(nowMs, HOUR), major: false },
    { id: 'c4h', label: 'Cierre 4h', kind: 'close', atMs: nextGrid(nowMs, 4 * HOUR), major: false },
    { id: 'diario', label: 'Cierre diario', kind: 'close', atMs: nextGrid(nowMs, DAY), major: true },
    { id: 'semanal', label: 'Cierre semanal', kind: 'close', atMs: nextWeekClose(nowMs), major: true },
    { id: 'mensual', label: 'Cierre mensual', kind: 'close', atMs: nextMonthClose(nowMs), major: true },
    {
      id: 'funding',
      label: 'Funding',
      kind: 'funding',
      atMs: nextFunding(nowMs, options.nextFundingTimeMs),
      major: false,
    },
    ...SESSIONS.map((s) => ({
      id: s.id,
      label: s.label,
      kind: 'session' as const,
      atMs: nextDailyAt(nowMs, s.minutesUtc),
      major: false,
    })),
  ];

  return raw
    .map((item, order) => ({ item, order }))
    .sort((a, b) => a.item.atMs - b.item.atMs || a.order - b.order)
    .map(({ item }) => ({
      ...item,
      remainingMs: item.atMs - nowMs,
      clock: clockLabel(item.atMs, nowMs, offset),
    }));
}

/** "12 min", "1 h 05 min", "3 d 4 h". Menos de un minuto: "<1 min". */
export function formatRemaining(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalMin = Math.floor(ms / MIN);
  if (totalMin < 1) return '<1 min';
  if (totalMin < 60) return `${totalMin} min`;
  const totalHours = Math.floor(totalMin / 60);
  if (totalHours < 24) return `${totalHours} h ${pad2(totalMin % 60)} min`;
  return `${Math.floor(totalHours / 24)} d ${totalHours % 24} h`;
}

export const IMMINENT_MS = 15 * MIN;

/** Cierre de 1h o más (no la vela de 15m, ni funding, ni aperturas) a 15 min o menos. */
export function isImminent(item: Pick<CloseItem, 'id' | 'kind' | 'remainingMs'>): boolean {
  return item.kind === 'close' && item.id !== 'c15m' && item.remainingMs <= IMMINENT_MS;
}

/** Lo que cabe en la banda: cierres y funding (sin la vela de 15m ni las aperturas). */
export function bandCloses(items: readonly CloseItem[], limit = 5): CloseItem[] {
  return items.filter((item) => item.kind !== 'session' && item.id !== 'c15m').slice(0, limit);
}
