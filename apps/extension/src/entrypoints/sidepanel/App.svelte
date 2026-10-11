<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { browser } from 'wxt/browser';
  import { analyze, usingAnalysisStub } from '../../lib/analysis';
  import { mountChart, type ChartHandle } from '../../lib/chart';
  import { onTvState, requestTvState, sendPaintCommand } from '../../lib/tv-paint-send';
  import { shapesForFindings } from '../../lib/tv-bridge/shapes';
  import { tvStateHint, type TvChartState } from '../../lib/tv-paint';
  import {
    CHART_FINDING_LIMIT,
    NO_ANNOTATIONS,
    annotationsForFindings,
    findingsLegend,
    renderAnalysis,
    type LegendRow,
  } from '../../lib/findings-view';
  import { fetchKlines, openKlineStream, type LiveSocket } from '../../lib/market-feed';
  import { normalizeSymbol } from '../../lib/market-context';
  import { parseRuntimeMessage } from '../../lib/messages';
  import { NEWS_REFRESH_MS, fetchNews, relativeTime, type NewsItem } from '../../lib/news';
  import {
    DEFAULT_SETTINGS,
    SETTINGS_KEY,
    normalizeSymbolList,
    settingsFromStorage,
    symbolAllowed,
    type ExtensionSettings,
  } from '../../lib/settings';
  import { TIMEFRAMES, type AnalysisResult, type Candle, type Timeframe } from '../../lib/types';

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

  let settings = $state<ExtensionSettings>({ ...DEFAULT_SETTINGS, symbols: [] });
  let settingsLoaded = $state(false);
  let symbolDraft = $state('');
  let settingsOpen = $state(false);
  let blocked = $state(false);

  let newsItems = $state<NewsItem[]>([]);
  let newsNote = $state<string | null>(null);
  let newsLoading = $state(false);
  let nowMs = $state(Date.now());
  /** Estado del gráfico de Binance: para saber si se puede pintar. */
  let tvState = $state<TvChartState | null>(null);
  /** Velas cargadas: el pintado las usa para anclar flechas a precios reales. */
  let rows: Candle[] = [];
  /** true en cuanto se ha mandado algo al gráfico, para no repetir el limpiado. */
  let painting = $state(false);

  const views = $derived(renderAnalysis(result));
  const topFindings = $derived(result.top.length > 0 ? result.top : result.findings);
  const legend = $derived<LegendRow[]>(findingsLegend(topFindings));

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

  onMount(() => {
    const onMessage = (message: unknown) => {
      applyContext(message);
    };
    browser.runtime.onMessage.addListener(onMessage);
    void browser.runtime.sendMessage({ type: 'get-context' }).then(applyContext).catch(() => {});
    // Estado del gráfico: lo empuja el content script y se refresca por si la
    // pestaña cambia mientras el panel está abierto.
    const unsubscribeTv = onTvState((state) => {
      tvState = state;
    });
    const refreshTv = () => {
      void requestTvState().then((state) => {
        if (state !== null) tvState = state;
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
    return () => {
      browser.runtime.onMessage.removeListener(onMessage);
      unsubscribeTv();
      clearInterval(clock);
      clearInterval(tvClock);
    };
  });

  $effect(() => {
    const host = chartHost;
    const sym = symbol;
    const tf = timeframe;
    if (!host) return;

    const handle = mountChart(host);
    chartApi = handle;
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
        if (!alive) return;
        handle.setCandles(rows);
        applyResult(analyze({ symbol: sym, timeframe: tf, candles: rows }));
        loading = false;
        stream = openKlineStream(sym, tf, {
          onCandle(candle, closed) {
            if (!alive) return;
            handle.updateCandle(candle);
            if (!closed) return;
            const index = rows.findIndex((row) => row.time === candle.time);
            if (index >= 0) rows[index] = candle;
            else rows.push(candle);
            applyResult(analyze({ symbol: sym, timeframe: tf, candles: rows }));
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
      handle.destroy();
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
    const shapes = shapesForFindings(top, {
      limit: CHART_FINDING_LIMIT,
      candleTimes: times,
      priceAt: priceAtTime,
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
</script>

<div class="app">
  <header class="header">
    <div class="brand">
      <strong>SWAL</strong>
      <span>futuros · datos públicos</span>
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
    <label class="field check paint-toggle">
      <input
        type="checkbox"
        disabled={!settingsLoaded}
        checked={settings.paintOnChart}
        onchange={(event) => {
          applySettings({
            ...settings,
            paintOnChart: (event.currentTarget as HTMLInputElement).checked,
          });
        }}
      />
      <span>Pintar en el gráfico de Binance (pestaña Trading View)</span>
    </label>
    {#if settings.paintOnChart}
      <p class="hint" data-testid="paint-hint">
        {tvStateHint(tvState) ??
          'Pintando los niveles sobre el gráfico de Binance. Se borran al apagar el interruptor.'}
      </p>
    {/if}
  </header>

  <div class="chart" bind:this={chartHost}></div>

  <!-- Leyenda del gráfico. Vive fuera del canvas a propósito: dentro, el lienzo
       de lightweight-charts se come los clics. -->
  <ol class="legend" aria-label="Leyenda del gráfico">
    {#each legend as row (row.findingId)}
      <li>
        <button
          type="button"
          class:selected={row.findingId === selectedId}
          aria-pressed={row.findingId === selectedId}
          onclick={() => {
            selectedId = row.findingId;
          }}
          data-finding-id={row.findingId}
        >
          <span class="swatch" aria-hidden="true"></span>
          <span class="legend-label">{row.label}</span>
          <span class="legend-prices">
            {#if row.confirm !== null}
              <span class="legend-level" data-kind="confirm">confirma {row.confirm}</span>
            {/if}
            {#if row.invalidate !== null}
              <span class="legend-level" data-kind="invalidate">invalida {row.invalidate}</span>
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
      {#if usingAnalysisStub}
        <p class="hint">El núcleo de análisis todavía no está en este build.</p>
      {/if}
    {/if}
    <ul>
      {#each views as item (item.id)}
        <li>
          <button
            type="button"
            class:selected={item.id === selectedId}
            aria-pressed={item.id === selectedId}
            onclick={() => {
              selectedId = item.id;
            }}
          >
            <span class="label">{item.label}</span>
            <span class="explanation">{item.explanation}</span>
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
          </button>
        </li>
      {/each}
    </ul>
    <div class="foot">
      <span class="live">{live ? 'en vivo' : 'sin conexión en vivo'}</span>
      <span class="live">{symbol} · {timeframe}</span>
    </div>
  </section>

  <section class="news" aria-label="Titulares">
    <h2>
      Titulares
      {#if newsLoading}<span class="news-state">cargando…</span>{/if}
    </h2>
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
  </section>

  <details class="settings" bind:open={settingsOpen}>
    <summary>Ajustes</summary>
    <div class="settings-body">
      <label class="field">
        <span>Temporalidad por defecto</span>
        <select
          disabled={!settingsLoaded}
          value={settings.defaultTimeframe}
          onchange={(event) => {
            const value = (event.currentTarget as HTMLSelectElement).value;
            if ((TIMEFRAMES as readonly string[]).includes(value)) {
              applySettings({ ...settings, defaultTimeframe: value as Timeframe });
            }
          }}
        >
          {#each TIMEFRAMES as tf (tf)}
            <option value={tf}>{tf}</option>
          {/each}
        </select>
      </label>
      <label class="field">
        <span>Símbolos permitidos (vacío = todos)</span>
        <input
          type="text"
          disabled={!settingsLoaded}
          value={symbolDraft}
          spellcheck="false"
          autocomplete="off"
          placeholder="BTC, ETH"
          onblur={() => {
            applySettings({ ...settings, symbols: normalizeSymbolList(symbolDraft) });
          }}
          oninput={(event) => {
            symbolDraft = (event.currentTarget as HTMLInputElement).value;
          }}
        />
      </label>
      <label class="field check">
        <input
          type="checkbox"
          disabled={!settingsLoaded}
          checked={settings.autoSync}
          onchange={(event) => {
            applySettings({ ...settings, autoSync: (event.currentTarget as HTMLInputElement).checked });
          }}
        />
        <span>Seguir la página abierta</span>
      </label>
      <p class="hint">
        Se guarda en <code>storage.local</code> de la extensión. Los titulares se renuevan cada
        {NEWS_REFRESH_MS / 60000} min.
      </p>
    </div>
  </details>
</div>
