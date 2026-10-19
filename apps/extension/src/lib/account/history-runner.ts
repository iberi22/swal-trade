// Ejecuta el plan de history.ts: un job cada vez, respetando el gasto de peso de Binance,
// con punto de control persistente para reanudar al cerrar y reabrir el panel.
// Todo entra por dependencias (get, almacenamiento, sleep): sin red ni IndexedDB aqui.

import {
  advance,
  currentJob,
  dedupeById,
  isFinished,
  minGapMs,
  newCheckpoint,
  nextPage,
  planIncomeJobs,
  planTradeJobs,
  symbolsFromIncome,
  weightOf,
  type HistoryCheckpoint,
  type Job,
} from './history';
import {
  pagingRows,
  parseIncome,
  parseUserTrades,
  type FillRow,
  type IncomeRowId,
} from './history-parse';

export type RunnerPhase = 'income' | 'trades';

/** Todo lo que se guarda entre sesiones. */
export interface StoredHistory {
  v: 1;
  fromMs: number;
  toMs: number;
  phase: RunnerPhase;
  /** Jobs de la fase income (para sumar el total de la barra). */
  incomeJobs: number;
  checkpoint: HistoryCheckpoint;
  income: IncomeRowId[];
  fills: FillRow[];
  skipped: number;
  nonStableFees: number;
  done: boolean;
}

export interface HistoryStorage {
  load(): Promise<StoredHistory | null>;
  save(state: StoredHistory): Promise<void>;
  clear(): Promise<void>;
}

export interface GetReply {
  data?: unknown;
  error?: string;
}

export interface HistoryProgress {
  phase: RunnerPhase;
  done: number;
  total: number;
  rows: number;
}

export interface RunnerDeps {
  /** Envoltorio de `acct:get` del panel. */
  get(path: string, params: Record<string, string | number | undefined>): Promise<GetReply>;
  storage: HistoryStorage;
  sleep(ms: number): Promise<void>;
  onProgress?(progress: HistoryProgress): void;
  /** true => parar tras la pagina en curso (se guarda y se puede reanudar). */
  shouldStop?(): boolean;
}

export interface HistoryResult {
  complete: boolean;
  /** true si se paro antes de terminar (error o parada): los datos son parciales. */
  partial: boolean;
  /** ip_or_perm, clock, net, http_N, no_key, incomplete, bad_reply o aborted. */
  error?: string;
  income: IncomeRowId[];
  fills: FillRow[];
  skipped: number;
  nonStableFees: number;
  progress: HistoryProgress;
}

export function progressOf(state: StoredHistory): HistoryProgress {
  const cp = state.checkpoint;
  const base = state.phase === 'trades' ? state.incomeJobs : 0;
  return {
    phase: state.phase,
    done: Math.min(base + cp.index, base + cp.jobs.length),
    total: base + cp.jobs.length,
    rows: state.income.length + state.fills.length,
  };
}

function resultOf(state: StoredHistory, error?: string): HistoryResult {
  return {
    complete: state.done,
    partial: !state.done,
    ...(error ? { error } : {}),
    income: state.income,
    fills: state.fills,
    skipped: state.skipped,
    nonStableFees: state.nonStableFees,
    progress: progressOf(state),
  };
}

/** Un punto de control con forma valida; si no, se ignora y se empieza de cero. */
export function isStoredHistory(value: unknown): value is StoredHistory {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<StoredHistory>;
  const cp = s.checkpoint;
  return (
    s.v === 1 &&
    typeof s.fromMs === 'number' &&
    typeof s.toMs === 'number' &&
    (s.phase === 'income' || s.phase === 'trades') &&
    typeof s.incomeJobs === 'number' &&
    typeof s.done === 'boolean' &&
    Array.isArray(s.income) &&
    Array.isArray(s.fills) &&
    !!cp &&
    Array.isArray(cp.jobs) &&
    typeof cp.index === 'number'
  );
}

/**
 * La continuacion de una pagina llena se pide por tiempo: Binance no admite `fromId`
 * junto a startTime/endTime, e income no tiene `fromId`. Las filas repetidas en el
 * milisegundo de corte las quita dedupeById. Sin avance de tiempo, se declara incompleto.
 */
function continueByTime(job: Job, lastTimeMs: number | undefined): Job | null {
  if (lastTimeMs === undefined || !Number.isFinite(lastTimeMs)) return null;
  if (lastTimeMs <= job.params.startTime || lastTimeMs > job.params.endTime) return null;
  const { fromId: _drop, ...rest } = job.params;
  void _drop;
  return { path: job.path, params: { ...rest, startTime: lastTimeMs } };
}

export async function runHistory(
  args: { fromMs: number; toMs: number; resume: boolean },
  deps: RunnerDeps,
): Promise<HistoryResult> {
  let state: StoredHistory | null = null;
  if (args.resume) {
    const stored = await deps.storage.load().catch(() => null);
    if (isStoredHistory(stored)) state = stored;
  }
  if (state?.done) return resultOf(state);
  if (!state) {
    const jobs = planIncomeJobs({ fromMs: args.fromMs, toMs: args.toMs });
    state = {
      v: 1,
      fromMs: args.fromMs,
      toMs: args.toMs,
      phase: 'income',
      incomeJobs: jobs.length,
      checkpoint: newCheckpoint(jobs),
      income: [],
      fills: [],
      skipped: 0,
      nonStableFees: 0,
      done: false,
    };
    await deps.storage.save(state).catch(() => {});
  }
  deps.onProgress?.(progressOf(state));

  let requests = 0;
  for (;;) {
    while (!isFinished(state.checkpoint)) {
      if (deps.shouldStop?.()) return resultOf(state, 'aborted');
      const job = currentJob(state.checkpoint)!;
      if (requests > 0) await deps.sleep(minGapMs(weightOf(job.path)));
      requests++;

      const reply = await deps.get(job.path, job.params as unknown as Record<string, string | number | undefined>);
      if (reply.error) return resultOf(state, reply.error);
      if (!Array.isArray(reply.data)) return resultOf(state, 'bad_reply');

      const incomePage = job.path === '/fapi/v1/income';
      const paging = pagingRows(reply.data, incomePage ? 'tranId' : 'id');
      const next = nextPage(job, paging);
      let follow: Job | 'done';
      if (next === 'done') {
        follow = 'done';
      } else if ('error' in next) {
        return resultOf(state, next.error);
      } else {
        const cont = continueByTime(job, paging[paging.length - 1]?.timeMs);
        if (!cont) return resultOf(state, 'incomplete');
        follow = cont;
      }

      if (incomePage) {
        const parsed = parseIncome(reply.data);
        state.income = dedupeById([...state.income, ...parsed.rows], 'tranId');
        state.skipped += parsed.skipped;
      } else {
        const parsed = parseUserTrades(reply.data);
        state.fills = dedupeById([...state.fills, ...parsed.rows], 'id');
        state.skipped += parsed.skipped;
        state.nonStableFees += parsed.nonStableFees;
      }
      state.checkpoint = advance(state.checkpoint, reply.data.length, follow);
      await deps.storage.save(state).catch(() => {});
      deps.onProgress?.(progressOf(state));
    }

    if (state.phase === 'income') {
      const symbols = symbolsFromIncome(state.income);
      state.incomeJobs = state.checkpoint.jobs.length;
      state.phase = 'trades';
      state.checkpoint = newCheckpoint(planTradeJobs({ symbols, fromMs: state.fromMs, toMs: state.toMs }));
      await deps.storage.save(state).catch(() => {});
      deps.onProgress?.(progressOf(state));
      continue;
    }
    break;
  }

  state.done = true;
  await deps.storage.save(state).catch(() => {});
  deps.onProgress?.(progressOf(state));
  return resultOf(state);
}
