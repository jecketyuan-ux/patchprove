import path from "node:path";
import { basenameNoExt, extname, normalizeRel, parentDir } from "../paths.js";
import type { DetectedTools } from "../types.js";
import { readProjectFile } from "./context.js";
import type { LanguagePlugin, PluginContext, PluginTestCommand } from "./types.js";
import { uniqueSorted } from "./types.js";

export function isRustTestFile(filePath: string, ctx?: PluginContext): boolean {
  const rel = normalizeRel(filePath);
  if (extname(rel) !== ".rs") return false;
  return (
    rel === "tests" ||
    rel.startsWith("tests/") ||
    rel.includes("/tests/") ||
    rel.endsWith("_test.rs") ||
    /\/tests\.rs$/.test(rel) ||
    (ctx != null && /#\s*\[\s*(?:[\w]+::)*test(?:\s*\([^\]]*\))?\s*\]/.test(
      (readProjectFile(ctx, rel) ?? "").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " "),
    ))
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

const USE_RE = /(?:^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?use\s+((?:\w+::)*\w+)(?=::|\s|;)/g;
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
  let parts = specifier.split("::").filter(Boolean);
  let moduleDir = srcPrefix;
  let knownCrate = ["crate", "self", "super"].includes(parts[0] ?? "");
  if (parts[0] === "super") {
    moduleDir = dir;
    while (parts[0] === "super") {
      moduleDir = parentDir(moduleDir) || ".";
      parts.shift();
    }
  } else if (parts[0] === "self") {
    moduleDir = dir;
    parts.shift();
  } else if (parts[0] === "crate") {
    parts.shift();
  } else {
    const crate = loadCargoCrates(ctx).find((candidate) => candidate.name.replaceAll("-", "_") === parts[0]);
    if (crate) {
      knownCrate = true;
      moduleDir = crate.path ? `${crate.path}/src` : "src";
      parts.shift();
    }
  }
  // A use path often ends in an item (alpha::module::function), so peel
  // item names until the containing source module is found.
  for (let length = parts.length; length > 0; length--) {
    const joined = `${moduleDir}/${parts.slice(0, length).join("/")}`;
    for (const candidate of [`${joined}.rs`, `${joined}/mod.rs`].map(normalizeRel)) {
      if (existing.has(candidate)) return candidate;
    }
  }
  if (!knownCrate) return null;
  for (const candidate of [`${moduleDir}/lib.rs`, `${moduleDir}/main.rs`].map(normalizeRel)) {
    if (existing.has(candidate)) return candidate;
  }
  return null;
}

function crateDependencyRoots(crate: CargoCrate, crates: CargoCrate[], ctx?: PluginContext): string[] {
  const manifest = readProjectFile(ctx, crate.path ? `${crate.path}/Cargo.toml` : "Cargo.toml") ?? "";
  const roots = new Set<string>();
  let section = "";
  for (const rawLine of manifest.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    const header = /^\s*\[([^\]]+)\]/.exec(line)?.[1];
    if (header) {
      section = header;
      const dependency = /(?:^|\.)(?:dev-|build-)?dependencies\.([\w-]+)$/.exec(header)?.[1];
      if (dependency) {
        const hit = crates.find((candidate) => candidate.name === dependency);
        if (hit) roots.add(hit.path);
      }
      continue;
    }
    if (!/(?:^|\.)(?:dev-|build-)?dependencies(?:\.|$)/.test(section)) continue;
    const entry = /^\s*([\w-]+)\s*=\s*(.*)$/.exec(line);
    if (!entry) continue;
    const key = entry[1] ?? "";
    const value = entry[2] ?? "";
    const packageName = /\bpackage\s*=\s*["']([^"']+)/.exec(value)?.[1];
    const pathValue = /\bpath\s*=\s*["']([^"']+)/.exec(value)?.[1];
    const dedicatedName = /(?:^|\.)(?:dev-|build-)?dependencies\.([\w-]+)$/.exec(section)?.[1];
    const resolvedPath = pathValue ? normalizeRel(path.posix.join(crate.path || ".", pathValue)) : null;
    const hit = crates.find((candidate) => candidate.path === resolvedPath || candidate.name === (packageName ?? dedicatedName ?? key));
    if (hit) roots.add(hit.path);
    // Dedicated [dependencies.alias] tables use one field per line.
    if (dedicatedName && key === "path") {
      const target = /^["']([^"']+)/.exec(value)?.[1];
      const hitByPath = target ? crates.find((candidate) => candidate.path === normalizeRel(path.posix.join(crate.path || ".", target))) : null;
      if (hitByPath) roots.add(hitByPath.path);
    }
    if (dedicatedName && key === "package") {
      const target = /^["']([^"']+)/.exec(value)?.[1];
      const hitByName = crates.find((candidate) => candidate.name === target);
      if (hitByName) roots.add(hitByName.path);
    }
  }
  return [...roots];
}

export function rustPackageTests(
  rel: string,
  existing: ReadonlySet<string>,
  ctx?: PluginContext,
): string[] {
  const source = normalizeRel(rel);
  if (extname(source) !== ".rs" || isRustTestFile(source)) return [];
  const roots = new Set([findCrateRoot(source, ctx)]);
  const crates = loadCargoCrates(ctx);
  // Cargo package tests exercise the crate as a unit. Include transitive
  // dependents even when a use path refers to an exported symbol, not a file.
  let added = true;
  while (added) {
    added = false;
    for (const crate of crates) {
      if (roots.has(crate.path)) continue;
      if (crateDependencyRoots(crate, crates, ctx).some((dependency) => roots.has(dependency))) {
        roots.add(crate.path);
        added = true;
      }
    }
  }
  return uniqueSorted([...existing].filter((file) => isRustTestFile(file, ctx) && roots.has(findCrateRoot(file, ctx))));
}

export const rustPlugin: LanguagePlugin = {
  id: "rust",
  capabilities: { contractVersion: 1, testedRunners: ["cargo@1.85.0"], granularity: "crate", reportFormats: ["cargo-harness"], unknownResult: "incomplete" },
  languages: ["rust"],
  extensions: [".rs"],
  isTestFile: isRustTestFile,
  testCandidates: rustTestCandidates,
  parseImports: (sourceText) => parseRustImports(sourceText),
  classifyImport(_from, specifier, ctx) {
    const first = specifier.split("::")[0] ?? "";
    if (["std", "core", "alloc"].includes(first)) return "builtin";
    return /^(?:mod:|crate::|self::|super::)/.test(specifier) || loadCargoCrates(ctx).some((crate) => crate.name.replaceAll("-", "_") === first) ? "internal" : "external";
  },
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
