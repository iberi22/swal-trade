<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import type { ContextSnapshot } from '../../lib/context/context-feed';
  import { buildLevels, computeAtrs, type FindingLevelInput } from '../../lib/context/levels';
  import { formatPanelPrice } from '../../lib/price-format';
  import type { RulesSettings } from '../../lib/settings';
  import { DEFAULT_SIZING_PREFERENCES, normalizeSizingPreferences, SIZING_STORAGE_KEY } from '../../lib/sizing';
  import { fetchSymbolFilters } from '../../lib/trade-cards/filters';
  import { defaultPresets } from '../../lib/trade-cards/presets';
  import { publishSizingLoad } from '../../lib/trade-cards/sizing-bridge';
  import { loadPresets, savePresets } from '../../lib/trade-cards/storage';
  import { buildTicketSides, CARDS_FOOTER, formatTicketText, HONEST_R_LINE, type SymbolFilters } from '../../lib/trade-cards/ticket';
  import type { TradeCardPreset, TradeSide, TradeTicket } from '../../lib/trade-cards/types';
  import TradeCardEditor from './TradeCardEditor.svelte';

  // Futuro, fuera de alcance: un "rellenar el formulario" opt-in. Hoy solo se calcula y se copia.
  let {
    symbol,
    lastPrice,
    snapshot,
    findingsLevels,
    rules,
    canLoad = true,
  }: {
    symbol: string;
    lastPrice: number | null;
    snapshot: ContextSnapshot | null;
    findingsLevels: FindingLevelInput[];
    rules: RulesSettings;
    canLoad?: boolean;
  } = $props();

  let presets = $state<TradeCardPreset[]>(defaultPresets());
  let capital = $state(DEFAULT_SIZING_PREFERENCES.capital);
  let filters = $state<SymbolFilters | null>(null);
  let expandedId = $state<string | null>(null);
  let sideChoice = $state<Record<string, TradeSide>>({});
  let copiedId = $state<string | null>(null);

  const area = () => browser.storage?.local as never;

  onMount(() => {
    void loadPresets(area()).then((p) => (presets = p));
    const apply = (raw: unknown) => {
      capital = normalizeSizingPreferences(raw).capital;
    };
    void browser.storage?.local?.get(SIZING_STORAGE_KEY).then((s) => apply(s?.[SIZING_STORAGE_KEY])).catch(() => {});
    const onChanged = (changes: Record<string, { newValue?: unknown }>, areaName: string) => {
      if (areaName === 'local' && changes[SIZING_STORAGE_KEY]) apply(changes[SIZING_STORAGE_KEY]?.newValue);
    };
    browser.storage?.onChanged?.addListener(onChanged as never);
    return () => browser.storage?.onChanged?.removeListener(onChanged as never);
  });

  $effect(() => {
    const sym = symbol;
    filters = null;
    let alive = true;
    void fetchSymbolFilters(sym).then((f) => {
      if (alive) filters = f;
    });
    return () => {
      alive = false;
    };
  });

  const candles = $derived(snapshot?.candles ?? null);
  const levels = $derived(
    lastPrice !== null && lastPrice > 0
      ? buildLevels({ price: lastPrice, d1: candles?.d1, w1: candles?.w1, h1: candles?.h1, h4: candles?.h4, findingsLevels })
      : [],
  );
  const atrs = $derived(computeAtrs({ h1: candles?.h1, h4: candles?.h4, d1: candles?.d1 }));
  const cards = $derived(
    presets.map((preset) => ({
      preset,
      sides:
        lastPrice !== null && lastPrice > 0
          ? buildTicketSides({ preset, symbol, price: lastPrice, levels, atrs, capital, rules, filters })
          : [],
    })),
  );
  const empty = $derived(levels.length === 0);

  function chosen(preset: TradeCardPreset, sides: Array<{ side: TradeSide; result: ReturnType<typeof buildTicketSides>[number]['result'] }>) {
    const want = preset.side === 'auto' ? (sideChoice[preset.id] ?? 'long') : preset.side;
    return sides.find((s) => s.side === want) ?? sides[0] ?? null;
  }

  function setPresets(next: TradeCardPreset[]) {
    presets = next;
    void savePresets(area(), next);
  }

  const usd = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 });

  async function copy(id: string, ticket: TradeTicket) {
    const text = formatTicketText(ticket);
    let done = false;
    try {
      await navigator.clipboard.writeText(text);
      done = true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        done = document.execCommand('copy');
      } catch {
        done = false;
      }
      ta.remove();
    }
    if (done) {
      copiedId = id;
      setTimeout(() => {
        if (copiedId === id) copiedId = null;
      }, 1500);
    }
  }

  function load(ticket: TradeTicket) {
    publishSizingLoad({
      direction: ticket.side,
      entry: ticket.entries[0]?.price ?? ticket.avgEntry,
      stop: ticket.stop,
      riskPct: ticket.basis.basis === 'risk' ? Math.min(5, Math.max(0.1, ticket.basis.pct)) : undefined,
    });
  }
</script>

<section class="cards" data-testid="trade-cards" aria-label="Tarjetas de operación">
  <div class="card-head">
    <h2>Tarjetas de operación</h2>
    <span class="head-hint">capital {usd.format(capital)} USDT</span>
  </div>
  <p class="foot">{CARDS_FOOTER}</p>

  {#if empty}
    <p class="hint">Sin niveles todavía</p>
  {/if}

  <div class="tiles">
    {#each cards as c (c.preset.id)}
      {@const pick = chosen(c.preset, c.sides)}
      {@const ticket = pick && pick.result.ok ? pick.result.ticket : null}
      <button
        type="button"
        class="tile"
        class:open={expandedId === c.preset.id}
        data-testid="trade-card"
        aria-expanded={expandedId === c.preset.id}
        disabled={empty && c.preset.entry.kind === 'limit_level'}
        onclick={() => (expandedId = expandedId === c.preset.id ? null : c.preset.id)}
      >
        <span class="t-name">{c.preset.name}</span>
        {#if ticket}
          <span class="t-line">entrada {formatPanelPrice(ticket.entries[0]?.price ?? 0)} · stop {formatPanelPrice(ticket.stop)}</span>
          <span class="t-line">pierdes {usd.format(ticket.lossAtStopUsd)} USD ({pct.format(ticket.lossAtStopPctOfCapital)} %)</span>
          {#if ticket.warnings.some((w) => w.code === 'risk_above_rule')}
            <span class="badge" class:inverted={ticket.highRisk}>{ticket.warnings.find((w) => w.code === 'risk_above_rule')?.text}</span>
          {/if}
        {:else if pick && !pick.result.ok}
          <span class="t-line muted">{pick.result.reason}</span>
        {:else}
          <span class="t-line muted">Esperando precio…</span>
        {/if}
      </button>
    {/each}
  </div>

  {#each cards as c (c.preset.id)}
    {#if expandedId === c.preset.id}
      {@const pick = chosen(c.preset, c.sides)}
      <div class="ticket" data-testid="trade-ticket">
        {#if c.preset.side === 'auto'}
          <div class="dir-group" role="group" aria-label="Dirección del ticket">
            <button type="button" class="dir-btn" class:selected={pick?.side === 'long'} onclick={() => (sideChoice[c.preset.id] = 'long')}>Largo</button>
            <button type="button" class="dir-btn" class:selected={pick?.side === 'short'} onclick={() => (sideChoice[c.preset.id] = 'short')}>Corto</button>
          </div>
        {/if}
        {#if pick && pick.result.ok}
          {@const t = pick.result.ticket}
          <dl>
            <dt>Par</dt><dd>{t.symbol} · {t.side === 'long' ? 'Largo' : 'Corto'} · {t.orderType === 'LIMIT' ? 'Límite' : 'Mercado'}</dd>
            {#each t.entries as e, i}
              <dt>Entrada{t.entries.length > 1 ? ` ${i + 1}` : ''}</dt><dd>{formatPanelPrice(e.price)} · cant. {e.qty} ({e.weightPct} %)</dd>
            {/each}
            {#if t.entries.length > 1}<dt>Media</dt><dd>{formatPanelPrice(t.avgEntry)}</dd>{/if}
            <dt>Nivel</dt><dd>{t.entryLabel}</dd>
            <dt>Stop</dt><dd>{formatPanelPrice(t.stop)}</dd>
            {#each t.tps as tp, i}
              <dt>Objetivo {i + 1}</dt><dd>{formatPanelPrice(tp.price)} · {pct.format(tp.rMultiple)}R{tp.label ? ` · ${tp.label}` : ''}</dd>
            {/each}
            <dt>Apalancamiento</dt><dd>{t.leverage}×</dd>
            <dt>Margen</dt><dd>{usd.format(t.marginUsd)} USD</dd>
            <dt>Nocional</dt><dd>{usd.format(t.notionalUsd)} USD</dd>
            <dt>Pérdida en stop</dt><dd>{usd.format(t.lossAtStopUsd)} USD ({pct.format(t.lossAtStopPctOfCapital)} %)</dd>
            <dt>Comisiones</dt><dd>~{usd.format(t.feeUsd)} USD · {t.fees.note}</dd>
          </dl>
          {#if t.scaleInNote}<p class="note">{t.scaleInNote}</p>{/if}
          {#if t.warnings.length > 0}
            <ul class="warns">
              {#each t.warnings as w (w.code)}<li>{w.text}</li>{/each}
            </ul>
          {/if}
          <p class="note">{HONEST_R_LINE}</p>
          <div class="actions">
            <button type="button" class="btn" data-testid="trade-copy" onclick={() => copy(c.preset.id, t)}>
              {copiedId === c.preset.id ? 'Copiado' : 'Copiar ticket'}
            </button>
            {#if canLoad}
              <button type="button" class="btn" data-testid="trade-load" onclick={() => load(t)}>Cargar en el dimensionador</button>
            {/if}
          </div>
        {:else if pick && !pick.result.ok}
          <p class="hint">{pick.result.reason}</p>
        {/if}
      </div>
    {/if}
  {/each}

  <TradeCardEditor {presets} onChange={setPresets} />
</section>

<style>
  .cards { flex: 0 0 auto; display: flex; flex-direction: column; gap: 0.45rem; background: hsl(var(--surface)); border-radius: var(--radius); padding: 0.65rem 0.7rem; }
  .card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
  .card-head h2 { margin: 0; font-size: 0.78rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: hsl(var(--muted-foreground)); }
  .head-hint { font-size: 0.7rem; color: hsl(var(--subtle-foreground)); font-family: var(--font-mono); }
  .foot, .hint { margin: 0; font-size: 0.7rem; color: hsl(var(--subtle-foreground)); line-height: 1.35; }
  .tiles { display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .tile { flex: 1 1 8.5rem; display: flex; flex-direction: column; gap: 0.15rem; text-align: left; background: hsl(var(--background)); color: hsl(var(--foreground)); border: 0; border-radius: calc(var(--radius) - 0.3rem); padding: 0.4rem 0.5rem; cursor: pointer; min-width: 0; }
  .tile.open { outline: 1px solid hsl(var(--foreground)); }
  .tile:disabled { opacity: 0.5; cursor: default; }
  .t-name { font-size: 0.72rem; font-weight: 600; }
  .t-line { font-size: 0.66rem; font-family: var(--font-mono); color: hsl(var(--muted-foreground)); font-variant-numeric: tabular-nums; }
  .muted { color: hsl(var(--subtle-foreground)); }
  .badge { align-self: flex-start; font-size: 0.62rem; padding: 0.1rem 0.35rem; border-radius: calc(var(--radius) - 0.4rem); background: hsl(var(--surface-strong)); color: hsl(var(--foreground)); }
  .badge.inverted { background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); }
  .ticket { display: flex; flex-direction: column; gap: 0.35rem; background: hsl(var(--background)); border-radius: calc(var(--radius) - 0.3rem); padding: 0.5rem; }
  dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 0.15rem 0.6rem; font-size: 0.72rem; }
  dt { color: hsl(var(--muted-foreground)); }
  dd { margin: 0; font-family: var(--font-mono); font-variant-numeric: tabular-nums; min-width: 0; overflow-wrap: anywhere; }
  .warns { margin: 0; padding-left: 1rem; font-size: 0.7rem; color: hsl(var(--foreground)); }
  .note { margin: 0; font-size: 0.68rem; color: hsl(var(--subtle-foreground)); line-height: 1.35; }
  .actions { display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .btn { background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); border: 0; border-radius: calc(var(--radius) - 0.3rem); padding: 0.35rem 0.6rem; font-size: 0.72rem; font-weight: 600; cursor: pointer; }
  .dir-group { display: flex; gap: 0.25rem; }
  .dir-btn { background: hsl(var(--surface)); color: hsl(var(--muted-foreground)); border: 0; border-radius: calc(var(--radius) - 0.2rem); padding: 0.25rem 0.6rem; font-size: 0.72rem; font-weight: 600; cursor: pointer; }
  .dir-btn.selected { background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); }
</style>
