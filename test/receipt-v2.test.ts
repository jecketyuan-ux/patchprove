import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEvidence } from "../src/evidence.js";
import * as graph from "../src/graph.js";
import { attachReceiptRef, buildReceipt, hashCanonical, hashEvidence, hashReceiptPayload, publicKeyFingerprint, verifyReceipt } from "../src/receipt.js";
import type { EffectivePolicy, Evidence, EvidenceReceipt, ExecutionRecord, RunOptions } from "../src/types.js";
import { validateEvidence, validateReceipt } from "../src/validation.js";
import { failOnOutcomeOf } from "../src/run.js";

const fixtureKey = "hmac:receipt-v2-fixture-key";
const roots: string[] = [];
const digest = (byte: string) => byte.repeat(64);

function modernEvidence(): Evidence {
  const record: ExecutionRecord = {
    id: "tests:fixture", checkId: "tests", scope: ["src/value.test.ts"], status: "passed",
    command: "node", args: ["--test", "src/value.test.ts"], cwd: "/tmp/fixture",
    exitCode: 0, durationMs: 12, collectedTests: 1, outputHash: digest("b"),
  };
  const base = buildEvidence({
    cwd: "/tmp/fixture", root: "/tmp/fixture", generatedAt: "2026-10-22T00:00:00.000Z",
    range: { mode: "working-tree", base: "a".repeat(40), head: null },
    impact: { changedFiles: [], mappedTests: [], unmappedSources: [], languages: [], mappingStrategy: "naming" },
    checks: [{ id: "tests", name: "tests", status: "passed", command: "node --test src/value.test.ts", exitCode: 0, durationMs: 12, detail: "one test passed", records: [record] }],
    gaps: [], findings: [],
  });
  const policy: Omit<EffectivePolicy, "hash"> = {
    protocol: 2, strict: true, failOn: null, failOnNewGaps: null,
    gates: { typecheck: false, lint: false, tests: true, secrets: false },
    ignorePaths: [], acceptGaps: [], plugins: [], config: null, spec: null, baseline: null,
  };
  const evidence: Evidence = {
    ...base, schemaVersion: "2.0.0", toolVersion: "2.0.0",
    snapshot: { algorithm: "sha256", version: 1, mode: "working-tree", base: "a".repeat(40), head: null, mergeBase: null, currentHead: "a".repeat(40), tree: "c".repeat(40), contentHash: digest("c"), patchHash: digest("d"), dirty: true, consistent: true },
    executionRecords: [record],
    verificationPlan: [{ id: record.id, checkId: "tests", scope: record.scope, required: true, reason: "changed test" }],
    verification: { status: "passed", strict: true, reasons: [] },
    effectivePolicy: { ...policy, hash: hashCanonical(policy) },
  };
  return validateEvidence(evidence, "v2 fixture");
}

function receiptFor(evidence: Evidence): EvidenceReceipt {
  const outcome = failOnOutcomeOf(evidence);
  return buildReceipt({ evidence, argv: ["run", "--sign"], options: { sign: true, out: "evidence.json", format: "json" }, exitCode: outcome.failed ? 1 : 0, failOnOutcome: outcome, sign: true, signingKey: fixtureKey, generatedAt: "2026-10-22T00:00:01.000Z" });
}
function clone<T>(value: T): T { return structuredClone(value); }
function rejected(evidence: Evidence, receipt: EvidenceReceipt): boolean {
  try { return !verifyReceipt(evidence, receipt, fixtureKey).ok; } catch { return true; }
}
function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
}
function write(root: string, relative: string, content: string): void {
  const absolute = path.join(root, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}
function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "patchprove-receipt-v2-"));
  roots.push(root);
  git(root, "init");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Receipt fixture");
  write(root, "src/value.ts", "export const value = 1;\n");
  write(root, ".gitignore", "evidence*.json\nnode_modules/\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "seed");
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("protocol 2 receipt authentication", () => {
  it("validates and verifies a fully populated signed envelope", () => {
    const evidence = modernEvidence();
    const receipt = receiptFor(evidence);
    expect(validateReceipt(receipt)).toEqual(receipt);
    expect(receipt.schemaVersion).toBe("2.0.0");
    expect(receipt.canonicalizationVersion).toBe("2");
    expect(verifyReceipt(evidence, receipt, fixtureKey, { requireSignature: true, allowLegacy: false })).toMatchObject({ ok: true, hashMatches: true, payloadMatches: true, signature: "verified", legacy: false });
    expect(hashEvidence(attachReceiptRef(evidence, receipt, { path: "evidence.receipt.json" }))).toBe(receipt.contentHash);
  });

  it("rejects signing malformed v2 evidence without execution records or a verification plan", () => {
    for (const field of ["executionRecords", "verificationPlan"] as const) {
      const malformed = modernEvidence();
      delete malformed[field];
      expect(() => receiptFor(malformed)).toThrow(new RegExp(field));
    }
  });

  it("rejects a stale decision or contradictory exit metadata before signing", () => {
    const evidence = modernEvidence();
    evidence.executionRecords![0]!.exitCode = null;
    expect(() => receiptFor(evidence)).toThrow(/decision/);
    expect(() => buildReceipt({ evidence: modernEvidence(), exitCode: 1, failOnOutcome: { failed: true, reason: "fail-on" } })).toThrow(/exit code/);
  });

  it.each([
    ["exit code", (receipt: EvidenceReceipt) => { receipt.exitCode = 1; }],
    ["policy outcome", (receipt: EvidenceReceipt) => { receipt.failOnOutcome = { failed: true, reason: "fail-on" }; }],
    ["argv", (receipt: EvidenceReceipt) => { receipt.argv.push("--disable-gate=tests"); }],
    ["output path", (receipt: EvidenceReceipt) => { receipt.options.out = "replaced.json"; }],
    ["timestamp", (receipt: EvidenceReceipt) => { receipt.generatedAt = "2026-10-23T00:00:00.000Z"; }],
    ["check digest", (receipt: EvidenceReceipt) => { receipt.checks[0]!.exitCode = 7; }],
    ["verification", (receipt: EvidenceReceipt) => { receipt.verification!.strict = false; }],
    ["effective policy", (receipt: EvidenceReceipt) => { receipt.effectivePolicy!.gates.tests = false; }],
  ])("rejects tampering with signed %s", (_name, mutate) => {
    const evidence = modernEvidence();
    const receipt = clone(receiptFor(evidence));
    mutate(receipt);
    expect(rejected(evidence, receipt)).toBe(true);
    // Recomputing the public payload hash must not repair the original signature.
    receipt.payloadHash = hashReceiptPayload(receipt);
    expect(rejected(evidence, receipt)).toBe(true);
  });

  it.each([
    ["evidence timestamp", (evidence: Evidence) => { evidence.generatedAt = "2026-10-23T00:00:00.000Z"; }],
    ["check duration", (evidence: Evidence) => { evidence.checks[0]!.durationMs = 999; }],
    ["command output", (evidence: Evidence) => { evidence.checks[0]!.detail = "different output"; }],
    ["execution output digest", (evidence: Evidence) => { evidence.executionRecords![0]!.outputHash = digest("e"); }],
    ["execution duration", (evidence: Evidence) => { evidence.executionRecords![0]!.durationMs = 999; }],
  ])("authenticates %s while keeping the stable content identity", (_name, mutate) => {
    const evidence = modernEvidence();
    const receipt = receiptFor(evidence);
    const changed = clone(evidence);
    mutate(changed);
    expect(hashEvidence(changed)).toBe(receipt.contentHash);
    expect(verifyReceipt(changed, receipt, fixtureKey)).toMatchObject({ ok: false, hashMatches: true, payloadMatches: false });
  });

  it("requires signatures when verification policy requires authentication", () => {
    const evidence = modernEvidence();
    const receipt = receiptFor(evidence);
    delete receipt.signature;
    expect(verifyReceipt(evidence, receipt, fixtureKey, { requireSignature: true })).toMatchObject({ ok: false, signature: "absent" });
  });

  it("rejects a v2-to-legacy receipt downgrade even when legacy evidence is allowed", () => {
    const evidence = modernEvidence();
    const receipt = receiptFor(evidence);
    const downgraded: EvidenceReceipt = {
      schemaVersion: "1.2.0", algorithm: receipt.algorithm, contentHash: receipt.contentHash,
      toolVersion: receipt.toolVersion, evidenceSchemaVersion: receipt.evidenceSchemaVersion,
      argv: receipt.argv, options: receipt.options, exitCode: receipt.exitCode,
      failOnOutcome: receipt.failOnOutcome, checks: receipt.checks, generatedAt: receipt.generatedAt,
    };
    expect(rejected(evidence, downgraded)).toBe(true);
    let accepted = false;
    try { accepted = verifyReceipt(evidence, downgraded, fixtureKey, { allowLegacy: true }).ok; } catch { /* Invalid cross-protocol receipts may throw. */ }
    expect(accepted).toBe(false);
  });

  it("rejects unsupported canonicalization versions", () => {
    const evidence = modernEvidence();
    const receipt = receiptFor(evidence);
    (receipt as unknown as Record<string, unknown>).canonicalizationVersion = "99";
    receipt.payloadHash = hashReceiptPayload(receipt);
    delete receipt.signature;
    expect(rejected(evidence, receipt)).toBe(true);
  });

  it("separates mathematical Ed25519 verification from configured signer trust", () => {
    const evidence = modernEvidence();
    const trusted = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const privateKey = trusted.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const publicKey = trusted.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const otherPublicKey = other.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const receipt = buildReceipt({ evidence, exitCode: 0, failOnOutcome: { failed: false, reason: "ok" }, sign: true, signingKey: `ed25519:${privateKey}` });
    expect(verifyReceipt(evidence, receipt, null, { trustedKeyFingerprints: [publicKeyFingerprint(publicKey)] })).toMatchObject({ ok: true, signature: "verified", trust: "trusted" });
    expect(verifyReceipt(evidence, receipt, null, { trustedKeyFingerprints: [publicKeyFingerprint(otherPublicKey)] })).toMatchObject({ ok: false, signature: "verified", trust: "untrusted" });
  });
});

describe("legacy receipt hash compatibility", () => {
  it("preserves the historical fixture hash and excludes the same wall-clock fields", () => {
    const evidence = JSON.parse(readFileSync(new URL("./fixtures/evidence-open-gaps.json", import.meta.url), "utf8")) as Evidence;
    expect(hashEvidence(evidence)).toBe("sha256:2ab2ddf942b7f5b70fa0bed693c08c04744e6e801f02c768296bef335ff8161d");
    const changed = clone(evidence);
    changed.generatedAt = "2026-12-01T00:00:00.000Z";
    expect(hashEvidence(changed)).toBe(hashEvidence(evidence));
    const receipt = buildReceipt({ evidence, exitCode: 0, failOnOutcome: { failed: false, reason: "ok" } });
    expect(receipt.schemaVersion).toBe("1.2.0");
    expect(verifyReceipt(evidence, receipt)).toMatchObject({ ok: true, legacy: true });
    expect(verifyReceipt(evidence, receipt, null, { allowLegacy: false }).ok).toBe(false);
  });
});

describe("real analyzed snapshot receipt identity", () => {
  it("is stable across repeated runs and distinguishes changes with equal diff statistics", async () => {
    const { analyze } = await import("../src/run.js");
    const root = repo();
    const options: RunOptions = { cwd: root, out: path.join(root, "evidence.json"), format: "json", json: true, protocol: 2, disableGate: ["typecheck", "lint", "tests", "secrets"] };
    write(root, "src/value.ts", "export const value = 2;\n");
    const first = validateEvidence(await analyze(options));
    const second = validateEvidence(await analyze(options));
    expect(first.schemaVersion).toBe("2.0.0");
    expect(first.snapshot?.contentHash).toBe(second.snapshot?.contentHash);
    expect(hashEvidence(first)).toBe(hashEvidence(second));
    const firstReceipt = receiptFor(first);
    expect(verifyReceipt(first, firstReceipt, fixtureKey, { requireSignature: true }).ok).toBe(true);
    write(root, "src/value.ts", "export const value = 3;\n");
    const third = validateEvidence(await analyze(options));
    expect(third.impact.changedFiles.map((file) => [file.path, file.additions, file.deletions])).toEqual(first.impact.changedFiles.map((file) => [file.path, file.additions, file.deletions]));
    expect(third.snapshot?.contentHash).not.toBe(first.snapshot?.contentHash);
    expect(hashEvidence(third)).not.toBe(hashEvidence(first));
    expect(verifyReceipt(third, firstReceipt, fixtureKey).ok).toBe(false);
  });

  it("keeps repeated isolated range hashes stable when contract and baseline inputs exist", async () => {
    const { analyze } = await import("../src/run.js");
    const root = repo();
    write(root, ".patchprove/spec.yml", "requiredGates: []\n");
    write(root, ".patchprove/baseline.json", readFileSync(new URL("./fixtures/evidence-open-gaps.json", import.meta.url), "utf8"));
    git(root, "add", ".");
    git(root, "commit", "-m", "policy inputs");
    const base = git(root, "rev-parse", "HEAD").trim();
    write(root, "src/value.ts", "export const value = 2;\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "target");
    const head = git(root, "rev-parse", "HEAD").trim();
    git(root, "checkout", "--detach", base);
    const options: RunOptions = { cwd: root, out: path.join(root, "evidence.json"), base, head, format: "json", json: true, protocol: 2, disableGate: ["typecheck", "lint", "tests", "secrets"] };
    const first = validateEvidence(await analyze(options));
    const second = validateEvidence(await analyze(options));
    expect(first.snapshot?.consistent).toBe(true);
    expect(second.snapshot?.consistent).toBe(true);
    expect(first.contract.source).toBe(path.join(root, ".patchprove/spec.yml"));
    expect(first.baselineComparison?.baselinePath).toBe(path.join(root, ".patchprove/baseline.json"));
    expect(hashEvidence(first)).toBe(hashEvidence(second));
    expect(receiptFor(first).contentHash).toBe(receiptFor(second).contentHash);
    expect(git(root, "rev-parse", "HEAD").trim()).toBe(base);
  });

  it("accepts and authenticates a valid date-only waiver expiration", async () => {
    const { analyze } = await import("../src/run.js");
    const root = repo();
    write(root, ".patchprove.yml", 'acceptGaps:\n  - path: "src/**"\n    reason: "fixture waiver"\n    expiresAt: "2099-01-01"\n');
    write(root, "src/value.ts", "export const value = 2;\n");
    const evidence = validateEvidence(await analyze({ cwd: root, out: path.join(root, "evidence.json"), format: "json", json: true, protocol: 2, disableGate: ["typecheck", "lint", "tests", "secrets"] }));
    expect(evidence.effectivePolicy?.acceptGaps[0]?.expiresAt).toMatch(/^2099-01-01/);
    const receipt = validateReceipt(receiptFor(evidence));
    expect(verifyReceipt(evidence, receipt, fixtureKey, { requireSignature: true }).ok).toBe(true);
  });

  it("binds a linked external YAML policy and lists every actual spec input", async () => {
    const { analyze } = await import("../src/run.js");
    const root = repo();
    const external = mkdtempSync(path.join(tmpdir(), "patchprove-external-spec-"));
    roots.push(external);
    const linked = path.join(external, "policy.yml");
    const initialYaml = "requiredGates: []\nmaxResidualRisk: medium\n";
    writeFileSync(linked, initialYaml);
    write(root, "SPEC.md", `[Policy](${linked})\n`);
    const options: RunOptions = { cwd: root, out: path.join(root, "evidence.json"), format: "json", json: true, protocol: 2, disableGate: ["typecheck", "lint", "tests", "secrets"] };
    const first = validateEvidence(await analyze(options));
    expect(first.effectivePolicy?.spec?.inputs).toEqual([
      { path: path.join(root, "SPEC.md"), hash: hashCanonical(readFileSync(path.join(root, "SPEC.md"), "utf8")) },
      { path: linked, hash: hashCanonical(initialYaml) },
    ]);
    writeFileSync(linked, "requiredGates: []\nmaxResidualRisk: high\n");
    const second = validateEvidence(await analyze(options));
    expect(second.effectivePolicy?.spec?.hash).toBe(first.effectivePolicy?.spec?.hash);
    expect(second.effectivePolicy?.spec?.inputs?.[1]?.hash).not.toBe(first.effectivePolicy?.spec?.inputs?.[1]?.hash);
    expect(second.effectivePolicy?.hash).not.toBe(first.effectivePolicy?.hash);
    expect(second.snapshot?.contentHash).toBe(first.snapshot?.contentHash);
    expect(hashEvidence(second)).not.toBe(hashEvidence(first));
    const receipt = validateReceipt(receiptFor(second));
    expect(verifyReceipt(second, receipt, fixtureKey, { requireSignature: true }).ok).toBe(true);
  });

  it("detects an external policy change between loading the contract and planning checks", async () => {
    const { analyze } = await import("../src/run.js");
    const root = repo();
    const external = mkdtempSync(path.join(tmpdir(), "patchprove-policy-drift-"));
    roots.push(external);
    const linked = path.join(external, "policy.yml");
    writeFileSync(linked, "requiredGates: []\nmaxResidualRisk: medium\n");
    write(root, "SPEC.md", `[Policy](${linked})\n`);
    const original = graph.buildImportGraph;
    vi.spyOn(graph, "buildImportGraph").mockImplementation((...args) => {
      const result = original(...args);
      writeFileSync(linked, "requiredGates: []\nmaxResidualRisk: high\n");
      return result;
    });
    const evidence = await analyze({ cwd: root, out: path.join(root, "evidence.json"), format: "json", json: true, protocol: 2, disableGate: ["typecheck", "lint", "tests", "secrets"] });
    expect(evidence.snapshot?.consistent).toBe(false);
    expect(evidence.verification?.status).not.toBe("passed");
  });
});
