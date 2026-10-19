// Cliente firmado de SOLO LECTURA para Binance Futures. Lista cerrada de rutas, solo GET.
// Nunca incluye la clave API, el secreto ni la firma en errores.
import { bytesToBase64 } from './vault';

export const READ_ALLOWLIST = [
  '/fapi/v1/time',
  '/fapi/v2/positionRisk',
  '/fapi/v3/account',
  '/fapi/v1/openOrders',
  '/fapi/v1/openAlgoOrders',
  '/fapi/v1/userTrades',
  '/fapi/v1/income',
  '/fapi/v1/premiumIndex',
] as const;

export const RECV_WINDOW = 15000;
const DEFAULT_BASE = 'https://fapi.binance.com';
const TIME_PATH = '/fapi/v1/time';

export type AccountErrorCode = 'ip_or_perm' | 'net' | 'bad_request' | 'clock' | `http_${number}`;

export class AccountError extends Error {
  readonly code: AccountErrorCode;
  constructor(code: AccountErrorCode, message: string) {
    super(message);
    this.name = 'AccountError';
    this.code = code;
  }
}

export interface Signer {
  apiKey: string;
  /** Firma el query string tal cual se envia (sin la firma). */
  sign(payload: string): Promise<string>;
  /** Textos que jamas deben aparecer en un error. */
  secrets: readonly string[];
}

export function ed25519Signer(privateKey: CryptoKey, apiKey: string): Signer {
  return {
    apiKey,
    secrets: [apiKey],
    async sign(payload) {
      const sig = await crypto.subtle.sign(
        { name: 'Ed25519' },
        privateKey,
        new TextEncoder().encode(payload),
      );
      return bytesToBase64(new Uint8Array(sig));
    },
  };
}

export function hmacSigner(secret: string, apiKey: string): Signer {
  return {
    apiKey,
    secrets: [apiKey, secret],
    async sign(payload) {
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const sig = new Uint8Array(
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)),
      );
      return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
    },
  };
}

export type Params = Record<string, string | number | undefined>;

export interface SignedClientOptions {
  fetch: typeof fetch;
  signer: Signer;
  now: () => number;
  baseUrl?: string;
}

export interface SignedClient {
  get(path: string, params?: Params): Promise<unknown>;
}

const NON_NEG_INT = ['startTime', 'endTime', 'fromId'];

function validateParams(params: Params): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [name, raw] of Object.entries(params)) {
    if (raw === undefined) continue;
    if (name === 'symbol') {
      if (typeof raw !== 'string' || !/^[A-Z0-9]{2,20}$/.test(raw)) {
        throw new AccountError('bad_request', 'parametro symbol no valido');
      }
    } else if (NON_NEG_INT.includes(name)) {
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
        throw new AccountError('bad_request', `parametro ${name} no valido`);
      }
    } else if (name === 'limit') {
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 1000) {
        throw new AccountError('bad_request', 'parametro limit no valido');
      }
    } else if (name === 'incomeType') {
      if (typeof raw !== 'string' || !/^[A-Z_]{2,40}$/.test(raw)) {
        throw new AccountError('bad_request', 'parametro incomeType no valido');
      }
    } else {
      throw new AccountError('bad_request', `parametro ${name} no permitido`);
    }
    out.push([name, String(raw)]);
  }
  return out;
}

function redact(text: string, secrets: readonly string[]): string {
  let out = text.replace(/https?:\/\/[^\s)]+/g, '[url]').replace(/signature=[^&\s]*/gi, 'signature=[redacted]');
  for (const s of secrets) {
    if (s.length > 0) out = out.split(s).join('[redacted]');
  }
  return out.slice(0, 200);
}

export function createSignedClient(opts: SignedClientOptions): SignedClient {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE;
  const { signer } = opts;
  let offsetMs = 0;

  async function request(url: string, headers: Record<string, string>): Promise<Response> {
    try {
      return await opts.fetch(url, { method: 'GET', headers, redirect: 'error' });
    } catch {
      // El error original puede llevar la URL firmada: se descarta.
      throw new AccountError('net', 'fallo de red');
    }
  }

  async function readJson(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }

  async function resync(): Promise<void> {
    const res = await request(`${baseUrl}${TIME_PATH}`, {});
    if (!res.ok) throw new AccountError(`http_${res.status}`, `HTTP ${res.status} en time`);
    const body = (await readJson(res)) as { serverTime?: unknown } | undefined;
    const server = Number(body?.serverTime);
    if (!Number.isFinite(server)) throw new AccountError('clock', 'hora del servidor no valida');
    offsetMs = server - opts.now();
  }

  async function signedOnce(
    path: string,
    pairs: Array<[string, string]>,
  ): Promise<{ res: Response; body: unknown }> {
    const all: Array<[string, string]> = [
      ...pairs,
      ['recvWindow', String(RECV_WINDOW)],
      ['timestamp', String(Math.trunc(opts.now() + offsetMs))],
    ];
    const query = all.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const signature = await signer.sign(query);
    const url = `${baseUrl}${path}?${query}&signature=${encodeURIComponent(signature)}`;
    const res = await request(url, { 'X-MBX-APIKEY': signer.apiKey });
    return { res, body: await readJson(res) };
  }

  function binanceCode(body: unknown): number | undefined {
    if (body && typeof body === 'object' && 'code' in body) {
      const code = Number((body as { code: unknown }).code);
      return Number.isFinite(code) ? code : undefined;
    }
    return undefined;
  }

  function fail(res: Response, body: unknown, secrets: readonly string[]): never {
    const code = binanceCode(body);
    if (code === -2015) {
      throw new AccountError('ip_or_perm', 'clave, IP o permisos no validos');
    }
    const msg =
      body && typeof body === 'object' && typeof (body as { msg?: unknown }).msg === 'string'
        ? redact((body as { msg: string }).msg, secrets)
        : '';
    throw new AccountError(`http_${res.status}`, `HTTP ${res.status}${code !== undefined ? ` (${code})` : ''}${msg ? `: ${msg}` : ''}`);
  }

  return {
    async get(path, params = {}) {
      // Todo se valida ANTES de llamar a fetch.
      if (!(READ_ALLOWLIST as readonly string[]).includes(path)) {
        throw new AccountError('bad_request', 'ruta no permitida');
      }
      const pairs = validateParams(params);

      if (path === TIME_PATH) {
        const res = await request(`${baseUrl}${path}`, {});
        const body = await readJson(res);
        if (!res.ok) fail(res, body, signer.secrets);
        return body;
      }

      let attempt = await signedOnce(path, pairs);
      if (!attempt.res.ok && binanceCode(attempt.body) === -1021) {
        await resync();
        attempt = await signedOnce(path, pairs);
      }
      if (!attempt.res.ok) {
        if (binanceCode(attempt.body) === -1021) {
          throw new AccountError('clock', 'reloj desfasado respecto a Binance');
        }
        fail(attempt.res, attempt.body, signer.secrets);
      }
      return attempt.body;
    },
  };
}
