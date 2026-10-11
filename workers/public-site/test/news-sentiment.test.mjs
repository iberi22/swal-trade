import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreSentiment } from '../src/news.js';

test('sentiment with negation flips correctly', () => {
  // 'Bitcoin rally and breakout' → positivo, 1
  const t1 = scoreSentiment('Bitcoin rally and breakout');
  assert.equal(t1.label, 'positivo');
  assert.equal(t1.score, 1);

  // 'Bitcoin fails to rally' → negativo
  const t2 = scoreSentiment('Bitcoin fails to rally');
  assert.equal(t2.label, 'negativo');
  assert.ok(t2.score < 0);

  // 'ETH sin caída tras el dato' → not negativo
  const t3 = scoreSentiment('ETH sin caída tras el dato');
  assert.notEqual(t3.label, 'negativo');

  // 'not a crash, but no rally either' → neutral, 0
  const t4 = scoreSentiment('not a crash, but no rally either');
  assert.equal(t4.label, 'neutral');
  assert.equal(t4.score, 0);

  // a negator 3+ words before the term does NOT flip it
  // 1 word before: "no rally" (0 intervening) -> flips
  // 2 words before: "no good rally" (1 intervening) -> flips
  // 3 words before: "no very good rally" (2 intervening) -> does NOT flip
  const t5 = scoreSentiment('no very good rally');
  assert.equal(t5.label, 'positivo');

  // empty string → neutral, 0
  const t8 = scoreSentiment('');
  assert.equal(t8.label, 'neutral');
  assert.equal(t8.score, 0);
});
