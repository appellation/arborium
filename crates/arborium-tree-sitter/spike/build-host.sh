#!/usr/bin/env bash
set -euo pipefail

# Build web-tree-sitter.wasm (MAIN_MODULE=2) from the arborium fork.
# Flags mirror upstream crates/xtask/src/build_wasm.rs lines 214-245.
# Paths are adjusted: arborium's fork flattens `lib/` out, so upstream
# `lib/src/...` becomes `src/...` and `lib/binding_web/...` becomes
# `binding_web/...`.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT_REL="spike/out"

# Source files already end each symbol with ','. Strip quotes, prepend '_'
# to each line, join without inserting more commas, trim trailing ','.
EXPORTS="$(cat "$ROOT/src/wasm/stdlib-symbols.txt" "$ROOT/binding_web/lib/exports.txt" \
  | tr -d '"' \
  | sed 's/^/_/' \
  | tr -d '\n' \
  | sed 's/,$//')"

# Extra exports for the spike (not added to exports.txt so the fork stays
# untouched). ts_parser_new is needed so our side module can allocate a parser
# and prove symbol resolution works end-to-end.
EXPORTS="${EXPORTS},_ts_parser_new"

# Run emcc inside the upstream-pinned emscripten image, working in $ROOT.
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$ROOT":/src:Z \
  -w /src \
  docker.io/emscripten/emsdk:4.0.15 \
  emcc \
    -O3 --minify 0 \
    -gsource-map=inline \
    -fno-exceptions \
    -std=c11 \
    -s WASM=1 \
    -s MODULARIZE=1 \
    -s EXPORT_ES6=1 \
    -s INITIAL_MEMORY=33554432 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s SUPPORT_BIG_ENDIAN=1 \
    -s WASM_BIGINT=1 \
    -s MAIN_MODULE=2 \
    -s FILESYSTEM=0 \
    -s NODEJS_CATCH_EXIT=0 \
    -s NODEJS_CATCH_REJECTION=0 \
    -s "EXPORTED_FUNCTIONS=${EXPORTS}" \
    -s 'EXPORTED_RUNTIME_METHODS=AsciiToString,stringToUTF8,UTF8ToString,lengthBytesUTF8,stringToUTF16,loadWebAssemblyModule,getValue,setValue,HEAPF32,HEAPF64,HEAP_DATA_VIEW,HEAP8,HEAPU8,HEAP16,HEAPU16,HEAP32,HEAPU32,HEAP64,HEAPU64,LE_HEAP_STORE_I64' \
    -D 'fprintf(...)=' \
    -D 'printf(...)=' \
    -D 'NDEBUG=' \
    -D '_POSIX_C_SOURCE=200112L' \
    -D '_DEFAULT_SOURCE=' \
    -D '_BSD_SOURCE=' \
    -D '_DARWIN_C_SOURCE=' \
    -I src \
    -I include \
    --js-library binding_web/lib/imports.js \
    --pre-js     binding_web/lib/prefix.js \
    -o "${OUT_REL}/web-tree-sitter.mjs" \
    src/lib.c \
    binding_web/lib/tree-sitter.c

ls -lh "${ROOT}/${OUT_REL}/"
