import { describe, expect, it } from 'vitest';
import {
  DAY_MS, WINDOW_MS, advance, currentJob, dedupeById, isFinished, minGapMs, newCheckpoint, nextPage,
  planIncomeJobs, planTradeJobs, symbolsFromIncome, weightBudget, type Job,
} from './history';

const TO = 1_800_000_000_000;
const mk = (n: number, f: (i: number) => object) => Array.from({ length: n }, (_, i) => f(i));

describe('windows', () => {
  it('180 days: <=7d, contiguous, no overlap, ends at toMs', () => {
    const jobs = planIncomeJobs({ fromMs: TO - 180 * DAY_MS, toMs: TO });
    expect(jobs.length).toBe(Math.ceil(180 / 7));
    jobs.forEach((j, i) => {
      expect(j.params.endTime - j.params.startTime + 1).toBeLessThanOrEqual(WINDOW_MS);
      expect(j.params.limit).toBe(1000);
      if (i > 0) expect(j.params.startTime).toBe(jobs[i - 1]!.params.endTime + 1);
    });
    expect(jobs[0]!.params.startTime).toBe(TO - 180 * DAY_MS);
    expect(jobs.at(-1)!.params.endTime).toBe(TO);
  });
  it('clamps older starts to 180 days', () => {
    const jobs = planIncomeJobs({ fromMs: TO - 400 * DAY_MS, toMs: TO });
    expect(jobs[0]!.params.startTime).toBe(TO - 180 * DAY_MS);
  });
  it('short range gives one window; inverted gives none', () => {
    expect(planIncomeJobs({ fromMs: TO - 1000, toMs: TO })).toHaveLength(1);
    expect(planIncomeJobs({ fromMs: TO, toMs: TO - 1 })).toHaveLength(0);
  });
  it('trade jobs per symbol, sanitized and sorted', () => {
    const jobs = planTradeJobs({ symbols: ['ethusdt', 'BTCUSDT', 'BTCUSDT', 'bad sym!'], fromMs: TO - 15 * DAY_MS, toMs: TO });
    expect(jobs).toHaveLength(2 * 3);
    expect(jobs[0]!.params.symbol).toBe('BTCUSDT');
    expect(jobs[3]!.params.symbol).toBe('ETHUSDT');
    expect(jobs.every((j) => j.path === '/fapi/v1/userTrades')).toBe(true);
  });
});

describe('symbolsFromIncome', () => {
  it('filters by type and validity', () => {
    const rows = [
      { symbol: 'ethusdt', incomeType: 'REALIZED_PNL' },
      { symbol: 'BTCUSDT', incomeType: 'FUNDING_FEE' },
      { symbol: 'BTCUSDT', incomeType: 'COMMISSION' },
      { symbol: 'XRPUSDT', incomeType: 'TRANSFER' },
      { symbol: '', incomeType: 'REALIZED_PNL' },
      { symbol: 'A', incomeType: 'REALIZED_PNL' },
      { symbol: 'BAD-SYM', incomeType: 'REALIZED_PNL' },
    ];
    expect(symbolsFromIncome(rows)).toEqual(['BTCUSDT', 'ETHUSDT']);
  });
});

describe('nextPage', () => {
  const income: Job = { path: '/fapi/v1/income', params: { startTime: 1, endTime: 9, limit: 1000 } };
  const trades: Job = { path: '/fapi/v1/userTrades', params: { symbol: 'BTCUSDT', startTime: 1, endTime: 9, limit: 1000 } };
  it('short page is done', () => {
    expect(nextPage(income, mk(999, (i) => ({ tranId: i })))).toBe('done');
    expect(nextPage(income, [])).toBe('done');
  });
  it('full income page continues with fromId', () => {
    const n = nextPage(income, mk(1000, (i) => ({ tranId: String(500 + i) }))) as Job;
    expect(n.params.fromId).toBe(1500);
    expect(n.params.endTime).toBe(9);
  });
  it('full trades page uses id', () => {
    const n = nextPage(trades, mk(1000, (i) => ({ id: i + 10 }))) as Job;
    expect(n.params.fromId).toBe(1010);
    expect(n.params.symbol).toBe('BTCUSDT');
  });
  it('full page without id is incomplete', () => {
    expect(nextPage(income, mk(1000, () => ({})))).toEqual({ error: 'incomplete' });
    expect(nextPage(trades, mk(1000, (i) => ({ tranId: i })))).toEqual({ error: 'incomplete' });
  });
  it('does not loop if the cursor cannot advance', () => {
    const j: Job = { path: '/fapi/v1/income', params: { ...income.params, fromId: 5000 } };
    expect(nextPage(j, mk(1000, (i) => ({ tranId: i })))).toEqual({ error: 'incomplete' });
  });
});

describe('dedupeById', () => {
  it('drops repeated ids, keeps id-less rows', () => {
    const rows = [{ tranId: 1 }, { tranId: '1' }, { tranId: 2 }, {}, {}];
    expect(dedupeById(rows, 'tranId')).toHaveLength(4);
  });
});

describe('throttle', () => {
  it('budget and gap keep <=1000 weight/min', () => {
    const jobs = planIncomeJobs({ fromMs: TO - 180 * DAY_MS, toMs: TO });
    expect(weightBudget(jobs)).toBe(jobs.length * 30);
    expect(minGapMs(30)).toBe(1800);
    expect(minGapMs(5)).toBe(300);
    expect((60_000 * 30) / minGapMs(30)).toBeLessThanOrEqual(1000);
    expect((60_000 * 5) / minGapMs(5)).toBeLessThanOrEqual(1000);
  });
});

describe('checkpoint', () => {
  it('advances, inserts follow-up pages, finishes', () => {
    const jobs = planIncomeJobs({ fromMs: TO - 10 * DAY_MS, toMs: TO });
    let cp = newCheckpoint(jobs);
    const follow = nextPage(jobs[0]!, mk(1000, (i) => ({ tranId: i }))) as Job;
    cp = advance(cp, 1000, follow);
    expect(cp.jobs).toHaveLength(3);
    expect(currentJob(cp)).toBe(follow);
    cp = advance(cp, 10, 'done');
    cp = advance(cp, 5, 'done');
    expect(isFinished(cp)).toBe(true);
    expect(cp.collected).toEqual({ rows: 1015, pages: 3 });
    expect(JSON.parse(JSON.stringify(cp))).toEqual(cp);
  });
});
