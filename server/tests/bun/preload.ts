// Runs the Vitest suite under Bun's test runner, which is the runtime the
// fork's containers use. Mirrors server/vitest.config.ts and fills the gaps in
// Bun's Vitest compatibility here, so upstream test files run unchanged.
import * as bunTest from 'bun:test';
import { expect, setSystemTime, test, vi } from 'bun:test';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

// vitest.config.ts `env`
process.env.NODE_ENV = 'test';
process.env.TUNARR_USE_WORKER_POOL = 'false';

// vitest.config.ts `setupFiles`
await import('zod/compile');
await import('../../src/testing/matchers/PixelFormatMatcher.ts');
await import('../../src/testing/matchers/FrameSizeMatcher.ts');

// vitest.config.ts `globalSetup`. The template database is built once by
// tests/bun/globalSetup.ts before the run; build it here only if missing.
const { setup, templateDbPath } = await import(
  '../../src/testing/globalTestSetup.ts'
);
if (!existsSync(templateDbPath)) {
  await setup();
}

// --- vi APIs Bun does not provide ---------------------------------------
type Vi = typeof vi & Record<string, unknown>;
const v = vi as Vi;

// Type-only in Vitest: returns its argument.
v.mocked ??= <T>(value: T) => value;

const stubbedEnv = new Map<string, string | undefined>();
v.stubEnv ??= (name: string, value: string | undefined) => {
  if (!stubbedEnv.has(name)) stubbedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return vi;
};
v.unstubAllEnvs ??= () => {
  for (const [name, value] of stubbedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  stubbedEnv.clear();
  return vi;
};

v.hoisted ??= <T>(factory: () => T) => factory();

v.setSystemTime ??= (time: number | string | Date) => {
  setSystemTime(new Date(time));
  return vi;
};

// Captured before any test fakes timers.
const realSetTimeout = globalThis.setTimeout;

// Like Vitest: with fake timers on, each retry advances them by `interval`.
v.waitFor ??= async <T>(
  callback: () => T | Promise<T>,
  options: number | { timeout?: number; interval?: number } = {},
) => {
  const { timeout = 1000, interval = 50 } =
    typeof options === 'number' ? { timeout: options } : options;
  const deadline = Date.now() + timeout;
  let waited = 0;
  for (;;) {
    try {
      return await callback();
    } catch (error) {
      if (Date.now() >= deadline || waited >= timeout) throw error;
      if (vi.isFakeTimers()) vi.advanceTimersByTime(interval);
      await new Promise((resolve) => realSetTimeout(resolve, interval));
      waited += interval;
    }
  }
};

// Vitest can fake only Date (`toFake: ['Date']`); Bun fakes every timer,
// which stalls anything awaiting setTimeout. Fake just the clock then.
const bunUseFakeTimers = vi.useFakeTimers.bind(vi);
const bunUseRealTimers = vi.useRealTimers.bind(vi);
let fakingOnlyDate = false;
v.useFakeTimers = (options?: { toFake?: string[] }) => {
  if (options?.toFake?.length && options.toFake.every((n) => n === 'Date')) {
    fakingOnlyDate = true;
    setSystemTime(new Date());
    return vi;
  }
  return bunUseFakeTimers(options as never);
};
v.useRealTimers = () => {
  if (fakingOnlyDate) {
    fakingOnlyDate = false;
    setSystemTime();
    return vi;
  }
  return bunUseRealTimers();
};

v.advanceTimersByTimeAsync ??= async (ms: number) => {
  vi.advanceTimersByTime(ms);
  await Promise.resolve();
  return vi;
};

// --- chai-style assertions (expect(x).to.eq(y)) --------------------------
// Vitest's expect includes chai's BDD chain. Capture the received value with
// a matcher, then hand it to the same chai Vitest uses.
const requireFrom = (from: string) => createRequire(from);
const vitestEntry = requireFrom(import.meta.path).resolve('vitest');
const expectEntry = requireFrom(vitestEntry).resolve('@vitest/expect');
const chai = requireFrom(expectEntry)('chai') as typeof import('chai');

let received: unknown;
let negated = false;
expect.extend({
  __tunarrCaptureReceived(this: { isNot: boolean }, value: unknown) {
    received = value;
    negated = this.isNot;
    // Always succeeds, negated or not; chai makes the real assertion.
    return { pass: !this.isNot, message: () => '' };
  },
});

// Vitest's assertion object is a chai Assertion, so chai's chain words and
// methods (`.to.eq`, `.length(3)`, `.greaterThan(1)`, `.includes(x)`) work on it
// directly. Expose every chai name Bun's expect lacks, delegating to chai.
const matchersProto = Object.getPrototypeOf(expect(undefined)) as object;
const chaiNames = new Set<string>();
for (
  let proto: object | null = chai.Assertion.prototype;
  proto && proto !== Object.prototype;
  proto = Object.getPrototypeOf(proto)
) {
  for (const name of Object.getOwnPropertyNames(proto)) chaiNames.add(name);
}
for (const name of chaiNames) {
  if (name === 'constructor' || name.startsWith('_') || name in matchersProto) {
    continue;
  }
  Object.defineProperty(matchersProto, name, {
    configurable: true,
    get(this: { __tunarrCaptureReceived: () => void }) {
      this.__tunarrCaptureReceived();
      const base = chai.expect(received);
      const assertion = negated ? base.not : base;
      const value: unknown = assertion[name as keyof Chai.Assertion];
      // `expect(x).length(2)` calls the method with Bun's expect object as
      // `this`; keep chai's assertion as `this` while preserving chained
      // properties on the method.
      return typeof value === 'function'
        ? new Proxy(value, {
            apply: (target, _thisArg, args) =>
              Reflect.apply(target, assertion, args),
          })
        : value;
    },
  });
}

// Vitest-only matchers.
expect.extend({
  toHaveBeenCalledExactlyOnceWith(
    this: { equals: (a: unknown, b: unknown) => boolean },
    received: { mock?: { calls: unknown[][] } },
    ...expected: unknown[]
  ) {
    const calls = received?.mock?.calls ?? [];
    const pass = calls.length === 1 && this.equals(calls[0], expected);
    return {
      pass,
      message: () =>
        `expected exactly one call with ${JSON.stringify(expected)}, got ${JSON.stringify(calls)}`,
    };
  },
});

// --- test.extend fixtures ---------------------------------------------------
type FixtureFn = (
  ctx: Record<string, unknown>,
  use: (value: unknown) => Promise<void>,
) => Promise<void>;
type Fixtures = Record<string, FixtureFn | unknown>;
type TestFn = (ctx: Record<string, unknown>) => unknown;

// Fixtures are set up in definition order, each wrapping the next, and torn
// down in reverse once the test finishes, like Vitest's `use` callback.
function withFixtures(fixtures: Fixtures, fn: TestFn) {
  const names = Object.keys(fixtures);
  return async () => {
    const ctx: Record<string, unknown> = {};
    const runFrom = async (i: number): Promise<void> => {
      if (i === names.length) {
        await fn(ctx);
        return;
      }
      const name = names[i]!;
      const fixture = fixtures[name];
      if (typeof fixture !== 'function') {
        ctx[name] = fixture;
        return runFrom(i + 1);
      }
      let used = false;
      await (fixture as FixtureFn)(ctx, async (value) => {
        used = true;
        ctx[name] = value;
        await runFrom(i + 1);
      });
      if (!used) throw new Error(`Fixture "${name}" never called use()`);
    };
    await runFrom(0);
  };
}

function extendTest(
  base: typeof test,
  inherited: Fixtures,
  fixtures: Fixtures,
) {
  const all = { ...inherited, ...fixtures };
  const wrap =
    (
      register: (name: string, fn: () => Promise<void>, opts?: unknown) => void,
    ) =>
    (name: string, fn: TestFn, opts?: unknown) =>
      register(name, withFixtures(all, fn), opts);
  const extended = Object.assign(wrap(base as never), {
    skip: wrap(base.skip as never),
    only: wrap(base.only as never),
    todo: base.todo,
    skipIf: (condition: boolean) => wrap(base.skipIf(condition) as never),
    for:
      (cases: unknown[]) =>
      (name: string, fn: (testCase: unknown, ctx: object) => unknown) =>
        base.each(cases.map((c) => [c]))(name, (c: unknown) =>
          withFixtures(all, (ctx) => fn(c, ctx))(),
        ),
    extend: (more: Fixtures) => extendTest(base, all, more),
  });
  return extended;
}

(test as unknown as Record<string, unknown>).extend ??= (fixtures: Fixtures) =>
  extendTest(test, {}, fixtures);

// test.for(cases)(name, (testCase, context) => ...)
(test as unknown as Record<string, unknown>).for ??=
  (cases: unknown[]) =>
  (name: string, fn: (testCase: unknown, ctx: object) => unknown) =>
    test.each(cases.map((c) => [c]))(name, (c: unknown) => fn(c, {}));

// Node's --expose-gc global, used by heap measurements.
(globalThis as Record<string, unknown>).gc ??= () => Bun.gc(true);

// vitest.config.ts `globals: true`: files may use describe/test/expect without
// importing them.
for (const name of [
  'describe',
  'it',
  'test',
  'expect',
  'beforeAll',
  'afterAll',
  'beforeEach',
  'afterEach',
  'vi',
] as const) {
  (globalThis as Record<string, unknown>)[name] ??= bunTest[name];
}
