<script module lang="ts">
  let seq = 0;
  let activeCloser: (() => void) | null = null;

  function nextId(): string {
    seq += 1;
    return `term-tip-${seq}`;
  }
</script>

<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import type { GlossaryEntry } from '../../lib/glossary/entries';
  import { openInLearn } from '../../lib/glossary/learn-nav';
  import { tooltipForEntry, type TermTooltip } from '../../lib/glossary/tooltip';
  import { getTermTrend } from './term-trend';

  let { entry, text }: { entry: GlossaryEntry; text: string } = $props();

  const tipId = nextId();
  const MARGIN = 6;

  let open = $state(false);
  let tip = $state<TermTooltip | null>(null);
  let left = $state(0);
  let top = $state(0);
  let anchorEl = $state<HTMLSpanElement | null>(null);
  let tipEl = $state<HTMLDivElement | null>(null);
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelClose() {
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  function close() {
    cancelClose();
    if (activeCloser === close) activeCloser = null;
    open = false;
    tip = null;
  }

  /** El puntero puede cruzar del término al tooltip para pulsar «Ver en Aprender». */
  function scheduleClose() {
    cancelClose();
    closeTimer = setTimeout(close, 160);
  }

  function place() {
    const anchor = anchorEl?.getBoundingClientRect();
    if (!anchor) return;
    const box = tipEl?.getBoundingClientRect();
    const width = box?.width || 256;
    const height = box?.height || 150;
    const vw = window.innerWidth || 380;
    const vh = window.innerHeight || 600;
    // El panel mide 380 px: el tooltip se queda dentro siempre.
    const maxLeft = Math.max(MARGIN, vw - width - MARGIN);
    const x = Math.min(Math.max(MARGIN, anchor.left), maxLeft);
    let y = anchor.bottom + MARGIN;
    if (y + height > vh - MARGIN) y = Math.max(MARGIN, anchor.top - height - MARGIN);
    left = Math.round(x);
    top = Math.round(y);
  }

  async function show() {
    cancelClose();
    if (activeCloser && activeCloser !== close) activeCloser();
    activeCloser = close;
    tip = tooltipForEntry(entry, { trend: getTermTrend() });
    open = true;
    await tick();
    place();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      close();
      anchorEl?.focus();
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && !open) {
      event.preventDefault();
      void show();
    }
  }

  function goLearn() {
    openInLearn(entry.id);
    close();
  }

  /** Mueve el tooltip a <body>: ninguna tarjeta con overflow lo recorta. */
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }

  $effect(() => {
    if (!open) return;
    const onScroll = () => close();
    const onResize = () => place();
    // Esc cierra aunque el foco esté en cualquier parte del panel.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onEscape, true);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('keydown', onEscape, true);
    };
  });

  onDestroy(() => {
    cancelClose();
    if (activeCloser === close) activeCloser = null;
  });
</script>

<span
  class="term"
  class:open
  bind:this={anchorEl}
  tabindex="0"
  aria-describedby={open ? tipId : undefined}
  data-testid="term"
  data-term={entry.id}
  onmouseenter={() => void show()}
  onmouseleave={scheduleClose}
  onfocus={() => void show()}
  onblur={scheduleClose}
  onclick={() => {
    if (!open) void show();
  }}
  onkeydown={onKeydown}
>{text}</span>{#if open && tip}<div
    class="tip"
    role="tooltip"
    id={tipId}
    data-testid="term-tooltip"
    data-term={entry.id}
    bind:this={tipEl}
    use:portal
    style:left="{left}px"
    style:top="{top}px"
    onmouseenter={cancelClose}
    onmouseleave={scheduleClose}
    onkeydown={onKeydown}
  >
    <p class="tip-title" data-tip="title">{tip.title}</p>
    <p class="tip-short" data-tip="short">{tip.short}</p>
    <p class="tip-read" data-tip="read">{tip.read}</p>
    {#if tip.context}
      <p class="tip-context" data-tip="context">{tip.context}</p>
    {/if}
    {#if tip.stat}
      <p class="tip-stat" data-tip="stat">{tip.stat}</p>
      <p class="tip-note" data-tip="stat-note">{tip.statNote}</p>
    {:else if tip.noData}
      <p class="tip-note" data-tip="none">{tip.noData}</p>
    {/if}
    <button type="button" class="tip-learn" data-tip="learn" onclick={goLearn}>{tip.learnLabel}</button>
  </div>{/if}

<style>
  .term {
    cursor: help;
    border-radius: 0.2rem;
  }

  .term:hover,
  .term:focus-visible {
    text-decoration: underline dotted;
    text-underline-offset: 0.15em;
  }

  .tip {
    position: fixed;
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    width: max-content;
    max-width: 16rem;
    padding: 0.5rem 0.6rem;
    background: rgba(247, 245, 240, 0.82);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    border-radius: calc(var(--radius) - 0.15rem);
    box-shadow: 0 8px 22px hsl(var(--foreground) / 0.14);
    color: hsl(var(--foreground));
    font-size: 0.7rem;
    line-height: 1.35;
    white-space: normal;
    text-align: left;
  }

  .tip p {
    margin: 0;
  }

  .tip-title {
    font-weight: 600;
  }

  .tip-short {
    color: hsl(var(--foreground));
  }

  .tip-read,
  .tip-context,
  .tip-note {
    color: hsl(var(--muted-foreground));
  }

  .tip-stat {
    font-variant-numeric: tabular-nums;
  }

  .tip-learn {
    align-self: flex-start;
    margin-top: 0.1rem;
    padding: 0;
    border: 0;
    background: none;
    color: hsl(var(--foreground));
    font-size: 0.7rem;
    font-weight: 600;
    text-decoration: underline;
    text-underline-offset: 0.15em;
    cursor: pointer;
  }
</style>
