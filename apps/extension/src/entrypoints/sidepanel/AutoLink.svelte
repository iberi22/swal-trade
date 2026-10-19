<script lang="ts">
  import { entryById, termsInText, type GlossaryEntry } from '../../lib/glossary/entries';
  import Term from './Term.svelte';

  let { text }: { text: string } = $props();

  /**
   * Trocea el texto en tramos llanos y términos del glosario. Nunca usa
   * `{@html}`: cada tramo se interpola como texto y Svelte lo escapa.
   */
  const segments = $derived.by((): Array<{ text: string; entry: GlossaryEntry | null }> => {
    const source = typeof text === 'string' ? text : '';
    const out: Array<{ text: string; entry: GlossaryEntry | null }> = [];
    let at = 0;
    for (const match of termsInText(source)) {
      const entry = entryById(match.id);
      if (!entry) continue;
      if (match.start > at) out.push({ text: source.slice(at, match.start), entry: null });
      out.push({ text: match.text, entry });
      at = match.end;
    }
    if (at < source.length) out.push({ text: source.slice(at), entry: null });
    return out;
  });
</script>

{#each segments as segment, index (index)}{#if segment.entry}<Term entry={segment.entry} text={segment.text} />{:else}{segment.text}{/if}{/each}
