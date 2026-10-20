<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { browser } from 'wxt/browser';
  import { PANEL_TABS, PANEL_TAB_KEY, parsePanelTab, tabForKey, type PanelTab } from '../../lib/account/panel-controller';
  import { onOpenInLearn } from '../../lib/glossary/learn-nav';

  let {
    operacion,
    aprender,
    ajustes,
    escaner,
    mistrades,
    selected = $bindable<PanelTab>('operacion'),
    onTabChange,
  }: {
    operacion: Snippet;
    aprender: Snippet;
    ajustes: Snippet;
    escaner: Snippet;
    mistrades: Snippet;
    /** Pestaña activa. El panel es el dueño: aquí solo se refleja y se edita. */
    selected?: PanelTab;
    /** Avisa de la pestaña elegida (incluida la restaurada al abrir). */
    onTabChange?: (tab: PanelTab) => void;
  } = $props();

  // Una sola fuente de verdad: si el panel cambia la pestaña (atajo «Tu
  // dibujo»), esta barra la pinta porque `selected` es el mismo estado. Antes
  // cada uno guardaba su copia y la tarjeta seguía oculta.
  let touched = false;
  let initialized = false;
  $effect(() => {
    const tab = selected;
    onTabChange?.(tab);
    if (!initialized) {
      initialized = true;
      return;
    }
    touched = true;
    void browser.storage.session?.set({ [PANEL_TAB_KEY]: tab }).catch(() => {});
  });
  const buttons: Record<string, HTMLButtonElement | undefined> = {};

  // Un término con «Ver en Aprender» cambia a esta pestaña; el detalle del
  // término lo abre LearnTab, que escucha el mismo aviso.
  $effect(() => onOpenInLearn(() => select('aprender')));

  onMount(() => {
    void browser.storage.session
      ?.get(PANEL_TAB_KEY)
      .then((stored) => {
        // Si ya se eligió una pestaña (con el ratón o con un atajo) mientras
        // tanto, manda esa elección.
        if (!touched) selected = parsePanelTab(stored?.[PANEL_TAB_KEY]);
      })
      .catch(() => {});
  });

  function select(tab: PanelTab, focus = false) {
    touched = true;
    selected = tab;
    if (focus) buttons[tab]?.focus();
  }

  function onKeydown(event: KeyboardEvent) {
    const next = tabForKey(selected, event.key);
    if (!next) return;
    event.preventDefault();
    select(next, true);
  }
</script>

<div class="tabs">
  <div
    class="tablist"
    role="tablist"
    aria-label="Secciones del panel"
    tabindex="-1"
    onkeydown={onKeydown}
    style="grid-template-columns: repeat({PANEL_TABS.length}, 1fr)"
  >
    {#each PANEL_TABS as tab (tab.id)}
      <button
        type="button"
        role="tab"
        id={`tab-${tab.id}`}
        aria-selected={selected === tab.id}
        aria-controls={`tabpanel-${tab.id}`}
        tabindex={selected === tab.id ? 0 : -1}
        class:selected={selected === tab.id}
        bind:this={buttons[tab.id]}
        onclick={() => select(tab.id)}
      >{tab.label}</button>
    {/each}
  </div>

  <!-- Todos los paneles siguen montados: cambiar de pestaña no reinicia la IA ni el radar. -->
  <div role="tabpanel" id="tabpanel-operacion" aria-labelledby="tab-operacion" hidden={selected !== 'operacion'}>
    {@render operacion()}
  </div>
  <div role="tabpanel" id="tabpanel-aprender" aria-labelledby="tab-aprender" hidden={selected !== 'aprender'}>
    {@render aprender()}
  </div>
  <div role="tabpanel" id="tabpanel-ajustes" aria-labelledby="tab-ajustes" hidden={selected !== 'ajustes'}>
    {@render ajustes()}
  </div>
  <div role="tabpanel" id="tabpanel-escaner" aria-labelledby="tab-escaner" hidden={selected !== 'escaner'}>
    {@render escaner()}
  </div>
  <div role="tabpanel" id="tabpanel-mistrades" aria-labelledby="tab-mistrades" hidden={selected !== 'mistrades'}>
    {@render mistrades()}
  </div>
</div>

<style>
  .tabs {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    flex: 0 0 auto;
  }
  [role='tabpanel'] {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  [role='tabpanel'][hidden] {
    display: none;
  }
  .tablist {
    display: grid;
    /* auto-fit: añadir pestañas no descoloca la barra. */
    grid-template-columns: repeat(auto-fit, minmax(3.4rem, 1fr));
    gap: 0.25rem;
    background: hsl(var(--surface));
    border-radius: var(--radius);
    padding: 0.2rem;
  }
  .tablist button {
    background: transparent;
    border: 0;
    border-radius: calc(var(--radius) - 0.2rem);
    padding: 0.4rem 0.3rem;
    font-size: 0.74rem;
    color: hsl(var(--muted-foreground));
    cursor: pointer;
  }
  .tablist button.selected {
    background: hsl(var(--primary));
    color: hsl(var(--primary-foreground));
    font-weight: 600;
  }
</style>
