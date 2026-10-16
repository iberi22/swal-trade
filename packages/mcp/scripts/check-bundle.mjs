// Gancho prepack: aborta si el tarball saldría sin el núcleo de análisis o sin la licencia.
// Con ignore-scripts=true npm no lo ejecuta; entonces la protección es `npm run build`
// (que ya copia ambos ficheros) y scripts/verify-pack.mjs antes de publicar.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const f of ['core/analysis-core.js', 'LICENSE', 'dist/index.js']) {
  if (!existsSync(join(pkg, f))) {
    console.error(`prepack: falta ${f}. Ejecuta "npm run build" antes de empaquetar.`);
    process.exit(1);
  }
}
