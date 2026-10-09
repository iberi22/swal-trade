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
  const stub = resolve(here, 'src/lib/analysis-core-stub.ts');
  return existsSync(real) ? real : stub;
}
