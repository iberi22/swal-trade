<script lang="ts">
  import { NO_DATA } from '../../lib/market-pulse';
  import { bandCloses, formatRemaining, isImminent, nextCloses } from '../../lib/context/closes';
  import type { ContextSnapshot } from '../../lib/context/context-feed';
  import { buildSentiment } from '../../lib/context/sentiment';
  import type { NewsItem } from '../../lib/news';

  let {
    snapshot,
    newsItems,
    nowMs,
  }: { snapshot: ContextSnapshot | null; newsItems: NewsItem[]; nowMs: number } = $props();

  const DISCLAIMER = 'Referencias, no predicciones: la dirección no está medida.';

  const sentiment = $derived(
    buildSentiment({
      fearGreed: snapshot?.fearGreed ?? null,
      premium: snapshot?.premium ?? null,
      ticker24h: snapshot?.ticker ?? null,
      news: newsItems,
    }),
  );
  const allReady = $derived(
    !!snapshot && snapshot.ready.fearGreed && snapshot.ready.market,
  );
  // La matemática de cierres no necesita red: funciona siempre.
  const closes = $derived(
    nextCloses(nowMs, undefined, { nextFundingTimeMs: snapshot?.premium?.nextFundingTime ?? null }),
  );
  const chips = $derived(bandCloses(closes));
  const nearest = $derived(chips[0] ?? null);
  // El resumen plegado cabe en 70 caracteres como el resto de plegables.
  const clamp = (text: string) => (text.length > 70 ? `${text.slice(0, 69)}…` : text);
  const collapsed = $derived(
    [
      sentiment.summary,
      nearest ? `${nearest.label.toLowerCase()} en ${formatRemaining(nearest.remainingMs)}` : '',
    ]
      .filter(Boolean)
      .join(' · '),
  );
  const summaryText = $derived(clamp(`Contexto · ${collapsed}`));
</script>

<section class="ctx" aria-label="Contexto" data-testid="context-band">
  <details class="fold" open>
    <summary>{summaryText}</summary>

    <div data-testid="context-sentiment">
      {#if sentiment.items.length > 0}
        <ul class="chips">
          {#each sentiment.items as item (item.id)}
            <li class="chip" class:warn={item.tone === 'warn'} data-id={item.id}>
              <span class="chip-name">{item.label}</span> {item.value}
            </li>
          {/each}
        </ul>
      {:else if allReady}
        <p class="empty">{NO_DATA}</p>
      {:else}
        <p class="empty">Cargando…</p>
      {/if}
    </div>

    <ul class="chips" data-testid="context-closes" aria-label="Próximos cierres">
      {#each chips as item (item.id)}
        <li
          class="chip"
          class:warn={isImminent(item)}
          class:major={item.major}
          data-id={item.id}
          title="{item.label} · {item.clock}"
        >
          <span class="chip-name">{item.label}</span>
          {formatRemaining(item.remainingMs)}
          <span class="clock">{item.clock}</span>
        </li>
      {/each}
    </ul>

    <p class="disclaimer" data-testid="context-disclaimer">{DISCLAIMER}</p>
  </details>
</section>

<style>
  .ctx {
    flex: 0 0 auto;
  }

  .chips {
    list-style: none;
    margin: 0 0 0.35rem;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .chip {
    background: hsl(var(--surface-strong));
    border-radius: calc(var(--radius) - 0.4rem);
    padding: 0.12rem 0.4rem;
    font-size: 0.68rem;
    line-height: 1.3;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .chip-name {
    color: hsl(var(--muted-foreground));
  }

  .chip.major {
    font-weight: 700;
  }

  .chip.major .chip-name {
    color: hsl(var(--foreground));
  }

  .chip.warn {
    background: hsl(var(--foreground));
    color: hsl(var(--background));
  }

  .chip.warn .chip-name,
  .chip.warn .clock {
    color: hsl(var(--background));
  }

  .clock {
    font-family: var(--font-mono);
    color: hsl(var(--subtle-foreground));
  }

  .empty,
  .disclaimer {
    margin: 0 0 0.3rem;
    font-size: 0.68rem;
    color: hsl(var(--subtle-foreground));
  }

  .disclaimer {
    margin: 0;
  }
</style>
