import { expect, it, vi } from 'vitest';
import { manifestSchema } from '../extensions/schema.ts';
import type { SimilarityProvider } from './contracts.ts';

const current = vi.hoisted(() => ({ providers: [] as SimilarityProvider[] }));
vi.mock('../extensions/similarity.ts', () => ({
  extensionSimilarityProviders: async () => current.providers,
}));

const { capabilityTable, readyProvider, CapabilityUnavailableError } =
  await import('./capabilities.ts');

const provider = (
  name: string,
  state: 'preparing' | 'ready',
): SimilarityProvider => ({
  name,
  status: async () => ({ state, message: `${name} is ${state}.` }),
  index: async () => ({ sent: 0, removed: 0 }),
  similar: async () => [],
});

it('says what is missing when nothing provides the capability', async () => {
  current.providers = [];
  const refused = readyProvider('similarity');
  await expect(refused).rejects.toBeInstanceOf(CapabilityUnavailableError);
  await expect(refused).rejects.toThrow(capabilityTable.similarity.whenMissing);
});

it("passes on a provider's own sentence while it is still preparing", async () => {
  current.providers = [provider('Potion', 'preparing')];
  await expect(readyProvider('similarity')).rejects.toThrow(
    'Potion is preparing.',
  );
});

it('consults the first ready provider and skips ones still preparing', async () => {
  const ready = provider('Second', 'ready');
  current.providers = [
    provider('First', 'preparing'),
    ready,
    provider('Third', 'ready'),
  ];
  expect(await readyProvider('similarity')).toBe(ready);
});

it('only lets a package claim capabilities that core defines', () => {
  const manifest = (provides: string[]) =>
    manifestSchema.safeParse({
      id: 'example',
      name: 'Example',
      version: '1.0.0',
      apiVersion: '0.5',
      entrypoint: 'adapter.js',
      sha256: '1'.repeat(64),
      maintainer: 'Example',
      issueTracker: 'https://example.org/issues',
      provides,
      actions: [{ id: 'status', label: 'Status' }],
    }).success;
  expect(manifest(['similarity'])).toBe(true);
  expect(manifest(['weather'])).toBe(false);
});
