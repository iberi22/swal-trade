// Metricas deterministas de trading calculadas con los fills/income propios del usuario.
// Sin red, sin aleatoriedad salvo el bootstrap con semilla de gradeCell.

import { gradeCell, wilsonBounds, type CellGradeResult } from './grading';
import type { ClosedTrade, Fill, IncomeRow } from './types';

/** ClosedTrade + campos derivados que types.ts no tiene (funding, neto, nocional). */
export interface RoundTrip extends ClosedTrade {
  /** FUNDING_FEE dentro de la ventana (openedMs, closedMs]; negativo = pagado. */
  fundingUsd: number;
  /** pnl - fees + fundingUsd. */
  netUsd: number;
  /** Nocional de entrada: entry * size. */
  notionalUsd: number;
}

export interface MetricsOptions {
  riskPerTradeUsd: number;
  riskCapitalUsd?: number;
  leverageRule: number;
  tzOffsetHours: number;
  revengeMinutes: number;
  openExposureUsd?: number;
  equity?: number;
}

export interface BucketStats {
  n: number;
  winRate: number;
  netUsd: number;
  revengeCount: number;
}

export interface TradeMetrics {
  n: number;
  wins: number;
  winRate: number;
  winRateWilsonLow: number | null;
  winRateWilsonHigh: number | null;
  /** R nominal = net / riskPerTradeUsd (no es R realizado contra stop real). */
  rNominalMean: number;
  rNominalMeanWin: number | null;
  rNominalMeanLossAbs: number | null;
  expectancyUsd: number;
  /** null cuando no hay perdidas (infinito). */
  profitFactor: number | null;
  netUsd: number;
  feesUsd: number;
  fundingUsd: number;
  maxDrawdownUsd: number;
  /** Drawdown maximo / pico de la curva en ese punto; null si el pico <= 0. */
  maxDrawdownPctOfPeak: number | null;
  medianHoldMin: number;
  byBucket: {
    symbol: Record<string, BucketStats>;
    side: Record<string, BucketStats>;
    hour: Record<string, BucketStats>;
  };
  revengeCount: number;
  sizeUpAfterLossCount: number;
  /** max nocional / (riskCapitalUsd ?? equity); null si no hay capital. */
  maxLeverageSeen: number | null;
  leverageRule: number;
  leverageBreaches: number;
  exposureRatio: number | null;
  grade: CellGradeResult;
}

const EPS = 1e-9;
const MIN = 60_000;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

interface OpenTrip {
  side: 'long' | 'short';
  openedMs: number;
  openQty: number;
  openCost: number;
  closeQty: number;
  closeValue: number;
  pnl: number;
  fees: number;
}

function newTrip(side: 'long' | 'short', timeMs: number): OpenTrip {
  return { side, openedMs: timeMs, openQty: 0, openCost: 0, closeQty: 0, closeValue: 0, pnl: 0, fees: 0 };
}

/**
 * Reconstruye round trips por simbolo corriendo la posicion firmada de 0 a 0.
 * Cierres parciales acumulan en el mismo trip; un fill que invierte el signo
 * cierra el trip y abre otro con el remanente (fee prorrateado por qty; realizedPnl va a la parte que cierra).
 * Trips que siguen abiertos al final se descartan.
 */
export function buildRoundTrips(fills: Fill[], income: IncomeRow[]): RoundTrip[] {
  const bySymbol = new Map<string, Fill[]>();
  for (const f of fills ?? []) {
    if (!f || !(num(f.qty) > 0)) continue;
    const arr = bySymbol.get(f.symbol) ?? [];
    arr.push(f);
    bySymbol.set(f.symbol, arr);
  }
  const funding = (income ?? []).filter(
    (r) => r && r.incomeType === 'FUNDING_FEE' && Number.isFinite(r.income),
  );
  const out: RoundTrip[] = [];

  for (const [symbol, list] of bySymbol) {
    const sorted = [...list].sort((a, b) => num(a.timeMs) - num(b.timeMs));
    let pos = 0;
    let trip: OpenTrip | null = null;

    const finish = (t: OpenTrip, closedMs: number) => {
      const entry = t.openQty > 0 ? t.openCost / t.openQty : 0;
      const exit = t.closeQty > 0 ? t.closeValue / t.closeQty : 0;
      let fund = 0;
      for (const r of funding) {
        if (r.symbol === symbol && r.timeMs > t.openedMs && r.timeMs <= closedMs) fund += r.income;
      }
      out.push({
        symbol,
        side: t.side,
        openedMs: t.openedMs,
        closedMs,
        entry,
        exit,
        size: t.openQty,
        pnl: t.pnl,
        fees: t.fees,
        fundingUsd: fund,
        netUsd: t.pnl - t.fees + fund,
        notionalUsd: entry * t.openQty,
      });
    };

    for (const f of sorted) {
      const qty = num(f.qty);
      const price = num(f.price);
      const fee = Math.abs(num(f.fee));
      const pnl = num(f.realizedPnl);
      const dir = f.side === 'BUY' ? 1 : -1;
      let remaining = qty;

      while (remaining > EPS) {
        if (Math.abs(pos) <= EPS || !trip) {
          pos = 0;
          trip = newTrip(dir > 0 ? 'long' : 'short', f.timeMs);
        }
        const posDir = pos === 0 ? dir : Math.sign(pos);
        const share = remaining / qty;
        if (posDir === dir) {
          trip.openQty += remaining;
          trip.openCost += remaining * price;
          trip.fees += fee * share;
          pos += dir * remaining;
          remaining = 0;
        } else {
          const closeQ = Math.min(remaining, Math.abs(pos));
          const cshare = closeQ / qty;
          trip.closeQty += closeQ;
          trip.closeValue += closeQ * price;
          trip.fees += fee * cshare;
          trip.pnl += pnl; // realizedPnl de Binance corresponde a la parte que cierra
          pos += dir * closeQ;
          remaining -= closeQ;
          if (Math.abs(pos) <= EPS) {
            finish(trip, f.timeMs);
            trip = null;
            pos = 0;
          }
        }
      }
    }
  }
  return out.sort((a, b) => a.closedMs - b.closedMs || a.openedMs - b.openedMs);
}

function bucketAdd(map: Record<string, BucketStats>, key: string, net: number, revenge: boolean) {
  const b = (map[key] ??= { n: 0, winRate: 0, netUsd: 0, revengeCount: 0 });
  b.n += 1;
  b.netUsd += net;
  if (net > 0) b.winRate += 1; // acumula wins; se normaliza al final
  if (revenge) b.revengeCount += 1;
}

function normalise(map: Record<string, BucketStats>) {
  for (const b of Object.values(map)) b.winRate = b.n ? b.winRate / b.n : 0;
}

function netOf(t: ClosedTrade): number {
  const r = t as Partial<RoundTrip>;
  if (typeof r.netUsd === 'number' && Number.isFinite(r.netUsd)) return r.netUsd;
  return num(t.pnl) - num(t.fees) + num(r.fundingUsd);
}

export function computeMetrics(trips: ClosedTrade[], opts: MetricsOptions): TradeMetrics {
  const list = [...(trips ?? [])].sort(
    (a, b) => num(a.closedMs) - num(b.closedMs) || num(a.openedMs) - num(b.openedMs),
  );
  const n = list.length;
  const risk = num(opts?.riskPerTradeUsd);
  const nets = list.map(netOf);
  const rs = nets.map((x) => (risk > 0 ? x / risk : 0));
  const notionals = list.map((t) => {
    const r = t as Partial<RoundTrip>;
    return typeof r.notionalUsd === 'number' ? r.notionalUsd : num(t.entry) * num(t.size);
  });
  const medNotional = median(notionals);

  const wins = nets.filter((x) => x > 0).length;
  const grossWin = nets.filter((x) => x > 0).reduce((s, x) => s + x, 0);
  const grossLoss = nets.filter((x) => x < 0).reduce((s, x) => s + -x, 0);
  const netUsd = nets.reduce((s, x) => s + x, 0);
  const winRs = rs.filter((_, i) => (nets[i] ?? 0) > 0);
  const lossRs = rs.filter((_, i) => (nets[i] ?? 0) < 0);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const meanWin = mean(winRs);
  const meanLossAbs = lossRs.length ? (mean(lossRs) as number) * -1 : null;

  // curva acumulada y drawdown
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  let maxDdPeak = 0;
  for (const x of nets) {
    cum += x;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDd) {
      maxDd = peak - cum;
      maxDdPeak = peak;
    }
  }

  // sesgos de comportamiento
  const windowMs = Math.max(0, num(opts?.revengeMinutes)) * MIN;
  const tz = num(opts?.tzOffsetHours);
  const byBucket: TradeMetrics['byBucket'] = { symbol: {}, side: {}, hour: {} };
  let revengeCount = 0;
  let sizeUp = 0;
  for (let j = 0; j < n; j++) {
    const t = list[j]!;
    const netJ = nets[j] ?? 0;
    const notionalJ = notionals[j] ?? 0;
    // ultimo trip cerrado antes (o al mismo instante) de abrir este
    let prev = -1;
    for (let i = 0; i < n; i++) {
      if (i === j) continue;
      const ci = num(list[i]?.closedMs);
      if (ci <= t.openedMs && (prev < 0 || ci >= num(list[prev]?.closedMs))) prev = i;
    }
    const afterLoss = prev >= 0 && (nets[prev] ?? 0) < 0;
    const revenge = afterLoss && t.openedMs - num(list[prev]?.closedMs) <= windowMs;
    if (revenge) revengeCount++;
    if (afterLoss && medNotional > 0 && notionalJ > 1.5 * medNotional) sizeUp++;
    const hour = new Date(num(t.openedMs) + tz * 3_600_000).getUTCHours();
    bucketAdd(byBucket.symbol, t.symbol, netJ, revenge);
    bucketAdd(byBucket.side, t.side, netJ, revenge);
    bucketAdd(byBucket.hour, String(hour), netJ, revenge);
  }
  normalise(byBucket.symbol);
  normalise(byBucket.side);
  normalise(byBucket.hour);

  const capital = num(opts?.riskCapitalUsd) > 0 ? num(opts.riskCapitalUsd) : num(opts?.equity) > 0 ? num(opts.equity) : 0;
  const maxNotional = notionals.reduce((m, x) => Math.max(m, x), 0);
  const levs = notionals.map((x) => (capital > 0 ? x / capital : 0));
  const rule = num(opts?.leverageRule);
  const equity = num(opts?.equity);
  const [wLow, wHigh] = wilsonBounds(wins, n);

  const rr = meanWin !== null && meanLossAbs !== null && meanLossAbs > 0 ? meanWin / meanLossAbs : 1.0;
  const grade = gradeCell({ n, wins, netRs: rs, rr, costR: 0 });
  if (n < 30) grade.grade = 'no_evidence';

  return {
    n,
    wins,
    winRate: n ? wins / n : 0,
    winRateWilsonLow: wLow,
    winRateWilsonHigh: wHigh,
    rNominalMean: n ? rs.reduce((s, x) => s + x, 0) / n : 0,
    rNominalMeanWin: meanWin,
    rNominalMeanLossAbs: meanLossAbs,
    expectancyUsd: n ? netUsd / n : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    netUsd,
    feesUsd: list.reduce((s, t) => s + num(t.fees), 0),
    fundingUsd: list.reduce((s, t) => s + num((t as Partial<RoundTrip>).fundingUsd), 0),
    maxDrawdownUsd: maxDd,
    maxDrawdownPctOfPeak: maxDdPeak > 0 ? maxDd / maxDdPeak : null,
    medianHoldMin: median(list.map((t) => (num(t.closedMs) - num(t.openedMs)) / MIN)),
    byBucket,
    revengeCount,
    sizeUpAfterLossCount: sizeUp,
    maxLeverageSeen: capital > 0 && n ? maxNotional / capital : null,
    leverageRule: rule,
    leverageBreaches: rule > 0 ? levs.filter((l) => l > rule).length : 0,
    exposureRatio:
      opts?.openExposureUsd !== undefined && equity > 0 ? num(opts.openExposureUsd) / equity : null,
    grade,
  };
}
