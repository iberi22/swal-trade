import { describe, expect, it } from 'vitest';
import { DAY_MS, PAGE_LIMIT } from './history';
import { isStoredHistory, runHistory, type GetReply, type HistoryStorage, type StoredHistory } from './history-runner';

const TO = 1_800_000_000_000;
const FROM = TO - 10 * DAY_MS; // 2 ventanas de 7 dias

function memStorage(initial: StoredHistory | null = null): HistoryStorage & { saved: StoredHistory | null; saves: number } {
  const s = {
    saved: initial ? structuredClone(initial) : null,
    saves: 0,
    load: async () => (s.saved ? structuredClone(s.saved) : null),
    save: async (v: StoredHistory) => {
      s.saves++;
      s.saved = structuredClone(v);
    },
    clear: async () => {
      s.saved = null;
    },
  };
  return s;
}

const incomeRow = (i: number, over: Record<string, unknown> = {}) => ({
  symbol: 'BTCUSDT',
  incomeType: 'REALIZED_PNL',
  income: '1.5',
  asset: 'USDT',
  info: '',
  time: FROM + i * 1000,
  tranId: 1000 + i,
  tradeId: '',
  ...over,
});
const tradeRow = (i: number, time = FROM + 5000 + i) => ({
  symbol: 'BTCUSDT', id: 5000 + i, orderId: 1, side: 'BUY', price: '100', qty: '1', realizedPnl: '0',
  commission: '0.05', commissionAsset: 'USDT', time,
});

function harness(router: (path: string, params: Record<string, unknown>) => GetReply) {
  const calls: Array<{ path: string; params: Record<string, unknown> }> = [];
  const sleeps: number[] = [];
  const deps = (storage: HistoryStorage, extra: Partial<Parameters<typeof runHistory>[1]> = {}) => ({
    get: async (path: string, params: Record<string, string | number | undefined>) => {
      calls.push({ path, params });
      return router(path, params);
    },
    storage,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { calls, sleeps, deps };
}

describe('runHistory', () => {
  it('runs income then trades one job at a time, throttled, and reports progress', async () => {
    const h = harness((path) => ({ data: path === '/fapi/v1/income' ? [incomeRow(1), incomeRow(2)] : [tradeRow(1)] }));
    const storage = memStorage();
    const progress: Array<[number, number, number]> = [];
    const r = await runHistory({ fromMs: FROM, toMs: TO, resume: false }, h.deps(storage, { onProgress: (p) => progress.push([p.done, p.total, p.rows]) }));
    expect(r.complete).toBe(true);
    expect(r.partial).toBe(false);
    // 2 ventanas de income + 2 de trades para el unico simbolo
    expect(h.calls.map((c) => c.path)).toEqual([
      '/fapi/v1/income', '/fapi/v1/income', '/fapi/v1/userTrades', '/fapi/v1/userTrades',
    ]);
    // sin espera antes del primero; 1800 ms tras income (30 de peso) y 300 ms tras trades (5)
    expect(h.sleeps).toEqual([1800, 300, 300]);
    // filas repetidas entre ventanas se deduplican por id
    expect(r.income).toHaveLength(2);
    expect(r.fills).toHaveLength(1);
    expect(progress.at(-1)).toEqual([4, 4, 3]);
    expect(storage.saved?.done).toBe(true);
    expect(r.progress).toMatchObject({ done: 4, total: 4 });
  });

  it('follows a full page by time and dedupes the cut millisecond', async () => {
    const full = Array.from({ length: PAGE_LIMIT }, (_, i) => incomeRow(i, { symbol: '', incomeType: 'TRANSFER' }));
    const h = harness((path, params) => {
      if (path !== '/fapi/v1/income') return { data: [] };
      if (params.startTime === FROM) return { data: full };
      return { data: [full[PAGE_LIMIT - 1], incomeRow(PAGE_LIMIT, { symbol: '', incomeType: 'TRANSFER' })] };
    });
    const r = await runHistory({ fromMs: FROM, toMs: FROM + 2_000_000, resume: false }, h.deps(memStorage()));
    const income = h.calls.filter((c) => c.path === '/fapi/v1/income');
    expect(income).toHaveLength(2);
    expect(income[1]!.params.startTime).toBe(FROM + (PAGE_LIMIT - 1) * 1000);
    expect(income[1]!.params).not.toHaveProperty('fromId');
    expect(r.income).toHaveLength(PAGE_LIMIT + 1);
    expect(r.complete).toBe(true);
  });

  it('declares incomplete when a full page makes no progress in time', async () => {
    const same = Array.from({ length: PAGE_LIMIT }, (_, i) => incomeRow(i, { time: FROM }));
    const h = harness(() => ({ data: same }));
    const r = await runHistory({ fromMs: FROM, toMs: FROM + 1000, resume: false }, h.deps(memStorage()));
    expect(r.partial).toBe(true);
    expect(r.error).toBe('incomplete');
  });

  it.each(['ip_or_perm', 'clock', 'net', 'http_429', 'no_key'])('stops cleanly on %s with a partial result', async (code) => {
    let n = 0;
    const h = harness(() => (++n === 2 ? { error: code } : { data: [incomeRow(n)] }));
    const storage = memStorage();
    const r = await runHistory({ fromMs: FROM, toMs: TO, resume: false }, h.deps(storage));
    expect(r.error).toBe(code);
    expect(r.partial).toBe(true);
    expect(r.complete).toBe(false);
    expect(r.income).toHaveLength(1);
    expect(h.calls).toHaveLength(2);
    expect(storage.saved?.done).toBe(false);
    expect(storage.saved?.checkpoint.index).toBe(1);
  });

  it('resumes from the stored checkpoint without repeating finished jobs', async () => {
    let n = 0;
    const first = harness(() => (++n === 2 ? { error: 'net' } : { data: [incomeRow(n)] }));
    const storage = memStorage();
    await runHistory({ fromMs: FROM, toMs: TO, resume: false }, first.deps(storage));

    const second = harness((path) => ({ data: path === '/fapi/v1/income' ? [incomeRow(9)] : [tradeRow(1)] }));
    const r = await runHistory({ fromMs: FROM, toMs: TO, resume: true }, second.deps(storage));
    expect(r.complete).toBe(true);
    // solo queda la segunda ventana de income y los trades
    expect(second.calls.map((c) => c.path)).toEqual(['/fapi/v1/income', '/fapi/v1/userTrades', '/fapi/v1/userTrades']);
    expect(r.income.map((x) => x.tranId).sort()).toEqual(['1001', '1009']);
  });

  it('a finished stored run returns without calling the network; resume:false starts over', async () => {
    const h = harness(() => ({ data: [] }));
    const storage = memStorage();
    await runHistory({ fromMs: FROM, toMs: TO, resume: false }, h.deps(storage));
    const calls = h.calls.length;
    const again = await runHistory({ fromMs: FROM, toMs: TO, resume: true }, h.deps(storage));
    expect(again.complete).toBe(true);
    expect(h.calls).toHaveLength(calls);
    await runHistory({ fromMs: FROM, toMs: TO, resume: false }, h.deps(storage));
    expect(h.calls.length).toBeGreaterThan(calls);
  });

  it('ignores a corrupt stored value', async () => {
    const storage = memStorage();
    storage.saved = { v: 2 } as unknown as StoredHistory;
    const h = harness(() => ({ data: [] }));
    const r = await runHistory({ fromMs: FROM, toMs: TO, resume: true }, h.deps(storage));
    expect(r.complete).toBe(true);
    expect(isStoredHistory({ v: 2 })).toBe(false);
  });

  it('stops when asked and keeps the checkpoint', async () => {
    const h = harness(() => ({ data: [incomeRow(1)] }));
    const storage = memStorage();
    let calls = 0;
    const r = await runHistory({ fromMs: FROM, toMs: TO, resume: false }, h.deps(storage, { shouldStop: () => calls++ >= 1 }));
    expect(r.error).toBe('aborted');
    expect(r.partial).toBe(true);
    expect(storage.saved?.checkpoint.index).toBe(1);
  });

  it('rejects a non-array reply as bad_reply', async () => {
    const h = harness(() => ({ data: { code: 1 } }));
    const r = await runHistory({ fromMs: FROM, toMs: TO, resume: false }, h.deps(memStorage()));
    expect(r.error).toBe('bad_reply');
  });
});
