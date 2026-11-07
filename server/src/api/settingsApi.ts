import { z } from 'zod/v4';
import { GlobalMediaSourceSettingsSchema } from '@tunarr/types/schemas';
import type { RouterPluginAsyncCallback } from '../types/serverType.js';

const fields = GlobalMediaSourceSettingsSchema.shape;

// eslint-disable-next-line @typescript-eslint/require-await
export const settingsApi: RouterPluginAsyncCallback = async (fastify) => {
  fastify.get(
    '/settings/media-source',
    {
      schema: {
        tags: ['Settings'],
        response: {
          200: GlobalMediaSourceSettingsSchema,
        },
      },
    },
    async (req, res) => {
      const settings = req.serverCtx.settings.globalMediaSourceSettings();
      return res.send(settings);
    },
  );

  fastify.put(
    '/settings/media-source',
    {
      schema: {
        tags: ['Settings'],
        body: z
          .object({
            plexNotificationsEnabled:
              fields.plexNotificationsEnabled.removeDefault(),
            rescanIntervalHours: fields.rescanIntervalHours.removeDefault(),
            repairReaddedItems: fields.repairReaddedItems.removeDefault(),
            repairReaddedItemsOnStartup:
              fields.repairReaddedItemsOnStartup.removeDefault(),
          })
          .partial(),
        response: {
          200: GlobalMediaSourceSettingsSchema,
        },
      },
    },
    async (req, res) => {
      await req.serverCtx.settings.directUpdate((file) => {
        Object.assign(file.settings.mediaSource, req.body);
      });
      return res.send(req.serverCtx.settings.globalMediaSourceSettings());
    },
  );
};
