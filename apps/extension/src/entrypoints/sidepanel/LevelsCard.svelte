<script lang="ts">
  import { NO_DATA } from '../../lib/market-pulse';
  import type { ContextSnapshot } from '../../lib/context/context-feed';
  import {
    LEVEL_HELP,
    buildLevels,
    computeAtrs,
    expectedRange,
    type FindingLevelInput,
  } from '../../lib/context/levels';
  import { signed } from '../../lib/context/sentiment';
  import { formatPanelPrice } from '../../lib/price-format';

  let {
    lastPrice,
    snapshot,
    findingsLevels,
  }: {
    lastPrice: number | null;
    snapshot: ContextSnapshot | null;
    findingsLevels: FindingLevelInput[];
  } = $props();

  const candles = $derived(snapshot?.candles ?? null);
  const rows = $derived(
    lastPrice !== null && lastPrice > 0
      ? buildLevels({
          price: lastPrice,
          d1: candles?.d1,
          w1: candles?.w1,
          h1: candles?.h1,
          h4: candles?.h4,
          findingsLevels,
        })
      : [],
  );
  const atrs = $derived(computeAtrs({ h1: candles?.h1, h4: candles?.h4, d1: candles?.d1 }));
  const ranges = $derived(
    lastPrice !== null && lastPrice > 0 ? expectedRange({ price: lastPrice, ...atrs }) : [],
  );
  // La fila del precio actual va justo bajo el último nivel que lo supera.
  const markerAt = $derived(
    lastPrice === null ? -1 : rows.filter((row) => row.price >= lastPrice).length,
  );
  const candlesFailed = $derived(!!snapshot && snapshot.ready.candles && candles === null);
</script>

<section class="levels" aria-label="Mapa de niveles" data-testid="levels-card">
  <details class="fold">
    <summary title={LEVEL_HELP}>Mapa de niveles{rows.length > 0 ? ` · ${rows.length} zonas` : ''}</summary>

    {#if lastPrice === null}
      <p class="empty">Esperando precio…</p>
    {:else}
      <p class="sub">Zonas de reacción posible</p>
      <ol class="ladder">
        {#each rows as row, index (row.price + row.label)}
          {#if index === markerAt}
            <li class="now" data-testid="levels-now"><span>▶ precio actual</span><span>{formatPanelPrice(lastPrice)}</span></li>
          {/if}
          <li class="row" data-testid="levels-row" data-side={row.price >= lastPrice ? 'above' : 'below'}>
            <span class="price">{formatPanelPrice(row.price)}</span>
            <span class="name">{row.label}</span>
            <span class="dist">
              {signed(row.distancePct, 2)} %{row.distanceAtr === null ? '' : ` · ${signed(row.distanceAtr, 1)} ATR`}
            </span>
          </li>
        {/each}
        {#if markerAt === rows.length}
          <li class="now" data-testid="levels-now"><span>▶ precio actual</span><span>{formatPanelPrice(lastPrice)}</span></li>
        {/if}
      </ol>
      {#if candlesFailed}
        <p class="empty">Niveles por velas: {NO_DATA}</p>
      {/if}

      {#if ranges.length > 0}
        <ul class="ranges" data-testid="levels-range">
          {#each ranges as range (range.id)}
            <li>
              <span class="name">{range.horizon} · {range.label}</span>
              <span class="dist">
                {formatPanelPrice(range.low)} – {formatPanelPrice(range.high)} (±{range.pct.toFixed(2).replace('.', ',')} %)
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </details>
</section>

<style>
  .levels {
    flex: 0 0 auto;
  }

  .sub,
  .empty {
    margin: 0 0 0.3rem;
    font-size: 0.68rem;
    color: hsl(var(--subtle-foreground));
  }

  .ladder,
  .ranges {
    list-style: none;
    margin: 0 0 0.3rem;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .row {
    display: grid;
    grid-template-columns: 5.2rem minmax(0, 1fr) auto;
    gap: 0.35rem;
    align-items: baseline;
    font-size: 0.7rem;
  }

  .price {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dist {
    font-family: var(--font-mono);
    font-size: 0.66rem;
    color: hsl(var(--muted-foreground));
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .row[data-side='below'] .name {
    color: hsl(var(--muted-foreground));
  }

  .now {
    display: flex;
    justify-content: space-between;
    padding: 0.12rem 0.3rem;
    border-radius: calc(var(--radius) - 0.4rem);
    background: hsl(var(--foreground));
    color: hsl(var(--background));
    font-family: var(--font-mono);
    font-size: 0.68rem;
  }

  .ranges li {
    display: flex;
    justify-content: space-between;
    gap: 0.4rem;
    font-size: 0.68rem;
  }
</style>
