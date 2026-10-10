import { describe, expect, it, vi } from 'vitest';
import {
  NEWS_HOST,
  NEWS_LIMIT,
  NEWS_PATH,
  fetchNews,
  newsAsset,
  newsUrl,
  parseNewsItem,
  parseNewsPayload,
  relativeTime,
} from './news';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');

function item(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'a'.repeat(64),
    title: 'Bitcoin rompe máximos',
    url: 'https://example.com/news/bitcoin',
    source: 'Example News',
    publishedAt: '2026-10-09T11:00:00.000Z',
    snippet: 'El mercado celebra el breakout.',
    provider: 'brave',
    symbols: ['BTC'],
    sentiment: { score: 0.6, label: 'positivo' },
    ...partial,
  };
}

describe('newsAsset / newsUrl', () => {
  it('solo BTC y ETH tienen titulares en el servicio', () => {
    expect(newsAsset('BTCUSDT')).toBe('BTC');
    expect(newsAsset('btcusdt')).toBe('BTC');
    expect(newsAsset('ETHUSDC')).toBe('ETH');
    expect(newsAsset('SOLUSDT')).toBeNull();
    expect(newsAsset('')).toBeNull();
  });

  it('arma la URL pública con símbolo y límite', () => {
    expect(newsUrl('BTCUSDT')).toBe('https://trade.swal.network/api/news?symbol=BTC&limit=5');
    expect(newsUrl('ethusdt', 3)).toBe('https://trade.swal.network/api/news?symbol=ETH&limit=3');
    // El servicio corta en 20: no se pide más.
    expect(newsUrl('BTCUSDT', 500)).toContain('limit=20');
    expect(NEWS_PATH).toBe('/api/news');
    expect(NEWS_HOST).toBe('https://trade.swal.network');
  });

  it('sin símbolo cubierto no hay URL', () => {
    expect(newsUrl('SOLUSDT')).toBeNull();
  });
});

describe('parseNewsItem', () => {
  it('lee título, fuente, fecha y tono', () => {
    expect(parseNewsItem(item({}))).toEqual({
      id: 'a'.repeat(64),
      title: 'Bitcoin rompe máximos',
      url: 'https://example.com/news/bitcoin',
      source: 'Example News',
      publishedAt: '2026-10-09T11:00:00.000Z',
      snippet: 'El mercado celebra el breakout.',
      sentiment: { score: 0.6, label: 'positivo' },
    });
  });

  it('descarta lo que no es un titular con enlace https', () => {
    expect(parseNewsItem(item({ title: '' }))).toBeNull();
    expect(parseNewsItem(item({ title: '   ' }))).toBeNull();
    expect(parseNewsItem(item({ url: 'http://example.com/x' }))).toBeNull();
    expect(parseNewsItem(item({ url: 'javascript:alert(1)' }))).toBeNull();
    expect(parseNewsItem(null)).toBeNull();
    expect(parseNewsItem('nope')).toBeNull();
  });

  it('normaliza espacios y corta lo largo', () => {
    const parsed = parseNewsItem(item({ title: '  mucho    espacio  ', snippet: 'x'.repeat(900) }));
    expect(parsed?.title).toBe('mucho espacio');
    expect(parsed?.snippet).toHaveLength(500);
  });

  it('una fecha ilegible no rompe la tarjeta', () => {
    expect(parseNewsItem(item({ publishedAt: 'no-es-fecha' }))?.publishedAt).toBe('');
    expect(relativeTime('no-es-fecha', NOW)).toBe('fecha no disponible');
  });

  it('deduce el tono del score si falta la etiqueta', () => {
    expect(parseNewsItem(item({ sentiment: { score: -0.4 } }))?.sentiment.label).toBe('negativo');
    expect(parseNewsItem(item({ sentiment: { score: 0.2 } }))?.sentiment.label).toBe('positivo');
    expect(parseNewsItem(item({ sentiment: { score: 0 } }))?.sentiment.label).toBe('neutral');
    expect(parseNewsItem(item({ sentiment: {} }))?.sentiment).toEqual({ score: 0, label: 'neutral' });
  });

  it('acota el score a [-1, 1]', () => {
    expect(parseNewsItem(item({ sentiment: { score: 9, label: 'positivo' } }))?.sentiment.score).toBe(1);
    expect(parseNewsItem(item({ sentiment: { score: -9, label: 'negativo' } }))?.sentiment.score).toBe(-1);
  });
});

describe('parseNewsPayload', () => {
  it('acepta { items } y una lista pelada', () => {
    const rows = [item({ id: 'a' }), item({ id: 'b' })];
    expect(parseNewsPayload({ items: rows }).map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(parseNewsPayload(rows).map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('salta las filas inválidas y corta en el límite', () => {
    const rows = [
      item({ id: 'a' }),
      { title: '' },
      item({ id: 'b' }),
      item({ id: 'c' }),
    ];
    expect(parseNewsPayload({ items: rows }, 2).map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(parseNewsPayload({ items: rows, symbol: 'BTC' }, NEWS_LIMIT)).toHaveLength(3);
  });

  it('ante basura devuelve una lista vacía', () => {
    expect(parseNewsPayload(null)).toEqual([]);
    expect(parseNewsPayload('nope')).toEqual([]);
    expect(parseNewsPayload({ error: 'symbol_invalid' })).toEqual([]);
    expect(parseNewsPayload({ items: 'nope' })).toEqual([]);
  });
});

describe('relativeTime', () => {
  it('dice hace cuánto, en español y sin fecha que interpretar', () => {
    expect(relativeTime('2026-10-09T11:59:40.000Z', NOW)).toBe('hace 20 seg');
    expect(relativeTime('2026-10-09T11:55:00.000Z', NOW)).toBe('hace 5 min');
    expect(relativeTime('2026-10-09T09:00:00.000Z', NOW)).toBe('hace 3 h');
    expect(relativeTime('2026-10-07T12:00:00.000Z', NOW)).toBe('hace 2 d');
    expect(relativeTime('2026-09-09T12:00:00.000Z', NOW)).toBe('hace 1 mes');
  });

  it('el futuro se cuenta como ahora', () => {
    expect(relativeTime('2026-10-09T12:05:00.000Z', NOW)).toBe('ahora');
  });

  it('más allá de un mes no da precisión falsa', () => {
    expect(relativeTime('2025-01-01T00:00:00.000Z', NOW)).toBe('hace tiempo');
  });
});

describe('fetchNews', () => {
  const rows = [item({ publishedAt: '2026-10-09T11:00:00.000Z' })];

  it('pide los titulares del endpoint público', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ items: rows }), { status: 200 }));
    const result = await fetchNews('BTCUSDT', fetchImpl as unknown as typeof fetch, NOW);
    expect(result.note).toBeNull();
    expect(result.items).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledWith(newsUrl('BTCUSDT'), { headers: { Accept: 'application/json' } });
  });

  it('un símbolo sin titulares no llama a la red', async () => {
    const fetchImpl = vi.fn();
    const result = await fetchNews('SOLUSDT', fetchImpl as unknown as typeof fetch, NOW);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.items).toEqual([]);
    expect(result.note).toBe('Sin titulares para este símbolo.');
  });

  it('el servicio caído deja una nota, no una excepción', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 503 }));
    const result = await fetchNews('BTCUSDT', fetchImpl as unknown as typeof fetch, NOW);
    expect(result.items).toEqual([]);
    expect(result.note).toBe('Titulares no disponibles (503).');
  });

  it('sin red deja una nota', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    const result = await fetchNews('BTCUSDT', fetchImpl as unknown as typeof fetch, NOW);
    expect(result.items).toEqual([]);
    expect(result.note).toBe('Sin conexión con el servicio de titulares.');
  });

  it('un 200 sin titulares lo dice', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 }));
    const result = await fetchNews('BTCUSDT', fetchImpl as unknown as typeof fetch, NOW);
    expect(result.items).toEqual([]);
    expect(result.note).toBe('Sin titulares recientes.');
  });
});
