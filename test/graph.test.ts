import { describe, expect, it } from "vitest";
import { buildImportGraph, mapTestsFromGraph } from "../src/graph.js";
import { parseJsImports, resolveJsImport } from "../src/plugins/js.js";
import { parsePyImports, resolvePyImport } from "../src/plugins/python.js";
import { mapTestsForSource } from "../src/coverage.js";
import { buildImpact } from "../src/evidence.js";
import type { DiffFile } from "../src/git.js";

function files(map: Record<string, string>): {
  existing: Set<string>;
  read: (rel: string) => string | null;
} {
  const existing = new Set(Object.keys(map));
  return {
    existing,
    read: (rel) => (rel in map ? (map[rel] as string) : null),
  };
}

describe("JS/TS import parsing", () => {
  it("parses from / side-effect / require specifiers", () => {
    const src = `
      import { ttl } from "./session.ts";
      import "./side.js";
      export { x } from "../lib/x";
      const m = require("./legacy.cjs");
      const d = import("./dyn.js");
    `;
    expect(parseJsImports(src)).toEqual([
      "../lib/x",
      "./dyn.js",
      "./legacy.cjs",
      "./session.ts",
      "./side.js",
    ]);
  });

  it("resolves relative specifiers with TS/JS extensions", () => {
    const existing = new Set(["src/auth/session.ts", "src/auth/session.test.ts", "src/lib/x.ts"]);
    expect(resolveJsImport("src/auth/session.test.ts", "./session.ts", existing)).toBe(
      "src/auth/session.ts",
    );
    expect(resolveJsImport("src/auth/session.test.ts", "../lib/x.js", existing)).toBe("src/lib/x.ts");
  });
});

describe("Python import heuristics", () => {
  it("parses from/import and resolves repo files", () => {
    expect(parsePyImports("from pkg.util import hash\nimport os\nfrom .local import x\n")).toEqual([
      ".local",
      "os",
      "pkg.util",
    ]);
    const existing = new Set(["pkg/util.py", "pkg/local.py", "tests/test_util.py"]);
    expect(resolvePyImport("tests/test_util.py", "pkg.util", existing)).toBe("pkg/util.py");
    expect(resolvePyImport("pkg/mod.py", ".local", existing)).toBe("pkg/local.py");
  });
});

describe("import graph reverse mapping", () => {
  it("maps a changed source to tests that import it, including one hop", () => {
    const { existing, read } = files({
      "src/utils/hash.ts": "export const hash = (s: string) => s;\n",
      "src/utils/hash.test.ts": 'import { hash } from "./hash.ts";\n',
      "src/auth/session.ts": 'import { hash } from "../utils/hash.ts";\nexport const ttl = 1;\n',
      "src/auth/session.test.ts": 'import { ttl } from "./session.ts";\n',
    });
    const graph = buildImportGraph("/repo", existing, undefined, read);
    expect(mapTestsFromGraph("src/utils/hash.ts", existing, graph)).toEqual([
      "src/auth/session.test.ts",
      "src/utils/hash.test.ts",
    ]);
    expect(mapTestsFromGraph("src/auth/session.ts", existing, graph)).toEqual([
      "src/auth/session.test.ts",
    ]);
    const mapped = mapTestsForSource("src/utils/hash.ts", existing, null, graph);
    expect(mapped.via).toBe("graph");
    expect(mapped.tests).toContain("src/auth/session.test.ts");
  });

  it("records mappingStrategy graph when graph produces the mapping", () => {
    const { existing, read } = files({
      "src/utils/hash.ts": "export const hash = (s: string) => s;\n",
      "test/unit/hash.spec.ts": 'import { hash } from "../../src/utils/hash.ts";\n',
    });
    const graph = buildImportGraph("/repo", existing, undefined, read);
    const impact = buildImpact(
      [{ path: "src/utils/hash.ts", status: "modified", additions: 1, deletions: 0, patch: "" } as DiffFile],
      existing,
      { graph },
    );
    expect(impact.mappingStrategy).toBe("graph");
    expect(impact.mappedTests[0]).toEqual({
      source: "src/utils/hash.ts",
      tests: ["test/unit/hash.spec.ts"],
      via: "graph",
    });
  });
});
