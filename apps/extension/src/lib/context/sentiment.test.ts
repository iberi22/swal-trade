import { describe, expect, it } from 'vitest';
import { buildSentiment, fundingText, signed, type SentimentItem } from './sentiment';

const fearGreed = (value: number, label: string) => ({ value, classification: '', label });
const premium = (rate: number, mark = 100, index = 100) => ({
  lastFundingRate: rate,
  nextFundingTime: 0,
  markPrice: mark,
  indexPrice: index,
});
const byId = (s: ReturnType<typeof buildSentiment>) => Object.fromEntries(s.items.map((i) => [i.id, i])) as Record<SentimentItem['id'], SentimentItem>;

describe('signed', () => {
  it('signo explícito, coma decimal y sin -0', () => {
    expect(signed(0.00934, 3)).toBe('+0,009');
    expect(signed(-1.2, 2)).toBe('-1,20');
    expect(signed(0.0001, 3)).toBe('0,000');
    expect(signed(-0.0001, 3)).toBe('0,000');
  });
});

describe('buildSentiment', () => {
  it('todo presente', () => {
    const s = buildSentiment({
      fearGreed: fearGreed(32, 'Miedo'),
      premium: premium(0.00008, 100.03, 100),
      ticker24h: { priceChangePercent: 1.195 },
      news: [
        { sentiment: { label: 'positivo' } },
        { sentiment: { label: 'negativo' } },
        { sentiment: { label: 'neutral' } },
        { sentiment: { label: 'positivo' } },
      ],
      regimen: [{ timeframe: '1h', label: 'Alcista' }],
    });
    const items = byId(s);
    expect(items.fearGreed.value).toBe('32 · Miedo');
    expect(items.fearGreed.tone).toBe('neutral');
    expect(items.funding.value).toBe('+0,008 % · los largos pagan');
    expect(items.funding.tone).toBe('neutral');
    expect(items.basis.value).toBe('+0,030 %');
    expect(items.change24h.value).toBe('+1,20 %');
    expect(items.news.value).toBe('2 pos · 1 neg · 1 neutro');
    expect(items.regimen.value).toBe('1h Alcista');
    expect(s.summary).toBe('Miedo 32 · funding +0,008 %');
  });

  it('extremos de miedo/codicia y funding alto son warn', () => {
    expect(byId(buildSentiment({ fearGreed: fearGreed(20, 'Miedo extremo') })).fearGreed.tone).toBe('warn');
    expect(byId(buildSentiment({ fearGreed: fearGreed(80, 'Codicia extrema') })).fearGreed.tone).toBe('warn');
    expect(byId(buildSentiment({ fearGreed: fearGreed(21, 'Miedo') })).fearGreed.tone).toBe('neutral');
    expect(byId(buildSentiment({ premium: premium(0.0005) })).funding.tone).toBe('warn');
    expect(byId(buildSentiment({ premium: premium(-0.0006) })).funding.value).toContain('los cortos pagan');
    expect(byId(buildSentiment({ premium: premium(0.00049) })).funding.tone).toBe('neutral');
  });

  it('funding casi cero es neutro', () => {
    expect(fundingText(0.004)).toBe('neutro');
    expect(fundingText(-0.004)).toBe('neutro');
    expect(fundingText(0.005)).toBe('los largos pagan');
  });

  it('un dato que falta se omite, nunca se inventa', () => {
    const s = buildSentiment({ premium: premium(0.0001, Number.NaN, 100) });
    expect(s.items.map((i) => i.id)).toEqual(['funding']);
    expect(buildSentiment({})).toEqual({ items: [], summary: '' });
    expect(buildSentiment({ fearGreed: null, premium: null, ticker24h: null, news: [], regimen: [] }).items).toEqual([]);
    expect(buildSentiment({ ticker24h: { priceChangePercent: Number.NaN } }).items).toEqual([]);
    expect(buildSentiment({ premium: premium(0.0001, 100, 0) }).items.map((i) => i.id)).toEqual(['funding']);
  });

  it('no usa lenguaje de recomendación', () => {
    const s = buildSentiment({
      fearGreed: fearGreed(10, 'Miedo extremo'),
      premium: premium(0.001),
      ticker24h: { priceChangePercent: -4 },
    });
    expect(JSON.stringify(s).toLowerCase()).not.toMatch(/compra|vende/);
  });
});
