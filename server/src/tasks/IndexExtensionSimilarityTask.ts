import { inject, injectable } from 'inversify';
import { MeilisearchService } from '../services/MeilisearchService.ts';
import {
  extensionSimilarity,
  similarityText,
} from '../services/extensions/similarity.ts';
import { SimpleTask } from './Task.ts';
import { simpleTaskDef } from './TaskRegistry.ts';

/** Keeps an installed similarity extension's index in step with the library. */
@injectable()
@simpleTaskDef({
  description:
    'Send new and changed shows and movies to an installed similarity extension.',
})
export class IndexExtensionSimilarityTask extends SimpleTask {
  static ID = IndexExtensionSimilarityTask.name;
  private running = false;

  constructor(@inject(MeilisearchService) private search: MeilisearchService) {
    super();
  }

  protected async runInternal() {
    if (this.running) return;
    this.running = true;
    try {
      const similarity = extensionSimilarity();
      // Nothing to do, and no library read, without a similarity extension.
      if (!(await similarity.hasProvider())) return;
      const docs = await this.search.getSimilarityDocuments();
      const { sent, removed } = await similarity.index(
        docs.map((doc) => ({ id: doc.id, text: similarityText(doc) })),
      );
      if (sent || removed)
        this.logger.info(
          'Similarity extension: indexed %d titles, removed %d',
          sent,
          removed,
        );
    } finally {
      this.running = false;
    }
  }
}
