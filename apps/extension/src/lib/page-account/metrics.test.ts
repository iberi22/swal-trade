import { describe, expect, it } from 'vitest';
import { wilsonBounds } from '../account/grading';
import { historyFixture } from './fixtures';
import { historyMetrics } from './metrics';
import { parsePositionHistory } from './parse-history';

const TZ = -300;
const rows = parsePositionHistory(historyFixture(), { tzOffsetMinutes: TZ });
const metrics = historyMetrics(rows);

describe('historyMetrics', () => {
  it('counts rows, wins and losses', () => {
    expect(metrics.n).toBe(3);
    expect(metrics.wins).toBe(2);
    expect(metrics.losses).toBe(1);
    expect(metrics.netPnl).toBeCloseTo(1.01 + 2.16 - 10.57, 10);
    expect(metrics.netPnl).toBeCloseTo(-7.4, 10);
  });

  it('averages ROI over the rows that show it', () => {
    expect(metrics.avgRoiPct).toBeCloseTo((9.25 + 40.24 - 62.05) / 3, 10);
  });

  it('identifies the best and the worst closed position', () => {
    expect(metrics.best?.symbol).toBe('1000PEPEUSDC');
    expect(metrics.best?.realizedPnl).toBe(2.16);
    expect(metrics.worst?.symbol).toBe('HBARUSDC');
    expect(metrics.worst?.realizedPnl).toBe(-10.57);
  });

  it('groups by symbol sorted by net PnL', () => {
    expect(metrics.bySymbol.map((entry) => entry.symbol)).toEqual([
      '1000PEPEUSDC',
      'BTCUSDC',
      'HBARUSDC',
    ]);
    expect(metrics.bySymbol.map((entry) => entry.n)).toEqual([1, 1, 1]);
    expect(metrics.bySymbol[0]?.netPnl).toBe(2.16);
    expect(metrics.bySymbol[1]?.netPnl).toBe(1.01);
    expect(metrics.bySymbol[2]?.netPnl).toBe(-10.57);
    expect(metrics.bySymbol[0]?.winRate).toBe(1);
    expect(metrics.bySymbol[2]?.winRate).toBe(0);
  });

  it('groups by side', () => {
    expect(metrics.bySide.long).toMatchObject({
      n: 1,
      wins: 1,
      losses: 0,
      netPnl: 2.16,
      winRate: 1,
      avgRoiPct: 40.24,
    });
    expect(metrics.bySide.short.n).toBe(2);
    expect(metrics.bySide.short.wins).toBe(1);
    expect(metrics.bySide.short.losses).toBe(1);
    expect(metrics.bySide.short.netPnl).toBeCloseTo(-9.56, 10);
    expect(metrics.bySide.short.avgRoiPct).toBeCloseTo((9.25 - 62.05) / 2, 10);
  });

  it('averages duration and leverage', () => {
    expect(metrics.avgDurationMs).toBe(
      (38_100_000 + 31_200_000 + 38_220_000) / 3,
    );
    expect(metrics.leverage).toEqual({ median: 30, max: 40 });
  });

  it('reports the Wilson interval and the same module grade', () => {
    expect(metrics.winRateCi).toEqual(wilsonBounds(2, 3));
    expect(metrics.winRateCi[0]).toBeGreaterThanOrEqual(0);
    expect(metrics.winRateCi[1]).toBeLessThanOrEqual(1);
    expect(metrics.grade.grade).toBe('no_evidence');
    expect(metrics.grade.n).toBe(3);
    expect(metrics.grade.reasons).toContain('n_below_30');
  });

  it('returns empty metrics without rows and never throws', () => {
    for (const input of [null, undefined, []]) {
      const empty = historyMetrics(input as never);
      expect(empty.n).toBe(0);
      expect(empty.wins).toBe(0);
      expect(empty.losses).toBe(0);
      expect(empty.netPnl).toBe(0);
      expect(empty.avgRoiPct).toBeNull();
      expect(empty.best).toBeNull();
      expect(empty.worst).toBeNull();
      expect(empty.bySymbol).toEqual([]);
      expect(empty.bySide).toEqual({
        long: { n: 0, wins: 0, losses: 0, netPnl: 0, winRate: 0, avgRoiPct: null },
        short: { n: 0, wins: 0, losses: 0, netPnl: 0, winRate: 0, avgRoiPct: null },
      });
      expect(empty.avgDurationMs).toBeNull();
      expect(empty.leverage).toEqual({ median: null, max: null });
      expect(empty.winRateCi).toEqual([null, null]);
      expect(empty.grade.grade).toBe('no_evidence');
    }
  });

  it('handles rows with null pnl, roi, side, duration and leverage', () => {
    const partial = historyMetrics([
      {
        symbol: 'BTCUSDC',
        leverage: null,
        marginMode: null,
        side: null,
        status: 'closed',
        openedAtMs: 0,
        closedAtMs: 3_600_000,
        durationMs: null,
        realizedPnl: null,
        pnlAsset: null,
        roiPct: null,
        closeVolume: null,
        closeVolumeAsset: null,
        entry: null,
        avgClose: null,
        maxOpenInterest: null,
        key: 'BTCUSDC|0|3600000',
      },
    ]);
    expect(partial.n).toBe(1);
    expect(partial.wins).toBe(0);
    expect(partial.losses).toBe(0);
    expect(partial.netPnl).toBe(0);
    expect(partial.avgRoiPct).toBeNull();
    expect(partial.bySide.long.n).toBe(0);
    expect(partial.bySide.short.n).toBe(0);
    expect(partial.avgDurationMs).toBe(3_600_000);
    expect(partial.leverage).toEqual({ median: null, max: null });
  });
});
