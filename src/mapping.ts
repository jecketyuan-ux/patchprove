import { basenameNoExt, extname, normalizeRel } from "./paths.js";
import {
  builtinPlugins,
  isPluginSourceFile,
  isPluginTestFile,
  pluginForPath,
  type LanguagePlugin,
} from "./plugins/index.js";
import type { PluginContext } from "./plugins/types.js";
import { JS_EXTS, TS_EXTS } from "./plugins/js.js";
import type { Language } from "./types.js";

export { JS_EXTS, TS_EXTS };

const PY_EXTS = new Set([".py"]);

export function languageOf(
  filePath: string,
  plugins: readonly LanguagePlugin[] = builtinPlugins,
): Language {
  const ext = extname(filePath);
  if (TS_EXTS.has(ext)) return "typescript";
  if (JS_EXTS.has(ext)) return "javascript";
  if (PY_EXTS.has(ext)) return "python";
  if (ext === ".go") return "go";
  if (ext === ".rs") return "rust";
  if (ext === ".java") return "java";
  return pluginForPath(filePath, plugins)?.languages[0] ?? "other";
}

export function isSourceFile(
  filePath: string,
  plugins: readonly LanguagePlugin[] = builtinPlugins,
): boolean {
  return isPluginSourceFile(filePath, plugins);
}

export function isTestFile(
  filePath: string,
  plugins: readonly LanguagePlugin[] = builtinPlugins,
): boolean {
  return isPluginTestFile(filePath, plugins);
}

export function isMappableSource(
  filePath: string,
  plugins: readonly LanguagePlugin[] = builtinPlugins,
): boolean {
  return isSourceFile(filePath, plugins) && !isTestFile(filePath, plugins);
}

export function testCandidatesFor(
  filePath: string,
  plugins: readonly LanguagePlugin[] = builtinPlugins,
  ctx?: PluginContext,
): string[] {
  const plugin = pluginForPath(filePath, plugins);
  if (!plugin || isTestFile(filePath, plugins)) return [];
  return plugin.testCandidates(normalizeRel(filePath), ctx);
}

export function mapTestsForFile(
  filePath: string,
  existingFiles: ReadonlySet<string>,
  plugins: readonly LanguagePlugin[] = builtinPlugins,
  ctx?: PluginContext,
): string[] {
  const normalized = new Set([...existingFiles].map(normalizeRel));
  return testCandidatesFor(filePath, plugins, ctx).filter((c) => normalized.has(c));
}

export function collectLanguages(
  paths: string[],
  plugins: readonly LanguagePlugin[] = builtinPlugins,
): Language[] {
  const set = new Set<Language>();
  for (const p of paths) {
    const lang = languageOf(p, plugins);
    if (lang !== "other") set.add(lang);
  }
  return [...set].sort();
}

/**
 * Strip test_ / _test / .test / .spec wrappers so coverage can pair
 * `src/utils/hash.ts` with `test/unit/hash.spec.ts`.
 */
export function testBasenameKey(filePath: string): string {
  const rel = normalizeRel(filePath);
  const ext = extname(rel);
  let name = basenameNoExt(rel);
  if (PY_EXTS.has(ext)) {
    if (name.startsWith("test_")) name = name.slice(5);
    else if (name.endsWith("_test")) name = name.slice(0, -5);
    return name.toLowerCase();
  }
  if (ext === ".go" && name.endsWith("_test")) {
    return name.slice(0, -5).toLowerCase();
  }
  if (ext === ".java") {
    name = name.replace(/Tests?$/, "").replace(/^Test/, "");
    return name.toLowerCase();
  }
  name = name.replace(/\.(test|spec)$/i, "");
  if (name.endsWith("_test")) name = name.slice(0, -5);
  return name.toLowerCase();
}

export { builtinPlugins };
