/**
 * Cliente LLM del background. La URL sale SIEMPRE del registro; la clave solo
 * viaja en cabeceras y jamás en un motivo ni en un valor lanzado. Nunca lanza.
 */
import { getProvider } from './providers';

export type ChatFailure =
  | 'no_key'
  | 'timeout'
  | 'auth'
  | 'rate_limit'
  | 'bad_response'
  | 'net'
  | `http_${number}`;

export type ChatResult = { ok: true; text: string } | { ok: false; reason: ChatFailure };

export interface ChatRequest {
  provider: string;
  model: string;
  system: string;
  user: string;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface ChatDeps {
  fetch: typeof fetch;
}

export const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,80}$/;
/** Patrón del modelo, más: sin `..` ni barra inicial, para que no reescriba la ruta. */
export const isValidModelId = (model: unknown): model is string =>
  typeof model === 'string' && MODEL_ID_PATTERN.test(model) && !model.includes('..') && !model.startsWith('/');
export const MAX_REPLY_CHARS = 8000;
export const MAX_MODELS = 200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function buildRequest(
  kind: 'openai' | 'anthropic' | 'gemini',
  url: string,
  req: Required<Pick<ChatRequest, 'model' | 'system' | 'user' | 'maxTokens' | 'temperature'>>,
  apiKey: string,
): { url: string; headers: Record<string, string>; body: unknown } {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (kind === 'anthropic') {
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    // Necesaria para que Anthropic acepte llamadas desde un contexto de navegador.
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    return {
      url,
      headers,
      body: {
        model: req.model,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        max_tokens: req.maxTokens,
        temperature: req.temperature,
      },
    };
  }
  if (kind === 'gemini') {
    if (apiKey) headers['x-goog-api-key'] = apiKey;
    return {
      url: url.replace('{model}', req.model),
      headers,
      body: {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text: req.user }] }],
        generationConfig: { maxOutputTokens: req.maxTokens, temperature: req.temperature },
      },
    };
  }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return {
    url,
    headers,
    body: {
      model: req.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      max_tokens: req.maxTokens,
      temperature: req.temperature,
    },
  };
}

function extractText(kind: 'openai' | 'anthropic' | 'gemini', json: unknown): string {
  if (!isRecord(json)) return '';
  if (kind === 'openai') {
    const choice = Array.isArray(json.choices) ? json.choices[0] : null;
    const message = isRecord(choice) && isRecord(choice.message) ? choice.message : null;
    return typeof message?.content === 'string' ? message.content : '';
  }
  if (kind === 'anthropic') {
    const blocks = Array.isArray(json.content) ? json.content : [];
    return blocks
      .map((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .join('');
  }
  const candidate = Array.isArray(json.candidates) ? json.candidates[0] : null;
  const content = isRecord(candidate) && isRecord(candidate.content) ? candidate.content : null;
  const parts = Array.isArray(content?.parts) ? (content.parts as unknown[]) : [];
  return parts.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('');
}

export async function chat(request: ChatRequest, deps: ChatDeps): Promise<ChatResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const provider = getProvider(request.provider);
    if (!provider) return { ok: false, reason: 'bad_response' };
    if (!isValidModelId(request.model)) {
      return { ok: false, reason: 'bad_response' };
    }
    const apiKey = typeof request.apiKey === 'string' ? request.apiKey.trim() : '';
    if (provider.needsKey && !apiKey) return { ok: false, reason: 'no_key' };
    // Una clave con saltos o caracteres no ASCII no puede ir en una cabecera.
    if (apiKey && !/^[\x21-\x7e]+$/.test(apiKey)) return { ok: false, reason: 'auth' };

    const built = buildRequest(
      provider.kind,
      provider.chatUrl,
      {
        model: request.model,
        system: String(request.system ?? ''),
        user: String(request.user ?? ''),
        maxTokens: request.maxTokens ?? 500,
        temperature: request.temperature ?? 0.2,
      },
      provider.needsKey ? apiKey : '',
    );

    const controller = new AbortController();
    let timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs ?? 20_000);

    let response: Response;
    try {
      response = await deps.fetch(built.url, {
        method: 'POST',
        headers: built.headers,
        body: JSON.stringify(built.body),
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
      });
    } catch {
      return { ok: false, reason: timedOut ? 'timeout' : 'net' };
    }

    if (response.status === 401 || response.status === 403) return { ok: false, reason: 'auth' };
    if (response.status === 429) return { ok: false, reason: 'rate_limit' };
    if (!response.ok) return { ok: false, reason: `http_${response.status}` };

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { ok: false, reason: timedOut ? 'timeout' : 'bad_response' };
    }
    const text = extractText(provider.kind, json).trim().slice(0, MAX_REPLY_CHARS);
    return text ? { ok: true, text } : { ok: false, reason: 'bad_response' };
  } catch {
    return { ok: false, reason: 'net' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Lista de modelos de una respuesta estilo OpenAI `{data:[{id}]}`. */
export function parseModels(providerId: string, json: unknown): string[] {
  if (!getProvider(providerId) || !isRecord(json) || !Array.isArray(json.data)) return [];
  const ids = new Set<string>();
  for (const item of json.data) {
    const id = isRecord(item) ? item.id : undefined;
    if (isValidModelId(id)) ids.add(id);
  }
  return [...ids].sort().slice(0, MAX_MODELS);
}
