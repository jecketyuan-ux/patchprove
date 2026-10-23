import { describe, expect, it } from "vitest";
import { parseCoverageText, mapTestsForSource } from "../src/coverage.js";
import { buildImpact, collectGaps } from "../src/evidence.js";
import type { DiffFile } from "../src/git.js";
import { buildImportGraph, dynamicDependencyDiagnostics } from "../src/graph.js";
import { emptyDetectedTools } from "../src/types.js";

function changed(path: string, status: DiffFile["status"] = "modified"): DiffFile {
  return { path, status, additions: 1, deletions: 0, patch: "" };
}

function project(contents: Record<string, string>) {
  const existing = new Set(Object.keys(contents));
  const readFile = (rel: string) => contents[rel] ?? null;
  const ctx = { cwd: "/repo", existing, readFile };
  return { existing, ctx, graph: buildImportGraph("/repo", existing, undefined, readFile, ctx) };
}

describe("conservative verification selection", () => {
  it("falls back when a repository resolution configuration cannot be parsed", () => {
    const p = project({ "tsconfig.json": "{broken", "src/value.ts": "export const value=1;", "src/value.test.ts": "import './value';", "test/indirect.test.ts": "import '@/unknown';" });
    expect(buildImpact([changed("src/value.ts")], p.existing, { graph: p.graph }).mappedTests[0]?.tests).toContain("test/indirect.test.ts");
  });
  it.each([{ extends: "./missing.json" }, { extends: "./tsconfig.json" }, { compilerOptions: { paths: { "@/*": "src/*" } } }])("does not silently ignore unresolved or malformed alias configuration %j", (config) => {
    const p = project({ "tsconfig.json": JSON.stringify(config), "src/value.ts": "export const value=1;", "src/value.test.ts": "import './value';", "test/indirect.test.ts": "import '@/unknown';" });
    expect(buildImpact([changed("src/value.ts")], p.existing, { graph: p.graph }).mappedTests[0]?.tests).toContain("test/indirect.test.ts");
  });
  it("does not expand declared external dependencies under baseUrl to the whole repository", () => {
    const p = project({
      "package.json": JSON.stringify({ devDependencies: { vitest: "4.1.12" } }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "." } }),
      "src/value.ts": "export const value = 2;", "src/value.test.ts": "import './value'; import 'vitest';",
      "tests/unrelated.test.ts": "import 'vitest'; import 'node:fs';",
    });
    expect(buildImpact([changed("src/value.ts")], p.existing, { graph: p.graph }).mappedTests[0]?.tests).toEqual(["src/value.test.ts"]);
  });
  const contents = {
    "src/hash.ts": "export const hash = () => 1;",
    "src/session.ts": 'import { hash } from "./hash"; export const session = hash;',
    "src/hash.test.ts": 'import { hash } from "./hash";',
    "tests/session.test.ts": 'import { session } from "../src/session";',
    "tests/other.test.ts": "export {};",
  };

  it("includes tests importing package imports aliases as well as nearby tests", () => {
    const { existing, graph, ctx } = project({
      "package.json": JSON.stringify({ imports: { "#value": "./src/value.js" } }),
      "src/value.js": "export const value = 2;",
      "src/value.test.js": "import './value.js';",
      "test/dependent.test.js": "import { value } from '#value';",
    });
    const impact = buildImpact([changed("src/value.js")], existing, { graph, pluginContext: ctx });
    expect(impact.mappedTests[0]?.tests).toEqual(["src/value.test.js", "test/dependent.test.js"]);
  });

  it("falls back for an unresolved internal alias while keeping external imports scoped", () => {
    const unresolved = project({
      "src/value.js": "export const value = 2;", "src/value.test.js": "import './value.js';",
      "test/unknown.test.js": "import '#missing';", "test/unrelated.test.js": "import 'vitest'; import 'node:fs';",
    });
    const impact = buildImpact([changed("src/value.js")], unresolved.existing, { graph: unresolved.graph, pluginContext: unresolved.ctx });
    expect(impact.mappedTests[0]?.tests).toContain("test/unknown.test.js");
    expect(impact.mappingDiagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "mapping-unresolved-internal-import" })]));
    const normal = project({ "src/value.js": "import 'node:fs'; import 'external-library';", "src/value.test.js": "import './value.js';", "test/unrelated.test.js": "import 'vitest';" });
    expect(buildImpact([changed("src/value.js")], normal.existing, { graph: normal.graph }).mappedTests[0]?.tests).toEqual(["src/value.test.js"]);
  });

  it.each([
    { title: "unrelated", map: { "unrelated.ts": { s: { "0": 1 } } } },
    { title: "all-zero", map: { "src/hash.ts": { s: { "0": 0 } } } },
    { title: "foreign-project", map: { "/elsewhere/src/hash.ts": ["tests/other.test.ts"] } },
    { title: "partial explicit", map: { "src/hash.ts": ["tests/other.test.ts", "missing.test.ts"] } },
  ])("preserves indirect graph tests with $title coverage", ({ map }) => {
    const { existing, graph, ctx } = project(contents);
    const coverage = parseCoverageText(JSON.stringify(map), "/repo", "json")!;
    coverage.freshness = "stale";
    const result = mapTestsForSource("src/hash.ts", existing, coverage, graph, undefined, ctx);
    expect(result.tests).toEqual(expect.arrayContaining(["src/hash.test.ts", "tests/session.test.ts"]));
    expect(result.tests).not.toContain("missing.test.ts");
    expect(result.evidence.find((edge) => edge.test === "tests/session.test.ts" && edge.via === "graph")).toMatchObject({ precision: "structural", inputHash: graph.inputHash });
    for (const edge of result.evidence.filter((edge) => edge.via === "coverage")) {
      expect(edge.freshness).toBe("stale");
      expect(edge.inputHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("retains separate naming, graph and historical reasons for a relationship", () => {
    const { existing, graph, ctx } = project(contents);
    const coverage = parseCoverageText('{"src/hash.ts":["src/hash.test.ts"]}', "/repo", "json");
    const result = mapTestsForSource("src/hash.ts", existing, coverage, graph, undefined, ctx);
    expect(result.origins).toEqual(expect.arrayContaining(["naming", "graph", "coverage"]));
    expect(result.evidence.filter((edge) => edge.test === "src/hash.test.ts").map((edge) => edge.precision)).toEqual(["heuristic", "structural", "historical"]);
    expect(result.evidence.find((edge) => edge.via === "coverage")?.freshness).toBe("unknown");
  });

  it.each(["added", "modified", "untracked"] as const)("selects %s tests themselves without a production source change", (status) => {
    const impact = buildImpact([changed("tests/new.test.mts", status)], new Set(["tests/new.test.mts"]));
    expect(impact.mappedTests).toEqual([{ source: "tests/new.test.mts", tests: ["tests/new.test.mts"], via: "naming" }]);
    expect(impact.mappingEvidence?.[0]).toMatchObject({ origin: "changed-test", precision: "structural" });
    expect(impact.unmappedSources).toEqual([]);
  });

  it("maps deleted sources through the base graph to surviving tests", () => {
    const { existing, graph, ctx } = project(contents);
    const impact = buildImpact([changed("src/hash.ts", "deleted")], existing, { baseGraph: graph, basePluginContext: ctx });
    expect(impact.mappedTests[0]?.tests).toEqual(["src/hash.test.ts", "tests/session.test.ts"]);
    expect(impact.unmappedSources).toEqual([]);
    expect(impact.mappingEvidence?.find((edge) => edge.via === "graph")?.origin).toMatch(/^base:/);
  });

  it("reports deletion uncertainty and never selects deleted tests still listed in the index", () => {
    const { existing, graph } = project(contents);
    const impact = buildImpact([changed("src/hash.ts", "deleted"), changed("src/hash.test.ts", "deleted")], existing, { graph });
    expect(impact.mappedTests.flatMap((entry) => entry.tests)).not.toContain("src/hash.test.ts");
    expect(impact.unmappedReasons?.["src/hash.ts"]).toMatch(/base revision/);
    expect(impact.unmappedReasons?.["src/hash.test.ts"]).toMatch(/Deleted test/);
  });

  it.each(["src/core.c", "src/core.hpp", "scripts/deploy.sh", "package.json", "config.yaml", "example.txt", "tests/fixtures/example.txt", "templates/mail.html"])("reports an explicit dependency mapping gap for %s", (file) => {
    const impact = buildImpact([changed(file)], new Set([file]));
    expect(impact.unmappedSources).toContain(file);
    expect(impact.unmappedReasons?.[file]).toMatch(/mapping|mapper/);
    expect(collectGaps(impact, [], emptyDetectedTools())).toEqual(expect.arrayContaining([expect.objectContaining({ files: [file], kind: "unsupported-language" })]));
  });

  it("does not invent a mapping requirement for prose documentation", () => {
    const impact = buildImpact([changed("README.md"), changed("docs/guide.rst")], new Set(["README.md", "docs/guide.rst"]));
    expect(impact.unmappedSources).toEqual([]);
    expect(collectGaps(impact, [], emptyDetectedTools())).toEqual([]);
  });

  it("records unresolved imports without presenting their scope as resolved", () => {
    const { existing, graph } = project({ "src/main.ts": 'import { x } from "@missing/x";', "tests/main.test.ts": 'import "../src/main";' });
    const impact = buildImpact([changed("src/main.ts")], existing, { graph });
    expect(impact.mappingDiagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "mapping-unresolved-import", files: ["src/main.ts"] })]));
    expect(graph.inputHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("dynamic dependency uncertainty", () => {
  it.each([
    "await import(moduleName);",
    "require(moduleName);",
    "await import('../src/' + moduleName);",
    "await import(`../src/${moduleName}.js`);",
  ])("reports a JavaScript dependency expression: %s", (source) => {
    expect(dynamicDependencyDiagnostics("test/runtime.test.mts", source)).toEqual([expect.objectContaining({ code: "mapping-dynamic-dependency", severity: "warning", files: ["test/runtime.test.mts"] })]);
  });

  it.each([
    "importlib.import_module(module_name)",
    "__import__(module_name)",
    "import_module(prefix + module_name)",
  ])("reports a Python dependency expression: %s", (source) => {
    expect(dynamicDependencyDiagnostics("tests/test_runtime.py", source)).toEqual([expect.objectContaining({ code: "mapping-dynamic-dependency" })]);
  });

  it("keeps literal imports, comments, and string examples out of uncertainty diagnostics", () => {
    const source = [
      "await import('../src/value.js');",
      'require("../src/value.js");',
      "await import(/* chunk */ '../src/value.js');",
      "await import(`../src/value.js`);",
      "// import(variable)",
      "/* require(variable) */",
      'const example = "import(variable)";',
    ].join("\n");
    expect(dynamicDependencyDiagnostics("test/static.test.js", source)).toEqual([]);
    expect(dynamicDependencyDiagnostics("tests/test_static.py", '# __import__(variable)\nexample = "importlib.import_module(variable)"\nimportlib.import_module("pkg.value")')).toEqual([]);
  });

  it("maps Python literal runtime imports as structural imports", () => {
    const { existing, graph, ctx } = project({
      "pkg/value.py": "value = 1",
      "tests/test_runtime.py": 'import importlib\nmodule = importlib.import_module("pkg.value")',
    });
    expect(mapTestsForSource("pkg/value.py", existing, null, graph, undefined, ctx).tests).toContain("tests/test_runtime.py");
    expect(graph.diagnostics?.some((diagnostic) => diagnostic.code === "mapping-dynamic-dependency")).toBe(false);
  });

  it("selects the full known suite when a changed source may reach a variable import", () => {
    const { existing, graph, ctx } = project({
      "src/value.js": "export const value = 2;",
      "src/value.test.js": "import './value.js';",
      "test/dynamic.test.js": "const moduleName = '../src/' + 'value.js'; await import(moduleName);",
    });
    expect(graph.importers.get("src/value.js")).toEqual(["src/value.test.js"]);
    const impact = buildImpact([changed("src/value.js")], existing, { graph, pluginContext: ctx });
    expect(impact.mappedTests[0]?.tests).toEqual(["src/value.test.js", "test/dynamic.test.js"]);
    expect(impact.mappingEvidence).toEqual(expect.arrayContaining([expect.objectContaining({ source: "src/value.js", test: "test/dynamic.test.js", origin: "dynamic-fallback", precision: "heuristic", freshness: "unknown" })]));
    expect(impact.mappingDiagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "mapping-dynamic-dependency", files: ["test/dynamic.test.js"] })]));
  });

  it("retains unsupported configuration gaps while conservatively selecting tests", () => {
    const { existing, graph } = project({ "config.yaml": "mode: changed", "test/dynamic.test.js": "await import(moduleName);" });
    const impact = buildImpact([changed("config.yaml")], existing, { graph });
    expect(impact.mappedTests[0]?.tests).toEqual(["test/dynamic.test.js"]);
    expect(impact.unmappedReasons?.["config.yaml"]).toMatch(/configuration/);
  });

  it("keeps possible test consumers when a changed test has dynamic dependencies", () => {
    const { existing, graph } = project({ "test/dynamic.test.js": "await import(moduleName);", "test/other.test.js": "export {};" });
    const impact = buildImpact([changed("test/dynamic.test.js")], existing, { graph });
    expect(impact.mappedTests[0]?.tests).toEqual(["test/dynamic.test.js", "test/other.test.js"]);
    expect(impact.mappingEvidence?.some((edge) => edge.origin === "dynamic-fallback")).toBe(true);
  });
});
