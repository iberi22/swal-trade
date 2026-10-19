import { describe, expect, it, vi } from 'vitest';
import { localeOfTabUrl, openPair, openPairUrl, safeLocale, type OpenPairDeps, type PairTab } from './open-pair';

function deps(found: PairTab[]): OpenPairDeps & { update: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => found);
  const update = vi.fn(async () => ({}));
  const create = vi.fn(async () => ({}));
  return { tabs: { query, update, create }, query, update, create };
}

describe('openPairUrl', () => {
  it('builds the futures URL from the validated symbol', () => {
    expect(openPairUrl('solusdt')).toBe('https://www.binance.com/en/futures/SOLUSDT');
    expect(openPairUrl('BTCUSDT', 'es')).toBe('https://www.binance.com/es/futures/BTCUSDT');
    expect(openPairUrl('BTCUSDT', 'pt-BR')).toBe('https://www.binance.com/pt-BR/futures/BTCUSDT');
  });
  it('rejects bad symbols and ignores bad locales', () => {
    expect(() => openPairUrl('BTC/../x')).toThrow();
    expect(() => openPairUrl('')).toThrow();
    expect(openPairUrl('BTCUSDT', 'evil.com/x')).toBe('https://www.binance.com/en/futures/BTCUSDT');
    expect(safeLocale(undefined)).toBe('en');
  });
  it('reads the locale from a tab url', () => {
    expect(localeOfTabUrl('https://www.binance.com/es-LA/futures/BTCUSDT')).toBe('es-LA');
    expect(localeOfTabUrl('https://evil.test/es/futures/x')).toBeNull();
    expect(localeOfTabUrl(undefined)).toBeNull();
  });
});

describe('openPair', () => {
  it('queries the futures pattern and navigates the existing tab keeping the locale', async () => {
    const d = deps([
      { id: 1, url: 'https://www.binance.com/en/futures/ETHUSDT' },
      { id: 2, url: 'https://www.binance.com/es/futures/BTCUSDT', active: true },
    ]);
    expect(await openPair('SOLUSDT', d)).toBe('updated');
    expect(d.query).toHaveBeenCalledWith({ url: 'https://www.binance.com/*/futures/*' });
    expect(d.update).toHaveBeenCalledWith(2, { url: 'https://www.binance.com/es/futures/SOLUSDT', active: true });
    expect(d.create).not.toHaveBeenCalled();
  });
  it('creates a tab when none is open or query fails', async () => {
    const d = deps([]);
    expect(await openPair('SOLUSDT', d)).toBe('created');
    expect(d.create).toHaveBeenCalledWith({ url: 'https://www.binance.com/en/futures/SOLUSDT', active: true });
    const bad = deps([]);
    bad.query.mockRejectedValueOnce(new Error('x'));
    expect(await openPair('SOLUSDT', bad)).toBe('created');
  });
  it('falls back to create when update fails', async () => {
    const d = deps([{ id: 3, url: 'https://www.binance.com/en/futures/BTCUSDT' }]);
    d.update.mockRejectedValueOnce(new Error('closed'));
    expect(await openPair('SOLUSDT', d)).toBe('created');
  });
  it('never touches tabs with an invalid symbol', async () => {
    const d = deps([]);
    await expect(openPair('a b', d)).rejects.toThrow();
    expect(d.query).not.toHaveBeenCalled();
    expect(d.create).not.toHaveBeenCalled();
  });
});
