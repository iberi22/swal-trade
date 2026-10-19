import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// El escaner lee solo datos publicos: ningun modulo bajo src/lib/scanner/ puede
// importar la cuenta (src/lib/account) ni la IA (src/lib/ai), ni usar el
// enrutador acct:/ai:. Recorre los archivos que existan al correr la prueba.
const ROOT = new URL('.', import.meta.url).pathname;
const SELF = 'scanner-privacy.test.ts';

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.(ts|svelte|js|mjs)$/.test(name) && name !== SELF) out.push(full);
  }
  return out;
}

describe('scanner privacy', () => {
  it('scanner modules never import account or ai and never use the acct:/ai: router', () => {
    for (const file of sources(ROOT)) {
      const text = readFileSync(file, 'utf8');
      const imports = [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const spec of imports) {
        expect(spec, `${file} -> ${spec}`).not.toMatch(/(^|\/)(account|ai)(\/|$)/);
      }
      expect(text, file).not.toMatch(/['"`](acct|ai):/);
    }
  });
});
