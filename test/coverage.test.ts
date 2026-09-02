import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildImpact } from "../src/evidence.js";
import {
  loadCoverageMap,
  mapTestsForSource,
  parseCoverageText,
} from "../src/coverage.js";
import { mapTestsForFile } from "../src/mapping.js";
import type { DiffFile } from "../src/git.js";

function file(partial: Partial<DiffFile> & { path: string }): DiffFile {
  return {
    status: "modified",
    additions: 2,
    deletions: 0,
    patch: "",
    ...partial,
  };
}

describe("coverage map parsing", () => {
  it("parses Istanbul/V8 coverage-final.json", () => {
    const root = "/repo";
    const json = JSON.stringify({
      "/repo/src/utils/hash.ts": {
        path: "/repo/src/utils/hash.ts",
        statementMap: {},
        s: { "0": 1 },
      },
      "/repo/test/unit/hash.spec.ts": {
        path: "/repo/test/unit/hash.spec.ts",
        statementMap: {},
        s: { "0": 1 },
      },
    });
    const index = parseCoverageText(json, root, "json");
    expect(index?.origin).toBe("istanbul");
    expect(index?.sources.has("src/utils/hash.ts")).toBe(true);
    expect(index?.tests.has("test/unit/hash.spec.ts")).toBe(true);
  });

  it("parses an explicit source→tests JSON map", () => {
    const index = parseCoverageText(
      JSON.stringify({
        "src/foo.ts": ["custom/weird.test.ts"],
      }),
      "/repo",
      "json",
    );
    expect(index?.origin).toBe("map");
    expect(index?.sourceToTests.get("src/foo.ts")).toEqual(["custom/weird.test.ts"]);
  });

  it("parses Cobertura coverage.xml", () => {
    const xml = `<?xml version="1.0"?>
<coverage>
  <packages>
    <package name="pkg">
      <classes>
        <class filename="pkg/util.py" name="util"></class>
        <class filename="tests/unit/test_util.py" name="test_util"></class>
      </classes>
    </package>
  </packages>
</coverage>`;
    const index = parseCoverageText(xml, "/repo", "xml");
    expect(index?.origin).toBe("cobertura");
    expect(index?.sources.has("pkg/util.py")).toBe(true);
    expect(index?.tests.has("tests/unit/test_util.py")).toBe(true);
  });
});

describe("coverage-based mapping vs naming fallback", () => {
  it("maps via coverage basename when naming heuristics miss", () => {
    const existing = new Set([
      "src/utils/hash.ts",
      "test/unit/hash.spec.ts",
    ]);
    expect(mapTestsForFile("src/utils/hash.ts", existing)).toEqual([]);

    const coverage = parseCoverageText(
      JSON.stringify({
        "/repo/src/utils/hash.ts": { path: "/repo/src/utils/hash.ts", s: { "0": 1 } },
        "/repo/test/unit/hash.spec.ts": { path: "/repo/test/unit/hash.spec.ts", s: { "0": 1 } },
      }),
      "/repo",
      "json",
    );
    const mapped = mapTestsForSource("src/utils/hash.ts", existing, coverage);
    expect(mapped.tests).toEqual(["test/unit/hash.spec.ts"]);
    expect(mapped.via).toBe("coverage");
  });

  it("falls back to naming when no coverage map is present", () => {
    const existing = new Set(["src/foo.ts", "src/foo.test.ts"]);
    const mapped = mapTestsForSource("src/foo.ts", existing, null);
    expect(mapped.tests).toEqual(["src/foo.test.ts"]);
    expect(mapped.via).toBe("naming");
  });

  it("records mappingStrategy coverage when a map is loaded", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pp-cov-"));
    mkdirSync(path.join(dir, "coverage"), { recursive: true });
    writeFileSync(
      path.join(dir, "coverage", "coverage-final.json"),
      JSON.stringify({
        [`${dir}/src/utils/hash.ts`]: { path: `${dir}/src/utils/hash.ts`, s: { "0": 1 } },
        [`${dir}/test/unit/hash.spec.ts`]: {
          path: `${dir}/test/unit/hash.spec.ts`,
          s: { "0": 1 },
        },
      }),
    );
    const coverage = loadCoverageMap(dir);
    expect(coverage?.file).toBe("coverage/coverage-final.json");
    const impact = buildImpact(
      [file({ path: "src/utils/hash.ts" })],
      new Set(["src/utils/hash.ts", "test/unit/hash.spec.ts"]),
      { coverage },
    );
    expect(impact.mappingStrategy).toBe("coverage");
    expect(impact.mappedTests).toEqual([
      { source: "src/utils/hash.ts", tests: ["test/unit/hash.spec.ts"], via: "coverage" },
    ]);
    expect(impact.unmappedSources).toEqual([]);
  });

  it("uses naming strategy and leaves the file unmapped without coverage", () => {
    const impact = buildImpact(
      [file({ path: "src/utils/hash.ts" })],
      new Set(["src/utils/hash.ts", "test/unit/hash.spec.ts"]),
    );
    expect(impact.mappingStrategy).toBe("naming");
    expect(impact.mappedTests).toEqual([]);
    expect(impact.unmappedSources).toEqual(["src/utils/hash.ts"]);
  });

  it("honors ignorePaths in impact", () => {
    const impact = buildImpact(
      [file({ path: "src/utils/hash.ts" }), file({ path: "dist/bundle.js" })],
      new Set(["src/utils/hash.ts", "src/utils/hash.test.ts", "dist/bundle.js"]),
      { ignorePaths: ["dist/**"] },
    );
    expect(impact.changedFiles.map((f) => f.path)).toEqual(["src/utils/hash.ts"]);
    expect(impact.mappedTests[0]?.tests).toEqual(["src/utils/hash.test.ts"]);
  });
});
