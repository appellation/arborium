# Emscripten dynamic linking spike

Validates step 1 of the plan to split arborium's WASM runtime from per-grammar
bundles: **can a C `SIDE_MODULE` call `ts_*` symbols resolved against
web-tree-sitter's `MAIN_MODULE=2` wasm at load time?**

## Result: yes

```
$ node harness.mjs
side module exports: [ '__wasm_call_ctors', 'try_ts' ]
try_ts() returned: 78248 (type: number )
OK: cross-module symbol resolution works
```

`try_ts()` inside `hello.wasm` calls `ts_parser_new()`, `ts_parser_reset()`,
`ts_parser_delete()` as `extern` functions. None of those symbols exist in
the side module's own code; they're imports resolved by emscripten's
`loadWebAssemblyModule` loader against the host main module at load time.
A non-null parser pointer (0x131a8) confirms the call reached real host code.

## Sizes

| Artifact | Size |
|---|---|
| `web-tree-sitter.wasm` (MAIN_MODULE=2, -O3) | 193 KB |
| `web-tree-sitter.mjs` (loader + runtime bindings) | 82 KB |
| `hello.wasm` (SIDE_MODULE=2, 3 extern ts_* calls + 1 export) | **176 bytes** |

The side module size is the interesting number: it contains only the
dylink metadata, import table, and the function body itself. All
tree-sitter runtime code lives exactly once, in the main module.

## What's in here

- `build-host.sh` — invokes emcc (via `docker.io/emscripten/emsdk:4.0.15`)
  with upstream tree-sitter's flag set (from `crates/xtask/src/build_wasm.rs`
  on master), adapted for arborium's flattened fork layout. Appends
  `_ts_parser_new` to `EXPORTED_FUNCTIONS` so the side module can call it;
  the fork's `exports.txt` is not modified.
- `build-side.sh` — compiles `side/hello.c` with `-sSIDE_MODULE=2 -fPIC`.
- `side/hello.c` — one function (`try_ts`) that exercises three host `ts_*`
  symbols by name and returns the parser pointer as `uintptr_t`.
- `harness.mjs` — Node script that instantiates the main module,
  `Module.loadWebAssemblyModule(sideBytes, { loadAsync: true })`, invokes
  `try_ts()`, asserts nonzero.
- `out/` — build products.

## Key facts discovered

1. Upstream tree-sitter **already builds `web-tree-sitter.wasm` with
   `-s MAIN_MODULE=2`** and exports `loadWebAssemblyModule` as a runtime
   method. No upstream change needed — the dynamic-linking capability is
   already in place, it just wasn't being used for anything but grammars.
2. The arborium fork flattens upstream's `lib/` directory. Paths in the
   upstream xtask (`lib/src/lib.c`, `lib/binding_web/...`) become `src/lib.c`
   and `binding_web/...` here.
3. `exports.txt` drives which symbols `MAIN_MODULE=2` keeps alive for
   dynamic linking. Plain `ts_parser_new` is not in the fork's list;
   `ts_parser_new_wasm` (a JS-bridge variant) is. Adding plain names is a
   one-line change.

## Next step (step 2 of the plan)

Repeat this exercise with Rust: compile a trivial crate targeting
`wasm32-unknown-emscripten`, producing a `SIDE_MODULE=2` output, with one
`extern "C"` call to `ts_parser_new`. Confirm:
- `rustup target add wasm32-unknown-emscripten` + nightly `-Zbuild-std`
  produce a PIC side module.
- Rust's C-ABI declarations resolve against the host the same way hello.c's
  did.
- No `panic_unwind` or similar machinery sneaks in and blocks loading.

The real content lives in step 3 (porting `arborium-plugin-runtime`). Step 2
is the smallest possible Rust-specific proof so we can keep the variables
separated.

## Reproducing

```
./build-host.sh   # ~1 min first time (caches emscripten sysroot), <10s after
./build-side.sh   # <5s
node harness.mjs
```

Prerequisites: docker + node. No local emscripten install needed.
