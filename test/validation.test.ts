import { describe, expect, it } from "vitest";
import { buildEvidence } from "../src/evidence.js";
import { validateEvidence, validateReceipt } from "../src/validation.js";

function evidence() {
  return buildEvidence({ cwd: "/tmp", root: "/tmp", range: { mode: "working-tree", base: "HEAD", head: null },
    impact: { changedFiles: [], mappedTests: [], unmappedSources: [], languages: [], mappingStrategy: "naming" }, checks: [], gaps: [], findings: [] });
}

describe("versioned runtime readers", () => {
  it("accepts historical packs and additive optional fields without inventing provenance", () => {
    const raw = { ...evidence(), schemaVersion: "1.0.0", contract: undefined, baselineComparison: undefined, futureOptional: { a: 1 } };
    const parsed = validateEvidence(raw, "old.json");
    expect(parsed.contract.passed).toBe(true);
    expect(parsed.snapshot).toBeUndefined();
    expect((parsed as unknown as Record<string, unknown>).futureOptional).toEqual({ a: 1 });
  });

  it.each([
    { schemaVersion: "99.0.0" }, { findings: undefined }, { checks: [{ id: "tests", name: "tests", status: "unknown" }] },
    { summary: { risk: "none", checksPassed: -1, checksFailed: 0, checksSkipped: 0, gapCount: 0, acceptedGapCount: 0, findingCount: 0 } },
  ])("rejects invalid required structure %j with the input source", (overrides) => {
    expect(() => validateEvidence({ ...evidence(), ...overrides }, "bad.json")).toThrow(/bad.json.*\//);
  });

  it("rejects duplicate identities and summaries contradicting details", () => {
    const check = { id: "tests", name: "tests", status: "passed" };
    expect(() => validateEvidence({ ...evidence(), checks: [check, check] }, "duplicate.json")).toThrow(/duplicate identity/);
    expect(() => validateEvidence({ ...evidence(), checks: [check] }, "counts.json")).toThrow(/checksPassed/);
    expect(() => validateEvidence({ ...evidence(), summary: { ...evidence().summary, risk: "high" } }, "risk.json")).toThrow(/summary\/risk/);
  });

  it("requires provenance and an explicit decision in protocol 2", () => {
    expect(() => validateEvidence({ ...evidence(), schemaVersion: "2.0.0" }, "strict.json")).toThrow(/snapshot|verificationPlan|executionRecords|effectivePolicy|verification/);
  });

  it("does not normalize missing required fields in recent compatibility packs", () => {
    expect(() => validateEvidence({ ...evidence(), schemaVersion: "1.3.0", contract: undefined }, "recent.json")).toThrow(/contract/);
  });

  it("validates receipt structure and rejects unsupported major versions", () => {
    const receipt = { schemaVersion: "1.2.0", algorithm: "sha256", contentHash: `sha256:${"ab".repeat(32)}`, toolVersion: "1.2.0", evidenceSchemaVersion: "1.2.0",
      argv: [], options: {}, exitCode: 0, failOnOutcome: { failed: false, reason: "ok" }, checks: [], generatedAt: "2026-10-22T00:00:00.000Z" };
    expect(validateReceipt({ ...receipt, futureOptional: true }).schemaVersion).toBe("1.2.0");
    expect(() => validateReceipt({ ...receipt, schemaVersion: "99.0.0" }, "receipt.json")).toThrow(/schemaVersion/);
    expect(() => validateReceipt({ ...receipt, algorithm: "sha512" }, "receipt.json")).toThrow(/algorithm/);
  });
});
