<script lang="ts">
  import { requestSwitchTab } from '../../lib/tv-paint-send';
  import { tvStateHint, type TvChartState } from '../../lib/tv-paint';
  import {
    normalizeSymbolList,
    HOTKEY_SLOTS,
    HOTKEY_SLOT_LABELS,
    DEFAULT_HOTKEY_MAP,
    isTimeframeSlot,
    type ExtensionSettings,
  } from '../../lib/settings';
  import { editCombo } from '../../lib/hotkeys';
  import { NEWS_REFRESH_MS } from '../../lib/news';
  import { TIMEFRAMES, type Timeframe } from '../../lib/types';
  import { LOCALES, isLocaleCode } from '../../lib/i18n/locales';
  import { t } from '../../lib/i18n/i18n.svelte';
  import CredentialsAi from './CredentialsAi.svelte';
  import CredentialsBinance from './CredentialsBinance.svelte';
  import PromptSettings from './PromptSettings.svelte';
  import RulesSettings from './RulesSettings.svelte';

  let {
    settings,
    settingsLoaded,
    symbolDraft = $bindable(),
    symbol,
    timeframe,
    tvState,
    tvChart,
    claudeStatus,
    applySettings,
    checkClaudeStatus,
  }: {
    settings: ExtensionSettings;
    settingsLoaded: boolean;
    symbolDraft: string;
    symbol: string;
    timeframe: Timeframe;
    tvState: TvChartState | null;
    tvChart: { symbol: string; tf: string } | null;
    claudeStatus: 'connected' | 'connecting' | 'disconnected';
    applySettings: (next: ExtensionSettings) => void;
    checkClaudeStatus: () => void;
  } = $props();

  /** Aviso del editor de atajos: solo texto, nunca un atajo guardado a medias. */
  let hotkeyNote = $state<string | null>(null);

  function setCombo(input: HTMLInputElement, slot: (typeof HOTKEY_SLOTS)[number]) {
    hotkeyNote = null;
    const edit = editCombo(input.value, settings.hotkeyMap, slot);
    if (edit.problem) {
      // El campo vuelve al atajo que sigue guardado: nada de estados a medias.
      input.value = settings.hotkeyMap[slot].combo;
      const typed = input.value.trim();
      hotkeyNote =
        edit.problem === 'reserved'
          ? `${input.value || 'Esa combinación'} no se puede usar: ${input.value} es un atajo del navegador.`
          : edit.problem === 'duplicate'
            ? 'Esa combinación ya la usa otro atajo.'
            : `Atajo no válido: "${typed || input.value}" no es una combinación. Usa Alt, Ctrl o Meta con una tecla (por ejemplo Alt+Shift+7).`;
      return;
    }
    // Se guarda SIEMPRE la forma canónica: `shift+alt+a` se escribe como
    // `Alt+Shift+A`, que es lo que compara el escucha del teclado.
    input.value = edit.combo;
    applySettings({ ...settings, hotkeyMap: { ...settings.hotkeyMap, [slot]: { ...settings.hotkeyMap[slot], combo: edit.combo } } });
  }

  function setSlotTimeframe(slot: (typeof HOTKEY_SLOTS)[number], raw: string) {
    const timeframe = raw === '' ? null : (raw as ExtensionSettings['defaultTimeframe']);
    applySettings({ ...settings, hotkeyMap: { ...settings.hotkeyMap, [slot]: { ...settings.hotkeyMap[slot], timeframe } } });
  }

  function resetHotkeys() {
    hotkeyNote = null;
    applySettings({ ...settings, hotkeyMap: { ...DEFAULT_HOTKEY_MAP } });
  }
</script>

<!-- Los interruptores de la página viven aquí pero fuera de .settings: son
     acciones sobre la página, no una preferencia más. -->
<div class="paint-block">
  <label class="field check paint-toggle">
    <input
      type="checkbox"
      disabled={!settingsLoaded}
      checked={settings.paintOnChart}
      onchange={(event) => {
        applySettings({
          ...settings,
          paintOnChart: (event.currentTarget as HTMLInputElement).checked,
        });
      }}
    />
    <span>Pintar en el gráfico de Binance (pestaña Trading View)</span>
  </label>
  {#if settings.paintOnChart}
    {#if tvState === 'mismatch' && tvChart}
      <p class="hint" data-testid="paint-hint">
        El gráfico muestra {tvChart.symbol} · {tvChart.tf}; el análisis es {symbol} · {timeframe}.
      </p>
    {:else}
      <p class="hint" data-testid="paint-hint">
        {tvStateHint(tvState) ??
          `Pintando ${symbol} · ${timeframe} sobre el gráfico de Binance. Se borran al apagar el interruptor.`}
      </p>
      {#if tvState === "original" || tvState === "ready" || tvState === "tradingview"}
        <button
          type="button"
          class="btn-return-original"
          onclick={() => void requestSwitchTab("original")}
        >Volver a Original</button>
      {/if}
    {/if}
  {/if}

  <!-- Solo lectura del dibujo del usuario: no crea, mueve ni borra nada. -->
  <label class="field check paint-toggle">
    <input
      type="checkbox"
      disabled={!settingsLoaded}
      checked={settings.readDrawings}
      data-testid="settings-read-drawings"
      onchange={(event) => {
        applySettings({
          ...settings,
          readDrawings: (event.currentTarget as HTMLInputElement).checked,
        });
      }}
    />
    <span>Leer mis dibujos de posición (TradingView)</span>
  </label>
  {#if settings.readDrawings}
    <p class="hint" data-testid="read-drawings-hint">
      Cada 1,5 s se miran las herramientas Long/Short Position de la pestaña Trading View y la
      tarjeta «Tu dibujo» de Operación enseña su análisis. No se crea ni se mueve ningún dibujo.
    </p>
  {/if}

  <!-- Solo lectura de la página: ni clics ni escrituras, y nada sale del navegador. -->
  <label class="field check paint-toggle">
    <input
      type="checkbox"
      disabled={!settingsLoaded}
      checked={settings.readPageAccount}
      data-testid="settings-read-page-account"
      onchange={(event) => {
        applySettings({
          ...settings,
          readPageAccount: (event.currentTarget as HTMLInputElement).checked,
        });
      }}
    />
    <span>Leer mis posiciones e historial de la página de Binance (solo en este navegador)</span>
  </label>
  <p class="hint" data-testid="read-page-account-hint">
    Lee el texto que ya ves en la página. No pulsa nada y no sale de tu navegador.
  </p>
</div>


<section class="settings" aria-label="Ajustes">
  <div class="settings-body">
    <label class="field">
      <span>Temporalidad por defecto</span>
      <select
        disabled={!settingsLoaded}
        value={settings.defaultTimeframe}
        onchange={(event) => {
          const value = (event.currentTarget as HTMLSelectElement).value;
          if ((TIMEFRAMES as readonly string[]).includes(value)) {
            applySettings({ ...settings, defaultTimeframe: value as Timeframe });
          }
        }}
      >
        {#each TIMEFRAMES as tf (tf)}
          <option value={tf}>{tf}</option>
        {/each}
      </select>
    </label>
    <label class="field">
      <span>Símbolos permitidos (vacío = todos)</span>
      <input
        type="text"
        disabled={!settingsLoaded}
        value={symbolDraft}
        spellcheck="false"
        autocomplete="off"
        placeholder="BTC, ETH"
        onblur={() => {
          applySettings({ ...settings, symbols: normalizeSymbolList(symbolDraft) });
        }}
        oninput={(event) => {
          symbolDraft = (event.currentTarget as HTMLInputElement).value;
        }}
      />
    </label>
    <label class="field check">
      <input
        type="checkbox"
        disabled={!settingsLoaded}
        checked={settings.autoSync}
        onchange={(event) => {
          applySettings({ ...settings, autoSync: (event.currentTarget as HTMLInputElement).checked });
        }}
      />
      <span>Seguir la página abierta</span>
    </label>
    <label class="field check">
      <input
        type="checkbox"
        data-testid="settings-hotkeys"
        disabled={!settingsLoaded}
        checked={settings.hotkeysEnabled}
        onchange={(e) => applySettings({ ...settings, hotkeysEnabled: (e.currentTarget as HTMLInputElement).checked })}
      />
      <span>Atajos de teclado para temporalidad (Alt+Mayús)</span>
    </label>
    <p class="hint">
      Los atajos de la extensión empiezan por Alt+Mayús para no chocar con los del navegador. Se
      pueden editar; F1 a F12 no se aceptan porque son teclas del navegador y del sistema.
    </p>
    <div class="field" data-testid="hotkey-editor">
      <span>Atajos</span>
      <div class="hotkeys-grid">
        {#each HOTKEY_SLOTS as slot (slot)}
          <div class="hotkey-row">
            <input
              type="text"
              class="hotkey-combo"
              data-testid={`hotkey-combo-${slot}`}
              aria-label={`Atajo ${slot}`}
              disabled={!settingsLoaded || !settings.hotkeysEnabled}
              value={settings.hotkeyMap[slot]?.combo ?? ''}
              placeholder={isTimeframeSlot(slot) ? `Alt+Shift+${slot}` : 'Alt+Shift+…'}
              spellcheck="false"
              autocomplete="off"
              onchange={(e) => setCombo(e.currentTarget as HTMLInputElement, slot)}
            />
            {#if isTimeframeSlot(slot)}
              <select
                aria-label={`Temporalidad del atajo ${slot}`}
                disabled={!settingsLoaded || !settings.hotkeysEnabled}
                value={settings.hotkeyMap[slot]?.timeframe ?? ''}
                onchange={(e) => setSlotTimeframe(slot, (e.currentTarget as HTMLSelectElement).value)}
              >
                <option value="">—</option>
                {#each TIMEFRAMES as tf (tf)}<option value={tf}>{tf}</option>{/each}
              </select>
            {:else}
              <span class="hotkey-action" data-testid={`hotkey-action-${slot}`}>
                {HOTKEY_SLOT_LABELS[slot]}
              </span>
            {/if}
          </div>
        {/each}
      </div>
      <button
        type="button"
        class="btn small"
        data-testid="hotkeys-reset"
        disabled={!settingsLoaded || !settings.hotkeysEnabled}
        onclick={resetHotkeys}
      >Restablecer</button>
      {#if hotkeyNote}
        <p class="hint" role="status" data-testid="hotkey-note">{hotkeyNote}</p>
      {/if}
    </div>
    <div class="claude-bridge-section">
      <label class="field check">
        <input
          type="checkbox"
          disabled={!settingsLoaded}
          checked={settings.claudeBridgeEnabled}
          onchange={(event) => {
            applySettings({
              ...settings,
              claudeBridgeEnabled: (event.currentTarget as HTMLInputElement).checked,
            });
            setTimeout(checkClaudeStatus, 150);
          }}
        />
        <span>Permitir que Claude use el gráfico</span>
      </label>
      <p class="hint">
        Permite que un agente local (Claude Code vía swal-trade MCP) lea y dibuje en el gráfico abierto.
      </p>
      <div class="claude-status-line">
        <span class="status-indicator" class:connected={claudeStatus === "connected"}></span>
        <span>{claudeStatus === "connected" ? "Claude conectado" : "Claude desconectado"}</span>
      </div>
      {#if settings.claudeBridgeEnabled}
        <label class="field">
          <span>Puerto del puente MCP</span>
          <input
            type="number"
            disabled={!settingsLoaded}
            value={settings.claudeBridgePort}
            onchange={(event) => {
              const port = parseInt((event.currentTarget as HTMLInputElement).value, 10);
              if (Number.isFinite(port) && port >= 1024 && port <= 65535) {
                applySettings({ ...settings, claudeBridgePort: port });
              }
            }}
          />
        </label>
        <label class="field">
          <span>Token de emparejamiento</span>
          <input
            type="password"
            disabled={!settingsLoaded}
            value={settings.claudeBridgeToken}
            placeholder="Pegar token de ~/.config/swal-trade/chart-bridge-token"
            oninput={(event) => {
              applySettings({
                ...settings,
                claudeBridgeToken: (event.currentTarget as HTMLInputElement).value.trim(),
              });
              setTimeout(checkClaudeStatus, 150);
            }}
          />
        </label>
      {/if}
    </div>
    <p class="hint">
      Se guarda en <code>storage.local</code> de la extensión. Los titulares se renuevan cada
      {NEWS_REFRESH_MS / 60000} min.
    </p>
  </div>
</section>

<section class="settings" aria-label={t('settings.language.title')} data-testid="language-section">
  <div class="settings-body">
    <label class="field">
      <span>{t('settings.language.title')}</span>
      <select
        disabled={!settingsLoaded}
        value={settings.locale}
        onchange={(event) => {
          const value = (event.currentTarget as HTMLSelectElement).value;
          if (value === 'auto' || isLocaleCode(value)) {
            applySettings({ ...settings, locale: value });
          }
        }}
      >
        <option value="auto">{t('settings.language.auto')}</option>
        {#each LOCALES as loc (loc.code)}
          <option value={loc.code}>{loc.nativeName}</option>
        {/each}
      </select>
      <small class="hint">{t('settings.language.hint')}</small>
    </label>
  </div>
</section>

<section class="settings" aria-label="Cuenta, reglas e IA">
  <div class="settings-body">
    <CredentialsBinance {settings} {applySettings} />
    <RulesSettings {settings} {settingsLoaded} {applySettings} />
    <CredentialsAi {settings} {settingsLoaded} {applySettings} />
    <PromptSettings />
  </div>
</section>
