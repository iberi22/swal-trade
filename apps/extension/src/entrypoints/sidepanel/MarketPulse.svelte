<script lang="ts">
  import {
    FEAR_GREED_KEY,
    NO_DATA,
    browserCache,
    startMarketPulse,
    type MarketPulseSnapshot,
  } from '../../lib/market-pulse';
  import { formatPanelPrice, typicalLevelUsd } from '../../lib/price-format';
  import type { DepthWalls, FearGreed, LiquidationSummary, TimeframeTrend } from '../../lib/types';

  let { symbol }: { symbol: string } = $props();

  let walls = $state<DepthWalls | null>(null);
  let liquidations = $state<LiquidationSummary | null>(null);
  let fearGreed = $state<FearGreed | null>(null);
  let regimen = $state<TimeframeTrend[] | null>(null);
  let live = $state(false);

  const cache = browserCache(FEAR_GREED_KEY);

  $effect(() => {
    // Lo que depende del símbolo se borra al cambiar de par: el pulso nuevo no
    // emite en el arranque y el anterior se vería bajo el símbolo nuevo.
    // Miedo/codicia no depende del par y se conserva.
    walls = null;
    liquidations = null;
    regimen = null;
    live = false;
    const handle = startMarketPulse(symbol, {
      cache,
      onChange: (snapshot: MarketPulseSnapshot) => {
        walls = snapshot.walls;
        liquidations = snapshot.liquidations;
        fearGreed = snapshot.fearGreed;
        regimen = snapshot.regimen;
        live = snapshot.live;
      },
    });
    return () => handle.stop();
  });

  /** Números compactos en español; sin decimales de más. */
  function usd(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return '0 USDT';
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace('.', ',')} M USDT`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace('.', ',')} mil USDT`;
    return `${value.toFixed(1).replace('.', ',')} USDT`;
  }

  /** Precios del libro y precio medio: 2 decimales desde 1; hasta 8 cifras si son menores. */
  const price = (value: number) => formatPanelPrice(value);

  function pct(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return '—';
    return `${value.toFixed(2).replace('.', ',')} %`;
  }

  const fiveMin = $derived(liquidations?.windows[0] ?? null);
  const fifteenMin = $derived(liquidations?.windows[1] ?? null);
  const wallCount = $derived((walls?.bids.length ?? 0) + (walls?.asks.length ?? 0));
  /** La cantidad mediana está en el activo base (PEPE, BTC...): se pasa a USDT con el precio medio. */
  const typicalUsd = $derived(
    walls ? typicalLevelUsd(walls.medianSize, walls.mid) : null,
  );
</script>

<section class="pulse" aria-label="Pulso de mercado">
  <h2>
    Pulso de mercado
    <span class="pulse-state">{live ? 'en vivo' : 'sin conexión en vivo'}</span>
  </h2>

  <div class="pulse-grid">
    <article class="card" aria-label="Muros del libro">
      <h3>Muros del libro</h3>
      {#if walls && wallCount > 0}
        <ul class="walls">
          {#each walls.asks as wall (wall.price)}
            <li data-side="ask">
              <span class="wall-price">{price(wall.price)}</span>
              <span class="wall-usd">{usd(wall.usd)}</span>
              <span class="wall-dist">+{pct(wall.distancePct)}</span>
            </li>
          {/each}
          {#each walls.bids as wall (wall.price)}
            <li data-side="bid">
              <span class="wall-price">{price(wall.price)}</span>
              <span class="wall-usd">{usd(wall.usd)}</span>
              <span class="wall-dist">−{pct(wall.distancePct)}</span>
            </li>
          {/each}
        </ul>
        <p class="note">
          Precio medio {walls.mid === null ? '—' : price(walls.mid)} · margen {pct(walls.spreadPct)} · nivel
          típico ≈ {typicalUsd === null ? '—' : usd(typicalUsd)} (cantidad × precio medio)
        </p>
      {:else}
        <p class="empty">{NO_DATA}</p>
      {/if}
    </article>

    <article class="card" aria-label="Liquidaciones recientes">
      <h3>Liquidaciones recientes</h3>
      {#if liquidations && liquidations.count > 0}
        <p class="big">{usd(fiveMin?.totalUsd ?? 0)}</p>
        <p class="note">
          Últimos 5 min · largos {usd(fiveMin?.longUsd ?? 0)} · cortos {usd(fiveMin?.shortUsd ?? 0)}
        </p>
        <p class="note">
          15 min · largos {usd(fifteenMin?.longUsd ?? 0)} · cortos {usd(fifteenMin?.shortUsd ?? 0)}
        </p>
        {#if liquidations.largest}
          <p class="note">
            Mayor: {usd(liquidations.largest.usd)} de una posición
            {liquidations.largest.side === 'long' ? 'larga' : 'corta'}
          </p>
        {/if}
      {:else}
        <p class="empty">Sin liquidaciones desde que abriste el panel.</p>
      {/if}
    </article>

    <article class="card" aria-label="Miedo y codicia">
      <h3>Miedo y codicia</h3>
      {#if fearGreed}
        <p class="big">{fearGreed.value}<span class="unit">/100</span></p>
        <p class="note">
          {fearGreed.label}. 0 = miedo extremo, 100 = codicia extrema (alternative.me, se actualiza cada
          hora).
        </p>
      {:else}
        <p class="empty">{NO_DATA}</p>
      {/if}
    </article>

    <article class="card" aria-label="Régimen por temporalidad">
      <h3>Régimen</h3>
      {#if regimen && regimen.length > 0}
        <ul class="regime">
          {#each regimen as row (row.timeframe)}
            <li>
              <span class="regime-tf">{row.timeframe}</span>
              <span class="regime-label">{row.label}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="empty">{NO_DATA}</p>
      {/if}
    </article>
  </div>
</section>

<style>
  .pulse {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    flex: 0 0 auto;
  }

  .pulse h2 {
    margin: 0;
    font-size: 0.78rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: hsl(var(--muted-foreground));
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .pulse-state {
    font-size: 0.7rem;
    letter-spacing: 0;
    text-transform: none;
    color: hsl(var(--subtle-foreground));
  }

  .pulse-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
    gap: 0.5rem;
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
    background: hsl(var(--surface));
    border-radius: var(--radius);
    padding: 0.5rem 0.6rem;
  }

  .card h3 {
    margin: 0;
    font-size: 0.72rem;
    font-weight: 600;
    color: hsl(var(--muted-foreground));
  }

  .big {
    margin: 0;
    font-size: 1.15rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .unit {
    font-size: 0.72rem;
    font-weight: 400;
    color: hsl(var(--subtle-foreground));
  }

  .note {
    margin: 0;
    font-size: 0.68rem;
    line-height: 1.35;
    color: hsl(var(--muted-foreground));
  }

  .empty {
    margin: 0;
    font-size: 0.72rem;
    color: hsl(var(--subtle-foreground));
  }

  .walls,
  .regime {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .walls li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 0.35rem;
    align-items: baseline;
    font-family: var(--font-mono);
    font-size: 0.7rem;
  }

  .wall-price {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .wall-usd,
  .wall-dist {
    color: hsl(var(--muted-foreground));
    font-variant-numeric: tabular-nums;
  }

  .walls li[data-side='bid'] .wall-price::before {
    content: '▼ ';
    color: hsl(var(--subtle-foreground));
  }

  .walls li[data-side='ask'] .wall-price::before {
    content: '▲ ';
    color: hsl(var(--subtle-foreground));
  }

  .regime li {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    font-size: 0.72rem;
  }

  .regime-tf {
    font-family: var(--font-mono);
    color: hsl(var(--muted-foreground));
  }

  .regime-label {
    font-weight: 600;
  }
</style>
