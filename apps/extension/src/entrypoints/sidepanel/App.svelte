<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { browser } from 'wxt/browser';
  import { analyze, usingAnalysisStub, volumeFlowOf } from '../../lib/analysis';
  import { mountChart, mountFlowPane, type ChartHandle, type FlowPaneHandle } from '../../lib/chart';
  import { onTvState, requestTvState, sendPaintCommand } from '../../lib/tv-paint-send';
  import { shapesForFindings } from '../../lib/tv-bridge/shapes';
  import type { TvChartState } from '../../lib/tv-paint';
  import {
    CHART_FINDING_LIMIT,
    NO_ANNOTATIONS,
    annotationsForFindings,
    findingsLegend,
    flowCollapsedLabel,
    renderAnalysis,
    type LegendRow,
  } from '../../lib/findings-view';
  import { fetchKlines, openKlineStream, type LiveSocket } from '../../lib/market-feed';
  import { atrOf } from '../../lib/account/analysis-view';
  import { createPanelController, type PanelState, type PanelTab } from '../../lib/account/panel-controller';
  import { hotkeyTimeframe } from '../../lib/hotkeys';
  import { normalizeSymbol } from '../../lib/market-context';
  import { parseRuntimeMessage } from '../../lib/messages';
  import { fetchNews, type NewsItem } from '../../lib/news';
  import {
    DEFAULT_SETTINGS,
    SETTINGS_KEY,
    settingsFromStorage,
    symbolAllowed,
    type ExtensionSettings,
  } from '../../lib/settings';
  import { TIMEFRAMES, type AnalysisResult, type Candle, type Timeframe } from '../../lib/types';
  import { CVD_LEGEND_TEXT, cvdLineData, flowLegendText } from '../../lib/volume-flow-view';
  import { browserLanguages, initI18n } from '../../lib/i18n/i18n.svelte';
  import MyTradesTab from './MyTradesTab.svelte';
  import OperationTab from './OperationTab.svelte';
  import LearnTab from './LearnTab.svelte';
  import ScannerTab from './ScannerTab.svelte';
  import SettingsTab from './SettingsTab.svelte';
  import SidepanelFooter from './SidepanelFooter.svelte';
  import Tabs from './Tabs.svelte';

  let activeTab = $state<PanelTab>('operacion');
  let symbol = $state('BTCUSDT');
  let draft = $state('BTCUSDT');
  let timeframe = $state<Timeframe>(DEFAULT_SETTINGS.defaultTimeframe);
  let inferred = $state(true);
  let linked = $state(false);
  let trend = $state<string | null>(null);
  let result = $state<AnalysisResult>({ findings: [], top: [], trend: null, levels: [], generatedAt: '' });
  let selectedId = $state<string | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let live = $state(false);
  let chartHost = $state<HTMLDivElement | null>(null);
  let chartApi = $state<ChartHandle | null>(null);
  let flowHost = $state<HTMLDivElement | null>(null);
  let flowApi = $state<FlowPaneHandle | null>(null);
  let flowLegend = $state(CVD_LEGEND_TEXT);
  /** Puntos pintados en el panel de CVD (línea y barras): 0 si no hay flujo. */
  let flowPoints = $state(0);
  /** Delta de la última vela: el dato que resume el panel de CVD plegado. */
  let flowDelta = $state<number | null>(null);

  let settings = $state<ExtensionSettings>({ ...DEFAULT_SETTINGS, symbols: [] });
  let settingsLoaded = $state(false);
  let symbolDraft = $state('');
  let blocked = $state(false);
  let claudeStatus = $state<"connected" | "connecting" | "disconnected">("disconnected");

  function checkClaudeStatus() {
    void browser.runtime
      ?.sendMessage({ type: "get-claude-bridge-status" })
      .then((res) => {
        if (res && typeof res.status === "string") {
          claudeStatus = res.status;
        }
      })
      .catch(() => {
        claudeStatus = "disconnected";
      });
  }

  let newsItems = $state<NewsItem[]>([]);
  let newsNote = $state<string | null>(null);
  let newsLoading = $state(false);
  let nowMs = $state(Date.now());
  /** Estado del gráfico de Binance: para saber si se puede pintar. */
  let tvState = $state<TvChartState | null>(null);
  /** Símbolo y tf del gráfico, solo cuando no casan con el análisis. */
  let tvChart = $state<{ symbol: string; tf: string } | null>(null);
  /** Velas cargadas: el pintado las usa para anclar flechas a precios reales. */
  let rows: Candle[] = [];
  /** true en cuanto se ha mandado algo al gráfico, para no repetir el limpiado. */
  let painting = false;

  const views = $derived(renderAnalysis(result));
  const topFindings = $derived(result.top.length > 0 ? result.top : result.findings);
  const legend = $derived<LegendRow[]>(findingsLegend(topFindings));
  const selectedFinding = $derived(topFindings.find((item) => item.id === selectedId) ?? topFindings[0] ?? null);
  let lastPrice = $state<number | null>(null);
  /** ATR(14) de las velas cargadas, para el contexto relativo de la IA. */
  let atr = $state<number | null>(null);

  // Modo del panel: posición / sin posición / no sé. Solo pregunta a la cuenta
  // mientras el panel se ve y hay una clave de solo lectura.
  let panel = $state<PanelState>({ mode: 'loading', stale: false, snapshot: null, error: null });
  const controller = createPanelController({
    send: (message) => browser.runtime.sendMessage(message),
    now: () => Date.now(),
    isVisible: () => document.visibilityState === 'visible',
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (handle) => window.clearInterval(handle as number),
    onChange: (state) => {
      panel = state;
    },
  });

  $effect(() => {
    controller.setContext({
      symbol,
      configured: settings.acctMeta.configured,
      klinesOk: error === null,
    });
  });

  // Idioma: arranca al cargar los ajustes y se reaplica si cambia el ajuste.
  const uiLocale = $derived(settings.locale);
  $effect(() => {
    if (!settingsLoaded) return;
    void initI18n(uiLocale, browserLanguages());
  });

  function applySettings(next: ExtensionSettings) {
    settings = next;
    symbolDraft = next.symbols.join(', ');
    void browser.storage.local
      ?.set({ [SETTINGS_KEY]: next })
      .catch(() => {});
  }

  function applyContext(message: unknown) {
    const parsed = parseRuntimeMessage(message);
    const context =
      parsed?.type === 'market-context'
        ? parsed.context
        : parsed?.type === 'context-result'
          ? parsed.context
          : null;
    if (!context) return;
    // Con el seguimiento apagado manda lo que escriba el usuario.
    if (!untrack(() => settings.autoSync)) return;
    // Fuera de la lista blanca: el panel no cambia de símbolo.
    if (!symbolAllowed(context.symbol, untrack(() => settings.symbols))) return;
    symbol = context.symbol;
    draft = context.symbol;
    // Si la página no dice su temporalidad, manda la que eligió el usuario.
    timeframe = context.timeframeInferred
      ? untrack(() => settings.defaultTimeframe)
      : context.timeframe;
    inferred = context.timeframeInferred;
    linked = true;
  }

  // La lista blanca se deriva del símbolo mostrado: la ponga la página, los
  // ajustes o el teclado, el aviso sale solo.
  $effect(() => {
    const allowed = symbolAllowed(symbol, settings.symbols);
    blocked = !allowed;
  });

  function commitSymbol() {
    const next = normalizeSymbol(draft);
    if (!next) {
      draft = symbol;
      return;
    }
    if (!symbolAllowed(next, settings.symbols)) {
      draft = next;
      return;
    }
    symbol = next;
    draft = next;
  }

  function onSymbolSubmit(event: SubmitEvent) {
    event.preventDefault();
    commitSymbol();
  }

  function onTimeframe(event: Event) {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if ((TIMEFRAMES as readonly string[]).includes(value)) {
      timeframe = value as Timeframe;
      inferred = false;
    }
  }

  // Pintando sobre el gráfico de Binance: si muestra el mismo par en otra
  // temporalidad, el análisis adopta la del gráfico. Así los niveles que se
  // pintan son los de las velas que el usuario ve, y no hace falta tocar nada.
  $effect(() => {
    if (!settings.paintOnChart || tvState !== 'mismatch' || !tvChart) return;
    const chart = tvChart;
    untrack(() => {
      if (chart.symbol !== symbol) return;
      if (chart.tf === timeframe) return;
      if (!(TIMEFRAMES as readonly string[]).includes(chart.tf)) return;
      timeframe = chart.tf as Timeframe;
      inferred = false;
    });
  });

  onMount(() => {
    const onMessage = (message: unknown) => {
      applyContext(message);
    };
    browser.runtime.onMessage.addListener(onMessage);
    void browser.runtime.sendMessage({ type: 'get-context' }).then(applyContext).catch(() => {});
    // Estado del gráfico: lo empuja el content script y se refresca por si la
    // pestaña cambia mientras el panel está abierto.
    const unsubscribeTv = onTvState((state, chart) => {
      tvState = state;
      tvChart = chart ?? null;
    });
    const refreshTv = () => {
      void requestTvState().then((snapshot) => {
        if (snapshot !== null) {
          tvState = snapshot.state;
          tvChart = snapshot.chart;
        }
      });
    };
    void browser.storage.local
      ?.get(SETTINGS_KEY)
      .then((stored) => {
        const loaded = settingsFromStorage(stored?.settings ?? stored);
        settings = loaded;
        symbolDraft = loaded.symbols.join(', ');
        if (!linked) timeframe = loaded.defaultTimeframe;
        settingsLoaded = true;
      })
      .catch(() => {});
    const clock = setInterval(() => {
      nowMs = Date.now();
    }, 30_000);
    const tvClock = setInterval(refreshTv, 5_000);
    refreshTv();
    checkClaudeStatus();
    const claudeClock = setInterval(checkClaudeStatus, 3_000);
    const onPageHide = () => {
      void sendPaintCommand(null);
    };
    window.addEventListener('pagehide', onPageHide);
    const onVisibility = () => controller.visibilityChanged();
    document.addEventListener('visibilitychange', onVisibility);
    // Atajos del panel: la misma combinación que en la página cambia la
    // temporalidad del análisis. Nunca mientras se escribe en un campo.
    const onHotkey = (event: KeyboardEvent) => {
      const next = hotkeyTimeframe(event, settings.hotkeyMap, settings.hotkeysEnabled && settingsLoaded);
      if (!next) return;
      event.preventDefault();
      event.stopPropagation();
      timeframe = next;
      inferred = false;
    };
    window.addEventListener('keydown', onHotkey, true);
    return () => {
      window.removeEventListener('keydown', onHotkey, true);
      controller.stop();
      document.removeEventListener('visibilitychange', onVisibility);
      browser.runtime.onMessage.removeListener(onMessage);
      unsubscribeTv();
      clearInterval(clock);
      clearInterval(tvClock);
      clearInterval(claudeClock);
      void sendPaintCommand(null);
      window.removeEventListener('pagehide', onPageHide);
    };
  });

  $effect(() => {
    const host = chartHost;
    const flow = flowHost;
    const sym = symbol;
    const tf = timeframe;
    if (!host || !flow) return;

    const handle = mountChart(host);
    const flowPane = mountFlowPane(flow, handle);
    chartApi = handle;
    flowApi = flowPane;
    let alive = true;
    let stream: LiveSocket | null = null;
    loading = true;
    error = null;
    live = false;

    const applyResult = (next: AnalysisResult) => {
      const previous = untrack(() => selectedId);
      result = next;
      trend = next.trend;
      const top = next.top.length > 0 ? next.top : next.findings;
      if (!top.some((item) => item.id === previous)) {
        selectedId = top[0]?.id ?? null;
      }
    };

    void (async () => {
      try {
        rows = await fetchKlines(sym, tf);
        lastPrice = rows[rows.length - 1]?.close ?? null;
        atr = atrOf(rows);
        if (!alive) return;
        handle.setCandles(rows);
        const analysis = analyze({ symbol: sym, timeframe: tf, candles: rows });
        const flowData = analysis.volumeFlow ?? volumeFlowOf(rows);
        flowPane.setFlow(rows, flowData);
        flowLegend = flowLegendText(rows, flowData);
        flowPoints = cvdLineData(rows, flowData).length;
        flowDelta = flowData?.delta?.[flowData.delta.length - 1] ?? null;
        applyResult(analysis);
        loading = false;
        stream = openKlineStream(sym, tf, {
          onCandle(candle, closed) {
            if (!alive) return;
            lastPrice = candle.close;
            handle.updateCandle(candle);
            if (!closed) return;
            const index = rows.findIndex((row) => row.time === candle.time);
            if (index >= 0) rows[index] = candle;
            else rows.push(candle);
            const nextResult = analyze({ symbol: sym, timeframe: tf, candles: rows });
            const liveFlow = nextResult.volumeFlow ?? volumeFlowOf(rows);
            flowPane.setFlow(rows, liveFlow);
            flowLegend = flowLegendText(rows, liveFlow);
            flowPoints = cvdLineData(rows, liveFlow).length;
            flowDelta = liveFlow?.delta?.[liveFlow.delta.length - 1] ?? null;
            applyResult(nextResult);
          },
          onLive(isLive) {
            if (alive) live = isLive;
          },
        });
      } catch {
        if (!alive) return;
        loading = false;
        error = 'No se pudieron cargar las velas públicas.';
      }
    })();

    return () => {
      alive = false;
      stream?.close();
      chartApi = null;
      flowApi = null;
      handle.destroy();
      flowPane.destroy();
    };
  });

  // El gráfico pinta TODOS los hallazgos del top; la selección solo resalta uno.
  $effect(() => {
    const api = chartApi;
    const id = selectedId;
    const current = result;
    if (!api) return;
    const annotation = annotationsForFindings(
      current.top.length > 0 ? current.top : current.findings,
      { candleTimes: api.times(), limit: CHART_FINDING_LIMIT },
    );
    api.setAnnotations(annotation, id);
  });

  /** Precio de cierre de la vela más cercana a un instante, o null. */
  function priceAtTime(time: number): number | null {
    if (rows.length === 0) return null;
    let best = rows[0]!;
    let distance = Math.abs(best.time - time);
    for (const row of rows) {
      const candidate = Math.abs(row.time - time);
      if (candidate < distance) {
        best = row;
        distance = candidate;
      }
    }
    return best.close;
  }

  // Pintar en el gráfico de Binance. Con el interruptor apagado se limpia una
  // sola vez; con él encendido se manda el análisis del símbolo y la
  // temporalidad que el panel tenga cargados, que son los mismos de la página.
  $effect(() => {
    const enabled = settings.paintOnChart && settingsLoaded;
    const current = result;
    const times = chartApi?.times() ?? [];
    if (!enabled) {
      if (!painting) return;
      painting = false;
      void sendPaintCommand(null);
      return;
    }
    painting = true;
    const top = current.top.length > 0 ? current.top : current.findings;
    // Etiqueta el hallazgo elegido (o el primero si no hay ninguno): elegir
    // otro hallazgo vuelve a pintar con sus rótulos, sin llenar de texto.
    const labelId = selectedId ?? top[0]?.id ?? null;
    const shapes = shapesForFindings(top, {
      limit: CHART_FINDING_LIMIT,
      candleTimes: times,
      priceAt: priceAtTime,
      labelId: labelId ? String(labelId) : null,
    });
    void sendPaintCommand({ key: `${symbol}@${timeframe}`, shapes });
  });

  $effect(() => {
    const sym = symbol;
    let alive = true;
    newsItems = [];
    newsNote = null;
    newsLoading = true;
    void (async () => {
      const { items, note } = await fetchNews(sym);
      if (!alive) return;
      newsItems = items;
      newsNote = note;
      newsLoading = false;
    })();
    return () => {
      alive = false;
    };
  });
  function selectFinding(id: string) {
    selectedId = id;
  }
</script>


<div class="app">
  <header class="header">
    <div class="brand">
      <strong>SWAL</strong>
      <span class="live-dot" class:on={live} role="status" aria-label={live ? 'en vivo' : 'sin conexión en vivo'}>
        {live ? 'en vivo' : 'sin conexión'}
      </span>
    </div>
    <form class="controls" onsubmit={onSymbolSubmit}>
      <input
        aria-label="Símbolo"
        value={draft}
        spellcheck="false"
        autocomplete="off"
        maxlength="30"
        oninput={(event) => {
          draft = (event.currentTarget as HTMLInputElement).value.toUpperCase();
        }}
        onblur={commitSymbol}
      />
      <select aria-label="Temporalidad" value={timeframe} onchange={onTimeframe}>
        {#each TIMEFRAMES as tf (tf)}
          <option value={tf}>{tf}</option>
        {/each}
      </select>
    </form>
    {#if trend}
      <p class="trend">{trend}</p>
    {/if}
    {#if blocked}
      <p class="hint">Fuera de tu lista de símbolos. Añádelo en ajustes o cambia el par.</p>
    {:else if !linked}
      <p class="hint">Abre un futuro en Binance o un gráfico en TradingView.</p>
    {:else if inferred}
      <p class="hint">La página no muestra la temporalidad. Gráfico en {timeframe}.</p>
    {/if}
  </header>

  <div class="chart" bind:this={chartHost}></div>

  <!-- Panel de flujo de volumen: línea de CVD y delta por vela, con la misma
       escala de tiempo que el gráfico de precio. Un solo tono, sin rojo ni verde.
       Plegado por defecto: el resumen ya dice hacia dónde empuja el flujo. -->
  <section class="flow" aria-label="Flujo de volumen">
    <details class="fold">
      <summary>{flowCollapsedLabel(flowPoints, flowDelta)}</summary>
      <div class="flow-chart" bind:this={flowHost} data-cvd-points={flowPoints}></div>
      <p class="flow-legend">{flowLegend}</p>
    </details>
  </section>

  <Tabs onTabChange={(tab) => (activeTab = tab)}>
    {#snippet operacion()}
      <OperationTab
        {symbol}
        {timeframe}
        {panel}
        {views}
        {legend}
        {selectedId}
        onSelect={selectFinding}
        {loading}
        {error}
        usingStub={usingAnalysisStub}
        {result}
        {selectedFinding}
        {lastPrice}
        {newsItems}
        {newsNote}
        {newsLoading}
        {nowMs}
        {settings}
        {settingsLoaded}
        {applySettings}
      />
    {/snippet}
    {#snippet aprender()}
      <LearnTab />
    {/snippet}
    {#snippet ajustes()}
      <SettingsTab
        {settings}
        {settingsLoaded}
        bind:symbolDraft
        {symbol}
        {timeframe}
        {tvState}
        {tvChart}
        {claudeStatus}
        {applySettings}
        {checkClaudeStatus}
      />
    {/snippet}
    {#snippet escaner()}
      <ScannerTab active={activeTab === 'escaner'} />
    {/snippet}
    {#snippet mistrades()}
      <MyTradesTab
        active={activeTab === 'mistrades'}
        {symbol}
        {timeframe}
        {panel}
        {settings}
        {settingsLoaded}
        {applySettings}
        findings={topFindings}
        {trend}
        {lastPrice}
        {atr}
        nowMs={nowMs}
      />
    {/snippet}
  </Tabs>

  <SidepanelFooter {symbol} />
</div>
