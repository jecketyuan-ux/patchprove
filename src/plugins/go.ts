import { basenameNoExt, extname, normalizeRel, parentDir } from "../paths.js";
import type { DetectedTools } from "../types.js";
import { readProjectFile } from "./context.js";
import type { LanguagePlugin, PluginContext, PluginTestCommand } from "./types.js";
import { uniqueSorted } from "./types.js";

export function isGoTestFile(filePath: string): boolean {
  const rel = normalizeRel(filePath);
  return extname(rel) === ".go" && rel.endsWith("_test.go");
}

export function goTestCandidates(filePath: string, _ctx?: PluginContext): string[] {
  const rel = normalizeRel(filePath);
  if (extname(rel) !== ".go" || isGoTestFile(rel)) return [];
  const name = basenameNoExt(rel);
  const dir = parentDir(rel);
  const dirPrefix = dir === "." ? "" : `${dir}/`;
  return uniqueSorted([`${dirPrefix}${name}_test.go`]);
}

const IMPORT_BLOCK_RE = /import\s*\(([\s\S]*?)\)/g;
const IMPORT_SINGLE_RE = /import\s+(?:[\w.]+\s+)?["']([^"']+)["']/g;

export function parseGoImports(sourceText: string): string[] {
  const specs: string[] = [];
  IMPORT_BLOCK_RE.lastIndex = 0;
  let block: RegExpExecArray | null;
  while ((block = IMPORT_BLOCK_RE.exec(sourceText))) {
    const body = block[1] ?? "";
    const lineRe = /["']([^"']+)["']/g;
    let line: RegExpExecArray | null;
    while ((line = lineRe.exec(body))) {
      if (line[1]) specs.push(line[1]);
    }
  }
  IMPORT_SINGLE_RE.lastIndex = 0;
  let single: RegExpExecArray | null;
  while ((single = IMPORT_SINGLE_RE.exec(sourceText))) {
    if (single[1]) specs.push(single[1]);
  }
  return uniqueSorted(specs);
}

export function parseGoModulePath(goModText: string): string | null {
  const match = /^\s*module\s+(\S+)/m.exec(goModText);
  return match?.[1] ?? null;
}

export function loadGoModulePath(ctx?: PluginContext): string | null {
  const text = readProjectFile(ctx, "go.mod");
  return text ? parseGoModulePath(text) : null;
}

/**
 * Coarse Go `internal/` rule: an import of `…/internal/…` is only visible to
 * packages under the parent of the last `internal` path element.
 */
export function goInternalVisible(fromRel: string, importedDir: string): boolean {
  const parts = normalizeRel(importedDir).split("/").filter(Boolean);
  const idx = parts.lastIndexOf("internal");
  if (idx === -1) return true;
  const parent = parts.slice(0, idx).join("/");
  const fromDir = parentDir(normalizeRel(fromRel)) || ".";
  if (!parent) return true;
  return fromDir === parent || fromDir.startsWith(`${parent}/`);
}

function packageDirIfExists(dir: string, existing: ReadonlySet<string>): string | null {
  const normalized = dir === "" ? "." : normalizeRel(dir) || ".";
  for (const file of existing) {
    if (extname(file) !== ".go") continue;
    if ((parentDir(file) || ".") === normalized) return normalized;
  }
  return null;
}

export function resolveGoPackageDir(
  fromFile: string,
  specifier: string,
  existing: ReadonlySet<string>,
  ctx?: PluginContext,
): string | null {
  if (specifier.startsWith(".")) {
    const dir = parentDir(normalizeRel(fromFile)) || ".";
    const joined = normalizeRel(`${dir}/${specifier}`) || ".";
    return packageDirIfExists(joined, existing);
  }
  const modulePath = loadGoModulePath(ctx);
  if (modulePath) {
    if (specifier === modulePath) return packageDirIfExists(".", existing);
    if (specifier.startsWith(`${modulePath}/`)) {
      return packageDirIfExists(specifier.slice(modulePath.length + 1), existing);
    }
    return null;
  }
  for (const file of existing) {
    if (extname(file) !== ".go") continue;
    const dir = parentDir(file) || ".";
    if (dir !== "." && specifier.endsWith(`/${dir}`)) return dir;
  }
  return null;
}

export function resolveGoImport(
  fromFile: string,
  specifier: string,
  existing: ReadonlySet<string>,
  ctx?: PluginContext,
): string | null {
  const files = resolveGoImportFiles(fromFile, specifier, existing, ctx);
  return files[0] ?? null;
}

export function resolveGoImportFiles(
  fromFile: string,
  specifier: string,
  existing: ReadonlySet<string>,
  ctx?: PluginContext,
): string[] {
  if (specifier.startsWith(".")) {
    const dir = parentDir(normalizeRel(fromFile)) || ".";
    const joined = normalizeRel(`${dir}/${specifier}`);
    for (const candidate of [joined, `${joined}.go`, `${joined}/doc.go`]) {
      if (existing.has(candidate)) {
        const pkg = parentDir(candidate) || ".";
        return goSourceFilesInDir(pkg, existing);
      }
    }
  }
  const pkgDir = resolveGoPackageDir(fromFile, specifier, existing, ctx);
  if (!pkgDir) return [];
  if (!goInternalVisible(fromFile, pkgDir)) return [];
  return goSourceFilesInDir(pkgDir, existing);
}

function goSourceFilesInDir(dir: string, existing: ReadonlySet<string>): string[] {
  const files: string[] = [];
  for (const file of existing) {
    if (extname(file) !== ".go" || isGoTestFile(file)) continue;
    if ((parentDir(file) || ".") === dir) files.push(file);
  }
  return uniqueSorted(files);
}

export function goPackageTests(
  rel: string,
  existing: ReadonlySet<string>,
  _ctx?: PluginContext,
): string[] {
  const source = normalizeRel(rel);
  if (extname(source) !== ".go" || isGoTestFile(source)) return [];
  const dir = parentDir(source);
  const tests: string[] = [];
  for (const file of existing) {
    if (!isGoTestFile(file)) continue;
    if ((parentDir(file) || ".") === dir) tests.push(file);
  }
  return uniqueSorted(tests);
}

/** Collapse `pkg/api` + `pkg/api/v2` to `./pkg/api/...`; leave unrelated packages listed. */
export function collapseGoTestTargets(pkgDirs: readonly string[]): string[] {
  const dirs = uniqueSorted(
    pkgDirs.map((d) => (d === "" || d === "." ? "." : normalizeRel(d))),
  );
  const set = new Set(dirs);
  const kept: string[] = [];
  for (const dir of dirs) {
    if (dir === ".") {
      kept.push(".");
      continue;
    }
    let ancestorCovered = false;
    const parts = dir.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      if (set.has(parts.slice(0, i).join("/"))) {
        ancestorCovered = true;
        break;
      }
    }
    if (!ancestorCovered) kept.push(dir);
  }
  return uniqueSorted(
    kept.map((dir) => {
      if (dir === ".") return ".";
      const hasDescendant = [...set].some((other) => other !== dir && other.startsWith(`${dir}/`));
      return hasDescendant ? `./${dir}/...` : `./${dir}`;
    }),
  );
}

export const goPlugin: LanguagePlugin = {
  id: "go",
  languages: ["go"],
  extensions: [".go"],
  isTestFile: isGoTestFile,
  testCandidates: goTestCandidates,
  parseImports: (sourceText) => parseGoImports(sourceText),
  resolveImport: resolveGoImport,
  resolveImportFiles: resolveGoImportFiles,
  packageTests: goPackageTests,
  testCommand(_cwd, mappedTests, tools: DetectedTools): PluginTestCommand | null {
    const tests = mappedTests.filter((t) => extname(t) === ".go");
    if (tests.length === 0 || !tools.goBin) return null;
    const pkgs = collapseGoTestTargets(
      tests.map((t) => {
        const dir = parentDir(t);
        return dir === "." ? "." : dir;
      }),
    );
    return { name: "affected tests (go test)", command: tools.goBin, args: ["test", ...pkgs] };
  },
  missingTestRunnerReason(tools) {
    if (tools.go && !tools.goBin) return "Go module present but go binary not found";
    return null;
  },
};
