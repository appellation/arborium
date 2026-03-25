/**
 * Arborium loader - loads grammar plugins and highlights code.
 *
 * Architecture:
 * 1. Grammar registry is bundled at build time (no network request needed in production)
 *    - Can be overridden via pluginsUrl config for local development
 * 2. Load standard tree-sitter language .wasm files on demand from @arborium/<lang> packages
 * 3. Use web-tree-sitter as shared runtime for parsing and query execution
 * 4. arborium-host (Rust WASM) handles injection recursion and HTML rendering
 */

import type {
  Utf8ParseResult,
  Utf16ParseResult,
  ArboriumConfig,
  Grammar,
  Session,
} from "./types.js";
import { availableLanguages, pluginVersion } from "./plugins-manifest.js";
import { escapeHtml } from "./utils.js";
import { concatenateQueries, buildQueryConfig, executeQuery, convertToUtf16, type QueryConfig } from "./query-executor.js";
import { Parser, Query as QueryClass, Language, type Query, type Tree } from "web-tree-sitter";

/** Build a QueryConfig from query strings and a language */
function makeQueryConfig(
  language: Language,
  highlightsQuery: string,
  injectionsQuery: string,
  localsQuery: string,
): QueryConfig {
  const { source, localsOffset, highlightsOffset } = concatenateQueries(
    highlightsQuery,
    injectionsQuery,
    localsQuery,
  );
  const query = new QueryClass(language, source);
  return buildQueryConfig(query, localsOffset, highlightsOffset);
}

// Default config
export const defaultConfig: Required<ArboriumConfig> = {
  manual: false,
  theme: "one-dark",
  selector: "pre code",
  cdn: "jsdelivr",
  version: pluginVersion, // Precise version from manifest
  pluginsUrl: "", // Empty means use bundled manifest
  hostUrl: "", // Empty means use CDN based on version
  logger: console,
  resolveHostJs: ({ baseUrl, path }) => import(/* @vite-ignore */ `${baseUrl}/${path}`),
  resolveHostWasm: ({ baseUrl, path }) => fetch(`${baseUrl}/${path}`),
  resolveWasm: ({ baseUrl, path }) => fetch(`${baseUrl}/${path}`),
  resolveText: ({ baseUrl, path }) => fetch(`${baseUrl}/${path}`).then((r) => r.ok ? r.text() : ""),
};

// Rust host module (loaded on demand)
interface HostModule {
  highlight: (language: string, source: string) => Promise<string>;
  isLanguageAvailable: (language: string) => boolean;
}
let hostModule: HostModule | null = null;
let hostLoadPromise: Promise<HostModule | null> | null = null;

// Merged config
let globalConfig: Required<ArboriumConfig> = { ...defaultConfig };

// Grammar plugins cache
const grammarCache = new Map<string, GrammarPlugin>();

// In-flight grammar load promises (to prevent double-loading)
const grammarLoadPromises = new Map<string, Promise<GrammarPlugin | null>>();

// Languages we know are available (bundled at build time)
const knownLanguages: Set<string> = new Set(availableLanguages);

// web-tree-sitter initialization
let parserInitPromise: Promise<void> | null = null;

/** Initialize web-tree-sitter runtime (once) */
async function ensureParserInit(config: Required<ArboriumConfig>): Promise<void> {
  if (!parserInitPromise) {
    parserInitPromise = Parser.init({
      locateFile: () => {
        const hostUrl = getHostUrl(config);
        return `${hostUrl}/web-tree-sitter.wasm`;
      },
    });
  }
  return parserInitPromise;
}

// For local development: can override with pluginsUrl to load from dev server
interface LocalManifest {
  entries: Array<{
    language: string;
    local_wasm: string;
  }>;
}
let localManifest: LocalManifest | null = null;
let localManifestPromise: Promise<void> | null = null;

/** Load local manifest if pluginsUrl is configured (for dev server) */
async function ensureLocalManifest(config: Required<ArboriumConfig>): Promise<void> {
  if (!config.pluginsUrl) {
    return;
  }

  if (localManifestPromise) {
    return localManifestPromise;
  }

  localManifestPromise = (async () => {
    config.logger.debug(`[arborium] Loading local plugins manifest from: ${config.pluginsUrl}`);
    const response = await fetch(config.pluginsUrl);
    if (!response.ok) {
      throw new Error(`Failed to load plugins.json: ${response.status}`);
    }
    localManifest = await response.json();
    config.logger.debug(`[arborium] Loaded local manifest with ${localManifest?.entries.length} entries`);
  })();

  return localManifestPromise;
}

/** Get the CDN base URL for a grammar */
function getGrammarBaseUrl(language: string, config: Required<ArboriumConfig>): string {
  // If we have a local manifest (dev mode), use the local path
  if (localManifest) {
    const entry = localManifest.entries.find((e) => e.language === language);
    if (entry) {
      // Extract base URL from local_wasm path (e.g., "/langs/group-hazel/python/npm/language.wasm" -> "/langs/group-hazel/python/npm")
      return entry.local_wasm.substring(0, entry.local_wasm.lastIndexOf("/"));
    }
  }

  // Production: derive from language name using precise version
  const cdn = config.cdn;
  const version = config.version;
  let baseUrl: string;
  if (cdn === "jsdelivr") {
    baseUrl = "https://cdn.jsdelivr.net/npm";
  } else if (cdn === "unpkg") {
    baseUrl = "https://unpkg.com";
  } else {
    baseUrl = cdn;
  }
  return `${baseUrl}/@arborium/${language}@${version}`;
}

type MaybePromise<T> = Promise<T> | T;

// See https://github.com/wasm-bindgen/wasm-bindgen/blob/dda4821ee2fbcaa7adc58bc8c385ed8d3627a272/crates/cli-support/src/js/mod.rs#L860
/** Source of the WASM module for wasm-bindgen */
type WbgInitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

/** wasm-bindgen host module interface (for arborium-host only) */
interface WasmBindgenHost {
  default: (
    module_or_path?: { module_or_path: MaybePromise<WbgInitInput> } | undefined,
  ) => Promise<void>;
  highlight(language: string, source: string): Promise<string>;
  isLanguageAvailable(language: string): boolean;
}

/** A loaded grammar plugin backed by web-tree-sitter */
interface GrammarPlugin {
  languageId: string;
  injectionLanguages: string[];
  language: Language;
  queryConfig: QueryConfig;
  /** Parse returning UTF-8 offsets (for Rust host) */
  parseUtf8: (text: string) => Utf8ParseResult;
  /** Parse returning UTF-16 offsets (for JavaScript public API) */
  parseUtf16: (text: string) => Utf16ParseResult;
}

/** Create a Parser instance configured for a language */
function createParserForLanguage(language: Language): Parser {
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

/** Load a grammar plugin */
async function loadGrammarPlugin(
  language: string,
  config: Required<ArboriumConfig>,
): Promise<GrammarPlugin | null> {
  // Check cache first
  const cached = grammarCache.get(language);
  if (cached) {
    config.logger.debug(`[arborium] Grammar '${language}' found in cache`);
    return cached;
  }

  // Check if there's already an in-flight load for this language
  const inFlight = grammarLoadPromises.get(language);
  if (inFlight) {
    config.logger.debug(`[arborium] Grammar '${language}' already loading, waiting...`);
    return inFlight;
  }

  // Start the actual load and track the promise
  const loadPromise = loadGrammarPluginInner(language, config);
  grammarLoadPromises.set(language, loadPromise);

  try {
    return await loadPromise;
  } finally {
    // Clean up the in-flight promise once done
    grammarLoadPromises.delete(language);
  }
}

/** Internal grammar loading - called only once per language */
async function loadGrammarPluginInner(
  language: string,
  config: Required<ArboriumConfig>,
): Promise<GrammarPlugin | null> {
  // Load local manifest if in dev mode
  await ensureLocalManifest(config);

  // Check if language is known
  if (
    !knownLanguages.has(language) &&
    !localManifest?.entries.some((e) => e.language === language)
  ) {
    config.logger.debug(`[arborium] Grammar '${language}' not available`);
    return null;
  }

  try {
    // Initialize web-tree-sitter if needed
    await ensureParserInit(config);

    const baseUrl = getGrammarBaseUrl(language, config);
    config.logger.debug(`[arborium] Loading grammar '${language}' from ${baseUrl}`);

    // Load language WASM and query files in parallel
    const [wasmResponse, highlightsQuery, injectionsQuery, localsQuery] = await Promise.all([
      config.resolveWasm({ language, baseUrl, path: "language.wasm" }),
      config.resolveText({ language, baseUrl, path: "highlights.scm" }),
      config.resolveText({ language, baseUrl, path: "injections.scm" }),
      config.resolveText({ language, baseUrl, path: "locals.scm" }),
    ]);

    // Load language from WASM bytes
    let wasmBytes: Uint8Array;
    if (wasmResponse instanceof Response) {
      const buffer = await wasmResponse.arrayBuffer();
      wasmBytes = new Uint8Array(buffer);
    } else if (wasmResponse instanceof ArrayBuffer) {
      wasmBytes = new Uint8Array(wasmResponse);
    } else if (wasmResponse instanceof Uint8Array) {
      wasmBytes = wasmResponse;
    } else {
      throw new Error("Unexpected WASM source type");
    }

    const tsLanguage = await Language.load(wasmBytes);

    // Build combined query
    const queryConfig = makeQueryConfig(
      tsLanguage,
      highlightsQuery,
      injectionsQuery,
      localsQuery,
    );

    // Create plugin with parsing functions
    const plugin: GrammarPlugin = {
      languageId: language,
      injectionLanguages: [], // Extracted from injection queries if needed
      language: tsLanguage,
      queryConfig,
      parseUtf8: (text: string) => {
        const parser = createParserForLanguage(tsLanguage);
        try {
          const tree = parser.parse(text);
          if (!tree) return { spans: [], injections: [] };
          try {
            return executeQuery(queryConfig, tree, text);
          } finally {
            tree.delete();
          }
        } catch (e) {
          config.logger.error(`[arborium] Parse error:`, e);
          return { spans: [], injections: [] };
        } finally {
          parser.delete();
        }
      },
      parseUtf16: (text: string) => {
        const parser = createParserForLanguage(tsLanguage);
        try {
          const tree = parser.parse(text);
          if (!tree) return { spans: [], injections: [] };
          try {
            const utf8Result = executeQuery(queryConfig, tree, text);
            return convertToUtf16(text, utf8Result);
          } finally {
            tree.delete();
          }
        } catch (e) {
          config.logger.error(`[arborium] Parse error:`, e);
          return { spans: [], injections: [] };
        } finally {
          parser.delete();
        }
      },
    };

    grammarCache.set(language, plugin);
    config.logger.debug(`[arborium] Grammar '${language}' loaded successfully`);
    return plugin;
  } catch (e) {
    config.logger.error(`[arborium] Failed to load grammar '${language}':`, e);
    return null;
  }
}

// Handle to plugin mapping for the host interface
const handleToPlugin = new Map<number, GrammarPlugin>();
let nextHandle = 1;

/** Setup globalThis.arboriumHost for the Rust host to call into */
function setupHostInterface(config: Required<ArboriumConfig>): void {
  (globalThis as any).arboriumHost = {
    /** Check if a language is available (sync) */
    isLanguageAvailable(language: string): boolean {
      return knownLanguages.has(language) || grammarCache.has(language);
    },

    /** Load a grammar and return a handle (async) */
    async loadGrammar(language: string): Promise<number> {
      const plugin = await loadGrammarPlugin(language, config);
      if (!plugin) return 0; // 0 = not found

      // Check if we already have a handle
      for (const [handle, p] of handleToPlugin) {
        if (p === plugin) return handle;
      }

      // Create new handle
      const handle = nextHandle++;
      handleToPlugin.set(handle, plugin);
      return handle;
    },

    /** Parse text using a grammar handle (sync) - returns UTF-8 offsets for Rust host */
    parse(handle: number, text: string): Utf8ParseResult {
      const plugin = handleToPlugin.get(handle);
      if (!plugin) return { spans: [], injections: [] };
      return plugin.parseUtf8(text);
    },
  };
}

/** Get the host URL based on config */
function getHostUrl(config: Required<ArboriumConfig>): string {
  if (config.hostUrl) {
    return config.hostUrl;
  }
  // Use CDN
  const cdn = config.cdn;
  const version = config.version;
  let baseUrl: string;
  if (cdn === "jsdelivr") {
    baseUrl = "https://cdn.jsdelivr.net/npm";
  } else if (cdn === "unpkg") {
    baseUrl = "https://unpkg.com";
  } else {
    baseUrl = cdn;
  }
  const versionSuffix = version === "latest" ? "" : `@${version}`;
  return `${baseUrl}/@arborium/arborium${versionSuffix}/dist`;
}

/** Load the Rust host module */
async function loadHost(config: Required<ArboriumConfig>): Promise<HostModule | null> {
  if (hostModule) return hostModule;
  if (hostLoadPromise) return hostLoadPromise;

  hostLoadPromise = (async () => {
    // Setup the interface the host imports
    setupHostInterface(config);

    const hostUrl = getHostUrl(config);
    const detail = config.resolveHostJs === defaultConfig.resolveHostJs ? ` from ${hostUrl}/arborium_host.js` : "";
    config.logger.debug(`[arborium] Loading host${detail}`);

    try {
      const module = (await config.resolveHostJs({ baseUrl: hostUrl, path: "arborium_host.js" })) as WasmBindgenHost;
      const wasm = await config.resolveHostWasm({ baseUrl: hostUrl, path: "arborium_host_bg.wasm" });

      await module.default({ module_or_path: wasm });

      hostModule = {
        highlight: module.highlight,
        isLanguageAvailable: module.isLanguageAvailable,
      };
      config.logger.debug(`[arborium] Host loaded successfully`);
      return hostModule;
    } catch (e) {
      config.logger.error("[arborium] Failed to load host:", e);
      return null;
    }
  })();

  return hostLoadPromise;
}

/** Highlight source code */
export async function highlight(
  language: string,
  source: string,
  configOverrides?: ArboriumConfig,
): Promise<string> {
  const config = getConfig(configOverrides);
  // Use the Rust host (handles injections, proper span deduplication, etc.)
  const host = await loadHost(config);
  if (host) {
    try {
      return host.highlight(language, source);
    } catch (e) {
      config.logger.error("[arborium] Host highlight failed:", e);
    }
  }

  // Host not available - return escaped source
  return escapeHtml(source);
}

/** Load a grammar for direct use */
export async function loadGrammar(
  language: string,
  configOverrides?: ArboriumConfig,
): Promise<Grammar | null> {
  const config = getConfig(configOverrides);
  const plugin = await loadGrammarPlugin(language, config);
  if (!plugin) return null;

  return {
    languageId: () => plugin.languageId,
    injectionLanguages: () => plugin.injectionLanguages,
    highlight: async (source: string) => {
      // Use the Rust host for proper highlighting with injection support
      return highlight(language, source, configOverrides);
    },
    // Public API returns UTF-16 offsets for JavaScript compatibility
    parse: (source: string) => plugin.parseUtf16(source),
    createSession: (): Session => {
      const parser = createParserForLanguage(plugin.language);
      let currentTree: Tree | null = null;
      let currentText = "";

      return {
        setText: (text: string) => {
          currentText = text;
          const newTree = parser.parse(text, currentTree ?? undefined);
          if (currentTree) currentTree.delete();
          currentTree = newTree;
        },
        // Session.parse() returns UTF-16 offsets for JavaScript compatibility
        parse: () => {
          try {
            if (!currentTree) return { spans: [], injections: [] };
            const utf8Result = executeQuery(plugin.queryConfig, currentTree, currentText);
            return convertToUtf16(currentText, utf8Result);
          } catch (e) {
            config.logger.error(`[arborium] Session parse error:`, e);
            return { spans: [], injections: [] };
          }
        },
        cancel: () => {
          // web-tree-sitter doesn't have a cancel API for sync parsing
        },
        free: () => {
          if (currentTree) {
            currentTree.delete();
            currentTree = null;
          }
          parser.delete();
        },
      };
    },
    dispose: () => {
      // No-op for now, plugins are cached
    },
  };
}

/**
 * Register a pre-loaded grammar, bypassing CDN resolution.
 *
 * Use this in Node.js, Deno, or other non-browser environments where
 * dynamic `import()` of CDN URLs isn't available.
 *
 * @param languageWasm - The language WASM bytes (Uint8Array or ArrayBuffer)
 * @param queries - The query strings for highlighting
 * @param queries.highlights - The highlights.scm query string
 * @param queries.injections - The injections.scm query string (optional)
 * @param queries.locals - The locals.scm query string (optional)
 *
 * @example
 * ```ts
 * import { readFile } from "node:fs/promises";
 * const wasm = await readFile("node_modules/@arborium/python/language.wasm");
 * const highlights = await readFile("node_modules/@arborium/python/highlights.scm", "utf-8");
 * const grammar = await registerGrammar(wasm, { highlights });
 * const html = await grammar.highlight("print('hello')");
 * ```
 */
export async function registerGrammar(
  languageWasm: Uint8Array | ArrayBuffer,
  queries: { highlights: string; injections?: string; locals?: string },
  configOverrides?: ArboriumConfig,
): Promise<Grammar> {
  const config = getConfig(configOverrides);

  // Initialize web-tree-sitter if needed
  await ensureParserInit(config);

  const wasmBytes = languageWasm instanceof Uint8Array
    ? languageWasm
    : new Uint8Array(languageWasm);
  const tsLanguage = await Language.load(wasmBytes);
  const languageId = tsLanguage.name ?? "unknown";

  const queryConfig = makeQueryConfig(
    tsLanguage,
    queries.highlights,
    queries.injections ?? "",
    queries.locals ?? "",
  );

  const plugin: GrammarPlugin = {
    languageId,
    injectionLanguages: [],
    language: tsLanguage,
    queryConfig,
    parseUtf8: (text: string) => {
      const parser = createParserForLanguage(tsLanguage);
      try {
        const tree = parser.parse(text);
        if (!tree) return { spans: [], injections: [] };
        try {
          return executeQuery(queryConfig, tree, text);
        } finally {
          tree.delete();
        }
      } catch (e) {
        config.logger.error(`[arborium] Parse error:`, e);
        return { spans: [], injections: [] };
      } finally {
        parser.delete();
      }
    },
    parseUtf16: (text: string) => {
      const parser = createParserForLanguage(tsLanguage);
      try {
        const tree = parser.parse(text);
        if (!tree) return { spans: [], injections: [] };
        try {
          const utf8Result = executeQuery(queryConfig, tree, text);
          return convertToUtf16(text, utf8Result);
        } finally {
          tree.delete();
        }
      } catch (e) {
        config.logger.error(`[arborium] Parse error:`, e);
        return { spans: [], injections: [] };
      } finally {
        parser.delete();
      }
    },
  };

  grammarCache.set(languageId, plugin);
  knownLanguages.add(languageId);
  config.logger.debug(`[arborium] Grammar '${languageId}' registered`);

  const grammar = await loadGrammar(languageId, configOverrides);
  return grammar!;
}

/** Get current config, optionally merging with overrides */
export function getConfig(overrides?: Partial<ArboriumConfig>): Required<ArboriumConfig> {
  if (overrides) {
    return { ...globalConfig, ...overrides };
  }
  return { ...globalConfig };
}

/** Set/merge config */
export function setConfig(newConfig: Partial<ArboriumConfig>): void {
  globalConfig = { ...globalConfig, ...newConfig };
}

/** Check if a language is available */
export async function isLanguageAvailable(
  language: string,
  configOverrides?: ArboriumConfig,
): Promise<boolean> {
  const config = getConfig(configOverrides);
  await ensureLocalManifest(config);
  return (
    knownLanguages.has(language) ||
    (localManifest?.entries.some((e) => e.language === language) ?? false)
  );
}

/** Get list of available languages */
export async function getAvailableLanguages(configOverrides?: ArboriumConfig): Promise<string[]> {
  const config = getConfig(configOverrides);
  await ensureLocalManifest(config);
  // In dev mode, use local manifest if available
  if (localManifest) {
    return localManifest.entries.map((e) => e.language);
  }
  return Array.from(knownLanguages);
}
