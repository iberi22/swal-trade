/**
 * Enrutador PURO de los mensajes privilegiados (cuenta e IA) del service worker.
 * Todo lo que toca el navegador (fetch, boveda, reloj, almacenamiento) llega por
 * `deps`. Las respuestas jamas llevan una clave ni un secreto: solo
 * `{configured, kind, last4}` y codigos de error fijos.
 */
import { isPrivilegedType, parsePrivilegedMessage, type PrivilegedMessage } from '../messages';
import {
  AccountError,
  ed25519Signer,
  hmacSigner,
  RECV_WINDOW,
  type SignedClient,
  type Signer,
} from '../account/binance-signed';
import { parsePositions } from '../account/positions';
import type { AccountSnapshot } from '../account/types';
import {
  generateEd25519Signing,
  generateWrappingKey,
  openSecret,
  sealSecret,
  type SealedSecret,
  type Vault,
} from '../account/vault';
import { buildUserMessage, parseAiAnswer } from '../ai/prompt';
import { buildSystemPrompt, normalizePromptConfig, PROMPT_CONFIG_KEY } from '../ai/prompt-config';
import { serializeForLlm, type AiHistoryPayload, type AiPositionPayload } from '../ai/payload';
import { parseModels, type ChatRequest, type ChatResult } from '../ai/llm-client';
import { getProvider, PROVIDERS } from '../ai/providers';
import { resolveLocale } from '../i18n/locales';
import type { ExtensionSettings } from '../settings';

export type Reply = Record<string, unknown>;

export interface SenderInfo {
  id?: string;
  url?: string;
  tab?: unknown;
}

export interface KeyValueStore {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface RouterDeps {
  /** Id de la extension (`runtime.id`). */
  runtimeId: string;
  /** URL base de la extension (`runtime.getURL('/')`). */
  extensionUrl: string;
  vault: Vault;
  now: () => number;
  fetch: typeof fetch;
  makeClient: (signer: Signer) => SignedClient;
  chat: (request: ChatRequest) => Promise<ChatResult>;
  loadSettings: () => Promise<ExtensionSettings>;
  /** storage.local: cache de modelos y prompt configurado. */
  cache: KeyValueStore;
  /** Claves de IA solo de sesion (storage.session o memoria). */
  session: KeyValueStore;
  /** Idiomas del navegador, para resolver el idioma del panel cuando es 'auto'. */
  uiLanguages?: () => readonly string[];
}

export const SNAPSHOT_TTL_MS = 5_000;
export const MODELS_TTL_MS = 24 * 60 * 60 * 1000;

const FAPI = 'https://fapi.binance.com';
const SAPI_RESTRICTIONS = 'https://api.binance.com/sapi/v1/account/apiRestrictions';
const FORBIDDEN = { error: 'forbidden' } as const;

const K_WRAP = 'wrap';
const K_META = 'acct:meta';
const K_API = 'acct:apikey';
const K_HMAC = 'acct:hmac';
const K_ED = 'acct:ed25519';
const aiKeyName = (provider: string) => `ai:key:${provider}`;

interface Meta {
  kind: 'ed25519' | 'hmac';
  last4: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function errCode(e: unknown): string {
  return e instanceof AccountError ? e.code : 'net';
}

export function createRouter(deps: RouterDeps) {
  const extUrl = deps.extensionUrl.endsWith('/') ? deps.extensionUrl : `${deps.extensionUrl}/`;
  const snapshotCache = new Map<string, { at: number; reply: Reply }>();

  /** Guarda de remitente: solo el panel de la propia extension. */
  function senderAllowed(sender: SenderInfo | undefined): boolean {
    return Boolean(
      sender &&
        sender.id === deps.runtimeId &&
        !sender.tab &&
        typeof sender.url === 'string' &&
        sender.url.startsWith(extUrl),
    );
  }

  async function wrappingKey(create: boolean): Promise<CryptoKey | null> {
    const existing = await deps.vault.get(K_WRAP);
    if (existing) return existing as CryptoKey;
    if (!create) return null;
    const key = await generateWrappingKey();
    await deps.vault.put(K_WRAP, key);
    return key;
  }

  async function readMeta(): Promise<Meta | null> {
    const raw = await deps.vault.get(K_META);
    if (!isRecord(raw)) return null;
    if ((raw.kind !== 'ed25519' && raw.kind !== 'hmac') || typeof raw.last4 !== 'string') return null;
    return { kind: raw.kind, last4: raw.last4 };
  }

  async function loadSigner(): Promise<Signer | null> {
    try {
      const meta = await readMeta();
      const wrap = await wrappingKey(false);
      const sealedKey = await deps.vault.get(K_API);
      if (!meta || !wrap || !sealedKey) return null;
      const apiKey = await openSecret(sealedKey as SealedSecret, wrap);
      if (meta.kind === 'ed25519') {
        const priv = await deps.vault.get(K_ED);
        return priv ? ed25519Signer(priv as CryptoKey, apiKey) : null;
      }
      const sealedSecret = await deps.vault.get(K_HMAC);
      if (!sealedSecret) return null;
      return hmacSigner(await openSecret(sealedSecret as SealedSecret, wrap), apiKey);
    } catch {
      return null;
    }
  }

  // --- cuenta ---------------------------------------------------------

  async function snapshot(symbol: string): Promise<Reply> {
    const now = deps.now();
    const hit = snapshotCache.get(symbol);
    if (hit && now - hit.at >= 0 && now - hit.at < SNAPSHOT_TTL_MS) return hit.reply;

    const none = (error: string): Reply => ({ snapshot: null, source: 'none', fetchedAt: now, error });
    const signer = await loadSigner();
    if (!signer) return none('no_key');
    const client = deps.makeClient(signer);
    try {
      const [risk, orders, algo, account] = await Promise.all([
        client.get('/fapi/v2/positionRisk', { symbol }),
        client.get('/fapi/v1/openOrders', { symbol }),
        client.get('/fapi/v1/openAlgoOrders', { symbol }),
        client.get('/fapi/v3/account'),
      ]);
      let fundingRate: number | null = null;
      let nextFundingMs: number | null = null;
      try {
        const res = await deps.fetch(`${FAPI}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`, {
          method: 'GET',
          redirect: 'error',
          credentials: 'omit',
        });
        if (res.ok) {
          const body: unknown = await res.json();
          if (isRecord(body)) {
            const rate = Number(body.lastFundingRate);
            const next = Number(body.nextFundingTime);
            fundingRate = Number.isFinite(rate) ? rate : null;
            nextFundingMs = Number.isFinite(next) && next > 0 ? next : null;
          }
        }
      } catch {
        // el funding es opcional
      }
      const equityRaw = isRecord(account) ? Number(account.totalMarginBalance) : NaN;
      const snap: AccountSnapshot = {
        fetchedAt: now,
        equity: Number.isFinite(equityRaw) ? equityRaw : null,
        dailyPnl: null,
        positions: parsePositions(
          Array.isArray(risk) ? risk : [],
          Array.isArray(orders) ? orders : [],
          Array.isArray(algo) ? algo : [],
        ),
        fundingRate,
        nextFundingMs,
      };
      const reply: Reply = { snapshot: snap, source: 'api', fetchedAt: now };
      snapshotCache.set(symbol, { at: now, reply });
      return reply;
    } catch (e) {
      return none(errCode(e));
    }
  }

  async function acctGet(path: string, params: Record<string, string | number | undefined>): Promise<Reply> {
    const signer = await loadSigner();
    if (!signer) return { error: 'no_key' };
    try {
      return { data: await deps.makeClient(signer).get(path, params) };
    } catch (e) {
      return { error: errCode(e) };
    }
  }

  async function genEd25519(): Promise<Reply> {
    try {
      const { privateKey, publicPem } = await generateEd25519Signing();
      await deps.vault.put(K_ED, privateKey);
      return { publicPem };
    } catch {
      return { error: 'unsupported' };
    }
  }

  async function setKey(m: Extract<PrivilegedMessage, { type: 'acct:set-key' }>): Promise<Reply> {
    try {
      if (m.kind === 'ed25519' && !(await deps.vault.get(K_ED))) return { error: 'no_private_key' };
      const wrap = await wrappingKey(true);
      if (!wrap) return { error: 'vault' };
      await deps.vault.put(K_API, await sealSecret(m.apiKey, wrap));
      if (m.kind === 'hmac') {
        await deps.vault.put(K_HMAC, await sealSecret(m.hmacSecret ?? '', wrap));
        await deps.vault.delete(K_ED);
      } else {
        await deps.vault.delete(K_HMAC);
      }
      await deps.vault.put(K_META, { kind: m.kind, last4: m.apiKey.slice(-4) });
      snapshotCache.clear();
      return { ok: true };
    } catch {
      return { error: 'vault' };
    }
  }

  async function testKey(): Promise<Reply> {
    const signer = await loadSigner();
    if (!signer) return { ok: false, error: 'no_key' };
    try {
      const query = `recvWindow=${RECV_WINDOW}&timestamp=${Math.trunc(deps.now())}`;
      const signature = await signer.sign(query);
      let res: Response;
      try {
        res = await deps.fetch(`${SAPI_RESTRICTIONS}?${query}&signature=${encodeURIComponent(signature)}`, {
          method: 'GET',
          headers: { 'X-MBX-APIKEY': signer.apiKey },
          redirect: 'error',
          credentials: 'omit',
        });
      } catch {
        return { ok: false, error: 'net' };
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      if (!res.ok) {
        const code = isRecord(body) ? Number(body.code) : NaN;
        if (code === -2015) return { ok: false, error: 'ip_or_perm' };
        if (code === -1021) return { ok: false, error: 'clock' };
        return { ok: false, error: `http_${res.status}` };
      }
      if (!isRecord(body) || typeof body.enableWithdrawals !== 'boolean' || typeof body.enableFutures !== 'boolean') {
        return { ok: false, error: 'bad_response' };
      }
      // Retiros: nunca. Futuros: Binance suele exigir ese permiso aunque solo se lea, asi que no se
      // rechaza; se avisa (tradingEnabled) y la extension solo tiene rutas de lectura en su lista.
      if (body.enableWithdrawals) {
        return { ok: false, error: 'key_has_trading_or_withdraw' };
      }
      return {
        ok: true,
        restrictions: {
          ipRestrict: body.ipRestrict === true,
          enableReading: body.enableReading === true,
          tradingEnabled: body.enableFutures === true,
        },
      };
    } catch {
      return { ok: false, error: 'net' };
    }
  }

  async function clearAcct(): Promise<Reply> {
    try {
      for (const k of [K_API, K_HMAC, K_ED, K_META]) await deps.vault.delete(k);
      snapshotCache.clear();
      return { ok: true };
    } catch {
      return { error: 'vault' };
    }
  }

  async function acctMeta(): Promise<Reply> {
    const meta = await readMeta().catch(() => null);
    return meta
      ? { configured: true, kind: meta.kind, last4: meta.last4 }
      : { configured: false, kind: 'none', last4: '' };
  }

  // --- IA -------------------------------------------------------------

  async function aiKey(provider: string): Promise<string | undefined> {
    const session = await deps.session.get(aiKeyName(provider));
    if (typeof session === 'string' && session) return session;
    try {
      const sealed = await deps.vault.get(aiKeyName(provider));
      const wrap = await wrappingKey(false);
      if (sealed && wrap) return await openSecret(sealed as SealedSecret, wrap);
    } catch {
      // clave ilegible: se trata como ausente
    }
    return undefined;
  }

  async function aiSetKey(m: Extract<PrivilegedMessage, { type: 'ai:set-key' }>): Promise<Reply> {
    if (!getProvider(m.provider)) return { error: 'bad_request' };
    try {
      if (m.persist === 'session') {
        await deps.vault.delete(aiKeyName(m.provider));
        await deps.session.set(aiKeyName(m.provider), m.key);
      } else {
        const wrap = await wrappingKey(true);
        if (!wrap) return { error: 'vault' };
        await deps.vault.put(aiKeyName(m.provider), await sealSecret(m.key, wrap));
        await deps.session.remove(aiKeyName(m.provider));
      }
      return { ok: true };
    } catch {
      return { error: 'vault' };
    }
  }

  async function aiClear(provider?: string): Promise<Reply> {
    if (provider !== undefined && !getProvider(provider)) return { error: 'bad_request' };
    try {
      const ids = provider ? [provider] : PROVIDERS.map((p) => p.id as string);
      for (const id of ids) {
        await deps.vault.delete(aiKeyName(id));
        await deps.session.remove(aiKeyName(id));
      }
      return { ok: true };
    } catch {
      return { error: 'vault' };
    }
  }

  async function aiModels(providerId: string): Promise<Reply> {
    const provider = getProvider(providerId);
    if (!provider) return { models: [], error: 'bad_request' };
    if (!provider.modelsUrl) return { models: [], error: 'no_models_url' };
    const cacheKey = `models:${provider.id}`;
    const now = deps.now();
    const cached = await deps.cache.get(cacheKey).catch(() => undefined);
    if (
      isRecord(cached) &&
      typeof cached.at === 'number' &&
      Array.isArray(cached.models) &&
      now - cached.at >= 0 &&
      now - cached.at < MODELS_TTL_MS
    ) {
      return { models: cached.models };
    }
    try {
      const key = await aiKey(provider.id);
      const headers: Record<string, string> = {};
      if (key && /^[\x21-\x7e]+$/.test(key)) {
        if (provider.kind === 'anthropic') headers['x-api-key'] = key;
        else headers.authorization = `Bearer ${key}`;
      }
      const res = await deps.fetch(provider.modelsUrl, {
        method: 'GET',
        headers,
        redirect: 'error',
        credentials: 'omit',
      });
      if (!res.ok) return { models: [], error: `http_${res.status}` };
      const models = parseModels(provider.id, await res.json());
      await deps.cache.set(cacheKey, { at: now, models }).catch(() => {});
      return { models };
    } catch {
      return { models: [], error: 'net' };
    }
  }

  async function aiAnalyze(m: Extract<PrivilegedMessage, { type: 'ai:analyze' }>): Promise<Reply> {
    const provider = getProvider(m.provider);
    if (!provider) return { view: null, reason: 'bad_response' };
    const schema = m.payload.schema;
    if (schema !== 'swal.position.v1' && schema !== 'swal.history.v1') {
      return { view: null, reason: 'bad_payload' };
    }
    let settings: ExtensionSettings;
    try {
      settings = await deps.loadSettings();
    } catch {
      return { view: null, reason: 'no_consent' };
    }
    if (!(settings.ai.consentedProviders as readonly string[]).includes(provider.id)) {
      return { view: null, reason: 'no_consent' };
    }
    let serialized: string;
    try {
      // Se vuelve a serializar aqui: jamas se confia en un texto que venga del panel.
      serialized = serializeForLlm(m.payload as unknown as AiPositionPayload | AiHistoryPayload);
    } catch {
      return { view: null, reason: 'bad_payload' };
    }
    const apiKey = await aiKey(provider.id);
    // El prompt editable vive en storage.local; el marco de seguridad lo pone
    // siempre `buildSystemPrompt` al final, no el contenido guardado.
    let config = normalizePromptConfig(undefined);
    try {
      config = normalizePromptConfig(await deps.cache.get(PROMPT_CONFIG_KEY));
    } catch {
      // Sin lectura, prompt por defecto.
    }
    const uiLocale = resolveLocale(settings.locale, deps.uiLanguages?.() ?? []);
    const result = await deps.chat({
      provider: provider.id,
      model: m.model,
      system: buildSystemPrompt(config, uiLocale),
      user: buildUserMessage(serialized),
      apiKey,
    });
    if (!result.ok) return { view: null, reason: result.reason };
    return { view: parseAiAnswer(result.text) };
  }

  async function dispatch(m: PrivilegedMessage): Promise<Reply> {
    switch (m.type) {
      case 'acct:snapshot':
        return snapshot(m.symbol);
      case 'acct:get':
        return acctGet(m.path, m.params);
      case 'acct:gen-ed25519':
        return genEd25519();
      case 'acct:set-key':
        return setKey(m);
      case 'acct:test':
        return testKey();
      case 'acct:clear':
        return clearAcct();
      case 'acct:meta':
        return acctMeta();
      case 'ai:set-key':
        return aiSetKey(m);
      case 'ai:clear':
        return aiClear(m.provider);
      case 'ai:models':
        return aiModels(m.provider);
      case 'ai:analyze':
        return aiAnalyze(m);
    }
  }

  return {
    /** `null` = no es un mensaje de este enrutador (otros oyentes pueden atenderlo). */
    async handle(message: unknown, sender: SenderInfo | undefined): Promise<Reply | null> {
      const type = isRecord(message) ? message.type : undefined;
      if (!isPrivilegedType(type)) return null;
      if (!senderAllowed(sender)) return { ...FORBIDDEN };
      const parsed = parsePrivilegedMessage(message);
      if (!parsed) return { error: 'bad_request' };
      try {
        return await dispatch(parsed);
      } catch {
        return { error: 'internal' };
      }
    },
  };
}
