<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { browser } from 'wxt/browser';
  import { analyze, usingAnalysisStub } from '../../lib/analysis';
  import { mountChart, type ChartHandle } from '../../lib/chart';
  import { annotationsForFinding, NO_ANNOTATIONS, renderAnalysis } from '../../lib/findings-view';
  import { fetchKlines, openKlineStream, type LiveSocket } from '../../lib/market-feed';
  import { normalizeSymbol } from '../../lib/market-context';
  import { parseRuntimeMessage } from '../../lib/messages';
  import { TIMEFRAMES, type AnalysisResult, type Candle, type Timeframe } from '../../lib/types';

  let symbol = $state('BTCUSDT');
  let draft = $state('BTCUSDT');
  let timeframe = $state<Timeframe>('5m');
  let inferred = $state(true);
  let linked = $state(false);
  let trend = $state<string | null>(null);
  let result = $state<AnalysisResult>({ findings: [], trend: null, levels: [], generatedAt: '' });
  let selectedId = $state<string | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let live = $state(false);
  let chartHost = $state<HTMLDivElement | null>(null);
  let chartApi = $state<ChartHandle | null>(null);

  const views = $derived(renderAnalysis(result));

  function applyContext(message: unknown) {
    const parsed = parseRuntimeMessage(message);
    const context =
      parsed?.type === 'market-context'
        ? parsed.context
        : parsed?.type === 'context-result'
          ? parsed.context
          : null;
    if (!context) return;
    symbol = context.symbol;
    draft = context.symbol;
    timeframe = context.timeframe;
    inferred = context.timeframeInferred;
    linked = true;
  }

  function commitSymbol() {
    const next = normalizeSymbol(draft);
    if (!next) {
      draft = symbol;
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
    return () => {
      browser.runtime.onMessage.removeListener(onMessage);
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
    let rows: Candle[] = [];
    loading = true;
    error = null;
    live = false;

    const applyResult = (next: AnalysisResult) => {
      const previous = untrack(() => selectedId);
      result = next;
      trend = next.trend;
      if (!next.findings.some((item) => item.id === previous)) {
        selectedId = next.findings[0]?.id ?? null;
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

  $effect(() => {
    const api = chartApi;
    const id = selectedId;
    const current = result;
    if (!api) return;
    const finding = current.findings.find((item) => item.id === id) ?? null;
    api.setAnnotations(finding ? annotationsForFinding(finding, api.times()) : NO_ANNOTATIONS);
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
    {#if !linked}
      <p class="hint">Abre un futuro en Binance o un gráfico en TradingView.</p>
    {:else if inferred}
      <p class="hint">La página no muestra la temporalidad. Gráfico en {timeframe}.</p>
    {/if}
  </header>

  <div class="chart" bind:this={chartHost} role="img" aria-label="Gráfico de velas"></div>

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
</div>
