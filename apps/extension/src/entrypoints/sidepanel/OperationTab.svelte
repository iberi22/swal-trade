<script lang="ts">
  import { positionFor, sectionsForMode, type PanelState } from '../../lib/account/panel-controller';
  import {
    TOP_ONE_LINERS,
    collapsedLabel,
    findingOneLiner,
    findingSummary,
    newsCollapsedLabel,
    shortPrice,
    type LegendRow,
    type RenderedFinding,
  } from '../../lib/findings-view';
  import { relativeTime, type NewsItem } from '../../lib/news';
  import type { ExtensionSettings } from '../../lib/settings';
  import type { AnalysisResult, Finding, Timeframe } from '../../lib/types';
  import ExplainCard from './ExplainCard.svelte';
  import MarketPulse from './MarketPulse.svelte';
  import PositionCard from './PositionCard.svelte';
  import RadarCard from './RadarCard.svelte';
  import SizingCard from './SizingCard.svelte';

  let {
    symbol,
    timeframe,
    panel,
    views,
    legend,
    selectedId,
    onSelect,
    loading,
    error,
    usingStub,
    result,
    selectedFinding,
    lastPrice,
    newsItems,
    newsNote,
    newsLoading,
    nowMs,
    settings,
    settingsLoaded,
    applySettings,
  }: {
    symbol: string;
    timeframe: Timeframe;
    panel: PanelState;
    views: RenderedFinding[];
    legend: LegendRow[];
    selectedId: string | null;
    onSelect: (id: string) => void;
    loading: boolean;
    error: string | null;
    usingStub: boolean;
    result: AnalysisResult;
    selectedFinding: Finding | null;
    lastPrice: number | null;
    newsItems: NewsItem[];
    newsNote: string | null;
    newsLoading: boolean;
    nowMs: number;
    settings: ExtensionSettings;
    settingsLoaded: boolean;
    applySettings: (next: ExtensionSettings) => void;
  } = $props();

  const sections = $derived(sectionsForMode(panel.mode, symbol));
  const position = $derived(positionFor(panel.snapshot, symbol));
  const topViews = $derived(views.slice(0, TOP_ONE_LINERS));
  const moreViews = $derived(views.slice(TOP_ONE_LINERS));
  const rawById = $derived(
    new Map((result.top.length > 0 ? result.top : result.findings).map((item) => [String(item.id), item])),
  );
  const newsLabel = $derived(
    newsLoading
      ? collapsedLabel('Titulares', 'cargando…')
      : newsCollapsedLabel(newsItems.length, newsItems[0] ? relativeTime(newsItems[0].publishedAt, nowMs) : null),
  );
</script>

{#snippet findingRow(item: RenderedFinding)}
  <li>
    <details class="finding" class:selected={item.id === selectedId}>
      <summary
        title={findingSummary(rawById.get(item.id) ?? item)}
        onclick={() => onSelect(item.id)}
      >{findingOneLiner(item.label, item.fuerzaPct)}</summary>
      <p class="explanation">{item.explanation}</p>
      <span class="fuerza">
        <span class="fuerza-name">fuerza</span>
        <span
          class="fuerza-track"
          role="meter"
          aria-label="fuerza"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={item.fuerzaPct}
        >
          <span class="fuerza-fill" style:--fuerza-pct="{item.fuerzaPct}%"></span>
        </span>
      </span>
    </details>
  </li>
{/snippet}

{#if sections.notice}
  <p class="mode-notice" data-testid="mode-notice" data-mode={panel.mode}>{sections.notice}</p>
{/if}

{#if sections.position}
  <PositionCard {position} stale={panel.stale} />
{:else if sections.sizing}
  <SizingCard {lastPrice} finding={selectedFinding} compact />
{/if}

<!-- Leyenda del gráfico. Vive fuera del canvas a propósito: dentro, el lienzo
     de lightweight-charts se come los clics. -->
<ol class="legend" aria-label="Leyenda del gráfico">
  {#each legend as row (row.findingId)}
    <li>
      <button
        type="button"
        class:selected={row.findingId === selectedId}
        aria-pressed={row.findingId === selectedId}
        onclick={() => onSelect(row.findingId)}
        data-finding-id={row.findingId}
      >
        <span class="swatch" aria-hidden="true"></span>
        <span class="legend-label">{row.label}</span>
        <span class="legend-prices">
          {#if row.confirm !== null}
            <span class="legend-level" data-kind="confirm">confirma {shortPrice(row.confirm)}</span>
          {/if}
          {#if row.invalidate !== null}
            <span class="legend-level" data-kind="invalidate">invalida {shortPrice(row.invalidate)}</span>
          {/if}
        </span>
      </button>
    </li>
  {/each}
  {#if legend.length === 0}
    <li class="legend-empty">Sin niveles que pintar en este tramo.</li>
  {/if}
</ol>

<section class="findings" aria-label="Hallazgos">
  <h2>Hallazgos</h2>
  {#if loading}
    <p class="empty">Cargando velas públicas…</p>
  {:else if error}
    <p class="empty">{error}</p>
  {:else if views.length === 0}
    <p class="empty">Sin hallazgos en este tramo.</p>
    {#if usingStub}
      <p class="hint">El núcleo de análisis todavía no está en este build.</p>
    {/if}
  {/if}
  <ul>
    {#each topViews as item (item.id)}
      {@render findingRow(item)}
    {/each}
  </ul>
  {#if moreViews.length > 0}
    <details class="fold" data-testid="more-findings">
      <summary>{collapsedLabel('Más hallazgos', moreViews.length)}</summary>
      <ul>
        {#each moreViews as item (item.id)}
          {@render findingRow(item)}
        {/each}
      </ul>
    </details>
  {/if}
</section>

<ExplainCard
  {symbol}
  {timeframe}
  {result}
  ready={settingsLoaded}
  enabled={settings.explainWithAi}
  onToggle={(value) => applySettings({ ...settings, explainWithAi: value })}
/>

{#if sections.market}
  <section class="news" aria-label="Titulares">
    <details class="fold">
      <summary>{newsLabel}</summary>
      {#if newsNote}
        <p class="empty">{newsNote}</p>
      {:else if newsItems.length > 0}
        <ul>
          {#each newsItems as item (item.id)}
            <li>
              <a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a>
              <div class="meta">
                <span class="source">{item.source || 'fuente desconocida'}</span>
                <span>{relativeTime(item.publishedAt, nowMs)}</span>
                <span class="sentiment" data-label={item.sentiment.label}>{item.sentiment.label}</span>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </details>
  </section>

  <MarketPulse {symbol} />

  <RadarCard {symbol} port={settings.radarPort} paintEnabled={settings.paintOnChart} enabled={settings.radarEnabled} />
{/if}
