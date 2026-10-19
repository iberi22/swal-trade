<script lang="ts">
  import {
    HONESTY_LINE,
    R_NOMINAL_NOTE,
    bucketText,
    gradeLine,
    metricRows,
    topBuckets,
    type TopBucketKind,
  } from '../../lib/account/analysis-view';
  import type { TradeMetrics } from '../../lib/account/metrics';

  let {
    metrics,
    riskUsd,
    riskFromEquity,
    manualRisk = $bindable(null),
    partial,
    skipped,
  }: {
    metrics: TradeMetrics | null;
    /** Riesgo por operación que se usó para el R nominal; null si falta. */
    riskUsd: number | null;
    /** true si salió de maxRiskPct y el capital; false pide el número a mano. */
    riskFromEquity: boolean;
    manualRisk: number | null;
    /** La carga se detuvo antes de terminar: las cifras son parciales. */
    partial: boolean;
    skipped: number;
  } = $props();

  const GROUPS: ReadonlyArray<{ kind: TopBucketKind; label: string }> = [
    { kind: 'symbol', label: 'Por símbolo' },
    { kind: 'side', label: 'Por lado' },
    { kind: 'hour', label: 'Por hora de apertura' },
  ];
</script>

<section class="an-card" data-testid="metrics-card" aria-label="Métricas de tu historial">
  <h2>Métricas</h2>
  {#if !riskFromEquity}
    <label class="an-field">
      Riesgo por operación (USD)
      <input type="number" min="0" step="any" aria-label="Riesgo por operación en USD" bind:value={manualRisk} />
    </label>
  {/if}
  {#if metrics === null}
    <p class="an-note">Aún no hay historial. Cárgalo arriba para ver tus métricas.</p>
  {:else}
    {#if partial}
      <p class="an-error" data-testid="metrics-partial">Carga incompleta: estas cifras son parciales.</p>
    {/if}
    <dl class="an-rows">
      {#each metricRows(metrics) as row (row.label)}
        <dt>{row.label}</dt>
        <dd>{row.value}</dd>
      {/each}
    </dl>
    {#each GROUPS as group (group.kind)}
      {@const top = topBuckets(metrics, group.kind)}
      {#if top.length > 0}
        <p class="an-note"><strong>{group.label}:</strong> {top.map((b) => bucketText(group.kind, b)).join(' · ')}</p>
      {/if}
    {/each}
    <p class="an-note" data-testid="metrics-grade">{gradeLine(metrics)}</p>
    {#if riskUsd === null}
      <p class="an-note">Sin riesgo por operación el R nominal vale 0. Indícalo arriba.</p>
    {:else}
      <p class="an-note">{R_NOMINAL_NOTE} Usado: {riskUsd.toFixed(2)} USD.</p>
    {/if}
    {#if skipped > 0}
      <p class="an-note">{skipped} filas de Binance no se pudieron leer y se descartaron.</p>
    {/if}
  {/if}
  <p class="an-note an-honesty">{HONESTY_LINE}</p>
</section>
