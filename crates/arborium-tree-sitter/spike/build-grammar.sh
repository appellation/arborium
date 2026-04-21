#!/usr/bin/env bash
set -euo pipefail

# Build the tree-sitter-json grammar as an emscripten SIDE_MODULE=2. Its one
# export, tree_sitter_json, returns a *const TSLanguage that the host +
# probe use to drive parsing.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
GRAMMAR_DIR="$(cd "$ROOT/../../langs/group-acorn/json/crate/grammar" && pwd)"

docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$GRAMMAR_DIR":/grammar:Z \
  -v "$HERE":/spike:Z \
  -w /grammar \
  docker.io/emscripten/emsdk:4.0.15 \
  emcc \
    -O2 \
    -fPIC \
    -std=c11 \
    -s SIDE_MODULE=2 \
    -s 'EXPORTED_FUNCTIONS=_tree_sitter_json' \
    -I src \
    -o /spike/out/tree-sitter-json.wasm \
    src/parser.c

ls -lh "${HERE}/out/tree-sitter-json.wasm"
