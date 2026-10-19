<script lang="ts">
  import { browser } from 'wxt/browser';
  import { errorText } from '../../lib/account/error-text';
  import { FREE_MODEL_WARNING, getProvider, isFreeModel } from '../../lib/ai/providers';
  import { AI_PROVIDERS, type AiProvider, type ExtensionSettings } from '../../lib/settings';

  let {
    settings,
    settingsLoaded,
    applySettings,
  }: {
    settings: ExtensionSettings;
    settingsLoaded: boolean;
    applySettings: (next: ExtensionSettings) => void;
  } = $props();

  const provider = $derived(getProvider(settings.ai.provider));
  const label = $derived(provider?.label ?? settings.ai.provider);
  const consented = $derived(settings.ai.consentedProviders.includes(settings.ai.provider));
  const isFree = $derived(isFreeModel(settings.ai.provider, settings.ai.model));

  let key = $state('');
  let persist = $state<'session' | 'vault'>('session');
  let models = $state<string[]>([]);
  let busy = $state(false);
  let failure = $state<string | null>(null);
  let note = $state<string | null>(null);

  async function send(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const reply: unknown = await browser.runtime.sendMessage(message);
      return reply && typeof reply === 'object' ? (reply as Record<string, unknown>) : { error: 'bad_response' };
    } catch {
      return { error: 'net' };
    }
  }

  /** Pide el permiso de host opcional del proveedor; true si no hay API de permisos. */
  async function requestHost(): Promise<boolean> {
    const origin = provider?.hostPermission;
    const api = (browser as unknown as { permissions?: { request?: (p: { origins: string[] }) => Promise<boolean> } })
      .permissions;
    if (!origin || !api?.request) return true;
    try {
      return await api.request({ origins: [origin] });
    } catch {
      return false;
    }
  }

  function setAi(patch: Partial<ExtensionSettings['ai']>) {
    applySettings({ ...settings, ai: { ...settings.ai, ...patch } });
  }

  function chooseProvider(id: string) {
    if (!(AI_PROVIDERS as readonly string[]).includes(id)) return;
    models = [];
    failure = null;
    note = null;
    key = '';
    setAi({ provider: id as AiProvider, model: '' });
  }

  async function saveKey() {
    failure = null;
    note = null;
    if (key.length < 8) {
      failure = 'La clave es demasiado corta.';
      return;
    }
    busy = true;
    if (!(await requestHost())) {
      busy = false;
      failure = `Sin permiso de acceso a ${label}: no se podrá llamar.`;
      return;
    }
    const reply = await send({ type: 'ai:set-key', provider: settings.ai.provider, key, persist });
    busy = false;
    if (reply.ok === true) {
      key = '';
      note = persist === 'vault' ? 'Clave guardada cifrada.' : 'Clave guardada solo para esta sesión.';
    } else {
      failure = errorText(reply.error);
    }
  }

  async function allowLocal() {
    failure = null;
    note = (await requestHost()) ? 'Acceso permitido.' : null;
    if (!note) failure = `Sin permiso de acceso a ${label}.`;
  }

  async function loadModels() {
    failure = null;
    note = null;
    busy = true;
    if (!(await requestHost())) {
      busy = false;
      failure = `Sin permiso de acceso a ${label}.`;
      return;
    }
    const reply = await send({ type: 'ai:models', provider: settings.ai.provider });
    busy = false;
    models = Array.isArray(reply.models) ? reply.models.filter((m): m is string => typeof m === 'string') : [];
    if (reply.error) failure = errorText(reply.error);
    else if (models.length === 0) note = 'El proveedor no devolvió modelos.';
  }

  async function clearKey() {
    failure = null;
    busy = true;
    const reply = await send({ type: 'ai:clear', provider: settings.ai.provider });
    busy = false;
    if (reply.ok === true) {
      key = '';
      note = 'Clave borrada.';
    } else {
      failure = errorText(reply.error);
    }
  }

  function setConsent(on: boolean) {
    const id = settings.ai.provider;
    const rest = settings.ai.consentedProviders.filter((p) => p !== id);
    setAi({ consentedProviders: on ? [...rest, id] : rest });
  }
</script>

<fieldset class="cred" data-testid="cred-ai">
  <legend>IA con tu propia clave</legend>
  <label class="field">
    <span>Proveedor</span>
    <select
      name="ai-provider"
      disabled={!settingsLoaded}
      value={settings.ai.provider}
      onchange={(event) => chooseProvider((event.currentTarget as HTMLSelectElement).value)}
    >
      {#each AI_PROVIDERS as id (id)}
        <option value={id}>{getProvider(id)?.label ?? id}</option>
      {/each}
    </select>
  </label>

  {#if provider?.needsKey}
    <label class="field">
      <span>Clave de {label} (no se vuelve a mostrar)</span>
      <input
        type="password"
        name="ai-key"
        autocomplete="off"
        spellcheck="false"
        disabled={!settingsLoaded}
        bind:value={key}
      />
    </label>
    <label class="field">
      <span>Dónde guardarla</span>
      <select name="ai-persist" bind:value={persist}>
        <option value="session">solo esta sesión</option>
        <option value="vault">guardar cifrada</option>
      </select>
    </label>
    <div class="row">
      <button type="button" class="btn small" disabled={busy || key === ''} onclick={saveKey}>Guardar clave</button>
      <button type="button" class="btn small" disabled={busy} onclick={clearKey}>Borrar clave</button>
    </div>
  {:else}
    <div class="row">
      <button type="button" class="btn small" disabled={busy} onclick={allowLocal}>Permitir acceso local</button>
    </div>
  {/if}

  <div class="row">
    <button type="button" class="btn small" disabled={busy || !provider?.modelsUrl} onclick={loadModels}>Cargar modelos</button>
  </div>
  {#if models.length > 0}
    <label class="field">
      <span>Modelo</span>
      <select
        name="ai-model"
        value={settings.ai.model}
        onchange={(event) => setAi({ model: (event.currentTarget as HTMLSelectElement).value })}
      >
        <option value="">—</option>
        {#each models as m (m)}
          <option value={m}>{m}{isFreeModel(settings.ai.provider, m) ? ' (gratis)' : ''}</option>
        {/each}
      </select>
    </label>
  {:else if !provider?.modelsUrl}
    <label class="field">
      <span>Modelo (escríbelo)</span>
      <input
        type="text"
        name="ai-model-text"
        style="text-transform: none"
        spellcheck="false"
        autocomplete="off"
        value={settings.ai.model}
        onchange={(event) => setAi({ model: (event.currentTarget as HTMLInputElement).value.trim() })}
      />
    </label>
  {/if}
  {#if isFree}
    <p class="hint" data-testid="ai-free-warning">! {FREE_MODEL_WARNING}</p>
  {/if}

  <label class="field check">
    <input
      type="checkbox"
      name="ai-redaction"
      disabled={!settingsLoaded}
      checked={settings.ai.redaction === 'absolute'}
      onchange={(event) => setAi({ redaction: (event.currentTarget as HTMLInputElement).checked ? 'absolute' : 'relative' })}
    />
    <span>Enviar importes absolutos (por defecto: solo cifras relativas)</span>
  </label>
  {#if settings.ai.redaction === 'absolute'}
    <p class="hint" data-testid="ai-absolute-warning">
      !! Con importes absolutos el proveedor recibe USD y cantidades de tu cuenta.
    </p>
  {/if}

  <label class="field check">
    <input
      type="checkbox"
      name="ai-consent"
      disabled={!settingsLoaded}
      checked={consented}
      onchange={(event) => setConsent((event.currentTarget as HTMLInputElement).checked)}
    />
    <span data-testid="ai-consent-text">
      Acepto que se envíen a {label}: cifras relativas: R, apalancamiento, % al stop, % a liquidación, banderas; sin importes en USD ni cantidades.{settings.ai.redaction === 'absolute'
        ? ' Con importes absolutos también se envían USD y cantidades.'
        : ''}
    </span>
  </label>

  {#if failure}<p class="hint" role="alert" data-testid="ai-error">! {failure}</p>{/if}
  {#if note}<p class="hint">{note}</p>{/if}
</fieldset>

<style>
  .row {
    display: flex;
    gap: 0.4rem;
  }
</style>
