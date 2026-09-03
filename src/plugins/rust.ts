import path from "node:path";
import { basenameNoExt, extname, normalizeRel, parentDir } from "../paths.js";
import type { DetectedTools } from "../types.js";
import { readProjectFile } from "./context.js";
import type { LanguagePlugin, PluginContext, PluginTestCommand } from "./types.js";
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

export interface CargoCrate {
  name: string;
  /** Repo-relative crate root; empty string for the repo-root package. */
  path: string;
}

function tomlSection(text: string, header: string): string {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\[${escaped}\\]\\s*$`, "m");
  const match = re.exec(text);
  if (!match || match.index === undefined) return "";
  const start = match.index + match[0].length;
  const rest = text.slice(start);
  const next = rest.search(/^\[/m);
  return next < 0 ? rest : rest.slice(0, next);
}

function tomlString(section: string, key: string): string | null {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m");
  return re.exec(section)?.[1] ?? null;
}

function tomlStringArray(section: string, key: string): string[] {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m");
  const match = re.exec(section);
  if (!match) return [];
  const out: string[] = [];
  const quoted = /"([^"]+)"/g;
  let item: RegExpExecArray | null;
  while ((item = quoted.exec(match[1] ?? ""))) {
    if (item[1]) out.push(item[1]);
  }
  return out;
}

export function parseCargoPackageName(tomlText: string): string | null {
  return tomlString(tomlSection(tomlText, "package"), "name");
}

export function parseCargoWorkspaceMembers(tomlText: string): string[] {
  return tomlStringArray(tomlSection(tomlText, "workspace"), "members").map(normalizeRel);
}

function expandMemberGlob(pattern: string, existing: ReadonlySet<string>): string[] {
  const n = normalizeRel(pattern);
  if (!n.includes("*")) return [n];
  if (n.endsWith("/*")) {
    const prefix = n.slice(0, -1);
    const crates = new Set<string>();
    for (const file of existing) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const crate = rest.split("/")[0];
      if (crate && crate !== "*") crates.add(`${prefix}${crate}`);
    }
    return uniqueSorted(crates);
  }
  return [n.replaceAll("*", "")].filter(Boolean);
}

export function loadCargoCrates(ctx?: PluginContext): CargoCrate[] {
  const root = readProjectFile(ctx, "Cargo.toml");
  if (!root) return [];
  const members = parseCargoWorkspaceMembers(root);
  const rootName = parseCargoPackageName(root);
  const existing = ctx?.existing ?? new Set<string>();
  const crates: CargoCrate[] = [];
  const seen = new Set<string>();
  for (const member of members.flatMap((m) => expandMemberGlob(m, existing))) {
    const text = readProjectFile(ctx, `${member}/Cargo.toml`);
    const name = (text ? parseCargoPackageName(text) : null) ?? path.posix.basename(member);
    if (seen.has(name)) continue;
    seen.add(name);
    crates.push({ name, path: normalizeRel(member) });
  }
  if (rootName && !seen.has(rootName)) {
    crates.push({ name: rootName, path: "" });
  }
  return crates;
}

export function inferCrateRoot(rel: string): string {
  const n = normalizeRel(rel);
  const match = n.match(/^(.*)\/src\//);
  if (match?.[1]) return match[1];
  const tests = n.match(/^(.*)\/tests\//);
  if (tests?.[1]) return tests[1];
  return "";
}

export function findCrateRoot(rel: string, ctx?: PluginContext): string {
  const n = normalizeRel(rel);
  const crates = loadCargoCrates(ctx);
  let best = "";
  for (const crate of crates) {
    if (!crate.path) continue;
    if (n === crate.path || n.startsWith(`${crate.path}/`)) {
      if (crate.path.length > best.length) best = crate.path;
    }
  }
  if (best) return best;
  if (crates.some((c) => c.path === "")) return "";
  return inferCrateRoot(n);
}

export function crateNameForFile(rel: string, ctx?: PluginContext): string | null {
  const root = findCrateRoot(rel, ctx);
  const crates = loadCargoCrates(ctx);
  const hit = crates.find((c) => c.path === root);
  if (hit) return hit.name;
  if (root) return path.posix.basename(root);
  return crates.find((c) => c.path === "")?.name ?? null;
}

export function rustTestCandidates(filePath: string, ctx?: PluginContext): string[] {
  const rel = normalizeRel(filePath);
  if (extname(rel) !== ".rs" || isRustTestFile(rel)) return [];
  const name = basenameNoExt(rel);
  const crateRoot = findCrateRoot(rel, ctx);
  const prefix = crateRoot ? `${crateRoot}/` : "";
  const dir = parentDir(rel);
  const dirInCrate =
    crateRoot && (dir === crateRoot || dir.startsWith(`${crateRoot}/`))
      ? dir.slice(crateRoot.length).replace(/^\//, "")
      : dir;
  const withoutSrc = dirInCrate.replace(/^src\/?/, "");
  const candidates = [
    `${prefix}tests/${name}.rs`,
    `${prefix}tests/${name}/main.rs`,
    `${dir === "." ? "" : `${dir}/`}${name}_test.rs`,
  ];
  if (withoutSrc && withoutSrc !== dirInCrate) {
    candidates.push(`${prefix}tests/${withoutSrc}/${name}.rs`);
  }
  if (name === "lib" || name === "main") {
    candidates.push(`${prefix}tests/integration.rs`);
    const crateName = crateNameForFile(rel, ctx);
    if (crateName) candidates.push(`${prefix}tests/${crateName}.rs`);
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
  ctx?: PluginContext,
): string | null {
  const from = normalizeRel(fromFile);
  const dir = parentDir(from) || ".";
  const crateRoot = findCrateRoot(from, ctx);
  const srcPrefix = crateRoot ? `${crateRoot}/src` : "src";
  if (specifier.startsWith("mod:")) {
    const name = specifier.slice(4);
    const candidates = [
      `${dir === "." ? "" : `${dir}/`}${name}.rs`,
      `${dir === "." ? "" : `${dir}/`}${name}/mod.rs`,
      `${srcPrefix}/${name}.rs`,
      `${srcPrefix}/${name}/mod.rs`,
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
  const cratePaths = [`${srcPrefix}/${parts.join("/")}.rs`, `${srcPrefix}/${parts.join("/")}/mod.rs`];
  for (const candidate of cratePaths.map(normalizeRel)) {
    if (existing.has(candidate)) return candidate;
  }
  return null;
}

export function rustPackageTests(
  rel: string,
  existing: ReadonlySet<string>,
  ctx?: PluginContext,
): string[] {
  const source = normalizeRel(rel);
  if (extname(source) !== ".rs" || isRustTestFile(source)) return [];
  const root = findCrateRoot(source, ctx);
  const tests: string[] = [];
  for (const file of existing) {
    if (!isRustTestFile(file)) continue;
    if (findCrateRoot(file, ctx) === root) tests.push(file);
  }
  return uniqueSorted(tests);
}

export const rustPlugin: LanguagePlugin = {
  id: "rust",
  languages: ["rust"],
  extensions: [".rs"],
  isTestFile: isRustTestFile,
  testCandidates: rustTestCandidates,
  parseImports: (sourceText) => parseRustImports(sourceText),
  resolveImport: resolveRustImport,
  packageTests: rustPackageTests,
  testCommand(cwd, mappedTests, tools: DetectedTools, ctx?: PluginContext): PluginTestCommand | null {
    const tests = mappedTests.filter((t) => extname(t) === ".rs");
    if (tests.length === 0 || !tools.cargoBin) return null;
    const context = ctx ?? { cwd, existing: new Set(mappedTests) };
    const names = uniqueSorted(
      tests.map((t) => crateNameForFile(t, context)).filter((n): n is string => Boolean(n)),
    );
    const args = ["test"];
    for (const name of names) {
      args.push("-p", name);
    }
    return { name: "affected tests (cargo test)", command: tools.cargoBin, args };
  },
  missingTestRunnerReason(tools) {
    if (tools.cargo && !tools.cargoBin) return "Cargo.toml present but cargo binary not found";
    return null;
  },
};
