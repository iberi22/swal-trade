// Genera los iconos PNG de la tienda (16/32/48/128) a partir de public/icon/icon.svg,
// en un solo tono y sin assets externos. Rasteriza en local con `rsvg-convert`
// (preferido) o `magick`/`convert` (ImageMagick). No descarga nada de la red.
//
// Uso: node scripts/generate-icons.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const svgPath = resolve(here, '../public/icon/icon.svg');
const outDir = resolve(here, '../public/icon');
const sizes = [16, 32, 48, 128];

/** ¿Está el binario en el PATH? `command` es builtin, así que va por el shell. */
function hasBin(bin) {
  try {
    execFileSync('/bin/sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Devuelve una función (size, dest) que escribe el PNG. */
function pickRasterizer() {
  if (hasBin('rsvg-convert')) {
    return (size, dest) =>
      execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), svgPath, '-o', dest], {
        stdio: ['ignore', 'ignore', 'inherit'],
      });
  }
  const magick = hasBin('magick') ? 'magick' : hasBin('convert') ? 'convert' : null;
  if (magick) {
    // ImageMagick: fondo transparente, escalar al cuadrado exacto.
    return (size, dest) =>
      execFileSync(
        magick,
        ['-background', 'none', '-density', '512', svgPath, '-resize', `${size}x${size}`, dest],
        { stdio: ['ignore', 'ignore', 'inherit'] },
      );
  }
  throw new Error(
    'No hay rasterizador local. Instala rsvg-convert (librsvg) o ImageMagick (magick o convert).',
  );
}

function pngSize(dest) {
  const buf = readFileSync(dest);
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error(`No es un PNG: ${dest}`);
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

if (!existsSync(svgPath)) throw new Error(`Falta la fuente SVG: ${svgPath}`);

const rasterize = pickRasterizer();
const tool = hasBin('rsvg-convert') ? 'rsvg-convert' : hasBin('magick') ? 'magick' : 'convert';
const keep = new Set(sizes.map((size) => `${size}.png`));

for (const size of sizes) {
  const dest = resolve(outDir, `${size}.png`);
  rasterize(size, dest);
  const { width, height, bytes } = pngSize(dest);
  if (width !== size || height !== size) {
    throw new Error(`PNG ${width}x${height}, se esperaba ${size}x${size}: ${dest}`);
  }
  // Un PNG mínimo tiene >= 67 bytes; verificamos que no quede vacío.
  if (bytes < 67) throw new Error(`PNG sospechosamente pequeño (${bytes} B): ${dest}`);
  process.stdout.write(`icon ${size}x${size} -> public/icon/${size}.png (${bytes} B) [${tool}]\n`);
}

for (const name of readdirSync(outDir)) {
  if (!name.endsWith('.png') || keep.has(name)) continue;
  unlinkSync(resolve(outDir, name));
  process.stdout.write(`quito PNG fuera de la lista: public/icon/${name}\n`);
}

process.stdout.write('OK: iconos 16/32/48/128 en un solo tono desde icon.svg\n');
