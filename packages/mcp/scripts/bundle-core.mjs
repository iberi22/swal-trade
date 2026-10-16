// Copia el núcleo de análisis y la licencia dentro del paquete antes de `npm pack`/`npm publish`.
// Un paquete instalado no tiene el repositorio alrededor: sin esto, analyze_chart respondería
// "analysis core not available". El fichero fuente sigue siendo el del repo (única fuente de verdad).
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(pkg, '..', '..');

mkdirSync(join(pkg, 'core'), { recursive: true });
copyFileSync(join(repo, 'workers/public-site/static/analisis/analysis-core.js'), join(pkg, 'core/analysis-core.js'));
copyFileSync(join(repo, 'LICENSE'), join(pkg, 'LICENSE'));
console.log('bundle-core: core/analysis-core.js y LICENSE copiados');
