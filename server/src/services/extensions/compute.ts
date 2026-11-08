import {
  BinaryReader,
  BinaryReaderState,
  SectionCode,
  type IImportEntry,
  type IMemoryType,
  type ISectionInformation,
  type ITableType,
  type ITypeEntry,
} from 'wasmparser';

// Node's server tsconfig doesn't import browser globals.
type Memory = { readonly buffer: ArrayBuffer; grow(pages: number): number };
type WasmFunction = (...args: number[]) => unknown;
const wasm = (
  globalThis as unknown as {
    WebAssembly: {
      Module: (new (bytes: Uint8Array) => object) & {
        imports(
          module: object,
        ): { module: string; name: string; kind: string }[];
      };
      Instance: new (
        module: object,
        imports: object,
      ) => { exports: Record<string, unknown> };
      Memory: new (limits: { initial: number; maximum: number }) => Memory;
    };
  }
).WebAssembly;

// The bundled QuickJS engine imports at least 256 pages.
export function createGuestMemory(initial: number, memoryBytes: number) {
  return new wasm.Memory({ initial, maximum: Math.floor(memoryBytes / 65536) });
}

function checkModule(bytes: Uint8Array<ArrayBuffer>, pageLimit: number) {
  const module = new wasm.Module(bytes);
  const imports = wasm.Module.imports(module);
  const memory = imports[0];
  if (
    imports.length !== 1 ||
    memory?.module !== 'env' ||
    memory.name !== 'memory' ||
    memory.kind !== 'memory'
  )
    throw new Error('A compute module must import only env.memory.');

  // V8 validates the instructions. Inspect the declarations it accepted before
  // instantiation: a private memory, GC heap or growing table bypasses our grant.
  const reader = new BinaryReader();
  reader.setData(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
    true,
  );
  let limits: { initial: number; maximum: number } | undefined;
  while (reader.read()) {
    switch (reader.state) {
      case BinaryReaderState.BEGIN_SECTION: {
        const { id } = reader.result as ISectionInformation;
        if (id === SectionCode.Memory || id === SectionCode.Tag)
          throw new Error(
            'Compute modules cannot declare private memory or exception tags.',
          );
        if (id === SectionCode.Table) {
          // Exactly one ordinary 32-bit funcref table with an explicit maximum.
          const at = reader.position;
          if (
            reader.data[at] !== 1 ||
            reader.data[at + 1] !== 0x70 ||
            reader.data[at + 2] !== 1
          )
            throw new Error(
              'A compute module can declare one bounded function table.',
            );
        } else if (id !== SectionCode.Type && id !== SectionCode.Import)
          reader.skipSection();
        break;
      }
      case BinaryReaderState.IMPORT_SECTION_ENTRY: {
        const memoryType = (reader.result as IImportEntry).type as IMemoryType;
        const { initial, maximum = pageLimit } = memoryType.limits;
        if (memoryType.shared || initial > pageLimit)
          throw new Error(
            'The compute module needs an unsupported memory grant.',
          );
        // Rust allocators acquire pages with memory.grow as they need them.
        limits = { initial, maximum: Math.min(maximum, pageLimit) };
        break;
      }
      case BinaryReaderState.TYPE_SECTION_ENTRY:
        if (!(reader.result as ITypeEntry).params)
          throw new Error('Compute modules may declare only function types.');
        break;
      case BinaryReaderState.BEGIN_REC_GROUP:
        throw new Error(
          'Compute modules cannot declare recursive type groups.',
        );
      case BinaryReaderState.TABLE_SECTION_ENTRY:
        if (((reader.result as ITableType).limits.maximum ?? Infinity) > 4096)
          throw new Error(
            'A compute module function table is limited to 4096 entries.',
          );
        break;
      case BinaryReaderState.END_WASM:
        if (!limits) throw new Error('Missing compute memory import.');
        return { module, limits };
      case BinaryReaderState.ERROR:
        throw reader.error;
      default:
        break;
    }
  }
  throw new Error('Incomplete compute module.');
}

export function loadComputeModule(
  bytes: Uint8Array<ArrayBuffer>,
  memoryBytes: number,
) {
  const { module, limits } = checkModule(
    bytes,
    Math.floor(memoryBytes / 65536),
  );
  const memory = new wasm.Memory(limits);
  const { exports } = new wasm.Instance(module, { env: { memory } });
  function getFunction(name: string): WasmFunction {
    const fn = exports[name];
    if (!Object.hasOwn(exports, name) || typeof fn !== 'function')
      throw new Error(`Missing compute function: ${name}.`);
    return fn as WasmFunction;
  }
  const alloc = getFunction('alloc');
  const dealloc = getFunction('dealloc');
  return (name: string, inputs: Iterable<Uint8Array>) => {
    if (name === 'alloc' || name === 'dealloc')
      throw new Error('Reserved compute function.');
    const fn = getFunction(name);
    const args: number[] = [];
    let total = 0;
    for (const input of inputs) {
      total += input.byteLength;
      if (total > memoryBytes)
        throw new Error('Compute inputs exceed the module memory limit.');
      const ptr = alloc(input.byteLength);
      if (typeof ptr !== 'number' || !Number.isInteger(ptr) || ptr < 0)
        throw new Error('The compute allocator returned an invalid pointer.');
      new Uint8Array(memory.buffer, ptr, input.byteLength).set(input);
      args.push(ptr, input.byteLength);
    }
    const result = fn(...args);
    if (typeof result !== 'bigint')
      throw new Error('A compute function must return an i64.');
    const packed = BigInt.asUintN(64, result);
    const ptr = Number(packed >> 32n);
    const length = Number(packed & 0xffffffffn);
    const output = new Uint8Array(memory.buffer, ptr, length);
    if (output[0] !== 0) {
      const message =
        output[0] === 1
          ? Buffer.from(output.subarray(1, 301)).toString('utf8')
          : '';
      if (length) dealloc(ptr, length);
      throw new Error(message || 'Invalid compute result.');
    }
    const answer = output.slice(1);
    dealloc(ptr, length);
    return answer.buffer;
  };
}
