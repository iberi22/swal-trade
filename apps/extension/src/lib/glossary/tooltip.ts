/**
 * Contenido del tooltip de un término, en un solo sitio y sin DOM: así se puede
 * probar que no aparecen promesas ni cifras que no vengan de `stats.json`.
 */
import { entryById, type GlossaryEntry } from './entries';
import { trendContext, type Trend } from './context-line';
import { noStatLine, statFor, statLine, type GlossaryStat, type GlossaryStatsFile } from './stats';
import { entryText, uiText } from './text';

export interface TooltipLine {
  id: 'title' | 'short' | 'read' | 'context' | 'stat' | 'stat-note' | 'none' | 'learn';
  text: string;
}

export interface TermTooltip {
  entryId: string;
  title: string;
  short: string;
  read: string;
  /** Línea de contexto por tendencia; null si el panel no conoce la tendencia. */
  context: string | null;
  /** Línea medida; null si no hay datos suficientes. */
  stat: string | null;
  /** Aviso honesto que acompaña siempre a una cifra medida. */
  statNote: string | null;
  /** «sin datos suficientes» cuando no hay medida. */
  noData: string | null;
  learnLabel: string;
  /** Todas las líneas visibles, en orden. `learn` es el enlace a Aprender. */
  lines: readonly TooltipLine[];
}

export interface TooltipOptions {
  trend?: Trend | null;
  side?: 'long' | 'short';
  stats?: GlossaryStatsFile;
}

/** Tooltip de una entrada; null si el id no existe en el glosario. */
export function tooltipFor(entryId: string, options: TooltipOptions = {}): TermTooltip | null {
  const entry: GlossaryEntry | undefined = entryById(entryId);
  if (!entry) return null;
  return tooltipForEntry(entry, options);
}

/** Igual que `tooltipFor` con la entrada ya resuelta (lo usan los componentes). */
export function tooltipForEntry(entry: GlossaryEntry, options: TooltipOptions = {}): TermTooltip {
  const title = entryText(entry.id, 'title');
  const short = entryText(entry.id, 'short');
  const read = entryText(entry.id, 'read');
  const context = trendContext(entry, options.trend ?? null);
  const stat: GlossaryStat | null = statFor(entry, options.side, options.stats);
  const statText = stat ? statLine(stat) : null;
  const statNote = stat ? uiText('past_frequency') : null;
  const noData = stat ? null : noStatLine();
  const learnLabel = uiText('view_in_learn');

  const lines: TooltipLine[] = [
    { id: 'title', text: title },
    { id: 'short', text: short },
    { id: 'read', text: read },
  ];
  if (context) lines.push({ id: 'context', text: context });
  if (statText) lines.push({ id: 'stat', text: statText });
  if (statNote) lines.push({ id: 'stat-note', text: statNote });
  if (noData) lines.push({ id: 'none', text: noData });
  lines.push({ id: 'learn', text: learnLabel });

  return {
    entryId: entry.id,
    title,
    short,
    read,
    context,
    stat: statText,
    statNote,
    noData,
    learnLabel,
    lines,
  };
}

export interface DetailSection {
  id: 'what' | 'read' | 'up' | 'down' | 'range' | 'watch';
  label: string;
  text: string;
}

export interface EntryDetail {
  entryId: string;
  title: string;
  short: string;
  sections: readonly DetailSection[];
  /** Línea medida; null si no hay datos suficientes. */
  stat: string | null;
  statNote: string | null;
  noData: string | null;
  measuredLabel: string;
}

const SECTION_LABELS: ReadonlyArray<[DetailSection['id'], string]> = [
  ['what', 'section_what'],
  ['read', 'section_read'],
  ['up', 'section_up'],
  ['down', 'section_down'],
  ['range', 'section_range'],
  ['watch', 'section_watch'],
];

/** Detalle completo de la wiki (pestaña Aprender), sin DOM. */
export function detailFor(entry: GlossaryEntry, options: TooltipOptions = {}): EntryDetail {
  const sections: DetailSection[] = SECTION_LABELS.map(([id, ui]) => ({
    id,
    label: uiText(ui),
    text: entryText(entry.id, id),
  }));
  const stat = statFor(entry, options.side, options.stats);
  return {
    entryId: entry.id,
    title: entryText(entry.id, 'title'),
    short: entryText(entry.id, 'short'),
    sections,
    stat: stat ? statLine(stat) : null,
    statNote: stat ? uiText('past_frequency') : null,
    noData: stat ? null : noStatLine(),
    measuredLabel: uiText('measured_history'),
  };
}
