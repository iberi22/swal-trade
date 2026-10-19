// Garantías verificables de la lectura de página: los módulos de
// `page-account` solo leen el DOM, no escriben en él, no pulsan nada y no
// hablan por la red. Se comprueban sobre el código fuente para que la promesa
// del aviso («no pulsa nada y no sale de tu navegador») no dependa de la memoria
// de quien lo escribió.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const contentScript = path.join(dir, '..', '..', 'entrypoints', 'content.ts');

function sourceFiles(): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'fixtures.ts')
    .map((name) => path.join(dir, name));
}

const WRITE_APIS = [
  '.click(',
  'dispatchEvent',
  'innerHTML',
  'outerHTML',
  '.setAttribute(',
  'insertAdjacentHTML',
  'appendChild',
  'removeChild',
  'execCommand',
  'document.write',
  'XMLHttpRequest',
  'WebSocket',
  'fetch(',
];

describe('page-account no escribe en la página ni sale a la red', () => {
  it('ningún módulo usa APIs de escritura ni de red', () => {
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8');
      for (const api of WRITE_APIS) {
        expect(text.includes(api), `${path.basename(file)} usa ${api}`).toBe(false);
      }
    }
  });

  it('el content script no lee valores de inputs en su parte de página', () => {
    const text = readFileSync(contentScript, 'utf8');
    const start = text.indexOf('// --- Lectura de la página');
    const end = text.indexOf('// Lectura de los dibujos de posición del usuario');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = text.slice(start, end);
    expect(block).toContain('readPageAccount');
    expect(block).toContain('MutationObserver');
    // Ni clics ni escrituras: solo mirar el texto que ya se ve.
    for (const api of ['.click(', 'dispatchEvent', '.value', 'innerHTML', 'setAttribute']) {
      expect(block.includes(api), `el bloque de lectura usa ${api}`).toBe(false);
    }
  });

  it('el content script solo manda avisos y el diagnóstico anonimizado', () => {
    const text = readFileSync(contentScript, 'utf8');
    expect(text).toContain('PAGE_ACCOUNT_UPDATE');
    expect(text).toContain('PAGE_ACCOUNT_DIAGNOSE_RESULT');
    // El árbol crudo nunca viaja: se anonimiza justo antes de responder.
    expect(text).toContain('treeToCompactText(anonymizeTree(tree))');
  });
});
