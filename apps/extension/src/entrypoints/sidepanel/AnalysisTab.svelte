<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import {
    HISTORY_MONTHS_LABEL,
    exportFilename,
    historyErrorText,
    metricsOptionsFor,
    riskPerTradeUsd,
  } from '../../lib/account/analysis-view';
  import { metricsToJson, tradesToCsv } from '../../lib/account/export';
  import { DAY_MS, MAX_HORIZON_DAYS } from '../../lib/account/history';
  import { tripsFromHistory } from '../../lib/account/history-parse';
  import {
    runHistory,
    type GetReply,
    type HistoryProgress,
    type HistoryResult,
    type StoredHistory,
  } from '../../lib/account/history-runner';
  import { createIdbHistoryStorage } from '../../lib/account/idb-history';
  import { computeMetrics, type RoundTrip } from '../../lib/account/metrics';
  import { positionFor, type PanelState } from '../../lib/account/panel-controller';
  import type { ExtensionSettings } from '../../lib/settings';
  import type { Finding } from '../../lib/types';
  import AiCard from './AiCard.svelte';
  import MetricsCard from './MetricsCard.svelte';

  let {
    symbol,
    timeframe,
    panel,
    settings,
    applySettings,
    findings,
    trend,
    lastPrice,
    atr,
  }: {
    symbol: string;
    timeframe: string;
    panel: PanelState;
    settings: ExtensionSettings;
    applySettings: (next: ExtensionSettings) => void;
    findings: readonly Finding[];
    trend: string | null;
    lastPrice: number | null;
    atr: number | null;
  } = $props();

  const storage = createIdbHistoryStorage();

  let stored = $state<StoredHistory | null>(null);
  let running = $state(false);
  let progress = $state<HistoryProgress | null>(null);
  let runError = $state<string | null>(null);
  let stopRequested = false;
  let manualRisk = $state<number | null>(null);

  const configured = $derived(settings.acctMeta.configured);
  const equity = $derived(panel.snapshot?.equity ?? null);
  const riskFromEquity = $derived(equity !== null && equity > 0);
  const riskUsd = $derived(riskPerTradeUsd(settings.rules, equity, manualRisk));
  const unfinished = $derived(stored !== null && !stored.done);

  const trips = $derived<RoundTrip[]>(stored ? tripsFromHistory(stored.fills, stored.income) : []);
  const metrics = $derived(
    stored ? computeMetrics(trips, metricsOptionsFor(settings.rules, riskUsd ?? 0, equity)) : null,
  );
  const position = $derived(positionFor(panel.snapshot, symbol));

  onMount(() => {
    void storage
      .load()
      .then((value) => {
        if (value && value.v === 1) stored = value;
      })
      .catch(() => {});
  });

  async function acctGet(path: string, params: Record<string, string | number | undefined>): Promise<GetReply> {
    try {
      const reply = (await browser.runtime.sendMessage({ type: 'acct:get', path, params })) as
        | { data?: unknown; error?: string }
        | undefined;
      if (!reply) return { error: 'net' };
      return reply.error ? { error: String(reply.error) } : { data: reply.data };
    } catch {
      return { error: 'net' };
    }
  }

  function snapshotOf(result: HistoryResult): StoredHistory {
    // Lo que importa para las métricas; el punto de control exacto ya está en IndexedDB.
    return {
      v: 1,
      fromMs: 0,
      toMs: 0,
      phase: result.progress.phase,
      incomeJobs: 0,
      checkpoint: { jobs: [], index: 0, collected: { rows: result.progress.rows, pages: 0 } },
      income: result.income,
      fills: result.fills,
      skipped: result.skipped,
      nonStableFees: result.nonStableFees,
      done: result.complete,
    };
  }

  async function load() {
    if (running || !configured) return;
    running = true;
    stopRequested = false;
    runError = null;
    const toMs = Date.now();
    try {
      const result = await runHistory(
        { fromMs: toMs - MAX_HORIZON_DAYS * DAY_MS, toMs, resume: unfinished },
        {
          get: acctGet,
          storage,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          onProgress: (p) => {
            progress = p;
          },
          shouldStop: () => stopRequested,
        },
      );
      stored = snapshotOf(result);
      if (result.error) runError = historyErrorText(result.error);
    } catch {
      runError = historyErrorText('net');
    } finally {
      running = false;
    }
  }

  function download(name: string, text: string, mime: string) {
    // Blob + <a download>: no hace falta el permiso `downloads`.
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportCsv() {
    if (trips.length === 0) return;
    download(exportFilename('csv', Date.now()), tradesToCsv(trips), 'text/csv;charset=utf-8');
  }

  function exportJson() {
    if (!metrics) return;
    download(exportFilename('json', Date.now()), metricsToJson(metrics), 'application/json');
  }

  const pct = $derived(progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0);
</script>

<section class="an-tab" aria-label="Análisis">
  <section class="an-card" data-testid="history-card" aria-label="Historial">
    <h2>Historial</h2>
    {#if !configured}
      <p class="an-note" data-testid="history-no-key">
        Para cargar tu historial conecta una clave de solo lectura en Ajustes.
      </p>
    {:else}
      <div class="an-actions">
        <button type="button" class="an-btn" data-testid="history-load" disabled={running} onclick={load}>
          {unfinished ? 'Reanudar carga' : `Cargar historial (${HISTORY_MONTHS_LABEL})`}
        </button>
        {#if running}
          <button type="button" class="an-btn an-ghost" onclick={() => (stopRequested = true)}>Detener</button>
        {/if}
      </div>
      {#if running && progress}
        <progress class="an-progress" max="100" value={pct} aria-label="Progreso de la carga"></progress>
        <p class="an-note" role="status" data-testid="history-progress">
          {progress.phase === 'income' ? 'Ingresos' : 'Operaciones'} · {progress.done}/{progress.total} · {progress.rows} filas
        </p>
      {/if}
      {#if runError}
        <p class="an-error" role="alert" data-testid="history-error">{runError}</p>
      {/if}
      {#if unfinished && !running}
        <p class="an-note">Hay una carga a medias; se reanuda donde se quedó.</p>
      {/if}
    {/if}
  </section>

  <MetricsCard
    {metrics}
    {riskUsd}
    {riskFromEquity}
    bind:manualRisk
    partial={unfinished}
    skipped={stored?.skipped ?? 0}
  />

  <section class="an-card" aria-label="Exportar">
    <h2>Exportar</h2>
    <div class="an-actions">
      <button type="button" class="an-btn an-ghost" data-testid="export-csv" disabled={trips.length === 0} onclick={exportCsv}>
        Exportar CSV
      </button>
      <button type="button" class="an-btn an-ghost" data-testid="export-json" disabled={!metrics} onclick={exportJson}>
        Exportar JSON
      </button>
    </div>
    <p class="an-note">Se guarda en tu equipo; no se sube a ningún sitio.</p>
  </section>

  <AiCard
    {symbol}
    {timeframe}
    {settings}
    {applySettings}
    {panel}
    {position}
    {metrics}
    {findings}
    {trend}
    {lastPrice}
    {atr}
  />

  <p class="an-note an-honesty">
    La fuerza del patrón no es una probabilidad. Esto es una lectura educativa, no una recomendación.
  </p>
</section>

<style>
  .an-tab {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
</style>
