// This crate provides the wasm-sysroot path to dependent crates
// via the DEP_ARBORIUM_SYSROOT_PATH environment variable set by build.rs,
// and includes WASM allocator implementations for browser compatibility.

// Include the WASM allocator module when targeting WASM, but not for
// emscripten: emcc ships its own libc, so defining our own malloc/free
// here would produce duplicate-symbol link errors.
#[cfg(all(target_family = "wasm", not(target_os = "emscripten")))]
mod wasm;

// Re-export allocator symbols for external crates
#[cfg(all(target_family = "wasm", not(target_os = "emscripten")))]
pub use wasm::*;
