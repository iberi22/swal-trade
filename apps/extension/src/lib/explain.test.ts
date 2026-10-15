import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXPLAIN_CACHE_MS,
  EXPLAIN_DISCLAIMER,
  EXPLAIN_ENDPOINT,
  EXPLAIN_MAX_FINDINGS,
  EXPLAIN_OPT_IN_NOTE,
  explainCacheKey,
  explainPatterns,
  explainReasonText,
  explainRequestFrom,
  localFallbackExplain,
  parseExplainResponse,
  resetExplainCache,
  safeText,
} from './explain';
import type { AnalysisResult, Finding } from './types';

const NOW = Date.parse('2026-10-15T12:00:00.000Z');

function finding(partial: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    kind: 'double_bottom',
    label: 'Doble suelo',
    explanation: 'Dos mínimos similares con el cuello roto.',
    from: 1,
    to: 2,
    levels: [{ role: 'neck', price: 100, confirm: 101, invalidate: 98 }],
    direction: 'up',
    strength: 0.62,
    status: 'confirmed',
    evidence: null,
    ...partial,
  };
}

function result(partial: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    findings: [],
    top: [finding()],
    trend: 'Tendencia alcista suave',
    levels: [98, 100],
    generatedAt: '2026-10-15T11:59:00.000Z',
    ...partial,
  };
}

function input(overrides: Partial<Parameters<typeof explainPatterns>[0]> = {}) {
  return { symbol: 'BTCUSDT', timeframe: '1h', result: result(), enabled: true, ...overrides };
}

function jsonFetch(payload: unknown, status = 200) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

function aiPayload(partial: Record<string, unknown> = {}) {
  return {
    source: 'ai',
    summary: 'El análisis ve un doble suelo formándose cerca del soporte.',
    scenarios: [
      {
        name: 'Doble suelo',
        condition: 'Se confirma con un cierre por encima de 101.',
        invalidation: 'Deja de valer con un cierre por debajo de 98.',
        risk_note: 'Stop detrás de 98 y tamaño pequeño.',
      },
    ],
    caution: 'La fuerza del patrón no es una tasa de acierto.',
    ...partial,
  };
}

beforeEach(() => {
  resetExplainCache();
});

describe('explainRequestFrom / caché', () => {
  it('manda solo el análisis: símbolo, temporalidad, top, tendencia y niveles', () => {
    const request = explainRequestFrom({ symbol: 'btcusdt', timeframe: '1h', result: result() });
    expect(request.symbol).toBe('BTCUSDT');
    expect(Object.keys(request).sort()).toEqual(['analysis', 'symbol', 'timeframe']);
    expect(Object.keys(request.analysis).sort()).toEqual(['levels', 'top', 'trend']);
    expect(request.analysis.top[0]).toMatchObject({ id: 'f1', direction: 'up', strength: 0.62 });
    expect(request.analysis.top[0]!.levels[0]).toEqual({
      role: 'neck',
      price: 100,
      confirm: 101,
      invalidate: 98,
    });
    expect(request.analysis.trend).toEqual({
      direction: 'up',
      strength: 0,
      label: 'Tendencia alcista suave',
    });
    expect(request.analysis.levels).toEqual([{ price: 98 }, { price: 100 }]);
  });

  it('corta el top en 5, usa findings si top viene vacío y no inventa tendencia', () => {
    const many = Array.from({ length: 9 }, (_, i) => finding({ id: `f${i}` }));
    expect(
      explainRequestFrom({ symbol: 'ETHUSDT', timeframe: '5m', result: result({ top: many }) }).analysis.top,
    ).toHaveLength(EXPLAIN_MAX_FINDINGS);
    const fallback = explainRequestFrom({
      symbol: 'ETHUSDT',
      timeframe: '5m',
      result: result({ top: [], findings: [finding()], trend: null }),
    });
    expect(fallback.analysis.top).toHaveLength(1);
    expect(fallback.analysis.trend).toBeNull();
  });

  it('la clave de caché cambia con los hallazgos', () => {
    const base = explainRequestFrom({ symbol: 'BTCUSDT', timeframe: '1h', result: result() });
    const other = explainRequestFrom({
      symbol: 'BTCUSDT',
      timeframe: '1h',
      result: result({ top: [finding({ id: 'f2', strength: 0.2 })] }),
    });
    expect(explainCacheKey(base)).toContain('BTCUSDT@1h');
    expect(explainCacheKey(base)).not.toBe(explainCacheKey(other));
  });
});

describe('safeText / parseExplainResponse', () => {
  it('quita ángulos y control, y corta al tope', () => {
    expect(safeText('<img src=x onerror=alert(1)>Hola', 100)).toBe('img src=x onerror=alert(1)Hola');
    expect(safeText('a\u0000b\n\nc', 100)).toBe('a b c');
    expect(safeText('x'.repeat(900), 600)).toHaveLength(600);
    expect(safeText(42, 100)).toBe('');
  });

  it('sanea longitudes, descarta escenarios sin nombre y rechaza sin contenido', () => {
    const parsed = parseExplainResponse({
      source: 'ai',
      summary: 'S'.repeat(5000),
      scenarios: [
        ...Array.from({ length: 9 }, (_, i) => ({
          name: `<b>Patrón ${i}</b>`,
          condition: 'C'.repeat(900),
          invalidation: 'I'.repeat(900),
          risk_note: 'R'.repeat(900),
        })),
        { name: '' },
        { name: '<script>alert(1)</script>' },
      ],
      caution: 'Aviso',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.view.summary).toHaveLength(600);
    expect(parsed.view.scenarios).toHaveLength(5);
    expect(parsed.view.scenarios[0]!.name).toBe('bPatrón 0/b');
    expect(parsed.view.scenarios[0]!.condition).toHaveLength(400);
    expect(JSON.stringify(parsed.view)).not.toContain('<script>');

    expect(parseExplainResponse(null)).toEqual({ ok: false, error: 'invalid_payload' });
    expect(parseExplainResponse({ summary: '', scenarios: [] }).ok).toBe(false);
    expect(parseExplainResponse({ source: 'evil', summary: 'hola' }).ok).toBe(false);
    expect(parseExplainResponse({ source: 'fallback', summary: 'hola', reason: 'daily_cap' }).ok).toBe(true);
  });

  it('el motivo corto se traduce al español', () => {
    expect(explainReasonText('rate_limited')).toBe('límite por hora alcanzado');
    expect(explainReasonText('offline')).toBe('sin conexión');
    expect(explainReasonText('symbol_invalid')).toContain('reglas fijas');
    expect(explainReasonText('')).toBe('');
  });
});

describe('explainPatterns', () => {
  it('con el interruptor apagado no toca la red y explica en local', async () => {
    const fetchImpl = vi.fn(() => {
      throw new Error('no debería llamarse');
    });
    const view = await explainPatterns(input({ enabled: false }), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(view).toMatchObject({ local: true, source: 'fallback', fromCache: false });
    expect(view.reason).toBe('explicaciones con IA desactivadas');
    expect(view.summary).toContain('Doble suelo');
    expect(EXPLAIN_DISCLAIMER).toBe('Explicación educativa. No es una recomendación de compra o venta.');
    expect(EXPLAIN_OPT_IN_NOTE).toContain('nunca datos de tu cuenta');
  });

  it('200 válido: pinta summary, escenarios y aviso', async () => {
    const fetchImpl = jsonFetch(aiPayload());
    const view = await explainPatterns(input(), { fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: NOW });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(EXPLAIN_ENDPOINT);
    expect(JSON.parse(String(init.body))).toEqual(explainRequestFrom({ ...input() }));
    expect(view).toMatchObject({ source: 'ai', local: false, reason: '' });
    expect(view.scenarios[0]).toEqual({
      name: 'Doble suelo',
      condition: 'Se confirma con un cierre por encima de 101.',
      invalidation: 'Deja de valer con un cierre por debajo de 98.',
      riskNote: 'Stop detrás de 98 y tamaño pequeño.',
    });
  });

  it('429: respaldo local con «límite por hora alcanzado» y sin cachear', async () => {
    const fetchImpl = jsonFetch({ error: 'rate_limited', retryAfterS: 3600 }, 429);
    const view = await explainPatterns(input(), { fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: NOW });
    expect(view).toMatchObject({ local: true, reason: 'límite por hora alcanzado' });
    await explainPatterns(input(), { fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: NOW });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('timeout: aborta a los 15 s y cae al respaldo local', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const view = await explainPatterns(input(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 10,
      nowMs: NOW,
    });
    expect(view).toMatchObject({ local: true, reason: 'tiempo de espera agotado' });
  });

  it('sin conexión y JSON inválido: respaldo local, nunca una excepción', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect((await explainPatterns(input(), { fetchImpl: offline as unknown as typeof fetch, nowMs: NOW })).reason).toBe(
      'sin conexión',
    );
    const broken = vi.fn(async () => new Response('no soy json', { status: 200 }));
    const brokenView = await explainPatterns(input(), { fetchImpl: broken as unknown as typeof fetch, nowMs: NOW });
    expect(brokenView.reason).toBe('respuesta no válida del servicio');
    expect(brokenView.scenarios[0]!.name).toBe('Doble suelo');
  });

  it('HTML dentro del texto se pinta como texto, sin marcado', async () => {
    const fetchImpl = jsonFetch(
      aiPayload({
        summary: '<img src=x onerror="alert(1)"> Cuidado con <b>esto</b>',
        scenarios: [{ name: '<svg onload=alert(1)>Ruptura</svg>', condition: 'c', invalidation: 'i', risk_note: 'r' }],
      }),
    );
    const view = await explainPatterns(input(), { fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: NOW });
    expect(view.summary).not.toMatch(/[<>]/);
    expect(view.scenarios[0]!.name).not.toMatch(/[<>]/);
  });

  it('cachea por (símbolo, temporalidad, hallazgos) durante 5 minutos', async () => {
    const fetchImpl = jsonFetch(aiPayload());
    const fetchLike = fetchImpl as unknown as typeof fetch;
    expect((await explainPatterns(input(), { fetchImpl: fetchLike, nowMs: NOW })).fromCache).toBe(false);
    expect((await explainPatterns(input(), { fetchImpl: fetchLike, nowMs: NOW + 60_000 })).fromCache).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await explainPatterns(input(), { fetchImpl: fetchLike, nowMs: NOW + EXPLAIN_CACHE_MS + 1 });
    await explainPatterns(input({ symbol: 'ETHUSDT' }), { fetchImpl: fetchLike, nowMs: NOW + 1000 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('una sola petición en vuelo a la vez', async () => {
    let active = 0;
    let maxActive = 0;
    const body = JSON.stringify(aiPayload());
    const fetchImpl = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const fetchLike = fetchImpl as unknown as typeof fetch;
    const [a, b] = await Promise.all([
      explainPatterns(input(), { fetchImpl: fetchLike, nowMs: NOW }),
      explainPatterns(input(), { fetchImpl: fetchLike, nowMs: NOW }),
    ]);
    expect(a).toEqual(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await Promise.all([
      explainPatterns(input({ timeframe: '4h' }), { fetchImpl: fetchLike, nowMs: NOW }),
      explainPatterns(input({ timeframe: '1d' }), { fetchImpl: fetchLike, nowMs: NOW }),
    ]);
    expect(maxActive).toBe(1);
  });

  it('respuesta demasiado grande no rompe: se corta a los topes', async () => {
    const fetchImpl = jsonFetch(
      aiPayload({
        summary: 'Largo '.repeat(2000),
        scenarios: Array.from({ length: 20 }, (_, i) => ({
          name: `Patrón ${i}`,
          condition: 'C'.repeat(2000),
          invalidation: 'I'.repeat(2000),
          risk_note: 'R'.repeat(2000),
        })),
      }),
    );
    const view = await explainPatterns(input(), { fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: NOW });
    expect(view.summary.length).toBeLessThanOrEqual(600);
    expect(view.scenarios).toHaveLength(5);
    expect(view.scenarios[0]!.condition.length).toBeLessThanOrEqual(400);
  });
});

describe('localFallbackExplain', () => {
  it('sin patrones explica que no hay escenario; con patrones opuestos avisa', () => {
    const empty = localFallbackExplain(
      explainRequestFrom({ symbol: 'BTCUSDT', timeframe: '1h', result: result({ top: [], findings: [] }) }),
      'invalid_payload',
    );
    expect(empty.summary).toContain('no ve patrones claros');
    expect(empty.scenarios).toHaveLength(0);
    expect(empty.reason).toBe('respuesta no válida del servicio');

    const conflict = localFallbackExplain(
      explainRequestFrom({
        symbol: 'BTCUSDT',
        timeframe: '1h',
        result: result({
          top: [
            finding({ id: 'a', direction: 'up' }),
            finding({ id: 'b', direction: 'down', label: 'Doble techo' }),
          ],
        }),
      }),
      'offline',
    );
    expect(conflict.summary).toContain('no señalan todos en la misma dirección');
    expect(conflict.scenarios[0]!.condition).toContain('por encima de 101');
    expect(conflict.caution).not.toMatch(/probabilidad/i);
  });
});

describe('explainPatterns: una sola petición en vuelo', () => {
  it('tres llamadas con claves distintas nunca mandan dos POST a la vez', async () => {
    let active = 0;
    let maxActive = 0;
    const fetchImpl = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response(JSON.stringify(aiPayload()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const deps = { fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: NOW };
    await Promise.all([
      explainPatterns(input({ timeframe: '1h' }), deps),
      explainPatterns(input({ timeframe: '4h' }), deps),
      explainPatterns(input({ timeframe: '15m' }), deps),
    ]);
    expect(maxActive).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
