import { describe, expect, it } from "vitest";
import { buildEvidence } from "../src/evidence.js";
import { toSarif } from "../src/sarif.js";

describe("toSarif", () => {
  it("emits findings and marks accepted gaps as suppressed", () => {
    const evidence = buildEvidence({
      cwd: "/tmp",
      root: "/tmp",
      range: { mode: "working-tree", base: "HEAD", head: null },
      impact: {
        changedFiles: [],
        mappedTests: [],
        unmappedSources: ["src/utils/hash.ts"],
        languages: ["typescript"],
        mappingStrategy: "naming",
      },
      checks: [],
      gaps: [
        {
          id: "gap-unmapped-src/utils/hash.ts",
          kind: "unmapped-test",
          message: "No nearby test mapped for src/utils/hash.ts",
          risk: "medium",
          files: ["src/utils/hash.ts"],
        },
      ],
      findings: [
        {
          id: "path-1",
          kind: "workflow",
          risk: "high",
          message: "High-risk path (workflow): .github/workflows/ci.yml",
          path: ".github/workflows/ci.yml",
        },
      ],
      acceptGaps: [{ path: "src/utils/hash.ts", reason: "known" }],
      generatedAt: "2026-09-02T00:00:00.000Z",
    });

    const sarif = toSarif(evidence);
    expect(sarif.version).toBe("2.1.0");
    const run = (sarif.runs as Array<{ results: Array<Record<string, unknown>> }>)[0];
    expect(run).toBeTruthy();
    const results = run?.results ?? [];
    const gap = results.find((r) => r.ruleId === "unmapped-test");
    expect(gap?.level).toBe("note");
    expect(gap?.suppressions).toEqual([
      { kind: "external", status: "accepted", justification: "known" },
    ]);
    const finding = results.find((r) => r.ruleId === "workflow");
    expect(finding?.level).toBe("error");
  });
});
