# Focused test timing cleanup — 2026-10-30

Status: implemented for review; do not merge or deploy without operator approval.
Base: `1e8eae83ff1314f542879694d3bf4e3b47911486` (main after PR #80).

## Outcome and scope

Keep every existing case and behavior assertion in the four affected test files while removing unnecessary elapsed-time dependence and misleading warning output. No production code, test timeout, workflow, dependency, or global logging changes.

- `useNumberString`: advance a fake clock through the real 500 ms debounce, then assert the state directly. Unmount before restoring real timers. Also assert that the numeric value has not changed immediately after typing.
- `StreamProgramCalculator`: remove five 10 ms sleeps. `getCurrentLineupItem` already awaits both the history lookup and conditional write before returning, including the duplicate-playback branch. All original positive and negative call assertions remain.
- `ReviewLibraryTable`: the router Link mock forwards its anchor ref and props, removing the observed Material UI ref warning without suppressing logging.
- `i18n`: capture and assert exactly the expected missing-locale warning inside that one test, restoring the console spy in finally. Start from Spanish so the existing fallback test proves a transition to English.

The table and language-picker tests remain unchanged. Their rendering costs need profiling separately; this change does not claim to solve them. Intentional server failure-path logs, including the fake-clock FFmpeg shutdown warning, remain unchanged.

## Matched local measurements

Node 22.23.4, pnpm 10.28.0, Vitest 4.1.5 on the same macOS workstation. Three runs before changes, then three after. Same commands, file groups, dependencies, and default parallelism. Each run passed 20 web tests and 16 server tests. Values below are summed assertion durations in milliseconds from Vitest JSON output, not overall Build duration.

| File                              | Before runs (ms)          | After runs (ms)        | Median (ms)     |
| --------------------------------- | ------------------------- | ---------------------- | --------------- |
| `StreamProgramCalculator.test.ts` | 66.65, 66.80, 63.10       | 9.82, 9.60, 15.85      | 66.65 → 9.82    |
| `ReviewLibraryTable.test.tsx`     | 1023.07, 910.76, 922.52   | 917.90, 902.58, 902.63 | 922.52 → 902.63 |
| `i18n.test.ts`                    | 38.03, 36.81, 36.61       | 38.20, 38.58, 40.80    | 36.81 → 38.58   |
| `useNumberString.test.ts`         | 4626.17, 4613.31, 4617.36 | 22.41, 21.58, 23.92    | 4617.36 → 22.41 |

External process wall times (seconds, including pnpm/Vitest startup):

- Web before: 6.519, 6.505, 6.725; after: 5.834, 5.848, 5.819. Median 6.519 → 5.834 (~10.5% lower).
- Server before: 3.041, 2.987, 3.105; after: 3.372, 3.135, 4.558. Median 3.041 → 3.372. There is no measured server end-to-end speedup; startup and setup dominate this small suite.

The debounce cases remove about 4.60 seconds of summed test time. Parallel execution means that saving does not translate one-for-one into wall time. Three local samples are not evidence of a particular CI speedup.

Reproduction, from the named package directory:

```sh
# web; add --reporter=json --outputFile=<file> to retain per-case durations
pnpm exec vitest run --project unit src/hooks/useNumberString.test.ts src/components/ReviewLibraryTable.test.tsx src/test/i18n.test.ts
# server
pnpm exec vitest run src/stream/StreamProgramCalculator.test.ts
```

## Validation and limits

- All 36 affected tests pass in all three before and after runs; same case names/counts, no skips added.
- Web typecheck passes after rebuilding local types/shared outputs for the main baseline.
- Prettier and diff whitespace checks pass.
- The repository's normal lint-changed command excludes all `*.test.ts(x)` files and reports no files to lint. No lint policy changes made.
- The full server test typecheck is blocked by existing local MPEG-TS fixtures named `.ts` being parsed as TypeScript and the existing `tests/support/seed.ts` TS2883 declaration error. This is not claimed as a passing check.
- Hosted Build provides the normal combined-source checks; see the PR for current status. No full hosted-equivalent suite was run locally.
