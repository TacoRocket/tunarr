import type { SubtitleLookupProvider } from '../capabilities/contracts.ts';
import {
  extensionProgramSchema,
  subtitleLookupResult,
  type Installation,
  type Manifest,
} from './schema.ts';
import type { ExtensionStore } from './store.ts';
import { extensionStore } from './storeInstance.ts';

export async function extensionSubtitleLookupProviders(
  store = extensionStore(),
) {
  const found = await store.discoverProviders('subtitleLookup');
  return found.map(({ state, manifest }) =>
    extensionSubtitleLookupProvider(store, state, manifest),
  );
}

export function extensionSubtitleLookupProvider(
  store: ExtensionStore,
  state: Installation,
  manifest: Manifest,
): SubtitleLookupProvider {
  return {
    name: manifest.name,
    status: () =>
      Promise.resolve({
        state: 'ready',
        message: `${manifest.name} is ready.`,
      }),
    lookup({ program, language, sdh, forced }) {
      return store.lock.runExclusive(async () => {
        const active = await store.currentProvider('subtitleLookup', state);
        if (!active) return { status: 'unavailable' as const };
        return store.provide(
          active.state,
          active.manifest,
          {
            action: 'subtitle.lookup',
            program: extensionProgramSchema.parse(program),
            language,
            sdh,
            forced,
          },
          subtitleLookupResult,
        );
      });
    },
  };
}
