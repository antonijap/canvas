#!/usr/bin/env bash
# Builds the wasm engine and runs wasm-bindgen into engine/pkg.
set -euo pipefail
cd "$(dirname "$0")"
export RUSTFLAGS="${RUSTFLAGS:-} --cfg=web_sys_unstable_apis"
cargo build --release --target wasm32-unknown-unknown
rm -rf pkg
wasm-bindgen --target web --out-dir pkg target/wasm32-unknown-unknown/release/canvas_engine.wasm
ls -l pkg/*.wasm
gzip -9 -c pkg/canvas_engine_bg.wasm | wc -c | awk '{print "gzip bytes:", $1}'
