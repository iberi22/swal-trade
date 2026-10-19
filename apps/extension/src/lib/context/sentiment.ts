import type { FearGreed, TimeframeTrend } from '../types';

/**
 * Sentimiento y contexto de mercado en chips cortos. Son hechos del momento,
 * no señales: el miedo/codicia y el funding no han mostrado ventaja
 * direccional estable en nuestras auditorías. Un dato que falta se omite.
 */

export interface SentimentItem {
  id: 'fearGreed' | 'funding' | 'basis' | 'change24h' | 'news' | 'regimen';
  label: string;
  value: string;
  tone: 'neutral' | 'warn';
}

export interface SentimentInput {
  fearGreed?: FearGreed | null;
  premium?: {
    lastFundingRate: number;
    nextFundingTime?: number;
    markPrice: number;
    indexPrice: number;
  } | null;
  ticker24h?: { priceChangePercent: number } | null;
  news?: ReadonlyArray<{ sentiment: { label: string } }> | null;
  regimen?: readonly Pick<TimeframeTrend, 'timeframe' | 'label'>[] | null;
}

export interface Sentiment {
  items: SentimentItem[];
  /** "Miedo 32 · funding +0,009 %": vacío si no hay ni miedo/codicia ni funding. */
  summary: string;
}

export const FUNDING_WARN_PCT = 0.05;
/** Por debajo de esto (en %, cada 8 h) el funding se considera neutro. */
export const FUNDING_NEUTRAL_PCT = 0.005;
export const FEAR_WARN_LOW = 20;
export const FEAR_WARN_HIGH = 80;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Número con signo y coma decimal: +0,009 / -1,20. */
export function signed(value: number, decimals: number): string {
  const fixed = Math.abs(value).toFixed(decimals);
  const sign = Number(fixed) === 0 ? '' : value > 0 ? '+' : '-';
  return `${sign}${fixed.replace('.', ',')}`;
}

export function fundingText(ratePct: number): string {
  if (Math.abs(ratePct) < FUNDING_NEUTRAL_PCT) return 'neutro';
  return ratePct > 0 ? 'los largos pagan' : 'los cortos pagan';
}

export function buildSentiment(input: SentimentInput): Sentiment {
  const items: SentimentItem[] = [];
  let fearShort = '';
  let fundingShort = '';

  const fg = input.fearGreed;
  if (fg && finite(fg.value)) {
    const warn = fg.value <= FEAR_WARN_LOW || fg.value >= FEAR_WARN_HIGH;
    items.push({
      id: 'fearGreed',
      label: 'Miedo/Codicia',
      value: `${fg.value} · ${fg.label}`,
      tone: warn ? 'warn' : 'neutral',
    });
    fearShort = `${fg.label} ${fg.value}`;
  }

  const premium = input.premium;
  if (premium && finite(premium.lastFundingRate)) {
    const pct = premium.lastFundingRate * 100;
    items.push({
      id: 'funding',
      label: 'Funding 8h',
      value: `${signed(pct, 3)} % · ${fundingText(pct)}`,
      tone: Math.abs(pct) >= FUNDING_WARN_PCT ? 'warn' : 'neutral',
    });
    fundingShort = `funding ${signed(pct, 3)} %`;
  }

  if (premium && finite(premium.markPrice) && finite(premium.indexPrice) && premium.indexPrice > 0) {
    const basis = ((premium.markPrice - premium.indexPrice) / premium.indexPrice) * 100;
    items.push({ id: 'basis', label: 'Basis', value: `${signed(basis, 3)} %`, tone: 'neutral' });
  }

  const ticker = input.ticker24h;
  if (ticker && finite(ticker.priceChangePercent)) {
    items.push({
      id: 'change24h',
      label: '24h',
      value: `${signed(ticker.priceChangePercent, 2)} %`,
      tone: 'neutral',
    });
  }

  const news = input.news;
  if (news && news.length > 0) {
    let pos = 0;
    let neg = 0;
    let neutral = 0;
    for (const item of news) {
      const label = item.sentiment?.label;
      if (label === 'positivo') pos += 1;
      else if (label === 'negativo') neg += 1;
      else neutral += 1;
    }
    items.push({
      id: 'news',
      label: 'Titulares',
      value: `${pos} pos · ${neg} neg · ${neutral} neutro`,
      tone: 'neutral',
    });
  }

  const regimen = input.regimen;
  if (regimen && regimen.length > 0) {
    items.push({
      id: 'regimen',
      label: 'Régimen',
      value: regimen.map((row) => `${row.timeframe} ${row.label}`).join(' · '),
      tone: 'neutral',
    });
  }

  return { items, summary: [fearShort, fundingShort].filter(Boolean).join(' · ') };
}
