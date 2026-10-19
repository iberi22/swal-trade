import { describe, expect, it } from 'vitest';
import { metricsToJson, tradesToCsv } from './export';
import { computeMetrics } from './metrics';
import type { ClosedTrade } from './types';

const base: ClosedTrade = {
  symbol: 'BTCUSDT',
  side: 'long',
  openedMs: Date.UTC(2026, 0, 5),
  closedMs: Date.UTC(2026, 0, 5, 1),
  entry: 100,
  exit: 110,
  size: 1,
  pnl: 10,
  fees: 0.5,
};

const rows = (csv: string) => csv.split('\n');

describe('tradesToCsv', () => {
  it('header is Spanish snake_case and lines end with \\n', () => {
    const csv = tradesToCsv([base]);
    expect(rows(csv)[0]).toBe(
      'simbolo,lado,apertura_iso,cierre_iso,entrada,salida,tamano,pnl_bruto,comisiones,funding,neto,nocional',
    );
    expect(csv.endsWith('\n')).toBe(true);
    expect(csv).not.toContain('\r');
    expect(rows(csv)[1]).toBe('BTCUSDT,long,2026-01-05T00:00:00.000Z,2026-01-05T01:00:00.000Z,100,110,1,10,0.5,0,9.5,100');
  });

  it('neutralizes formula injection in string cells', () => {
    for (const bad of ['=1+1', '+cmd', '-2', '@x', '\tx']) {
      const line = rows(tradesToCsv([{ ...base, symbol: bad }]))[1]!;
      expect(line.startsWith(`'${bad},`)).toBe(true);
    }
  });

  it('keeps negative numbers numeric', () => {
    const line = rows(tradesToCsv([{ ...base, pnl: -10 }]))[1]!;
    expect(line).toContain(',-10,');
    expect(line).not.toContain("'-10");
  });

  it('quotes commas, quotes and newlines (RFC 4180)', () => {
    const line = tradesToCsv([{ ...base, symbol: 'A,"B"\nC' }]);
    expect(line).toContain('"A,""B""\nC"');
    expect(tradesToCsv([{ ...base, symbol: '=A,B' }])).toContain('"\'=A,B"');
  });

  it('empty input is header only', () => {
    expect(tradesToCsv([])).toBe(rows(tradesToCsv([]))[0] + '\n');
  });
});

describe('metricsToJson', () => {
  it('serializes and parses back', () => {
    const m = computeMetrics([], {
      riskPerTradeUsd: 50,
      leverageRule: 3,
      tzOffsetHours: 0,
      revengeMinutes: 30,
    });
    const parsed = JSON.parse(metricsToJson(m));
    expect(parsed.n).toBe(0);
    expect(parsed.profitFactor).toBeNull();
    expect(parsed.grade.grade).toBe('no_evidence');
  });

  it('maps Infinity to null', () => {
    const m = computeMetrics([], { riskPerTradeUsd: 1, leverageRule: 1, tzOffsetHours: 0, revengeMinutes: 1 });
    m.expectancyUsd = Infinity;
    expect(JSON.parse(metricsToJson(m)).expectancyUsd).toBeNull();
  });
});
