use arborium_tree_sitter::{Language, Parser, QueryCursor};
use core::slice;

// Drag arborium-plugin-runtime into the link so its transitive `ts_*` uses
// are pulled into the side module's import surface. Without this `use`
// the crate's code would be dead-code-eliminated and the probe wouldn't
// actually exercise the runtime.
use arborium_plugin_runtime as _;

#[unsafe(no_mangle)]
pub extern "C" fn try_ts() -> u32 {
    let _p = Parser::new();
    let _c = QueryCursor::new();
    0xCAFEu32
}

/// Parse UTF-8 `text` using the tree-sitter language at `lang_ptr` (obtained
/// from a grammar side module's `tree_sitter_<lang>()` export). Returns the
/// root node's named child count, or `u32::MAX` on failure.
///
/// The harness passes shared-heap pointers: since every module loaded via
/// `loadWebAssemblyModule` into web-tree-sitter's MAIN_MODULE shares one
/// WASM memory, `lang_ptr` and `text_ptr` are valid across module
/// boundaries without copying.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn try_parse(
    lang_ptr: *const core::ffi::c_void,
    text_ptr: *const u8,
    text_len: u32,
) -> u32 {
    let language = unsafe { Language::from_raw(lang_ptr as *const _) };
    let mut parser = Parser::new();
    if parser.set_language(&language).is_err() {
        return u32::MAX;
    }
    let bytes = unsafe { slice::from_raw_parts(text_ptr, text_len as usize) };
    let text = match core::str::from_utf8(bytes) {
        Ok(s) => s,
        Err(_) => return u32::MAX,
    };
    let Some(tree) = parser.parse(text, None) else {
        return u32::MAX;
    };
    tree.root_node().named_child_count() as u32
}
