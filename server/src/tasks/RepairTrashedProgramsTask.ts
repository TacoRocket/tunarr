import type { Tag } from '@tunarr/types';
import { inject, injectable } from 'inversify';
import { TrashRepairService } from '../services/TrashRepairService.ts';
import { InjectLogger } from '../util/inject.ts';
import type { Logger } from '../util/logging/LoggerFactory.ts';
import type { TaskMetadata } from './Task.ts';
import { SimpleTask } from './Task.ts';
import { simpleTaskDef } from './TaskRegistry.ts';

// Runs after every library scan, when the media server may have re-added
// items under new IDs. Does nothing unless the repair setting is on.
@injectable()
@simpleTaskDef({
  description:
    'Merges trashed items into their re-added copies when repairs are enabled',
  hidden: true,
})
export class RepairTrashedProgramsTask extends SimpleTask {
  static KEY = Symbol.for(RepairTrashedProgramsTask.name);
  static ID = RepairTrashedProgramsTask.name;
  public ID = RepairTrashedProgramsTask.ID as Tag<
    typeof RepairTrashedProgramsTask.name,
    TaskMetadata
  >;

  @InjectLogger() declare protected readonly logger: Logger;

  constructor(
    @inject(TrashRepairService) private trashRepair: TrashRepairService,
  ) {
    super();
  }

  protected async runInternal(): Promise<void> {
    await this.trashRepair.runIfEnabled('library scan');
  }
}
