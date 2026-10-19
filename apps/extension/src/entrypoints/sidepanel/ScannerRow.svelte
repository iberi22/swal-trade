<script lang="ts">
  import { browser } from 'wxt/browser';
  import { analyze } from '../../lib/analysis';
  import { fetchKlines } from '../../lib/market-feed';
  import type { ScannerEvent } from '../../lib/scanner/events';
  import { openPair, type OpenPairDeps } from '../../lib/scanner/open-pair';
  import {
    STUDY_LABEL, analysisLines, detailLines, geometry, planRows, rowText, type ScannerRowEvent,
  } from '../../lib/scanner/view';

  let { event }: { event: ScannerEvent } = $props();

  let open = $state(false);
  let loaded = false;
  let analysisState = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
  let analysis = $state<string[]>([]);
  let openError = $state<string | null>(null);

  const isMarket = $derived(event.count !== undefined);
  const details = $derived(detailLines(event as ScannerRowEvent));
  const plans = $derived(planRows(event));
  const geo = $derived(geometry(event));
  const levelRows = $derived(plans.filter((row) => row.levels !== null));

  async function loadAnalysis() {
    analysisState = 'loading';
    try {
      const candles = await fetchKlines(event.symbol, '15m', 300);
      const result = analyze({ symbol: event.symbol, timeframe: '15m', candles });
      const top = (result.top.length > 0 ? result.top : result.findings)[0] ?? null;
      analysis = analysisLines(top ? { label: String(top.label ?? ''), direction: String(top.direction ?? '') } : null, event);
      analysisState = 'ready';
    } catch {
      analysisState = 'error';
    }
  }

  function toggle() {
    open = !open;
    if (open && !loaded && !isMarket) {
      loaded = true;
      void loadAnalysis();
    }
  }

  async function openInBinance() {
    openError = null;
    try {
      await openPair(event.symbol, { tabs: browser.tabs } as unknown as OpenPairDeps);
    } catch {
      openError = 'No se pudo abrir el par en Binance.';
    }
  }
</script>

<li class="sc-row" data-testid="scanner-row" data-symbol={event.symbol}>
  <button type="button" class="sc-line" class:sc-new={!event.seen} aria-expanded={open} onclick={toggle}>
    <span class="sc-mark" aria-hidden="true">{event.seen ? '' : '•'}</span>
    <span class="sc-text" data-testid="scanner-row-text">{rowText(event)}</span>
    <span class="sc-chev" class:sc-open={open} aria-hidden="true">›</span>
  </button>
  {#if open}
    <div class="sc-detail" data-testid="scanner-detail">
      <ul class="sc-facts">
        {#each details as line (line)}
          <li>{line}</li>
        {/each}
      </ul>

      {#if !isMarket}
        <p class="sc-note">{STUDY_LABEL}: medición pasada en muestra, no un resultado hacia adelante.</p>
        <div class="sc-table-wrap">
          <table class="sc-table" data-testid="scanner-plans">
            <thead>
              <tr>
                <th scope="col">Plan</th>
                <th scope="col">n</th>
                <th scope="col">Acierto [intervalo]</th>
                <th scope="col">Equilibrio</th>
                <th scope="col">R neto medio</th>
                <th scope="col">Grado</th>
              </tr>
            </thead>
            <tbody>
              {#each plans as row (row.mode)}
                <tr data-mode={row.mode}>
                  <th scope="row">{row.modeLabel}<br />{row.direction}</th>
                  <td>{row.n}</td>
                  <td>{row.winRate}</td>
                  <td>{row.breakeven}</td>
                  <td>{row.meanR}</td>
                  <td>{row.grade}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        {#each levelRows as row (row.mode)}
          <p class="sc-levels" data-testid="scanner-levels">{row.modeLabel}: {row.levels}</p>
        {/each}
        {#if geo}
          <div class="sc-geometry" data-testid="scanner-geometry">
            <strong>{geo.title}</strong>
            {#each geo.lines as line (line)}
              <p>{line}</p>
            {/each}
          </div>
        {/if}

        <div class="sc-analysis" data-testid="scanner-analysis" aria-live="polite">
          {#if analysisState === 'loading'}
            <p class="sc-note">Leyendo velas de 15m…</p>
          {:else if analysisState === 'error'}
            <p class="sc-note">No se pudieron leer las velas de 15m.</p>
          {:else if analysisState === 'ready'}
            {#each analysis as line (line)}
              <p class="sc-note">{line}</p>
            {/each}
          {/if}
        </div>

        <div class="sc-actions">
          <button type="button" class="an-btn an-ghost" data-testid="scanner-open-pair" onclick={openInBinance}>
            Abrir en Binance
          </button>
        </div>
        {#if openError}
          <p class="an-error" role="alert">{openError}</p>
        {/if}
      {/if}
    </div>
  {/if}
</li>
