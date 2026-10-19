import { describe, expect, it } from 'vitest';
import messages from './glossary.es.json';
import { GLOSSARY, entryById } from './entries';
import { detailFor, tooltipFor } from './tooltip';
import {
  EMPTY_STATS,
  STATS_SCHEMA,
  formatPct,
  parseStatsFile,
  statLine,
  type GlossaryStatsFile,
} from './stats';
import { entryText, uiText } from './text';

const prose = messages as Record<string, string>;

/** Medida de prueba: la UI solo puede repetir estas cifras, tal cual. */
const STAT = {
  type: 'level',
  id: 'prevDayHigh',
  rate: 58.1,
  ci_low: 55.2,
  ci_high: 61,
  baseline: 50,
  lift_pp: 8.1,
  n: 1234,
  grade: 'promising',
};

const FIXTURE: GlossaryStatsFile = parseStatsFile({ schema: STATS_SCHEMA, stats: [STAT] })!;

const TRENDS = [null, 'up', 'down', 'range'] as const;

const plain = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

describe('tooltipFor', () => {
  it('devuelve las piezas que pide el tooltip', () => {
    const tip = tooltipFor('prevDayHigh', { trend: 'up' })!;
    expect(tip.title).toBe(entryText('prevDayHigh', 'title'));
    expect(tip.short).toBe(entryText('prevDayHigh', 'short'));
    expect(tip.read).toBe(entryText('prevDayHigh', 'read'));
    expect(tip.context).toContain('Tendencia actual: alcista');
    expect(tip.learnLabel).toBe(uiText('view_in_learn'));
    expect(tip.lines.map((line) => line.id)).toContain('learn');
  });

  it('sin tendencia no añade la línea de contexto', () => {
    const tip = tooltipFor('prevDayHigh', { trend: null })!;
    expect(tip.context).toBeNull();
    expect(tip.lines.some((line) => line.id === 'context')).toBe(false);
  });

  it('sin medida dice «sin datos suficientes» en vez de inventar una cifra', () => {
    const tip = tooltipFor('prevDayHigh', { trend: 'up', stats: EMPTY_STATS })!;
    expect(tip.stat).toBeNull();
    expect(tip.statNote).toBeNull();
    expect(tip.noData).toBe('sin datos suficientes');
    for (const line of tip.lines) expect(line.text).not.toContain('%');
  });

  it('con medida añade la línea y el aviso honesto', () => {
    const tip = tooltipFor('prevDayHigh', { trend: 'up', stats: FIXTURE })!;
    expect(tip.noData).toBeNull();
    expect(tip.stat).toContain('58,1 %');
    expect(tip.stat).toContain('n = 1234 eventos');
    expect(tip.statNote).toBe(uiText('past_frequency'));
    expect(tip.statNote).toContain('no una predicción');
  });

  it('null si el término no existe', () => {
    expect(tooltipFor('no_existe')).toBeNull();
  });
});

describe('grados de la línea medida', () => {
  const withGrade = (grade: string, extra: Record<string, unknown> = {}) =>
    parseStatsFile({
      schema: STATS_SCHEMA,
      stats: [
        {
          type: 'level',
          id: 'prevDayHigh',
          rate: 50.4,
          ci_low: 47.4,
          ci_high: 53.4,
          baseline: 50,
          lift_pp: 0.4,
          n: 812,
          grade,
          ...extra,
        },
      ],
    })!;

  it('un grado no_evidence muestra la plantilla y nunca una cifra suelta', () => {
    const stats = withGrade('no_evidence');
    const tip = tooltipFor('prevDayHigh', { stats })!;
    const line = statLine(stats.stats[0]!);
    expect(tip.stat).toBe(line);
    expect(tip.stat).not.toBe(formatPct(50.4));
    expect(tip.stat).toMatch(/No supera al azar/);
    // El aviso fijo acompaña a la cifra; sin cifra no aparece.
    expect(tip.statNote).toContain('no una predicción');
    expect(tip.noData).toBeNull();
  });

  it('un grado none dice «sin datos suficientes para medirlo» y nada más', () => {
    const stats = withGrade('none', {
      n: 0,
      rate: null,
      ci_low: null,
      ci_high: null,
      baseline: null,
      lift_pp: null,
    });
    const tip = tooltipFor('prevDayHigh', { stats })!;
    expect(tip.stat).toBe('Sin datos suficientes para medirlo (n = 0 eventos).');
    expect(tip.stat).not.toMatch(/%/);
  });
});

describe('honestidad del texto', () => {
  it('ningún camino de texto promete comprar, vender ni garantizar', () => {
    for (const entry of GLOSSARY) {
      for (const trend of TRENDS) {
        for (const tip of [tooltipFor(entry.id, { trend }), tooltipFor(entry.id, { trend, stats: FIXTURE })]) {
          const text = plain(tip!.lines.map((line) => line.text).join(' \n '));
          expect(text, entry.id).not.toMatch(/comprar|vender|garantiz/);
        }
      }
    }
  });

  it('los % de un tooltip vienen de la prosa de definición o de la línea medida', () => {
    for (const entry of GLOSSARY) {
      for (const trend of TRENDS) {
        const allowed = new Set(
          [
            entryText(entry.id, 'title'),
            entryText(entry.id, 'short'),
            entryText(entry.id, 'read'),
            trend ? entryText(entry.id, trend) : '',
          ].filter(Boolean),
        );
        const tip = tooltipFor(entry.id, { trend })!;
        for (const line of tip.lines) {
          if (!line.text.includes('%')) continue;
          if (line.id === 'stat' || line.id === 'stat-note') continue;
          const body = line.id === 'context' ? line.text.replace(/^[^—]*— /, '') : line.text;
          expect(allowed.has(body), `${entry.id} · ${line.id}: ${line.text}`).toBe(true);
        }
      }
    }
  });

  it('la línea medida repite solo las cifras del archivo', () => {
    const tip = tooltipFor('prevDayHigh', { trend: 'down', stats: FIXTURE })!;
    const statLine = tip.lines.find((line) => line.id === 'stat')!.text;
    // rate, ci_low, ci_high y baseline: cuatro porcentajes, ni uno más.
    expect(statLine.match(/%/g)).toHaveLength(4);
    for (const value of ['58,1 %', '55,2 %', '61,0 %', '50,0 %', '+8,1 pp', '1234']) {
      expect(statLine).toContain(value);
    }
  });
});

describe('detalle de Aprender', () => {
  it('trae todas las secciones con su etiqueta', () => {
    // `EMPTY_STATS` explícito: el resultado no depende de si `stats.json` existe.
    const detail = detailFor(entryById('prevDayHigh')!, { stats: EMPTY_STATS });
    expect(detail.sections.map((section) => section.id)).toEqual([
      'what',
      'read',
      'up',
      'down',
      'range',
      'watch',
    ]);
    for (const section of detail.sections) {
      expect(section.label).toBe(uiText(`section_${section.id}`));
      expect(section.text).toBe(prose[`glossary.prevDayHigh.${section.id}`]);
    }
    expect(detail.measuredLabel).toBe(uiText('measured_history'));
    expect(detail.noData).toBe('sin datos suficientes');
  });

  it('muestra la medida cuando existe', () => {
    const detail = detailFor(entryById('prevDayHigh')!, { stats: FIXTURE });
    expect(detail.stat).toContain('58,1 %');
    expect(detail.noData).toBeNull();
  });
});
