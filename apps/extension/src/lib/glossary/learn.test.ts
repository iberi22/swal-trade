import { describe, expect, it } from 'vitest';
import { GLOSSARY, entryById } from './entries';
import { CATEGORY_ORDER, learnCategories, learnEntries } from './learn';

describe('learnEntries', () => {
  it('sin consulta lista todo el glosario', () => {
    expect(learnEntries()).toHaveLength(GLOSSARY.length);
    expect(learnEntries('   ')).toHaveLength(GLOSSARY.length);
  });

  it('busca por alias, id, título y definición sin tildes ni mayúsculas', () => {
    expect(learnEntries('R1').map((entry) => entry.id)).toContain('r1');
    expect(learnEntries('pdh').map((entry) => entry.id)).toEqual(['prevDayHigh']);
    expect(learnEntries('MAXIMO DE AYER').map((entry) => entry.id)).toEqual(['prevDayHigh']);
    expect(learnEntries('funding').map((entry) => entry.id)).toContain('funding');
    expect(learnEntries('doble techo').map((entry) => entry.id)).toContain('double_top');
    expect(learnEntries('resistencia 1 del pivote').map((entry) => entry.id)).toEqual(['r1']);
    expect(learnEntries('zzzz')).toEqual([]);
  });

  it('filtra por categoría y combina con la búsqueda', () => {
    const niveles = learnEntries('', 'niveles');
    expect(niveles.length).toBeGreaterThan(0);
    for (const entry of niveles) expect(entry.category).toBe('niveles');
    expect(learnEntries('r1', 'niveles').map((entry) => entry.id)).toContain('r1');
    expect(learnEntries('r1', 'patrones')).toEqual([]);
    expect(learnEntries('rsi', 'patrones').map((entry) => entry.id)).toContain('rsi');
  });

  it('todas las entradas encontradas existen en el glosario', () => {
    for (const entry of learnEntries('a')) expect(entryById(entry.id)).toBeDefined();
  });
});

describe('learnCategories', () => {
  it('orden estable y sin categorías vacías', () => {
    const categories = learnCategories();
    expect(categories).toEqual(CATEGORY_ORDER.filter((category) => categories.includes(category)));
    for (const category of categories) {
      expect(learnEntries('', category).length).toBeGreaterThan(0);
    }
  });
});
