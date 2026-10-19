import { describe, expect, it, vi } from 'vitest';
import { createSignedClient, ed25519Signer, hmacSigner, AccountError, READ_ALLOWLIST } from './binance-signed';
import { base64ToBytes, generateEd25519Signing } from './vault';

const KEY_ID = 'fake-visible-marker-a';
const PASSPHRASE = 'fake-visible-marker-b';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

function splitSigned(url: string) {
  const u = new URL(url);
  const signature = u.searchParams.get('signature') ?? '';
  const raw = u.search.slice(1);
  const payload = raw.slice(0, raw.lastIndexOf('&signature='));
  return { u, signature, payload };
}

describe('cliente firmado: firmas', () => {
  it('HMAC-SHA256 hex verifica y envia la cabecera de clave', async () => {
    const fetchMock = vi.fn(async () => json({ ok: 1 }));
    const client = createSignedClient({ fetch: fetchMock as never, signer: hmacSigner(PASSPHRASE, KEY_ID), now: () => 1000 });
    await client.get('/fapi/v3/account');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const { signature, payload, u } = splitSigned(url);
    expect(signature).toBe(await hmacHex(PASSPHRASE, payload));
    expect(u.searchParams.get('recvWindow')).toBe('15000');
    expect(u.searchParams.get('timestamp')).toBe('1000');
    expect((init.headers as Record<string, string>)['X-MBX-APIKEY']).toBe(KEY_ID);
    expect(init.redirect).toBe('error');
    expect(init.method).toBe('GET');
  });

  it('Ed25519 base64 verifica con la clave publica', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    const fetchMock = vi.fn(async () => json([]));
    const client = createSignedClient({ fetch: fetchMock as never, signer: ed25519Signer(pair.privateKey, KEY_ID), now: () => 5 });
    await client.get('/fapi/v1/openOrders', { symbol: 'BTCUSDT' });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    const { signature, payload } = splitSigned(url);
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, pair.publicKey, base64ToBytes(signature) as BufferSource, new TextEncoder().encode(payload));
    expect(ok).toBe(true);
    expect(payload).toContain('symbol=BTCUSDT');
  });
});

describe('cliente firmado: lista cerrada y validacion', () => {
  const mk = () => {
    const fetchMock = vi.fn(async () => json({}));
    const client = createSignedClient({ fetch: fetchMock as never, signer: hmacSigner(PASSPHRASE, KEY_ID), now: () => 1 });
    return { fetchMock, client };
  };

  it('rutas fuera de la lista fallan antes de fetch', async () => {
    const { fetchMock, client } = mk();
    for (const p of ['/fapi/v1/order', '/fapi/v1/listenKey', '/sapi/v1/capital/withdraw/apply', '/fapi/v3/account/../order']) {
      await expect(client.get(p)).rejects.toBeInstanceOf(AccountError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(READ_ALLOWLIST).toHaveLength(8);
  });

  it('rechaza parametros no validos antes de fetch', async () => {
    const { fetchMock, client } = mk();
    const bad: Array<Record<string, string | number>> = [
      { symbol: 'btcusdt' },
      { symbol: 'BTC&x=1' },
      { symbol: 'A' },
      { limit: 0 },
      { limit: 1001 },
      { limit: 1.5 },
      { startTime: -1 },
      { endTime: Number.NaN },
      { fromId: 1.2 },
      { side: 'SELL' },
    ];
    for (const params of bad) {
      await expect(client.get('/fapi/v1/userTrades', params)).rejects.toBeInstanceOf(AccountError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    await client.get('/fapi/v1/userTrades', { symbol: 'ETHUSDT', limit: 1000, startTime: 0, fromId: 7 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('cliente firmado: errores', () => {
  it('-1021 resincroniza una vez y reintenta una vez', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes('/fapi/v1/time')) return json({ serverTime: 10_000 });
      if (calls.filter((c) => c.includes('/fapi/v3/account')).length === 1) return json({ code: -1021, msg: 'Timestamp ahead' }, 400);
      return json({ ok: true });
    });
    const client = createSignedClient({ fetch: fetchMock as never, signer: hmacSigner(PASSPHRASE, KEY_ID), now: () => 4_000 });
    await expect(client.get('/fapi/v3/account')).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    expect(calls.filter((c) => c.includes('/fapi/v1/time'))).toHaveLength(1);
    expect(new URL(calls[2]!).searchParams.get('timestamp')).toBe('10000');
  });

  it('-1021 persistente no entra en bucle', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/time') ? json({ serverTime: 1 }) : json({ code: -1021, msg: 'x' }, 400),
    );
    const client = createSignedClient({ fetch: fetchMock as never, signer: hmacSigner(PASSPHRASE, KEY_ID), now: () => 1 });
    await expect(client.get('/fapi/v3/account')).rejects.toMatchObject({ code: 'clock' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('-2015 se mapea a ip_or_perm', async () => {
    const fetchMock = vi.fn(async () => json({ code: -2015, msg: 'Invalid API-key, IP, or permissions' }, 401));
    const client = createSignedClient({ fetch: fetchMock as never, signer: hmacSigner(PASSPHRASE, KEY_ID), now: () => 1 });
    await expect(client.get('/fapi/v3/account')).rejects.toMatchObject({ code: 'ip_or_perm' });
  });

  it('fallo de red -> net; otro HTTP -> http_<status>', async () => {
    const boom = vi.fn(async (url: string) => {
      throw new Error(`failed ${url} ${KEY_ID} ${PASSPHRASE}`);
    });
    const c1 = createSignedClient({ fetch: boom as never, signer: hmacSigner(PASSPHRASE, KEY_ID), now: () => 1 });
    await expect(c1.get('/fapi/v3/account')).rejects.toMatchObject({ code: 'net' });

    const f503 = vi.fn(async () => new Response('down', { status: 503 }));
    const c2 = createSignedClient({ fetch: f503 as never, signer: hmacSigner(PASSPHRASE, KEY_ID), now: () => 1 });
    await expect(c2.get('/fapi/v3/account')).rejects.toMatchObject({ code: 'http_503' });
  });

  it('los errores nunca contienen clave, secreto ni firma', async () => {
    let sentUrl = '';
    const fetchMock = vi.fn(async (url: string) => {
      sentUrl = url;
      return json({ code: -1100, msg: `bad ${KEY_ID} ${PASSPHRASE} ${url}` }, 400);
    });
    const client = createSignedClient({ fetch: fetchMock as never, signer: hmacSigner(PASSPHRASE, KEY_ID), now: () => 1 });
    const err = (await client.get('/fapi/v3/account').catch((e) => e)) as AccountError;
    const signature = splitSigned(sentUrl).signature;
    const dump = `${err.message} ${err.code} ${String(err.stack)} ${JSON.stringify(err)}`;
    expect(signature.length).toBeGreaterThan(10);
    for (const s of [KEY_ID, PASSPHRASE, signature]) expect(dump).not.toContain(s);
  });
});

describe('generateEd25519Signing', () => {
  it('la clave generada firma y no se puede exportar', async () => {
    const { privateKey } = await generateEd25519Signing();
    const client = createSignedClient({ fetch: (async () => json({})) as never, signer: ed25519Signer(privateKey, KEY_ID), now: () => 1 });
    await expect(client.get('/fapi/v3/account')).resolves.toEqual({});
  });
});
