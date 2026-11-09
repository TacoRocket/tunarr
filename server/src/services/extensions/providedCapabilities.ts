import { capabilityTable } from '../capabilities/capabilities.ts';
import type { Capability, ProviderStatus } from '../capabilities/contracts.ts';
import type { Installation, Manifest } from './schema.ts';
import { extensionSimilarityProvider } from './similarity.ts';
import type { ExtensionStore } from './store.ts';

// How an installed extension answers each capability. Adding a capability to
// the table without a line here is a type error.
const extensionProvider: {
  [K in Capability]: (
    store: ExtensionStore,
    state: Installation,
    manifest: Manifest,
  ) => { status(): Promise<ProviderStatus> };
} = { similarity: extensionSimilarityProvider };

/**
 * Each capability an installed extension provides and how far along it is,
 * for its Info tab. `off` while it is turned off or not set up: Tunarr won't
 * consult it then.
 */
export function providedCapabilities(
  store: ExtensionStore,
  state: Installation,
  manifest: Manifest,
) {
  return Promise.all(
    manifest.provides.map(async (capability) => {
      const label = capabilityTable[capability].label;
      const status =
        state.enabled && state.configured
          ? await extensionProvider[capability](store, state, manifest).status()
          : {
              state: 'off' as const,
              message: `Turn on ${manifest.name} to provide ${label}.`,
            };
      return { capability, label, ...status };
    }),
  );
}
