import { describe, expect, it } from "vitest";
import { buildImpact } from "../src/evidence.js";
import { buildImportGraph, dynamicDependencyDiagnostics } from "../src/graph.js";
import { parseJsImports } from "../src/plugins/js.js";
import { parseCoverageText } from "../src/coverage.js";
import type { DiffFile } from "../src/git.js";

function project(contents: Record<string, string>) {
  const existing = new Set(Object.keys(contents));
  const readFile = (file: string) => contents[file] ?? null;
  const context = { cwd: "/repo", existing, readFile };
  return { existing, context, graph: buildImportGraph("/repo", existing, undefined, readFile, context) };
}
function changed(path: string, status: DiffFile["status"] = "modified"): DiffFile {
  return { path, status, additions: status === "deleted" ? 0 : 1, deletions: 1, patch: "" };
}

describe("preserving complete known dependency ranges", () => {
  it("selects changed tests together with their direct and transitive test importers", () => {
    const p = project({
      "test/shared.test.js": "export const double = value => value * 3;",
      "test/consumer.test.js": "import { double } from './shared.test.js'; export const value = double(2);",
      "test/outer.test.js": "import { value } from './consumer.test.js';",
      "test/unrelated.test.js": "export {};",
    });
    const impact = buildImpact([changed("test/shared.test.js")], p.existing, { graph: p.graph, pluginContext: p.context });
    expect(impact.mappedTests[0]?.tests).toEqual(["test/consumer.test.js", "test/outer.test.js", "test/shared.test.js"]);
    expect(impact.mappingEvidence).toContainEqual(expect.objectContaining({ test: "test/shared.test.js", origin: "changed-test" }));
    expect(impact.mappingEvidence).toContainEqual(expect.objectContaining({ test: "test/outer.test.js", via: "graph" }));
  });

  it("retains surviving consumers of a deleted test while reporting removed coverage", () => {
    const p = project({ "test/shared.test.js": "export const double = value => value * 2;", "test/consumer.test.js": "import './shared.test.js';" });
    const impact = buildImpact([changed("test/shared.test.js", "deleted")], p.existing,
      { baseGraph: p.graph, basePluginContext: p.context });
    expect(impact.mappedTests[0]?.tests).toEqual(["test/consumer.test.js"]);
    expect(impact.unmappedReasons?.["test/shared.test.js"]).toMatch(/Deleted test/);
  });

  it("unions coverage and cyclic graph consumers of a changed test", () => {
    const p = project({
      "test/shared.test.js": "import './consumer.test.js';",
      "test/consumer.test.js": "import './shared.test.js';",
      "test/coverage-only.test.js": "export {};",
    });
    const coverage = parseCoverageText('{"test/shared.test.js":["test/coverage-only.test.js"]}', "/repo", "json");
    const impact = buildImpact([changed("test/shared.test.js")], p.existing,
      { graph: p.graph, coverage, pluginContext: p.context });
    expect(impact.mappedTests[0]?.tests).toEqual(["test/consumer.test.js", "test/coverage-only.test.js", "test/shared.test.js"]);
    expect(impact.mappingEvidence).toContainEqual(expect.objectContaining({ test: "test/coverage-only.test.js", via: "coverage" }));
    expect(impact.mappingEvidence).toContainEqual(expect.objectContaining({ test: "test/consumer.test.js", via: "graph" }));
  });

  it("preserves static imports between strings containing comment delimiters", () => {
    const p = project({
      "src/value.js": "export const value = 2;",
      "test/value.test.js": "import '../src/value.js';",
      "test/consumer.test.js": 'const open = "/*";\nimport { value } from "../src/value.js";\nconst close = "*/";',
    });
    expect(p.graph.imports.get("test/consumer.test.js")).toEqual(["src/value.js"]);
    const impact = buildImpact([changed("src/value.js")], p.existing, { graph: p.graph, pluginContext: p.context });
    expect(impact.mappedTests[0]?.tests).toEqual(["test/consumer.test.js", "test/value.test.js"]);
  });

  it("does not extract imports from strings, comments, or regular expressions", () => {
    const source = [
      'const example = "import(\\\"./fake.js\\\")";',
      "const regex = /require\\(['\"]fake['\"]\\)/;",
      "/* import './comment.js'; */",
      "import './real.js';",
      "const template = `example: ${import('./inside-template.js')}`;",
    ].join("\n");
    expect(parseJsImports(source)).toEqual(["./inside-template.js", "./real.js"]);
    expect(dynamicDependencyDiagnostics("test/behavior.test.js", source)).toEqual([]);
  });

  it("diagnoses malformed syntax and selects the known suite even for a test-only edit", () => {
    const p = project({ "test/broken.test.ts": "import { missing from './value';", "test/other.test.ts": "export {};" });
    expect(p.graph.diagnostics).toContainEqual(expect.objectContaining({ code: "mapping-parse-error", files: ["test/broken.test.ts"] }));
    const impact = buildImpact([changed("test/broken.test.ts")], p.existing, { graph: p.graph });
    expect(impact.mappedTests[0]?.tests)
      .toEqual(["test/broken.test.ts", "test/other.test.ts"]);
    expect(impact.mappingEvidence).toContainEqual(expect.objectContaining({ test: "test/other.test.ts", origin: "parse-error-fallback" }));
  });

  it("shares static and dynamic dependency semantics across TS/JS syntax", () => {
    const source = [
      "import legacy = require('./legacy.cjs');",
      "export type { Value } from './types';",
      "type Loaded = import('./typed').Value;",
      'const escaped = require("./escaped\\x2ejs");',
      "const view = <div>{import('./jsx.js')}{import(variable)}</div>;",
    ].join("\n");
    expect(parseJsImports(source, "test/consumer.test.tsx")).toEqual(["./escaped.js", "./jsx.js", "./legacy.cjs", "./typed", "./types"]);
    expect(dynamicDependencyDiagnostics("test/consumer.test.tsx", source)).toEqual([
      expect.objectContaining({ code: "mapping-dynamic-dependency" }),
    ]);
  });
});
