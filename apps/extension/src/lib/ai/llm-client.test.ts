import { describe, expect, it, vi } from 'vitest';
import { chat, parseModels } from './llm-client';

const KEY = 'sk-SECRET-123';

interface Call {
  url: string;
  init: RequestInit;
}

function fake(status: number, body: unknown, calls: Call[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => {
        if (body === 'BAD') throw new SyntaxError(`bad json ${KEY}`);
        return body;
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const base = { system: 'sys', user: 'usr', apiKey: KEY };

describe('chat request shapes', () => {
  it('openai kind: bearer, messages, registry url, redirect error', async () => {
    const calls: Call[] = [];
    const r = await chat(
      { ...base, provider: 'opencode', model: 'grok-code-free' },
      { fetch: fake(200, { choices: [{ message: { content: ' hola ' } }] }, calls) },
    );
    expect(r).toEqual({ ok: true, text: 'hola' });
    expect(calls[0]!.url).toBe('https://opencode.ai/inference/openai/v1/chat/completions');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.init.redirect).toBe('error');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
    expect(body.max_tokens).toBe(500);
    expect(body.temperature).toBe(0.2);
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it('anthropic kind', async () => {
    const calls: Call[] = [];
    const r = await chat(
      { ...base, provider: 'anthropic', model: 'claude-x', maxTokens: 99 },
      { fetch: fake(200, { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, calls) },
    );
    expect(r).toEqual({ ok: true, text: 'ab' });
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(KEY);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers.authorization).toBeUndefined();
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toMatchObject({ model: 'claude-x', system: 'sys', max_tokens: 99 });
    expect(body.messages).toEqual([{ role: 'user', content: 'usr' }]);
  });

  it('gemini kind: key in header, never in url', async () => {
    const calls: Call[] = [];
    const r = await chat(
      { ...base, provider: 'gemini', model: 'gemini-2.0-flash' },
      { fetch: fake(200, { candidates: [{ content: { parts: [{ text: 'x' }, { text: 'y' }] } }] }, calls) },
    );
    expect(r).toEqual({ ok: true, text: 'xy' });
    expect(calls[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    );
    expect(calls[0]!.url).not.toContain(KEY);
    expect((calls[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.contents[0].parts[0].text).toBe('usr');
    expect(body.systemInstruction.parts[0].text).toBe('sys');
    expect(body.generationConfig).toEqual({ maxOutputTokens: 500, temperature: 0.2 });
  });

  it('local works without key and sends no authorization', async () => {
    const calls: Call[] = [];
    const r = await chat(
      { provider: 'local', model: 'llama3:8b', system: 's', user: 'u' },
      { fetch: fake(200, { choices: [{ message: { content: 'ok' } }] }, calls) },
    );
    expect(r.ok).toBe(true);
    expect(calls[0]!.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });
});

describe('chat failures', () => {
  const run = (status: number, body: unknown = {}) =>
    chat({ ...base, provider: 'openai', model: 'gpt-4o' }, { fetch: fake(status, body) });

  it('no key', async () => {
    const f = vi.fn();
    const r = await chat({ provider: 'openai', model: 'gpt-4o', system: '', user: '', apiKey: '  ' }, { fetch: f as never });
    expect(r).toEqual({ ok: false, reason: 'no_key' });
    expect(f).not.toHaveBeenCalled();
  });

  it('maps statuses', async () => {
    expect(await run(401)).toEqual({ ok: false, reason: 'auth' });
    expect(await run(403)).toEqual({ ok: false, reason: 'auth' });
    expect(await run(429)).toEqual({ ok: false, reason: 'rate_limit' });
    expect(await run(500)).toEqual({ ok: false, reason: 'http_500' });
  });

  it('malformed json and wrong shape are bad_response, without leaking the key', async () => {
    const a = await run(200, 'BAD');
    expect(a).toEqual({ ok: false, reason: 'bad_response' });
    expect(await run(200, { choices: [] })).toEqual({ ok: false, reason: 'bad_response' });
    expect(await run(200, null)).toEqual({ ok: false, reason: 'bad_response' });
  });

  it('network error never leaks the key', async () => {
    const f = (async () => {
      throw new Error(`boom ${KEY}`);
    }) as unknown as typeof fetch;
    const r = await chat({ ...base, provider: 'openai', model: 'gpt-4o' }, { fetch: f });
    expect(r).toEqual({ ok: false, reason: 'net' });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('times out via abort', async () => {
    const f = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const r = await chat({ ...base, provider: 'openai', model: 'gpt-4o', timeoutMs: 10 }, { fetch: f });
    expect(r).toEqual({ ok: false, reason: 'timeout' });
  });

  it('rejects invalid model ids and unknown providers before any fetch', async () => {
    const f = vi.fn();
    for (const model of ['', 'a b', '../x', 'a?key=1', 'a#b', 'x'.repeat(81), 'm\n']) {
      expect(await chat({ ...base, provider: 'gemini', model }, { fetch: f as never })).toEqual({
        ok: false,
        reason: 'bad_response',
      });
    }
    expect(await chat({ ...base, provider: 'https://evil.test', model: 'm' }, { fetch: f as never })).toEqual({
      ok: false,
      reason: 'bad_response',
    });
    expect(f).not.toHaveBeenCalled();
  });

  it('url always comes from the registry for every provider', async () => {
    for (const [provider, prefix] of [
      ['opencode', 'https://opencode.ai/'],
      ['openrouter', 'https://openrouter.ai/'],
      ['openai', 'https://api.openai.com/'],
      ['anthropic', 'https://api.anthropic.com/'],
      ['gemini', 'https://generativelanguage.googleapis.com/'],
      ['local', 'http://127.0.0.1:11434/'],
    ] as const) {
      const calls: Call[] = [];
      await chat({ ...base, provider, model: 'm1' }, { fetch: fake(500, {}, calls) });
      expect(calls[0]!.url.startsWith(prefix)).toBe(true);
    }
  });

  it('rejects keys that cannot be a header value', async () => {
    const f = vi.fn();
    const r = await chat({ ...base, apiKey: 'a\nb', provider: 'openai', model: 'm' }, { fetch: f as never });
    expect(r).toEqual({ ok: false, reason: 'auth' });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('parseModels', () => {
  it('dedupes, sorts, filters invalid ids', () => {
    expect(
      parseModels('opencode', {
        data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }, { id: 'bad id' }, { id: 5 }, null, { nope: 1 }, { id: 'x<y>' }],
      }),
    ).toEqual(['a', 'b']);
  });

  it('caps at 200', () => {
    const data = Array.from({ length: 300 }, (_, i) => ({ id: `m${String(i).padStart(3, '0')}` }));
    const out = parseModels('openrouter', { data });
    expect(out).toHaveLength(200);
    expect(out[0]).toBe('m000');
  });

  it('handles junk', () => {
    expect(parseModels('opencode', null)).toEqual([]);
    expect(parseModels('opencode', { data: 'x' })).toEqual([]);
    expect(parseModels('opencode', [])).toEqual([]);
    expect(parseModels('evil', { data: [{ id: 'a' }] })).toEqual([]);
  });
});
