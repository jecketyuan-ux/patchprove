import { basenameNoExt, extname, normalizeRel, parentDir } from "../paths.js";
import type { DetectedTools } from "../types.js";
import type { LanguagePlugin, PluginTestCommand } from "./types.js";
import { uniqueSorted } from "./types.js";

export const JS_EXTS = new Set([".js", ".jsx", ".mjs", ".cjs"]);
export const TS_EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const JS_TEST_RE = /\.(test|spec)\.(t|j|mj|cj)sx?$/i;

export function isJsTsExt(ext: string): boolean {
  return JS_EXTS.has(ext) || TS_EXTS.has(ext);
}

export function isJsTestFile(filePath: string): boolean {
  const rel = normalizeRel(filePath);
  const ext = extname(rel);
  if (!isJsTsExt(ext)) return false;
  return JS_TEST_RE.test(rel) || rel.includes("/__tests__/") || rel.startsWith("__tests__/");
}

export function jsTestCandidates(filePath: string): string[] {
  const rel = normalizeRel(filePath);
  const ext = extname(rel);
  if (!isJsTsExt(ext) || isJsTestFile(rel)) return [];

  const name = basenameNoExt(rel);
  const dir = parentDir(rel);
  const dirPrefix = dir === "." ? "" : `${dir}/`;
  const candidates: string[] = [];
  const testExts = TS_EXTS.has(ext)
    ? [".ts", ".tsx", ".js", ".jsx"]
    : [".js", ".jsx", ".ts", ".tsx"];

  for (const te of testExts) {
    candidates.push(
      `${dirPrefix}${name}.test${te}`,
      `${dirPrefix}${name}.spec${te}`,
      `${dirPrefix}__tests__/${name}${te}`,
      `${dirPrefix}__tests__/${name}.test${te}`,
      `${dirPrefix}__tests__/${name}.spec${te}`,
      `tests/${name}.test${te}`,
      `test/${name}.test${te}`,
      `__tests__/${name}.test${te}`,
    );
    if (dir !== ".") {
      const withoutSrc = dir.replace(/^src\//, "");
      candidates.push(`tests/${dir}/${name}.test${te}`, `test/${dir}/${name}.test${te}`);
      if (withoutSrc !== dir) {
        candidates.push(`tests/${withoutSrc}/${name}.test${te}`, `${withoutSrc}/${name}.test${te}`);
      }
    }
  }
  return uniqueSorted(candidates);
}

const IMPORT_FROM_RE =
  /(?:^|[^.\w$])(?:import(?:\s+type)?|export(?:\s+type)?)\s+(?:\*\s+as\s+[\w$]+|\*|\{[^}]*\}|[\w$]+(?:\s*,\s*\{[^}]*\})?)\s+from\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT_RE = /(?:^|[^.\w$])import\s*['"]([^'"]+)['"]/g;
const REQUIRE_OR_DYNAMIC_RE = /(?:^|[^.\w$])(?:require|import)\s*\(\s*['"]([^'"]+)['"]/g;

export function parseJsImports(sourceText: string): string[] {
  const stripped = sourceText
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:\\\w])\/\/.*$/gm, "$1");
  const specs: string[] = [];
  for (const re of [IMPORT_FROM_RE, SIDE_EFFECT_IMPORT_RE, REQUIRE_OR_DYNAMIC_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(stripped))) {
      const spec = match[1];
      if (spec) specs.push(spec);
    }
  }
  return uniqueSorted(specs);
}

const RESOLVE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

export function resolveJsImport(
  fromFile: string,
  specifier: string,
  existing: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;
  const from = normalizeRel(fromFile);
  const dir = parentDir(from) || ".";
  const joined = normalizeRel(`${dir}/${specifier}`);
  const withoutExt = joined.replace(/\.(js|mjs|cjs|jsx|ts|tsx|mts|cts)$/i, "");
  const candidates = [
    joined,
    ...RESOLVE_EXTS.map((e) => `${joined}${e}`),
    ...RESOLVE_EXTS.map((e) => `${withoutExt}${e}`),
    ...RESOLVE_EXTS.map((e) => `${joined}/index${e}`),
    ...RESOLVE_EXTS.map((e) => `${withoutExt}/index${e}`),
  ];
  for (const candidate of uniqueSorted(candidates)) {
    if (existing.has(candidate)) return candidate;
  }
  return null;
}

export const jsPlugin: LanguagePlugin = {
  id: "javascript",
  languages: ["javascript", "typescript"],
  extensions: [...JS_EXTS, ...TS_EXTS],
  isTestFile: isJsTestFile,
  testCandidates: jsTestCandidates,
  parseImports: (sourceText) => parseJsImports(sourceText),
  resolveImport: resolveJsImport,
  testCommand(cwd: string, mappedTests: string[], tools: DetectedTools): PluginTestCommand | null {
    const tests = mappedTests.filter((t) => isJsTsExt(extname(t)));
    if (tests.length === 0) return null;
    if (tools.vitestBin) {
      return { name: "affected tests (vitest)", command: tools.vitestBin, args: ["run", ...tests] };
    }
    if (tools.jestBin) {
      return {
        name: "affected tests (jest)",
        command: tools.jestBin,
        args: ["--passWithNoTests", ...tests],
      };
    }
    return null;
  },
  missingTestRunnerReason(tools) {
    if (tools.vitest || tools.jest) {
      return "Test runner configured but binary not found";
    }
    return null;
  },
};
