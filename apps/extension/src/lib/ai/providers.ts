/**
 * Registro fijo de proveedores de IA (clave propia del usuario). No hay URL
 * arbitrarias: pedirlas exigiría un permiso de host para cualquier https. Cada entrada declara
 * el permiso de host opcional que hay que conceder antes de llamar.
 */
export type ProviderKind = 'openai' | 'anthropic' | 'gemini';

export type ProviderId = 'opencode' | 'openrouter' | 'openai' | 'anthropic' | 'gemini' | 'local';

export interface Provider {
  id: ProviderId;
  label: string;
  kind: ProviderKind;
  /** Para gemini lleva el marcador `{model}`, que el cliente sustituye tras validar. */
  chatUrl: string;
  modelsUrl: string | null;
  needsKey: boolean;
  hostPermission: string;
  freeModelRegex?: RegExp;
}

export const PROVIDERS: readonly Provider[] = Object.freeze([
  {
    id: 'opencode',
    label: 'OpenCode',
    kind: 'openai',
    chatUrl: 'https://opencode.ai/inference/openai/v1/chat/completions',
    modelsUrl: 'https://opencode.ai/inference/v1/models',
    needsKey: true,
    hostPermission: 'https://opencode.ai/inference/*',
    freeModelRegex: /(-free|^big-pickle)$/,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    needsKey: true,
    hostPermission: 'https://openrouter.ai/api/*',
    freeModelRegex: /:free$/,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    chatUrl: 'https://api.openai.com/v1/chat/completions',
    modelsUrl: 'https://api.openai.com/v1/models',
    needsKey: true,
    hostPermission: 'https://api.openai.com/v1/*',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic',
    chatUrl: 'https://api.anthropic.com/v1/messages',
    modelsUrl: null,
    needsKey: true,
    hostPermission: 'https://api.anthropic.com/v1/*',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    kind: 'gemini',
    chatUrl: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
    modelsUrl: null,
    needsKey: true,
    hostPermission: 'https://generativelanguage.googleapis.com/*',
  },
  {
    id: 'local',
    label: 'Local (Ollama)',
    kind: 'openai',
    chatUrl: 'http://127.0.0.1:11434/v1/chat/completions',
    modelsUrl: 'http://127.0.0.1:11434/v1/models',
    needsKey: false,
    hostPermission: 'http://127.0.0.1:11434/*',
  },
] satisfies Provider[]);

export const FREE_MODEL_WARNING =
  'Los modelos gratuitos pueden usar lo que envías para entrenar; no incluyas datos que no quieras compartir.';

export function getProvider(id: unknown): Provider | null {
  if (typeof id !== 'string') return null;
  return PROVIDERS.find((provider) => provider.id === id) ?? null;
}

export function isFreeModel(providerId: string, modelId: string): boolean {
  const provider = getProvider(providerId);
  if (!provider?.freeModelRegex || typeof modelId !== 'string') return false;
  return provider.freeModelRegex.test(modelId);
}
