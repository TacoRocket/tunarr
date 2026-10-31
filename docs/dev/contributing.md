# Contributing

Thank you for your interest in contributing to Tunarr! This guide will help you get started with development.

This copy describes TacoRocket's fork. Its contribution policies are reviewed by maintainers, without upstream's policy, stale-item or release-comment bots. See the [fork CI and release process](../fork/container.md#ci-and-release-checks). Contributions sent upstream follow [upstream's current policy](https://tunarr.com/dev/contributing/).

## Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js 22** or later
- **pnpm 12.15.0** or later (do not use npm or yarn; easiest to use `corepack` to get the right version)
- **Git**
- **FFmpeg** (for testing streaming features)

## Getting Started

### 1. Fork and Clone

1. Fork the repository on GitHub: [chrisbenincasa/tunarr](https://github.com/chrisbenincasa/tunarr)
2. Clone your fork locally:

```bash
git clone https://github.com/YOUR_USERNAME/tunarr.git
cd tunarr
```

### 2. Install Dependencies

```bash
pnpm i
```

### 3. Start Development Servers

```bash
pnpm turbo dev
```

This starts:

- **Backend server** on `http://localhost:8000`
- **Frontend dev server** on `http://localhost:5173/web`

## Dev Containers

The repository ships two [dev container](https://containers.dev/) configurations in `.devcontainer/`. Both include Node 22, pnpm, ffmpeg 7.1.1, and the Meilisearch binary, and both build `@tunarr/types` and `@tunarr/shared` on creation.

| Configuration | Use it for | Extra setup |
|---------------|------------|-------------|
| **Tunarr: Testing** | Running unit tests and the e2e route sweep | Playwright Chromium and its system libraries |
| **Tunarr: PR Review** | Checking out and reviewing a pull request | None, so it starts faster |

VS Code asks which configuration to use when you run **Dev Containers: Reopen in Container**.

### Reviewing a pull request in a container

Use either route. Both clone the repository into an isolated Docker volume, so your local checkout stays untouched.

- **Dev Containers extension:** run **Dev Containers: Clone Repository in Container Volume**, paste the pull request URL, and pick **Tunarr: PR Review**.
- **GitHub Pull Requests extension:** right-click the pull request in the GitHub view and choose **Checkout Pull Request in Dev Container**.

The container builds from the pull request's own `.devcontainer/`, so a PR that changes the container config is reviewed in the changed container.

## Repository Structure

Tunarr is a monorepo with four main packages:

| Package | Path | Description |
|---------|------|-------------|
| `@tunarr/server` | `server/` | Node.js backend (Fastify, SQLite) |
| `@tunarr/web` | `web/` | React frontend (Vite, Material-UI) |
| `@tunarr/types` | `types/` | Shared TypeScript types and Zod schemas |
| `@tunarr/shared` | `shared/` | Utility functions shared between packages |

## Common Commands

### Root-Level Commands

```bash
# Install all dependencies
pnpm i

# Start all dev servers
pnpm turbo dev

# Build all packages
pnpm turbo build

# Run all tests
pnpm turbo test

# Run the typechecker
pnpm turbo typecheck

# Format code with Prettier
pnpm fmt

# Lint changed files only
pnpm lint-changed
```

### Server Commands

```bash
cd server

pnpm dev              # Start server with hot reload
pnpm debug            # Start server with debugger attached
pnpm test             # Run server tests
pnpm test path/to/test.ts  # Run a single test file
pnpm generate-openapi # Regenerate OpenAPI spec
pnpm kysely           # Run Kysely CLI for database operations
pnpm tunarr           # Run CLI commands
```

### Web Commands

```bash
cd web

pnpm dev              # Start Vite dev server
pnpm bundle           # Build production bundle
pnpm generate-client  # Regenerate API client from OpenAPI spec
pnpm regen-routes     # Regenerate TanStack Router routes
```

## Development Workflow

### Making Changes

1. Create a new branch from `main`, or from `dev` for a large feature (see [base branch](#pull-request-guidelines)):

    ```bash
    git checkout main
    git pull origin main
    git checkout -b feature/your-feature-name
    ```

2. Make your changes
3. Ensure code passes all checks:

    ```bash
    pnpm fmt
    pnpm lint-changed
    pnpm turbo typecheck
    pnpm turbo test
    ```

4. Commit your changes using [conventional commit](#commit-messages) format
5. Push your branch and open a Pull Request against the branch you started from

### Adding API Endpoints

When adding new API endpoints, follow these steps:

1. Define your route in `server/src/api/{domain}Api.ts`
2. Use Fastify with the Zod type provider for type-safe requests/responses
3. Register the route in `server/src/api/index.ts`
4. Regenerate the OpenAPI spec:

    ```bash
    cd server && pnpm generate-openapi
    ```

5. Regenerate the web client:

    ```bash
    cd web && pnpm generate-client
    ```

### Database Changes

The codebase uses both Kysely (legacy) and Drizzle ORM:

- **New code should use Drizzle ORM**
- Schema definitions are in `server/src/db/schema/`
- Database migrations are in `server/src/migration/`
- Access the database via `DBAccess`, which provides both `db` (Kysely) and `drizzle` (Drizzle) instances

### Working with Dependencies

When adding new services or components that need dependency injection:

1. Define your service key in `server/src/types/inject.ts`
2. Register your service in the appropriate module:
    - `DBModule.ts` for database services
    - `ServicesModule.ts` for business logic services
    - `StreamModule.ts` for streaming services
    - `FFmpegModule.ts` for FFmpeg-related services
3. Use `@injectable()` decorator and `@inject(KEYS.ServiceName)` for constructor injection

## Code Style

### General Guidelines

- **TypeScript**: All code must be written in TypeScript
- **No `as any`**: Never cast types using `as any`
- **Formatting**: Prettier handles formatting (run `pnpm fmt`)
- **Linting**: oxlint (config in `.oxlintrc.json`)
- **Pre-commit hooks**: Husky + lint-staged run automatically

### Import Aliases

- Server: Use `@/` prefix (e.g., `import { foo } from '@/services/foo'`)
- Web: Uses configured path aliases

## Pre-Commit Hooks

Tunarr uses [Husky](https://typicode.github.io/husky/) and [lint-staged](https://github.com/lint-staged/lint-staged) to automatically run checks before each commit. These hooks are installed automatically when you run `pnpm i`.

### What Runs on Commit

When you commit, the following checks run automatically on staged files:

- **Prettier** - Formats code and auto-fixes formatting issues
- **oxlint** - Lints code and reports errors

If any check fails, the commit will be blocked. Fix the reported issues and try again.

### Bypassing Hooks (Not Recommended)

In rare cases where you need to skip pre-commit hooks:

```bash
git commit --no-verify -m "your message"
```

!!! warning
    Only bypass hooks when absolutely necessary. Formatting, oxlint and commit-message checks remain local; hosted CI does not replace them.

### Troubleshooting Hooks

If hooks aren't running after cloning:

```bash
pnpm i  # Reinstall dependencies to set up hooks
```

If hooks are misconfigured or you need to reinstall them:

```bash
pnpm exec husky install
```

## Commit Messages

Tunarr uses [Conventional Commits](https://www.conventionalcommits.org/) for commit messages. This standardized format enables automatic changelog generation and makes the git history easier to read.

### Format

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

### Types

| Type | Description |
|------|-------------|
| `feat` | A new feature |
| `fix` | A bug fix |
| `docs` | Documentation changes only |
| `style` | Code style changes (formatting, semicolons, etc.) |
| `refactor` | Code changes that neither fix bugs nor add features |
| `perf` | Performance improvements |
| `test` | Adding or updating tests |
| `chore` | Maintenance tasks (deps, build config, etc.) |
| `ci` | CI/CD configuration changes |

### Scope (Optional)

The scope indicates which part of the codebase is affected:

- `server` - Backend changes
- `web` - Frontend changes
- `types` - Shared types package
- `shared` - Shared utilities package
- `docs` - Documentation
- `deps` - Dependency updates

### Examples

```bash
# Feature
git commit -m "feat(web): add dark mode toggle to settings"

# Bug fix
git commit -m "fix(server): resolve race condition in stream cleanup"

# Documentation
git commit -m "docs: update contributing guide with commit conventions"

# Refactor with scope
git commit -m "refactor(server): migrate channel queries to Drizzle"

# Chore without scope
git commit -m "chore: update dependencies"

# Breaking change (add ! after type)
git commit -m "feat(api)!: change channel endpoint response format"
```

### Commit Message Body

For complex changes, add a body to explain **what** and **why**:

```bash
git commit -m "fix(server): handle null media duration gracefully

Previously, media items with null duration would cause the scheduler
to crash. This change treats null duration as 0 and logs a warning.

Fixes #1234"
```

### Closing Issues on Release

`Fixes #1234` closes the issue when the PR merges. If closure should wait until a fork container release, leave the issue open and identify that requirement in the PR. The maintainer confirms the release and closes it manually; this fork does not process `Closes-on-release` markers or post automatic release comments.

## Testing

- **Framework**: Vitest
- **Test files**: Use `.test.ts` extension
- **Test data**: Use `@faker-js/faker` for generating test data

```bash
# Run all tests
pnpm turbo test

# Run tests in watch mode
pnpm test:watch

# Run a single test file
cd server && pnpm test path/to/file.test.ts
```

## Testing a Build in Docker

`pnpm docker-test` builds your working tree into the production Docker image and runs it. Use it to test a change on real hardware, such as a GPU transcoding pipeline, on your own machine or on a remote server.

It layers three compose files from `docker/test/`:

| Layer | File | Committed |
|-------|------|-----------|
| Base | `compose.yaml` | Yes |
| Hardware pipeline | `pipelines/<name>.compose.yaml` | Yes |
| Your Docker host | `local.compose.yaml` (optional) | No |

Settings that differ between machines live in `docker/test/.env`, which is also ignored by git.

### Docker Host Requirements

- Docker Engine 23 or later
- A user that can run `docker` without `sudo`
- For the `vaapi` and `qsv` pipelines: a working GPU driver, so that `/dev/dri` exists
- For the `nvidia` pipeline: the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)

### Setup

1. Copy the templates:

    ```bash
    cp docker/test/.env.example docker/test/.env
    cp docker/test/local.compose.example.yaml docker/test/local.compose.yaml  # optional
    ```

2. Edit `docker/test/.env`. Set `TUNARR_TEST_DATA_DIR` and choose a `TUNARR_TEST_PIPELINE` (`none`, `vaapi`, `qsv`, or `nvidia`).
3. Add your media mounts to `docker/test/local.compose.yaml`, if you need any.
4. To run on a remote server, create a Docker context that reaches it over SSH and set `TUNARR_TEST_DOCKER_CONTEXT` to its name:

    ```bash
    docker context create my-server --docker "host=ssh://user@my-server"
    ```

!!! warning
    Every path in `.env` and `local.compose.yaml` is a path on the Docker host. With a remote context, that is the server, not your machine. Docker creates a missing host path as an empty directory instead of reporting an error.

!!! warning
    Point `TUNARR_TEST_DATA_DIR` at a directory set aside for testing, or at a copy of your data. A test build may run database migrations.

### Commands

```bash
pnpm docker-test              # Build the working tree and start it
pnpm docker-test logs -f      # Follow the logs
pnpm docker-test config       # Print the merged compose file without running anything
pnpm docker-test down         # Stop and remove the container
pnpm docker-test repro        # Run the stream-repro script in a throwaway container
```

`pnpm docker-test repro` builds the same image and runs `.claude/skills/stream-repro/scripts/repro.mjs` inside a throwaway container with the pipeline's GPU, then copies its report back to a local temp directory. Options after `repro` go to the script; see `.claude/skills/stream-repro/SKILL.md`.

Any other arguments are passed to `docker compose`. The build includes uncommitted changes. The server listens on port `8001` by default, so the web UI is at `http://<docker-host>:8001/web`.

### Adding a Pipeline

Add `docker/test/pipelines/<name>.compose.yaml` containing only the settings that pipeline needs. `TUNARR_TEST_PIPELINE=<name>` then selects it.

## Architecture Overview

### Server

- **Fastify** for HTTP server with Zod type provider
- **Inversify** for dependency injection
- **Drizzle ORM** (preferred) and **Kysely** (legacy) for database access
- **better-sqlite3** for SQLite database
- **Meilisearch** for search functionality

Key directories:

- `api/` - Route handlers organized by domain
- `db/` - Database layer and schema
- `services/` - Business logic
- `stream/` - Video streaming pipeline
- `ffmpeg/` - FFmpeg wrapper and pipeline builder
- `external/` - API clients for Plex, Jellyfin, Emby

### Web

- **React 18** with TypeScript
- **Vite** for bundling
- **Material-UI v7** for components
- **TanStack Router** for file-based routing
- **TanStack Query** for data fetching
- **Zustand** for state management
- **React Hook Form** + **Zod** for forms

Key directories:

- `routes/` - File-based routing
- `components/` - Reusable components
- `hooks/` - Custom React hooks
- `store/` - Zustand stores
- `generated/` - Auto-generated API client

## Getting Help

- **GitHub Issues**: [Report bugs or request features](https://github.com/chrisbenincasa/tunarr/issues)
- **Discord**: [Join the community](https://discord.gg/JpFjERP7y) for discussion and support

## Pull Request Policy

These rules apply to every PR, however it was written. They apply to maintainers too.

### You own every line

- You are the author of everything in your PR, whoever or whatever typed it.
- You must understand each change well enough to explain it in review.
- You must have run the change yourself and confirmed it does what the PR says.
- "The AI wrote that part" is not an answer to a review question.

### Design before code

Some changes need an agreed design before anyone writes code. Open an issue first and describe the design. A maintainer approves it by adding the `design approved` label. Then open the PR and link the issue in the "Design issue" section of the PR description.

A change needs a design issue if it does any of the following:

- Adds a new media source type or a new kind of stream source
- Changes the database schema (adds a migration)
- Adds a new runtime dependency
- Adds a new top-level feature, such as a new page, settings area, or scheduling mode
- Changes code in more than one package (`server`, `web`, `types`, `shared`) in a way that changes how they talk to each other, such as a new API shape or shared type
- Changes more than **500 lines** outside tests, or more than **1,500 lines** including tests. Neither count includes the generated files listed below.

The line counts leave out these generated files:

- `pnpm-lock.yaml`
- `server/src/migration/db/sql/meta/`
- `server/src/generated/`, `web/src/generated/`, `docs/generated/`
- `web/src/routeTree.gen.ts`
- `web/src/locales/`

The design issue should cover:

- The problem, and who has it
- The approach, and the main alternatives you rejected
- Which parts of the codebase change, and any schema or API changes
- How you will split the work into PRs that can each be reviewed on their own

Large mechanical changes, such as a rename or the same fix repeated across many files, can skip the size limit. A maintainer decides by adding the `mechanical` label to the PR. The other triggers still apply. If you're planning a big mechanical change, ask in an issue first, because it may conflict with other open work.

Small fixes, docs changes, and refactors inside one module don't need a design issue. If you're unsure, ask in an issue or on Discord before you start.

### Manual policy review

Maintainers check the design requirements and AI disclosure during review. They can request a design, move a PR to draft or apply `needs design` and `needs policy fix` with an explanation. Authors address the request and ask for another review. There is no `/recheck` command, automatic draft conversion or timed closure in this fork.

Maintainers are listed in [the fork's CODEOWNERS](https://github.com/TacoRocket/tunarr/blob/main/.github/CODEOWNERS). As described in `AGENTS.md`, maintainers are exempt from the preliminary design check. The `approved` label records review approval; it is not set or enforced by a policy bot.

Outside contributors should keep at most five ready PRs open at once. Maintainers handle exceptions and stale work directly, without scheduled jobs.

### During review

- Address each comment with a change scoped to that comment. Don't regenerate or rewrite unrelated code, because that forces the reviewer to start over.
- If you don't know why your code does something, say so. Then find out before you change it.
- A PR whose author can't answer questions about their own code will be closed.
- A maintainer may label a PR `needs policy fix` for a contribution-policy or [AI use](#ai-use) issue, explain the required correction and remove the label after review.
- Maintainers decide when to close inactive work. No scheduled workflow warns or closes issues or PRs.

## AI Use

You may use AI tools to write code, tests, docs, and issues for Tunarr. The [Pull Request Policy](#pull-request-policy) applies the same way with or without AI. The rules below add to it.

### Disclose AI use

Every PR description says whether you used AI tools, in the "AI use" section of the PR template. If you did, name the tools and say what they did. For example:

- "Claude Code wrote most of the implementation. I wrote the tests and reviewed every change."
- "No AI tools used."

Disclosure is not a mark against your PR. It tells the reviewer where to look harder.

- Autocomplete that finishes the line you're typing doesn't need disclosure. Anything that writes whole functions, files, or changes does.
- Commit trailers such as `Co-Authored-By` are fine to keep but don't replace the PR statement. If your commits or PR description credit an AI tool and your "AI use" section says you used none, the maintainer will ask you to fix the section.

A maintainer may ask how you used AI. If your answer turns out to be false, the review ends and the PR is closed. Maintainers act on concrete evidence, such as AI tool trailers in your commits or your own statements. They don't act on how the code looks. Without such evidence, they ask questions about the code instead.

### AI in review replies

Write review replies yourself. You may use AI to understand a comment or check your answer, but don't paste model output into the thread.

### Issues and bug reports

AI can help you write an issue, but the content must come from you.

- **Bug reports.** Report what you saw. Your steps, logs, and screenshots must come from your own Tunarr install. If you include a guess about the cause, mark it as a guess. You may include an AI analysis of the cause, but put it in the bug template's "AI analysis" field and say whether you checked it. Maintainers treat unchecked AI analysis as a lead, not a finding.
- **Feature requests.** Describe the problem you have and how you would use the feature. A short request from you beats a long spec from a model.
- **Design issues.** A design issue is held to the same rule as a PR. You must understand the design and be able to answer questions about it. Use the "Design proposal" issue template, which asks you to disclose AI use.
- **Comments.** Don't answer other people's questions with AI output you haven't checked.

Issues that are mostly unchecked AI output will be closed.

### Security reports

Report vulnerabilities privately through [GitHub's vulnerability reporting](https://github.com/chrisbenincasa/tunarr/security/advisories/new), not in a public issue. See [SECURITY.md](https://github.com/chrisbenincasa/tunarr/blob/main/.github/SECURITY.md).

A report must include steps that reproduce the problem against a real Tunarr build. Output from an AI or a scanner that you haven't confirmed will be closed without a detailed response.

## Pull Request Guidelines

1. **Base branch** 
    1. **Target the `main` branch** by default. This includes fixes, chores, refactors, and small to medium features, even when they add a database migration.
    2. **Target `main` in this fork**, including agreed feature work. When contributing upstream, follow its current branch policy instead.
2. **Keep PRs focused** - one feature or fix per PR
3. **Use conventional commits** - follow the [commit message format](#commit-messages)
4. **Ensure all checks pass** before requesting review
5. **Update documentation** if your change affects user-facing behavior
6. **Add tests** for new functionality when applicable
