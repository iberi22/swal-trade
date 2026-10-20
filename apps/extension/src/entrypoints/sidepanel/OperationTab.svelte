<script lang="ts">
  import { browser } from 'wxt/browser';
  import { evaluateRules } from '../../lib/account/rules';
  import {
    manualStorageKey,
    manualToPositionView,
    parseStoredManual,
    withManualPosition,
    type ManualPosition as ManualData,
  } from '../../lib/account/manual-position';
  import {
    buildRuleInput,
    rememberInitialStop,
    type InitialStopStore,
  } from '../../lib/account/position-view-model';
  import { startContextFeed, type ContextSnapshot } from '../../lib/context/context-feed';
  import { PAGE_ACCOUNT_SESSION_KEY, parseStoredPagePositions } from '../../lib/page-account/messages';
  import {
    PAGE_SOURCE_LABEL,
    pagePositionFor,
    pagePositionToView,
    pageStaleLabel,
    withPagePosition,
  } from '../../lib/page-account/page-position';
  import type { PagePosition } from '../../lib/page-account/parse-positions';
  import type { PageBalance } from '../../lib/page-account/parse-balance';
  import { fetchKlines } from '../../lib/market-feed';
  import { FEAR_GREED_KEY, browserCache } from '../../lib/market-pulse';
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
  import type { AnalysisResult, Candle, Finding, Timeframe } from '../../lib/types';
  import AutoLink from './AutoLink.svelte';
  import ContextBar from './ContextBar.svelte';
  import DrawingCard from './DrawingCard.svelte';
  import ExplainCard from './ExplainCard.svelte';
  import LevelsCard from './LevelsCard.svelte';
  import ManualPosition from './ManualPosition.svelte';
  import MarketPulse from './MarketPulse.svelte';
  import PositionCard from './PositionCard.svelte';
  import RadarCard from './RadarCard.svelte';
  import RulesList from './RulesList.svelte';
  import SizingCard from './SizingCard.svelte';
  import TradeCards from './TradeCards.svelte';

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

  // Posición leída de la página (opt-in, sin credenciales): el content script
  // deja las posiciones abiertas en storage.session y aquí se usan cuando la
  // cuenta por API no dice nada. La instantánea de API siempre manda.
  let pageAccount = $state<{
    positions: PagePosition[];
    balance: PageBalance | null;
    capturedAt: number;
  } | null>(null);

  // Posición escrita a mano (sin credenciales): vive en storage.session y, si el
  // panel no sabe si hay posición, se trata como una de snapshot con fuente `manual`.
  let manual = $state<ManualData | null>(null);
  let showManualForm = $state(false);
  let candles = $state<Candle[]>([]);
  let initialStop = $state<number | null>(null);

  const session = () => browser.storage?.session;

  const initialStopStore: InitialStopStore = {
    async get(key) {
      const value = (await session()?.get(key))?.[key];
      return typeof value === 'number' ? value : null;
    },
    async set(key, price) {
      await session()?.set({ [key]: price });
    },
  };

  $effect(() => {
    const enabled = settings.readPageAccount;
    if (!enabled) {
      pageAccount = null;
      return;
    }
    let alive = true;
    const load = () => {
      void session()
        ?.get(PAGE_ACCOUNT_SESSION_KEY)
        .then((stored) => {
          if (!alive) return;
          const parsed = parseStoredPagePositions(stored?.[PAGE_ACCOUNT_SESSION_KEY]);
          pageAccount = parsed
            ? { positions: parsed.positions, balance: parsed.balance, capturedAt: parsed.capturedAt }
            : null;
        })
        .catch(() => {});
    };
    load();
    const handle = setInterval(load, 5_000);
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === 'session' && changes[PAGE_ACCOUNT_SESSION_KEY]) load();
    };
    try {
      browser.storage?.onChanged?.addListener(onChanged as never);
    } catch {
      // sin onChanged queda el sondeo
    }
    return () => {
      alive = false;
      clearInterval(handle);
      try {
        browser.storage?.onChanged?.removeListener(onChanged as never);
      } catch {
        // nunca se registró
      }
    };
  });

  $effect(() => {
    const sym = symbol;
    let alive = true;
    showManualForm = false;
    manual = null;
    void session()
      ?.get(manualStorageKey(sym))
      .then((stored) => {
        if (alive) manual = parseStoredManual(stored?.[manualStorageKey(sym)], sym);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  });

  function saveManual(value: ManualData) {
    manual = value;
    showManualForm = false;
    void session()?.set({ [manualStorageKey(value.symbol)]: value }).catch(() => {});
  }

  function removeManual() {
    manual = null;
    void session()?.remove(manualStorageKey(symbol)).catch(() => {});
  }

  // Contexto (sentimiento, cierres, niveles): datos públicos de Binance; si fallan, la
  // banda sigue con los cierres, que son matemática pura.
  let contextSnapshot = $state<ContextSnapshot | null>(null);
  const contextCache = browserCache(FEAR_GREED_KEY);

  $effect(() => {
    contextSnapshot = null;
    const handle = startContextFeed(symbol, {
      cache: contextCache,
      onChange: (snapshot) => {
        contextSnapshot = snapshot;
      },
    });
    return () => handle.stop();
  });

  const findingsLevels = $derived(
    legend.map((row) => ({ label: row.label, confirm: row.confirm, invalidate: row.invalidate })),
  );

  const manualView = $derived(manual ? manualToPositionView(manual, lastPrice) : null);
  const pagePosition = $derived(pageAccount ? pagePositionFor(pageAccount.positions, symbol) : null);
  const pageView = $derived(pagePositionToView(pagePosition));
  const pageCapturedAt = $derived(pageAccount?.capturedAt ?? null);
  const pageStale = $derived(pageStaleLabel(pageCapturedAt, nowMs));
  // Orden: API > página > manual. Cada paso solo actúa si nadie más sabía nada.
  const pagePanel = $derived(withPagePosition(panel, pageView, symbol, pageCapturedAt, nowMs));
  const effectivePanel = $derived(withManualPosition(pagePanel, manualView, symbol, nowMs));
  const isPage = $derived(pagePanel !== panel);
  const isManual = $derived(effectivePanel !== pagePanel);
  const sections = $derived(sectionsForMode(effectivePanel.mode, symbol));
  const position = $derived(positionFor(effectivePanel.snapshot, symbol));

  // Velas para el ATR: solo se piden con posición abierta.
  $effect(() => {
    if (effectivePanel.mode !== 'position') return;
    const sym = symbol;
    const tf = timeframe;
    let alive = true;
    const load = () =>
      void fetchKlines(sym, tf, 100)
        .then((rows) => {
          if (alive) candles = rows;
        })
        .catch(() => {
          if (alive) candles = [];
        });
    load();
    const handle = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(handle);
    };
  });

  $effect(() => {
    const p = position;
    const salt = manual && isManual ? String(manual.savedMs) : '';
    if (!p) {
      initialStop = null;
      return;
    }
    let alive = true;
    void rememberInitialStop(initialStopStore, p, salt).then((value) => {
      if (alive) initialStop = value;
    });
    return () => {
      alive = false;
    };
  });

  const ruleResults = $derived(
    position && effectivePanel.snapshot
      ? evaluateRules(
          buildRuleInput({
            position,
            snapshot: effectivePanel.snapshot,
            candles,
            rules: settings.rules,
            initialStopPrice: initialStop,
            now: nowMs,
          }),
        )
      : [],
  );
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
      ><AutoLink text={findingOneLiner(item.label, item.fuerzaPct)} /></summary>
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

<ContextBar snapshot={contextSnapshot} {newsItems} {nowMs} />
<LevelsCard {lastPrice} snapshot={contextSnapshot} {findingsLevels} />

{#if sections.notice}
  <p class="mode-notice" data-testid="mode-notice" data-mode={effectivePanel.mode}>{sections.notice}</p>
{/if}

{#if effectivePanel.mode === 'unknown'}
  {#if showManualForm}
    <ManualPosition {symbol} {lastPrice} onSave={saveManual} onCancel={() => (showManualForm = false)} />
  {:else}
    <button type="button" class="btn small" data-testid="manual-open" onclick={() => (showManualForm = true)}>Tengo una posición</button>
  {/if}
{/if}

{#if sections.position}
  <PositionCard
    {position}
    snapshot={effectivePanel.snapshot}
    {nowMs}
    stale={effectivePanel.stale}
    manual={isManual}
    sourceLabel={isPage ? PAGE_SOURCE_LABEL : null}
    staleNote={isPage ? pageStale : null}
    onRemoveManual={removeManual}
  />
  <RulesList results={ruleResults} />
{:else if sections.sizing}
  <SizingCard
    {lastPrice}
    finding={selectedFinding}
    compact
    {symbol}
    pageBalance={pageAccount?.balance ?? null}
    pageBalanceCapturedAt={pageAccount?.capturedAt ?? null}
    {nowMs}
    readPageAccount={settings.readPageAccount}
  />
{/if}

<DrawingCard
  {symbol}
  {lastPrice}
  snapshot={contextSnapshot}
  {findingsLevels}
  rules={settings.rules}
  {settings}
  {settingsLoaded}
  {applySettings}
  canLoad={sections.sizing}
/>

<TradeCards
  {symbol}
  {lastPrice}
  snapshot={contextSnapshot}
  {findingsLevels}
  rules={settings.rules}
  canLoad={sections.sizing}
  pageBalance={pageAccount?.balance ?? null}
  pageBalanceCapturedAt={pageAccount?.capturedAt ?? null}
  {nowMs}
  readPageAccount={settings.readPageAccount}
/>

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
        <span class="legend-label"><AutoLink text={row.label} /></span>
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
