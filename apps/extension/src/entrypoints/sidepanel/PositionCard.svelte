<script lang="ts">
  import { positionCardView } from '../../lib/account/position-view-model';
  import type { AccountSnapshot, PositionView } from '../../lib/account/types';

  let {
    position,
    snapshot = null,
    nowMs,
    stale = false,
    manual = false,
    onRemoveManual,
  }: {
    position: PositionView | null;
    snapshot?: AccountSnapshot | null;
    nowMs: number;
    stale?: boolean;
    manual?: boolean;
    onRemoveManual?: () => void;
  } = $props();

  const view = $derived(position ? positionCardView(position, snapshot, nowMs, { stale, manual }) : null);
</script>

<section class="position" data-testid="position-card" data-stale={stale} aria-label="Posición abierta">
  {#if view}
    {#each view.lines as line, i (i)}
      <p class="line" class:strong={i === 0 || line === 'SIN STOP'}>{line}</p>
    {/each}
    {#if manual && onRemoveManual}
      <button type="button" class="btn small" data-testid="manual-remove" onclick={onRemoveManual}>Quitar</button>
    {/if}
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
  .position :global(.btn) {
    align-self: flex-start;
    margin-top: 0.3rem;
  }
</style>
