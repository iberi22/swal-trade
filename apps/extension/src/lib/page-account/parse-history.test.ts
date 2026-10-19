import { describe, expect, it } from 'vitest';
import { englishHistoryFixture, historyCards, historyFixture } from './fixtures';
import { parsePositionHistory, type ClosedPosition } from './parse-history';

const TZ = -300;
const btcOpened = Date.UTC(2026, 9, 19, 4, 45, 54);
const btcClosed = Date.UTC(2026, 9, 19, 15, 21, 28);
const pepeOpened = Date.UTC(2026, 9, 19, 5, 13, 18);
const pepeClosed = Date.UTC(2026, 9, 19, 13, 53, 36);
const hbarOpened = Date.UTC(2026, 9, 18, 20, 26, 58);
const hbarClosed = Date.UTC(2026, 9, 19, 7, 4, 33);

function bySymbol(rows: ClosedPosition[]): Map<string, ClosedPosition> {
  return new Map(rows.map((row) => [row.symbol, row]));
}

describe('parsePositionHistory', () => {
  const rows = parsePositionHistory(historyFixture(), { tzOffsetMinutes: TZ });
  const map = bySymbol(rows);

  it('finds the three cards inside an arbitrary container', () => {
    expect(rows).toHaveLength(3);
    expect([...map.keys()]).toEqual(['BTCUSDC', '1000PEPEUSDC', 'HBARUSDC']);
  });

  it('parses the BTC short card exactly', () => {
    expect(map.get('BTCUSDC')).toEqual({
      symbol: 'BTCUSDC',
      leverage: 30,
      marginMode: 'cross',
      side: 'short',
      status: 'closed',
      openedAtMs: btcOpened,
      closedAtMs: btcClosed,
      durationMs: 38_100_000,
      realizedPnl: 1.01,
      pnlAsset: 'USDC',
      roiPct: 9.25,
      closeVolume: 0.004,
      closeVolumeAsset: 'BTC',
      entry: 82_644.1,
      avgClose: 82_330,
      maxOpenInterest: 0.004,
      key: `BTCUSDC|${btcOpened}|${btcClosed}`,
    });
  });

  it('parses the PEPE long card exactly (local time UTC-5)', () => {
    const pepe = map.get('1000PEPEUSDC') as ClosedPosition;
    expect(pepe.leverage).toBe(40);
    expect(pepe.marginMode).toBe('cross');
    expect(pepe.side).toBe('long');
    expect(pepe.openedAtMs).toBe(pepeOpened);
    expect(new Date(pepe.openedAtMs as number).toISOString()).toBe('2026-10-19T05:13:18.000Z');
    expect(pepe.closedAtMs).toBe(pepeClosed);
    expect(pepe.durationMs).toBe(8 * 3_600_000 + 40 * 60_000);
    expect(pepe.realizedPnl).toBe(2.16);
    expect(pepe.roiPct).toBe(40.24);
    expect(pepe.closeVolume).toBe(53_033);
    expect(pepe.closeVolumeAsset).toBe('1000PEPE');
    expect(pepe.entry).toBe(0.0040522);
    expect(pepe.avgClose).toBe(0.0040967);
    expect(pepe.maxOpenInterest).toBe(53_033);
  });

  it('parses the HBAR short card and keeps missing fields null', () => {
    const hbar = map.get('HBARUSDC') as ClosedPosition;
    expect(hbar.leverage).toBe(25);
    expect(hbar.side).toBe('short');
    expect(hbar.openedAtMs).toBe(hbarOpened);
    expect(hbar.closedAtMs).toBe(hbarClosed);
    expect(hbar.durationMs).toBe(10 * 3_600_000 + 37 * 60_000);
    expect(hbar.realizedPnl).toBe(-10.57);
    expect(hbar.roiPct).toBe(-62.05);
    expect(hbar.closeVolume).toBe(5_184);
    expect(hbar.closeVolumeAsset).toBe('HBAR');
    expect(hbar.entry).toBe(0.08218);
    expect(hbar.avgClose).toBe(0.0842113);
    expect(hbar.maxOpenInterest).toBeNull();
  });

  it('builds a stable dedupe key from symbol and timestamps', () => {
    expect(map.get('BTCUSDC')?.key).toBe(`BTCUSDC|${btcOpened}|${btcClosed}`);
    const again = parsePositionHistory(historyFixture(), { tzOffsetMinutes: TZ });
    expect(new Set(again.map((row) => row.key))).toEqual(new Set(rows.map((row) => row.key)));
  });

  it('is robust to cards in any order', () => {
    const reversed = parsePositionHistory(historyFixture([...historyCards()].reverse()), {
      tzOffsetMinutes: TZ,
    });
    expect(new Set(reversed.map((row) => row.key))).toEqual(new Set(rows.map((row) => row.key)));
    expect([...bySymbol(reversed).keys()]).toEqual(['HBARUSDC', '1000PEPEUSDC', 'BTCUSDC']);
  });
});

describe('parsePositionHistory with English labels', () => {
  const rows = parsePositionHistory(englishHistoryFixture(), { tzOffsetMinutes: TZ });

  it('parses the card and leaves ROI null when the card omits it', () => {
    expect(rows).toHaveLength(1);
    const eth = rows[0] as ClosedPosition;
    expect(eth.symbol).toBe('ETHUSDC');
    expect(eth.leverage).toBe(20);
    expect(eth.marginMode).toBe('cross');
    expect(eth.side).toBe('long');
    expect(eth.status).toBe('closed');
    expect(eth.openedAtMs).toBe(Date.UTC(2026, 9, 19, 6, 2, 3));
    expect(eth.closedAtMs).toBe(Date.UTC(2026, 9, 19, 8, 4, 5));
    expect(eth.durationMs).toBe(2 * 3_600_000 + 2 * 60_000);
    expect(eth.realizedPnl).toBe(5);
    expect(eth.pnlAsset).toBe('USDC');
    expect(eth.roiPct).toBeNull();
    expect(eth.closeVolume).toBe(0.5);
    expect(eth.closeVolumeAsset).toBe('ETH');
    expect(eth.entry).toBe(2000);
    expect(eth.avgClose).toBe(2050);
    expect(eth.maxOpenInterest).toBe(0.5);
    expect(eth.key).toBe(`ETHUSDC|${eth.openedAtMs}|${eth.closedAtMs}`);
  });
});

describe('parsePositionHistory robustness', () => {
  it('returns [] for empty, garbage or symbol-less pages', () => {
    expect(parsePositionHistory(null)).toEqual([]);
    expect(parsePositionHistory({ tag: 'div' })).toEqual([]);
    expect(parsePositionHistory({ tag: 'div', text: 'BTCUSDC' })).toEqual([]);
    expect(
      parsePositionHistory({
        tag: 'div',
        children: [{ tag: 'span', text: '10/19/2026 00:13:18 Abierto' }],
      }),
    ).toEqual([]);
    expect(historyCards()).toHaveLength(3);
  });

  it('does not throw with missing options or weird nodes', () => {
    expect(() => parsePositionHistory(historyFixture())).not.toThrow();
    expect(
      parsePositionHistory({ tag: 'div', text: '1000PEPEUSDC 10/19/2026 00:13:18' }),
    ).toEqual([]);
  });
});
