import { LoggerFactory } from '@/util/logging/LoggerFactory.js';
import { Worker } from 'node:worker_threads';
import { ExtensionError } from './schema.ts';
import { loadExtensionWorker } from './workerSource.ts';

const actionTimeoutMs = 30_000;
const maxReplyBytes = 8 * 1024 * 1024;
const maxMessageLength = 300;

type JsonObject = Record<string, unknown>;
export type ServicePayload = { query: unknown; body: unknown };
type ServiceRequest = (
  id: string,
  payload: ServicePayload,
  remainingMs: number,
) => Promise<unknown>;
type WorkerReply =
  | {
      type: 'request';
      id: string;
      payload: ServicePayload;
      response: SharedArrayBuffer;
    }
  | { type: 'result'; value: JsonObject }
  | { type: 'error'; message?: string; internal?: string }
  | { type: 'timeout' };

const logger = LoggerFactory.child({
  caller: import.meta,
  className: 'ExtensionRuntime',
});

// One line of plain text, short enough for a Settings alert.
function plainMessage(text: string) {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > maxMessageLength
    ? line.slice(0, maxMessageLength - 1) + '…'
    : line;
}

export async function runExtension(
  extension: { id: string; name: string },
  code: string,
  input: JsonObject,
  request: ServiceRequest,
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
        if (message.type === 'error') {
          if (message.message)
            return reject(
              new ExtensionError(422, plainMessage(message.message)),
            );
          logger.warn(
            'Extension %s stopped with an internal error: %s',
            extension.id,
            message.internal ?? 'unknown',
          );
          return reject(
            new ExtensionError(
              502,
              `${extension.name} stopped with an internal error. Report it to its publisher.`,
            ),
          );
        }
        const { response } = message;
        const flag = new Int32Array(response, 0, 1);
        pending = flag;
        void request(message.id, message.payload, deadline - Date.now())
          .then((value) => {
            if (finished) return;
            // An empty reply (e.g. 204) reaches the package as null.
            const encoded = Buffer.from(JSON.stringify(value ?? null));
            if (encoded.length > maxReplyBytes) {
              throw new ExtensionError(
                502,
                `${extension.name}'s reply is larger than extensions can handle.`,
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
