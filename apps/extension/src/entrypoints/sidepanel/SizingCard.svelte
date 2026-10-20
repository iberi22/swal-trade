<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import {
    calculatePositionSize,
    calculatePositionSizeWithFees,
    defaultScaleEntries,
    formatLossUsd,
    formatQuantity,
    planScaleIn,
    DEFAULT_SIZING_PREFERENCES,
    invalidationPriceForSide,
    normalizeSizingPreferences,
    SIZING_STORAGE_KEY,
    TAKER_FEE_RATE,
    type SizingDirection,
  } from '../../lib/sizing';
  import {
    CAPITAL_SOURCE_STORAGE_KEY,
    normalizeCapitalSource,
    pageCapitalAvailable,
    resolveCapital,
    resolveCapitalOnLoad,
    type CapitalSource,
  } from '../../lib/sizing-capital';
  import { formatBalanceAmount } from '../../lib/page-account/page-balance';
  import type { PageBalance } from '../../lib/page-account/parse-balance';
  import type { Finding } from '../../lib/types';
  import {
    exactSizingFromLoad,
    parseSizingLoad,
    sizingStateFromLoad,
    subscribeSizingLoad,
    TRANCHES_NOTE,
    type SizingLoad,
  } from '../../lib/trade-cards/sizing-bridge';

  let {
    lastPrice = null,
    finding = null,
    compact = false,
    symbol = '',
    pageBalance = null,
    pageBalanceCapturedAt = null,
    nowMs = 0,
    readPageAccount = false,
  }: {
    lastPrice?: number | null;
    finding?: Finding | null;
    compact?: boolean;
    /** Par del panel: decide qué activo del saldo se puede usar. */
    symbol?: string;
    /** Caja de cuenta leída de la página (opt-in `readPageAccount`). */
    pageBalance?: PageBalance | null;
    pageBalanceCapturedAt?: number | null;
    /** Reloj del panel para «hace X s» y la marca de dato viejo. */
    nowMs?: number;
    readPageAccount?: boolean;
  } = $props();

  let capital = $state(DEFAULT_SIZING_PREFERENCES.capital);
  let capitalSource = $state<CapitalSource>('manual');
  let riskPct = $state(DEFAULT_SIZING_PREFERENCES.riskPct);
  let direction = $state<SizingDirection>(DEFAULT_SIZING_PREFERENCES.direction);
  let loaded = $state(false);
  let entryStr = $state('');
  let stopStr = $state('');
  let userEditedEntry = $state(false);
  let userEditedStop = $state(false);
  let prevFindingId = $state<string | null>(null);
  // Carga desde una tarjeta: usa el riesgo efectivo del ticket y sus tarifas
  // para reproducir el mismo tamaño (si no, el riesgo guardado daría otro).
  let fromCard = $state(false);
  let cardNote = $state('');
  let cardTranchesNote = $state('');
  let cardEntryFeeRate = $state(TAKER_FEE_RATE);
  let cardExitFeeRate = $state(TAKER_FEE_RATE);
  /** Payload validado de la tarjeta o del dibujo (contrato `SizingLoad`). */
  let cardLoad = $state<SizingLoad | null>(null);
  /** Aviso al pasar a capital manual porque el ticket trae el suyo. */
  let loadCapitalNote = $state<string | null>(null);

  onMount(() => {
    void browser.storage.local?.get(SIZING_STORAGE_KEY).then((stored) => {
      const prefs = normalizeSizingPreferences(stored?.[SIZING_STORAGE_KEY] ?? stored);
      capital = prefs.capital;
      riskPct = prefs.riskPct;
      direction = prefs.direction;
      loaded = true;
    }).catch(() => { loaded = true; });

    void browser.storage.local?.get(CAPITAL_SOURCE_STORAGE_KEY).then((stored) => {
      capitalSource = normalizeCapitalSource(stored?.[CAPITAL_SOURCE_STORAGE_KEY]);
    }).catch(() => {});

    // Tarjetas de operación y dibujos: «Cargar en el dimensionador».
    return subscribeSizingLoad((incoming) => {
      // Misma validación que usan los tests de contrato: un payload sin tarifas
      // o sin riesgo no se pinta (antes salía «La comisión no es válida»).
      const load = parseSizingLoad(incoming);
      if (!load) return;
      // El capital del panel pasa a ser el del ticket: si no, una tarjeta de
      // 2.000 con el panel en 1.000 daba otra cantidad (1,49977 en vez de 3).
      const state = sizingStateFromLoad(load);
      direction = state.direction;
      // El campo enseña el % con 4 decimales; la cantidad y la pérdida que se
      // ven abajo salen del payload EXACTO (ver `exactSizingFromLoad`). En
      // cuanto se toca el riesgo, la cifra exacta deja de valer y el panel
      // recalcula con lo escrito.
      riskPct = state.riskPct;
      entryStr = state.entryStr;
      stopStr = state.stopStr;
      // El ticket trae su propio capital: se pasa a «manual» CON ese capital
      // para que `exactSizingFromLoad` siga valiendo. Con «saldo de la página»
      // el capital efectivo era el de la página (p. ej. 1.000) y la carga de
      // 100 enseñaba otra cantidad y otra pérdida (1 y 10,09 en vez de 0,1 y
      // 1,0095). La nota dice cómo volver al saldo de la página.
      const capitalOnCard = resolveCapitalOnLoad(capitalSource, load);
      capitalSource = capitalOnCard.source;
      capital = capitalOnCard.capital;
      loadCapitalNote = capitalOnCard.note;
      if (capitalOnCard.note) {
        void browser.storage.local
          ?.set({ [CAPITAL_SOURCE_STORAGE_KEY]: capitalOnCard.source })
          .catch(() => {});
      }
      userEditedEntry = true;
      userEditedStop = true;
      fromCard = true;
      cardLoad = load;
      cardNote = load.note;
      cardEntryFeeRate = load.entryFeeRate;
      cardExitFeeRate = load.exitFeeRate;
      const tranchePrices = load.tranches ?? [];
      if (tranchePrices.length === 3) {
        e2Str = String(tranchePrices[1]);
        e3Str = String(tranchePrices[2]);
        userEditedScale = true;
        cardTranchesNote = '';
      } else {
        userEditedScale = false;
        cardTranchesNote = tranchePrices.length > 1 ? TRANCHES_NOTE : '';
      }
      savePreferences();
    });
  });

  function savePreferences() {
    if (!loaded) return;
    void browser.storage.local?.set({ [SIZING_STORAGE_KEY]: { capital, riskPct, direction } }).catch(() => {});
  }

  function chooseCapitalSource(next: CapitalSource) {
    if (next === 'page' && !pageOfferAvailable) return;
    capitalSource = next;
    // Elegir a mano cierra el aviso de la carga: ya manda lo que pidió el usuario.
    loadCapitalNote = null;
    void browser.storage.local?.set({ [CAPITAL_SOURCE_STORAGE_KEY]: next }).catch(() => {});
  }

  // «Saldo de la página» solo se ofrece con la lectura encendida y un saldo del
  // activo del par. Un exchange sin lectores o un saldo en otro activo no puede
  // colarse como capital.
  const pageOfferAvailable = $derived(
    pageCapitalAvailable({ readPageAccount, balance: pageBalance, symbol }),
  );
  const resolvedCapital = $derived(
    resolveCapital({
      source: capitalSource,
      manualCapital: capital,
      symbol,
      balance: pageBalance,
      capturedAtMs: pageBalanceCapturedAt,
      nowMs,
      readPageAccount,
    }),
  );
  const effectiveCapital = $derived(resolvedCapital.capital);

  // La fuente elegida NO se cambia sola: si el saldo de la página deja de servir
  // (otro par, otra moneda) se sigue mostrando «saldo de la página» con el
  // respaldo manual y su nota. Cambiarla aquí borraba el aviso y ocultaba por
  // qué las tarjetas usaban otro capital.

  $effect(() => {
    if (!userEditedEntry && lastPrice !== null && Number.isFinite(lastPrice)) entryStr = String(lastPrice);
  });

  /**
   * Stop desde el hallazgo: SOLO niveles de invalidación del lado correcto
   * (largo por debajo de la entrada, corto por encima). Si no hay ninguno, se
   * deja lo que haya escrito el usuario: nunca se rellena un stop del lado
   * equivocado (un largo a 81.513,1 se quedó con un stop de 87.370).
   */
  $effect(() => {
    const findingId = finding?.id ?? null;
    const entry = numEntry;
    const changed = findingId !== prevFindingId;
    if (changed) prevFindingId = findingId;
    // Lo escrito a mano manda siempre.
    if (userEditedStop) return;
    const candidate = invalidationPriceForSide(finding, direction, entry);
    if (candidate === null) return;
    if (changed || stopStr === '') {
      stopStr = String(candidate);
      return;
    }
    // Un stop automático que quedó del lado equivocado (p. ej. tras cambiar de
    // dirección) se corrige; un valor editable del usuario no se toca.
    const stop = numStop;
    if (!Number.isFinite(stop) || !Number.isFinite(entry)) return;
    const wrongSide = direction === 'long' ? stop >= entry : stop <= entry;
    if (wrongSide) stopStr = String(candidate);
  });

  const numEntry = $derived(parseFloat(entryStr));
  const numStop = $derived(parseFloat(stopStr));
  const hasInputs = $derived(Number.isFinite(numEntry) && numEntry > 0 && Number.isFinite(numStop) && numStop > 0);
  const result = $derived(
    hasInputs
      ? fromCard
        ? calculatePositionSizeWithFees({
            capital: effectiveCapital,
            riskPct,
            direction,
            entry: numEntry,
            stop: numStop,
            entryFeeRate: cardEntryFeeRate,
            exitFeeRate: cardExitFeeRate,
          })
        : calculatePositionSize({ capital: effectiveCapital, riskPct, direction, entry: numEntry, stop: numStop })
      : null,
  );
  /**
   * Cifras exactas del ticket mientras los campos sigan igual que al cargarlo.
   * Recalcular desde el % redondeado cambiaba 3 -> 3,0014; el payload trae la
   * cantidad y la pérdida reales. Cambiar capital, riesgo, entrada o stop anula
   * la carga exacta: las cifras pasan a salir de lo escrito.
   */
  const exact = $derived(
    fromCard && cardLoad
      ? exactSizingFromLoad(cardLoad, { entryStr, stopStr, direction, capital: effectiveCapital, riskPct })
      : null,
  );
  const shownQuantity = $derived(exact ? exact.quantity : result?.valid ? result.quantity : null);
  const shownLossUsd = $derived(exact ? exact.lossUsd : result?.valid ? result.lossUsd : null);

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
      ? planScaleIn({ capital: effectiveCapital, riskPct, direction, entry1: numEntry, entry2: parseFloat(e2Str), entry3: parseFloat(e3Str), stop: numStop })
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
    <div class="field field-wide">
      <span class="label-text">Capital</span>
      <div class="src-group" role="group" aria-label="Origen del capital">
        <button
          type="button"
          class="src-btn"
          class:selected={capitalSource === 'manual'}
          aria-pressed={capitalSource === 'manual'}
          data-testid="capital-source-manual"
          onclick={() => chooseCapitalSource('manual')}
        >manual</button>
        {#if pageOfferAvailable || capitalSource === 'page'}
          <!-- Se sigue enseñando si el usuario la eligió: al cambiar de par el
               saldo deja de servir, pero la fuente NO se cambia sola y el
               botón tiene que seguir marcado junto a la nota de respaldo. -->
          <button
            type="button"
            class="src-btn"
            class:selected={capitalSource === 'page'}
            aria-pressed={capitalSource === 'page'}
            data-testid="capital-source-page"
            onclick={() => chooseCapitalSource('page')}
          >saldo de la página</button>
        {/if}
      </div>
    </div>
    <label class="field">
      <span class="label-text">Capital manual (USDT)</span>
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
      <span class="label-text">Stop loss {#if finding && invalidationPriceForSide(finding, direction, numEntry) !== null}<span class="tag">invalida hallazgo</span>{/if}</span>
      <input type="number" step="any" placeholder="Stop loss" aria-label="Stop loss" value={stopStr} oninput={(e) => {
        userEditedStop = true;
        stopStr = (e.currentTarget as HTMLInputElement).value;
      }} />
    </label>
  </div>

  {#if resolvedCapital.source === 'page' && resolvedCapital.pageLine}
    <p class="page-capital" class:stale={resolvedCapital.stale} data-testid="capital-page-line">
      {resolvedCapital.pageLine} · capital {formatBalanceAmount(resolvedCapital.capital, resolvedCapital.asset)}
    </p>
  {:else if resolvedCapital.fallbackNote}
    <p class="page-capital note" data-testid="capital-fallback-note">
      {resolvedCapital.fallbackNote} ({formatBalanceAmount(resolvedCapital.capital, resolvedCapital.asset)})
    </p>
  {/if}

  {#if loadCapitalNote}
    <p class="page-capital note" data-testid="capital-load-note">{loadCapitalNote}</p>
  {/if}

  {#if exact && (cardNote || cardTranchesNote)}
    <p class="from-card" data-testid="sizing-from-card">
      {cardNote}{#if cardTranchesNote} · {cardTranchesNote}{/if}
    </p>
  {/if}

  {#if riskPct > 2}
    <p class="warning" data-testid="sizing-risk-warning">Aviso: arriesgar más del 2 % por operación desaconsejado para principiantes; aumenta drásticamente el riesgo de quiebra.</p>
  {/if}

  {#if result}
    {#if result.valid}
      <div class="metrics-grid" data-testid="sizing-results">
        <div class="metric"><span class="m-title">Distancia stop</span><span class="m-val">{pctFmt.format(result.distancePct)} %</span></div>
        <div class="metric"><span class="m-title">Pérdida en stop</span><span class="m-val">{formatLossUsd(shownLossUsd ?? result.lossUsd)} USD</span></div>
        <div class="metric"><span class="m-title">Cantidad</span><span class="m-val">{formatQuantity(shownQuantity ?? result.quantity)}</span></div>
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
                <li>Tramo {i + 1} ({Math.round(scalePlan.weights[i] * 100)} %): {priceFmt.format(t.price)} · {formatQuantity(t.qty)}</li>
              {/each}
            </ul>
            <p class="sz-line" data-testid="scale-in-avg">Media si se llenan todos: {priceFmt.format(scalePlan.avgByFill[scalePlan.avgByFill.length - 1])}</p>
            <p class="sz-line">Punto de equilibrio con comisión: {priceFmt.format(scalePlan.breakEvenByFill[scalePlan.breakEvenByFill.length - 1])}</p>
            <p class="sz-line" data-testid="scale-in-loss-all">Si se llenan todos y salta el stop: -{formatLossUsd(scalePlan.lossIfAllFillAndStop)} USD</p>
            <p class="sz-line" data-testid="scale-in-loss-first">Si solo se llena el primero: -{formatLossUsd(scalePlan.lossIfOnlyFirstFillsAndStop)} USD</p>
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
  .src-group { display: flex; gap: 0.25rem; }
  .src-btn { flex: 1; background: hsl(var(--background)); color: hsl(var(--muted-foreground)); border: 0; border-radius: calc(var(--radius) - 0.2rem); padding: 0.3rem 0.45rem; font-size: 0.72rem; font-weight: 600; cursor: pointer; }
  .src-btn.selected { background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); }
  .page-capital { margin: 0; font-size: 0.7rem; line-height: 1.35; color: hsl(var(--muted-foreground)); }
  .page-capital.stale { color: hsl(var(--foreground)); }
  .page-capital.note { color: hsl(var(--subtle-foreground)); }
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
  .from-card { margin: 0; font-size: 0.7rem; color: hsl(var(--subtle-foreground)); line-height: 1.35; }
</style>
