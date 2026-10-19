<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import { errorText } from '../../lib/account/error-text';
  import { normalizeAcctMeta, type AcctMeta, type ExtensionSettings } from '../../lib/settings';

  let {
    settings,
    applySettings,
  }: {
    settings: ExtensionSettings;
    applySettings: (next: ExtensionSettings) => void;
  } = $props();

  const KEY_RE = /^[A-Za-z0-9]{16,128}$/;
  const SECRET_RE = /^[\x21-\x7e]{1,256}$/;

  interface Restrictions {
    ipRestrict: boolean;
    enableReading: boolean;
    tradingEnabled: boolean;
  }

  let meta = $state<AcctMeta>({ configured: false, kind: 'none', last4: '' });
  let pem = $state<string | null>(null);
  let apiKey = $state('');
  let hmacKey = $state('');
  let hmacSecret = $state('');
  let busy = $state(false);
  let note = $state<string | null>(null);
  let failure = $state<string | null>(null);
  let restrictions = $state<Restrictions | null>(null);
  let copied = $state(false);

  async function send(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const reply: unknown = await browser.runtime.sendMessage(message);
      return reply && typeof reply === 'object' ? (reply as Record<string, unknown>) : { error: 'bad_response' };
    } catch {
      return { error: 'net' };
    }
  }

  function syncSettings(next: AcctMeta) {
    meta = next;
    applySettings({ ...settings, acctMeta: next });
  }

  async function refreshMeta() {
    const reply = await send({ type: 'acct:meta' });
    if (!reply.error) meta = normalizeAcctMeta(reply);
  }

  onMount(() => {
    void refreshMeta();
  });

  function fail(code: unknown) {
    failure = errorText(code);
    note = null;
  }

  async function generate() {
    busy = true;
    failure = null;
    const reply = await send({ type: 'acct:gen-ed25519' });
    busy = false;
    if (typeof reply.publicPem === 'string') {
      pem = reply.publicPem;
      copied = false;
    } else {
      fail(reply.error);
    }
  }

  async function copyPem() {
    if (!pem) return;
    try {
      await navigator.clipboard.writeText(pem);
      copied = true;
    } catch {
      copied = false;
      note = 'No se pudo copiar: selecciona el texto a mano.';
    }
  }

  async function saveEd() {
    failure = null;
    if (!KEY_RE.test(apiKey)) {
      failure = 'La clave API tiene de 16 a 128 letras y números.';
      return;
    }
    busy = true;
    const reply = await send({ type: 'acct:set-key', kind: 'ed25519', apiKey });
    busy = false;
    if (reply.ok === true) {
      syncSettings({ configured: true, kind: 'ed25519', last4: apiKey.slice(-4) });
      apiKey = '';
      note = 'Clave guardada. Pulsa Probar.';
    } else {
      fail(reply.error);
    }
  }

  async function saveHmac() {
    failure = null;
    if (!KEY_RE.test(hmacKey) || !SECRET_RE.test(hmacSecret)) {
      failure = 'Revisa la clave API (16 a 128 letras y números) y el secreto.';
      return;
    }
    busy = true;
    const reply = await send({ type: 'acct:set-key', kind: 'hmac', apiKey: hmacKey, hmacSecret });
    busy = false;
    if (reply.ok === true) {
      syncSettings({ configured: true, kind: 'hmac', last4: hmacKey.slice(-4) });
      hmacKey = '';
      hmacSecret = '';
      note = 'Clave guardada. Pulsa Probar.';
    } else {
      fail(reply.error);
    }
  }

  async function test() {
    busy = true;
    failure = null;
    restrictions = null;
    note = null;
    const reply = await send({ type: 'acct:test' });
    busy = false;
    const r = reply.restrictions as Partial<Restrictions> | undefined;
    if (reply.ok === true && r && typeof r === 'object') {
      restrictions = {
        ipRestrict: r.ipRestrict === true,
        enableReading: r.enableReading === true,
        tradingEnabled: r.tradingEnabled === true,
      };
      note = 'Conexión correcta.';
    } else {
      fail(reply.error ?? 'bad_response');
    }
  }

  async function clearAll() {
    busy = true;
    failure = null;
    const reply = await send({ type: 'acct:clear' });
    busy = false;
    if (reply.ok === true) {
      pem = null;
      restrictions = null;
      note = 'Credenciales borradas.';
      syncSettings({ configured: false, kind: 'none', last4: '' });
    } else {
      fail(reply.error);
    }
  }
</script>

<fieldset class="cred" data-testid="cred-binance">
  <legend>Binance: clave de solo lectura</legend>
  <p class="hint" data-testid="cred-binance-status">
    {meta.configured ? `Clave ${meta.kind} guardada (termina en ${meta.last4}).` : 'Sin clave. La posición manual funciona sin ella.'}
  </p>

  <p class="step"><strong>1.</strong> Genera la clave dentro de la extensión.</p>
  <button type="button" class="btn small" disabled={busy} onclick={generate}>Generar clave</button>
  {#if pem}
    <pre class="pem" data-testid="cred-pem">{pem}</pre>
    <button type="button" class="btn small" onclick={copyPem}>{copied ? 'Copiada' : 'Copiar'}</button>
    <p class="hint">Pégala en Binance, API Management, «Editar» la clave. Activa Enable Reading; restringir la IP es opcional.</p>
  {/if}

  <p class="step"><strong>2.</strong> Pega la API key (no se vuelve a mostrar).</p>
  <input
    type="password"
    name="binance-api-key"
    aria-label="API key de Binance"
    autocomplete="off"
    spellcheck="false"
    bind:value={apiKey}
  />
  <button type="button" class="btn small" disabled={busy || apiKey === ''} onclick={saveEd}>Guardar clave</button>

  <p class="step"><strong>3.</strong> Comprueba la conexión.</p>
  <button type="button" class="btn small" disabled={busy || !meta.configured} onclick={test}>Probar</button>
  {#if restrictions}
    <p class="hint" data-testid="cred-ip">Restricción de IP: {restrictions.ipRestrict ? 'sí' : 'no'}</p>
    {#if !restrictions.enableReading}
      <p class="hint">! Falta el permiso de lectura (Enable Reading).</p>
    {/if}
    {#if restrictions.tradingEnabled}
      <p class="hint" data-testid="cred-trading-note">
        Esta clave tiene permiso de Futuros (Binance lo suele exigir para leer). La extensión solo usa rutas de lectura.
      </p>
    {/if}
  {/if}

  <p class="step"><strong>4.</strong> Si ya no la quieres:</p>
  <button type="button" class="btn small" disabled={busy || !meta.configured} onclick={clearAll}>Borrar credenciales</button>

  {#if failure}<p class="hint" role="alert" data-testid="cred-error">! {failure}</p>{/if}
  {#if note}<p class="hint" data-testid="cred-note">{note}</p>{/if}

  <details class="fold" data-testid="cred-hmac">
    <summary>Alternativa HMAC (sin Ed25519)</summary>
    <p class="hint">Para navegadores sin Ed25519. Crea la clave en Binance con solo lectura.</p>
    <input type="password" name="binance-hmac-key" aria-label="API key HMAC" autocomplete="off" spellcheck="false" bind:value={hmacKey} />
    <input type="password" name="binance-hmac-secret" aria-label="Secreto HMAC" autocomplete="off" spellcheck="false" bind:value={hmacSecret} />
    <button type="button" class="btn small" disabled={busy || hmacKey === '' || hmacSecret === ''} onclick={saveHmac}>Guardar HMAC</button>
  </details>
</fieldset>
