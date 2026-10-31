import { expect, it } from 'vitest';
import { fixPgsOcrText } from './PgsOcrText.ts';

it.each([
  [
    '| think there must be\nsomething wrong with me, Linus.',
    'I think there must be\nsomething wrong with me, Linus.',
  ],
  [
    "Christmas is coming, but I'm not happy.\n| don't feel the way I'm supposed to feel.",
    "Christmas is coming, but I'm not happy.\nI don't feel the way I'm supposed to feel.",
  ],
  ["|'m sure |t is.", "I'm sure It is."],
])(
  'repairs the observed English capital-I OCR error: %s',
  (input, expected) => {
    expect(fixPgsOcrText(input, 'eng')).toBe(expected);
  },
);

it('limits the English correction to an English-only OCR job', () => {
  expect(fixPgsOcrText('| think', 'deu')).toBe('| think');
  expect(fixPgsOcrText('| think', 'eng+deu')).toBe('| think');
});
