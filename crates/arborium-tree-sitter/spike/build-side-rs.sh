#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Local emsdk install; emcc must be in PATH for Rust's wasm32-unknown-emscripten
# target to link.
export EMSDK=/home/discord/.emsdk
export PATH=/home/discord/.emsdk/upstream/emscripten:/home/discord/.emsdk:$PATH
export EMSDK_NODE=/home/discord/.emsdk/node/22.16.0_64bit/bin/node

cd "$HERE/side-rs"
# This system uses a nix-provided nightly rustc directly (no rustup).
cargo build --release

OUT="$HERE/side-rs/target/wasm32-unknown-emscripten/release/ts_side_rs.wasm"
DEST="$HERE/out/hello-rs.wasm"
cp "$OUT" "$DEST"
ls -lh "$DEST"
