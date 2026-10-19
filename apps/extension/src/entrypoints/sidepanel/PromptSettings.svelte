<script lang="ts">
  /**
   * Editor del prompt de IA. Solo cambia rol, estilo y preferencias; el marco
   * de seguridad es fijo y se muestra tal cual se envía. Guarda en
   * `storage.local` bajo su propia clave: no toca `settings`.
   */
  import { i18n } from '../../lib/i18n/i18n.svelte';
  import { LOCALES, isLocaleCode, type LocaleCode } from '../../lib/i18n/locales';
  import {
    DEFAULT_PROMPT_CONFIG,
    MAX_EXTRA_CHARS,
    MAX_ROLE_CHARS,
    MAX_STYLE_CHARS,
    SAFETY_FRAME,
    buildSystemPrompt,
    exportPromptConfig,
    importPromptConfig,
    loadPromptConfig,
    normalizePromptConfig,
    resolvePromptLanguage,
    savePromptConfig,
    type PromptConfig,
  } from '../../lib/ai/prompt-config';

  let draft = $state<PromptConfig>({ ...DEFAULT_PROMPT_CONFIG });
  let loaded = $state(false);
  let note = $state<string | null>(null);
  let failure = $state<string | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);

  const uiLocale = $derived<LocaleCode>(isLocaleCode(i18n.locale) ? i18n.locale : 'es');
  const language = $derived(resolvePromptLanguage(draft.language, uiLocale));
  const previewNames = $derived(LOCALES.map((l) => ({ code: l.code, name: l.nativeName })));

  $effect(() => {
    let alive = true;
    void loadPromptConfig().then((config) => {
      if (!alive) return;
      draft = config;
      loaded = true;
    });
    return () => {
      alive = false;
    };
  });

  function set(field: 'role' | 'style' | 'extra', value: string) {
    draft = { ...draft, [field]: value };
    note = null;
    failure = null;
  }

  function setLanguage(value: string) {
    draft = { ...draft, language: isLocaleCode(value) ? value : 'auto' };
    note = null;
    failure = null;
  }

  async function save() {
    failure = null;
    try {
      const config = normalizePromptConfig(draft);
      await savePromptConfig(config);
      draft = config;
      note = 'Prompt guardado.';
    } catch {
      failure = 'No se pudo guardar el prompt.';
    }
  }

  function reset() {
    draft = { ...DEFAULT_PROMPT_CONFIG };
    note = null;
    failure = null;
  }

  function download() {
    try {
      const blob = new Blob([exportPromptConfig(draft)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'swal-prompt.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      note = 'Prompt exportado.';
    } catch {
      failure = 'No se pudo exportar el prompt.';
    }
  }

  async function upload(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      failure = 'No se pudo leer el archivo.';
      return;
    }
    const parsed = importPromptConfig(text);
    if (!parsed.ok) {
      failure =
        parsed.error === 'bad_json'
          ? 'El archivo no es JSON válido.'
          : parsed.error === 'bad_version'
            ? 'El archivo es de otra versión del prompt.'
            : 'El archivo no contiene un prompt.';
      return;
    }
    draft = parsed.config;
    await save();
    note = 'Prompt importado y guardado.';
  }
</script>

<details class="prompt" data-testid="prompt-settings">
  <summary>Prompt de la IA</summary>
  <div class="prompt-body">
    <p class="hint">
      Cambia cómo habla el asistente. Las reglas de riesgo y el formato de salida son fijos y se añaden siempre al final.
    </p>

  <label class="field">
    <span>Rol</span>
    <textarea
      data-testid="prompt-role"
      rows="2"
      maxlength={MAX_ROLE_CHARS}
      disabled={!loaded}
      value={draft.role}
      oninput={(event) => set('role', (event.currentTarget as HTMLTextAreaElement).value)}
    ></textarea>
    <small class="hint" data-testid="prompt-role-count">{draft.role.length}/{MAX_ROLE_CHARS}</small>
  </label>

  <label class="field">
    <span>Estilo</span>
    <textarea
      data-testid="prompt-style"
      rows="2"
      maxlength={MAX_STYLE_CHARS}
      disabled={!loaded}
      value={draft.style}
      oninput={(event) => set('style', (event.currentTarget as HTMLTextAreaElement).value)}
    ></textarea>
    <small class="hint" data-testid="prompt-style-count">{draft.style.length}/{MAX_STYLE_CHARS}</small>
  </label>

  <label class="field">
    <span>Preferencias extra (opcional)</span>
    <textarea
      data-testid="prompt-extra"
      rows="3"
      maxlength={MAX_EXTRA_CHARS}
      disabled={!loaded}
      value={draft.extra}
      placeholder="Ej.: explícame las opciones con ejemplos numéricos del propio JSON."
      oninput={(event) => set('extra', (event.currentTarget as HTMLTextAreaElement).value)}
    ></textarea>
    <small class="hint" data-testid="prompt-extra-count">{draft.extra.length}/{MAX_EXTRA_CHARS}</small>
  </label>

  <label class="field">
    <span>Idioma de la respuesta</span>
    <select
      data-testid="prompt-language"
      disabled={!loaded}
      value={draft.language}
      onchange={(event) => setLanguage((event.currentTarget as HTMLSelectElement).value)}
    >
      <option value="auto">Idioma del panel ({uiLocale})</option>
      {#each previewNames as entry (entry.code)}
        <option value={entry.code}>{entry.name}</option>
      {/each}
    </select>
    <small class="hint">Se enviará «Responde en {language}».</small>
  </label>

  <div class="field">
    <span>Reglas fijas (no editables)</span>
    <pre class="frame" data-testid="prompt-frame">{SAFETY_FRAME}</pre>
  </div>

  <details class="field">
    <summary class="hint">Ver el prompt completo que se enviará</summary>
    <pre class="frame" data-testid="prompt-assembled">{buildSystemPrompt(draft, uiLocale)}</pre>
  </details>

  <div class="row">
    <button type="button" class="btn small" data-testid="prompt-save" disabled={!loaded} onclick={save}>Guardar</button>
    <button type="button" class="btn small" data-testid="prompt-reset" disabled={!loaded} onclick={reset}>Restablecer</button>
    <button type="button" class="btn small" disabled={!loaded} onclick={download}>Exportar JSON</button>
    <button type="button" class="btn small" disabled={!loaded} onclick={() => fileInput?.click()}>Importar JSON</button>
    <input
      bind:this={fileInput}
      type="file"
      accept="application/json,.json"
      hidden
      data-testid="prompt-import"
      onchange={upload}
    />
  </div>

  {#if failure}<p class="hint" role="alert" data-testid="prompt-error">! {failure}</p>{/if}
  {#if note}<p class="hint" data-testid="prompt-note">{note}</p>{/if}
  </div>
</details>

<style>
  .prompt {
    border: 1px solid var(--line, #2a2f3a);
    border-radius: 6px;
    padding: 0.6rem;
  }
  .prompt-body {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .frame {
    margin: 0;
    padding: 0.4rem;
    background: var(--bg-2, #14171d);
    border: 1px solid var(--line, #2a2f3a);
    border-radius: 4px;
    font-size: 0.75rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  textarea {
    width: 100%;
    resize: vertical;
    font: inherit;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
</style>
