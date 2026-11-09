import type { SubtitleRequestProvider } from '../capabilities/contracts.ts';
import {
  extensionProgramSchema,
  subtitleRequestResult,
  type Installation,
  type Manifest,
} from './schema.ts';
import type { ExtensionStore } from './store.ts';
import { extensionStore } from './storeInstance.ts';

export async function extensionSubtitleRequestProviders(
  store = extensionStore(),
) {
  const found = await store.discoverProviders('subtitleRequest');
  return found.map(({ state, manifest }) =>
    extensionSubtitleRequestProvider(store, state, manifest),
  );
}

export function extensionSubtitleRequestProvider(
  store: ExtensionStore,
  state: Installation,
  manifest: Manifest,
): SubtitleRequestProvider {
  return {
    name: manifest.name,
    status: () =>
      Promise.resolve({
        state: 'ready',
        message: `${manifest.name} is ready.`,
      }),
    request({ program, language, sdh, forced }) {
      return store.lock.runExclusive(async () => {
        const active = await store.currentProvider('subtitleRequest', state);
        if (!active) return { status: 'unavailable' as const };
        return store.provide(
          active.state,
          active.manifest,
          {
            action: 'subtitle.request',
            program: extensionProgramSchema.parse(program),
            language,
            sdh,
            forced,
          },
          subtitleRequestResult,
        );
      });
    },
  };
}
