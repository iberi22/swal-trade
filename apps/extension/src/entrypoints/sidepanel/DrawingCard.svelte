<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import { aiErrorText } from '../../lib/account/analysis-view';
  import { drawingAiPayload } from '../../lib/drawing/ai-payload';
  import { analyzeDrawing } from '../../lib/drawing/analyze';
  import {
    buildDrawingCardModel,
    DRAWING_AI_NOT_CONFIGURED,
    type DrawingCardEntry,
    type DrawingCardTool,
  } from '../../lib/drawing/card-model';
  import type { DrawingAnalysis } from '../../lib/drawing/types';
  import { serializeForLlm } from '../../lib/ai/payload';
  import type { AiView } from '../../lib/ai/prompt';
  import { getProvider } from '../../lib/ai/providers';
  import type { ContextSnapshot } from '../../lib/context/context-feed';
  import { buildLevels, computeAtrs, type FindingLevelInput } from '../../lib/context/levels';
  import { formatPanelPrice } from '../../lib/price-format';
  import type { ExtensionSettings, RulesSettings } from '../../lib/settings';
  import { DEFAULT_SIZING_PREFERENCES, normalizeSizingPreferences, SIZING_STORAGE_KEY } from '../../lib/sizing';
  import { fetchSymbolFilters } from '../../lib/trade-cards/filters';
  import { publishSizingLoad } from '../../lib/trade-cards/sizing-bridge';
  import type { SymbolFilters } from '../../lib/trade-cards/ticket';
  import { drawingsFromPositionTools } from '../../lib/tv-bridge/position-tools';
  import { POSITION_TOOLS_STORAGE_KEY, toolsForSymbol } from '../../lib/tv-bridge/relay';

  /**
   * «Tu dibujo»: lee la herramienta Long/Short Position que el usuario traza en
   * la pestaña Trading View y enseña el análisis determinista (geometría,
   * costes, niveles, alcance y funding). Solo lectura del dibujo: la tarjeta no
   * crea, mueve ni borra nada, y no abre órdenes.
   */
  let {
    symbol,
    lastPrice,
    snapshot,
    findingsLevels,
    rules,
    settings,
    settingsLoaded,
    applySettings,
    canLoad = true,
  }: {
    symbol: string;
    lastPrice: number | null;
    snapshot: ContextSnapshot | null;
    findingsLevels: FindingLevelInput[];
    rules: RulesSettings;
    settings: ExtensionSettings;
    settingsLoaded: boolean;
    applySettings: (next: ExtensionSettings) => void;
    canLoad?: boolean;
  } = $props();

  /** Último mensaje del puente, tal cual lo guarda el background por símbolo. */
  let store = $state<unknown>(null);
  let capital = $state(DEFAULT_SIZING_PREFERENCES.capital);
  let filters = $state<SymbolFilters | null>(null);
  let copiedId = $state<string | null>(null);
  let pendingId = $state<string | null>(null);
  let aiBusy = $state(false);
  let aiView = $state<AiView | null>(null);
  let aiError = $state<string | null>(null);

  onMount(() => {
    const applyStore = (raw: unknown) => {
      store = raw ?? null;
    };
    void browser.storage?.session
      ?.get(POSITION_TOOLS_STORAGE_KEY)
      .then((stored) => applyStore(stored?.[POSITION_TOOLS_STORAGE_KEY]))
      .catch(() => {});
    const onChanged = (changes: Record<string, { newValue?: unknown }>, areaName: string) => {
      if (areaName !== 'session' || !changes[POSITION_TOOLS_STORAGE_KEY]) return;
      applyStore(changes[POSITION_TOOLS_STORAGE_KEY]?.newValue);
    };
    browser.storage?.onChanged?.addListener(onChanged as never);

    const applySizing = (raw: unknown) => {
      capital = normalizeSizingPreferences(raw).capital;
    };
    void browser.storage?.local
      ?.get(SIZING_STORAGE_KEY)
      .then((stored) => applySizing(stored?.[SIZING_STORAGE_KEY]))
      .catch(() => {});
    const onLocalChanged = (changes: Record<string, { newValue?: unknown }>, areaName: string) => {
      if (areaName === 'local' && changes[SIZING_STORAGE_KEY]) {
        applySizing(changes[SIZING_STORAGE_KEY]?.newValue);
      }
    };
    browser.storage?.onChanged?.addListener(onLocalChanged as never);

    return () => {
      browser.storage?.onChanged?.removeListener(onChanged as never);
      browser.storage?.onChanged?.removeListener(onLocalChanged as never);
    };
  });

  $effect(() => {
    const sym = symbol;
    filters = null;
    let alive = true;
    void fetchSymbolFilters(sym).then((value) => {
      if (alive) filters = value;
    });
    return () => {
      alive = false;
    };
  });

  const message = $derived(toolsForSymbol(store, symbol));
  const refPrice = $derived(lastPrice !== null && lastPrice > 0 ? lastPrice : null);
  const candles = $derived(snapshot?.candles ?? null);
  const atrs = $derived(computeAtrs({ h1: candles?.h1, h4: candles?.h4, d1: candles?.d1 }));
  const levels = $derived(
    refPrice !== null
      ? buildLevels({ price: refPrice, d1: candles?.d1, w1: candles?.w1, h1: candles?.h1, h4: candles?.h4, findingsLevels })
      : [],
  );
  const fundingRatePct8h = $derived(
    snapshot?.premium && Number.isFinite(snapshot.premium.lastFundingRate)
      ? snapshot.premium.lastFundingRate * 100
      : null,
  );
  const entries = $derived<DrawingCardEntry[]>(
    drawingsFromPositionTools(message).map((drawing) => ({
      symbol: drawing.symbol,
      id: drawing.id,
      result: analyzeDrawing({
        drawing,
        price: refPrice ?? drawing.entry,
        levels,
        atrs,
        capital,
        rules,
        filters: filters ?? undefined,
        fundingRatePct8h,
      }),
    })),
  );
  const model = $derived(
    buildDrawingCardModel({ enabled: settings.readDrawings, symbol, entries }),
  );
  const analysisById = $derived(
    new Map(
      entries.flatMap((entry) =>
        entry.result.ok ? [[entry.id, entry.result.analysis] as const] : [],
      ),
    ),
  );

  const provider = $derived(getProvider(settings.ai.provider));
  const aiConfigured = $derived(provider !== null && settings.ai.model.trim() !== '');
  const consented = $derived(
    (settings.ai.consentedProviders as readonly string[]).includes(settings.ai.provider),
  );
  const pendingAnalysis = $derived(pendingId ? analysisById.get(pendingId) ?? null : null);

  const usd = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function enable() {
    applySettings({ ...settings, readDrawings: true });
  }

  function load(tool: DrawingCardTool) {
    publishSizingLoad(tool.load);
  }

  async function copy(tool: DrawingCardTool) {
    let done = false;
    try {
      await navigator.clipboard.writeText(tool.ticket);
      done = true;
    } catch {
      const area = document.createElement('textarea');
      area.value = tool.ticket;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try {
        done = document.execCommand('copy');
      } catch {
        done = false;
      }
      area.remove();
    }
    if (done) {
      copiedId = tool.id;
      setTimeout(() => {
        if (copiedId === tool.id) copiedId = null;
      }, 1500);
    }
  }

  /** Pide el permiso de host opcional del proveedor; debe colgar del clic. */
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

  async function sendAi(analysis: DrawingAnalysis) {
    if (!provider || aiBusy) return;
    aiBusy = true;
    aiView = null;
    aiError = null;
    try {
      if (!(await ensureHost())) {
        aiError = 'Sin permiso de acceso al sitio del proveedor. Concédelo para poder analizar.';
        return;
      }
      const request = {
        type: 'ai:analyze' as const,
        provider: provider.id,
        model: settings.ai.model,
        payload: drawingAiPayload(analysis),
      };
      let reply = (await browser.runtime.sendMessage(request)) as
        | { view?: AiView | null; reason?: string }
        | undefined;
      if (reply?.reason === 'no_consent') {
        await new Promise((resolve) => setTimeout(resolve, 200));
        reply = (await browser.runtime.sendMessage(request)) as typeof reply;
      }
      if (reply?.view) aiView = reply.view;
      else aiError = aiErrorText(reply?.reason ?? 'net');
    } catch {
      aiError = aiErrorText('net');
    } finally {
      aiBusy = false;
    }
  }

  function startAi(analysis: DrawingAnalysis) {
    if (aiBusy) return;
    if (!consented) {
      pendingId = analysis.drawing.id;
      return;
    }
    void sendAi(analysis);
  }

  function acceptAi() {
    const analysis = pendingAnalysis;
    if (!analysis || !provider) return;
    pendingId = null;
    applySettings({
      ...settings,
      ai: {
        ...settings.ai,
        consentedProviders: [...new Set([...settings.ai.consentedProviders, settings.ai.provider])],
      },
    });
    void sendAi(analysis);
  }

  const consentLine = $derived(
    provider
      ? `Se enviarán a ${provider.label}, y solo a ${provider.label}: símbolo, lado, distancias en % y ATR, R:R bruto y neto, coste de funding y etiquetas de nivel con su distancia. Sin precios, importes ni cantidades.`
      : '',
  );
</script>

<section class="drawing" data-testid="drawing-card" aria-label="Tu dibujo">
  <div class="card-head">
    <h2>Tu dibujo</h2>
    <span class="head-hint">Long/Short Position · solo lectura</span>
  </div>

  {#if model.state === 'off'}
    <p class="hint">{model.text}</p>
    <div class="actions">
      <button type="button" class="btn" data-testid="drawing-enable" disabled={!settingsLoaded} onclick={enable}>
        Activar
      </button>
    </div>
  {:else if model.state === 'empty'}
    <p class="hint" data-testid="drawing-empty">{model.hint}</p>
  {:else}
    {#each model.items as item (item.id)}
      {#if item.kind === 'analysis'}
        {@const tool = item.tool}
        {@const analysis = analysisById.get(tool.id) ?? null}
        <div class="tool" data-testid="drawing-tool">
          <p class="summary" data-testid="drawing-summary">{tool.summary}</p>

          {#if tool.checks.length > 0}
            <ul class="checks">
              {#each tool.checks as check (check.code)}
                <li class="check" class:inverted={check.severity === 'warn'} data-testid="drawing-check">{check.text}</li>
              {/each}
            </ul>
          {/if}

          <dl>
            {#each tool.numbers as row (row.label)}
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            {/each}
          </dl>

          {#if tool.levels.length > 0}
            <p class="note">Niveles en el camino: {tool.levels.join(' · ')}</p>
          {:else}
            <p class="note">Sin niveles entre la entrada y el objetivo.</p>
          {/if}
          <p class="note">Alcance: {tool.reach}.</p>
          <p class="note">Funding: {tool.funding}.</p>
          <p class="note honest" data-testid="drawing-honest">{tool.honestLine}</p>

          <div class="actions">
            <button type="button" class="btn" data-testid="drawing-load" disabled={!canLoad} onclick={() => load(tool)}>
              Cargar en el dimensionador
            </button>
            <button type="button" class="btn ghost" data-testid="drawing-copy" onclick={() => copy(tool)}>
              {copiedId === tool.id ? 'Copiado' : 'Copiar ticket'}
            </button>
            <button
              type="button"
              class="btn ghost"
              data-testid="drawing-ai"
              disabled={aiBusy || !aiConfigured || !analysis}
              onclick={() => analysis && startAi(analysis)}
            >
              Analizar con IA
            </button>
          </div>
          {#if !aiConfigured}
            <p class="note" data-testid="drawing-ai-config">{DRAWING_AI_NOT_CONFIGURED}.</p>
          {/if}

          {#if pendingAnalysis && pendingAnalysis.drawing.id === tool.id && analysis}
            <div class="consent" role="dialog" aria-label="Consentimiento de envío">
              <p class="note">{consentLine}</p>
              <pre class="pre">{serializeForLlm(drawingAiPayload(analysis))}</pre>
              <div class="actions">
                <button type="button" class="btn" data-testid="drawing-ai-accept" onclick={acceptAi}>Aceptar y analizar</button>
                <button type="button" class="btn ghost" onclick={() => (pendingId = null)}>Cancelar</button>
              </div>
            </div>
          {/if}
        </div>
      {:else}
        <div class="tool" data-testid="drawing-invalid">
          <p class="error" role="status">{item.text}</p>
        </div>
      {/if}
    {/each}

    {#if aiBusy}
      <p class="note" role="status">Analizando…</p>
    {/if}
    {#if aiError}
      <p class="error" role="alert" data-testid="drawing-ai-error">{aiError}</p>
    {/if}
    {#if aiView}
      <div class="answer" data-testid="drawing-ai-answer">
        {#if aiView.flag}<p class="error">{aiView.flag}</p>{/if}
        {#if aiView.resumen}<p class="note">{aiView.resumen}</p>{/if}
        {#if aiView.lectura.length > 0}
          <ul class="checks">
            {#each aiView.lectura as line}<li class="check">{line}</li>{/each}
          </ul>
        {/if}
        {#if aiView.opciones.length > 0}
          <ul class="checks">
            {#each aiView.opciones as option}
              <li class="check">{option.accion}{option.coste ? ` — coste: ${option.coste}` : ''}{option.no_aplica_si ? ` — no aplica si: ${option.no_aplica_si}` : ''}</li>
            {/each}
          </ul>
        {/if}
        {#if aiView.preguntas.length > 0}<p class="note">Preguntas: {aiView.preguntas.join(' · ')}</p>{/if}
        {#if aiView.faltan.length > 0}<p class="note">Faltan: {aiView.faltan.join(' · ')}</p>{/if}
        <p class="note honest">{aiView.disclaimer}</p>
      </div>
    {/if}
  {/if}

  <p class="foot">Capital de referencia {usd.format(capital)} USDT · no abre órdenes; las colocas tú en Binance.</p>
</section>

<style>
  .drawing { flex: 0 0 auto; display: flex; flex-direction: column; gap: 0.45rem; background: hsl(var(--surface)); border-radius: var(--radius); padding: 0.65rem 0.7rem; }
  .card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
  .card-head h2 { margin: 0; font-size: 0.78rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: hsl(var(--muted-foreground)); }
  .head-hint { font-size: 0.7rem; color: hsl(var(--subtle-foreground)); }
  .tool { display: flex; flex-direction: column; gap: 0.35rem; background: hsl(var(--background)); border-radius: calc(var(--radius) - 0.3rem); padding: 0.5rem; }
  .summary { margin: 0; font-size: 0.76rem; font-weight: 600; color: hsl(var(--foreground)); line-height: 1.35; }
  .hint, .foot { margin: 0; font-size: 0.7rem; color: hsl(var(--subtle-foreground)); line-height: 1.35; }
  .note { margin: 0; font-size: 0.7rem; color: hsl(var(--muted-foreground)); line-height: 1.35; }
  .honest { color: hsl(var(--subtle-foreground)); }
  .checks { margin: 0; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 0.25rem; }
  .check { font-size: 0.66rem; padding: 0.12rem 0.35rem; border-radius: calc(var(--radius) - 0.4rem); background: hsl(var(--surface-strong)); color: hsl(var(--foreground)); }
  .check.inverted { background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); }
  dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 0.15rem 0.6rem; font-size: 0.72rem; }
  dt { color: hsl(var(--muted-foreground)); }
  dd { margin: 0; font-family: var(--font-mono); font-variant-numeric: tabular-nums; min-width: 0; overflow-wrap: anywhere; }
  .actions { display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .btn { background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); border: 0; border-radius: calc(var(--radius) - 0.3rem); padding: 0.35rem 0.6rem; font-size: 0.72rem; font-weight: 600; cursor: pointer; }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .btn.ghost { background: hsl(var(--surface-strong)); color: hsl(var(--foreground)); }
  .consent { display: flex; flex-direction: column; gap: 0.35rem; background: hsl(var(--surface)); border-radius: calc(var(--radius) - 0.3rem); padding: 0.45rem; }
  .pre { margin: 0; font-size: 0.64rem; line-height: 1.3; white-space: pre-wrap; overflow-wrap: anywhere; color: hsl(var(--muted-foreground)); max-height: 9rem; overflow: auto; }
  .error { margin: 0; font-size: 0.72rem; line-height: 1.35; color: hsl(var(--foreground)); background: hsl(var(--surface-strong)); padding: 0.35rem 0.5rem; border-radius: calc(var(--radius) - 0.3rem); }
  .answer { display: flex; flex-direction: column; gap: 0.3rem; }
</style>
