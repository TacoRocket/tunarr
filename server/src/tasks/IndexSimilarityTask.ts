import { inject, injectable } from 'inversify';
import { MeilisearchService } from '../services/MeilisearchService.ts';
import {
  capabilityProviders,
  similarityText,
} from '../services/capabilities/capabilities.ts';
import { SimpleTask } from './Task.ts';
import { simpleTaskDef } from './TaskRegistry.ts';

/** Keeps each similarity provider's index in step with the library. */
@injectable()
@simpleTaskDef({
  description:
    'Send new and changed shows and movies to similarity providers, such as the Potion extension.',
})
export class IndexSimilarityTask extends SimpleTask {
  static ID = IndexSimilarityTask.name;
  private running = false;

  constructor(@inject(MeilisearchService) private search: MeilisearchService) {
    super();
  }

  protected async runInternal() {
    if (this.running) return;
    this.running = true;
    try {
      const providers = await capabilityProviders('similarity');
      // Nothing to do, and no library read, without a provider.
      if (providers.length === 0) return;
      const items = (await this.search.getSimilarityDocuments()).map((doc) => ({
        id: doc.id,
        text: similarityText(doc),
      }));
      for (const provider of providers) {
        const { sent, removed } = await provider.index(items);
        if (sent || removed)
          this.logger.info(
            '%s: indexed %d titles, removed %d',
            provider.name,
            sent,
            removed,
          );
      }
    } finally {
      this.running = false;
    }
  }
}
