import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { CommandModule } from 'yargs';
import { container } from '../container.ts';
import type { ServerOptions } from '../globals.ts';
import { setServerOptionsUnchecked } from '../globals.ts';
import { TunarrWorker } from '../services/TunarrWorker.ts';
import type { GenerateOpenApiCommandArgs } from './GenerateOpenApiCommand.ts';
import type { GlobalArgsType } from './types.ts';

type WorkerData = {
  serverOptions: ServerOptions;
};

export const StartWorkerCommand: CommandModule<
  GlobalArgsType,
  GenerateOpenApiCommandArgs
> = {
  command: 'start-worker',
  describe: 'Starts a Tunarr worker (internal use only)',
  handler: () => {
    if (isMainThread) {
      console.error('This module is only meant to be run as a worker thread.');
      process.exit(1);
    }

    if (!parentPort) {
      console.error('No parent port.');
      process.exit(1);
    }

    const { serverOptions } = workerData as WorkerData;

    // The global options were already resolved from this worker's argv by the
    // CLI middleware. This applies the server-only fields on top — notably
    // searchPort, without which the worker starts hunting for a free port and
    // never finds the search server the parent is actually running.
    //
    // The unchecked setter is required: `setServerOptions` is `once()`-guarded
    // and the middleware has already spent it.
    setServerOptionsUnchecked(serverOptions);

    // Scheduling initializes its search client on dispatch. OCR needs neither
    // search startup nor the server's migrations, fixers and library refreshes.
    container.get<TunarrWorker>(TunarrWorker).start();
  },
};
