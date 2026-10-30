import type { Tag } from '@tunarr/types';
import { inject, injectable } from 'inversify';
import { SmartFillerListService } from '../services/SmartFillerListService.ts';
import { InjectLogger } from '../util/inject.ts';
import type { Logger } from '../util/logging/LoggerFactory.ts';
import type { TaskMetadata } from './Task.ts';
import { SimpleTask } from './Task.ts';
import { simpleTaskDef } from './TaskRegistry.ts';

// Runs after every library scan, so clips added to or removed from a smart
// collection's matches reach the filler lists linked to it.
@injectable()
@simpleTaskDef({
  description:
    'Syncs filler lists linked to smart collections with their results',
  hidden: true,
})
export class SyncSmartFillerListsTask extends SimpleTask {
  static KEY = Symbol.for(SyncSmartFillerListsTask.name);
  static ID = SyncSmartFillerListsTask.name;
  public ID = SyncSmartFillerListsTask.ID as Tag<
    typeof SyncSmartFillerListsTask.name,
    TaskMetadata
  >;

  @InjectLogger() declare protected readonly logger: Logger;

  constructor(
    @inject(SmartFillerListService)
    private smartFillerLists: SmartFillerListService,
  ) {
    super();
  }

  protected async runInternal(): Promise<void> {
    await this.smartFillerLists.syncAll();
  }
}
