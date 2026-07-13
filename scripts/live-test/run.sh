#!/usr/bin/env bash
# Phase 56: invoke the live-test harness inside Electron; print only the RESULT json.
# Usage: bash scripts/live-test/run.sh '{"op":"counts"}'
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
OUT="$(node_modules/.bin/electron scripts/live-test/main.cjs "$1" 2>/dev/null)"
echo "$OUT" | grep '^RESULT:' | sed 's/^RESULT://'
