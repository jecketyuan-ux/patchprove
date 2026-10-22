import path from "node:path";
import { readProjectFile } from "./context.js";
import { basenameNoExt, extname, normalizeRel, parentDir } from "../paths.js";
import type { DetectedTools } from "../types.js";
import type { LanguagePlugin, PluginContext, PluginTestCommand } from "./types.js";
import { uniqueSorted } from "./types.js";

export const JS_EXTS = new Set([".js", ".jsx", ".mjs", ".cjs"]);
export const TS_EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const JS_TEST_RE = /\.(test|spec)$/i;

export function isJsTsExt(ext: string): boolean {
  return JS_EXTS.has(ext) || TS_EXTS.has(ext);
}

export function isJsTestFile(filePath: string): boolean {
  const rel = normalizeRel(filePath);
  const ext = extname(rel);
  if (!isJsTsExt(ext)) return false;
  return JS_TEST_RE.test(basenameNoExt(rel)) || rel.includes("/__tests__/") || rel.startsWith("__tests__/");
}

export function jsTestCandidates(filePath: string): string[] {
  const rel = normalizeRel(filePath);
  const ext = extname(rel);
  if (!isJsTsExt(ext) || isJsTestFile(rel)) return [];

  const name = basenameNoExt(rel);
  const dir = parentDir(rel);
  const dirPrefix = dir === "." ? "" : `${dir}/`;
  const candidates: string[] = [];
  const testExts = uniqueSorted([ext, ...TS_EXTS, ...JS_EXTS]);

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
const STATIC_TEMPLATE_IMPORT_RE = /(?:^|[^.\w$])(?:require|import)\s*\(\s*`((?:(?!\$\{)[^`])+)`/g;

export function parseJsImports(sourceText: string): string[] {
  const stripped = sourceText
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:\\\w])\/\/.*$/gm, "$1");
  const specs: string[] = [];
  for (const re of [IMPORT_FROM_RE, SIDE_EFFECT_IMPORT_RE, REQUIRE_OR_DYNAMIC_RE, STATIC_TEMPLATE_IMPORT_RE]) {
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

function resolveJsPath(joined: string, existing: ReadonlySet<string>): string | null {
  const normalized = normalizeRel(joined);
  const withoutExt = normalized.replace(/\.(js|mjs|cjs|jsx|ts|tsx|mts|cts)$/i, "");
  const candidates = [
    normalized,
    ...RESOLVE_EXTS.map((e) => `${normalized}${e}`),
    ...RESOLVE_EXTS.map((e) => `${withoutExt}${e}`),
    ...RESOLVE_EXTS.map((e) => `${normalized}/index${e}`),
    ...RESOLVE_EXTS.map((e) => `${withoutExt}/index${e}`),
  ];
  return candidates.find((candidate) => existing.has(candidate)) ?? null;
}

/** Read the JSON subset used by package.json and JSONC tsconfig files. */
function readJson(ctx: PluginContext | undefined, rel: string): Record<string, unknown> | null {
  const text = readProjectFile(ctx, rel);
  if (text == null) return null;
  try {
    const cleaned = text.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
      (token) => token.startsWith("/") ? " " : token);
    const value: unknown = JSON.parse(cleaned.replace(/"(?:\\.|[^"\\])*"|,\s*(?=[}\]])/g, (token) => token.startsWith('"') ? token : ""));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function ancestorDirs(rel: string): string[] {
  const dirs: string[] = [];
  let dir = parentDir(rel) || ".";
  while (true) {
    dirs.push(dir);
    if (dir === ".") return dirs;
    dir = parentDir(dir) || ".";
  }
}

interface AliasConfig { base: string; paths: Record<string, unknown>; hasBaseUrl: boolean }

function aliasConfig(ctx: PluginContext | undefined, rel: string, seen = new Set<string>()): AliasConfig | null {
  const configPath = normalizeRel(rel);
  if (seen.has(configPath)) return null;
  seen.add(configPath);
  const config = readJson(ctx, configPath);
  if (!config) return null;
  const dir = parentDir(configPath) || ".";
  const inherited = typeof config.extends === "string" && config.extends.startsWith(".")
    ? aliasConfig(ctx, path.posix.join(dir, config.extends.endsWith(".json") ? config.extends : `${config.extends}.json`), seen)
    : null;
  const options = config.compilerOptions as Record<string, unknown> | undefined;
  if (!options || typeof options !== "object") return inherited ?? { base: dir, paths: {}, hasBaseUrl: false };
  const hasBaseUrl = typeof options.baseUrl === "string" || inherited?.hasBaseUrl === true;
  const base = typeof options.baseUrl === "string" ? path.posix.join(dir, options.baseUrl) : inherited?.hasBaseUrl ? inherited.base : dir;
  const paths = options.paths;
  if (paths && typeof paths === "object" && !Array.isArray(paths)) {
    return { base, paths: paths as Record<string, unknown>, hasBaseUrl };
  }
  return typeof options.baseUrl === "string"
    ? { base, paths: inherited?.paths ?? {}, hasBaseUrl }
    : inherited ?? { base, paths: {}, hasBaseUrl };
}

function matchPattern(pattern: string, specifier: string): string | null {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === specifier ? "" : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return specifier.startsWith(prefix) && specifier.endsWith(suffix)
    ? specifier.slice(prefix.length, specifier.length - suffix.length || undefined) : null;
}

function exportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  if (value && typeof value === "object") return Object.values(value).flatMap(exportTargets);
  return [];
}

export function resolveJsImportFiles(
  fromFile: string,
  specifier: string,
  existing: ReadonlySet<string>,
  ctx?: PluginContext,
): string[] {
  const from = normalizeRel(fromFile);
  const dir = parentDir(from) || ".";
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const hit = resolveJsPath(specifier.startsWith("/") ? specifier.slice(1) : path.posix.join(dir, specifier), existing);
    return hit ? [hit] : [];
  }
  const hits: string[] = [];
  // The nearest config defines the importer's aliases. Every configured target
  // is retained because conditional builds can choose different files.
  for (const ancestor of ancestorDirs(from)) {
    const prefix = ancestor === "." ? "" : `${ancestor}/`;
    const config = aliasConfig(ctx, `${prefix}tsconfig.json`) ?? aliasConfig(ctx, `${prefix}jsconfig.json`);
    if (!config) continue;
    for (const [pattern, targets] of Object.entries(config.paths)) {
      const capture = matchPattern(pattern, specifier);
      if (capture == null || !Array.isArray(targets)) continue;
      for (const target of targets) {
        if (typeof target !== "string") continue;
        const hit = resolveJsPath(path.posix.join(config.base, target.replace("*", capture)), existing);
        if (hit) hits.push(hit);
      }
    }
    const baseHit = config.hasBaseUrl ? resolveJsPath(path.posix.join(config.base, specifier), existing) : null;
    if (baseHit) hits.push(baseHit);
    break;
  }
  for (const manifest of existing) {
    if (!/(^|\/)package\.json$/.test(manifest) || /(^|\/)node_modules\//.test(manifest)) continue;
    const pkg = readJson(ctx, manifest);
    if (!pkg || typeof pkg.name !== "string") continue;
    if (specifier !== pkg.name && !specifier.startsWith(`${pkg.name}/`)) continue;
    const pkgDir = parentDir(manifest) || ".";
    const subpath = specifier.slice(pkg.name.length).replace(/^\//, "");
    const exportKey = subpath ? `./${subpath}` : ".";
    const exports = pkg.exports;
    let targets: string[] = [];
    if (exports && typeof exports === "object" && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith("."))) {
      for (const [pattern, value] of Object.entries(exports)) {
        const capture = matchPattern(pattern, exportKey);
        if (capture != null) targets.push(...exportTargets(value).map((target) => target.replace("*", capture)));
      }
    } else if (!subpath) targets = exportTargets(exports);
    if (targets.length === 0) {
      targets = subpath ? [subpath] : [pkg.source, pkg.module, pkg.main, pkg.types, "index"].filter((target): target is string => typeof target === "string");
    }
    for (const target of targets) {
      const hit = resolveJsPath(path.posix.join(pkgDir, target), existing);
      if (hit) hits.push(hit);
    }
  }
  return uniqueSorted(hits);
}

export function resolveJsImport(
  fromFile: string,
  specifier: string,
  existing: ReadonlySet<string>,
  ctx?: PluginContext,
): string | null {
  return resolveJsImportFiles(fromFile, specifier, existing, ctx)[0] ?? null;
}

export const jsPlugin: LanguagePlugin = {
  id: "javascript",
  languages: ["javascript", "typescript"],
  extensions: [...JS_EXTS, ...TS_EXTS],
  isTestFile: isJsTestFile,
  testCandidates: jsTestCandidates,
  parseImports: (sourceText) => parseJsImports(sourceText),
  resolveImport: resolveJsImport,
  resolveImportFiles: resolveJsImportFiles,
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
        args: ["--runInBand", "--runTestsByPath", ...tests],
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
