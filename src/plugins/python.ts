import { basenameNoExt, extname, normalizeRel, parentDir } from "../paths.js";
import type { DetectedTools } from "../types.js";
import type { LanguagePlugin, PluginTestCommand } from "./types.js";
import { uniqueSorted } from "./types.js";

export function isPyTestFile(filePath: string): boolean {
  const rel = normalizeRel(filePath);
  if (extname(rel) !== ".py") return false;
  const base = rel.split("/").pop() ?? rel;
  return base.startsWith("test_") || base.endsWith("_test.py");
}

export function pyTestCandidates(filePath: string): string[] {
  const rel = normalizeRel(filePath);
  if (extname(rel) !== ".py" || isPyTestFile(rel)) return [];
  const name = basenameNoExt(rel);
  const dir = parentDir(rel);
  const dirPrefix = dir === "." ? "" : `${dir}/`;
  const candidates = [
    `${dirPrefix}test_${name}.py`,
    `${dirPrefix}${name}_test.py`,
    `tests/test_${name}.py`,
    `test/test_${name}.py`,
  ];
  if (dir !== ".") {
    candidates.push(`tests/${dir}/test_${name}.py`, `test/${dir}/test_${name}.py`);
    const withoutSrc = dir.replace(/^src\//, "");
    if (withoutSrc !== dir) {
      candidates.push(`tests/${withoutSrc}/test_${name}.py`, `tests/test_${name}.py`);
    }
  }
  return uniqueSorted(candidates);
}

const FROM_RE = /^\s*from\s+([.\w]+)\s+import\s+/gm;
const IMPORT_RE = /^\s*import\s+([.\w]+(?:\s*,\s*[.\w]+)*)/gm;

export function parsePyImports(sourceText: string): string[] {
  const stripped = sourceText.replace(/^\s*#.*$/gm, "").replace(/'''[\s\S]*?'''/g, " ").replace(/"""[\s\S]*?"""/g, " ");
  const specs: string[] = [];
  FROM_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FROM_RE.exec(stripped))) {
    const spec = match[1];
    if (spec && spec !== "__future__") specs.push(spec);
  }
  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(stripped))) {
    const group = match[1] ?? "";
    for (const part of group.split(",")) {
      const spec = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (spec) specs.push(spec);
    }
  }
  return uniqueSorted(specs);
}

function pyFileCandidates(relDir: string, parts: string[]): string[] {
  const prefix = relDir === "." ? "" : `${relDir}/`;
  const joined = `${prefix}${parts.join("/")}`.replace(/^\//, "");
  if (!joined) {
    return [`${prefix}__init__.py`.replace(/^\//, "")];
  }
  return [`${joined}.py`, `${joined}/__init__.py`];
}

export function resolvePyImport(
  fromFile: string,
  specifier: string,
  existing: ReadonlySet<string>,
): string | null {
  const from = normalizeRel(fromFile);
  const tryPaths = (candidates: string[]): string | null => {
    for (const candidate of uniqueSorted(candidates.map(normalizeRel))) {
      if (existing.has(candidate)) return candidate;
    }
    return null;
  };

  if (specifier.startsWith(".")) {
    let dir = parentDir(from) || ".";
    let rest = specifier;
    let dots = 0;
    while (rest.startsWith(".")) {
      dots += 1;
      rest = rest.slice(1);
    }
    for (let i = 1; i < dots; i++) {
      dir = dir === "." ? "." : parentDir(dir) || ".";
    }
    const parts = rest ? rest.split(".").filter(Boolean) : [];
    return tryPaths(pyFileCandidates(dir, parts));
  }

  const parts = specifier.split(".").filter(Boolean);
  if (parts.length === 0) return null;
  const roots = [".", "src", parentDir(from) || "."];
  for (const root of roots) {
    const hit = tryPaths(pyFileCandidates(root, parts));
    if (hit) return hit;
  }
  return null;
}

export const pythonPlugin: LanguagePlugin = {
  id: "python",
  languages: ["python"],
  extensions: [".py"],
  isTestFile: isPyTestFile,
  testCandidates: pyTestCandidates,
  parseImports: (sourceText) => parsePyImports(sourceText),
  resolveImport: resolvePyImport,
  testCommand(_cwd: string, mappedTests: string[], tools: DetectedTools): PluginTestCommand | null {
    const tests = mappedTests.filter((t) => extname(t) === ".py");
    if (tests.length === 0 || !tools.pytestBin) return null;
    return { name: "affected tests (pytest)", command: tools.pytestBin, args: tests };
  },
  missingTestRunnerReason(tools) {
    if (tools.pytest) return "Test runner configured but binary not found";
    return null;
  },
};
