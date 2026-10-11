import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('analisis.js renderFindings adds keyboard accessibility attributes and events', () => {
  const code = readFileSync(new URL('../static/analisis/analisis.js', import.meta.url), 'utf8');

  // Find the body of renderFindings
  const renderFindingsMatch = code.match(/function renderFindings\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(renderFindingsMatch, 'renderFindings function should exist');
  const body = renderFindingsMatch[1];

  // Assert tabIndex
  assert.ok(body.includes('tabIndex = 0'), 'renderFindings should set tabIndex = 0');

  // Assert role
  assert.ok(body.includes("setAttribute('role', 'button')") || body.includes('role = \'button\'') || body.includes('role="button"'), 'renderFindings should set role button');

  // Assert aria-pressed
  assert.ok(body.includes('aria-pressed'), 'renderFindings should set aria-pressed');
  assert.ok(body.includes('true') && body.includes('false'), 'renderFindings should set aria-pressed to true or false depending on selection');

  // Assert keydown
  assert.ok(body.includes("addEventListener('keydown'"), 'renderFindings should add keydown event listener');

  // Assert Enter key
  assert.ok(body.includes("'Enter'") || body.includes('"Enter"'), 'renderFindings keydown should handle Enter key');

  // Assert Space key
  assert.ok(body.includes("' '") || body.includes('" "'), 'renderFindings keydown should handle Space key');

  // Assert preventDefault for Space
  assert.ok(body.includes('preventDefault()'), 'renderFindings keydown should call preventDefault for Space key');

  // Assert focusFinding is called
  assert.ok(body.includes('focusFinding(f)'), 'renderFindings keydown should call focusFinding');
});
