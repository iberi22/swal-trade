<script lang="ts">
  import { positionCardLines } from '../../lib/account/panel-controller';
  import type { PositionView } from '../../lib/account/types';

  // Versión mínima: T14 la enriquece (reglas, historial, análisis).
  let { position, stale = false }: { position: PositionView | null; stale?: boolean } = $props();

  const lines = $derived(position ? positionCardLines(position, stale) : []);
</script>

<section class="position" data-testid="position-card" data-stale={stale} aria-label="Posición abierta">
  {#if position}
    {#each lines as line, i (i)}
      <p class="line" class:strong={i === 0 || line === 'SIN STOP'}>{line}</p>
    {/each}
  {:else}
    <p class="line strong">Posición abierta · sin detalle</p>
  {/if}
</section>

<style>
  .position {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    background: hsl(var(--surface));
    border-radius: var(--radius);
    padding: 0.6rem 0.7rem;
    font-family: var(--font-mono);
    font-size: 0.78rem;
  }
  .line {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }
  .strong {
    font-weight: 700;
  }
</style>
