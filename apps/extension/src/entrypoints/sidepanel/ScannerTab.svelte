<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import type { KeyValueStorage } from '../../lib/scanner/settings';
  import {
    createScannerRunner, initialRunnerState, playBeep, type RunnerState, type ScannerRunner,
  } from '../../lib/scanner/scanner-runner';
  import {
    DEFAULT_FILTERS, filterEvents, hhmm, mutedLabel, sortEvents, type ScannerFilters,
  } from '../../lib/scanner/view';
  import ScannerRow from './ScannerRow.svelte';
  import ScannerSettings from './ScannerSettings.svelte';

  let { active = false }: { active?: boolean } = $props();

  let rs = $state<RunnerState>(initialRunnerState());
  let runner = $state.raw<ScannerRunner | null>(null);
  let filters = $state<ScannerFilters>({ ...DEFAULT_FILTERS });
  let order = $state<'recent' | 'volume'>('recent');

  const overrides = $derived({ mutedCells: rs.settings.mutedCells, unmutedCells: rs.settings.unmutedCells });
  const mainRows = $derived(sortEvents(filterEvents(rs.events, { ...filters, showMuted: false }, overrides), order));
  const mutedRows = $derived(
    filters.showMuted
      ? sortEvents(
          filterEvents(rs.events, { ...filters, showMuted: true }, overrides).filter(
            (e) => !mainRows.some((m) => m.id === e.id),
          ),
          order,
        )
      : [],
  );

  const storage: KeyValueStorage = {
    async get(key) {
      const stored = await browser.storage.local.get(key);
      return stored?.[key];
    },
    async set(key, value) {
      await browser.storage.local.set({ [key]: value });
    },
  };

  onMount(() => {
    const instance = createScannerRunner({
      fetch: (url, init) => fetch(url, init),
      storage,
      setBadge: (text) => {
        void browser.action?.setBadgeText({ text }).catch(() => {});
      },
      beep: playBeep,
      notificationsAllowed: async () => (await browser.permissions?.contains({ permissions: ['notifications'] })) === true,
      notify: ({ title, message }) => {
        void browser.notifications
          ?.create({ type: 'basic', iconUrl: browser.runtime.getURL('/icon/128.png'), title, message })
          .catch(() => {});
      },
    });
    const unsubscribe = instance.subscribe((state) => {
      rs = state;
    });
    runner = instance;
    instance.setVisible(document.visibilityState === 'visible');
    const onVisibility = () => instance.setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);
    void instance.init();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribe();
      instance.destroy();
      void browser.action?.setBadgeText({ text: '' }).catch(() => {});
    };
  });

  $effect(() => {
    runner?.setTabActive(active);
  });

  function setEnabled(event: Event) {
    const checked = (event.currentTarget as HTMLInputElement).checked;
    void runner?.setSettings({ enabled: checked });
  }

  const statusLine = $derived(
    rs.lastCycleAt !== null && rs.running
      ? `${rs.statusText} · último ciclo ${hhmm(rs.lastCycleAt)}`
      : rs.statusText,
  );
</script>

<section class="sc-tab" aria-label="Escáner">
  <header class="sc-head">
    <label class="sc-switch">
      <input
        type="checkbox"
        role="switch"
        data-testid="scanner-switch"
        aria-label="Escáner"
        checked={rs.settings.enabled}
        disabled={!rs.loaded}
        onchange={setEnabled}
      />
      <span class="sc-switch-label">Escáner</span>
    </label>
    <p class="sc-status" role="status" data-testid="scanner-status" data-kind={rs.statusKind}>{statusLine}</p>
  </header>

  {#if !rs.settings.enabled}
    <p class="sc-note" data-testid="scanner-off">
      El escáner está apagado. Cuando lo enciendas usará solo datos públicos de Binance.
    </p>
  {:else if rs.events.length === 0 && rs.startedAt !== null}
    <p class="sc-note" data-testid="scanner-empty">Sin movimientos desde {hhmm(rs.startedAt)}</p>
  {/if}

  <details class="sc-fold" data-testid="scanner-filters">
    <summary>Filtros y orden</summary>
    <div class="sc-settings">
      <label class="sc-field">
        <span>Nivel de volumen</span>
        <select bind:value={filters.tier}>
          <option value="all">Todos</option>
          <option value="hi">Alto</option>
          <option value="mid">Medio</option>
          <option value="lo">Bajo</option>
        </select>
      </label>
      <label class="sc-field">
        <span>Señal</span>
        <select bind:value={filters.signal}>
          <option value="all">Todas</option>
          <option value="move30">30 min</option>
          <option value="move15">15 min</option>
        </select>
      </label>
      <label class="sc-field">
        <span>Orden</span>
        <select bind:value={order}>
          <option value="recent">Recientes</option>
          <option value="volume">Volumen</option>
        </select>
      </label>
      <label class="sc-check"><input type="checkbox" bind:checked={filters.onlyEvidence} /><span>Solo con evidencia</span></label>
      <label class="sc-check"><input type="checkbox" bind:checked={filters.hideMarketWide} /><span>Ocultar movimientos de todo el mercado</span></label>
      <label class="sc-check"><input type="checkbox" bind:checked={filters.showMuted} /><span>Mostrar silenciadas</span></label>
    </div>
  </details>

  {#if mainRows.length > 0}
    <ul class="sc-list" data-testid="scanner-list" aria-label="Movimientos detectados">
      {#each mainRows as event (event.id)}
        <ScannerRow {event} />
      {/each}
    </ul>
  {:else if rs.events.length > 0}
    <p class="sc-note">Ningún evento con estos filtros.</p>
  {/if}

  {#if mutedRows.length > 0}
    <details class="sc-fold" data-testid="scanner-muted">
      <summary>{mutedLabel(mutedRows.length)}</summary>
      <ul class="sc-list">
        {#each mutedRows as event (event.id)}
          <ScannerRow {event} />
        {/each}
      </ul>
    </details>
  {/if}

  <ScannerSettings settings={rs.settings} onChange={(patch) => void runner?.setSettings(patch)} />

  <p class="sc-note sc-honesty">
    Eventos de movimiento con la medición de su celda; no son señales ni una promesa de acierto.
  </p>
</section>
