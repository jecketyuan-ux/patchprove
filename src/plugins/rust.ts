import { basenameNoExt, extname, normalizeRel, parentDir } from "../paths.js";
import type { DetectedTools } from "../types.js";
import type { LanguagePlugin, PluginTestCommand } from "./types.js";
import { uniqueSorted } from "./types.js";

export function isRustTestFile(filePath: string): boolean {
  const rel = normalizeRel(filePath);
  if (extname(rel) !== ".rs") return false;
  return (
    rel === "tests" ||
    rel.startsWith("tests/") ||
    rel.includes("/tests/") ||
    rel.endsWith("_test.rs") ||
    /\/tests\.rs$/.test(rel)
  );
}

export function rustTestCandidates(filePath: string): string[] {
  const rel = normalizeRel(filePath);
  if (extname(rel) !== ".rs" || isRustTestFile(rel)) return [];
  const name = basenameNoExt(rel);
  const dir = parentDir(rel);
  const withoutSrc = dir.replace(/^src\/?/, "");
  const candidates = [
    `tests/${name}.rs`,
    `tests/${name}/main.rs`,
    `${dir === "." ? "" : `${dir}/`}${name}_test.rs`,
  ];
  if (withoutSrc && withoutSrc !== dir) {
    candidates.push(`tests/${withoutSrc}/${name}.rs`);
  }
  if (name === "lib" || name === "main") {
    candidates.push("tests/integration.rs");
  }
  return uniqueSorted(candidates);
}

const USE_RE = /(?:^|\n)\s*(?:pub\s+)?use\s+((?:crate|super|self)?(?:::\w+)+)/g;
const MOD_RE = /(?:^|\n)\s*(?:pub\s+)?mod\s+(\w+)\s*;/g;

export function parseRustImports(sourceText: string): string[] {
  const specs: string[] = [];
  USE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = USE_RE.exec(sourceText))) {
    if (match[1]) specs.push(match[1].replace(/\{[\s\S]*$/, "").replace(/;$/, ""));
  }
  MOD_RE.lastIndex = 0;
  while ((match = MOD_RE.exec(sourceText))) {
    if (match[1]) specs.push(`mod:${match[1]}`);
  }
  return uniqueSorted(specs);
}

export function resolveRustImport(
  fromFile: string,
  specifier: string,
  existing: ReadonlySet<string>,
): string | null {
  const from = normalizeRel(fromFile);
  const dir = parentDir(from) || ".";
  if (specifier.startsWith("mod:")) {
    const name = specifier.slice(4);
    const candidates = [
      `${dir === "." ? "" : `${dir}/`}${name}.rs`,
      `${dir === "." ? "" : `${dir}/`}${name}/mod.rs`,
      `src/${name}.rs`,
      `src/${name}/mod.rs`,
    ].map(normalizeRel);
    for (const candidate of uniqueSorted(candidates)) {
      if (existing.has(candidate)) return candidate;
    }
    return null;
  }
  const parts = specifier.split("::").filter((p) => p && p !== "crate" && p !== "self");
  if (specifier.startsWith("super::")) {
    const parent = dir === "." ? "." : parentDir(dir) || ".";
    const rest = specifier.slice("super::".length).split("::").filter(Boolean);
    const prefix = parent === "." ? "" : `${parent}/`;
    const joined = `${prefix}${rest.join("/")}`;
    for (const candidate of [`${joined}.rs`, `${joined}/mod.rs`].map(normalizeRel)) {
      if (existing.has(candidate)) return candidate;
    }
  }
  if (parts.length === 0) return null;
  const cratePaths = [`src/${parts.join("/")}.rs`, `src/${parts.join("/")}/mod.rs`];
  for (const candidate of cratePaths.map(normalizeRel)) {
    if (existing.has(candidate)) return candidate;
  }
  return null;
}

export const rustPlugin: LanguagePlugin = {
  id: "rust",
  languages: ["rust"],
  extensions: [".rs"],
  isTestFile: isRustTestFile,
  testCandidates: rustTestCandidates,
  parseImports: (sourceText) => parseRustImports(sourceText),
  resolveImport: resolveRustImport,
  testCommand(_cwd, mappedTests, tools: DetectedTools): PluginTestCommand | null {
    const tests = mappedTests.filter((t) => extname(t) === ".rs");
    if (tests.length === 0 || !tools.cargoBin) return null;
    return { name: "affected tests (cargo test)", command: tools.cargoBin, args: ["test"] };
  },
  missingTestRunnerReason(tools) {
    if (tools.cargo && !tools.cargoBin) return "Cargo.toml present but cargo binary not found";
    return null;
  },
};
