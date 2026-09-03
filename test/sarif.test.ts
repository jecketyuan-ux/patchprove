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

  it("emits a failed contract clause as a SARIF result", () => {
    const evidence = buildEvidence({
      cwd: "/tmp",
      root: "/tmp",
      range: { mode: "working-tree", base: "HEAD", head: null },
      impact: {
        changedFiles: [],
        mappedTests: [],
        unmappedSources: ["src/crypto/box.ts"],
        languages: ["typescript"],
        mappingStrategy: "naming",
      },
      checks: [],
      gaps: [],
      findings: [],
      generatedAt: "2026-09-03T00:00:00.000Z",
      contract: {
        loaded: true,
        passed: false,
        source: "/tmp/.patchprove/spec.yml",
        format: "yaml",
        clauses: [
          {
            id: "forbidden-unproven-0",
            kind: "forbidden-unproven",
            passed: false,
            message: "Forbidden unproven path: src/crypto/box.ts",
            files: ["src/crypto/box.ts"],
          },
          {
            id: "required-gate-tests",
            kind: "required-gate",
            passed: true,
            message: "required gate tests passed",
          },
        ],
      },
    });

    const sarif = toSarif(evidence);
    const run = (sarif.runs as Array<{ results: Array<Record<string, unknown>> }>)[0];
    const results = run?.results ?? [];
    const failed = results.find((r) => r.ruleId === "forbidden-unproven");
    expect(failed).toBeTruthy();
    expect(failed?.level).toBe("error");
    expect((failed?.message as { text: string }).text).toMatch(/src\/crypto\/box\.ts/);
    expect(failed?.properties).toMatchObject({
      clauseId: "forbidden-unproven-0",
      contractKind: "forbidden-unproven",
      passed: false,
    });
    expect(results.some((r) => r.ruleId === "required-gate")).toBe(false);
  });
});
