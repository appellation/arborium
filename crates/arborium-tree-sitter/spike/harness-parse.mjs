// Step 4 harness: drive an end-to-end JSON parse across three wasm modules.
//
//   MAIN_MODULE:  web-tree-sitter.wasm  (tree-sitter C runtime)
//   SIDE_MODULE:  tree-sitter-json.wasm (grammar)
//   SIDE_MODULE:  runtime-probe.wasm    (arborium-tree-sitter Rust wrappers
//                                        + arborium-plugin-runtime in the link)
//
// Grammar provides a TSLanguage pointer. Probe accepts it + a text buffer,
// parses via Parser::set_language + Parser::parse, returns the root node's
// named child count.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, 'out');

const { default: MainModuleFactory } = await import(resolve(outDir, 'web-tree-sitter.mjs'));
const Module = await MainModuleFactory();

const grammarBytes = await readFile(resolve(outDir, 'tree-sitter-json.wasm'));
const probeBytes   = await readFile(resolve(outDir, 'runtime-probe.wasm'));

const grammar = await Module.loadWebAssemblyModule(grammarBytes, { loadAsync: true });
const probe   = await Module.loadWebAssemblyModule(probeBytes,   { loadAsync: true });

const langPtr = grammar.tree_sitter_json();
console.log('tree_sitter_json() returned:', langPtr);
if (!langPtr) {
  console.error('FAIL: grammar returned null language pointer');
  process.exit(1);
}

// Allocate a UTF-8 text buffer in shared linear memory.
const text = '[1, 2, 3]';
const textBytes = new TextEncoder().encode(text);
const textPtr = Module._malloc(textBytes.length);
Module.HEAPU8.set(textBytes, textPtr);

const childCount = probe.try_parse(langPtr, textPtr, textBytes.length);
Module._free(textPtr);

console.log(`try_parse(${JSON.stringify(text)}) -> named_child_count = ${childCount}`);
if (childCount === 0xFFFFFFFF >>> 0) {
  console.error('FAIL: try_parse returned u32::MAX');
  process.exit(1);
}
// For JSON '[1, 2, 3]', root "document" has one named child (the array).
if (childCount !== 1) {
  console.error(`FAIL: expected named_child_count = 1, got ${childCount}`);
  process.exit(1);
}
console.log('OK: end-to-end parse via dynamically-linked tree-sitter works');
