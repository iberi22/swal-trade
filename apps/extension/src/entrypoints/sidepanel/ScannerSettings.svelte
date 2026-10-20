<script lang="ts">
  import { browser } from 'wxt/browser';
  import { onMount } from 'svelte';
  import { HEALTH_KEY, parseHealth, type ScannerHealth } from '../../lib/scanner/background-runner';
  import { hhmm } from '../../lib/scanner/view';
  import { MAX_PER_HOUR_RANGE, MIN_Q24_RANGE, type ScannerSettings } from '../../lib/scanner/settings';

  let {
    settings,
    onChange,
  }: {
    settings: ScannerSettings;
    onChange: (patch: Partial<ScannerSettings>) => void;
  } = $props();

  let note = $state<string | null>(null);
  let health = $state<ScannerHealth | null>(null);
  const alarmsOk = typeof (browser as unknown as { alarms?: unknown }).alarms !== 'undefined';

  onMount(() => {
    void (async () => {
      try {
        health = parseHealth((await browser.storage.local.get(HEALTH_KEY))[HEALTH_KEY]);
      } catch {
        health = null;
      }
    })();
  });
  const universes = ['USDT', 'USDC'] as const;
  const tiers = [
    { id: 'hi', label: 'Volumen alto (≥ 100 M)' },
    { id: 'mid', label: 'Volumen medio (≥ 20 M)' },
    { id: 'lo', label: 'Volumen bajo' },
  ] as const;

  async function setNotifications(input: HTMLInputElement) {
    note = null;
    if (!input.checked) {
      onChange({ notifications: false });
      return;
    }
    let granted = false;
    try {
      granted = (await browser.permissions?.request({ permissions: ['notifications'] })) === true;
    } catch {
      granted = false;
    }
    if (!granted) {
      input.checked = false;
      note = 'Sin el permiso de avisos del navegador no se pueden mostrar.';
      onChange({ notifications: false });
      return;
    }
    onChange({ notifications: true });
  }

  function numberFrom(event: Event): number {
    return Number((event.currentTarget as HTMLInputElement).value);
  }
</script>

<details class="sc-fold" data-testid="scanner-settings">
  <summary>Ajustes del escáner</summary>
  <div class="sc-settings">
    <label class="sc-field">
      <span>Universo</span>
      <!-- `selected` en cada opción: el valor llega de forma asíncrona
           (storage) y el <select> no debe quedarse pintando USDT mientras
           el estado ya dice USDC. -->
      <select
        data-testid="scanner-universe"
        onchange={(e) => onChange({ universe: (e.currentTarget as HTMLSelectElement).value === 'USDC' ? 'USDC' : 'USDT' })}
      >
        {#each universes as quote (quote)}
          <option value={quote} selected={settings.universe === quote}>{quote}</option>
        {/each}
      </select>
    </label>

    <label class="sc-field">
      <span>Volumen mínimo 24 h (millones)</span>
      <input
        type="number"
        min={MIN_Q24_RANGE.min / 1e6}
        max={MIN_Q24_RANGE.max / 1e6}
        step="1"
        value={Math.round(settings.minQ24 / 1e6)}
        onchange={(e) => onChange({ minQ24: numberFrom(e) * 1e6 })}
      />
    </label>

    {#each tiers as tier (tier.id)}
      <label class="sc-field">
        <span>Umbral · {tier.label}</span>
        <select
          value={String(settings.thresholds[tier.id])}
          onchange={(e) => onChange({ thresholds: { ...settings.thresholds, [tier.id]: numberFrom(e) } })}
        >
          <option value="3">3 %</option>
          <option value="5">5 %</option>
          <option value="7">7 %</option>
        </select>
      </label>
    {/each}

    <label class="sc-check">
      <input type="checkbox" checked={settings.sound} onchange={(e) => onChange({ sound: (e.currentTarget as HTMLInputElement).checked })} />
      <span>Sonido corto (solo con el panel abierto)</span>
    </label>
    <label class="sc-check">
      <input type="checkbox" checked={settings.badge} onchange={(e) => onChange({ badge: (e.currentTarget as HTMLInputElement).checked })} />
      <span>Insignia con los eventos no vistos</span>
    </label>
    <label class="sc-check">
      <input type="checkbox" data-testid="scanner-notifications" checked={settings.notifications} onchange={(e) => void setNotifications(e.currentTarget as HTMLInputElement)} />
      <span>Avisos del navegador</span>
    </label>
    {#if note}
      <p class="sc-note" role="status">{note}</p>
    {/if}

    <label class="sc-check">
      <input
        type="checkbox"
        checked={settings.quietHours.enabled}
        onchange={(e) => onChange({ quietHours: { ...settings.quietHours, enabled: (e.currentTarget as HTMLInputElement).checked } })}
      />
      <span>Horas de silencio (callan avisos y sonido, no la lista)</span>
    </label>
    {#if settings.quietHours.enabled}
      <div class="sc-pair">
        <label class="sc-field">
          <span>Desde</span>
          <input type="time" value={settings.quietHours.from} onchange={(e) => onChange({ quietHours: { ...settings.quietHours, from: (e.currentTarget as HTMLInputElement).value } })} />
        </label>
        <label class="sc-field">
          <span>Hasta</span>
          <input type="time" value={settings.quietHours.to} onchange={(e) => onChange({ quietHours: { ...settings.quietHours, to: (e.currentTarget as HTMLInputElement).value } })} />
        </label>
      </div>
    {/if}

    <label class="sc-field">
      <span>Máximo de avisos por hora</span>
      <input
        type="number"
        min={MAX_PER_HOUR_RANGE.min}
        max={MAX_PER_HOUR_RANGE.max}
        step="1"
        value={settings.maxPerHour}
        onchange={(e) => onChange({ maxPerHour: numberFrom(e) })}
      />
    </label>

    <label class="sc-check" class:sc-disabled={!alarmsOk}>
      <input
        type="checkbox"
        data-testid="scanner-background"
        disabled={!alarmsOk}
        checked={alarmsOk && settings.backgroundMode}
        onchange={(e) => onChange({ backgroundMode: (e.currentTarget as HTMLInputElement).checked })}
      />
      <span>Vigilar con el panel cerrado</span>
    </label>
    {#if alarmsOk && settings.backgroundMode}
      <p class="sc-note" data-testid="scanner-background-note">Revisa cada 5 min con datos públicos de Binance, aunque el panel esté cerrado</p>
      {#if health && health.lastCycleAt}
        <p class="sc-note" data-testid="scanner-background-health">Último ciclo: {hhmm(health.lastCycleAt)} · {health.cycles} ciclos · {health.errors} errores</p>
      {/if}
    {/if}
  </div>
</details>
