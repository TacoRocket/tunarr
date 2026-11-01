# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Follow the contribution policy for AI agents in @AGENTS.md.

## Project Overview

Tunarr is a live TV channel creation platform that allows users to create custom TV channels using media from local files or remote media servers such as Plex, Jellyfin, or Emby servers. It's a TypeScript monorepo using pnpm workspaces and Turbo for task running.

## Repository Structure

This is a monorepo with four main packages:

- **server** (`@tunarr/server`): Bun container backend (Fastify server, SQLite database)
- **web** (`@tunarr/web`): React frontend (Vite + Material-UI)
- **types** (`@tunarr/types`): Shared TypeScript types and Zod schemas
- **shared** (`@tunarr/shared`): Utility functions shared between server and web

## Code Style

- Never cast types using `as any`
- Never use inline `import()` type annotations — use top-level `import type` statements instead
- All edits must comply with the project's oxlint rules. Run `pnpm lint-changed` to verify before considering work complete
- **Nullability checks**: Use truthiness for objects and arrays (`if (fade && fade.periodMins > 0)`, `if (!channel)`). For strings, use `isNonEmptyString` (it narrows the type and treats `''` as missing). Compare explicitly (`=== undefined`, `=== null`) only when a falsy value is valid data, such as a number that can be `0`.
- **Returning nothing**: Write `return;`, not `return undefined;`.
- **No unguarded non-null assertions (`!`)**: Never use `!` to assert a value is non-null/non-undefined without first narrowing its type via a conditional check, early return, or explicit throw. If a value is optional, either guard it with an `if` check that narrows the type, or throw an explicit error explaining the invariant. The `!` operator silently crashes at runtime when the assumption is wrong.

## Development Setup

### Package Manager & Task Runner

- Use **pnpm** (v12.15.0) for all dependency management - never use npm or yarn
- Use **Turbo** for running tasks across the monorepo
- Production containers run Bun, pinned in `.bun-version`. The build/test toolchain uses `.nvmrc`; it is not the production runtime.

### Version Control

- Releases use CalVer (`YYYY.M.PATCH`), so the version says when a release shipped, not what changed.
- The `main` branch creates "stable" releases. It receives fixes, chores, build/CI changes, docs, refactors, and small to medium features, including those with database migrations.
- The `dev` branch creates prereleases. It is reserved for large features that need many prerelease iterations before they reach stable, such as infinite schedules or remote streaming sources.

### Plans

For fork-only work, follow the private-records policy in `AGENTS.md`. The guidance
below applies to upstream planning documents.

- Write all plans, designs, and audits to `plans/` at the repo root. Never use `.claude/plans/`.
- Write issue investigations to `plans/investigations/`, named `issue-<n>-<slug>-YYYY-MM-DD.md`. These report whether a bug is real and why. A design that follows from one goes in `plans/`.
- Name files `<topic>.md`, adding a date suffix (`-YYYY-MM-DD`) for point-in-time reports.
- `.claude/settings.json` sets `plansDirectory` to `plans`, so plan-mode plans land there too.

### Fork CI and releases

- Use PRs targeting `main`; keep the existing tests and API/client checks for the combined fork source. Ready PRs run Build; drafts and prose-only changes do not. New commits cancel superseded validation runs.
- Merge only after validation against the current base and the review approval below. Main-push validation is intentionally absent. Branch protection is not configured, so this remains maintainer discipline. Exceptional direct pushes require a manual Build run.
- Before publishing, run Build manually with `ref` set to the exact `tunarrCommit` in `docker/fork-release.json` and confirm it passed. A check of a different source revision is not release validation.
- Publish only through the manual fork-container workflow. Keep its pinned runtime, cache and startup checks. Native platform packages and the documentation site belong to upstream; fork-specific documentation lives in `docs/fork/` only (no wiki, no other site); upstream doc pages under `docs/` stay byte-identical to upstream. Write fork docs in the friendly tone of `docs/fork/hardware-comparison.md`.
- Commit-message checks remain local. Contribution-policy decisions and issue closure are manual; no policy or expiry bot enforces them.
- Write release notes by hand in `docker/fork-release-notes.md`, in the same PR as the release pin, for a casual reader deciding whether to upgrade (see "Release cadence" in `docs/fork/container.md`). The Publish workflow posts them as the GitHub Release.
- When merging upstream, review new workflows before adopting them. Restore retired automation only for an identified fork need. See `plans/fork-ci-review-2026-10-28.md` for the retirement rationale.

### PR Review Labels

The maintainer cannot approve their own PRs on GitHub, so review agents record their verdict with labels.

| Label               | Meaning                                        |
| ------------------- | ---------------------------------------------- |
| `approved`          | Reviewed and ready to merge                    |
| `changes requested` | Review found issues; the PR needs another pass |

- A reviewer sets exactly one of these labels and removes the other.
- A reviewer also leaves a comment with the findings. The label carries the verdict and the comment carries the reasons.
- Whoever pushes new commits to an `approved` PR removes the label, because nobody has reviewed the new code.
- An author who addresses the findings removes `changes requested` so the PR returns to review.
- Only merge a PR labeled `approved`.
- Commands: `gh pr edit <n> --add-label approved --remove-label "changes requested"` and the reverse.

### Common Commands

- Build and typecheck through Turbo (`pnpm turbo build`, `pnpm turbo typecheck`). Turbo rebuilds the packages a package depends on first.
- To check a single package directly, run its own script (`pnpm typecheck` / `pnpm build` inside the package). These use `tsc -p tsconfig.build.json`. Never run a bare `tsc` without `-p tsconfig.build.json`, because the default `tsconfig.json` pulls in test files the build excludes.
- Neither `pnpm typecheck` nor `tsconfig.json` covers `server/tests/`. Only `tsconfig.test.json` does, so typecheck changes there with `pnpm exec tsc --noEmit -p tsconfig.test.json` inside `server`.

```bash
# Install dependencies
pnpm i

# Start all dev servers (backend on :8000, frontend on :5173/web)
pnpm turbo dev

# Build all packages
pnpm turbo build

# Run tests across all packages
pnpm turbo test

# Run single test file
cd server && pnpm test path/to/test.ts

# Format code
pnpm fmt

# Lint changed files only
pnpm lint-changed

# Run the typechecker
pnpm turbo typecheck

# Build the working tree into a Docker image and run it (see docker/test/)
pnpm docker-test

# Server-specific commands
cd server
pnpm dev              # Start server with tsx watch
pnpm debug            # Start server with debugger
pnpm kysely           # Run Kysely CLI for database operations
pnpm tunarr           # Run CLI commands (see src/cli/commands.ts)
pnpm generate-openapi # Generate OpenAPI spec
pnpm resolve-migrations # Regenerate this branch's migration after a merge/rebase conflict

# Web-specific commands
cd web
pnpm dev              # Start Vite dev server
pnpm bundle           # Build production bundle
pnpm generate-client  # Generate API client from OpenAPI spec
pnpm regen-routes     # Regenerate TanStack Router routes
```

## Architecture

### Server Architecture

**Framework & Dependencies:**

- **Fastify** for HTTP server with Zod-based type provider
- **Inversify** for dependency injection (IoC container in `container.ts`)
- **Kysely** + **Drizzle ORM** for database access (dual ORM approach, migrating to Drizzle)
- **better-sqlite3** for SQLite database
- **Meilisearch** for search functionality
- **Zod** for schema validation

**Key Directories:**

- `api/` - Fastify route handlers organized by domain (channels, plex, jellyfin, etc.)
- `db/` - Database layer with both Kysely and Drizzle implementations
  - `schema/` - Database schema definitions
  - `interfaces/` - DB interface abstractions
  - `ChannelDB.ts`, `ProgramDB.ts` - Main database access classes
- `services/` - Business logic layer (event handling, scheduling, media source integration)
  - `scanner/` - Media scanning functionality
  - `scheduling/` - Channel scheduling logic
  - `startup/` - Startup tasks
- `stream/` - Video streaming pipeline (HLS, concat streams, FFmpeg integration)
  - Organized by session type (`hls/`, `ConcatSession`); source-specific logic lives in stream details fetchers and `plugins/`
- `ffmpeg/` - FFmpeg wrapper and pipeline builder
- `external/` - External API clients for Plex, Jellyfin, Emby
- `tasks/` - Background tasks and fixers
- `cli/` - CLI commands (accessible via `pnpm tunarr <command>`)

**Dependency Injection:**
The server uses Inversify for DI. Service registration happens in module files:

- `container.ts` - Root container and module registration
- `DBModule.ts` - Database services
- `ServicesModule.ts` - Business services
- `StreamModule.ts` - Streaming services
- `FFmpegModule.ts` - FFmpeg services
- `TasksModule.ts` - Bindings for tasks

Other modules are files ending with `Module.ts`

To inject dependencies, use the `@injectable()` decorator and constructor injection with `@inject(KEYS.ServiceName)`. Keys are defined in `types/inject.ts`.

**Database:**
The codebase uses both Kysely (legacy) and Drizzle ORM (current/future):

- Schema is defined in `db/schema/` using Drizzle
- Most queries still use Kysely but new code should use Drizzle
- Access via `DBAccess` which provides both `db` (Kysely) and `drizzle` (Drizzle) instances
- Database migrations are in `migration/`

### Web Architecture

**Framework & Libraries:**

- **React 18** with TypeScript
- **Vite** for bundling and dev server
- **Material-UI (MUI)** v7 for components
- **TanStack Router** for routing (file-based routes in `routes/`)
- **TanStack Query** for data fetching and caching
- **Zustand** for global state management
- **React Hook Form** for form handling
- **Zod** for form/data validation

**Key Directories:**

- `routes/` - File-based routing (generates `routeTree.gen.ts`)
- `components/` - Reusable React components
- `hooks/` - Custom React hooks
- `store/` - Zustand state stores
- `generated/` - Auto-generated API client code
- `pages/` - Legacy page components (being migrated to routes/)

**API Integration:**
The web app uses a generated API client (`generated/`) created from the server's OpenAPI spec. Regenerate with `pnpm generate-client` when server API changes.

### Shared Packages

**@tunarr/types:**

- Type definitions and Zod schemas shared between server and web
- Organized by domain: `plex/`, `jellyfin/`, `emby/`, `api/`, `schemas/`
- Build with `pnpm build` to generate `.d.ts` and `.js` files

**@tunarr/shared:**

- Utility functions for both server and web
- Notable: Custom DSL parser for scheduling/filtering (uses Chevrotain)

## Testing

- **A test starts out failing.** Write it first and watch it fail for the reason you expect, then make it pass. A bug fix adds a test that fails without the fix. A review concern becomes a test only once it names a concrete wrong result (this input gives this wrong output) or reproduces the fault.
- **New features prove themselves by running the real path,** with the evidence in the PR description: what was run, what was checked, and what was not exercised. Don't add tests that only restate what new code already does. They have never caught anything, and they make the next refactor a fight.
- **Keep a test only while it names the failure it catches.** A test that asserts behavior nobody wants is a deletion candidate, not a design constraint. Test count is not evidence.
- **Deterministic only.** No sleeps, retries or timing thresholds to make a test pass, and no dependence on the machine's time zone or clock; inject them.
- PRs to upstream Tunarr follow upstream's testing rule instead.

### Test layers, from most to fewest

1. **Unit tests at the smallest owner of the behavior.** Most tests live here. Test through the smallest existing owner. Extract logic only when that creates a meaningful boundary and is necessary to isolate the demonstrated failure. Hand it its inputs instead of seeding a database, search index or running server to produce them. One test answers one layer's question.
2. **Recorded-fixture tests.** Real data captured once and replayed: a probed file's stream list, a `vainfo` dump, a real subtitle display set. This is how we cover hardware we don't own: fixtures prove our decisions and generated commands for the recorded capabilities. Run fallback paths end to end on our hardware with a capability override, adding one when a fallback path has none. Say "untested on X" only for what needs the device itself: driver bugs and throughput.
3. **Real-path runs.** Run the built feature against real data, recorded in the PR description rather than committed.
4. **Integration and end-to-end tests.** Not ordinary coverage. Add one only when a unit or fixture test cannot prove an observed failure, and say which boundary the smaller test can't reach. Ask the maintainer before adding a new one. The route sweep below is the existing exception.

- **Bun is the default server test runtime.** `pnpm --filter @tunarr/server test` runs files listed in `server/tests/bun/green-files.txt` under Bun and the remaining files under Vitest on Node. Each server file runs once; both groups must pass. New files run on Node until verified under Bun and added to the list (`bun tests/bun/run.ts --candidates` reports candidates). Never remove a file to make the run green. Setup is in `server/tests/bun/preload.ts`.
- `pnpm --filter @tunarr/server test <file-path>` selects matching paths in their assigned runtime. `test:bun` runs only the Bun group; `test:node` explicitly runs the full server suite on Node and supports Vitest-specific flags. The watch/local scripts also remain Vitest commands.
- **Web and shared tests use Vitest.** CI has one blocking Build job: the normal build/API checks, the nonoverlapping test groups, and the packaged Bun worker smoke check. It does not run a second full server suite under Node.
- Test files use `.test.ts` extension
- Run tests with `pnpm turbo test` or `pnpm test:watch` for watch mode
- Server tests often use `@faker-js/faker` for test data generation

### E2E route sweep (`e2e/`)

- Playwright suite that visits every web route against a seeded server. Local only; CI does not run it yet.
- Run with `cd e2e && pnpm e2e`. First time only: `pnpm e2e:install-browsers`. Needs `ffmpeg` on the PATH and the Meilisearch binary (`cd server && pnpm install-meilisearch`).
- Uses its own ports (server 18000, search 17700, web 15173), so it can run beside `pnpm turbo dev`.
- The fixture is rebuilt on every run: generated test clips, three local media sources, three channels, a custom show, a filler list, and a smart collection (`e2e/fixture/seed.ts`).
- A route fails on uncaught exceptions, `console.error` output (including React warnings), 5xx API responses, or the error page.
- New routes must be added to `e2e/tests/routes.ts`; a coverage test compares it against `routeTree.gen.ts`.
- Pre-existing warnings are listed per route in `e2e/tests/knownIssues.ts`. Remove an entry when its cause is fixed.

## Code Style

- Prettier for formatting (config in root `package.json`)
- oxlint for linting (config in `.oxlintrc.json` at the root, extended per package)
- Husky + lint-staged for pre-commit hooks
- Import aliases: Use `@/` for server, web has configured path aliases

## Important Implementation Notes

### When changing the behavior of features

- Always update relevant documentation.
- Double-check for unintended side-effects of the change

### When Working with Database Code:

- Prefer Drizzle ORM for new queries over Kysely
- Both ORMs access the same SQLite database via `DBAccess`
- Database interfaces are in `db/interfaces/` - implement these for new DB access classes
- Use dependency injection to get database instances
- All database schema changes should have migrations generated via `pnpm drizzle-kit generate`

### When Working with Slot Schedules:

- Time slots and random slots are being deprecated in favor of infinite schedules (`architecture/infinite-schedules/README.md`, "Deprecation plan").
- A PR that adds or changes classic slot-scheduler behavior must add a row to `architecture/infinite-schedules/parity-checklist.md`.

### When Working with Streaming:

- Streaming logic is complex - see `stream/` directory
- Sessions are managed by `SessionManager`
- Different stream types: `VideoStream`, `ConcatSession`, `DirectStreamSession`
- FFmpeg pipeline is built using builder pattern in `ffmpeg/builder/`

### When Working with External Media Sources:

- External API clients are in `external/` (Plex, Jellyfin, Emby)
- Canonicalization logic converts external media to Tunarr's internal format
- Media scanning is handled by scanner services in `services/scanner/`
- Media source libraries are refreshed via `MediaSourceLibraryRefresher`

### When Adding API Endpoints:

1. Define route in `server/src/api/{domain}Api.ts`
2. Use Fastify + Zod type provider for type-safe requests/responses
3. Register in `api/index.ts`
4. Regenerate OpenAPI spec: `cd server && pnpm generate-openapi`
5. Regenerate web client: `cd web && pnpm generate-client`

### When Working with NFO Files:

- NFO parsing is in `server/src/nfo/`
- Different parsers for different media types (TV shows, movies, etc.)
- Uses Zod schemas defined in `NfoSchemas.ts`

## Build & Deployment

- Production server runs the CommonJS bundle with Bun and the external better-sqlite3 Node-API package. Use the default Dockerfile and manual container workflow; do not deploy a native Node executable over the Bun service.
- `make-bin` is a separate native-package compatibility path, not the fork container release path.
- Web builds static assets with Vite
- macOS app bundle support in `macos/` directory
- Fork Docker releases: `ghcr.io/tacorocket/tunarr`; see `docs/fork/container.md`.
