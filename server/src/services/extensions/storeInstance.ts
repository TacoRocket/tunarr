import { container } from '@/container.js';
import { serverOptions } from '@/globals.js';
import { join } from 'node:path';
import { MeilisearchService } from '../MeilisearchService.ts';
import { defaultExtensionSource } from './distribution.ts';
import { ExtensionStore } from './store.ts';

let instance: ExtensionStore | undefined;

/** The one extension store, shared by the API and Tunarr's own calls. */
export function extensionStore(): ExtensionStore {
  instance ??= new ExtensionStore(
    join(serverOptions().databaseDirectory, 'extension-store'),
    process.env.TUNARR_EXTENSION_SOURCE ?? defaultExtensionSource,
    () => {
      const ports = [serverOptions().port];
      const searchPort = container.get(MeilisearchService).getPort();
      if (searchPort !== undefined) ports.push(searchPort);
      return ports;
    },
  );
  return instance;
}
