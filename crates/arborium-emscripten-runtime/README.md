# arborium-emscripten-runtime

A new-architecture companion to `arborium-plugin-runtime`. Packages the
same plugin runtime as an emscripten `SIDE_MODULE=2` wasm so the entire
tree-sitter C runtime can live once (in `web-tree-sitter.wasm`, a
`MAIN_MODULE=2` built by upstream tree-sitter) and be shared across many
grammars loaded dynamically at runtime.

**Not a replacement** for the existing per-grammar wasm-bindgen plugins —
those continue to work unchanged. This is an additive new path a consumer
can opt into.

## Architecture

```
┌─────────────────────────────────┐
│ web-tree-sitter.wasm            │   MAIN_MODULE=2. Ships the tree-sitter
│   (upstream tree-sitter)        │   C runtime (~200 KB once, shared).
└──────────────▲──────────────────┘
               │ dynamic linking via loadWebAssemblyModule
       ┌───────┴────────┐
       │                │
┌──────┴──────────┐  ┌──┴──────────────────────────┐
│ tree-sitter-    │  │ arborium_emscripten_runtime  │
│ <grammar>.wasm  │  │ .wasm (this crate)           │
│                 │  │                              │
│ one per grammar │  │ one for the whole process;   │
│ just parser.c   │  │ owns session state + runs    │
│ (+ scanner.c)   │  │ highlights/injections/locals │
│ ~5-50 KB each   │  │ queries in Rust.             │
└─────────────────┘  └─────────────────────────────-┘
        ▲                      ▲
        │ tree_sitter_<lang>() │ arborium_rt_register_grammar(lang, queries…)
        └──────────────────────┘
                  calls originating from JS, all three
                  modules sharing one WASM linear memory.
```

The runtime loads once and serves all grammars. Each grammar registers
itself by handing over its `*const TSLanguage` and three query strings;
the runtime builds a `PluginRuntime` per grammar. Sessions are created
against a grammar handle, receive text, and produce JSON-encoded
`arborium_wire::Utf16ParseResult` payloads delivered through shared
memory.

## Building

Prereqs:

- [emsdk](https://github.com/emscripten-core/emsdk) 4.0.15 (matching the
  version upstream tree-sitter uses) on `PATH`.
- Nightly Rust with `rust-src` component (for `-Zbuild-std`).
- No rustup required; direct `rustc`/`cargo` from a nix / system install
  works. This crate does not touch `wasm32-unknown-unknown` and does not
  need that target installed.

Build:

```sh
cargo build --release
```

The `.cargo/config.toml` pins the target to `wasm32-unknown-emscripten`
and adds the right linker flags, so a plain `cargo build --release` from
this directory does the right thing. Output:

```
target/wasm32-unknown-emscripten/release/arborium_emscripten_runtime.wasm
```

Inspect exports:

```sh
llvm-objdump --syms target/.../arborium_emscripten_runtime.wasm | grep arborium_rt_
```

Expected: `arborium_rt_abi_version`, `arborium_rt_register_grammar`,
`arborium_rt_unregister_grammar`, `arborium_rt_create_session`,
`arborium_rt_free_session`, `arborium_rt_set_text`, `arborium_rt_cancel`,
`arborium_rt_parse_utf16`, `arborium_rt_free`.

## C ABI

```c
// Call immediately after loading the side module. Refuse to proceed on
// mismatch — bump on any breaking change to the functions below.
uint32_t arborium_rt_abi_version(void);

// Grammar lifecycle. `language` comes from the grammar's
// tree_sitter_<lang>() export. Queries may be NULL + len=0 for "empty".
// Returns a non-zero grammar ID, or 0 on failure.
uint32_t arborium_rt_register_grammar(
    const void* language,
    const uint8_t* highlights_ptr, uint32_t highlights_len,
    const uint8_t* injections_ptr, uint32_t injections_len,
    const uint8_t* locals_ptr,     uint32_t locals_len);
void     arborium_rt_unregister_grammar(uint32_t grammar_id);

// Session lifecycle. Returns a non-zero session ID, or 0 on failure.
uint32_t arborium_rt_create_session(uint32_t grammar_id);
void     arborium_rt_free_session(uint32_t session_id);

// Load UTF-8 text; triggers an immediate parse.
void     arborium_rt_set_text(uint32_t session_id,
                               const uint8_t* text_ptr, uint32_t text_len);
void     arborium_rt_cancel(uint32_t session_id);

// Execute queries; deliver JSON as (ptr, len) the caller owns. Return 0
// on success, non-zero on failure. Caller MUST return the buffer via
// arborium_rt_free(ptr, len).
int32_t  arborium_rt_parse_utf16(uint32_t session_id,
                                  uint8_t** out_ptr, uint32_t* out_len);
void     arborium_rt_free(uint8_t* ptr, uint32_t len);
```

JSON payload from `arborium_rt_parse_utf16`:

```json
{
  "spans": [
    { "start": 0, "end": 7, "capture": "keyword", "pattern_index": 3 },
    …
  ],
  "injections": [
    { "start": 42, "end": 99, "language": "javascript", "include_children": false }
  ]
}
```

Offsets are UTF-16 code-unit indices (matching JavaScript's `String.length`
and `slice()`), not byte indices — see `arborium_wire::Utf16ParseResult`.

## Minimal JS integration

```js
import MainModuleFactory from './web-tree-sitter.mjs';

const Module = await MainModuleFactory();

const runtime = await Module.loadWebAssemblyModule(
    await fetch('arborium_emscripten_runtime.wasm').then(r => r.arrayBuffer()),
    { loadAsync: true });

// ABI handshake.
if (runtime.arborium_rt_abi_version() !== 1) {
    throw new Error('arborium runtime ABI mismatch');
}

// Load a grammar side module.
const json = await Module.loadWebAssemblyModule(
    await fetch('tree-sitter-json.wasm').then(r => r.arrayBuffer()),
    { loadAsync: true });
const langPtr = json.tree_sitter_json();

// Allocate query strings in shared memory.
function putStr(s) {
    const bytes = new TextEncoder().encode(s);
    const p = Module._malloc(bytes.length);
    Module.HEAPU8.set(bytes, p);
    return [p, bytes.length];
}
const [hPtr, hLen] = putStr(HIGHLIGHTS_SCM);  // contents of highlights.scm
const [iPtr, iLen] = putStr('');
const [lPtr, lLen] = putStr('');

const grammarId = runtime.arborium_rt_register_grammar(
    langPtr, hPtr, hLen, iPtr, iLen, lPtr, lLen);
if (grammarId === 0) throw new Error('register_grammar failed');

// Parse.
const sessionId = runtime.arborium_rt_create_session(grammarId);
const [tPtr, tLen] = putStr('[1, 2, 3]');
runtime.arborium_rt_set_text(sessionId, tPtr, tLen);
Module._free(tPtr);

// Receive results.
const outPtr = Module._malloc(4);   // holds a u8* (wasm32 pointer)
const outLen = Module._malloc(4);   // holds a u32 length
const rc = runtime.arborium_rt_parse_utf16(sessionId, outPtr, outLen);
if (rc !== 0) throw new Error(`parse returned ${rc}`);
const jsonPtr = Module.getValue(outPtr, 'i32');
const jsonLen = Module.getValue(outLen, 'i32');
const payload = JSON.parse(Module.UTF8ToString(jsonPtr, jsonLen));
runtime.arborium_rt_free(jsonPtr, jsonLen);
Module._free(outPtr);
Module._free(outLen);

console.log(payload.spans, payload.injections);
```

## Known limitations

The runtime imports plain-named `ts_*` symbols (e.g. `ts_parser_new`,
`ts_tree_root_node`) that web-tree-sitter's upstream
`binding_web/lib/exports.txt` does not currently export — upstream only
exports the `*_wasm` JS-bridge variants. Until that list is extended
(small, mechanical follow-up PR to tree-sitter upstream), consumers of
this crate must build their own `web-tree-sitter.wasm` with the extra
exports. The spike branch `emscripten-dynlink-spike` in this repo
contains a reference `build-host.sh` that demonstrates the required
exports.

This is the only blocker to being fully drop-in against stock
web-tree-sitter. Once upstream has the extra exports, consumers can use
the npm-published `web-tree-sitter` unchanged.

## Stability

The `arborium_rt_*` ABI is versioned by the `ABI_VERSION` constant in
`src/lib.rs` and returned by `arborium_rt_abi_version()`. Bump on any
breaking change. Non-breaking additions (new functions) are allowed at
the same ABI version; consumers should ignore unknown functions.

## Non-goals

- Not a replacement for `arborium-plugin-runtime`. It depends on it.
- Not a replacement for the existing per-grammar wasm-bindgen plugins.
- Does not ship a prebuilt `.wasm`; consumers build it. See
  `PUBLISH.md` in the repo root if you're a maintainer considering
  adding this to the release pipeline.
