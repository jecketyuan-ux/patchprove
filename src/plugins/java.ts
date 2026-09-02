import { basenameNoExt, extname, normalizeRel, parentDir } from "../paths.js";
import type { DetectedTools } from "../types.js";
import type { LanguagePlugin, PluginTestCommand } from "./types.js";
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
    /^Test/.test(base)
  );
}

export function javaTestCandidates(filePath: string): string[] {
  const rel = normalizeRel(filePath);
  if (extname(rel) !== ".java" || isJavaTestFile(rel)) return [];
  const name = basenameNoExt(rel);
  const dir = parentDir(rel);
  const testDir = dir.replace(/(^|\/)src\/main\//, "$1src/test/");
  const candidates = [
    `${testDir}/${name}Test.java`,
    `${testDir}/${name}Tests.java`,
    `${testDir}/Test${name}.java`,
  ];
  if (dir.includes("src/main/java/")) {
    const pkg = dir.replace(/^.*src\/main\/java\//, "");
    candidates.push(`src/test/java/${pkg}/${name}Test.java`);
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

export function resolveJavaImport(
  _fromFile: string,
  specifier: string,
  existing: ReadonlySet<string>,
): string | null {
  const rel = specifier.replaceAll(".", "/");
  const candidates = [
    `src/main/java/${rel}.java`,
    `src/test/java/${rel}.java`,
    `${rel}.java`,
  ];
  for (const candidate of candidates.map(normalizeRel)) {
    if (existing.has(candidate)) return candidate;
  }
  return null;
}

function javaClassName(filePath: string): string {
  return basenameNoExt(filePath);
}

export const javaPlugin: LanguagePlugin = {
  id: "java",
  languages: ["java"],
  extensions: [".java"],
  isTestFile: isJavaTestFile,
  testCandidates: javaTestCandidates,
  parseImports: (sourceText) => parseJavaImports(sourceText),
  resolveImport: resolveJavaImport,
  testCommand(_cwd, mappedTests, tools: DetectedTools): PluginTestCommand | null {
    const tests = mappedTests.filter((t) => extname(t) === ".java");
    if (tests.length === 0) return null;
    const classes = uniqueSorted(tests.map(javaClassName));
    if (tools.mavenBin) {
      return {
        name: "affected tests (mvn test)",
        command: tools.mavenBin,
        args: ["-q", "test", `-Dtest=${classes.join(",")}`],
      };
    }
    if (tools.gradleBin) {
      const args = ["test"];
      for (const cls of classes) args.push("--tests", cls);
      return { name: "affected tests (gradle test)", command: tools.gradleBin, args };
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
