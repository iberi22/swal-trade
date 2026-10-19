import { describe, expect, it } from 'vitest';
import { loadCatalog } from './catalog';
import { LOCALES, type LocaleCode } from './locales';

describe('loadCatalog', () => {
  it('carga el pedido más en y es', async () => {
    const out = await loadCatalog('ja');
    expect(Object.keys(out).sort()).toEqual(['en', 'es', 'ja']);
    expect(out.es!['settings.language.title']).toBe('Idioma');
    expect(out.en!['settings.language.title']).toBe('Language');
  });
  it('los 20 cargan con contenido', async () => {
    for (const l of LOCALES) {
      const out = await loadCatalog(l.code);
      expect(out[l.code]!['app.name']).toBe('SWAL Trade');
    }
  });
  it('nunca rechaza, ni con un código raro', async () => {
    await expect(loadCatalog('zz' as LocaleCode)).resolves.toBeTypeOf('object');
  });
});
