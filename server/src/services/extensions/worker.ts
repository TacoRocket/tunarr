import { parentPort, workerData } from 'node:worker_threads';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-cjs-release-sync';

if (!parentPort) throw new Error('Extension runner requires a worker port.');
const port = parentPort;
const request = workerData as {
  deadline: number;
  code: string;
  input: Record<string, unknown>;
};

const maxWaitSeconds = 10;

// What the host reports when the package fails. An error the package threw
// on purpose (`throw new Error("...")`) carries its own message for the
// operator; anything else is a bug in the package.
type Failure =
  | { type: 'error'; message: string }
  | { type: 'error'; internal: string }
  | { type: 'timeout' };

function failure(error: unknown): Failure {
  if (Date.now() >= request.deadline) return { type: 'timeout' };
  const cause: unknown =
    error && typeof error === 'object' && 'cause' in error
      ? error.cause
      : undefined;
  if (
    cause &&
    typeof cause === 'object' &&
    'name' in cause &&
    cause.name === 'Error' &&
    'message' in cause &&
    typeof cause.message === 'string' &&
    cause.message.trim()
  ) {
    return { type: 'error', message: cause.message };
  }
  const described = JSON.stringify(cause ?? String(error)) ?? 'unknown';
  return { type: 'error', internal: described.slice(0, 300) };
}

async function execute() {
  // Node ESM wraps the CommonJS default. Bun imports the variant directly.
  const wasm = await newQuickJSWASMModuleFromVariant(
    variant.default ?? variant,
  );
  const vm = wasm.newContext();
  vm.runtime.setMemoryLimit(16 * 1024 * 1024);
  vm.runtime.setMaxStackSize(256 * 1024);
  vm.runtime.setInterruptHandler(() => Date.now() >= request.deadline);
  let requests = 0;
  let response: SharedArrayBuffer | undefined;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  try {
    const bridge = vm.newFunction('request', (name, payload) => {
      const id = vm.getString(name);
      const encoded = vm.getString(payload);
      if (++requests > 50)
        throw new Error('An action can make at most 50 service requests.');
      if (id.length > 64 || Buffer.byteLength(encoded) > 16384)
        throw new Error('The service request is too large.');
      // Only the VM worker waits. The host's HTTP event loop remains free.
      response ??= new SharedArrayBuffer(4 + 8 * 1024 * 1024);
      const size = new Int32Array(response, 0, 1);
      Atomics.store(size, 0, 0);
      port.postMessage({
        type: 'request',
        id,
        payload: JSON.parse(encoded) as unknown,
        response,
      });
      Atomics.wait(size, 0, 0, Math.max(0, request.deadline - Date.now()));
      const length = Atomics.load(size, 0);
      if (length <= 0) throw new Error('The service request stopped.');
      return vm.newString(Buffer.from(response, 4, length).toString('utf8'));
    });
    bridge.consume((handle) => vm.setProp(vm.global, '_request', handle));
    const wait = vm.newFunction('wait', (secondsHandle) => {
      const seconds = vm.getNumber(secondsHandle);
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > maxWaitSeconds)
        throw new Error(
          `wait() takes a number of seconds above 0 and up to ${maxWaitSeconds}.`,
        );
      // Sleeps without using CPU. The action's deadline still applies.
      const ms = Math.min(seconds * 1000, request.deadline - Date.now());
      if (ms > 0) Atomics.wait(sleeper, 0, 0, ms);
    });
    wait.consume((handle) => vm.setProp(vm.global, '_wait', handle));
    vm.unwrapResult(
      vm.evalCode(`
      ((call, sleep, parse, stringify) => {
        delete globalThis._request;
        delete globalThis._wait;
        Object.defineProperty(globalThis, 'request', {value: (id, options = {}) =>
          parse(call(id, stringify({query: options.query ?? {}, body: options.body ?? {}})))});
        Object.defineProperty(globalThis, 'wait', {value: (seconds) => { sleep(seconds); }});
      })(_request, _wait, JSON.parse, JSON.stringify);
    `),
    ).dispose();
    vm.unwrapResult(
      vm.evalCode('"use strict";\n' + request.code, 'adapter.js', {
        type: 'global',
      }),
    ).dispose();
    const argument = JSON.stringify(JSON.stringify(request.input));
    const result = vm.unwrapResult(
      vm.evalCode('JSON.stringify(run(JSON.parse(' + argument + ')) ?? null)'),
    );
    const serialized = result.consume((handle) => vm.getString(handle));
    if (Buffer.byteLength(serialized) > 65536) {
      port.postMessage({
        type: 'error',
        message: "The extension's answer is larger than Tunarr can show.",
      });
      return;
    }
    const value: unknown = JSON.parse(serialized || 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      port.postMessage({
        type: 'error',
        message: 'The extension finished without saying what it found.',
      });
      return;
    }
    port.postMessage({ type: 'result', value });
  } catch (error) {
    port.postMessage(failure(error));
  } finally {
    vm.dispose();
  }
}

execute().catch((error: unknown) => port.postMessage(failure(error)));
