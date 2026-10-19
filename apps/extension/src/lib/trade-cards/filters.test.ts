import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearFiltersCache, fetchSymbolFilters, parseSymbolFilters } from './filters';

const payload = {
  symbols: [
    {
      symbol: 'BTCUSDT',
      filters: [
        { minPrice: '556.80', tickSize: '0.10', maxPrice: '4529764', filterType: 'PRICE_FILTER' },
        { minQty: '0.001', maxQty: '1000', stepSize: '0.001', filterType: 'LOT_SIZE' },
        { notional: '50', filterType: 'MIN_NOTIONAL' },
      ],
    },
  ],
};

describe('exchangeInfo filters', () => {
  beforeEach(() => clearFiltersCache());

  it('parses the futures filter shape', () => {
    expect(parseSymbolFilters(payload, 'BTCUSDT')).toEqual({ tickSize: 0.1, stepSize: 0.001, minQty: 0.001, minNotional: 50 });
    expect(parseSymbolFilters(payload, 'ETHUSDT')).toBeNull();
    expect(parseSymbolFilters(null, 'BTCUSDT')).toBeNull();
  });

  it('fetches once per symbol and never throws', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => payload })) as unknown as typeof fetch;
    expect((await fetchSymbolFilters('btcusdt', fetchImpl))?.tickSize).toBe(0.1);
    await fetchSymbolFilters('BTCUSDT', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const bad = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await fetchSymbolFilters('ETHUSDT', bad)).toBeNull();
    expect(await fetchSymbolFilters('../x', bad)).toBeNull();
  });
});
