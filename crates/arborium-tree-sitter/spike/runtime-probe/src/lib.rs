use arborium_tree_sitter::{Parser, QueryCursor};

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
