<script lang="ts">
  import { browser } from 'wxt/browser';
  import {
    aiErrorText,
    consentText,
    findingsForPayload,
    historyInputFromMetrics,
    trendToken,
  } from '../../lib/account/analysis-view';
  import type { TradeMetrics } from '../../lib/account/metrics';
  import { evaluateRules } from '../../lib/account/rules';
  import type { PositionView } from '../../lib/account/types';
  import {
    buildHistoryPayload,
    buildPositionPayload,
    serializeForLlm,
    type AiHistoryPayload,
    type AiPositionPayload,
  } from '../../lib/ai/payload';
  import type { AiView } from '../../lib/ai/prompt';
  import { FREE_MODEL_WARNING, getProvider, isFreeModel } from '../../lib/ai/providers';
  import type { ExtensionSettings } from '../../lib/settings';
  import type { PanelState } from '../../lib/account/panel-controller';
  import type { Finding } from '../../lib/types';

  let {
    symbol,
    timeframe,
    settings,
    applySettings,
    panel,
    position,
    metrics,
    findings,
    trend,
    lastPrice,
    atr,
  }: {
    symbol: string;
    timeframe: string;
    settings: ExtensionSettings;
    applySettings: (next: ExtensionSettings) => void;
    panel: PanelState;
    position: PositionView | null;
    metrics: TradeMetrics | null;
    findings: readonly Finding[];
    trend: string | null;
    lastPrice: number | null;
    atr: number | null;
  } = $props();

  type Kind = 'position' | 'history';
  interface Built {
    payload: AiPositionPayload | AiHistoryPayload;
    text: string;
  }

  let busy = $state(false);
  let pending = $state<Kind | null>(null);
  let view = $state<AiView | null>(null);
  let errorText = $state<string | null>(null);

  const provider = $derived(getProvider(settings.ai.provider));
  const model = $derived(settings.ai.model);
  const consented = $derived((settings.ai.consentedProviders as readonly string[]).includes(settings.ai.provider));
  const free = $derived(isFreeModel(settings.ai.provider, model));

  function build(kind: Kind): Built | null {
    try {
      let payload: AiPositionPayload | AiHistoryPayload;
      if (kind === 'position') {
        if (!position || !panel.snapshot) return null;
        const rules = evaluateRules({
          position,
          snapshot: panel.snapshot,
          atr,
          rules: settings.rules,
          now: Date.now(),
        }).map((r) => ({ code: r.code, sev: r.sev }));
        payload = buildPositionPayload(
          {
            symbol,
            tf: timeframe,
            position,
            snapshot: panel.snapshot,
            atr,
            rules,
            contexto: { trend: trendToken(trend), findings: findingsForPayload(findings, lastPrice) },
            ruleMaxRiskPct: settings.rules.maxRiskPct,
          },
          settings.ai.redaction,
        );
      } else {
        if (!metrics || metrics.n === 0) return null;
        payload = buildHistoryPayload(historyInputFromMetrics(metrics), settings.ai.redaction);
      }
      return { payload, text: serializeForLlm(payload) };
    } catch {
      return null;
    }
  }

  const positionBuilt = $derived(build('position'));
  const historyBuilt = $derived(build('history'));
  const modelReady = $derived(provider !== null && model !== '');

  /** Pide el permiso de host opcional del proveedor; debe colgar del clic del usuario. */
  async function ensureHost(): Promise<boolean> {
    const origin = provider?.hostPermission;
    if (!origin) return false;
    try {
      const perms = browser.permissions;
      if (!perms) return true;
      if (await perms.contains({ origins: [origin] })) return true;
      return await perms.request({ origins: [origin] });
    } catch {
      return false;
    }
  }

  async function send(kind: Kind) {
    const built = kind === 'position' ? positionBuilt : historyBuilt;
    if (!built || !provider) {
      errorText = aiErrorText('bad_payload');
      return;
    }
    busy = true;
    view = null;
    errorText = null;
    try {
      if (!(await ensureHost())) {
        errorText = 'Sin permiso de acceso al sitio del proveedor. Concédelo para poder analizar.';
        return;
      }
      const message = { type: 'ai:analyze', provider: provider.id, model, payload: built.payload };
      let reply = (await browser.runtime.sendMessage(message)) as { view?: AiView | null; reason?: string } | undefined;
      // El consentimiento se guarda de forma asíncrona: un reintento corto cubre la carrera.
      if (reply?.reason === 'no_consent') {
        await new Promise((resolve) => setTimeout(resolve, 200));
        reply = (await browser.runtime.sendMessage(message)) as typeof reply;
      }
      if (reply?.view) view = reply.view;
      else errorText = aiErrorText(reply?.reason ?? 'net');
    } catch {
      errorText = aiErrorText('net');
    } finally {
      busy = false;
    }
  }

  function start(kind: Kind) {
    if (busy) return;
    if (!consented) {
      pending = kind;
      return;
    }
    void send(kind);
  }

  function accept() {
    const kind = pending;
    if (!kind || !provider) return;
    pending = null;
    applySettings({
      ...settings,
      ai: {
        ...settings.ai,
        consentedProviders: [...new Set([...settings.ai.consentedProviders, settings.ai.provider])],
      },
    });
    void send(kind);
  }

  const pendingBuilt = $derived(pending === 'position' ? positionBuilt : pending === 'history' ? historyBuilt : null);
</script>

<section class="an-card" data-testid="ai-card" aria-label="Análisis con IA">
  <h2>Análisis con IA</h2>
  <p class="an-note">
    Solo cuando pulsas un botón. Va a {provider?.label ?? 'tu proveedor'} con tu propia clave; nada pasa por los servidores de SWAL.
  </p>
  {#if !modelReady}
    <p class="an-note">Elige proveedor y modelo en Ajustes para usar este análisis.</p>
  {/if}
  {#if free}
    <p class="an-error" data-testid="ai-free-warning">{FREE_MODEL_WARNING}</p>
  {/if}
  <div class="an-actions">
    <button
      type="button"
      class="an-btn"
      data-testid="ai-position"
      disabled={busy || !modelReady || !positionBuilt}
      onclick={() => start('position')}
    >
      Analizar mi posición
    </button>
    <button
      type="button"
      class="an-btn"
      data-testid="ai-history"
      disabled={busy || !modelReady || !historyBuilt}
      onclick={() => start('history')}
    >
      Analizar mi historial
    </button>
  </div>
  {#if !positionBuilt}
    <p class="an-note">«Analizar mi posición» necesita una posición abierta en este símbolo.</p>
  {/if}

  {#if pending && pendingBuilt}
    <div class="an-consent" role="dialog" aria-label="Consentimiento de envío" data-testid="ai-consent">
      <p class="an-note">{consentText(settings.ai.provider, settings.ai.redaction, pending)}</p>
      <pre class="an-pre">{pendingBuilt.text}</pre>
      <div class="an-actions">
        <button type="button" class="an-btn" data-testid="ai-consent-accept" onclick={accept}>Aceptar y analizar</button>
        <button type="button" class="an-btn an-ghost" onclick={() => (pending = null)}>Cancelar</button>
      </div>
    </div>
  {/if}

  <details data-testid="ai-preview">
    <summary class="an-note">Ver lo que se envía</summary>
    {#if positionBuilt}
      <p class="an-note">Posición ({settings.ai.redaction === 'relative' ? 'relativo' : 'con precios'}):</p>
      <pre class="an-pre" data-testid="ai-preview-position">{positionBuilt.text}</pre>
    {/if}
    {#if historyBuilt}
      <p class="an-note">Historial:</p>
      <pre class="an-pre" data-testid="ai-preview-history">{historyBuilt.text}</pre>
    {/if}
    {#if !positionBuilt && !historyBuilt}
      <p class="an-note">Aún no hay nada que enviar: falta una posición abierta o un historial.</p>
    {/if}
  </details>

  {#if busy}
    <p class="an-note" role="status">Analizando…</p>
  {/if}
  {#if errorText}
    <p class="an-error" role="alert" data-testid="ai-error">{errorText}</p>
  {/if}
  {#if view}
    <div class="an-answer" data-testid="ai-answer">
      {#if view.flag}
        <p class="an-error" data-testid="ai-flag">{view.flag}</p>
      {/if}
      {#if view.resumen}<p class="an-note">{view.resumen}</p>{/if}
      {#if view.lectura.length > 0}
        <ul class="an-list">
          {#each view.lectura as line}<li>{line}</li>{/each}
        </ul>
      {/if}
      {#if view.opciones.length > 0}
        <ul class="an-list">
          {#each view.opciones as op}
            <li>{op.accion}{op.coste ? ` — coste: ${op.coste}` : ''}{op.no_aplica_si ? ` — no aplica si: ${op.no_aplica_si}` : ''}</li>
          {/each}
        </ul>
      {/if}
      {#if view.preguntas.length > 0}
        <p class="an-note">Preguntas: {view.preguntas.join(' · ')}</p>
      {/if}
      {#if view.faltan.length > 0}
        <p class="an-note">Faltan: {view.faltan.join(' · ')}</p>
      {/if}
      <p class="an-note an-honesty" data-testid="ai-disclaimer">{view.disclaimer}</p>
    </div>
  {/if}
</section>
