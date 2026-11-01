#!/bin/sh
# Starts the packaged server bundle under Bun, the runtime the fork's
# containers use. Lets scripts/worker-smoke-test.ts drive it via --binary.
exec bun "$(dirname "$0")/../dist/bundle.cjs" "$@"
