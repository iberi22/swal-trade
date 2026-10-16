<script lang="ts">
  import { buildFooterLinks } from '../../lib/footer-links';

  interface Props {
    symbol: string;
  }

  let { symbol }: Props = $props();
  let links = $derived(buildFooterLinks(symbol));
</script>

<footer class="sidepanel-footer" aria-label="Enlaces SWAL Trade">
  {#each links as link, i (link.label)}
    {#if i > 0}<span class="sep" aria-hidden="true">·</span>{/if}
    <a href={link.href} target="_blank" rel="noopener">{link.label}</a>
  {/each}
</footer>

<style>
  .sidepanel-footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 0.25rem 0.45rem;
    padding: 0.75rem 0.5rem 0.5rem;
    font-size: 0.75rem;
    color: hsl(var(--muted-foreground));
    border-top: 1px solid hsl(var(--surface-strong));
    margin-top: 0.75rem;
  }

  .sidepanel-footer a {
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .sidepanel-footer a:hover {
    color: hsl(var(--foreground));
  }

  .sep {
    opacity: 0.4;
    user-select: none;
  }
</style>
