// Pure pagination planner for account history. It never fetches: the side panel
// runs one job per message through the signed client and feeds the rows back here.
import type { IncomeRow } from './types';

export const DAY_MS = 86_400_000;
export const WINDOW_MS = 7 * DAY_MS;
export const MAX_HORIZON_DAYS = 180;
export const PAGE_LIMIT = 1000;
export const WEIGHT_PER_MIN = 1000;
export const INCOME_WEIGHT = 30;
export const TRADES_WEIGHT = 5;

export type JobPath = '/fapi/v1/income' | '/fapi/v1/userTrades';

export interface JobParams {
  symbol?: string;
  startTime: number;
  endTime: number;
  limit: 1000;
  incomeType?: string;
  fromId?: number;
}

export interface Job {
  path: JobPath;
  params: JobParams;
}

/** Rows as the panel receives them: IncomeRow/Fill plus the exchange id, which types.ts does not carry. */
export type IdRow = { tranId?: number | string; id?: number | string; timeMs?: number; symbol?: string; incomeType?: string };

/**
 * Splits [fromMs, toMs] into windows of at most 7 days with no gaps or overlaps:
 * each endTime is inclusive on the API, so the next window starts at endTime + 1.
 * The last window ends exactly at toMs.
 */
function windows(fromMs: number, toMs: number, now = toMs): Array<[number, number]> {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return [];
  const floor = now - MAX_HORIZON_DAYS * DAY_MS;
  let start = Math.max(Math.floor(fromMs), floor);
  const end = Math.floor(toMs);
  const out: Array<[number, number]> = [];
  while (start <= end) {
    const exclusiveEnd = start + WINDOW_MS;
    if (exclusiveEnd > end) {
      out.push([start, end]);
      break;
    }
    out.push([start, exclusiveEnd - 1]);
    start = exclusiveEnd;
  }
  return out;
}

export function planIncomeJobs(args: { fromMs: number; toMs: number }): Job[] {
  return windows(args.fromMs, args.toMs).map(([startTime, endTime]) => ({
    path: '/fapi/v1/income' as const,
    params: { startTime, endTime, limit: PAGE_LIMIT },
  }));
}

const SYMBOL_RE = /^[A-Z0-9]{2,20}$/;

export function planTradeJobs(args: { symbols: string[]; fromMs: number; toMs: number }): Job[] {
  const symbols = [...new Set(args.symbols.map((s) => String(s).toUpperCase()).filter((s) => SYMBOL_RE.test(s)))].sort();
  const wins = windows(args.fromMs, args.toMs);
  const jobs: Job[] = [];
  for (const symbol of symbols) {
    for (const [startTime, endTime] of wins) {
      jobs.push({ path: '/fapi/v1/userTrades', params: { symbol, startTime, endTime, limit: PAGE_LIMIT } });
    }
  }
  return jobs;
}

const SYMBOL_INCOME_TYPES = new Set(['REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE']);

export function symbolsFromIncome(rows: Pick<IncomeRow, 'symbol' | 'incomeType'>[]): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    if (!SYMBOL_INCOME_TYPES.has(r.incomeType)) continue;
    const s = typeof r.symbol === 'string' ? r.symbol.toUpperCase() : '';
    if (SYMBOL_RE.test(s)) set.add(s);
  }
  return [...set].sort();
}

function idOf(row: IdRow, key: 'tranId' | 'id'): number | null {
  const v = row[key];
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export type NextPage = Job | 'done' | { error: 'incomplete' };

/**
 * A short page proves completeness. A full page continues with fromId = last id + 1
 * (same window); a full page without a usable id is reported, never truncated silently.
 */
export function nextPage(job: Job, rows: IdRow[]): NextPage {
  if (rows.length < PAGE_LIMIT) return 'done';
  if (rows.length > PAGE_LIMIT) return { error: 'incomplete' };
  const key = job.path === '/fapi/v1/income' ? 'tranId' : 'id';
  const lastRow = rows[rows.length - 1];
  const last = lastRow ? idOf(lastRow, key) : null;
  if (last === null) return { error: 'incomplete' };
  const fromId = last + 1;
  if (job.params.fromId !== undefined && fromId <= job.params.fromId) return { error: 'incomplete' };
  return { path: job.path, params: { ...job.params, fromId } };
}

export function dedupeById<T extends IdRow>(rows: T[], idKey: 'tranId' | 'id'): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const v = row[idKey];
    if (v === undefined || v === null || v === '') {
      out.push(row); // no id: cannot prove it is a duplicate, keep it
      continue;
    }
    const k = String(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  return out;
}

export function weightOf(path: JobPath): number {
  return path === '/fapi/v1/income' ? INCOME_WEIGHT : TRADES_WEIGHT;
}

/** Minimum weight of the planned jobs (one request each; follow-up pages are extra). */
export function weightBudget(jobs: Job[]): number {
  return jobs.reduce((sum, j) => sum + weightOf(j.path), 0);
}

/** Minimum gap between requests so the total stays at or below 1000 weight/min. */
export function minGapMs(weightPerRequest: number): number {
  return Math.ceil((weightPerRequest * 60_000) / WEIGHT_PER_MIN);
}

export interface HistoryCheckpoint {
  jobs: Job[];
  index: number;
  collected: { rows: number; pages: number };
}

export function newCheckpoint(jobs: Job[]): HistoryCheckpoint {
  return { jobs, index: 0, collected: { rows: 0, pages: 0 } };
}

export function isFinished(cp: HistoryCheckpoint): boolean {
  return cp.index >= cp.jobs.length;
}

export function currentJob(cp: HistoryCheckpoint): Job | null {
  return cp.jobs[cp.index] ?? null;
}

/**
 * Records one finished page. `next` is the result of nextPage: a Job is inserted
 * right after the current one (so the window continues), 'done' just moves on.
 * An incomplete result must be handled by the caller and is not advanced.
 */
export function advance(cp: HistoryCheckpoint, rowCount: number, next: Job | 'done'): HistoryCheckpoint {
  const jobs = next === 'done' ? cp.jobs : [...cp.jobs.slice(0, cp.index + 1), next, ...cp.jobs.slice(cp.index + 1)];
  return {
    jobs,
    index: cp.index + 1,
    collected: { rows: cp.collected.rows + rowCount, pages: cp.collected.pages + 1 },
  };
}
