// Logica pura del Guardian de riesgo (port de scripts/risk_guardian.py). Sin red, sin DOM.

export const USD = new Set(['USDT', 'USDC', 'FDUSD', 'BUSD']);
export const PNL_TYPES = new Set(['REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE']);
export const FREE_MAX_POSITIONS = 1;

export function dayStartMs(nowMs, tzH) {
  const off = Math.trunc(tzH * 3600000);
  return Math.floor((nowMs + off) / 86400000) * 86400000 - off;
}

export function realizedUsd(rows) {
  let s = 0;
  for (const r of rows) {
    if (PNL_TYPES.has(r.incomeType) && USD.has(r.asset)) s += parseFloat(r.income);
  }
  return s;
}

export function positionsFrom(account) {
  return (account.positions || [])
    .filter((p) => parseFloat(p.positionAmt) !== 0)
    .map((p) => ({
      symbol: p.symbol,
      amt: String(p.positionAmt),
      notional: Math.abs(parseFloat(p.notional)),
      unrealized: parseFloat(p.unrealizedProfit),
      positionSide: p.positionSide || 'BOTH',
    }));
}

const f2 = (n) => n.toFixed(2);

export function breaches(dayPnl, pos, leverages, cfg) {
  const out = {};
  const lim = cfg.limit;
  const open = pos.reduce((a, p) => a + p.unrealized, 0);
  const det = `PnL del dia ${f2(dayPnl)} USD (realizado ${f2(dayPnl - open)}, abierto ${f2(open)}), limite -${f2(lim)}.`;
  if (dayPnl <= -lim) out.daily_hit = `GUARDIAN: limite diario alcanzado. ${det} Para de operar hoy.`;
  else if (dayPnl <= -lim * (cfg.warn ?? 0.7)) out.daily_warn = `GUARDIAN: cerca del limite diario. ${det} Cuidado.`;
  for (const p of pos) {
    const s = p.symbol;
    const mx = cfg.maxNotional;
    const lv = cfg.maxLev;
    if (mx && p.notional > mx) out[`notional:${s}`] = `GUARDIAN: ${s} nocional ${p.notional.toFixed(0)} USD supera el maximo ${mx.toFixed(0)}.`;
    if (lv && (leverages[s] || 0) > lv) out[`lev:${s}`] = `GUARDIAN: ${s} apalancamiento ${leverages[s]}x supera el maximo ${lv}x.`;
  }
  return out;
}

const isTrue = (v) => v === true || String(v).toLowerCase() === 'true';

export function hasStop(p, algo) {
  const long = parseFloat(p.amt) > 0;
  for (const o of algo) {
    const typ = o.orderType || o.type;
    if (o.symbol !== p.symbol || typ !== 'STOP_MARKET' || o.side !== (long ? 'SELL' : 'BUY')) continue;
    if (p.positionSide !== 'BOTH' && o.positionSide !== p.positionSide) continue;
    if (isTrue(o.closePosition) || isTrue(o.reduceOnly)) return true;
  }
  return false;
}

export const unprotected = (pos, algo) => pos.filter((p) => !hasStop(p, algo));

/** Mensajes SIN STOP a enviar ahora (max 1 por posicion cada everyS); muta `last` (Map). */
export function stopAlertsDue(missing, last, now, everyS) {
  const out = [];
  const keys = new Set();
  for (const p of missing) {
    const k = `${p.symbol}|${parseFloat(p.amt) > 0 ? 'LONG' : 'SHORT'}`;
    keys.add(k);
    if (now - (last.has(k) ? last.get(k) : -1e18) >= everyS) {
      last.set(k, now);
      out.push(`SIN STOP: ${p.symbol} ${k.split('|')[1]} ${p.amt.replace(/^-/, '')}`);
    }
  }
  for (const k of [...last.keys()]) if (!keys.has(k)) last.delete(k);
  return out;
}

/** Claves de incumplimiento nuevas (no avisadas aun) y actualiza `alerted` (Set). */
export function newBreaches(br, alerted) {
  const fresh = Object.keys(br).filter((k) => !alerted.has(k)).sort();
  for (const k of fresh) alerted.add(k);
  return fresh;
}

/** Validacion de la configuracion del formulario. Devuelve {cfg} o {error}. */
export function parseConfig({ limit, maxNotional, maxLev, tz }) {
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const l = num(limit);
  if (!(l > 0)) return { error: 'El limite diario debe ser mayor que 0.' };
  const mn = num(maxNotional);
  const ml = num(maxLev);
  const z = num(tz) ?? -5;
  if ([mn, ml].some((x) => x !== null && !(x > 0))) return { error: 'Nocional y apalancamiento maximos deben ser positivos o vacios.' };
  if (!(z >= -12 && z <= 14)) return { error: 'Zona horaria fuera de rango (-12 a 14).' };
  return { cfg: { limit: l, warn: 0.7, maxNotional: mn, maxLev: ml, tz: z } };
}

/** Pro gating (puro). license = {status:'pro'|'none'|'expired'|'invalid'|'unsupported'}. */
export function tierFor(license) {
  const pro = license && license.status === 'pro';
  return {
    tier: pro ? 'pro' : 'free',
    maxPositions: pro ? Infinity : FREE_MAX_POSITIONS,
    telegram: !!pro,
    selfHostLink: !!pro,
  };
}

/** Posiciones vigiladas segun el plan (free: la de mayor nocional). */
export function monitoredPositions(pos, tier) {
  if (pos.length <= tier.maxPositions) return pos;
  return [...pos].sort((a, b) => b.notional - a.notional).slice(0, tier.maxPositions);
}
