/**
 * Query executor for arborium grammar plugins.
 *
 * This is a TypeScript port of the query execution logic from
 * crates/arborium-plugin-runtime/src/lib.rs. It uses web-tree-sitter's
 * Query API to execute highlight and injection queries on parsed trees.
 */

import type { Utf8ParseResult, Utf8Span, Utf8Injection } from "./types.js";
import type { Query, Tree, Node } from "web-tree-sitter";

/**
 * Compiled query configuration for a grammar.
 *
 * Mirrors the Rust HighlightConfig struct from arborium-plugin-runtime.
 * The combined query concatenates injections + locals + highlights in order,
 * and we track pattern index boundaries to route matches correctly.
 */
export interface QueryConfig {
  /** The compiled combined query (injections + locals + highlights). */
  query: Query;
  /** Pattern index where locals section starts. */
  localsPatternIndex: number;
  /** Pattern index where highlights section starts. */
  highlightsPatternIndex: number;
}

/**
 * Build a combined query from separate injection, locals, and highlights queries.
 *
 * Concatenation order matches the Rust HighlightConfig::new:
 *   injections_query + "\n" + locals_query + "\n" + highlights_query
 *
 * Pattern index boundaries are computed by checking each pattern's start byte
 * offset against the section boundaries in the concatenated source.
 */
/**
 * Concatenate query sources in the correct order for buildQueryConfig.
 * Returns the combined source and byte offsets for each section boundary.
 */
export function concatenateQueries(
  highlightsQuery: string,
  injectionsQuery: string,
  localsQuery: string,
): { source: string; localsOffset: number; highlightsOffset: number } {
  let source = "";

  source += injectionsQuery;
  if (injectionsQuery.length > 0 && !injectionsQuery.endsWith("\n")) {
    source += "\n";
  }
  const localsOffset = source.length;

  source += localsQuery;
  if (localsQuery.length > 0 && !localsQuery.endsWith("\n")) {
    source += "\n";
  }
  const highlightsOffset = source.length;

  source += highlightsQuery;

  return { source, localsOffset, highlightsOffset };
}

/**
 * Build a QueryConfig from a pre-constructed Query and the section offsets.
 *
 * The caller is responsible for constructing the Query object from the
 * concatenated source returned by concatenateQueries().
 */
export function buildQueryConfig(
  query: Query,
  localsQueryOffset: number,
  highlightsQueryOffset: number,
): QueryConfig {

  // Find pattern indices for each section
  let localsPatternIndex = 0;
  let highlightsPatternIndex = 0;
  const patternCount = query.patternCount();
  for (let i = 0; i < patternCount; i++) {
    const patternOffset = query.startIndexForPattern(i);
    if (patternOffset < highlightsQueryOffset) {
      highlightsPatternIndex++;
      if (patternOffset < localsQueryOffset) {
        localsPatternIndex++;
      }
    }
  }

  return { query, localsPatternIndex, highlightsPatternIndex };
}

/**
 * Execute queries on a parsed tree and return highlight spans and injections.
 *
 * This is a faithful port of PluginRuntime::parse_raw (lines 314-435)
 * from crates/arborium-plugin-runtime/src/lib.rs.
 *
 * Returns UTF-8 byte offsets, which is what web-tree-sitter nodes natively provide
 * via node.startIndex / node.endIndex.
 */
export function executeQuery(
  config: QueryConfig,
  tree: Tree,
  source: string,
): Utf8ParseResult {
  const rootNode = tree.rootNode;
  const matches = config.query.matches(rootNode);

  const spans: Utf8Span[] = [];
  const injections: Utf8Injection[] = [];

  for (const match of matches) {
    // Route by pattern index section
    if (match.patternIndex < config.localsPatternIndex) {
      // Injection pattern
      let languageName: string | undefined;
      let contentNode: Node | undefined;
      let includeChildren = false;

      for (const capture of match.captures) {
        if (capture.name === "injection.language") {
          languageName = capture.node.text;
        } else if (capture.name === "injection.content") {
          contentNode = capture.node;
        }
      }

      // Check #set! predicates for injection properties
      const props = match.setProperties;
      if (props) {
        if (props["injection.language"] != null && languageName == null) {
          languageName = props["injection.language"];
        }
        if ("injection.include-children" in props) {
          includeChildren = true;
        }
      }

      if (languageName != null && contentNode != null) {
        injections.push({
          start: contentNode.startIndex,
          end: contentNode.endIndex,
          language: languageName,
          includeChildren,
        });
      }

      continue;
    }

    // Skip locals patterns
    if (match.patternIndex < config.highlightsPatternIndex) {
      continue;
    }

    // Highlight pattern — extract captures
    for (const capture of match.captures) {
      const captureName = capture.name;

      // Skip internal captures (starting with underscore)
      if (captureName.startsWith("_")) continue;

      // Skip injection-related captures
      if (captureName.startsWith("injection.")) continue;

      // Skip local-related captures
      if (captureName.startsWith("local.")) continue;

      const node = capture.node;
      spans.push({
        start: node.startIndex,
        end: node.endIndex,
        capture: captureName,
        pattern_index: match.patternIndex,
      });
    }
  }

  // Sort spans by (start, end) for consistent output
  spans.sort((a, b) => a.start - b.start || a.end - b.end);

  return { spans, injections };
}

/**
 * Batch convert UTF-8 byte offsets to UTF-16 code unit indices.
 *
 * Port of batch_utf8_to_utf16 from arborium-plugin-runtime/src/lib.rs (lines 62-101).
 * This is O(n + m) where n is string length and m is number of offsets.
 *
 * The offsets array must be sorted in ascending order.
 */
export function batchUtf8ToUtf16(text: string, offsets: number[]): number[] {
  const results: number[] = [];
  if (offsets.length === 0) return results;

  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);

  let offsetIdx = 0;
  let utf16Index = 0;
  let byteIndex = 0;

  for (let i = 0; i < text.length; i++) {
    // Emit results for all offsets at or before current byte position
    while (offsetIdx < offsets.length && byteIndex >= offsets[offsetIdx]) {
      results.push(utf16Index);
      offsetIdx++;
    }

    if (offsetIdx >= offsets.length) break;

    const codePoint = text.codePointAt(i)!;
    const charByteLen =
      codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    byteIndex += charByteLen;

    // Surrogate pairs (code points >= 0x10000) use 2 UTF-16 code units
    if (codePoint >= 0x10000) {
      utf16Index += 2;
      i++; // Skip the low surrogate in the string
    } else {
      utf16Index += 1;
    }
  }

  // Handle any remaining offsets at or past the end
  while (offsetIdx < offsets.length) {
    results.push(utf16Index);
    offsetIdx++;
  }

  return results;
}

/**
 * Convert a Utf8ParseResult to UTF-16 offsets.
 *
 * Port of PluginRuntime::parse_utf16 from arborium-plugin-runtime/src/lib.rs (lines 480-537).
 */
export function convertToUtf16(
  text: string,
  result: Utf8ParseResult,
): { spans: Array<{ start: number; end: number; capture: string; pattern_index: number }>; injections: Array<{ start: number; end: number; language: string; includeChildren: boolean }> } {
  if (result.spans.length === 0 && result.injections.length === 0) {
    return { spans: [], injections: [] };
  }

  // Collect all byte offsets and batch convert
  const allOffsets: number[] = [];
  for (const span of result.spans) {
    allOffsets.push(span.start);
    allOffsets.push(span.end);
  }
  for (const inj of result.injections) {
    allOffsets.push(inj.start);
    allOffsets.push(inj.end);
  }
  allOffsets.sort((a, b) => a - b);

  const utf16Offsets = batchUtf8ToUtf16(text, allOffsets);

  // Build lookup from byte offset to UTF-16 offset via binary search
  const lookup = (byteOffset: number): number => {
    let lo = 0;
    let hi = allOffsets.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (allOffsets[mid] < byteOffset) lo = mid + 1;
      else hi = mid;
    }
    return utf16Offsets[lo] ?? 0;
  };

  const spans = result.spans.map((s) => ({
    start: lookup(s.start),
    end: lookup(s.end),
    capture: s.capture,
    pattern_index: s.pattern_index,
  }));

  // Re-sort after offset conversion
  spans.sort((a, b) => a.start - b.start || a.end - b.end);

  const injections = result.injections.map((i) => ({
    start: lookup(i.start),
    end: lookup(i.end),
    language: i.language,
    includeChildren: i.includeChildren,
  }));

  return { spans, injections };
}
