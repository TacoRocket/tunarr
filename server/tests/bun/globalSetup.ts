// Builds the template database once before `bun test --parallel`, so workers
// do not race to create it. Mirrors vitest.config.ts `globalSetup`.
import { setup } from '../../src/testing/globalTestSetup.ts';

process.env.NODE_ENV = 'test';
process.env.TUNARR_USE_WORKER_POOL = 'false';
await setup();
