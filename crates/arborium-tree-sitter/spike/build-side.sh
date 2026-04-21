#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$ROOT":/src:Z \
  -w /src \
  docker.io/emscripten/emsdk:4.0.15 \
  emcc \
    -O2 \
    -fPIC \
    -std=c11 \
    -s SIDE_MODULE=2 \
    -s 'EXPORTED_FUNCTIONS=_try_ts' \
    -o spike/out/hello.wasm \
    spike/side/hello.c

ls -lh "${ROOT}/spike/out/hello.wasm"
