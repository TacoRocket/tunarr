// What each capability must answer. Features and providers both code against
// these shapes, never against each other. Kept free of runtime imports so the
// extension manifest schema can use the capability names.

/** Capability names. An extension lists the ones it implements in `provides`. */
export const capabilityNames = ['similarity'] as const;
export type Capability = (typeof capabilityNames)[number];

/**
 * How far along a provider is, with one plain sentence for the operator. Only
 * a `ready` provider is consulted.
 */
export type ProviderStatus =
  | { state: 'preparing'; message: string }
  | { state: 'ready'; message: string };

/** A title as similarity providers see it: its Tunarr id and its text. */
export type SimilarityItem = { id: string; text: string };

/** similarity: the shows and movies nearest to one of them. */
export interface SimilarityProvider {
  /** Shown to the operator, e.g. "Potion". */
  readonly name: string;
  status(): Promise<ProviderStatus>;
  /**
   * The library's shows and movies. Tunarr sends the full list every hour;
   * the provider keeps its own index and may skip what it already has.
   */
  index(items: SimilarityItem[]): Promise<{ sent: number; removed: number }>;
  /** Up to `limit` ids, closest first, never `id` itself. */
  similar(id: string, limit: number): Promise<string[]>;
}

export type CapabilityContracts = { similarity: SimilarityProvider };
