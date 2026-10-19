<script lang="ts">
  import { normalizeRules, normalizeSettings, type ExtensionSettings } from '../../lib/settings';

  let {
    settings,
    settingsLoaded,
    applySettings,
  }: {
    settings: ExtensionSettings;
    settingsLoaded: boolean;
    applySettings: (next: ExtensionSettings) => void;
  } = $props();

  type Key = 'maxRiskPct' | 'maxLeverage' | 'dailyLossUsd' | 'revengeMinutes';

  const FIELDS: ReadonlyArray<{ key: Key; label: string; step: string; min: number; max: number }> = [
    { key: 'maxRiskPct', label: 'Riesgo máximo por operación (% del capital)', step: '0.1', min: 0.1, max: 5 },
    { key: 'maxLeverage', label: 'Apalancamiento máximo (x)', step: '1', min: 1, max: 125 },
    { key: 'dailyLossUsd', label: 'Pérdida diaria máxima (USD)', step: '1', min: 0.01, max: 1_000_000 },
    { key: 'revengeMinutes', label: 'Espera tras una pérdida (min)', step: '1', min: 1, max: 240 },
  ];

  function commit(key: Key, raw: string, input: HTMLInputElement) {
    const value = Number(raw);
    const next = normalizeSettings({ ...settings, rules: normalizeRules({ ...settings.rules, [key]: value }) });
    // Lo que se muestra es lo que quedó guardado, ya con los límites aplicados.
    input.value = String(next.rules[key]);
    applySettings(next);
  }
</script>

<fieldset class="cred" data-testid="rules-settings">
  <legend>Tus reglas</legend>
  {#each FIELDS as f (f.key)}
    <label class="field">
      <span>{f.label}</span>
      <input
        type="number"
        name={f.key}
        step={f.step}
        min={f.min}
        max={f.max}
        disabled={!settingsLoaded}
        value={settings.rules[f.key]}
        onchange={(event) => commit(f.key, (event.currentTarget as HTMLInputElement).value, event.currentTarget as HTMLInputElement)}
      />
    </label>
  {/each}
</fieldset>
