<script lang="ts">
  import { validateManual, type ManualPosition } from '../../lib/account/manual-position';

  let {
    symbol,
    lastPrice = null,
    onSave,
    onCancel,
  }: {
    symbol: string;
    lastPrice?: number | null;
    onSave: (value: ManualPosition) => void;
    onCancel: () => void;
  } = $props();

  let side = $state<'long' | 'short'>('long');
  let entry = $state('');
  let size = $state('');
  let stop = $state('');
  let leverage = $state('1');
  let error = $state<string | null>(null);

  function submit(event: Event) {
    event.preventDefault();
    const result = validateManual(symbol, { side, entry, size, stop, leverage }, Date.now());
    if (!result.ok) {
      error = result.error;
      return;
    }
    error = null;
    onSave(result.value);
  }
</script>

<form class="manual" data-testid="manual-form" onsubmit={submit} aria-label="Posición manual">
  <p class="hint">Posición en {symbol}. Se guarda solo en esta sesión del navegador.</p>
  <div class="row">
    <button type="button" class="btn small" class:selected={side === 'long'} aria-pressed={side === 'long'} onclick={() => (side = 'long')}>Largo</button>
    <button type="button" class="btn small" class:selected={side === 'short'} aria-pressed={side === 'short'} onclick={() => (side = 'short')}>Corto</button>
  </div>
  <label class="mfield"><span>Entrada</span><input name="entry" inputmode="decimal" autocomplete="off" placeholder={lastPrice ? String(lastPrice) : ''} bind:value={entry} /></label>
  <label class="mfield"><span>Tamaño (unidades)</span><input name="size" inputmode="decimal" autocomplete="off" bind:value={size} /></label>
  <label class="mfield"><span>Stop (opcional)</span><input name="stop" inputmode="decimal" autocomplete="off" bind:value={stop} /></label>
  <label class="mfield"><span>Apalancamiento</span><input name="leverage" inputmode="numeric" autocomplete="off" bind:value={leverage} /></label>
  {#if error}<p class="hint" role="alert" data-testid="manual-error">! {error}</p>{/if}
  <div class="row">
    <button type="submit" class="btn small" data-testid="manual-save">Guardar</button>
    <button type="button" class="btn small" onclick={onCancel}>Cancelar</button>
  </div>
</form>

<style>
  .manual {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    background: hsl(var(--surface));
    border-radius: var(--radius);
    padding: 0.6rem 0.7rem;
  }
  .row {
    display: flex;
    gap: 0.4rem;
  }
  .mfield {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    font-size: 0.75rem;
    color: hsl(var(--muted-foreground));
  }
  .mfield input {
    background: hsl(var(--background));
    border: 0;
    border-radius: calc(var(--radius) - 0.2rem);
    padding: 0.3rem 0.5rem;
    font-family: var(--font-mono);
  }
  .hint {
    margin: 0;
  }
</style>
