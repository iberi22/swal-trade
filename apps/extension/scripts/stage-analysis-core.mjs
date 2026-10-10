// Copia el núcleo de análisis al árbol de la extensión antes de `wxt zip`.
// El zip de fuentes de Firefox (AMO) solo contiene apps/extension. Sin esta
// copia, quien reconstruya ese zip caería al stub y el paquete no coincidiría
// con el que se sube. No es una segunda fuente de verdad: si el archivo del
// sitio existe, se sobrescribe. `vendor/` está en .gitignore.
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../../../workers/public-site/static/analisis/analysis-core.js');
const dest = resolve(here, '../vendor/analysis-core.js');

if (!existsSync(source)) {
  if (existsSync(dest) && statSync(dest).size > 0) {
    process.stdout.write('analysis-core ya está en vendor/; no hay copia del sitio\n');
    process.exit(0);
  }
  throw new Error(`No está el núcleo ni una copia previa: ${source}`);
}

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(source, dest);
process.stdout.write(`analysis-core staged -> vendor/analysis-core.js (${statSync(dest).size} B)\n`);
