import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * `@swal/analysis-core` apunta al núcleo compartido.
 * TODO: `workers/public-site/static/analisis/analysis-core.js` se escribe en
 * paralelo y puede no existir. Si falta, el alias cae al stub para que el
 * build pase. El stub devuelve hallazgos vacíos y no inventa porcentajes.
 */
export function analysisCoreAlias(): string {
  const real = resolve(here, '../../workers/public-site/static/analisis/analysis-core.js');
  // Copia que `scripts/stage-analysis-core.mjs` mete en el zip de fuentes de AMO.
  const staged = resolve(here, 'vendor/analysis-core.js');
  const stub = resolve(here, 'src/lib/analysis-core-stub.ts');
  if (existsSync(real)) return real;
  if (existsSync(staged)) return staged;
  return stub;
}
