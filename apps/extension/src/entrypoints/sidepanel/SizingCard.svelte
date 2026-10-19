<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import {
    calculatePositionSize,
    defaultScaleEntries,
    planScaleIn,
    DEFAULT_SIZING_PREFERENCES,
    invalidationPriceFromFinding,
    normalizeSizingPreferences,
    SIZING_STORAGE_KEY,
    type SizingDirection,
  } from '../../lib/sizing';
  import type { Finding } from '../../lib/types';
  import { subscribeSizingLoad } from '../../lib/trade-cards/sizing-bridge';

  let { lastPrice = null, finding = null, compact = false }: { lastPrice?: number | null; finding?: Finding | null; compact?: boolean } = $props();

  let capital = $state(DEFAULT_SIZING_PREFERENCES.capital);
  let riskPct = $state(DEFAULT_SIZING_PREFERENCES.riskPct);
  let direction = $state<SizingDirection>(DEFAULT_SIZING_PREFERENCES.direction);
  let loaded = $state(false);
  let entryStr = $state('');
  let stopStr = $state('');
  let userEditedEntry = $state(false);
  let userEditedStop = $state(false);
  let prevFindingId = $state<string | null>(null);

  onMount(() => {
    void browser.storage.local?.get(SIZING_STORAGE_KEY).then((stored) => {
      const prefs = normalizeSizingPreferences(stored?.[SIZING_STORAGE_KEY] ?? stored);
      capital = prefs.capital;
      riskPct = prefs.riskPct;
      direction = prefs.direction;
      loaded = true;
    }).catch(() => { loaded = true; });

    // Tarjetas de operación: «Cargar en el dimensionador».
    return subscribeSizingLoad((load) => {
      direction = load.direction;
      if (load.riskPct !== undefined) riskPct = load.riskPct;
      entryStr = String(load.entry);
      stopStr = String(load.stop);
      userEditedEntry = true;
      userEditedStop = true;
      userEditedScale = false;
      savePreferences();
    });
  });

  function savePreferences() {
    if (!loaded) return;
    void browser.storage.local?.set({ [SIZING_STORAGE_KEY]: { capital, riskPct, direction } }).catch(() => {});
  }

  $effect(() => {
    if (!userEditedEntry && lastPrice !== null && Number.isFinite(lastPrice)) entryStr = String(lastPrice);
  });

  $effect(() => {
    const findingId = finding?.id ?? null;
    const inv = invalidationPriceFromFinding(finding);
    if (findingId !== prevFindingId) {
      prevFindingId = findingId;
      if (inv !== null) { stopStr = String(inv); userEditedStop = false; }
    } else if (!userEditedStop && inv !== null && stopStr === '') {
      stopStr = String(inv);
    }
  });

  const numEntry = $derived(parseFloat(entryStr));
  const numStop = $derived(parseFloat(stopStr));
  const hasInputs = $derived(Number.isFinite(numEntry) && numEntry > 0 && Number.isFinite(numStop) && numStop > 0);
  const result = $derived(hasInputs ? calculatePositionSize({ capital, riskPct, direction, entry: numEntry, stop: numStop }) : null);

  let e2Str = $state('');
  let e3Str = $state('');
  let userEditedScale = $state(false);

  $effect(() => {
    if (userEditedScale) return;
    const d = hasInputs ? defaultScaleEntries({ direction, entry: numEntry, stop: numStop }) : null;
    e2Str = d ? String(d.entry2) : '';
    e3Str = d ? String(d.entry3) : '';
  });

  const scalePlan = $derived(
    hasInputs && parseFloat(e2Str) > 0 && parseFloat(e3Str) > 0
      ? planScaleIn({ capital, riskPct, direction, entry1: numEntry, entry2: parseFloat(e2Str), entry3: parseFloat(e3Str), stop: numStop })
      : null,
  );

  const priceFmt = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 4 });
  const usdFmt = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pctFmt = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
</script>

<section class="sizing" data-testid="sizing-card" aria-label="Tamaño de la posición">
  <div class="card-head">
    <h2>Tamaño de la posición</h2>
    {#if !compact}<span class="head-hint">gestiona el riesgo por el stop</span>{/if}
  </div>

  <div class="fields-grid">
    <label class="field">
      <span class="label-text">Capital (USDT)</span>
      <input type="number" min="1" step="any" aria-label="Capital de la cuenta" value={capital} oninput={(e) => {
        const v = parseFloat((e.currentTarget as HTMLInputElement).value);
        if (Number.isFinite(v) && v > 0) { capital = v; savePreferences(); }
      }} />
    </label>
    <label class="field">
      <span class="label-text">Riesgo (%)</span>
      <input type="number" min="0.1" max="5" step="0.1" aria-label="Riesgo por operación" value={riskPct} oninput={(e) => {
        const v = parseFloat((e.currentTarget as HTMLInputElement).value);
        if (Number.isFinite(v)) { riskPct = v; savePreferences(); }
      }} />
    </label>
    <div class="field">
      <span class="label-text">Dirección</span>
      <div class="dir-group" role="group" aria-label="Dirección de la operación">
        <button type="button" class="dir-btn" class:selected={direction === 'long'} onclick={() => { direction = 'long'; savePreferences(); }}>Largo</button>
        <button type="button" class="dir-btn" class:selected={direction === 'short'} onclick={() => { direction = 'short'; savePreferences(); }}>Corto</button>
      </div>
    </div>
    <label class="field">
      <span class="label-text">Entrada</span>
      <input type="number" step="any" placeholder="Precio de entrada" aria-label="Precio de entrada" value={entryStr} oninput={(e) => {
        userEditedEntry = true;
        entryStr = (e.currentTarget as HTMLInputElement).value;
      }} />
    </label>
    <label class="field field-wide">
      <span class="label-text">Stop loss {#if finding && invalidationPriceFromFinding(finding) !== null}<span class="tag">invalida hallazgo</span>{/if}</span>
      <input type="number" step="any" placeholder="Stop loss" aria-label="Stop loss" value={stopStr} oninput={(e) => {
        userEditedStop = true;
        stopStr = (e.currentTarget as HTMLInputElement).value;
      }} />
    </label>
  </div>

  {#if riskPct > 2}
    <p class="warning" data-testid="sizing-risk-warning">Aviso: arriesgar más del 2 % por operación desaconsejado para principiantes; aumenta drásticamente el riesgo de quiebra.</p>
  {/if}

  {#if result}
    {#if result.valid}
      <div class="metrics-grid" data-testid="sizing-results">
        <div class="metric"><span class="m-title">Distancia stop</span><span class="m-val">{pctFmt.format(result.distancePct)} %</span></div>
        <div class="metric"><span class="m-title">Pérdida en stop</span><span class="m-val">{usdFmt.format(result.lossUsd)} USD</span></div>
        <div class="metric"><span class="m-title">Cantidad</span><span class="m-val">{priceFmt.format(result.quantity)}</span></div>
        <div class="metric"><span class="m-title">Nocional</span><span class="m-val">{usdFmt.format(result.notionalUsd)} USD</span></div>
        <div class="metric"><span class="m-title">Apalancamiento mín.</span><span class="m-val">{result.minLeverage}×</span></div>
      </div>
      <p class="summary-line" data-testid="sizing-summary">{result.summary}</p>
      <p class="fee-line">comisiones aprox. ~{usdFmt.format(result.feeUsd)} USD (taker 0,05 % al entrar y al salir)</p>
      {#if !compact}<p class="leverage-note">Más apalancamiento no cambia la pérdida si salta el stop; solo acerca la liquidación.</p>{/if}
      <details class="fold" data-testid="scale-in">
        <summary>Escalonar en 3 tramos</summary>
        <div class="sz-body">
          <div class="sz-inputs">
            <label class="field">
              <span class="label-text">Entrada 2</span>
              <input type="number" step="any" aria-label="Entrada del tramo 2" value={e2Str} oninput={(e) => { userEditedScale = true; e2Str = (e.currentTarget as HTMLInputElement).value; }} />
            </label>
            <label class="field">
              <span class="label-text">Entrada 3</span>
              <input type="number" step="any" aria-label="Entrada del tramo 3" value={e3Str} oninput={(e) => { userEditedScale = true; e3Str = (e.currentTarget as HTMLInputElement).value; }} />
            </label>
          </div>
          {#if scalePlan && scalePlan.valid}
            <ul class="sz-lines" data-testid="scale-in-tranches">
              {#each scalePlan.tranches as t, i}
                <li>Tramo {i + 1} ({Math.round(scalePlan.weights[i] * 100)} %): {priceFmt.format(t.price)} · {priceFmt.format(t.qty)}</li>
              {/each}
            </ul>
            <p class="sz-line" data-testid="scale-in-avg">Media si se llenan todos: {priceFmt.format(scalePlan.avgByFill[scalePlan.avgByFill.length - 1])}</p>
            <p class="sz-line">Punto de equilibrio con comisión: {priceFmt.format(scalePlan.breakEvenByFill[scalePlan.breakEvenByFill.length - 1])}</p>
            <p class="sz-line" data-testid="scale-in-loss-all">Si se llenan todos y salta el stop: -{usdFmt.format(scalePlan.lossIfAllFillAndStop)} USD</p>
            <p class="sz-line" data-testid="scale-in-loss-first">Si solo se llena el primero: -{usdFmt.format(scalePlan.lossIfOnlyFirstFillsAndStop)} USD</p>
            {#each scalePlan.notes as n}<p class="sz-line">{n}</p>{/each}
            <p class="sz-note" data-testid="scale-in-honest">{scalePlan.honestNote}</p>
          {:else if scalePlan}
            <p class="error-line" data-testid="scale-in-error">{scalePlan.error}</p>
          {/if}
        </div>
      </details>
    {:else}
      <p class="error-line" data-testid="sizing-error">{result.error}</p>
    {/if}
  {:else}
    <p class="hint-line">Introduce el precio de entrada y el stop loss para calcular el tamaño.</p>
  {/if}
</section>

<style>
  .sizing { flex: 0 0 auto; display: flex; flex-direction: column; gap: 0.5rem; background: hsl(var(--surface)); border-radius: var(--radius); padding: 0.65rem 0.7rem; }
  .card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
  .card-head h2 { margin: 0; font-size: 0.78rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: hsl(var(--muted-foreground)); }
  .head-hint { font-size: 0.7rem; color: hsl(var(--subtle-foreground)); }
  .fields-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.45rem; }
  .field { display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; }
  .field-wide { grid-column: span 2; }
  .label-text { font-size: 0.72rem; color: hsl(var(--muted-foreground)); }
  .tag { font-size: 0.64rem; color: hsl(var(--subtle-foreground)); text-transform: uppercase; letter-spacing: 0.03em; }
  .field input { background: hsl(var(--background)); border: 0; border-radius: calc(var(--radius) - 0.2rem); padding: 0.35rem 0.5rem; font-family: var(--font-mono); color: hsl(var(--foreground)); font-size: 0.8rem; width: 100%; min-width: 0; box-sizing: border-box; }
  .dir-group { display: flex; gap: 0.25rem; height: 100%; }
  .dir-btn { flex: 1; background: hsl(var(--background)); color: hsl(var(--muted-foreground)); border: 0; border-radius: calc(var(--radius) - 0.2rem); padding: 0.35rem 0.45rem; font-size: 0.75rem; font-weight: 600; cursor: pointer; }
  .dir-btn.selected { background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); }
  .warning { margin: 0; font-size: 0.72rem; line-height: 1.35; color: hsl(var(--foreground)); background: hsl(var(--surface-strong)); padding: 0.35rem 0.5rem; border-radius: calc(var(--radius) - 0.3rem); }
  .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(6rem, 1fr)); gap: 0.35rem; }
  .metric { background: hsl(var(--background)); border-radius: calc(var(--radius) - 0.3rem); padding: 0.35rem 0.45rem; display: flex; flex-direction: column; gap: 0.1rem; }
  .m-title { font-size: 0.65rem; color: hsl(var(--muted-foreground)); text-transform: uppercase; letter-spacing: 0.03em; }
  .m-val { font-size: 0.82rem; font-weight: 600; font-family: var(--font-mono); color: hsl(var(--foreground)); font-variant-numeric: tabular-nums; }
  .summary-line { margin: 0; font-size: 0.76rem; font-weight: 600; color: hsl(var(--foreground)); line-height: 1.35; }
  .fee-line { margin: 0; font-size: 0.7rem; color: hsl(var(--muted-foreground)); line-height: 1.35; }
  .leverage-note { margin: 0; font-size: 0.7rem; line-height: 1.35; color: hsl(var(--subtle-foreground)); }
  .error-line { margin: 0; font-size: 0.74rem; line-height: 1.35; color: hsl(var(--foreground)); background: hsl(var(--surface-strong)); padding: 0.4rem 0.5rem; border-radius: calc(var(--radius) - 0.3rem); }
  .hint-line { margin: 0; font-size: 0.72rem; color: hsl(var(--subtle-foreground)); }
</style>
