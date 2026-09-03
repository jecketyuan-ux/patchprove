import { basenameNoExt, extname, normalizeRel, parentDir } from "../paths.js";
import type { DetectedTools } from "../types.js";
import { readProjectFile } from "./context.js";
import type { LanguagePlugin, PluginContext, PluginTestCommand } from "./types.js";
import { uniqueSorted } from "./types.js";

export function isJavaTestFile(filePath: string): boolean {
  const rel = normalizeRel(filePath);
  if (extname(rel) !== ".java") return false;
  const base = basenameNoExt(rel);
  return (
    rel.includes("/src/test/") ||
    rel.startsWith("src/test/") ||
    /Test$/.test(base) ||
    /Tests$/.test(base) ||
    /TestCase$/.test(base) ||
    /IT$/.test(base) ||
    /ITCase$/.test(base) ||
    /^Test/.test(base)
  );
}

const TEST_NAME_SUFFIXES = ["Test", "Tests", "TestCase", "IT", "ITCase"] as const;

export interface JavaClassInfo {
  fqcn: string;
  simple: string;
  /** Multi-module directory (`api`, `services/auth`), or null for repo-root sources. */
  moduleDir: string | null;
}

export function javaClassFromPath(filePath: string): JavaClassInfo {
  const rel = normalizeRel(filePath);
  const simple = basenameNoExt(rel);
  const marker = /(^|\/)src\/(main|test)\/java\//;
  const match = marker.exec(rel);
  if (!match || match.index === undefined) {
    return { fqcn: simple, simple, moduleDir: inferModuleDir(rel) };
  }
  const prefix = rel.slice(0, match.index).replace(/\/$/, "");
  const after = rel.slice(match.index + match[0].length).replace(/\.java$/, "");
  const fqcn = after.replaceAll("/", ".") || simple;
  return { fqcn, simple, moduleDir: prefix || null };
}

function inferModuleDir(rel: string): string | null {
  const idx = rel.search(/(^|\/)src\/(main|test)\//);
  if (idx <= 0) return null;
  return rel.slice(0, idx).replace(/\/$/, "") || null;
}

export function javaTestCandidates(filePath: string, _ctx?: PluginContext): string[] {
  const rel = normalizeRel(filePath);
  if (extname(rel) !== ".java" || isJavaTestFile(rel)) return [];
  const name = basenameNoExt(rel);
  const dir = parentDir(rel);
  const testDir = dir.replace(/(^|\/)src\/main\//, "$1src/test/");
  const names = [
    ...TEST_NAME_SUFFIXES.map((suffix) => `${name}${suffix}`),
    `Test${name}`,
  ];
  const candidates = names.map((cls) => `${testDir}/${cls}.java`);
  if (dir.includes("src/main/java/")) {
    const modulePrefix = dir.slice(0, dir.indexOf("src/main/java/"));
    const pkg = dir.replace(/^.*src\/main\/java\//, "");
    for (const cls of names) {
      candidates.push(`${modulePrefix}src/test/java/${pkg}/${cls}.java`);
    }
  }
  return uniqueSorted(candidates);
}

const IMPORT_RE = /^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm;

export function parseJavaImports(sourceText: string): string[] {
  const specs: string[] = [];
  IMPORT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMPORT_RE.exec(sourceText))) {
    const spec = match[1];
    if (spec && !spec.endsWith(".*")) specs.push(spec);
  }
  return uniqueSorted(specs);
}

export interface JavaSubproject {
  kind: "gradle" | "maven";
  /** `:api` or `:services:auth` when Gradle. */
  gradlePath?: string;
  /** Repo-relative directory (`api`, `services/auth`). */
  dir: string;
}

function stripGradleComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function extractQuotedStrings(text: string): string[] {
  const out: string[] = [];
  const re = /['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (match[1]) out.push(match[1]);
  }
  return out;
}

export function parseGradleIncludedProjects(text: string): JavaSubproject[] {
  const stripped = stripGradleComments(text);
  const names: string[] = [];
  const callRe = /\binclude(?!Build)\s*\(([\s\S]*?)\)/g;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(stripped))) {
    names.push(...extractQuotedStrings(match[1] ?? ""));
  }
  const lineRe = /\binclude\s+(([':][^,\n]+|['"][^'"]+['"])(?:\s*,\s*[':][^,\n]+)*)/g;
  while ((match = lineRe.exec(stripped))) {
    const chunk = match[1] ?? "";
    if (chunk.startsWith("(")) continue;
    names.push(...extractQuotedStrings(chunk));
    const bare = chunk.match(/:[A-Za-z0-9_.:-]+/g);
    if (bare) names.push(...bare);
  }
  const projects: JavaSubproject[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const trimmed = raw.trim().replace(/^:/, "");
    if (!trimmed) continue;
    const gradlePath = `:${trimmed.replaceAll("/", ":")}`;
    const dir = trimmed.replaceAll(":", "/");
    if (seen.has(dir)) continue;
    seen.add(dir);
    projects.push({ kind: "gradle", gradlePath, dir: normalizeRel(dir) });
  }
  return projects;
}

export function parseMavenModules(pomText: string): string[] {
  const block = /<modules>([\s\S]*?)<\/modules>/i.exec(pomText);
  if (!block) return [];
  const modules: string[] = [];
  const re = /<module>\s*([^<]+?)\s*<\/module>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(block[1] ?? ""))) {
    const name = (match[1] ?? "").trim();
    if (name) modules.push(normalizeRel(name));
  }
  return uniqueSorted(modules);
}

export function loadJavaProjects(ctx?: PluginContext): JavaSubproject[] {
  const settings =
    readProjectFile(ctx, "settings.gradle") ?? readProjectFile(ctx, "settings.gradle.kts");
  if (settings) return parseGradleIncludedProjects(settings);
  const pom = readProjectFile(ctx, "pom.xml");
  if (pom) {
    return parseMavenModules(pom).map((dir) => ({ kind: "maven" as const, dir }));
  }
  return [];
}

export function javaProjectForFile(
  filePath: string,
  projects: readonly JavaSubproject[],
): JavaSubproject | null {
  const rel = normalizeRel(filePath);
  const info = javaClassFromPath(rel);
  let best: JavaSubproject | null = null;
  for (const project of projects) {
    if (rel === project.dir || rel.startsWith(`${project.dir}/`)) {
      if (!best || project.dir.length > best.dir.length) best = project;
    }
  }
  if (best) return best;
  if (info.moduleDir) {
    return { kind: projects[0]?.kind ?? "gradle", dir: info.moduleDir, gradlePath: `:${info.moduleDir.replaceAll("/", ":")}` };
  }
  return null;
}

export function resolveJavaImport(
  fromFile: string,
  specifier: string,
  existing: ReadonlySet<string>,
  ctx?: PluginContext,
): string | null {
  const rel = specifier.replaceAll(".", "/");
  const from = javaClassFromPath(fromFile);
  const projects = loadJavaProjects(ctx);
  const candidates = [
    `src/main/java/${rel}.java`,
    `src/test/java/${rel}.java`,
    `${rel}.java`,
  ];
  if (from.moduleDir) {
    candidates.unshift(
      `${from.moduleDir}/src/main/java/${rel}.java`,
      `${from.moduleDir}/src/test/java/${rel}.java`,
    );
  }
  for (const project of projects) {
    candidates.push(
      `${project.dir}/src/main/java/${rel}.java`,
      `${project.dir}/src/test/java/${rel}.java`,
    );
  }
  for (const candidate of candidates.map(normalizeRel)) {
    if (existing.has(candidate)) return candidate;
  }
  const suffix = `${rel}.java`;
  for (const file of existing) {
    if (file === suffix || file.endsWith(`/${suffix}`)) return file;
  }
  return null;
}

export function javaPackageTests(
  rel: string,
  existing: ReadonlySet<string>,
  _ctx?: PluginContext,
): string[] {
  const source = normalizeRel(rel);
  if (extname(source) !== ".java" || isJavaTestFile(source)) return [];
  const info = javaClassFromPath(source);
  const pkg = info.fqcn.includes(".") ? info.fqcn.slice(0, info.fqcn.lastIndexOf(".")) : "";
  const tests: string[] = [];
  for (const file of existing) {
    if (!isJavaTestFile(file)) continue;
    const test = javaClassFromPath(file);
    if (info.moduleDir !== test.moduleDir) continue;
    const testPkg = test.fqcn.includes(".") ? test.fqcn.slice(0, test.fqcn.lastIndexOf(".")) : "";
    if (pkg && testPkg === pkg) tests.push(file);
  }
  return uniqueSorted(tests);
}

function surefireClassName(filePath: string): string {
  return javaClassFromPath(filePath).fqcn;
}

function gradleTestArgs(
  tests: string[],
  projects: readonly JavaSubproject[],
): string[] {
  const grouped = new Map<string, string[]>();
  for (const file of tests) {
    const cls = surefireClassName(file);
    const project = javaProjectForFile(file, projects);
    const key = project?.gradlePath ?? "";
    const list = grouped.get(key) ?? [];
    list.push(cls);
    grouped.set(key, list);
  }
  const args: string[] = [];
  const keys = [...grouped.keys()].sort((a, b) => a.localeCompare(b));
  const hasProjectTasks = keys.some(Boolean);
  if (hasProjectTasks) {
    for (const key of keys) {
      const classes = uniqueSorted(grouped.get(key) ?? []);
      args.push(key ? `${key}:test` : "test");
      for (const cls of classes) args.push("--tests", cls);
    }
    return args;
  }
  args.push("test");
  for (const cls of uniqueSorted(tests.map(surefireClassName))) {
    args.push("--tests", cls);
  }
  return args;
}

function mavenModuleList(tests: string[], projects: readonly JavaSubproject[]): string[] {
  const modules = new Set<string>();
  for (const file of tests) {
    const project = javaProjectForFile(file, projects);
    if (project?.dir) modules.add(project.dir);
  }
  return uniqueSorted(modules);
}

export const javaPlugin: LanguagePlugin = {
  id: "java",
  languages: ["java"],
  extensions: [".java"],
  isTestFile: isJavaTestFile,
  testCandidates: javaTestCandidates,
  parseImports: (sourceText) => parseJavaImports(sourceText),
  resolveImport: resolveJavaImport,
  packageTests: javaPackageTests,
  testCommand(cwd, mappedTests, tools: DetectedTools, ctx?: PluginContext): PluginTestCommand | null {
    const tests = mappedTests.filter((t) => extname(t) === ".java");
    if (tests.length === 0) return null;
    const context = ctx ?? { cwd, existing: new Set(mappedTests) };
    const projects = loadJavaProjects(context);
    const classes = uniqueSorted(tests.map(surefireClassName));
    if (tools.gradleBin) {
      return {
        name: "affected tests (gradle test)",
        command: tools.gradleBin,
        args: gradleTestArgs(tests, projects),
      };
    }
    if (tools.mavenBin) {
      const args = ["-q"];
      const modules = mavenModuleList(tests, projects.length ? projects : tests.map((t) => {
        const info = javaClassFromPath(t);
        return info.moduleDir
          ? { kind: "maven" as const, dir: info.moduleDir }
          : { kind: "maven" as const, dir: "" };
      }).filter((p) => p.dir));
      if (modules.length > 0) {
        args.push("-pl", modules.join(","), "-am");
      }
      args.push("test", `-Dtest=${classes.join(",")}`);
      return { name: "affected tests (mvn test)", command: tools.mavenBin, args };
    }
    return null;
  },
  missingTestRunnerReason(tools) {
    if ((tools.maven || tools.gradle) && !tools.mavenBin && !tools.gradleBin) {
      return "Java build tool configured but mvn/gradle binary not found";
    }
    return null;
  },
};
