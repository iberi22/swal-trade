<script lang="ts">
  import { onMount } from 'svelte';
  import {
    fetchRadarSnapshot, formatPct, formatR, formatWilson,
    radarDirectionLabel, radarStatusLabel, shapesForRadarAlert,
    type RadarAlert, type RadarSnapshot, gradeView
  } from '../../lib/radar';
  import { formatPanelPrice } from '../../lib/price-format';
  import { sendPaintCommand } from '../../lib/tv-paint-send';

  let {
    symbol,
    port = 47322,
    paintEnabled = false,
    enabled = true,
  }: {
    symbol: string;
    port?: number;
    paintEnabled?: boolean;
    enabled?: boolean;
  } = $props();

  let snapshot = $state<RadarSnapshot>({ reachable: false, alerts: [], stats: null });
  let filterCurrent = $state(false);
  let paintingId = $state<number | string | null>(null);
  let reqSeq = 0;

  const clean = (s: string) => s.toUpperCase().replace(/USDC$|USDT$/, '');
  const activeAlerts = $derived(
    filterCurrent
      ? snapshot.alerts.filter((a) => clean(a.symbol) === clean(symbol))
      : snapshot.alerts
  );

  async function load() {
    if (!enabled) return;
    const currentSeq = ++reqSeq;
    const res = await fetchRadarSnapshot(port);
    if (currentSeq === reqSeq) {
      snapshot = res;
    }
  }

  async function paintAlert(alert: RadarAlert) {
    if (!paintEnabled) return;
    paintingId = alert.id;
    await sendPaintCommand({ key: `radar:${alert.id}`, shapes: shapesForRadarAlert(alert) });
  }

  $effect(() => {
    const p = port;
    const en = enabled;
    if (en && p) void load();
  });

  onMount(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer || !enabled) return;
      void load();
      timer = setInterval(() => { if (!document.hidden && enabled) void load(); }, 30_000);
    };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVis = () => { if (document.hidden) stop(); else start(); };

    document.addEventListener('visibilitychange', onVis);
    if (!document.hidden && enabled) start();
    return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
  });
</script>

{#if enabled}
  {#if !snapshot.reachable}
    <section class="radar" aria-label="Radar local">
      <p class="empty">Radar local apagado (servicio swal-radar)</p>
    </section>
  {:else}
    <section class="radar" aria-label="Radar local">
      <div class="head">
        <h2>Radar local</h2>
        <span class="subtle">{snapshot.version ? `v${snapshot.version}` : 'en vivo'}</span>
      </div>

      <div class="subhead">
        <h3>Alertas activas</h3>
        <label class="toggle">
          <input type="checkbox" bind:checked={filterCurrent} />
          <span>Solo este par</span>
        </label>
      </div>

      {#if activeAlerts.length === 0}
        <p class="empty">Sin alertas activas.</p>
      {:else}
        <ul class="alerts">
          {#each activeAlerts as alert (alert.id)}
            <li class="alert" class:hl={clean(alert.symbol) === clean(symbol)}>
              <div class="row">
                <span class="meta">{alert.symbol} · {alert.tf} · {radarDirectionLabel(alert.direction)}</span>
                <span class="badge" data-status={alert.status}>{radarStatusLabel(alert.status)}</span>
                <span class="badge grade {gradeView(alert.cellGrade, alert.cellN).tone}" title={gradeView(alert.cellGrade, alert.cellN).hint} aria-label={gradeView(alert.cellGrade, alert.cellN).hint}>{gradeView(alert.cellGrade, alert.cellN).label}</span>
                {#if alert.taken_by_user}<span class="taken">tomada por ti</span>{/if}
              </div>
              <p class="title">{alert.title}</p>
              <div class="levels">
                <span>Entrada {formatPanelPrice(alert.entry)}</span>
                <span>Stop {formatPanelPrice(alert.stop)}</span>
                <span>Obj 1R {formatPanelPrice(alert.target_1r)}</span>
              </div>
              <button
                type="button"
                class="btn-paint"
                disabled={!paintEnabled}
                title={paintEnabled ? 'Pintar niveles en el gráfico' : 'Activa «Pintar en el gráfico» en Ajustes'}
                onclick={() => paintAlert(alert)}
              >
                {paintingId === alert.id ? 'Pintado' : 'Ver en el gráfico'}
              </button>
            </li>
          {/each}
        </ul>
      {/if}

      {#if snapshot.stats}
        {@const s = snapshot.stats}
        <div class="subhead">
          <h3>Historial</h3>
        </div>
        <div class="stats-box">
          <div class="stat-card">
            <h4>Global ({s.overall.label})</h4>
            <p class="stat-line">Resueltas: {s.overall.n_resolved} · Activadas: {formatPct(s.overall.triggered_rate)}</p>
            <p class="stat-line">Ganó 1R: {formatPct(s.overall.win_rate_1r)} {formatWilson(s.overall.ci_1r)}</p>
            <p class="stat-line">Ganó 2R: {formatPct(s.overall.win_rate_2r)} {formatWilson(s.overall.ci_2r)}</p>
            <p class="stat-line">R neto medio: {formatR(s.overall.avg_net_r)}</p>
          </div>

          <div class="stat-card">
            <h4>Tomadas por ti ({s.taken.label})</h4>
            <p class="stat-line">Resueltas: {s.taken.n_resolved} · Activadas: {formatPct(s.taken.triggered_rate)}</p>
            <p class="stat-line">Ganó 1R: {formatPct(s.taken.win_rate_1r)} {formatWilson(s.taken.ci_1r)}</p>
            <p class="stat-line">Ganó 2R: {formatPct(s.taken.win_rate_2r)} {formatWilson(s.taken.ci_2r)}</p>
            <p class="stat-line">R neto medio: {formatR(s.taken.avg_net_r)}</p>
          </div>

          {#if s.by_kind.length > 0}
            <div class="stat-card">
              <h4>Por patrón</h4>
              {#each s.by_kind as k (k.kind + k.tf)}
                <div class="kind-row">
                  <span class="kind-name">{k.kind} ({k.tf})</span>
                  <span class="kind-val">{k.n_resolved} res · 1R {formatPct(k.win_rate_1r)} · {k.label}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
        <p class="note">{s.note}</p>
      {/if}
      <div class="honesty-footer">
        <p>La fuerza del patrón no es una probabilidad. Esto es una medición, no una recomendación.</p>
      </div>
    </section>
  {/if}
{/if}

<style>
  .radar {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    flex: 0 0 auto;
    background: hsl(var(--surface));
    border-radius: var(--radius);
    padding: 0.65rem 0.7rem;
  }
  .head, .subhead { display: flex; justify-content: space-between; align-items: baseline; }
  h2 { margin: 0; font-size: 0.78rem; font-weight: 600; text-transform: uppercase; color: hsl(var(--muted-foreground)); }
  h3 { margin: 0; font-size: 0.72rem; font-weight: 600; color: hsl(var(--muted-foreground)); }
  h4 { margin: 0 0 0.2rem 0; font-size: 0.7rem; font-weight: 600; color: hsl(var(--foreground)); }
  .subtle, .empty { font-size: 0.7rem; color: hsl(var(--subtle-foreground)); margin: 0; }
  .toggle { font-size: 0.7rem; display: flex; align-items: center; gap: 0.3rem; color: hsl(var(--muted-foreground)); cursor: pointer; }
  .alerts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .alert { background: hsl(var(--background)); border-radius: calc(var(--radius) - 0.2rem); padding: 0.45rem 0.5rem; display: flex; flex-direction: column; gap: 0.25rem; }
  .alert.hl { outline: 1px solid hsl(var(--primary) / 0.35); }
  .row { display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; }
  .meta { font-family: var(--font-mono); font-size: 0.7rem; font-weight: 600; }
  .badge { font-size: 0.65rem; padding: 0.1rem 0.3rem; border-radius: 3px; background: hsl(var(--surface-strong)); color: hsl(var(--foreground)); }
  .badge.grade.muted { background: hsl(var(--surface-strong)); color: hsl(var(--subtle-foreground)); }
  .badge.grade.warn { background: hsl(var(--surface-strong)); color: hsl(var(--foreground)); outline: 1px solid hsl(var(--subtle-foreground)); }
  .badge.grade.info { background: hsl(var(--surface-strong)); color: hsl(var(--foreground)); font-weight: 500; }
  .badge.grade.ok { background: hsl(var(--surface-strong)); color: hsl(var(--foreground)); outline: 1px solid hsl(var(--foreground)); }
  .taken { font-size: 0.65rem; padding: 0.1rem 0.3rem; border-radius: 3px; background: hsl(var(--primary) / 0.15); color: hsl(var(--primary)); }
  .title { margin: 0; font-size: 0.75rem; color: hsl(var(--foreground)); }
  .levels { display: flex; gap: 0.5rem; font-family: var(--font-mono); font-size: 0.68rem; color: hsl(var(--muted-foreground)); flex-wrap: wrap; }
  .btn-paint { align-self: flex-start; background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); border: 0; border-radius: calc(var(--radius) - 0.3rem); padding: 0.25rem 0.5rem; font-size: 0.68rem; cursor: pointer; }
  .btn-paint:disabled { background: hsl(var(--surface-strong)); color: hsl(var(--subtle-foreground)); cursor: default; }
  .stats-box { display: flex; flex-direction: column; gap: 0.35rem; }
  .stat-card { background: hsl(var(--background)); border-radius: calc(var(--radius) - 0.2rem); padding: 0.4rem 0.5rem; }
  .stat-line { margin: 0; font-size: 0.68rem; line-height: 1.35; color: hsl(var(--muted-foreground)); }
  .kind-row { display: flex; justify-content: space-between; font-size: 0.67rem; color: hsl(var(--muted-foreground)); padding: 0.1rem 0; }
  .kind-name { font-weight: 500; color: hsl(var(--foreground)); }
  .note { margin: 0; font-size: 0.68rem; line-height: 1.35; color: hsl(var(--muted-foreground)); }
  .honesty-footer { margin-top: 0.4rem; padding-top: 0.4rem; border-top: 1px solid hsl(var(--surface-strong)); }
  .honesty-footer p { margin: 0; font-size: 0.65rem; color: hsl(var(--subtle-foreground)); line-height: 1.3; text-align: center; }
</style>
