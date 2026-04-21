#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export EMSDK=/home/discord/.emsdk
export PATH=/home/discord/.emsdk/upstream/emscripten:/home/discord/.emsdk:$PATH
export EMSDK_NODE=/home/discord/.emsdk/node/22.16.0_64bit/bin/node

cd "$HERE/runtime-probe"
cargo build --release

OUT="$HERE/runtime-probe/target/wasm32-unknown-emscripten/release/runtime_probe.wasm"
DEST="$HERE/out/runtime-probe.wasm"
cp "$OUT" "$DEST"
ls -lh "$DEST"
