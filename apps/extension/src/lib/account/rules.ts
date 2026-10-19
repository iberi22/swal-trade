import type { RulesSettings } from '../settings';
import type { AccountSnapshot, Fill, PositionView } from './types';

export type RuleSeverity = 'critical' | 'warn' | 'info';

export interface RuleResult {
  code: string;
  sev: RuleSeverity;
  /** Texto en español, texto plano, <= 90 caracteres. Solo describe riesgo y costo. */
  text: string;
  values: Record<string, number>;
}

export interface RuleInput {
  position: PositionView;
  snapshot: AccountSnapshot;
  atr: number | null;
  rules: RulesSettings;
  recentFills?: Fill[];
  initialStopPrice?: number | null;
  lastClosedLoss?: { closedAtMs: number } | null;
  now: number;
}

const TAKER_FEE = 0.0005;
const STALE_MS = 30_000;
const FUNDING_WINDOW_MS = 60 * 60_000;
const SEV_ORDER: Record<RuleSeverity, number> = { critical: 0, warn: 1, info: 2 };

const MAX_TEXT = 90;
const clip = (s: string): string => (s.length <= MAX_TEXT ? s : s.slice(0, MAX_TEXT - 1) + '.');
const fix = (n: number, d = 1): string => n.toFixed(d);

function averagingDown(position: PositionView, fills: Fill[]): { last: number; prev: number } | null {
  const buySide = position.side === 'long' ? 'BUY' : 'SELL';
  const since = position.firstFillMs;
  const same = fills
    .filter((f) => f.symbol === position.symbol && f.side === buySide && f.qty > 0)
    .filter((f) => since === null || f.timeMs >= since)
    .sort((a, b) => a.timeMs - b.timeMs);
  if (same.length < 2) return null;
  const last = same[same.length - 1];
  if (!last) return null;
  const earlier = same.slice(0, -1);
  const qty = earlier.reduce((acc, f) => acc + f.qty, 0);
  if (qty <= 0) return null;
  const prev = earlier.reduce((acc, f) => acc + f.price * f.qty, 0) / qty;
  const worse = position.side === 'long' ? last.price < prev : last.price > prev;
  return worse ? { last: last.price, prev } : null;
}

export function evaluateRules(input: RuleInput): RuleResult[] {
  const { position: p, snapshot, atr, rules, now } = input;
  const out: RuleResult[] = [];
  const s = p.side === 'long' ? 1 : -1;
  const E = p.entry;
  const M = p.mark;
  const Q = p.size;
  const L = p.liq;
  const S = p.stop ? p.stop.price : null;
  const Eq = snapshot.equity;
  const f = snapshot.fundingRate;

  if (S === null) {
    const dist = L !== null ? (Math.abs(M - L) / M) * 100 : null;
    out.push({
      code: 'NO_STOP',
      sev: 'critical',
      text: clip(
        dist !== null
          ? `Sin stop: la perdida puede llegar a la liquidacion (a ${fix(dist)}% del precio)`
          : 'Sin stop: la perdida puede llegar hasta la liquidacion',
      ),
      values: dist !== null ? { distLiqPct: dist } : {},
    });
  }

  if (S !== null && L !== null) {
    const beyond = s === 1 ? S <= L : S >= L;
    if (beyond) {
      out.push({
        code: 'STOP_BEYOND_LIQ',
        sev: 'critical',
        text: clip('El stop esta mas alla de la liquidacion: se liquida antes de que actue'),
        values: { stop: S, liq: L },
      });
    }
    const dStop = Math.abs(E - S);
    const dLiq = Math.abs(E - L);
    if (dStop > 0.8 * dLiq) {
      out.push({
        code: 'STOP_NEAR_LIQ',
        sev: 'warn',
        text: clip(`El stop recorre ${fix((dStop / dLiq) * 100, 0)}% de la distancia a la liquidacion`),
        values: { stop: S, liq: L, ratio: dStop / dLiq },
      });
    }
  }

  if (S !== null && Eq !== null && Eq > 0) {
    const lossAtStop = Q * Math.abs(M - S) + Q * S * TAKER_FEE;
    const pct = (lossAtStop / Eq) * 100;
    if (pct > rules.maxRiskPct) {
      const crit = pct > 2 * rules.maxRiskPct;
      out.push({
        code: 'RISK_OVER_RULE',
        sev: crit ? 'critical' : 'warn',
        text: clip(`Perdida al stop ${fix(pct, 2)}% del capital; tu regla es ${fix(rules.maxRiskPct, 2)}%`),
        values: { lossAtStop, riskPct: pct, maxRiskPct: rules.maxRiskPct },
      });
    }
  }

  if (p.leverage > rules.maxLeverage) {
    out.push({
      code: 'LEV_OVER_RULE',
      sev: 'warn',
      text: clip(`Apalancamiento ${fix(p.leverage, 0)}x supera tu regla de ${fix(rules.maxLeverage, 0)}x`),
      values: { leverage: p.leverage, maxLeverage: rules.maxLeverage },
    });
  }

  if (atr !== null && atr > 0 && L !== null) {
    const k = Math.abs(M - L) / atr;
    if (k < 3) {
      out.push({
        code: 'LIQ_CLOSE',
        sev: 'warn',
        text: clip(`La liquidacion esta a ${fix(k)} ATR del precio actual`),
        values: { atrMultiple: k, liq: L, atr },
      });
    }
  }

  const dailyPnl = snapshot.dailyPnl;
  if (dailyPnl !== null && rules.dailyLossUsd > 0) {
    if (dailyPnl <= -rules.dailyLossUsd) {
      out.push({
        code: 'DAILY_LIMIT',
        sev: 'critical',
        text: clip(`Limite diario alcanzado: ${fix(dailyPnl, 2)} USD de ${fix(rules.dailyLossUsd, 2)} USD`),
        values: { dailyPnl, dailyLossUsd: rules.dailyLossUsd },
      });
    } else if (dailyPnl <= -0.7 * rules.dailyLossUsd) {
      out.push({
        code: 'DAILY_LIMIT',
        sev: 'warn',
        text: clip(`Perdida diaria al ${fix((-dailyPnl / rules.dailyLossUsd) * 100, 0)}% del limite (70% superado)`),
        values: { dailyPnl, dailyLossUsd: rules.dailyLossUsd },
      });
    }
  }

  if (f !== null && snapshot.nextFundingMs !== null && s * f > 0 && Math.abs(f) >= 0.0005) {
    const eta = snapshot.nextFundingMs - now;
    if (eta <= FUNDING_WINDOW_MS) {
      const cost = Math.abs(f) * M * Q;
      out.push({
        code: 'FUNDING_AGAINST',
        sev: 'info',
        text: clip(`Funding en contra (${fix(f * 100, 3)}%): costo estimado ${fix(cost, 2)} USD`),
        values: { fundingRate: f, cost, etaMs: eta },
      });
    }
  }

  if (input.recentFills && input.recentFills.length > 0) {
    const ad = averagingDown(p, input.recentFills);
    if (ad) {
      out.push({
        code: 'AVERAGING_DOWN',
        sev: 'warn',
        text: clip('Ultimo aumento de tamano a un precio peor que el previo: sube la exposicion'),
        values: { lastFill: ad.last, prevEntry: ad.prev },
      });
    }
  }

  const init = input.initialStopPrice;
  if (S !== null && init !== null && init !== undefined && Math.abs(E - S) > Math.abs(E - init)) {
    out.push({
      code: 'STOP_WIDENED',
      sev: 'warn',
      text: clip('El stop actual esta mas lejos que el stop inicial: el riesgo por unidad aumento'),
      values: { stop: S, initialStop: init },
    });
  }

  const lcl = input.lastClosedLoss;
  if (lcl && p.firstFillMs !== null) {
    const dt = p.firstFillMs - lcl.closedAtMs;
    if (dt >= 0 && dt <= rules.revengeMinutes * 60_000) {
      out.push({
        code: 'REVENGE',
        sev: 'warn',
        text: clip(`Abierta ${fix(dt / 60_000, 0)} min despues de una perdida (regla: ${rules.revengeMinutes} min)`),
        values: { minutesSinceLoss: dt / 60_000, revengeMinutes: rules.revengeMinutes },
      });
    }
  }

  const age = now - snapshot.fetchedAt;
  if (age > STALE_MS) {
    out.push({
      code: 'STALE',
      sev: 'info',
      text: clip(`Datos de la cuenta con ${fix(age / 1000, 0)} s de antiguedad`),
      values: { ageMs: age },
    });
  }

  return out
    .map((r, i) => ({ r, i }))
    .sort((a, b) => SEV_ORDER[a.r.sev] - SEV_ORDER[b.r.sev] || a.i - b.i)
    .map((x) => x.r);
}
