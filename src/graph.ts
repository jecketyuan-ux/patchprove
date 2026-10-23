import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { accountInput, assertInputActive, inputLimits, InputBudgetError, readBoundedFile } from "./input-budget.js";
import { extname, normalizeRel } from "./paths.js";
import { builtinPlugins, isPluginTestFile, type LanguagePlugin } from "./plugins/index.js";
import type { PluginContext } from "./plugins/types.js";
import { uniqueSorted } from "./plugins/types.js";
import type { Diagnostic } from "./types.js";
import { parseJsDependencies } from "./plugins/js-parser.js";

const SKIP_RE = /(^|\/)(node_modules|dist|coverage|\.git|vendor|target|build|\.patchprove)(\/|$)/;

export interface ImportGraph {
  /** source → files that import it (tests and other sources). */
  importers: Map<string, string[]>;
  /** file → resolved imports. */
  imports: Map<string, string[]>;
  edgeCount: number;
  /** Content identity of files used to build this graph. */
  inputHash?: string;
  diagnostics?: Diagnostic[];
  /** Includes tests recognized from content, such as inline Rust unit tests. */
  tests?: ReadonlySet<string>;
  provenance?: {
    parserVersion: "2";
    inputHash: string;
    configurations: Array<{ path: string; hash: string }>;
    resolutions: Array<{ from: string; specifier: string; kind: "builtin" | "external" | "internal-resolved" | "internal-unresolved"; targets: string[] }>;
  };
}

export function shouldIndexPath(filePath: string): boolean {
  const rel = normalizeRel(filePath);
  if (!rel || SKIP_RE.test(rel)) return false;
  return true;
}

function readText(root: string, rel: string): string | null {
  const full = path.join(root, rel);
  if (!existsSync(full)) return null;
  try {
    return readBoundedFile(full).toString("utf8");
  } catch (error) {
    if (error instanceof InputBudgetError) throw error;
    return null;
  }
}

/** Observe dependency expressions that this static graph cannot attribute. */
export function dynamicDependencyDiagnostics(rel: string, sourceText: string): Diagnostic[] {
  const extension = extname(rel);
  const python = extension === ".py";
  if (!python && ![".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"].includes(extension)) return [];
  if (!python) return parseJsDependencies(sourceText, rel).diagnostics;
  // Preserve offsets while hiding comments and literal contents, so examples
  // in strings/comments cannot masquerade as dependency calls.
  const nonCode = /'''[\s\S]*?'''|"""[\s\S]*?"""|#[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g;
  const code = sourceText.replace(nonCode, (literal) => " ".repeat(literal.length));
  const calls = /(?:^|[^\w$])(?:__import__|(?:importlib\s*\.\s*)?import_module)\s*\(/g;
  const diagnostics: Diagnostic[] = [];
  let match: RegExpExecArray | null;
  while ((match = calls.exec(code))) {
    const argumentStart = match.index + match[0].length;
    const argument = sourceText.slice(argumentStart).replace(/^\s*/, "");
    const staticLiteral = /^(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')\s*(?:,|\))/.test(argument);
    if (staticLiteral) continue;
    diagnostics.push({
      code: "mapping-dynamic-dependency",
      message: `Dependency call in ${rel} uses an expression that the static import graph cannot resolve; selecting all known tests is a conservative fallback`,
      severity: "warning",
      files: [rel],
    });
  }
  return diagnostics;
}

export function resolvedImportsFor(
  rel: string,
  sourceText: string,
  existing: ReadonlySet<string>,
  plugins: readonly LanguagePlugin[] = builtinPlugins,
  ctx?: PluginContext,
  diagnostics?: Diagnostic[],
  resolutions?: NonNullable<ImportGraph["provenance"]>["resolutions"],
  parsedSpecifiers?: readonly string[],
): string[] {
  const plugin = plugins.find((p) => p.extensions.includes(extname(rel)));
  if (!plugin?.parseImports) return [];
  const specs = parsedSpecifiers ?? plugin.parseImports(sourceText, rel);
  const resolved: string[] = [];
  for (const spec of specs) {
    let hits: string[];
    if (plugin.resolveImportFiles) {
      hits = plugin.resolveImportFiles(rel, spec, existing, ctx);
    } else {
      const hit = plugin.resolveImport?.(rel, spec, existing, ctx) ?? null;
      hits = hit ? [hit] : [];
    }
    resolved.push(...hits);
    const kind = plugin.classifyImport?.(rel, spec, ctx) ?? (/^[.#/]/.test(spec) ? "internal" : "external");
    if (resolutions) {
      if (resolutions.length >= inputLimits().maxGraphEdges) throw new InputBudgetError("Import expressions exceed maxGraphEdges budget");
      resolutions.push({ from: rel, specifier: spec, kind: hits.length ? "internal-resolved" : kind === "internal" ? "internal-unresolved" : kind, targets: hits });
    }
    if (hits.length === 0) {
      if (kind === "builtin") continue;
      diagnostics?.push({
        code: kind === "internal" ? "mapping-unresolved-internal-import" : "mapping-unresolved-import",
        message: `Import ${JSON.stringify(spec)} in ${rel} was not resolved to repository files; dependency mapping is incomplete for this import`,
        severity: "warning",
        files: [rel],
      });
    }
  }
  return uniqueSorted(resolved);
}

/**
 * Light-weight reverse import graph: parse imports from indexed files,
 * resolve relative/in-repo specifiers, BFS from tests to sources.
 */
export function buildImportGraph(
  root: string,
  existingFiles: ReadonlySet<string>,
  plugins: readonly LanguagePlugin[] = builtinPlugins,
  readFile: (rel: string) => string | null = (rel) => readText(root, rel),
  ctx?: PluginContext,
): ImportGraph {
  const existing = new Set([...existingFiles].map(normalizeRel).filter(shouldIndexPath));
  const inputs = new Map<string, string | null>();
  const readInput = (rel: string): string | null => {
    assertInputActive();
    const normalized = normalizeRel(rel);
    if (!inputs.has(normalized)) {
      const text = (ctx?.readFile ?? readFile)(normalized);
      if (text !== null) accountInput(path.join(root, normalized), Buffer.byteLength(text));
      inputs.set(normalized, text);
    }
    return inputs.get(normalized) ?? null;
  };
  const context: PluginContext = {
    cwd: ctx?.cwd ?? root,
    existing: ctx?.existing ?? existing,
    readFile: readInput,
  };
  const imports = new Map<string, string[]>();
  const diagnostics: Diagnostic[] = [];
  const resolutions: NonNullable<ImportGraph["provenance"]>["resolutions"] = [];
  for (const plugin of plugins) diagnostics.push(...(plugin.configurationDiagnostics?.(context) ?? []));
  const digest = createHash("sha256");
  for (const rel of existing) {
    if (/(^|\/)(package\.json|[tj]sconfig[^/]*\.json|Cargo\.toml|go\.mod|pom\.xml|(?:build|settings)\.gradle(?:\.kts)?)$/.test(rel)) readInput(rel);
  }

  for (const rel of [...existing].sort()) {
    assertInputActive();
    const plugin = plugins.find((p) => p.extensions.includes(extname(rel)));
    if (!plugin?.parseImports) continue;
    const text = readInput(rel);
    if (text == null) {
      diagnostics.push({ code: "mapping-unreadable-file", message: `Cannot read ${rel} to map dependencies`, severity: "warning", files: [rel] });
      continue;
    }
    const parsed = plugin.id === "javascript" ? parseJsDependencies(text, rel) : undefined;
    diagnostics.push(...(parsed?.diagnostics ?? dynamicDependencyDiagnostics(rel, text)));
    imports.set(rel, resolvedImportsFor(rel, text, existing, plugins, context, diagnostics, resolutions, parsed?.specifiers));
  }

  const reachableFrom = new Map<string, Set<string>>();
  const walk = (start: string): Set<string> => {
    const cached = reachableFrom.get(start);
    if (cached) return cached;
    const seen = new Set<string>();
    const stack = [...(imports.get(start) ?? [])];
    while (stack.length) {
      assertInputActive();
      const next = stack.pop();
      if (!next || seen.has(next)) continue;
      seen.add(next);
      for (const dep of imports.get(next) ?? []) stack.push(dep);
    }
    reachableFrom.set(start, seen);
    return seen;
  };

  const importers = new Map<string, Set<string>>();
  let relationships = 0;
  const addImporter = (source: string, importer: string): void => {
    const set = importers.get(source) ?? new Set<string>();
    if (!set.has(importer) && ++relationships > inputLimits().maxGraphEdges) throw new InputBudgetError("Import graph exceeds maxGraphEdges budget");
    set.add(importer);
    importers.set(source, set);
  };

  const testFiles = new Set([...existing].filter((file) => isPluginTestFile(file, plugins, context)));
  for (const file of testFiles) {
    assertInputActive();
    addImporter(file, file);
    for (const source of walk(file)) {
      addImporter(source, file);
    }
  }

  let edgeCount = 0;
  const importerMap = new Map<string, string[]>();
  for (const [source, set] of importers) {
    const tests = uniqueSorted([...set].filter((p) => testFiles.has(p)));
    importerMap.set(source, tests);
    edgeCount += tests.length;
  }

  for (const [rel, text] of [...inputs].sort(([a], [b]) => a.localeCompare(b))) digest.update(JSON.stringify([rel, text]));
  const inputHash = digest.digest("hex");
  const configurations = [...inputs].filter(([rel, text]) => text !== null && /(^|\/)(package\.json|[tj]sconfig[^/]*\.json|Cargo\.toml|go\.mod|pom\.xml|(?:build|settings)\.gradle(?:\.kts)?)$/.test(rel))
    .sort(([a], [b]) => a.localeCompare(b)).map(([rel, text]) => ({ path: rel, hash: createHash("sha256").update(text!).digest("hex") }));
  return { importers: importerMap, imports, edgeCount, inputHash, diagnostics, tests: testFiles, provenance: { parserVersion: "2", inputHash, configurations, resolutions } };
}

export function mapTestsFromGraph(
  filePath: string,
  existingFiles: ReadonlySet<string>,
  graph: ImportGraph | null | undefined,
  plugins: readonly LanguagePlugin[] = builtinPlugins,
  ctx?: PluginContext,
): string[] {
  if (!graph) return [];
  const source = normalizeRel(filePath);
  const existing = new Set([...existingFiles].map(normalizeRel));
  const fromGraph = graph.importers.get(source) ?? [];
  const plugin = plugins.find((p) => p.extensions.includes(extname(source)));
  const fromPackage = plugin?.packageTests?.(source, existing, ctx) ?? [];
  return uniqueSorted(
    [...fromGraph, ...fromPackage].filter((t) => existing.has(t) && (graph.tests?.has(t) || isPluginTestFile(t, plugins, ctx))),
  );
}
