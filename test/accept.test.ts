import { describe, expect, it } from "vitest";
import { applyAcceptedGaps, findAcceptMatch } from "../src/accept.js";
import { buildEvidence, collectGaps } from "../src/evidence.js";
import type { CheckResult, DetectedTools, Gap } from "../src/types.js";

const emptyTools: DetectedTools = {
  typescript: false,
  tscBin: null,
  eslint: false,
  eslintBin: null,
  vitest: false,
  vitestBin: null,
  jest: false,
  jestBin: null,
  python: false,
  pyright: false,
  pyrightBin: null,
  mypy: false,
  mypyBin: null,
  ruff: false,
  ruffBin: null,
  pytest: false,
  pytestBin: null,
  gitleaks: false,
  gitleaksBin: null,
};

const skippedChecks: CheckResult[] = [
  { id: "typecheck", name: "typecheck", status: "skipped", reason: "No typechecker configured (tsc / pyright / mypy)" },
  { id: "lint", name: "lint", status: "skipped", reason: "No linter configured (eslint / ruff)" },
  { id: "tests", name: "affected tests", status: "skipped", reason: "No mapped tests for this diff" },
  { id: "secrets", name: "secret scan (regex)", status: "passed", reason: "ok" },
];

function unmappedGap(file: string): Gap {
  return {
    id: `gap-unmapped-${file}`,
    kind: "unmapped-test",
    message: `No nearby test mapped for ${file}`,
    risk: "medium",
    files: [file],
  };
}

describe("acceptGaps matching", () => {
  it("matches gap ids and path patterns", () => {
    const gap = unmappedGap("src/generated/foo.ts");
    expect(findAcceptMatch(gap, [{ id: "gap-unmapped-src/generated/foo.ts" }])).toBeTruthy();
    expect(findAcceptMatch(gap, [{ path: "src/generated/**", reason: "codegen" }])?.reason).toBe(
      "codegen",
    );
    expect(findAcceptMatch(gap, [{ path: "vendor/**" }])).toBeUndefined();
  });
});

describe("accepted gaps do not inflate summary risk", () => {
  it("drops medium unmapped risk when the only gap is accepted", () => {
    const impact = {
      changedFiles: [
        {
          path: "src/utils/hash.ts",
          status: "modified" as const,
          additions: 1,
          deletions: 0,
          highRisk: false,
          riskKind: null,
        },
      ],
      mappedTests: [],
      unmappedSources: ["src/utils/hash.ts"],
      languages: ["typescript" as const],
      mappingStrategy: "naming" as const,
    };
    const gaps = collectGaps(impact, skippedChecks, emptyTools);
    expect(gaps.some((g) => g.kind === "unmapped-test")).toBe(true);

    const open = buildEvidence({
      cwd: "/tmp",
      root: "/tmp",
      range: { mode: "working-tree", base: "HEAD", head: null },
      impact,
      checks: skippedChecks,
      gaps,
      findings: [],
      generatedAt: "2026-09-02T00:00:00.000Z",
    });
    expect(open.summary.risk).toBe("medium");
    expect(open.summary.gapCount).toBeGreaterThan(0);
    expect(open.summary.acceptedGapCount).toBe(0);

    const accepted = buildEvidence({
      cwd: "/tmp",
      root: "/tmp",
      range: { mode: "working-tree", base: "HEAD", head: null },
      impact,
      checks: skippedChecks,
      gaps,
      findings: [],
      acceptGaps: [{ path: "src/utils/hash.ts", reason: "known untested helper" }],
      generatedAt: "2026-09-02T00:00:00.000Z",
    });
    expect(accepted.gaps.every((g) => g.accepted === true)).toBe(true);
    expect(accepted.gaps[0]?.acceptedReason).toBe("known untested helper");
    expect(accepted.summary.risk).toBe("none");
    expect(accepted.summary.gapCount).toBe(0);
    expect(accepted.summary.acceptedGapCount).toBeGreaterThan(0);
  });

  it("keeps high findings even when gaps are accepted", () => {
    const gaps = applyAcceptedGaps([unmappedGap("src/utils/hash.ts")], [
      { path: "src/utils/**" },
    ]);
    const evidence = buildEvidence({
      cwd: "/tmp",
      root: "/tmp",
      range: { mode: "working-tree", base: "HEAD", head: null },
      impact: {
        changedFiles: [],
        mappedTests: [],
        unmappedSources: [],
        languages: [],
        mappingStrategy: "naming",
      },
      checks: [],
      gaps,
      findings: [
        {
          id: "path-1",
          kind: "workflow",
          risk: "high",
          message: "High-risk path (workflow): .github/workflows/ci.yml",
          path: ".github/workflows/ci.yml",
        },
      ],
      generatedAt: "2026-09-02T00:00:00.000Z",
    });
    expect(evidence.summary.risk).toBe("high");
    expect(evidence.gaps[0]?.accepted).toBe(true);
  });
});
