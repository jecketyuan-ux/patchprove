import { describe, expect, it } from "vitest";
import { buildEvidence } from "../src/evidence.js";
import { evaluateVerification } from "../src/decision.js";
import { mergeConfig } from "../src/config.js";
import type { Evidence, ExecutionRecord } from "../src/types.js";

const hash = `sha256:${"ab".repeat(32)}`;
function complete(): Evidence {
  const evidence = buildEvidence({ cwd: "/tmp", root: "/tmp", range: { mode: "working-tree", base: "HEAD", head: null },
    impact: { changedFiles: [], mappedTests: [], unmappedSources: [], languages: [], mappingStrategy: "naming" },
    checks: [], gaps: [], findings: [],
  });
  evidence.snapshot = { algorithm: "sha256", version: 1, mode: "working-tree", base: "HEAD", head: null, mergeBase: null,
    currentHead: null, tree: null, contentHash: hash, patchHash: hash, dirty: false, consistent: true };
  evidence.effectivePolicy = { protocol: 2, strict: true, failOn: null, failOnNewGaps: null, gates: { typecheck: true, lint: true, tests: true, secrets: true },
    ignorePaths: [], acceptGaps: [], plugins: [], config: null, spec: null, baseline: null, hash };
  evidence.verificationPlan = [];
  evidence.executionRecords = [];
  return evidence;
}
function record(scope = ["a.ts"]): ExecutionRecord {
  return { id: "tests-a", checkId: "tests", scope, status: "passed", command: "vitest", args: [], cwd: "/tmp", exitCode: 0, durationMs: 1,
    testExecution: { parserVersion: "1", format: "vitest-json", reportStatus: "validated", granularity: "file", requestedScope: scope, collectedScope: scope, executedScope: scope, skippedScope: [], unknownScope: [],
      counts: { collected: scope.length, executed: scope.length, passed: scope.length, failed: 0, skipped: 0 } } };
}

describe("shared verification decision", () => {
  it("does not treat an old argv-only test scope as a fresh execution proof", () => {
    const evidence = complete();
    evidence.verificationPlan = [{ id: "tests", checkId: "tests", scope: ["a.ts"], required: true, reason: "selected" }];
    evidence.executionRecords = [record()];
    delete evidence.executionRecords[0]!.testExecution;
    expect(evaluateVerification(evidence).status).toBe("incomplete");
  });
  it("does not let an auxiliary imported task erase already proven required execution", () => {
    const evidence = complete();
    evidence.verificationPlan = [{ id: "tests", checkId: "tests", scope: ["a.ts"], required: true, reason: "selected" }];
    const auxiliary = { ...record(["other.ts"]), id: "nx:other", status: "imported" as const };
    delete auxiliary.testExecution;
    evidence.executionRecords = [record(), auxiliary];
    expect(evaluateVerification(evidence).status).toBe("passed");
  });
  it("cannot pass contradictory copies of an execution supplied directly by an SDK caller", () => {
    const evidence = complete();
    evidence.executionRecords = [record()];
    evidence.checks = [{ id: "tests", name: "tests", status: "passed", command: null, exitCode: 0, durationMs: 1,
      records: [{ ...record(), status: "failed", exitCode: 1 }] }];
    expect(evaluateVerification(evidence).status).not.toBe("passed");
  });
  it("passes a complete run with no applicable planned checks", () => {
    expect(evaluateVerification(complete()).status).toBe("passed");
  });

  it("marks legacy and drifted evidence incomplete", () => {
    const evidence = complete();
    delete evidence.snapshot;
    expect(evaluateVerification(evidence)).toMatchObject({ status: "incomplete", legacy: true });
    const drift = complete();
    drift.snapshot!.consistent = false;
    expect(evaluateVerification(drift).reasons.some((reason) => reason.code === "snapshot-mismatch")).toBe(true);
  });

  it("requires successful execution covering every required planned scope", () => {
    const evidence = complete();
    evidence.verificationPlan = [{ id: "tests", checkId: "tests", scope: ["a.ts", "b.ts"], required: true, reason: "changed tests" }];
    evidence.executionRecords = [record()];
    expect(evaluateVerification(evidence)).toMatchObject({ status: "incomplete", reasons: [{ code: "planned-scope-unverified", scope: ["b.ts"] }] });
    evidence.executionRecords.push({ ...record(["b.ts"]), id: "tests-b" });
    expect(evaluateVerification(evidence).status).toBe("passed");
  });

  it("cannot prove a local passed execution without a successful exit code", () => {
    const evidence = complete();
    evidence.executionRecords = [{ ...record(), exitCode: null }];
    expect(evaluateVerification(evidence)).toMatchObject({ status: "incomplete", reasons: [{ code: "execution-exit-unproven" }] });
  });

  it("requires cache/import provenance to identify the verified snapshot", () => {
    const evidence = complete();
    evidence.verificationPlan = [{ id: "tests", checkId: "tests", scope: ["a.ts"], required: true, reason: "changed tests" }];
    evidence.executionRecords = [{ ...record(), status: "imported" }];
    expect(evaluateVerification(evidence).status).toBe("incomplete");
    evidence.executionRecords[0]!.provenance = { adapter: "nx", version: "1", inputHash: hash, snapshotHash: hash };
    expect(evaluateVerification(evidence).status).toBe("passed");
  });

  it("requires a successful exit in addition to snapshot provenance for imported execution", () => {
    const evidence = complete();
    evidence.verificationPlan = [{ id: "tests", checkId: "tests", scope: ["a.ts"], required: true, reason: "changed tests" }];
    evidence.executionRecords = [{ ...record(), status: "imported", exitCode: null,
      provenance: { adapter: "nx", version: "1", inputHash: hash, snapshotHash: hash } }];
    expect(evaluateVerification(evidence)).toMatchObject({ status: "incomplete", reasons: [{ code: "planned-scope-unverified", scope: ["a.ts"] }] });
    evidence.executionRecords[0]!.exitCode = 0;
    expect(evaluateVerification(evidence).status).toBe("passed");
    evidence.executionRecords[0]!.exitCode = 1;
    expect(evaluateVerification(evidence).status).toBe("failed");
    evidence.executionRecords[0]!.exitCode = null;
    evidence.executionRecords[0]!.status = "cached";
    expect(evaluateVerification(evidence).status).toBe("passed");
  });

  it("requires every configured tool unit even when units share repository scope", () => {
    const evidence = complete();
    evidence.verificationPlan = ["tsc", "pyright"].map((tool) => ({ id: tool, unitId: `typecheck:${tool}`, checkId: "typecheck", scope: ["."], required: true, reason: "configured tool" }));
    evidence.executionRecords = [{ ...record(["."]), id: "typecheck:tsc", checkId: "typecheck" }];
    expect(evaluateVerification(evidence).status).toBe("incomplete");
    evidence.executionRecords.push({ ...record(["."]), id: "typecheck:pyright", checkId: "typecheck" });
    expect(evaluateVerification(evidence).status).toBe("passed");
    evidence.diagnostics = [{ code: "input-stale", message: "Affected input is stale", severity: "error", files: ["a.ts"] }];
    expect(evaluateVerification(evidence)).toMatchObject({ status: "incomplete", reasons: [{ code: "input-stale", scope: ["a.ts"] }] });
  });

  it("keeps failures authoritative under relaxed thresholds", () => {
    const evidence = complete();
    evidence.checks = [{ id: "tests", name: "tests", status: "failed" }];
    expect(evaluateVerification(evidence, mergeConfig(null, { strict: false })).status).toBe("failed");
    evidence.checks = [];
    evidence.executionRecords = [{ ...record(), status: "timed-out", exitCode: 0 }];
    expect(evaluateVerification(evidence).status).toBe("failed");
  });

  it("does not accept an execution that reports zero collected tests", () => {
    const evidence = complete();
    evidence.executionRecords = [{ ...record(), collectedTests: 0 }];
    expect(evaluateVerification(evidence)).toMatchObject({ status: "incomplete", reasons: [{ code: "zero-tests-collected" }] });
  });

  it("keeps open gaps incomplete and required gates enforced when optional gates are disabled", () => {
    const evidence = complete();
    evidence.gaps = [{ id: "unknown", kind: "tool-missing", message: "unverified scope", risk: "low" }];
    expect(evaluateVerification(evidence).status).toBe("incomplete");
    evidence.gaps = [];
    evidence.verificationPlan = [{ id: "lint", checkId: "lint", scope: ["a.ts"], required: true, reason: "source" }];
    const config = mergeConfig(null, { disableGate: ["lint"] });
    expect(evaluateVerification(evidence, config).status).toBe("passed");
    evidence.contract = { loaded: true, passed: false, source: "SPEC.md", format: "yaml", clauses: [{ id: "required-gate-lint", kind: "required-gate", passed: false, message: "required" }] };
    expect(evaluateVerification(evidence, config).status).toBe("failed");
  });
});
