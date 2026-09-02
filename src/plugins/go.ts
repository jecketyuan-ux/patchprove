import { basenameNoExt, extname, normalizeRel, parentDir } from "../paths.js";
import type { DetectedTools } from "../types.js";
import type { LanguagePlugin, PluginTestCommand } from "./types.js";
import { uniqueSorted } from "./types.js";

export function isGoTestFile(filePath: string): boolean {
  const rel = normalizeRel(filePath);
  return extname(rel) === ".go" && rel.endsWith("_test.go");
}

export function goTestCandidates(filePath: string): string[] {
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

export function resolveGoImport(
  fromFile: string,
  specifier: string,
  existing: ReadonlySet<string>,
): string | null {
  if (specifier.startsWith(".")) {
    const dir = parentDir(normalizeRel(fromFile)) || ".";
    const joined = normalizeRel(`${dir}/${specifier}`);
    for (const candidate of [joined, `${joined}.go`, `${joined}/doc.go`]) {
      if (existing.has(candidate)) return candidate;
    }
  }
  const asPath = normalizeRel(specifier);
  if (existing.has(asPath) || existing.has(`${asPath}.go`)) {
    return existing.has(asPath) ? asPath : `${asPath}.go`;
  }
  return null;
}

export function goPackageTests(rel: string, existing: ReadonlySet<string>): string[] {
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

export const goPlugin: LanguagePlugin = {
  id: "go",
  languages: ["go"],
  extensions: [".go"],
  isTestFile: isGoTestFile,
  testCandidates: goTestCandidates,
  parseImports: (sourceText) => parseGoImports(sourceText),
  resolveImport: resolveGoImport,
  packageTests: goPackageTests,
  testCommand(_cwd, mappedTests, tools: DetectedTools): PluginTestCommand | null {
    const tests = mappedTests.filter((t) => extname(t) === ".go");
    if (tests.length === 0 || !tools.goBin) return null;
    const pkgs = uniqueSorted(
      tests.map((t) => {
        const dir = parentDir(t);
        return dir === "." ? "." : `./${dir}`;
      }),
    );
    return { name: "affected tests (go test)", command: tools.goBin, args: ["test", ...pkgs] };
  },
  missingTestRunnerReason(tools) {
    if (tools.go && !tools.goBin) return "Go module present but go binary not found";
    return null;
  },
};
