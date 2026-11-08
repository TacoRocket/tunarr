import { createGuestMemory, loadComputeModule } from './compute.ts';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
} from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-cjs-release-sync';

if (!parentPort) throw new Error('Extension runner requires a worker port.');
const port = parentPort;
const request = workerData as {
  deadline: number;
  code: string;
  input: Record<string, unknown>;
  memoryBytes?: number;
  computeModule?: string;
  // Data files shipped with the package: name -> absolute path.
  files?: Record<string, string>;
  // The extension's own data: saved key/values, its file folder and limit.
  storage?: { kv: Record<string, string>; dir: string; maxBytes: number };
};

const fileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const storage = request.storage;
// Writes are held here and handed to Tunarr only if the run succeeds.
let kv = new Map(Object.entries(storage?.kv ?? {}));
let kvChanged = false;
const stagedFiles = new Map<string, Uint8Array | null>();

function storedFileSize(name: string) {
  const staged = stagedFiles.get(name);
  if (staged !== undefined) return staged?.byteLength ?? 0;
  const path = join(storage!.dir, name);
  return existsSync(path) ? statSync(path).size : 0;
}

function checkStorageLimit(
  nextKv: Map<string, string>,
  nextFile?: { name: string; bytes: number },
) {
  if (!storage) return;
  let used = Buffer.byteLength(JSON.stringify(Object.fromEntries(nextKv)));
  const names = new Set([...stagedFiles.keys()]);
  if (existsSync(storage.dir)) {
    for (const entry of readdirSync(storage.dir)) names.add(entry);
  }
  if (nextFile) names.add(nextFile.name);
  for (const name of names)
    used += nextFile?.name === name ? nextFile.bytes : storedFileSize(name);
  if (used > storage.maxBytes)
    throw new Error(
      `This extension's storage is full (${Math.round(storage.maxBytes / 1048576)} MB).`,
    );
}

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
  const moduleName = request.computeModule;
  const allowance = request.memoryBytes ?? 16 * 1024 * 1024;
  const vmBytes = moduleName ? Math.floor(allowance / 2) : allowance;
  const base = variant.default ?? variant;
  // QuickJS's allocator limit alone misses binary allocations. Bound the
  // interpreter's linear memory even when the adapter runs only JavaScript.
  const wasm = await newQuickJSWASMModuleFromVariant(
    newVariant(base, { wasmMemory: createGuestMemory(256, vmBytes) }),
  );
  const vm = wasm.newContext();
  vm.runtime.setMemoryLimit(vmBytes);
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
    const readPackageFile = vm.newFunction('readFile', (nameHandle, asText) => {
      const name = vm.getString(nameHandle);
      const path = request.files?.[name];
      if (!path) throw new Error(`This package has no file named ${name}.`);
      const bytes = readFileSync(path);
      // The sandbox has no TextDecoder; text files come back as strings.
      if (vm.dump(asText) === true) return vm.newString(bytes.toString('utf8'));
      return vm.newArrayBuffer(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      );
    });
    readPackageFile.consume((h) => vm.setProp(vm.global, '_readFile', h));
    let calculate: ReturnType<typeof loadComputeModule> | undefined;
    if (moduleName) {
      const compute = vm.newFunction('compute', (module, fn, ...pairs) => {
        if (vm.getString(module) !== moduleName)
          throw new Error(
            'This compute module was not declared by the extension.',
          );
        const files = request.files ?? {};
        if (!Object.hasOwn(files, moduleName))
          throw new Error('The compute module is missing.');
        calculate ??= loadComputeModule(
          new Uint8Array(readFileSync(files[moduleName]!)),
          vmBytes,
        );
        function* inputs() {
          for (let i = 0; i < pairs.length; i += 2) {
            const kind = vm.getString(pairs[i]!);
            const value = pairs[i + 1]!;
            if (kind === 'file') {
              const name = vm.getString(value);
              if (!Object.hasOwn(files, name))
                throw new Error('Unknown compute input file.');
              const path = files[name]!;
              if (statSync(path).size > vmBytes)
                throw new Error(
                  'Compute input file exceeds the module memory limit.',
                );
              yield readFileSync(path);
            } else if (kind === 'text') {
              yield Buffer.from(vm.getString(value));
            } else {
              const data = vm.getArrayBuffer(value);
              try {
                yield data.value;
              } finally {
                data.dispose();
              }
            }
          }
        }
        return vm.newArrayBuffer(calculate(vm.getString(fn), inputs()));
      });
      compute.consume((h) => vm.setProp(vm.global, '_compute', h));
    }
    const needStorage = () => {
      if (!storage)
        throw new Error('This extension has no storage. Declare storageMiB.');
      return storage;
    };
    const store = vm.newObject();
    const define = (name: string, fn: Parameters<typeof vm.newFunction>[1]) =>
      vm.newFunction(name, fn).consume((h) => vm.setProp(store, name, h));
    define('get', (keyHandle) => {
      needStorage();
      const value = kv.get(vm.getString(keyHandle));
      return value === undefined ? vm.null : vm.newString(value);
    });
    define('set', (keyHandle, valueHandle) => {
      needStorage();
      const key = vm.getString(keyHandle);
      const value = vm.getString(valueHandle);
      if (!key || key.length > 200)
        throw new Error('Storage keys are 1 to 200 characters.');
      const nextKv = new Map(kv).set(key, value);
      checkStorageLimit(nextKv);
      kv = nextKv;
      kvChanged = true;
    });
    define('delete', (keyHandle) => {
      needStorage();
      kvChanged = kv.delete(vm.getString(keyHandle)) || kvChanged;
    });
    define('keys', () => {
      needStorage();
      return vm.newString(JSON.stringify([...kv.keys()]));
    });
    define('readFile', (nameHandle) => {
      const { dir } = needStorage();
      const name = vm.getString(nameHandle);
      if (!fileName.test(name)) throw new Error('Invalid storage file name.');
      const staged = stagedFiles.get(name);
      if (staged === null) return vm.null;
      if (staged)
        return vm.newArrayBuffer(
          staged.buffer.slice(
            staged.byteOffset,
            staged.byteOffset + staged.byteLength,
          ),
        );
      const path = join(dir, name);
      if (!existsSync(path)) return vm.null;
      const bytes = readFileSync(path);
      return vm.newArrayBuffer(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      );
    });
    define('writeFile', (nameHandle, dataHandle) => {
      needStorage();
      const name = vm.getString(nameHandle);
      if (!fileName.test(name)) throw new Error('Invalid storage file name.');
      const bytes = vm
        .getArrayBuffer(dataHandle)
        .consume((buffer) => new Uint8Array(buffer.value));
      checkStorageLimit(kv, { name, bytes: bytes.byteLength });
      stagedFiles.set(name, bytes);
    });
    define('deleteFile', (nameHandle) => {
      needStorage();
      const name = vm.getString(nameHandle);
      if (!fileName.test(name)) throw new Error('Invalid storage file name.');
      stagedFiles.set(name, null);
    });
    vm.setProp(vm.global, '_storage', store);
    store.dispose();
    vm.unwrapResult(
      vm.evalCode(`
      ((call, sleep, readFile, store, computeCall, parse, stringify) => {
        delete globalThis._compute;
        delete globalThis._request;
        delete globalThis._wait;
        delete globalThis._readFile;
        delete globalThis._storage;
        const bytes = (data) => ArrayBuffer.isView(data)
          ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
          : data;
        Object.defineProperty(globalThis, 'request', {value: (id, options = {}) =>
          parse(call(id, stringify({query: options.query ?? {}, body: options.body ?? {}})))});
        Object.defineProperty(globalThis, 'wait', {value: (seconds) => { sleep(seconds); }});
        Object.defineProperty(globalThis, 'readFile', {value: (name) => readFile(String(name), false)});
        Object.defineProperty(globalThis, 'readTextFile', {value: (name) => readFile(String(name), true)});
        if (computeCall) Object.defineProperty(globalThis, 'compute', {value: (module) => Object.freeze({
          call: (fn, ...inputs) => computeCall(String(module), String(fn), ...inputs.flatMap((input) => {
            if (typeof input === 'string') return ['text', input];
            if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) return ['bytes', bytes(input)];
            if (input && typeof input.file === 'string') return ['file', input.file];
            throw new TypeError('Expected a string, bytes, or {file: name}.');
          })),
        })});
        Object.defineProperty(globalThis, 'storage', {value: Object.freeze({
          get: (key) => store.get(String(key)),
          set: (key, value) => { store.set(String(key), String(value)); },
          delete: (key) => { store.delete(String(key)); },
          keys: () => parse(store.keys()),
          readFile: (name) => store.readFile(String(name)),
          writeFile: (name, data) => { store.writeFile(String(name), bytes(data)); },
          deleteFile: (name) => { store.deleteFile(String(name)); },
        })});
      })(_request, _wait, _readFile, _storage, globalThis._compute, JSON.parse, JSON.stringify);
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
    // Storage writes go back with the answer; Tunarr commits them only now.
    const files = [...stagedFiles].map(
      ([name, data]) =>
        [name, data ? (data.buffer as ArrayBuffer) : null] as const,
    );
    port.postMessage(
      {
        type: 'result',
        value,
        writes:
          kvChanged || files.length
            ? { kv: kvChanged ? Object.fromEntries(kv) : undefined, files }
            : undefined,
      },
      files.flatMap(([, data]) => (data ? [data] : [])),
    );
  } catch (error) {
    port.postMessage(failure(error));
  } finally {
    vm.dispose();
  }
}

execute().catch((error: unknown) => port.postMessage(failure(error)));
