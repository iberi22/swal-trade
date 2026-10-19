<script lang="ts">
  import { requestSwitchTab } from '../../lib/tv-paint-send';
  import { tvStateHint, type TvChartState } from '../../lib/tv-paint';
  import { normalizeSymbolList, HOTKEY_KEYS, type ExtensionSettings } from '../../lib/settings';
  import { NEWS_REFRESH_MS } from '../../lib/news';
  import { TIMEFRAMES, type Timeframe } from '../../lib/types';

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
</script>

<!-- El interruptor de pintar vive aquí pero fuera de .settings: es una acción
     sobre la página, no una preferencia más. -->
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
        disabled={!settingsLoaded}
        checked={settings.hotkeysEnabled}
        onchange={(e) => applySettings({ ...settings, hotkeysEnabled: (e.currentTarget as HTMLInputElement).checked })}
      />
      <span>Atajos de teclado para temporalidad (F1..F12)</span>
    </label>
    <p class="hint">F1 a F5 cambian la temporalidad en Binance Futures y previenen acciones del navegador (F1 abre ayuda, F5 recarga la página).</p>
    <div class="field">
      <span>Asignación de teclas</span>
      <div class="hotkeys-grid">
        {#each HOTKEY_KEYS as key (key)}
          <div class="hotkey-row">
            <span class="hotkey-label">{key}</span>
            <select
              disabled={!settingsLoaded || !settings.hotkeysEnabled}
              value={settings.hotkeyMap?.[key] ?? ''}
              onchange={(e) => {
                const val = (e.currentTarget as HTMLSelectElement).value;
                applySettings({ ...settings, hotkeyMap: { ...settings.hotkeyMap, [key]: val ? (val as Timeframe) : null } });
              }}
            >
              <option value="">—</option>
              {#each TIMEFRAMES as tf (tf)}<option value={tf}>{tf}</option>{/each}
            </select>
          </div>
        {/each}
      </div>
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
