import { describe, expect, it } from 'vitest';
import { entryById } from './entries';
import {
  EMPTY_STATS,
  GLOSSARY_STATS,
  STATS_SCHEMA,
  formatLift,
  formatPct,
  noStatLine,
  parseStatsFile,
  statFor,
  statLine,
  statParams,
  type GlossaryStatsFile,
} from './stats';
import { uiText } from './text';

const file = (stats: unknown[]): unknown => ({
  schema: STATS_SCHEMA,
  window_days: 90,
  pairs: ['BTCUSDT', 'ETHUSDT'],
  stats,
});

function parsed(...rows: unknown[]): GlossaryStatsFile {
  const out = parseStatsFile(file(rows));
  if (!out) throw new Error('fixture inválida');
  return out;
}

const PROMISING = {
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

/** Fila coherente: el intervalo siempre envuelve la tasa y el lift es rate − 50. */
const row = (partial: Record<string, unknown>): Record<string, unknown> => {
  const rate = typeof partial.rate === 'number' ? partial.rate : PROMISING.rate;
  return {
    type: PROMISING.type,
    id: PROMISING.id,
    rate,
    ci_low: Number((rate - 3).toFixed(1)),
    ci_high: Number((rate + 3).toFixed(1)),
    baseline: 50,
    lift_pp: Number((rate - 50).toFixed(1)),
    n: PROMISING.n,
    grade: 'promising',
    ...partial,
  };
};

const NO_EVIDENCE = row({ grade: 'no_evidence', rate: 50.4, n: 812 });
const NEGATIVE = row({ grade: 'negative', rate: 44.2, n: 640 });

describe('sin stats.json', () => {
  it('el archivo es opcional: el build carga con la lista vacía', () => {
    // Si otro proceso aún no ha publicado stats.json, GLOSSARY_STATS existe igual.
    expect(GLOSSARY_STATS.schema).toBe(STATS_SCHEMA);
    expect(Array.isArray(GLOSSARY_STATS.stats)).toBe(true);
  });

  it('sin medidas no hay cifra: statFor es null y se dice «sin datos suficientes»', () => {
    const entry = entryById('prevDayHigh');
    expect(entry).toBeDefined();
    expect(statFor(entry, undefined, EMPTY_STATS)).toBeNull();
    expect(statFor(null, undefined, EMPTY_STATS)).toBeNull();
    expect(noStatLine()).toBe('sin datos suficientes');
  });

  it('el archivo real, si existe, solo contiene filas válidas', () => {
    for (const stat of GLOSSARY_STATS.stats) {
      expect(['level', 'pattern']).toContain(stat.type);
      expect(stat.id).not.toBe('');
      expect(Number.isInteger(stat.n)).toBe(true);
      if (stat.grade !== 'none') {
        expect(stat.ci_low!).toBeLessThanOrEqual(stat.rate!);
        expect(stat.rate!).toBeLessThanOrEqual(stat.ci_high!);
      }
    }
  });
});

describe('parseStatsFile', () => {
  it('rechaza otro esquema y la basura', () => {
    expect(parseStatsFile(null)).toBeNull();
    expect(parseStatsFile({ schema: 'otro', stats: [PROMISING] })).toBeNull();
    expect(parseStatsFile({ stats: [PROMISING] })).toBeNull();
  });

  it('descarta filas mal formadas en lugar de mostrar cifras dudosas', () => {
    const out = parseStatsFile(
      file([
        PROMISING,
        { ...PROMISING, rate: 101 }, // fuera de 0-100
        { ...PROMISING, ci_low: 62 }, // rate fuera del intervalo
        { ...PROMISING, ci_low: 70, ci_high: 60 }, // intervalo invertido
        { ...PROMISING, grade: 'seguro' }, // grado inexistente
        { ...PROMISING, n: 12.5 }, // n no entero
        { ...PROMISING, type: 'nivel' }, // tipo inexistente
        { ...PROMISING, id: '' },
        'basura',
      ]),
    );
    expect(out?.stats).toHaveLength(1);
    expect(out?.stats[0]?.id).toBe('prevDayHigh');
  });

  it('acepta el grado none sin cifras (solo n)', () => {
    const out = parseStatsFile(file([{ type: 'pattern', id: 'shock', grade: 'none', n: 0 }]));
    expect(out?.stats[0]).toMatchObject({ grade: 'none', n: 0, rate: null, baseline: null });
  });
});

describe('statFor', () => {
  const stats = parsed(
    PROMISING,
    row({ direction: 'short', rate: 47.9, n: 900 }),
    row({ id: 'double_top', direction: 'short', type: 'pattern', n: 300 }),
    row({ id: 'r1', rate: 51.2, n: 410 }),
  );

  it('cruza tipo e id de la entrada', () => {
    expect(statFor(entryById('prevDayHigh'), undefined, stats)?.n).toBe(1234);
    expect(statFor(entryById('r1'), undefined, stats)?.n).toBe(410);
    expect(statFor(entryById('double_top'), undefined, stats)?.n).toBe(300);
  });

  it('el lado pedido manda y cae a la fila sin dirección', () => {
    expect(statFor(entryById('prevDayHigh'), 'short', stats)?.rate).toBe(47.9);
    expect(statFor(entryById('prevDayHigh'), 'long', stats)?.rate).toBe(58.1);
    expect(statFor(entryById('r1'), 'short', stats)?.n).toBe(410); // sin fila short: usa la neutra
  });

  it('devuelve null si la entrada no tiene medida o no es del glosario', () => {
    expect(statFor(entryById('atr'), undefined, stats)).toBeNull(); // sin statRef
    expect(statFor(entryById('dayOpen'), undefined, stats)).toBeNull(); // no está en el archivo
    expect(statFor(undefined, undefined, stats)).toBeNull();
  });
});

describe('cifras formateadas', () => {
  it('porcentajes y puntos con coma decimal', () => {
    expect(formatPct(58.1)).toBe('58,1 %');
    expect(formatPct(50)).toBe('50,0 %');
    expect(formatPct(null)).toBe('—');
    expect(formatLift(8.1)).toBe('+8,1 pp');
    expect(formatLift(-2)).toBe('−2,0 pp');
    expect(formatLift(0)).toBe('0,0 pp');
    expect(formatLift(null)).toBe('—');
  });

  it('statLine usa la plantilla de cada grado', () => {
    const promising = parsed(PROMISING).stats[0]!;
    const noEvidence = parsed(NO_EVIDENCE).stats[0]!;
    const negative = parsed(NEGATIVE).stats[0]!;
    const none = parsed({ type: 'pattern', id: 'shock', grade: 'none', n: 0 }).stats[0]!;

    expect(statLine(promising)).toContain('58,1 %');
    expect(statLine(promising)).toContain('55,2 % a 61,0 %');
    expect(statLine(promising)).toContain('50,0 %');
    expect(statLine(promising)).toContain('+8,1 pp');
    expect(statLine(promising)).toContain('n = 1234 eventos');
    expect(statLine(promising)).toContain('Falta validarlo.');

    expect(statLine(noEvidence)).toContain('50,4 %');
    expect(statLine(noEvidence)).toContain('No supera al azar');
    expect(statLine(negative)).toContain('44,2 %');
    expect(statLine(negative)).toContain('por debajo de');
    expect(statLine(none)).toBe('Sin datos suficientes para medirlo (n = 0 eventos).');

    const texts = new Set([
      statLine(promising),
      statLine(noEvidence),
      statLine(negative),
      statLine(none),
    ]);
    expect(texts.size).toBe(4);
  });

  it('el grado no_evidence usa su plantilla completa, nunca una cifra suelta', () => {
    const stat = parsed(NO_EVIDENCE).stats[0]!;
    const line = statLine(stat);
    // La cifra está, pero jamás sola: sin plantilla no hay «no evidence».
    expect(line).not.toBe(formatPct(stat.rate));
    expect(line).not.toMatch(/^\s*[\d.,]+\s*%\s*$/);
    expect(line).toContain(uiText('measured_history'));
    expect(line).toContain(formatPct(stat.rate));
    expect(line).toContain(`${formatPct(stat.ci_low)} a ${formatPct(stat.ci_high)}`);
    expect(line).toContain(formatPct(stat.baseline));
    expect(line).toContain(`n = ${stat.n} eventos`);
    expect(line).toContain('No supera al azar');
    // Y no se confunde con las otras tres plantillas.
    expect(line).not.toBe(statLine(parsed(PROMISING).stats[0]!));
    expect(line).not.toBe(statLine(parsed(NEGATIVE).stats[0]!));
  });

  it('statParams solo formatea, no calcula', () => {
    const stat = parsed(PROMISING).stats[0]!;
    expect(statParams(stat)).toEqual({
      rate: '58,1 %',
      low: '55,2 %',
      high: '61,0 %',
      baseline: '50,0 %',
      lift: '+8,1 pp',
      n: '1234',
    });
  });
});
