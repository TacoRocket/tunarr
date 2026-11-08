import { Worker } from 'node:worker_threads';
import { ExtensionError } from './schema.ts';
import { loadExtensionWorker } from './workerSource.ts';

const actionTimeoutMs = 30_000;
const maxReadReply = 8 * 1024 * 1024;

type JsonObject = Record<string, unknown>;
type ServiceRead = (
  id: string,
  params: JsonObject,
  remainingMs: number,
) => Promise<unknown>;
type WorkerReply =
  | {
      type: 'read';
      id: string;
      params: JsonObject;
      response: SharedArrayBuffer;
    }
  | { type: 'result'; value: JsonObject }
  | { type: 'error' | 'timeout' };

export async function runExtension(
  code: string,
  input: JsonObject,
  read: ServiceRead,
): Promise<JsonObject> {
  if (
    Buffer.byteLength(code) > 128 * 1024 ||
    Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024
  ) {
    throw new ExtensionError(
      422,
      'The extension input exceeds its size limit.',
    );
  }
  const source = await loadExtensionWorker();
  const deadline = Date.now() + actionTimeoutMs;
  const worker = new Worker(source, {
    eval: true,
    execArgv: [],
    env: {},
    workerData: { code, input, deadline },
  });

  let pending: Int32Array | undefined;
  let finished = false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = () => new ExtensionError(504, 'Extension timed out.');
  try {
    return await new Promise<JsonObject>((resolve, reject) => {
      // Independent of the guest interrupt, including initialization and broker waits.
      timer = setTimeout(
        () => reject(timeout()),
        Math.max(0, deadline - Date.now()),
      );
      worker.once('error', () =>
        reject(new ExtensionError(502, 'Extension worker failed.')),
      );
      worker.once('exit', () =>
        reject(new ExtensionError(502, 'Extension worker stopped.')),
      );
      worker.on('message', (message: WorkerReply) => {
        if (finished) return;
        if (Date.now() >= deadline || message.type === 'timeout')
          return reject(timeout());
        if (message.type === 'result') return resolve(message.value);
        if (message.type !== 'read') {
          return reject(
            new ExtensionError(502, 'Extension failed to return a result.'),
          );
        }
        const { response } = message;
        const flag = new Int32Array(response, 0, 1);
        pending = flag;
        void read(message.id, message.params, deadline - Date.now())
          .then((value) => {
            if (finished) return;
            const encoded = Buffer.from(JSON.stringify(value));
            if (encoded.length === 0 || encoded.length > maxReadReply) {
              throw new ExtensionError(
                502,
                'The service response exceeds the size limit.',
              );
            }
            new Uint8Array(response, 4, encoded.length).set(encoded);
            Atomics.store(flag, 0, encoded.length);
            Atomics.notify(flag, 0);
            pending = undefined;
          })
          .catch(reject);
      });
    });
  } finally {
    finished = true;
    clearTimeout(timer);
    if (pending) {
      Atomics.store(pending, 0, -1);
      Atomics.notify(pending, 0);
    }
    void worker.terminate();
  }
}
