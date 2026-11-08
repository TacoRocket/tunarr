'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { newQuickJSWASMModuleFromVariant } = require('quickjs-emscripten-core');
const variant = require('@jitl/quickjs-singlefile-cjs-release-sync').default;

async function execute() {
  const wasm = await newQuickJSWASMModuleFromVariant(variant);
  const vm = wasm.newContext();
  vm.runtime.setMemoryLimit(16 * 1024 * 1024);
  vm.runtime.setMaxStackSize(256 * 1024);
  vm.runtime.setInterruptHandler(() => Date.now() >= workerData.deadline);
  let reads = 0;
  let response;
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
      parentPort.postMessage({
        type: 'read',
        id,
        params: JSON.parse(encodedQuery),
        response,
      });
      Atomics.wait(size, 0, 0, Math.max(0, workerData.deadline - Date.now()));
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
      vm.evalCode('"use strict";\n' + workerData.code, 'adapter.js', {
        type: 'global',
      }),
    ).dispose();
    const argument = JSON.stringify(workerData.input);
    const result = vm.unwrapResult(
      vm.evalCode('JSON.stringify(run(' + argument + '))'),
    );
    const serialized = result.consume((handle) => vm.getString(handle));
    if (Buffer.byteLength(serialized) > 65536)
      throw new Error('Result too large');
    const value = JSON.parse(serialized);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid result');
    parentPort.postMessage({ type: 'result', value });
  } catch {
    parentPort.postMessage({
      type: Date.now() >= workerData.deadline ? 'timeout' : 'error',
    });
  } finally {
    vm.dispose();
  }
}

execute().catch(() => parentPort.postMessage({ type: 'error' }));
