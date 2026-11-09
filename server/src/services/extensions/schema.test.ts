import { expect, it } from 'vitest';
import { checked, manifestSchema } from './schema.ts';

// The extension card template has two quick-action slots and reserves the
// "status" action for the Info tab. Publishers rely on these rules.

const manifest = (actions: object[]) => ({
  id: 'example',
  name: 'Example',
  version: '1.0.0',
  apiVersion: '0.5',
  entrypoint: 'adapter.js',
  sha256: '1'.repeat(64),
  maintainer: 'Example',
  issueTracker: 'https://example.org/issues',
  actions,
});
const act = (id: string, extra: object = {}) => ({ id, label: id, ...extra });
const parse = (actions: object[]) =>
  checked(
    manifestSchema,
    manifest(actions),
    "This extension's manifest is invalid.",
  );

it('accepts zero, one or two quick actions, and none is the default', () => {
  expect(parse([act('a')]).actions[0]!.quick).toBe(false);
  expect(() => parse([act('a', { quick: true })])).not.toThrow();
  expect(() =>
    parse([act('a', { quick: true }), act('b', { quick: true }), act('c')]),
  ).not.toThrow();
});

it('refuses a third quick action and tells the publisher why', () => {
  expect(() =>
    parse([
      act('a', { quick: true }),
      act('b', { quick: true }),
      act('c', { quick: true }),
    ]),
  ).toThrow(/manifest is invalid\. A card has room for 2 quick actions/);
});

it('keeps "status" for the Info tab: never quick, never asking for inputs', () => {
  expect(() => parse([act('status')])).not.toThrow();
  expect(() => parse([act('status', { quick: true })])).toThrow(
    /runs when the Info tab opens/,
  );
  expect(() =>
    parse([
      act('status', {
        inputs: [{ key: 'title', label: 'Title', type: 'text' }],
      }),
    ]),
  ).toThrow(/runs when the Info tab opens/);
});
