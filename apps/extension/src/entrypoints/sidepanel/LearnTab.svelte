<script lang="ts">
  import { tick } from 'svelte';
  import type { GlossaryEntry } from '../../lib/glossary/entries';
  import { entryById } from '../../lib/glossary/entries';
  import { learnCategories, learnEntries, type CategoryFilter } from '../../lib/glossary/learn';
  import { onOpenInLearn } from '../../lib/glossary/learn-nav';
  import { categoryText, entryText, uiText } from '../../lib/glossary/text';
  import { detailFor } from '../../lib/glossary/tooltip';

  let query = $state('');
  let category = $state<CategoryFilter>('todas');
  let expanded = $state<string | null>(null);
  let listEl = $state<HTMLUListElement | null>(null);

  const entries = $derived(learnEntries(query, category));
  const categories = $derived(learnCategories());
  const title = (entry: GlossaryEntry) => entryText(entry.id, 'title');
  const short = (entry: GlossaryEntry) => entryText(entry.id, 'short');

  async function reveal(entryId: string) {
    await tick();
    const node = listEl?.querySelector<HTMLElement>(`[data-entry="${entryId}"]`);
    if (!node) return;
    node.scrollIntoView({ block: 'nearest' });
    node.querySelector<HTMLElement>('button')?.focus();
  }

  // Un tooltip puede pedir «Ver en Aprender»: se abre el detalle de ese término.
  $effect(() => {
    const off = onOpenInLearn((request) => {
      query = '';
      category = 'todas';
      expanded = request.entryId;
      void reveal(request.entryId);
    });
    return off;
  });

  function toggle(entry: GlossaryEntry) {
    expanded = expanded === entry.id ? null : entry.id;
  }
</script>

<section class="learn" aria-label={uiText('tab_title')} data-testid="learn-tab">
  <div class="filters">
    <input
      type="search"
      class="search"
      data-testid="learn-search"
      placeholder={uiText('search_placeholder')}
      aria-label={uiText('search_placeholder')}
      bind:value={query}
    />
    <ul class="chips" aria-label={uiText('all_categories')}>
      <li>
        <button
          type="button"
          class:selected={category === 'todas'}
          aria-pressed={category === 'todas'}
          onclick={() => (category = 'todas')}
        >{uiText('all_categories')}</button>
      </li>
      {#each categories as item (item)}
        <li>
          <button
            type="button"
            class:selected={category === item}
            aria-pressed={category === item}
            onclick={() => (category = item)}
          >{categoryText(item)}</button>
        </li>
      {/each}
    </ul>
  </div>

  {#if entries.length === 0}
    <p class="empty">{uiText('no_results')}</p>
  {:else}
    <ul class="entries" bind:this={listEl}>
      {#each entries as entry (entry.id)}
        {@const detail = expanded === entry.id ? detailFor(entry) : null}
        <li class="entry" data-testid="learn-entry" data-entry={entry.id}>
          <button
            type="button"
            class="entry-head"
            aria-expanded={expanded === entry.id}
            onclick={() => toggle(entry)}
          >
            <span class="entry-title">{title(entry)}</span>
            <span class="entry-short">{short(entry)}</span>
          </button>
          {#if detail}
            <div class="detail" data-testid="learn-detail">
              {#each detail.sections as section (section.id)}
                <p class="section">
                  <span class="section-label">{section.label}</span>
                  {section.text}
                </p>
              {/each}
              <p class="measured">
                <span class="section-label">{detail.measuredLabel}</span>
                {detail.stat ?? detail.noData}
              </p>
              {#if detail.statNote}
                <p class="note">{detail.statNote}</p>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .learn {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    flex: 1 1 auto;
    min-height: 0;
  }

  .filters {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .search {
    width: 100%;
    padding: 0.32rem 0.45rem;
    border: 0;
    border-radius: calc(var(--radius) - 0.3rem);
    background: hsl(var(--surface));
    font-size: 0.74rem;
  }

  .chips {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .chips button {
    border: 0;
    border-radius: calc(var(--radius) - 0.4rem);
    padding: 0.12rem 0.4rem;
    background: hsl(var(--surface-strong));
    color: hsl(var(--muted-foreground));
    font-size: 0.66rem;
    cursor: pointer;
  }

  .chips button.selected {
    background: hsl(var(--primary));
    color: hsl(var(--primary-foreground));
    font-weight: 600;
  }

  .entries {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .entry {
    background: hsl(var(--surface));
    border-radius: calc(var(--radius) - 0.3rem);
    padding: 0.3rem 0.45rem;
  }

  .entry-head {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    width: 100%;
    padding: 0;
    border: 0;
    background: none;
    text-align: left;
    cursor: pointer;
  }

  .entry-title {
    font-size: 0.72rem;
    font-weight: 600;
  }

  .entry-short {
    font-size: 0.68rem;
    color: hsl(var(--muted-foreground));
  }

  .detail {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-top: 0.3rem;
    padding-top: 0.3rem;
    border-top: 1px solid hsl(var(--surface-strong));
  }

  .section,
  .measured,
  .note {
    margin: 0;
    font-size: 0.68rem;
    line-height: 1.35;
  }

  .measured {
    font-variant-numeric: tabular-nums;
  }

  .note {
    color: hsl(var(--subtle-foreground));
  }

  .section-label {
    display: block;
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: hsl(var(--subtle-foreground));
  }

  .empty {
    margin: 0;
    font-size: 0.7rem;
    color: hsl(var(--subtle-foreground));
  }
</style>
