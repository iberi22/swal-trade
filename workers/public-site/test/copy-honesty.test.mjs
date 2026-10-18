import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'static');

// List of allowed paths for the hit rate rule
const ALLOWED_RATE_PAGES = [
  // Operativa page shows the lab's own paper results with sample size, allowed by policy
  'operativa/index.html'
];

// Any existing violations are logged here, we do not edit HTML in this task
const KNOWN_VIOLATIONS = [];

function walkHtmlFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'vendor') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...walkHtmlFiles(p));
    } else if (name.endsWith('.html')) {
      out.push(p);
    }
  }
  return out;
}

const rel = (p) => p.slice(STATIC.length + 1);

function stripTagsAndExtractText(html) {
  // Extract meta description and og:description first before stripping tags
  let extraText = '';
  const descMatch = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
  if (descMatch) extraText += descMatch[1] + ' ';

  const ogDescMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]*)"/i);
  if (ogDescMatch) extraText += ogDescMatch[1] + ' ';

  // Remove scripts and styles entirely
  let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ');
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');

  // Replace tags with spaces
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode common HTML entities
  text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

  return (extraText + text).replace(/\s+/g, ' ').trim();
}

function splitIntoSentences(text) {
  // Simple heuristic for Spanish/English sentence splitting
  return text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 0);
}

// Allowed negations for the first rule
const NEGATIONS = /no |nunca|ni |never|not |sin evidencia|ninguna|does not/i;

// Forbidden phrases for the first rule
const FORBIDDEN_PROMISES = /garantiz|guarantee|asegurad[ao]s? (ganancias|rentabilidad)|risk[- ]free|sin riesgo|ganancias (seguras|aseguradas)|\d+ ?% (de )?(acierto|win rate)|pasive income|ingresos pasivos|get rich|hazte rico/i;

function hasUnmitigatedForbiddenPromise(sentence) {
  if (FORBIDDEN_PROMISES.test(sentence)) {
    if (!NEGATIONS.test(sentence)) {
      return true;
    }
  }
  return false;
}

describe('Linter Self-Tests', () => {
  it('detects unmitigated forbidden promises (violating)', () => {
    assert.strictEqual(hasUnmitigatedForbiddenPromise('Ofrecemos un 95% de acierto en las señales.'), true);
    assert.strictEqual(hasUnmitigatedForbiddenPromise('Es una inversión risk-free.'), true);
    assert.strictEqual(hasUnmitigatedForbiddenPromise('Ganancias aseguradas para tu portafolio.'), true);
  });

  it('allows forbidden words if accompanied by a negation (compliant)', () => {
    assert.strictEqual(hasUnmitigatedForbiddenPromise('No ofrecemos un 95% de acierto.'), false);
    assert.strictEqual(hasUnmitigatedForbiddenPromise('Nunca garantizamos rentabilidad o que sea risk-free.'), false);
    assert.strictEqual(hasUnmitigatedForbiddenPromise('El sistema opera sin evidencia de ser un ingreso pasivo asegurado.'), false);
  });
});

describe('Honesty Lint on Public HTML Pages', () => {
  const files = walkHtmlFiles(STATIC);

  it('no public text promises profitability without a negation', () => {
    let violations = [];
    for (const file of files) {
      const relativePath = rel(file);
      const html = readFileSync(file, 'utf8');
      const text = stripTagsAndExtractText(html);
      const sentences = splitIntoSentences(text);

      for (const sentence of sentences) {
        if (hasUnmitigatedForbiddenPromise(sentence)) {
          // Exclude known violations if needed, though they shouldn't occur
          violations.push(`File: ${relativePath} | Sentence: "${sentence}"`);
        }
      }
    }

    // Log known violations, but fail on new ones
    if (violations.length > 0) {
      console.log('VIOLATIONS FOUND:', violations);
    }

    // As per task instructions, if there are real violations, we add them to KNOWN_VIOLATIONS and PR body.
    // We will assert true here, but we will print them. Actually, wait. We should fail the test if there are new violations.
    // Let's filter out known violations first.
    const newViolations = violations.filter(v => !KNOWN_VIOLATIONS.includes(v));
    assert.strictEqual(newViolations.length, 0, 'Found unmitigated forbidden promises:\n' + newViolations.join('\n'));
  });

  it('requires sample size for "win rate" or "acierto"', () => {
    let violations = [];
    for (const file of files) {
      const relativePath = rel(file);
      if (ALLOWED_RATE_PAGES.includes(relativePath)) continue;

      const html = readFileSync(file, 'utf8');
      const text = stripTagsAndExtractText(html);

      if (/(win\s?rate|acierto)/i.test(text)) {
        if (!/\b(n|muestra|sample)\b/i.test(text)) {
          violations.push(`File: ${relativePath} | Missing sample size for win rate / acierto claim`);
        }
      }
    }
    const newViolations = violations.filter(v => !KNOWN_VIOLATIONS.includes(v));
    assert.strictEqual(newViolations.length, 0, 'Found missing sample size:\n' + newViolations.join('\n'));
  });

  it('requires "no es una probabilidad" for "fuerza del patrón"', () => {
    let violations = [];
    for (const file of files) {
      const relativePath = rel(file);
      const html = readFileSync(file, 'utf8');
      const text = stripTagsAndExtractText(html);

      if (/fuerza del patr[oó]n/i.test(text)) {
        if (!/(no es una probabilidad|not a probability)/i.test(text)) {
          violations.push(`File: ${relativePath} | Missing "no es una probabilidad" for "fuerza del patrón"`);
        }
      }
    }
    const newViolations = violations.filter(v => !KNOWN_VIOLATIONS.includes(v));
    assert.strictEqual(newViolations.length, 0, 'Found missing probability disclaimer:\n' + newViolations.join('\n'));
  });
});
