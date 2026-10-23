import path from "node:path";
import { isBuiltin } from "node:module";
import { InputBudgetError, parseBoundedJson } from "../input-budget.js";
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
    const value: unknown = parseBoundedJson(cleaned.replace(/"(?:\\.|[^"\\])*"|,\s*(?=[}\]])/g, (token) => token.startsWith('"') ? token : ""), rel);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch (error) {
    if (error instanceof InputBudgetError) throw error;
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

function completeAliasConfiguration(ctx: PluginContext, file: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false;
  seen.add(file);
  const config = readJson(ctx, file);
  if (!config) return false;
  const options = config.compilerOptions;
  if (options !== undefined) {
    if (!options || typeof options !== "object" || Array.isArray(options)) return false;
    const value = options as Record<string, unknown>;
    if (value.baseUrl !== undefined && typeof value.baseUrl !== "string") return false;
    if (value.paths !== undefined && (!value.paths || typeof value.paths !== "object" || Array.isArray(value.paths) ||
      Object.values(value.paths).some((targets) => !Array.isArray(targets) || !targets.every((target) => typeof target === "string")))) return false;
  }
  if (config.extends === undefined) return true;
  if (typeof config.extends !== "string" || !config.extends.startsWith(".")) return false;
  const target = normalizeRel(path.posix.join(parentDir(file) || ".", config.extends.endsWith(".json") ? config.extends : `${config.extends}.json`));
  return completeAliasConfiguration(ctx, target, seen);
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
  seen = new Set<string>(),
): string[] {
  const from = normalizeRel(fromFile);
  const identity = `${from}\0${specifier}`;
  if (seen.has(identity) || seen.size > 32) return [];
  seen.add(identity);
  const dir = parentDir(from) || ".";
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const hit = resolveJsPath(specifier.startsWith("/") ? specifier.slice(1) : path.posix.join(dir, specifier), existing);
    return hit ? [hit] : [];
  }
  const hits: string[] = [];
  if (specifier.startsWith("#")) {
    for (const ancestor of ancestorDirs(from)) {
      const manifest = ancestor === "." ? "package.json" : `${ancestor}/package.json`;
      if (!existing.has(manifest)) continue;
      const pkg = readJson(ctx, manifest);
      const imports = pkg?.imports;
      if (!imports || typeof imports !== "object" || Array.isArray(imports)) return [];
      // Exact keys win over patterns; the nearest package defines this scope.
      const candidates = Object.entries(imports).filter(([pattern]) => matchPattern(pattern, specifier) !== null)
        .sort(([a], [b]) => Number(b === specifier) - Number(a === specifier) || b.indexOf("*") - a.indexOf("*") || b.length - a.length);
      const match = candidates[0];
      if (!match) return [];
      const capture = matchPattern(match[0], specifier)!;
      for (const value of exportTargets(match[1])) {
        const target = value.replaceAll("*", capture);
        if (target.startsWith("./")) {
          const resolved = path.posix.normalize(path.posix.join(ancestor, target));
          if (resolved === ".." || resolved.startsWith("../") || target.split("/").includes("..")) continue;
          const hit = resolveJsPath(resolved, existing);
          if (hit) hits.push(hit);
        } else if (!target.startsWith(".") && !target.startsWith("/")) {
          hits.push(...resolveJsImportFiles(from, target, existing, ctx, seen));
        }
      }
      return uniqueSorted(hits);
    }
    return [];
  }
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

export function classifyJsImport(fromFile: string, specifier: string, ctx?: PluginContext): "internal" | "external" | "builtin" {
  if (isBuiltin(specifier)) return "builtin";
  if (/^[.#/]/.test(specifier)) return "internal";
  let baseUrl = false;
  for (const ancestor of ancestorDirs(normalizeRel(fromFile))) {
    const prefix = ancestor === "." ? "" : `${ancestor}/`;
    const config = aliasConfig(ctx, `${prefix}tsconfig.json`) ?? aliasConfig(ctx, `${prefix}jsconfig.json`);
    if (!config) continue;
    if (Object.keys(config.paths).some((pattern) => matchPattern(pattern, specifier) !== null)) return "internal";
    baseUrl = config.hasBaseUrl;
    break;
  }
  for (const manifest of ctx?.existing ?? []) {
    if (!/(^|\/)package\.json$/.test(manifest) || manifest.split("/").includes("node_modules")) continue;
    const name = readJson(ctx, manifest)?.name;
    if (typeof name === "string" && (specifier === name || specifier.startsWith(`${name}/`))) return "internal";
  }
  for (const ancestor of ancestorDirs(normalizeRel(fromFile))) {
    const pkg = readJson(ctx, ancestor === "." ? "package.json" : `${ancestor}/package.json`);
    if (!pkg) continue;
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const dependencies = pkg[field];
      if (dependencies && typeof dependencies === "object" && Object.keys(dependencies).some((name) => specifier === name || specifier.startsWith(`${name}/`))) return "external";
    }
  }
  if (baseUrl) return "internal";
  return "external";
}

export const jsPlugin: LanguagePlugin = {
  id: "javascript",
  capabilities: { contractVersion: 1, testedRunners: ["vitest@3.0.5", "vitest@4.1.12"], granularity: "file", reportFormats: ["vitest-json", "jest-json"], unknownResult: "incomplete" },
  languages: ["javascript", "typescript"],
  extensions: [...JS_EXTS, ...TS_EXTS],
  isTestFile: isJsTestFile,
  testCandidates: jsTestCandidates,
  parseImports: (sourceText) => parseJsImports(sourceText),
  classifyImport: classifyJsImport,
  configurationDiagnostics(ctx) {
    const diagnostics = [];
    for (const file of ctx.existing) {
      if (!/(^|\/)(?:package\.json|[tj]sconfig[^/]*\.json)$/.test(file)) continue;
      const config = readJson(ctx, file);
      if (!config || /(^|\/)[tj]sconfig[^/]*\.json$/.test(file) && !completeAliasConfiguration(ctx, file)) diagnostics.push({
        code: "mapping-invalid-configuration", severity: "warning" as const, files: [file],
        message: `Dependency configuration ${file} is unreadable or uses an external extends source outside the static resolver; selecting all known tests`,
      });
    }
    return diagnostics;
  },
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
