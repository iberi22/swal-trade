import { describe, expect, it } from 'vitest';
import {
  MANUAL_CAPITAL_ASSET,
  PAGE_BALANCE_STALE_MS,
  balanceAsset,
  balanceForSymbol,
  floorBalanceForDisplay,
  formatBalanceAmount,
  formatPageBalanceLine,
  isBalanceStale,
  pageBalanceAgeSeconds,
  quoteAssetOf,
} from './page-balance';
import type { PageBalance } from './parse-balance';

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

describe('quoteAssetOf', () => {
  it('reads the quote asset of the pair', () => {
    expect(quoteAssetOf('BTCUSDC')).toBe('USDC');
    expect(quoteAssetOf('BTCUSDT')).toBe('USDT');
    expect(quoteAssetOf('1000PEPEUSDC')).toBe('USDC');
    expect(quoteAssetOf('ETHFDUSD')).toBe('FDUSD');
    expect(quoteAssetOf('ethusdt')).toBe('USDT');
  });

  it('returns null when the pair does not say it', () => {
    expect(quoteAssetOf('BTC')).toBeNull();
    expect(quoteAssetOf('BTCUSD')).toBeNull();
    expect(quoteAssetOf('')).toBeNull();
    expect(quoteAssetOf(null)).toBeNull();
    expect(quoteAssetOf(42)).toBeNull();
  });
});

describe('balanceAsset', () => {
  it('normalizes the asset and rejects garbage', () => {
    expect(balanceAsset(balance({ asset: 'usdc' }))).toBe('USDC');
    expect(balanceAsset(balance({ asset: null }))).toBeNull();
    expect(balanceAsset(balance({ asset: 'USDC$' }))).toBeNull();
    expect(balanceAsset(null)).toBeNull();
  });
});

describe('balanceForSymbol', () => {
  it('uses the margin balance only when the asset matches the pair', () => {
    expect(balanceForSymbol(balance(), 'BTCUSDC')).toEqual({ asset: 'USDC', value: 71.9636 });
    expect(balanceForSymbol(balance({ asset: 'USDT', marginBalance: 500 }), 'BTCUSDT')).toEqual({
      asset: 'USDT',
      value: 500,
    });
  });

  it('never mixes assets: BTCUSDC with a USDT balance is a mismatch', () => {
    expect(balanceForSymbol(balance({ asset: 'USDT' }), 'BTCUSDC')).toBeNull();
    expect(balanceForSymbol(balance({ asset: 'USDC' }), 'BTCUSDT')).toBeNull();
  });

  it('returns null without a usable balance', () => {
    expect(balanceForSymbol(null, 'BTCUSDC')).toBeNull();
    expect(balanceForSymbol(balance({ marginBalance: null }), 'BTCUSDC')).toBeNull();
    expect(balanceForSymbol(balance({ marginBalance: 0 }), 'BTCUSDC')).toBeNull();
    expect(balanceForSymbol(balance({ marginBalance: Number.NaN }), 'BTCUSDC')).toBeNull();
    expect(balanceForSymbol(balance(), 'BTC')).toBeNull();
  });
});

describe('balance display', () => {
  it('floors instead of rounding a balance up', () => {
    expect(floorBalanceForDisplay(71.9636)).toBe(71.96);
    expect(floorBalanceForDisplay(71.9999)).toBe(71.99);
    expect(floorBalanceForDisplay(0.009999)).toBe(0.009999);
    expect(formatBalanceAmount(71.9636, 'USDC')).toBe('71,96 USDC');
    expect(formatBalanceAmount(1000.5, 'USDT')).toBe('1.000,50 USDT');
  });

  it('keeps small balances visible instead of showing 0,00', () => {
    expect(formatBalanceAmount(0.0045, 'USDC')).toBe('0,0045 USDC');
  });
});

describe('staleness', () => {
  const captured = 1_700_000_000_000;

  it('counts the age in seconds', () => {
    expect(pageBalanceAgeSeconds(captured, captured + 5_000)).toBe(5);
    expect(pageBalanceAgeSeconds(captured, captured - 5_000)).toBe(0);
    expect(pageBalanceAgeSeconds(null, captured)).toBeNull();
    expect(pageBalanceAgeSeconds(captured, Number.NaN)).toBeNull();
  });

  it('goes stale after 60 s, not before', () => {
    expect(isBalanceStale(captured, captured + PAGE_BALANCE_STALE_MS)).toBe(false);
    expect(isBalanceStale(captured, captured + PAGE_BALANCE_STALE_MS + 1_000)).toBe(true);
  });

  it('marks the line as old once it is stale', () => {
    expect(formatPageBalanceLine({ value: 71.9636, asset: 'USDC', capturedAtMs: captured, nowMs: captured + 12_000 })).toBe(
      'saldo de la página: 71,96 USDC (hace 12 s)',
    );
    expect(formatPageBalanceLine({ value: 71.9636, asset: 'USDC', capturedAtMs: captured, nowMs: captured + 75_000 })).toBe(
      'saldo de la página: 71,96 USDC (hace 75 s, dato viejo)',
    );
  });
});

describe('MANUAL_CAPITAL_ASSET', () => {
  it('is USDT: el capital manual no depende de la página', () => {
    expect(MANUAL_CAPITAL_ASSET).toBe('USDT');
  });
});
