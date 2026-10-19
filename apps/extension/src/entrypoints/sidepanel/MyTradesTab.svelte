<script lang="ts">
  import { browser } from 'wxt/browser';
  import { aiErrorText } from '../../lib/account/analysis-view';
  import { pageHistoryAiPayload, pageHistoryAiText } from '../../lib/page-account/ai-payload';
  import { pageHistoryFilename, pageHistoryToCsv } from '../../lib/page-account/export';
  import { pageHistoryTime } from '../../lib/page-account/page-history';
  import { pageStaleLabel } from '../../lib/page-account/page-position';
  import {
    parsePageAccountResult,
    parsePageAccountDiagnoseResult,
    PAGE_ACCOUNT_CLEAR,
    PAGE_ACCOUNT_DIAGNOSE,
    PAGE_ACCOUNT_GET,
  } from '../../lib/page-account/messages';
  import type { AiView } from '../../lib/ai/prompt';
  import { getProvider, isFreeModel } from '../../lib/ai/providers';
  import type { ExtensionSettings } from '../../lib/settings';
  import {
    EVIDENCE_MIN_N,
    filterHistory,
    historySymbols,
    metricsLines,
    openPositionLines,
    sideLabel,
    type HistorySideFilter,
  } from '../../lib/page-account/view';

  let {
    active = false,
    settings,
    settingsLoaded,
    applySettings,
    nowMs,
  }: {
    active?: boolean;
    settings: ExtensionSettings;
    settingsLoaded: boolean;
    applySettings: (next: ExtensionSettings) => void;
    nowMs: number;
  } = $props();

  let state = $state.raw<ReturnType<typeof parsePageAccountResult> | null>(null);
  let filterSymbol = $state('');
  let filterSide = $state<HistorySideFilter>('all');
  let note = $state<string | null>(null);
  let aiView = $state<AiView | null>(null);
  let aiError = $state<string | null>(null);
  let aiBusy = $state(false);
  let pendingConsent = $state(false);

  const enabled = $derived(settings.readPageAccount);

  const load = () => {
    if (!enabled) return;
    void browser.runtime
      .sendMessage({ type: PAGE_ACCOUNT_GET })
      .then((raw) => {
        const parsed = parsePageAccountResult(raw);
        if (parsed) state = parsed;
      })
      .catch(() => {});
  };

  // Solo se pregunta por lo leído mientras la pestaña se ve: es dato local.
  $effect(() => {
    if (!settingsLoaded || !enabled) {
      state = null;
      return;
    }
    let alive = true;
    load();
    if (!active) {
      return () => {
        alive = false;
      };
    }
    const handle = setInterval(() => {
      if (alive) load();
    }, 5_000);
    return () => {
      alive = false;
      clearInterval(handle);
    };
  });

  const positions = $derived(state?.positions ?? []);
  const history = $derived(state?.history ?? []);
  const metrics = $derived(state?.metrics ?? null);
  const capturedAt = $derived(state?.capturedAt ?? null);
  const stale = $derived(pageStaleLabel(capturedAt, nowMs));
  const symbols = $derived(historySymbols(history));
  const filtered = $derived(filterHistory(history, { symbol: filterSymbol, side: filterSide }));
  const newestFirst = $derived(
    [...filtered].sort((a, b) => pageHistoryTime(b) - pageHistoryTime(a)),
  );
  const lines = $derived(openPositionLines(positions));
  const metricsText = $derived(metrics ? metricsLines(metrics) : []);
  const noEvidence = $derived(metrics !== null && metrics.n < EVIDENCE_MIN_N);

  function enable() {
    applySettings({ ...settings, readPageAccount: true });
  }

  async function copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      let done = false;
      try {
        done = document.execCommand('copy');
      } catch {
        done = false;
      }
      area.remove();
      return done;
    }
  }

  function exportCsv() {
    const rows = filtered.length > 0 ? filtered : history;
    if (rows.length === 0) {
      note = 'No hay operaciones que exportar.';
      return;
    }
    const csv = pageHistoryToCsv(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = pageHistoryFilename(Date.now());
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    note = `Exportadas ${rows.length} operaciones a CSV.`;
  }

  async function diagnose() {
    note = null;
    try {
      const reply = await browser.runtime.sendMessage({ type: PAGE_ACCOUNT_DIAGNOSE });
      const outline = parsePageAccountDiagnoseResult(reply);
      if (!outline) {
        note = 'Abre la página de futuros de Binance para copiar el diagnóstico.';
        return;
      }
      const copied = await copyText(outline);
      note = copied
        ? `Diagnóstico anonimizado copiado (${outline.length} caracteres).`
        : 'No se pudo copiar el diagnóstico.';
    } catch {
      note = 'No se pudo leer la página.';
    }
  }

  async function clearData() {
    note = null;
    try {
      await browser.runtime.sendMessage({ type: PAGE_ACCOUNT_CLEAR });
      state = null;
      aiView = null;
      note = 'Datos leídos borrados de este navegador.';
      load();
    } catch {
      note = 'No se pudieron borrar los datos.';
    }
  }

  const provider = $derived(getProvider(settings.ai.provider));
  const consented = $derived(
    (settings.ai.consentedProviders as readonly string[]).includes(settings.ai.provider),
  );
  const free = $derived(isFreeModel(settings.ai.provider, settings.ai.model));
  const consentLine = $derived(
    provider
      ? `Se enviarán a ${provider.label}, y solo a ${provider.label}: número de operaciones, aciertos, ROI medio, mejor y peor en %, duración, apalancamiento y reparto por símbolo y lado. Sin importes, tamaños ni precios.`
      : '',
  );

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

  async function sendAi() {
    if (!provider || !metrics || aiBusy) return;
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
        payload: pageHistoryAiPayload(metrics),
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

  function startAi() {
    if (aiBusy || !metrics || metrics.n === 0) return;
    if (!consented) {
      pendingConsent = true;
      return;
    }
    void sendAi();
  }

  function acceptAi() {
    if (!provider) return;
    pendingConsent = false;
    applySettings({
      ...settings,
      ai: {
        ...settings.ai,
        consentedProviders: [...new Set([...settings.ai.consentedProviders, settings.ai.provider])],
      },
    });
    void sendAi();
  }
</script>

<section class="mis-trades" data-testid="mytrades-tab" aria-label="Mis trades">
  <div class="card-head">
    <h2>Mis trades</h2>
    <span class="head-hint">leído de tu página · solo lectura</span>
  </div>

  {#if !enabled}
    <p class="hint">
      Lee el texto que ya ves en la página de futuros de Binance: tus posiciones abiertas y el
      historial que abras. No pulsa nada, no escribe en la página y no sale de este navegador.
    </p>
    <div class="actions">
      <button
        type="button"
        class="btn"
        data-testid="mytrades-enable"
        disabled={!settingsLoaded}
        onclick={enable}
      >Leer mi página</button>
    </div>
  {:else}
    <p class="hint">Lee el texto que ya ves en la página. No pulsa nada y no sale de tu navegador.</p>
    {#if stale}
      <p class="hint" data-testid="mytrades-stale">{stale}</p>
    {/if}

    <h3>Posiciones abiertas</h3>
    <ul class="rows" data-testid="mytrades-positions">
      {#if lines.length === 0}
        <li class="empty">Abre la página de futuros de Binance.</li>
      {:else}
        {#each lines as line, i (i)}
          <li class="row">{line}</li>
        {/each}
      {/if}
    </ul>

    <h3>Historial de posiciones</h3>
    {#if history.length === 0}
      <p class="hint" data-testid="mytrades-history-hint">
        Abre la pestaña «Historial de posiciones» en Binance (elige 1 mes) para que la lea.
      </p>
    {:else}
      <div class="filters">
        <label class="field">
          <span>Símbolo</span>
          <select
            data-testid="mytrades-filter-symbol"
            value={filterSymbol}
            onchange={(event) => (filterSymbol = (event.currentTarget as HTMLSelectElement).value)}
          >
            <option value="">Todos</option>
            {#each symbols as item (item)}
              <option value={item}>{item}</option>
            {/each}
          </select>
        </label>
        <label class="field">
          <span>Lado</span>
          <select
            data-testid="mytrades-filter-side"
            value={filterSide}
            onchange={(event) =>
              (filterSide = (event.currentTarget as HTMLSelectElement).value as HistorySideFilter)}
          >
            <option value="all">Todos</option>
            <option value="long">Largo</option>
            <option value="short">Corto</option>
          </select>
        </label>
      </div>
      <ul class="rows" aria-label="Operaciones cerradas">
        {#each newestFirst as row (row.key)}
          <li class="row" data-testid="mytrades-history-row">
            <span class="strong">{row.symbol}</span>
            <span>{sideLabel(row.side)}</span>
            <span>{row.realizedPnl === null ? 'sin PnL' : `${row.realizedPnl > 0 ? '+' : ''}${row.realizedPnl} ${row.pnlAsset ?? ''}`}</span>
            <span>{row.roiPct === null ? 'ROI —' : `ROI ${row.roiPct} %`}</span>
            <span class="muted">{row.leverage === null ? '—' : `${row.leverage}x`}</span>
          </li>
        {/each}
      </ul>
      {#if newestFirst.length === 0}
        <p class="empty">Ninguna operación con ese filtro.</p>
      {/if}
    {/if}
  {/if}

  {#if enabled}
    <section class="metrics" data-testid="mytrades-metrics" aria-label="Métricas del historial">
      {#each metricsText as line, i (i)}
        <p class="line" class:strong={i === 0}>{line}</p>
      {/each}
      {#if noEvidence}
        <p class="hint" data-testid="mytrades-no-evidence">
          Sin evidencia: con menos de {EVIDENCE_MIN_N} operaciones esto es tu registro, no una
          medida.
        </p>
      {/if}
    </section>

    <div class="actions">
      <button type="button" class="btn small" data-testid="mytrades-export" onclick={exportCsv}>
        Exportar CSV
      </button>
      <button type="button" class="btn small" data-testid="mytrades-diagnose" onclick={diagnose}>
        Copiar diagnóstico
      </button>
      <button type="button" class="btn small" data-testid="mytrades-clear" onclick={clearData}>
        Borrar datos leídos
      </button>
    </div>
    {#if note}
      <p class="hint" data-testid="mytrades-note">{note}</p>
    {/if}

    <div class="ai">
      <button
        type="button"
        class="btn"
        data-testid="mytrades-ai"
        disabled={!provider || settings.ai.model.trim() === '' || !metrics || metrics.n === 0 || aiBusy}
        onclick={startAi}
      >Analizar con IA</button>
      {#if provider}
        <p class="hint" data-testid="mytrades-ai-consent">{consentLine}</p>
        {#if free}
          <p class="hint">Modelo gratuito: el proveedor puede usar lo que envías para entrenar.</p>
        {/if}
      {:else}
        <p class="hint">Elige un proveedor de IA y un modelo en Ajustes.</p>
      {/if}
      {#if pendingConsent}
        <p class="hint">Aún no has autorizado a {provider?.label}. Nada se ha enviado.</p>
        <div class="actions">
          <button type="button" class="btn small" data-testid="mytrades-ai-accept" onclick={acceptAi}>
            Entendido, enviar
          </button>
          <button type="button" class="btn small" onclick={() => (pendingConsent = false)}>Cancelar</button>
        </div>
      {/if}
      {#if metrics && metrics.n > 0}
        <details class="fold">
          <summary>Ver lo que se envía</summary>
          <pre class="pre">{pageHistoryAiText(metrics)}</pre>
        </details>
      {/if}
      {#if aiBusy}
        <p class="empty">Analizando…</p>
      {/if}
      {#if aiError}
        <p class="empty" data-testid="mytrades-ai-error">{aiError}</p>
      {/if}
      {#if aiView}
        <div class="ai-view" data-testid="mytrades-ai-view">
          <p>{aiView.resumen}</p>
          {#each aiView.lectura as item, i (i)}
            <p class="hint">{item}</p>
          {/each}
          <p class="hint">{aiView.disclaimer}</p>
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .mis-trades {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    flex: 0 0 auto;
  }
  .card-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .card-head h2 {
    margin: 0;
    font-size: 0.95rem;
  }
  .head-hint {
    font-size: 0.7rem;
    color: hsl(var(--muted-foreground));
  }
  h3 {
    margin: 0;
    font-size: 0.78rem;
    color: hsl(var(--muted-foreground));
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-family: var(--font-mono);
    font-size: 0.74rem;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    background: hsl(var(--surface));
    border-radius: var(--radius);
    padding: 0.3rem 0.45rem;
    font-variant-numeric: tabular-nums;
  }
  .strong {
    font-weight: 700;
  }
  .muted {
    color: hsl(var(--muted-foreground));
  }
  .filters {
    display: flex;
    gap: 0.4rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .metrics {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    background: hsl(var(--surface));
    border-radius: var(--radius);
    padding: 0.5rem 0.6rem;
    font-family: var(--font-mono);
    font-size: 0.74rem;
    font-variant-numeric: tabular-nums;
  }
  .metrics .line {
    margin: 0;
  }
  .ai {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .pre {
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 0.68rem;
    margin: 0;
    max-height: 12rem;
    overflow: auto;
  }
</style>
