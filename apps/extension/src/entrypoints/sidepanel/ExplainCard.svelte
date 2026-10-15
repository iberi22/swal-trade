<script lang="ts">
  import { EXPLAIN_DISCLAIMER, EXPLAIN_OPT_IN_NOTE, explainPatterns, type ExplainView } from '../../lib/explain';
  import type { AnalysisResult } from '../../lib/types';

  let {
    symbol,
    timeframe,
    result,
    enabled,
    ready,
    onToggle,
  }: {
    symbol: string;
    timeframe: string;
    result: AnalysisResult;
    enabled: boolean;
    ready: boolean;
    onToggle: (value: boolean) => void;
  } = $props();

  let view = $state<ExplainView | null>(null);
  let busy = $state(false);
  let shownKey = $state<string | null>(null);

  // Al cambiar de par o de temporalidad, la explicación anterior ya no vale.
  $effect(() => {
    if (shownKey !== null && shownKey !== `${symbol}@${timeframe}`) {
      view = null;
      shownKey = null;
    }
  });

  async function explain() {
    if (busy || !enabled) return;
    busy = true;
    const key = `${symbol}@${timeframe}`;
    try {
      view = await explainPatterns({ symbol, timeframe, result, enabled: true });
      shownKey = key;
    } catch {
      // explainPatterns no lanza; aun así, una tarjeta no puede romper el panel.
      view = null;
    } finally {
      busy = false;
    }
  }

  function sourceLabel(current: ExplainView): string {
    if (current.source === 'cache') return 'Respuesta guardada de hace menos de 5 minutos.';
    if (current.source === 'fallback') {
      return current.local ? 'Explicación local con reglas fijas.' : 'El servicio respondió con reglas fijas.';
    }
    return 'Explicación escrita por un modelo a partir del análisis determinista.';
  }
</script>

<section class="explain" data-testid="explain-card" aria-label="Explicación">
  <h2>Explicación</h2>
  <label class="optin">
    <input
      type="checkbox"
      disabled={!ready}
      checked={enabled}
      onchange={(event) => onToggle((event.currentTarget as HTMLInputElement).checked)}
    />
    <span>Explicaciones con IA</span>
  </label>
  <p class="note">{EXPLAIN_OPT_IN_NOTE}</p>

  <button type="button" data-testid="explain-button" disabled={!enabled || busy} onclick={explain}>
    {busy ? 'Explicando…' : 'Explicar estos patrones'}
  </button>
  {#if !enabled}
    <p class="note" data-testid="explain-optin-hint">
      Activa «Explicaciones con IA» para pedir la explicación.
    </p>
  {/if}

  {#if view}
    <div class="answer" data-testid="explain-answer" data-source={view.source}>
      <p class="note source">
        {sourceLabel(view)}{#if view.reason}<span class="reason"> · {view.reason}</span>{/if}
      </p>
      {#if view.summary}<p class="summary">{view.summary}</p>{/if}
      {#if view.scenarios.length > 0}
        <ul class="scenarios">
          {#each view.scenarios as scenario (scenario.name + scenario.condition)}
            <li>
              <p class="scenario-name">{scenario.name}</p>
              <p class="scenario-line"><span class="tag">confirma</span> {scenario.condition}</p>
              <p class="scenario-line"><span class="tag">invalida</span> {scenario.invalidation}</p>
              <p class="scenario-line risk">{scenario.riskNote}</p>
            </li>
          {/each}
        </ul>
      {/if}
      {#if view.caution}<p class="note">{view.caution}</p>{/if}
    </div>
  {/if}

  <p class="note disclaimer" data-testid="explain-disclaimer">{EXPLAIN_DISCLAIMER}</p>
</section>

<style>
  /* Mismo tono que el resto del panel: superficie hueso, sin bordes. */
  .explain {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    background: hsl(var(--surface));
    border-radius: var(--radius);
    padding: 0.65rem 0.7rem;
  }
  .explain h2 {
    margin: 0;
    font-size: 0.78rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: hsl(var(--muted-foreground));
  }
  .optin {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
    color: hsl(var(--foreground));
  }
  .optin input { accent-color: hsl(var(--primary)); }
  .note {
    margin: 0;
    font-size: 0.72rem;
    line-height: 1.35;
    color: hsl(var(--muted-foreground));
  }
  .disclaimer { color: hsl(var(--subtle-foreground)); }
  .explain button {
    align-self: flex-start;
    background: hsl(var(--primary));
    color: hsl(var(--primary-foreground));
    border: 0;
    border-radius: calc(var(--radius) - 0.2rem);
    padding: 0.4rem 0.7rem;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .explain button:disabled {
    background: hsl(var(--surface-strong));
    color: hsl(var(--subtle-foreground));
    cursor: default;
  }
  .answer { display: flex; flex-direction: column; gap: 0.4rem; }
  .summary {
    margin: 0;
    font-size: 0.82rem;
    line-height: 1.4;
    color: hsl(var(--foreground));
  }
  .scenarios {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .scenarios li {
    background: hsl(var(--background));
    border-radius: calc(var(--radius) - 0.3rem);
    padding: 0.45rem 0.5rem;
  }
  .scenario-name { margin: 0; font-size: 0.8rem; font-weight: 600; }
  .scenario-line {
    margin: 0;
    font-size: 0.74rem;
    line-height: 1.35;
    color: hsl(var(--muted-foreground));
  }
  .scenario-line.risk { color: hsl(var(--subtle-foreground)); }
  .tag {
    font-size: 0.66rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    color: hsl(var(--subtle-foreground));
  }
</style>
