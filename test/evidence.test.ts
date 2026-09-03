import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  buildEvidence,
  buildImpact,
  collectGaps,
  failedCheckFindings,
  pathFindings,
} from "../src/evidence.js";
import type { DiffFile } from "../src/git.js";
import { emptyDetectedTools, type CheckResult } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(path.join(here, "../schema/evidence.schema.json"), "utf8"),
) as object;

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

const emptyTools = emptyDetectedTools();

function file(partial: Partial<DiffFile> & { path: string }): DiffFile {
  return {
    status: "modified",
    additions: 3,
    deletions: 1,
    patch: "",
    ...partial,
  };
}

describe("evidence JSON shape", () => {
  it("matches the published 1.x schema", () => {
    const files = [
      file({ path: "src/auth/session.ts" }),
      file({ path: "src/utils/hash.ts" }),
      file({ path: ".github/workflows/ci.yml" }),
    ];
    const existing = new Set([
      "src/auth/session.ts",
      "src/auth/session.test.ts",
      "src/utils/hash.ts",
      ".github/workflows/ci.yml",
    ]);
    const impact = buildImpact(files, existing);
    const checks: CheckResult[] = [
      {
        id: "typecheck",
        name: "typecheck (tsc)",
        status: "passed",
        reason: "ok",
        command: "tsc --noEmit",
        exitCode: 0,
        durationMs: 12,
      },
      {
        id: "lint",
        name: "lint",
        status: "skipped",
        reason: "No linter configured (eslint / ruff)",
        command: null,
        exitCode: null,
        durationMs: 0,
      },
      {
        id: "tests",
        name: "affected tests",
        status: "skipped",
        reason: "No mapped tests for this diff",
        command: null,
        exitCode: null,
        durationMs: 0,
      },
      {
        id: "secrets",
        name: "secret scan (regex)",
        status: "passed",
        reason: "ok",
        command: null,
        exitCode: 0,
        durationMs: 1,
      },
    ];
    const gaps = collectGaps(impact, checks, emptyTools);
    const findings = [
      ...pathFindings(impact.changedFiles),
      ...failedCheckFindings(checks),
    ];
    const evidence = buildEvidence({
      cwd: "/tmp/demo",
      root: "/tmp/demo",
      range: { mode: "working-tree", base: "HEAD", head: null },
      impact,
      checks,
      gaps,
      findings,
      generatedAt: "2026-09-02T00:00:00.000Z",
    });

    const ok = validate(evidence);
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
    expect(evidence.schemaVersion).toBe("1.2.0");
    expect(evidence.impact.mappingStrategy).toBe("naming");
    expect(evidence.summary.acceptedGapCount).toBe(0);
    expect(evidence.impact.mappedTests).toEqual([
      { source: "src/auth/session.ts", tests: ["src/auth/session.test.ts"], via: "naming" },
    ]);
    expect(evidence.impact.unmappedSources).toContain("src/utils/hash.ts");
    expect(evidence.summary.risk).toBe("high");
    expect(evidence.findings.some((f) => f.kind === "workflow")).toBe(true);
    expect(evidence.findings.some((f) => f.kind === "auth-crypto")).toBe(true);
    expect(evidence.gaps.some((g) => g.kind === "unmapped-test")).toBe(true);
  });

  it("raises summary risk to critical when a secret finding is present", () => {
    const impact = buildImpact([], new Set());
    const evidence = buildEvidence({
      cwd: "/tmp",
      root: "/tmp",
      range: { mode: "range", base: "abc", head: "def" },
      impact,
      checks: [],
      gaps: [],
      findings: [
        {
          id: "secret-1",
          kind: "secret",
          risk: "critical",
          message: "AWS access key",
          path: "env.ts",
        },
      ],
      generatedAt: "2026-09-02T00:00:00.000Z",
    });
    expect(validate(evidence)).toBe(true);
    expect(evidence.summary.risk).toBe("critical");
  });
});
