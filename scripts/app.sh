#!/bin/bash
# pnpm app: a fresh clone to the running Mac app in one command.
#   1. dependencies (pnpm install --frozen-lockfile) when node_modules is missing
#   2. the engine (engine/build.sh) when engine/pkg is missing: the wasm32 target and the pinned wasm-bindgen-cli
#      are added first if they are not there. --engine rebuilds it anyway (after changing engine/).
#   3. the app: apps/macos/build.sh into build/Canvas.app (git ignores build/), with this checkout's path in it, so
#      it finds its server wherever the clone lives
#   4. opens it
# Never touches the tracked apps/macos/Canvas.app.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\npnpm app: %s\n' "$*" >&2; exit 1; }

[ "$(uname)" = Darwin ] || fail "Canvas.app is a macOS app. Elsewhere, run the browser version: pnpm start"
xcrun --find swiftc >/dev/null 2>&1 || fail "there is no Swift compiler. Install the Xcode Command Line Tools (xcode-select --install), then run pnpm app again."

if [ ! -d node_modules ]; then
  step "Installing dependencies"
  pnpm install --frozen-lockfile
fi

if [ ! -f engine/pkg/canvas_engine.js ] || [ "${1:-}" = "--engine" ]; then
  command -v cargo >/dev/null 2>&1 && command -v rustup >/dev/null 2>&1 \
    || fail "the drawing engine needs Rust. Install it from https://rustup.rs (one command), open a new terminal, then run pnpm app again."
  if ! rustup target list --installed | grep -qx wasm32-unknown-unknown; then
    step "Adding Rust's WebAssembly target"
    rustup target add wasm32-unknown-unknown
  fi
  want="$(sed -n 's/^wasm-bindgen = "=\{0,1\}\([0-9.]*\)".*/\1/p' engine/Cargo.toml | head -1)"
  have="$(wasm-bindgen --version 2>/dev/null | awk '{print $2}' || true)"
  if [ "$have" != "$want" ]; then
    step "Installing wasm-bindgen-cli $want (a few minutes, once)"
    cargo install wasm-bindgen-cli --version "$want" --locked
  fi
  step "Building the engine (a few minutes the first time)"
  engine/build.sh
fi

step "Building Canvas.app"
CANVAS_APP_OUT="$ROOT/build/Canvas.app" CANVAS_REPO="$ROOT" apps/macos/build.sh

[ "${CANVAS_APP_NO_OPEN:-}" = 1 ] && exit 0 # tests: build only
step "Opening Canvas"
open "$ROOT/build/Canvas.app"
echo "Canvas is at build/Canvas.app. Drag it to Applications to keep it in the Dock; it runs this checkout's server."
