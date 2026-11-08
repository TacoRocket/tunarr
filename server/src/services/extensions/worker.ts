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

async function execute() {
  // Node ESM wraps the CommonJS default. Bun imports the variant directly.
  const wasm = await newQuickJSWASMModuleFromVariant(
    variant.default ?? variant,
  );
  const vm = wasm.newContext();
  vm.runtime.setMemoryLimit(16 * 1024 * 1024);
  vm.runtime.setMaxStackSize(256 * 1024);
  vm.runtime.setInterruptHandler(() => Date.now() >= request.deadline);
  let reads = 0;
  let response: SharedArrayBuffer | undefined;
  try {
    const bridge = vm.newFunction('read', (name, query) => {
      const id = vm.getString(name);
      const encodedQuery = vm.getString(query);
      if (
        ++reads > 50 ||
        id.length > 64 ||
        Buffer.byteLength(encodedQuery) > 4096
      ) {
        throw new Error('Invalid service read');
      }
      // Only the VM worker waits. The host's HTTP event loop remains free.
      response ??= new SharedArrayBuffer(4 + 8 * 1024 * 1024);
      const size = new Int32Array(response, 0, 1);
      Atomics.store(size, 0, 0);
      port.postMessage({
        type: 'read',
        id,
        params: JSON.parse(encodedQuery) as unknown,
        response,
      });
      Atomics.wait(size, 0, 0, Math.max(0, request.deadline - Date.now()));
      const length = Atomics.load(size, 0);
      if (length <= 0) throw new Error('Service read stopped');
      return vm.newString(Buffer.from(response, 4, length).toString('utf8'));
    });
    bridge.consume((handle) => vm.setProp(vm.global, '_read', handle));
    vm.unwrapResult(
      vm.evalCode(`
      ((call, parse, stringify) => {
        delete globalThis._read;
        Object.defineProperty(globalThis, 'readJson', {value: (id, params = {}) => parse(call(id, stringify(params)))});
      })(_read, JSON.parse, JSON.stringify);
    `),
    ).dispose();
    vm.unwrapResult(
      vm.evalCode('"use strict";\n' + request.code, 'adapter.js', {
        type: 'global',
      }),
    ).dispose();
    const argument = JSON.stringify(JSON.stringify(request.input));
    const result = vm.unwrapResult(
      vm.evalCode('JSON.stringify(run(JSON.parse(' + argument + ')))'),
    );
    const serialized = result.consume((handle) => vm.getString(handle));
    if (Buffer.byteLength(serialized) > 65536)
      throw new Error('Result too large');
    const value: unknown = JSON.parse(serialized);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid result');
    port.postMessage({ type: 'result', value });
  } catch {
    port.postMessage({
      type: Date.now() >= request.deadline ? 'timeout' : 'error',
    });
  } finally {
    vm.dispose();
  }
}

execute().catch(() => port.postMessage({ type: 'error' }));
