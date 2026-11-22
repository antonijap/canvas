#!/bin/bash
# Rebuilds engine/pkg when the engine sources are newer than the build. The build is git-ignored, so a checkout
# can carry an old one, and the app, the perf gate and native QA would all run that old engine without saying so.
set -euo pipefail
cd "$(dirname "$0")/.."
wasm=engine/pkg/canvas_engine_bg.wasm
if [ ! -f "$wasm" ] || [ -n "$(find engine/src engine/Cargo.toml engine/Cargo.lock -newer "$wasm" -print -quit 2>/dev/null)" ]; then
  echo "Rebuilding the engine (its sources are newer than engine/pkg)" >&2
  engine/build.sh >/dev/null
fi
