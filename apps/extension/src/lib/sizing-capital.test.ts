import { describe, expect, it } from 'vitest';
import type { PageBalance } from './page-account/parse-balance';
import {
  CAPITAL_SOURCE_STORAGE_KEY,
  DEFAULT_CAPITAL_SOURCE,
  normalizeCapitalSource,
  pageCapitalAvailable,
  resolveCapital,
  type CapitalInput,
} from './sizing-capital';

const balance = (over: Partial<PageBalance> = {}): PageBalance => ({
  asset: 'USDC',
  marginBalance: 71.9636,
  walletBalance: 72.4075,
  available: 70.83,
  unrealizedPnl: -0.4439,
  maintenanceMargin: 0.9782,
  marginMode: 'cross',
  ...over,
});

const NOW = 1_700_000_060_000;
const CAPTURED = 1_700_000_000_000;

const input = (over: Partial<CapitalInput> = {}): CapitalInput => ({
  source: 'manual',
  manualCapital: 1000,
  symbol: 'BTCUSDC',
  balance: balance(),
  capturedAtMs: CAPTURED,
  nowMs: NOW,
  readPageAccount: true,
  ...over,
});

describe('normalizeCapitalSource', () => {
  it('defaults to manual', () => {
    expect(DEFAULT_CAPITAL_SOURCE).toBe('manual');
    expect(normalizeCapitalSource(undefined)).toBe('manual');
    expect(normalizeCapitalSource('manual')).toBe('manual');
    expect(normalizeCapitalSource('page')).toBe('page');
    expect(normalizeCapitalSource('otra-cosa')).toBe('manual');
  });

  it('has its own storage key, apart from the numeric preferences', () => {
    expect(CAPITAL_SOURCE_STORAGE_KEY).toBe('sizing_capital_source');
  });
});

describe('pageCapitalAvailable', () => {
  it('needs the opt-in and a balance for the pair quote', () => {
    expect(pageCapitalAvailable({ readPageAccount: true, balance: balance(), symbol: 'BTCUSDC' })).toBe(true);
    expect(pageCapitalAvailable({ readPageAccount: false, balance: balance(), symbol: 'BTCUSDC' })).toBe(false);
    expect(pageCapitalAvailable({ readPageAccount: true, balance: balance(), symbol: 'BTCUSDT' })).toBe(false);
    expect(pageCapitalAvailable({ readPageAccount: true, balance: null, symbol: 'BTCUSDC' })).toBe(false);
    expect(pageCapitalAvailable({ readPageAccount: true, balance: balance({ marginBalance: null }), symbol: 'BTCUSDC' })).toBe(false);
  });
});

describe('resolveCapital', () => {
  it('manual by default, in USDT', () => {
    expect(resolveCapital(input())).toEqual({
      source: 'manual',
      capital: 1000,
      asset: 'USDT',
      assetMismatch: false,
      stale: false,
      pageLine: null,
      fallbackNote: null,
    });
  });

  it('uses the page margin balance with the pair asset', () => {
    const resolved = resolveCapital(input({ source: 'page' }));
    expect(resolved).toMatchObject({ source: 'page', capital: 71.9636, asset: 'USDC', stale: false });
    expect(resolved.pageLine).toBe('saldo de la página: 71,96 USDC (hace 60 s)');
    expect(resolved.fallbackNote).toBeNull();
  });

  it('matches the quote of a USDT pair', () => {
    const usdt = balance({ asset: 'USDT', marginBalance: 250.5 });
    const resolved = resolveCapital(input({ source: 'page', symbol: 'BTCUSDT', balance: usdt }));
    expect(resolved).toMatchObject({ source: 'page', capital: 250.5, asset: 'USDT' });
  });

  it('falls back to the manual value on an asset mismatch and says why', () => {
    const resolved = resolveCapital(input({ source: 'page', symbol: 'BTCUSDT' }));
    expect(resolved).toMatchObject({ source: 'manual', capital: 1000, asset: 'USDT', assetMismatch: true });
    expect(resolved.fallbackNote).toContain('USDC');
    expect(resolved.fallbackNote).toContain('USDT');
    expect(resolved.pageLine).toBeNull();
  });

  it('falls back when there is no page balance yet', () => {
    const resolved = resolveCapital(input({ source: 'page', balance: null }));
    expect(resolved.source).toBe('manual');
    expect(resolved.capital).toBe(1000);
    expect(resolved.fallbackNote).toContain('todavía no muestra el saldo');
  });

  it('falls back when reading the page is off', () => {
    const resolved = resolveCapital(input({ source: 'page', readPageAccount: false }));
    expect(resolved.source).toBe('manual');
    expect(resolved.fallbackNote).toContain('apagada');
  });

  it('falls back when the page has no margin balance', () => {
    const resolved = resolveCapital(input({ source: 'page', balance: balance({ marginBalance: null }) }));
    expect(resolved.source).toBe('manual');
    expect(resolved.fallbackNote).toContain('saldo de margen');
  });

  it('falls back when the pair has no known quote', () => {
    const resolved = resolveCapital(input({ source: 'page', symbol: 'BTC' }));
    expect(resolved.source).toBe('manual');
    expect(resolved.fallbackNote).toContain('activo de cotización');
  });

  it('marks the page balance stale after 60 s', () => {
    const fresh = resolveCapital(input({ source: 'page', nowMs: CAPTURED + 59_000 }));
    expect(fresh.stale).toBe(false);
    const stale = resolveCapital(input({ source: 'page', nowMs: CAPTURED + 61_000 }));
    expect(stale.stale).toBe(true);
    expect(stale.pageLine).toContain('dato viejo');
    expect(stale.source).toBe('page');
    expect(stale.capital).toBe(71.9636);
  });
});
