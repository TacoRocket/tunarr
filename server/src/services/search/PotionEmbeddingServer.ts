import fs from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';
import { fileExists } from '../../util/fsUtil.ts';
import { PotionModel } from './PotionModel.ts';
import { POTION_MODEL_REVISION } from './potionModelManifest.ts';

// Version the URL when the encoder changes: Meili then regenerates its vectors.
const endpoint = `/potion/${POTION_MODEL_REVISION}/v1`;
const inputSchema = z.object({ input: z.string().max(32768) });

/** Loopback REST adapter owned by the main search service, before API startup. */
export class PotionEmbeddingServer {
  private server: Server | undefined;

  async start(databaseDirectory: string): Promise<string> {
    const candidates = [
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'potion'),
      path.join(process.cwd(), 'bin', 'potion'),
    ];
    let assets: string | undefined;
    for (const candidate of candidates) {
      if (await fileExists(path.join(candidate, 'model.safetensors'))) {
        assets = candidate;
        break;
      }
    }
    if (!assets)
      throw new Error(
        'Bundled Potion assets are missing. Run the Potion download script before enabling semantic recommendations.',
      );
    const model = new PotionModel(assets);
    await model.encode([]);

    // Changing the REST URL causes a full Meili re-embedding. Reuse this port
    // across restarts rather than allocating a new endpoint on every startup.
    const portFile = path.join(databaseDirectory, 'potion-port');
    const port = (await fileExists(portFile))
      ? z.coerce
          .number()
          .int()
          .min(1)
          .max(65535)
          .parse(await fs.readFile(portFile, 'utf8'))
      : 0;
    const server = createServer((request, response) => {
      const handle = async () => {
        if (request.method !== 'POST' || request.url !== endpoint) {
          response.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          const bytes = Buffer.from(chunk as Uint8Array);
          size += bytes.length;
          if (size > 262144) {
            response.writeHead(413).end();
            return;
          }
          chunks.push(bytes);
        }
        const parsed = inputSchema.safeParse(
          JSON.parse(Buffer.concat(chunks).toString('utf8')),
        );
        if (!parsed.success) {
          response.writeHead(400).end('Expected an input string');
          return;
        }
        const [embedding] = await model.encode([parsed.data.input]);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ embedding }));
      };
      void handle().catch((error: unknown) => {
        response.writeHead(error instanceof SyntaxError ? 400 : 500, {
          'Content-Type': 'application/json',
        });
        response.end(
          JSON.stringify({
            error:
              error instanceof Error ? error.message : 'Potion encoding failed',
          }),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    this.server = server;
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Potion did not bind a TCP port');
    await fs.writeFile(portFile, String(address.port));
    return `http://127.0.0.1:${address.port}${endpoint}`;
  }

  stop() {
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = undefined;
  }
}
