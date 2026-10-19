<script lang="ts">
  import { defaultPresets } from '../../lib/trade-cards/presets';
  import { MAX_PRESETS, normalizePresets } from '../../lib/trade-cards/storage';
  import type { TradeCardPreset } from '../../lib/trade-cards/types';

  let { presets, onChange }: { presets: TradeCardPreset[]; onChange: (next: TradeCardPreset[]) => void } = $props();

  const val = (e: Event) => (e.currentTarget as HTMLInputElement | HTMLSelectElement).value;

  function commit(next: TradeCardPreset[]) {
    onChange(normalizePresets(next));
  }

  function patch(id: string, fn: (p: TradeCardPreset) => TradeCardPreset) {
    commit(presets.map((p) => (p.id === id ? fn(structuredClone($state.snapshot(p)) as TradeCardPreset) : p)));
  }

  function duplicate(p: TradeCardPreset) {
    if (presets.length >= MAX_PRESETS) return;
    const copy = structuredClone($state.snapshot(p)) as TradeCardPreset;
    copy.id = `u-${Math.random().toString(36).slice(2, 8)}`;
    copy.name = `${p.name} (copia)`.slice(0, 40);
    commit([...presets, copy]);
  }

  function setStopKind(p: TradeCardPreset, kind: string): TradeCardPreset {
    if (kind === 'atr') p.stop = { kind: 'atr', atrMult: 1.5 };
    else if (kind === 'pct') p.stop = { kind: 'pct', pct: 1 };
    else p.stop = { kind: 'invalidation' };
    return p;
  }
</script>

<details class="edit" data-testid="trade-card-edit">
  <summary>Editar tarjetas</summary>
  <ul>
    {#each presets as p (p.id)}
      <li>
        <input class="name" aria-label="Nombre" maxlength="40" value={p.name} onchange={(e) => patch(p.id, (c) => ({ ...c, name: val(e) }))} />
        <div class="row">
          <label>Lado
            <select value={p.side} onchange={(e) => patch(p.id, (c) => ({ ...c, side: val(e) as TradeCardPreset['side'] }))}>
              <option value="auto">Auto</option><option value="long">Largo</option><option value="short">Corto</option>
            </select>
          </label>
          <label>Entrada
            <select value={p.entry.kind} onchange={(e) => patch(p.id, (c) => ({ ...c, entry: val(e) === 'market' ? { kind: 'market' } : { kind: 'limit_level', pick: 'nearest_support' } }))}>
              <option value="limit_level">Límite en nivel</option><option value="market">Mercado</option>
            </select>
          </label>
          <label>Tamaño
            <select value={p.size.basis} onchange={(e) => patch(p.id, (c) => ({ ...c, size: { ...c.size, basis: val(e) as 'risk' | 'margin' } }))}>
              <option value="risk">Riesgo %</option><option value="margin">Margen %</option>
            </select>
          </label>
          <label>%
            <input type="number" min="0.1" max="50" step="0.1" value={p.size.pct} onchange={(e) => patch(p.id, (c) => ({ ...c, size: { ...c.size, pct: Number(val(e)) } }))} />
          </label>
        </div>
        <div class="row">
          <label>Stop
            <select value={p.stop.kind} onchange={(e) => patch(p.id, (c) => setStopKind(c, val(e)))}>
              <option value="invalidation">Invalidación</option><option value="atr">ATR</option><option value="pct">%</option>
            </select>
          </label>
          {#if p.stop.kind === 'atr'}
            <label>× ATR
              <input type="number" min="0.5" max="6" step="0.1" value={p.stop.atrMult ?? 1.5} onchange={(e) => patch(p.id, (c) => ({ ...c, stop: { kind: 'atr', atrMult: Number(val(e)) } }))} />
            </label>
          {:else if p.stop.kind === 'pct'}
            <label>Stop %
              <input type="number" min="0.1" max="20" step="0.1" value={p.stop.pct ?? 1} onchange={(e) => patch(p.id, (c) => ({ ...c, stop: { kind: 'pct', pct: Number(val(e)) } }))} />
            </label>
          {/if}
          <label>Apal.
            <input value={p.leverage} aria-label="Apalancamiento (min o número)" onchange={(e) => patch(p.id, (c) => ({ ...c, leverage: val(e).trim().toLowerCase() === 'min' ? 'min' : Number(val(e)) }))} />
          </label>
          <label>Tramos
            <select value={p.scaleIn?.tranches ?? 0} onchange={(e) => patch(p.id, (c) => { const n = Number(val(e)); const { scaleIn: _drop, ...rest } = c; return n ? { ...rest, scaleIn: { tranches: n as 2 | 3 | 4 } } : rest; })}>
              <option value="0">No</option><option value="2">2</option><option value="3">3</option><option value="4">4</option>
            </select>
          </label>
        </div>
        <div class="row">
          <label>Objetivos (R)
            <input value={p.tp.rMultiples.join(', ')} onchange={(e) => patch(p.id, (c) => ({ ...c, tp: { ...c.tp, rMultiples: val(e).split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0) } }))} />
          </label>
          <label class="check"><input type="checkbox" checked={p.tp.useNextLevel} onchange={(e) => patch(p.id, (c) => ({ ...c, tp: { ...c.tp, useNextLevel: (e.currentTarget as HTMLInputElement).checked } }))} /> Siguiente nivel</label>
        </div>
        <div class="row actions">
          <button type="button" class="mini" onclick={() => duplicate(p)} disabled={presets.length >= MAX_PRESETS}>Duplicar</button>
          <button type="button" class="mini" onclick={() => commit(presets.filter((x) => x.id !== p.id))}>Eliminar</button>
        </div>
      </li>
    {/each}
  </ul>
  <button type="button" class="mini" onclick={() => onChange(defaultPresets())}>Restablecer</button>
</details>

<style>
  .edit { font-size: 0.72rem; color: hsl(var(--muted-foreground)); }
  summary { cursor: pointer; }
  ul { list-style: none; margin: 0.4rem 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  li { background: hsl(var(--background)); border-radius: calc(var(--radius) - 0.3rem); padding: 0.4rem; display: flex; flex-direction: column; gap: 0.3rem; }
  .row { display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: flex-end; }
  label { display: flex; flex-direction: column; gap: 0.15rem; font-size: 0.66rem; }
  label.check { flex-direction: row; align-items: center; gap: 0.25rem; }
  input, select { background: hsl(var(--surface)); color: hsl(var(--foreground)); border: 0; border-radius: calc(var(--radius) - 0.35rem); padding: 0.25rem 0.35rem; font-family: var(--font-mono); font-size: 0.72rem; width: 5.5rem; box-sizing: border-box; }
  input.name { width: 100%; font-family: inherit; font-weight: 600; }
  input[type='checkbox'] { width: auto; }
  .mini { background: hsl(var(--surface-strong)); color: hsl(var(--foreground)); border: 0; border-radius: calc(var(--radius) - 0.3rem); padding: 0.25rem 0.5rem; font-size: 0.7rem; cursor: pointer; }
  .mini:disabled { opacity: 0.5; cursor: default; }
</style>
