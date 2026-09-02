import { basenameNoExt, extname, normalizeRel } from "./paths.js";
import {
  builtinPlugins,
  isPluginSourceFile,
  isPluginTestFile,
  pluginForPath,
} from "./plugins/index.js";
import { JS_EXTS, TS_EXTS } from "./plugins/js.js";
import type { Language } from "./types.js";

export { JS_EXTS, TS_EXTS };

const PY_EXTS = new Set([".py"]);

export function languageOf(filePath: string): Language {
  const ext = extname(filePath);
  if (TS_EXTS.has(ext)) return "typescript";
  if (JS_EXTS.has(ext)) return "javascript";
  if (PY_EXTS.has(ext)) return "python";
  if (ext === ".go") return "go";
  if (ext === ".rs") return "rust";
  if (ext === ".java") return "java";
  return "other";
}

export function isSourceFile(filePath: string): boolean {
  return isPluginSourceFile(filePath);
}

export function isTestFile(filePath: string): boolean {
  return isPluginTestFile(filePath);
}

export function isMappableSource(filePath: string): boolean {
  return isSourceFile(filePath) && !isTestFile(filePath);
}

export function testCandidatesFor(filePath: string): string[] {
  const plugin = pluginForPath(filePath);
  if (!plugin || isTestFile(filePath)) return [];
  return plugin.testCandidates(normalizeRel(filePath));
}

export function mapTestsForFile(
  filePath: string,
  existingFiles: ReadonlySet<string>,
): string[] {
  const normalized = new Set([...existingFiles].map(normalizeRel));
  return testCandidatesFor(filePath).filter((c) => normalized.has(c));
}

export function collectLanguages(paths: string[]): Language[] {
  const set = new Set<Language>();
  for (const p of paths) {
    const lang = languageOf(p);
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
