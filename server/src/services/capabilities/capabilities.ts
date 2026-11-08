// Capabilities: what a Tunarr feature can ask for without knowing who answers.
//
// A feature names a capability and consults whichever provider meets its
// definition (contracts.ts). It never imports the extension, model or service
// behind it. Home Assistant works the same way: an Assist pipeline asks for a
// conversation agent, and any integration implementing that platform can be
// one. Debian calls the idea a virtual package.
//
// This table is the one place that says, for each capability, who can provide
// it, which features use it and what they say when nothing does.
import { extensionSimilarityProviders } from '../extensions/similarity.ts';
import type {
  Capability,
  CapabilityContracts,
  ProviderStatus,
} from './contracts.ts';

type Entry<K extends Capability> = {
  /** Features that consult it. */
  usedBy: string[];
  /** What those features tell the operator when no provider is ready. */
  whenMissing: string;
  /** Every current provider, in the order Tunarr consults them. */
  providers: () => Promise<CapabilityContracts[K][]>;
};

export const capabilityTable: { [K in Capability]: Entry<K> } = {
  similarity: {
    usedBy: ['Semantic matching', 'Balanced matching', 'Rolling guides'],
    whenMissing:
      'Semantic and Balanced matching need a similarity provider, such as the Potion extension.',
    // Enabled, set-up extensions whose manifest lists "similarity".
    providers: () => extensionSimilarityProviders(),
  },
};

/** The text similarity providers get for a title: name, genres, tags, summary. */
export function similarityText(doc: {
  title: string;
  genres?: { name: string }[] | string[] | null;
  tags?: string[] | null;
  summary?: string | null;
  plot?: string | null;
}) {
  const names = (list: unknown[] | null | undefined) =>
    (list ?? [])
      .map((x) => (typeof x === 'string' ? x : (x as { name?: string }).name))
      .filter(Boolean)
      .join(', ');
  return [
    doc.title,
    names(doc.genres),
    names(doc.tags),
    (doc.summary || doc.plot || '').trim(),
  ]
    .filter(Boolean)
    .join('. ');
}

/** No provider of the capability is ready; the message says why. */
export class CapabilityUnavailableError extends Error {}

/** Every current provider of `kind`, ready or not. */
export function capabilityProviders<K extends Capability>(kind: K) {
  return capabilityTable[kind].providers();
}

/** The first ready provider of `kind`, or the reason there is none. */
export async function consult<K extends Capability>(
  kind: K,
): Promise<
  | { provider: CapabilityContracts[K]; status: ProviderStatus }
  | {
      provider?: undefined;
      status: { state: 'preparing' | 'none'; message: string };
    }
> {
  let preparing: { state: 'preparing'; message: string } | undefined;
  for (const provider of await capabilityProviders(kind)) {
    const status = await provider.status();
    if (status.state === 'ready') return { provider, status };
    preparing ??= status;
  }
  return {
    status: preparing ?? {
      state: 'none',
      message: capabilityTable[kind].whenMissing,
    },
  };
}

/** The provider to use for `kind`; throws with the reason if none is ready. */
export async function readyProvider<K extends Capability>(kind: K) {
  const { provider, status } = await consult(kind);
  if (!provider) throw new CapabilityUnavailableError(status.message);
  return provider;
}
