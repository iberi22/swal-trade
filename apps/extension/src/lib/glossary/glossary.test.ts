import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analysisCoreAlias } from '../../../analysis-alias';
import { GLOSSARY, PROSE_FIELDS, entryById, entryForText, normalizeTerm, termsInText } from './entries';

const read = (url: URL) => readFileSync(fileURLToPath(url), 'utf8');
const messages = JSON.parse(read(new URL('./glossary.es.json', import.meta.url))) as Record<string, string>;
const levelsSource = read(new URL('../context/levels.ts', import.meta.url));

/** LevelKind leído del código fuente de levels.ts (el tipo no existe en tiempo de ejecución). */
function levelKinds(): string[] {
  const block = /export const LEVEL_KINDS = \[([\s\S]*?)\] as const;/.exec(levelsSource)?.[1] ?? '';
  return [...block.matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1] as string);
}

/** Todos los `kind` que el núcleo de análisis puede emitir (literales del código). */
function coreKinds(): string[] {
  const path = analysisCoreAlias();
  if (!path.endsWith('.js')) return [];
  const source = readFileSync(path, 'utf8');
  const kinds = new Set<string>();
  for (const line of source.split('\n')) {
    if (!/\bkind\b/.test(line) || /^\s*\/\//.test(line)) continue;
    for (const m of line.matchAll(/'([a-z]+(?:_[a-z]+)+|pivot|shock|absorption|climax)'/g)) kinds.add(m[1] as string);
  }
  const chart = /CHART_KINDS = new Set\(\[([^\]]+)\]\)/.exec(source)?.[1] ?? '';
  for (const m of chart.matchAll(/'([a-z_]+)'/g)) kinds.add(m[1] as string);
  return [...kinds];
}

describe('glossary entries', () => {
  it('ids are unique and non empty', () => {
    const ids = GLOSSARY.map((entry) => entry.id);
    expect(ids.every((id) => /^[A-Za-z0-9_]+$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every alias is non empty and unique across entries', () => {
    const seen = new Map<string, string>();
    for (const entry of GLOSSARY) {
      expect(entry.aliases.length, entry.id).toBeGreaterThan(0);
      for (const alias of entry.aliases) {
        const key = normalizeTerm(alias);
        expect(key, `${entry.id}: alias vacío`).not.toBe('');
        const owner = seen.get(key);
        expect(owner === undefined || owner === entry.id, `alias "${alias}" repetido en ${owner} y ${entry.id}`).toBe(true);
        seen.set(key, entry.id);
      }
    }
  });

  it('every related id exists and is not the entry itself', () => {
    for (const entry of GLOSSARY) {
      for (const related of entry.related) {
        expect(entryById(related), `${entry.id} -> ${related}`).toBeDefined();
        expect(related).not.toBe(entry.id);
      }
    }
  });

  it('every entry has all prose keys in glossary.es.json', () => {
    for (const entry of GLOSSARY) {
      for (const field of PROSE_FIELDS) {
        const value = messages[`glossary.${entry.id}.${field}`];
        expect(typeof value === 'string' && value.trim() !== '', `glossary.${entry.id}.${field}`).toBe(true);
      }
    }
  });

  it('has a label for each category', () => {
    for (const category of new Set(GLOSSARY.map((entry) => entry.category))) {
      expect(messages[`glossary.category.${category}`], category).toBeTruthy();
    }
  });

  it('level statRefs use real LevelKind ids and every LevelKind has an entry', () => {
    const kinds = levelKinds();
    expect(kinds.length).toBeGreaterThanOrEqual(18);
    for (const entry of GLOSSARY) {
      if (entry.statRef?.type === 'level') expect(kinds, entry.id).toContain(entry.statRef.id);
    }
    for (const kind of kinds) {
      const has = GLOSSARY.some((entry) => entry.statRef?.type === 'level' && entry.statRef.id === kind);
      expect(has, `LevelKind sin entrada: ${kind}`).toBe(true);
    }
  });

  it('every kind the analysis core can emit has a pattern entry', () => {
    const kinds = coreKinds();
    if (kinds.length === 0) return; // el alias cayó al stub: no hay núcleo que leer
    expect(kinds.length).toBeGreaterThan(30);
    const have = new Set(GLOSSARY.filter((e) => e.statRef?.type === 'pattern').map((e) => e.statRef?.id));
    for (const kind of kinds) expect(have.has(kind), `kind sin entrada: ${kind}`).toBe(true);
  });

  it('pattern statRef ids exist in the analysis core', () => {
    const kinds = new Set(coreKinds());
    if (kinds.size === 0) return;
    for (const entry of GLOSSARY) {
      if (entry.statRef?.type === 'pattern') expect(kinds.has(entry.statRef.id), entry.id).toBe(true);
    }
  });
});

describe('glossary prose: no afirma frecuencias ni velocidades no medidas', () => {
  /** Sin tildes y en minusculas, como el resto de comprobaciones. */
  const plain = (text: string): string =>
    text
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase();

  /**
   * Frases que dan por hecho la frecuencia o la rapidez del precio
   * (`con frecuencia`, `rara vez`, `suele rellenarse rápido`...) sin una
   * medición detras. La prosa debe atribuirlo a lo que los traders esperan o
   * decir que no está medido.
   */
  const UNMEASURED: ReadonlyArray<{ re: RegExp; label: string }> = [
    { re: /\brara vez\b/, label: 'rara vez' },
    { re: /\bpoco frecuente/, label: 'poco frecuente' },
    { re: /\bcon frecuencia\b/, label: 'con frecuencia' },
    { re: /\bhabitual/, label: 'habitual*' },
    { re: /\ba menudo\b/, label: 'a menudo' },
    { re: /\bfrecuente/, label: 'frecuente*' },
    { re: /\bvarias veces\b/, label: 'varias veces' },
    { re: /\bmuchas veces\b/, label: 'muchas veces' },
    { re: /\bnormalmente\b/, label: 'normalmente' },
    { re: /\btiende a\b/, label: 'tiende a' },
    { re: /\bsuele rellenarse\b/, label: 'suele rellenarse' },
    { re: /\bsuele perder vigencia\b/, label: 'suele perder vigencia' },
    { re: /\bsuelen llenarse\b/, label: 'suelen llenarse' },
    { re: /\bse repiten\b/, label: 'se repiten' },
    { re: /\bcon rapidez\b/, label: 'con rapidez' },
  ];

  it('ninguna frase de prosa presenta frecuencia o rapidez del precio como hecho', () => {
    const offenders: string[] = [];
    for (const entry of GLOSSARY) {
      for (const field of PROSE_FIELDS) {
        const text = plain(messages[`glossary.${entry.id}.${field}`] ?? '');
        for (const { re, label } of UNMEASURED) {
          if (re.test(text)) offenders.push(`${entry.id}.${field}: "${label}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('entryForText', () => {
  it('matches ignoring case, accents and surrounding punctuation', () => {
    expect(entryForText('PDH')?.id).toBe('prevDayHigh');
    expect(entryForText('  pdh. ')?.id).toBe('prevDayHigh');
    expect(entryForText('apertura dia')?.id).toBe('dayOpen');
    expect(entryForText('EMA50 4h')?.id).toBe('ema50_4h');
    expect(entryForText('Order block bajista')?.id).toBe('order_block_bearish');
    expect(entryForText('Barrido de liquidez')?.id).toBe('liquidity_sweep');
    expect(entryForText('Funding 8h')?.id).toBe('funding');
    expect(entryForText('nada que ver')).toBeUndefined();
    expect(entryForText('')).toBeUndefined();
  });
});

describe('termsInText', () => {
  it('finds merged level labels with offsets', () => {
    const text = 'PDH + R1 + EMA50 4h';
    const found = termsInText(text);
    expect(found.map((m) => m.id)).toEqual(['prevDayHigh', 'r1', 'ema50_4h']);
    for (const m of found) expect(text.slice(m.start, m.end)).toBe(m.text);
  });

  it('prefers the longest alias and never overlaps', () => {
    const found = termsInText('Order block bajista cerca del barrido de liquidez bajista');
    expect(found.map((m) => m.id)).toEqual(['order_block_bearish', 'liquidity_sweep_bearish']);
    for (let i = 1; i < found.length; i += 1) expect((found[i] as { start: number }).start).toBeGreaterThanOrEqual((found[i - 1] as { end: number }).end);
  });

  it('respects word boundaries and accents', () => {
    expect(termsInText('R10 y S12')).toEqual([]);
    const found = termsInText('Apertura día y funding');
    expect(found.map((m) => m.id)).toEqual(['dayOpen', 'funding']);
    expect(found[0]).toMatchObject({ start: 0, end: 12, text: 'Apertura día' });
  });

  it('returns nothing for empty text', () => {
    expect(termsInText('')).toEqual([]);
  });
});
