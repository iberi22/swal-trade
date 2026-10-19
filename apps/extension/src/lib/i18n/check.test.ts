import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCatalogs, placeholders } from './check';
import { LOCALES } from './locales';

const codes = ['es', 'en'];
const es = { a: 'Hola {name}', b: 'x' };

describe('checkCatalogs', () => {
  it('ok cuando coincide', () => {
    expect(checkCatalogs(codes, { es, en: { a: 'Hi {name}', b: 'y' } }).ok).toBe(true);
  });
  it('detecta faltantes, sobrantes, placeholders, vacíos y HTML', () => {
    const r = checkCatalogs(codes, { es, en: { a: 'Hi {who}', c: '<b>', b: ' ' } });
    expect(r.ok).toBe(false);
    const en = r.reports.find((x) => x.code === 'en')!;
    expect(en.extra).toEqual(['c']);
    expect(en.placeholderMismatch).toEqual(['a']);
    expect(en.empty).toEqual(['b']);
    expect(en.html).toEqual(['c']);
  });
  it('allowMissing solo avisa de faltantes', () => {
    const files = { es, en: { a: 'Hi {name}' } };
    expect(checkCatalogs(codes, files).ok).toBe(false);
    const r = checkCatalogs(codes, files, 'es', { allowMissing: true });
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(1);
  });
  it('allowMissing sigue fallando por sobrantes y placeholders', () => {
    expect(checkCatalogs(codes, { es, en: { a: 'x', b: 'y' } }, 'es', { allowMissing: true }).ok).toBe(false);
    expect(checkCatalogs(codes, { es, en: { a: 'Hi {name}', z: 'y' } }, 'es', { allowMissing: true }).ok).toBe(false);
  });
  it('archivo ausente o no plano', () => {
    expect(checkCatalogs(codes, { es }).ok).toBe(false);
    expect(checkCatalogs(codes, { es, en: { a: 1 } }).ok).toBe(false);
    expect(checkCatalogs(codes, { es, en: ['x'] }).ok).toBe(false);
  });
  it('placeholders', () => {
    expect(placeholders('{b} {a} {b}')).toEqual(['a', 'b']);
  });
});

describe('archivos reales de src/locales', () => {
  it('pasan el verificador', () => {
    const dir = join(__dirname, '../../locales');
    const files: Record<string, unknown> = {};
    for (const l of LOCALES) files[l.code] = JSON.parse(readFileSync(join(dir, `${l.code}.json`), 'utf8'));
    const r = checkCatalogs(
      LOCALES.map((l) => l.code),
      files,
    );
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
