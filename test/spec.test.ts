import { describe, expect, it } from "vitest";
import { evaluateContract, extractYamlFromSpecMd, parseContractText } from "../src/spec.js";
import { buildEvidence, buildImpact } from "../src/evidence.js";
import type { DiffFile } from "../src/git.js";
import { emptyDetectedTools } from "../src/types.js";
import { collectGaps } from "../src/evidence.js";

function file(path: string): DiffFile {
  return { path, status: "modified", additions: 2, deletions: 0, patch: "" };
}

describe("SPEC / contract parsing", () => {
  it("parses required gates, max risk, globs, and policy", () => {
    const spec = parseContractText(
      `
schemaVersion: "1.0"
requiredGates: [tests, secrets]
maxResidualRisk: medium
requiredMappedTests:
  - glob: src/auth/**
    reason: auth must have mapped tests
forbiddenUnproven:
  - src/crypto/**
acceptedResidualRisk:
  policy: listed-only
`,
      "inline",
    );
    expect(spec.requiredGates).toEqual(["tests", "secrets"]);
    expect(spec.maxResidualRisk).toBe("medium");
    expect(spec.requiredMappedTests[0]).toEqual({
      glob: "src/auth/**",
      reason: "auth must have mapped tests",
    });
    expect(spec.forbiddenUnproven[0]?.glob).toBe("src/crypto/**");
    expect(spec.acceptedResidualRisk.policy).toBe("listed-only");
  });

  it("extracts a fenced yaml block from SPEC.md", () => {
    const md = `# Contract\n\n\`\`\`yaml\nrequiredGates:\n  - tests\nmaxResidualRisk: high\n\`\`\`\n`;
    const extracted = extractYamlFromSpecMd(md);
    expect(extracted?.via).toBe("fence");
    const parsed = parseContractText(extracted?.yaml ?? "", "SPEC.md");
    expect(parsed.requiredGates).toEqual(["tests"]);
    expect(parsed.maxResidualRisk).toBe("high");
  });

  it("extracts a link to yaml from SPEC.md", () => {
    const md = `See the [contract](.patchprove/spec.yml).\n`;
    expect(extractYamlFromSpecMd(md)).toEqual({ yaml: ".patchprove/spec.yml", via: "link" });
  });
});

describe("contract evaluation", () => {
  const existing = new Set([
    "src/auth/session.ts",
    "src/auth/session.test.ts",
    "src/utils/hash.ts",
    "src/crypto/box.ts",
  ]);
  const impact = buildImpact(
    [file("src/auth/session.ts"), file("src/utils/hash.ts"), file("src/crypto/box.ts")],
    existing,
  );
  const evidence = buildEvidence({
    cwd: "/tmp",
    root: "/tmp",
    range: { mode: "working-tree", base: "HEAD", head: null },
    impact,
    checks: [
      { id: "typecheck", name: "typecheck", status: "skipped", reason: "none" },
      { id: "lint", name: "lint", status: "skipped", reason: "none" },
      { id: "tests", name: "tests", status: "passed", reason: "ok" },
      { id: "secrets", name: "secrets", status: "passed", reason: "ok" },
    ],
    gaps: collectGaps(impact, [], emptyDetectedTools()),
    findings: [],
    generatedAt: "2026-09-02T00:00:00.000Z",
  });

  it("fails required mapped tests and forbidden unproven globs", () => {
    const spec = parseContractText(
      `
requiredGates: [tests]
maxResidualRisk: high
requiredMappedTests:
  - glob: src/auth/**
forbiddenUnproven:
  - glob: src/crypto/**
acceptedResidualRisk:
  policy: allow
`,
      "inline",
    );
    const result = evaluateContract({ ...spec, sourcePath: "SPEC.md", format: "markdown" }, evidence);
    expect(result.loaded).toBe(true);
    expect(result.clauses.find((c) => c.kind === "required-gate")?.passed).toBe(true);
    expect(result.clauses.find((c) => c.kind === "required-mapped-tests")?.passed).toBe(true);
    const forbidden = result.clauses.find((c) => c.kind === "forbidden-unproven");
    expect(forbidden?.passed).toBe(false);
    expect(forbidden?.files).toContain("src/crypto/box.ts");
    expect(result.passed).toBe(false);
  });

  it("fails listed-only when open gaps remain", () => {
    const spec = parseContractText(
      `
acceptedResidualRisk:
  policy: listed-only
`,
      "inline",
    );
    const result = evaluateContract({ ...spec, sourcePath: "x", format: "yaml" }, evidence);
    expect(result.clauses.find((c) => c.kind === "accepted-residual-risk")?.passed).toBe(false);
  });

  it("passes maxResidualRisk when under the cap", () => {
    const spec = parseContractText(`maxResidualRisk: critical\n`, "inline");
    const result = evaluateContract({ ...spec, sourcePath: "x", format: "yaml" }, evidence);
    expect(result.clauses.find((c) => c.kind === "max-residual-risk")?.passed).toBe(true);
  });
});
