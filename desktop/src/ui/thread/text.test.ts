// node --test desktop/src/ui/thread/text.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerMessage, choices, dropMarker, insertMarker, splitMarkers } from './text.ts';

test('an ask offers its options, else its reply', () => {
  assert.deepEqual(choices({ options: ['Yes', 'No'], reply: 'done' }), ['Yes', 'No']);
  assert.deepEqual(choices({ reply: ' done ' }), ['done']);
  assert.deepEqual(choices({}), []);
});

test('answers are numbered when the card had several asks', () => {
  assert.equal(answerMessage(1, [{ index: 0, action: 'Ship it?', answer: 'Yes' }], ''), 'Ship it?\nYes');
  assert.equal(
    answerMessage(3, [{ index: 0, action: 'A?', answer: 'one' }, { index: 2, action: 'C?', answer: 'x\ny' }], 'Also this.'),
    '1. A?\n   one\n\n3. C?\n   x\n   y\n\nAlso this.',
  );
});

test('a marker goes in at the caret with spaces round it', () => {
  assert.deepEqual(insertMarker('', 0, 0, 1), { text: '[Picture 1] ', caret: 12 });
  assert.deepEqual(insertMarker('look at', 7, 7, 1), { text: 'look at [Picture 1] ', caret: 20 });
  assert.deepEqual(insertMarker('a b', 1, 1, 2), { text: 'a [Picture 2] b', caret: 13 });
  assert.deepEqual(insertMarker('abc', 1, 2, 1), { text: 'a [Picture 1] c', caret: 14 });
});

test('dropping a picture renumbers the later ones', () => {
  assert.equal(dropMarker('this [Picture 1] like [Picture 2] and [Picture 3]', 2), 'this [Picture 1] like and [Picture 2]');
  assert.equal(dropMarker('[Picture 1] only', 1), 'only');
  assert.equal(dropMarker('same [Picture 1]', 1), 'same');
  assert.equal(dropMarker('keep  two  spaces', 1), 'keep  two  spaces');
});

test('a message splits into words and picture numbers', () => {
  assert.deepEqual(splitMarkers('see [Picture 2] and [Picture 1]!'), ['see ', 2, ' and ', 1, '!']);
  assert.deepEqual(splitMarkers('[Picture 0] is not one'), ['[Picture 0] is not one']);
});
