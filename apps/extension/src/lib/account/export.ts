// Exportacion CSV (a prueba de formulas) y JSON de trades y metricas.

import type { ClosedTrade } from './types';
import type { RoundTrip, TradeMetrics } from './metrics';

const HEADER = [
  'simbolo',
  'lado',
  'apertura_iso',
  'cierre_iso',
  'entrada',
  'salida',
  'tamano',
  'pnl_bruto',
  'comisiones',
  'funding',
  'neto',
  'nocional',
];

function textCell(s: string): string {
  // Neutraliza inyeccion de formulas en hojas de calculo.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function numCell(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

function iso(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

export function tradesToCsv(trips: ClosedTrade[]): string {
  const lines = [HEADER.join(',')];
  for (const t of trips ?? []) {
    const r = t as Partial<RoundTrip>;
    const funding = r.fundingUsd ?? 0;
    const net = r.netUsd ?? t.pnl - t.fees + funding;
    const notional = r.notionalUsd ?? t.entry * t.size;
    lines.push(
      [
        textCell(String(t.symbol ?? '')),
        textCell(String(t.side ?? '')),
        textCell(iso(t.openedMs)),
        textCell(iso(t.closedMs)),
        numCell(t.entry),
        numCell(t.exit),
        numCell(t.size),
        numCell(t.pnl),
        numCell(t.fees),
        numCell(funding),
        numCell(net),
        numCell(notional),
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

export function metricsToJson(metrics: TradeMetrics): string {
  return JSON.stringify(
    metrics,
    (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v),
    2,
  );
}
