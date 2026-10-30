import type { RouterPluginAsyncCallback } from '@/types/serverType.js';
import {
  BaseErrorSchema,
  CreateFillerListRequestSchema,
  IdPathParamSchema,
  SmartFillerSyncResultSchema,
  UpdateFillerListRequestSchema,
} from '@tunarr/types/api';
import {
  FillerListProgrammingSchema,
  FillerListSchema,
} from '@tunarr/types/schemas';
import { isNil, map } from 'lodash-es';
import { z } from 'zod/v4';
import { MaterializeProgramsCommand } from '../commands/MaterializeProgramsCommand.ts';
import { container } from '../container.ts';
import { SmartFillerListService } from '../services/SmartFillerListService.ts';
import { GenericNotFoundError, SmartFillerSyncError } from '../types/errors.ts';

// We can't use the built-in zod brand because we have our own custom
// tagged type.
const fillerShowIdSchema = z.string().uuid();

// eslint-disable-next-line @typescript-eslint/require-await
export const fillerListsApi: RouterPluginAsyncCallback = async (fastify) => {
  fastify.get(
    '/filler-lists',
    {
      schema: {
        tags: ['Filler Lists'],
        response: {
          200: z.array(FillerListSchema),
        },
      },
    },
    async (req, res) => {
      const fillers = await req.serverCtx.fillerDB.getAllFillers();

      return res.send(
        map(fillers, (f) => ({
          id: f.uuid,
          name: f.name,
          contentCount: f.content.length,
          smartCollectionId: f.smartCollectionId,
        })),
      );
    },
  );

  fastify.get(
    '/filler-lists/:id',
    {
      schema: {
        tags: ['Filler Lists'],
        params: z.object({ id: fillerShowIdSchema }),
        response: {
          200: FillerListSchema,
          404: z.void(),
        },
      },
    },
    async (req, res) => {
      const filler = await req.serverCtx.fillerDB.getFiller(req.params.id);
      if (isNil(filler)) {
        return res.status(404).send();
      }

      return res.send({
        id: filler.uuid,
        name: filler.name,
        contentCount: filler.fillerContent.length,
        smartCollectionId: filler.smartCollectionId,
      });
    },
  );

  fastify.delete(
    '/filler-lists/:id',
    {
      schema: {
        tags: ['Filler Lists'],
        params: z.object({ id: fillerShowIdSchema }),
        response: {
          200: z.void(),
          404: z.void(),
        },
      },
    },
    async (req, res) => {
      const filler = await req.serverCtx.fillerDB.getFiller(req.params.id);
      if (isNil(filler)) {
        return res.status(404).send();
      }
      req.serverCtx.fillerDB.deleteFiller(req.params.id);
      return res.send();
    },
  );

  fastify.post(
    '/filler-lists',
    {
      schema: {
        tags: ['Filler Lists'],
        body: CreateFillerListRequestSchema,
        response: {
          201: z.object({ id: z.string() }),
          400: BaseErrorSchema,
        },
      },
    },
    async (req, res) => {
      try {
        const id = await container.get(SmartFillerListService).create(req.body);
        return res.status(201).send({ id });
      } catch (error) {
        if (error instanceof SmartFillerSyncError) {
          return res.status(400).send({ message: error.message });
        }
        throw error;
      }
    },
  );

  fastify.put(
    '/filler-lists/:id',
    {
      schema: {
        tags: ['Filler Lists'],
        params: z.object({
          id: fillerShowIdSchema,
        }),
        body: UpdateFillerListRequestSchema,
        response: {
          200: FillerListSchema,
          400: BaseErrorSchema,
          404: z.void(),
        },
      },
    },
    async (req, res) => {
      let result: Awaited<ReturnType<SmartFillerListService['update']>>;
      try {
        result = await container
          .get(SmartFillerListService)
          .update(req.params.id, req.body);
      } catch (error) {
        if (error instanceof SmartFillerSyncError) {
          return res.status(400).send({ message: error.message });
        }
        throw error;
      }

      if (isNil(result)) {
        return res.status(404).send();
      }

      return res.send({
        id: result.uuid,
        name: result.name,
        contentCount: result.fillerContent.length,
        smartCollectionId: result.smartCollectionId,
      });
    },
  );

  fastify.post(
    '/filler-lists/:id/sync',
    {
      schema: {
        operationId: 'SyncFillerListFromSmartCollection',
        description:
          "Replace a linked filler list's programs with its smart collection's current results. The list is left as it was when the collection has no playable clips.",
        tags: ['Filler Lists'],
        params: z.object({ id: fillerShowIdSchema }),
        response: {
          200: SmartFillerSyncResultSchema,
          400: BaseErrorSchema,
          404: z.void(),
        },
      },
    },
    async (req, res) => {
      try {
        return res.send(
          await container.get(SmartFillerListService).sync(req.params.id),
        );
      } catch (error) {
        if (error instanceof GenericNotFoundError) {
          return res.status(404).send();
        }
        if (error instanceof SmartFillerSyncError) {
          return res.status(400).send({ message: error.message });
        }
        throw error;
      }
    },
  );

  fastify.get(
    '/filler-lists/:id/programs',
    {
      schema: {
        tags: ['Filler Lists'],
        params: IdPathParamSchema.extend({ id: fillerShowIdSchema }),
        response: {
          200: FillerListProgrammingSchema,
          404: z.void(),
        },
      },
    },
    async (req, res) => {
      const fillerContent = await req.serverCtx.fillerDB.getFillerPrograms(
        req.params.id,
      );
      const materializedContent = await container
        .get<MaterializeProgramsCommand>(MaterializeProgramsCommand)
        .execute(fillerContent);
      const responsePrograms = materializedContent.map((program) =>
        req.serverCtx.programConverter.materializedProgramToContentProgram(
          program,
        ),
      );
      return res.status(200).send(responsePrograms);
    },
  );
};
