<script lang="ts">
  import { buildFooterLinks } from '../../lib/footer-links';

  interface Props {
    symbol: string;
  }

  let { symbol }: Props = $props();
  let links = $derived(buildFooterLinks(symbol));
</script>

<footer class="sidepanel-footer" aria-label="Enlaces SWAL Trade">
  <p class="disclaimer">Datos públicos y educativo. La fuerza de un patrón no es una probabilidad ni una recomendación.</p>
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

  .disclaimer {
    flex: 1 0 100%;
    margin: 0 0 0.2rem;
    text-align: center;
    font-size: 0.68rem;
    color: hsl(var(--subtle-foreground));
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
