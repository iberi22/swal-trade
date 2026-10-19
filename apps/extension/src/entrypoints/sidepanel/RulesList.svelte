<script lang="ts">
  import { ruleLine, topRules } from '../../lib/account/position-view-model';
  import type { RuleResult } from '../../lib/account/rules';

  let { results }: { results: RuleResult[] } = $props();

  const parts = $derived(topRules(results, 3));
</script>

<section class="rules" data-testid="rules-list" aria-label="Reglas">
  {#if results.length === 0}
    <p class="rule-line">i Sin avisos de tus reglas.</p>
  {:else}
    <ul>
      {#each parts.top as rule (rule.code)}
        <li class="rule-line" class:crit={rule.sev === 'critical'} data-code={rule.code} data-sev={rule.sev}>{ruleLine(rule)}</li>
      {/each}
    </ul>
    {#if parts.rest.length > 0}
      <details class="fold">
        <summary>Ver todas ({results.length})</summary>
        <ul>
          {#each parts.rest as rule (rule.code)}
            <li class="rule-line" class:crit={rule.sev === 'critical'} data-code={rule.code} data-sev={rule.sev}>{ruleLine(rule)}</li>
          {/each}
        </ul>
      </details>
    {/if}
  {/if}
</section>

<style>
  .rules {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .rule-line {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 0.74rem;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
  .crit {
    font-weight: 700;
  }
</style>
