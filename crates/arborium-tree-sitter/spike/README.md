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

## Step 2: Rust side module also works

A `no_std` Rust crate compiled to `wasm32-unknown-emscripten` and linked as
`SIDE_MODULE=2` produces a **byte-identical** 176-byte wasm to the C version
(`diff hello.wasm hello-rs.wasm` = no output). The harness returns the same
parser pointer (0x131a8). Rust's `extern "C"` declarations resolve against
the host exactly like C's.

```
$ node harness.mjs hello-rs.wasm
loading side module: hello-rs.wasm
side module exports: [ '__wasm_call_ctors', 'try_ts' ]
try_ts() returned: 78248 (type: number )
OK: cross-module symbol resolution works
```

Key findings from step 2:

- **No rustup needed.** The nix-provided nightly rustc is used directly;
  `-Zbuild-std=["core", "alloc"]` (in `side-rs/.cargo/config.toml`) builds
  core/alloc from the `rust-src` component for the emscripten target without
  needing a precompiled std tarball.
- **Native emcc needed** (emsdk 4.0.15 at `/home/discord/.emsdk`). The Rust
  emscripten target invokes emcc as the linker; the docker-in-a-loop trick
  used for the C build isn't viable for Rust because rustc passes many
  host-path arguments to the linker.
- **`-C relocation-model=pic` + `-C link-arg=-sSIDE_MODULE=2`** are
  sufficient linker flags. No `panic_unwind`, no `libstd` leakage, no
  unexpected imports.
- **Bigger crates may reveal more friction.** This spike is 3 extern calls
  and 1 export; `compiler-builtins` and `alloc` built cleanly, but real
  arborium code will pull in `std`, wasm-bindgen alternatives, etc.
  That's step 3.

## Step 3: plugin-runtime as SIDE_MODULE

A Rust crate that depends on `arborium-plugin-runtime` + `arborium-tree-sitter`,
compiled for `wasm32-unknown-emscripten` with `-sSIDE_MODULE=2`, loads into
web-tree-sitter and successfully calls into the tree-sitter C runtime via
dynamically-resolved symbols. The tree-sitter C code is **no longer statically
linked** into the side module.

```
$ node harness.mjs runtime-probe.wasm
loading side module: runtime-probe.wasm
side module exports: [ ... many Rust std symbols ..., 'try_ts', ... ]
try_ts() returned: 51966 (type: number )
OK: cross-module symbol resolution works
```

The probe's `try_ts()` calls `Parser::new()` + `QueryCursor::new()` +
`Drop::drop` on both, which transitively exercises 7 `ts_*` C symbols
(parser + query cursor alloc/dealloc + logger setup). All resolve against
the host at `loadWebAssemblyModule` time.

### Two targeted real-repo edits

Both are minimal, target-gated, and leave every non-emscripten build
untouched:

1. **`crates/arborium-tree-sitter/binding_rust/build.rs`** — early-return
   for `wasm32-unknown-emscripten` before the `cc::Build` step. Still
   copies `stdlib-symbols.txt` into OUT_DIR (consumers `include_str!` it)
   and emits `cargo:include`. Result: `ts_*` symbols become undefined
   imports resolved dynamically.
2. **`crates/arborium-sysroot/{build.rs,src/lib.rs}`** — narrow the wasm
   allocator gate to `not(target_os = "emscripten")`. Emcc provides its
   own libc, so compiling our dlmalloc-backed `malloc`/`free`/`realloc`
   on this target produces duplicate-symbol link errors.

### Sizes

| Artifact | Size |
|---|---|
| `web-tree-sitter.wasm` (MAIN_MODULE, 6 extra `ts_*` exports) | 194 KB |
| `runtime-probe.wasm` (Rust SIDE_MODULE, uses Parser + QueryCursor + std) | **55 KB** |

For comparison, step 2's side module with three `extern "C"` calls and no
Rust code was 176 bytes. Step 3's 55KB reflects the `std` machinery
(formatting, panic handling, alloc) that `arborium-plugin-runtime` pulls
in — not tree-sitter, which is now externalized.

### `ts_*` symbols discovered

By scanning `runtime-probe.wasm` for import strings:

```
ts_parser_delete          (already in binding_web/lib/exports.txt)
ts_parser_new             (added to spike/build-host.sh)
ts_parser_logger          (added)
ts_parser_print_dot_graphs (added)
ts_parser_set_logger      (added)
ts_query_cursor_new       (added)
ts_query_cursor_delete    (added)
```

A real grammar-driven build (step 4) will pull in many more: `ts_tree_*`,
`ts_query_*`, `ts_node_*`, etc. Same discovery method. Long-term these
should be promoted into `binding_web/lib/exports.txt` rather than living
in `build-host.sh`.

### Toolchain surprises

- `panic_immediate_abort` is no longer a `build-std-features` — it became
  a real panic strategy. Drop it from `.cargo/config.toml`; plain
  `panic = "abort"` in `[profile.release]` is sufficient.
- `binding_rust/lib.rs:3848` unconditionally `include_str!`s
  `stdlib-symbols.txt` from `OUT_DIR`. The emscripten early-return must
  still perform the `fs::copy` that puts the file there, even though no
  other build.rs work runs.

## Next (step 4)

Wire in a real grammar. Pick something small (JSON, TOML) and:

1. Compile its `parser.c` + `scanner.c` as a third `SIDE_MODULE=2` so
   web-tree-sitter's existing grammar loader can consume it.
2. Extend the probe (or create a new one) that obtains the grammar's
   `TSLanguage *` from web-tree-sitter, feeds it to `Parser::set_language`,
   parses a string, walks the resulting tree.
3. Compare vs. the existing `arborium-python` plugin size as a baseline.

## Reproducing

```
./build-host.sh              # emcc via docker, ~1 min cold, <10s warm
./build-side.sh              # C side module via docker
./build-side-rs.sh           # Rust side module via native emsdk
./build-side-probe.sh        # plugin-runtime side module
node harness.mjs                    # C side module
node harness.mjs hello-rs.wasm      # Rust side module
node harness.mjs runtime-probe.wasm # plugin-runtime side module
```

Prerequisites:
- docker (host + C side module builds)
- node (v22+)
- native emsdk at `/home/discord/.emsdk` (for Rust side modules; install
  with `git clone https://github.com/emscripten-core/emsdk && cd emsdk &&
  ./emsdk install 4.0.15 && ./emsdk activate 4.0.15`).

## Reproducing

```
./build-host.sh        # emcc via docker, ~1 min cold, <10s warm
./build-side.sh        # C side module via docker
./build-side-rs.sh     # Rust side module via native emsdk
node harness.mjs              # loads hello.wasm (C)
node harness.mjs hello-rs.wasm # loads the Rust version
```

Prerequisites:
- docker (for the host + C side module builds)
- node (v22+)
- **For the Rust side module only:** native emsdk at `/home/discord/.emsdk`.
  Install with `git clone https://github.com/emscripten-core/emsdk && cd emsdk && ./emsdk install 4.0.15 && ./emsdk activate 4.0.15`.
