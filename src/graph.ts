import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { extname, normalizeRel } from "./paths.js";
import { builtinPlugins, isPluginTestFile, type LanguagePlugin } from "./plugins/index.js";
import { uniqueSorted } from "./plugins/types.js";

const SKIP_RE = /(^|\/)(node_modules|dist|coverage|\.git|vendor|target|build|\.patchprove)(\/|$)/;

export interface ImportGraph {
  /** source → files that import it (tests and other sources). */
  importers: Map<string, string[]>;
  /** file → resolved imports. */
  imports: Map<string, string[]>;
  edgeCount: number;
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
    return readFileSync(full, "utf8");
  } catch {
    return null;
  }
}

export function resolvedImportsFor(
  rel: string,
  sourceText: string,
  existing: ReadonlySet<string>,
  plugins: readonly LanguagePlugin[] = builtinPlugins,
): string[] {
  const plugin = plugins.find((p) => p.extensions.includes(extname(rel)));
  if (!plugin?.parseImports) return [];
  const specs = plugin.parseImports(sourceText, rel);
  const resolved: string[] = [];
  for (const spec of specs) {
    const hit = plugin.resolveImport?.(rel, spec, existing) ?? null;
    if (hit) resolved.push(hit);
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
): ImportGraph {
  const existing = new Set([...existingFiles].map(normalizeRel).filter(shouldIndexPath));
  const imports = new Map<string, string[]>();

  for (const rel of existing) {
    const plugin = plugins.find((p) => p.extensions.includes(extname(rel)));
    if (!plugin?.parseImports) continue;
    const text = readFile(rel);
    if (text == null) continue;
    imports.set(rel, resolvedImportsFor(rel, text, existing, plugins));
  }

  const reachableFrom = new Map<string, Set<string>>();
  const walk = (start: string): Set<string> => {
    const cached = reachableFrom.get(start);
    if (cached) return cached;
    const seen = new Set<string>();
    const stack = [...(imports.get(start) ?? [])];
    while (stack.length) {
      const next = stack.pop();
      if (!next || seen.has(next)) continue;
      seen.add(next);
      for (const dep of imports.get(next) ?? []) stack.push(dep);
    }
    reachableFrom.set(start, seen);
    return seen;
  };

  const importers = new Map<string, Set<string>>();
  const addImporter = (source: string, importer: string): void => {
    const set = importers.get(source) ?? new Set<string>();
    set.add(importer);
    importers.set(source, set);
  };

  for (const file of existing) {
    if (!isPluginTestFile(file, plugins)) continue;
    addImporter(file, file);
    for (const source of walk(file)) {
      addImporter(source, file);
    }
  }

  let edgeCount = 0;
  const importerMap = new Map<string, string[]>();
  for (const [source, set] of importers) {
    const tests = uniqueSorted([...set].filter((p) => isPluginTestFile(p, plugins)));
    importerMap.set(source, tests);
    edgeCount += tests.length;
  }

  return { importers: importerMap, imports, edgeCount };
}

export function mapTestsFromGraph(
  filePath: string,
  existingFiles: ReadonlySet<string>,
  graph: ImportGraph | null | undefined,
  plugins: readonly LanguagePlugin[] = builtinPlugins,
): string[] {
  if (!graph) return [];
  const source = normalizeRel(filePath);
  const existing = new Set([...existingFiles].map(normalizeRel));
  const fromGraph = graph.importers.get(source) ?? [];
  const plugin = plugins.find((p) => p.extensions.includes(extname(source)));
  const fromPackage = plugin?.packageTests?.(source, existing) ?? [];
  return uniqueSorted(
    [...fromGraph, ...fromPackage].filter((t) => existing.has(t) && isPluginTestFile(t, plugins)),
  );
}
