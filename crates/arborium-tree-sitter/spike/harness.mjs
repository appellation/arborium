// Spike harness: instantiate web-tree-sitter.wasm (emscripten MAIN_MODULE=2),
// dynamically load hello.wasm (SIDE_MODULE=2), call its try_ts() export.
// Success = receives a nonzero pointer, proving the host's ts_parser_new
// symbol was resolved into the side module's import slot at load time.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, 'out');

const { default: MainModuleFactory } = await import(resolve(outDir, 'web-tree-sitter.mjs'));
const Module = await MainModuleFactory();

const sideBytes = await readFile(resolve(outDir, 'hello.wasm'));
const exports = await Module.loadWebAssemblyModule(sideBytes, { loadAsync: true });

console.log('side module exports:', Object.keys(exports));
const result = exports.try_ts();
console.log('try_ts() returned:', result, '(type:', typeof result, ')');

if (!result) {
  console.error('FAIL: try_ts returned 0 — ts_parser_new produced null');
  process.exit(1);
}
console.log('OK: cross-module symbol resolution works');
