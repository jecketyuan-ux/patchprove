import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { evaluateVerification } from "../src/decision.js";
import { DEFAULT_INPUT_LIMITS } from "../src/input-budget.js";
import { listGaps, readEvidenceFile } from "../src/mcp-tools.js";
import { readReceiptFile, verifyReceipt } from "../src/receipt.js";
import { validateEvidence } from "../src/validation.js";

const evidencePath = fileURLToPath(new URL("./fixtures/legacy-v2-producer/evidence.json", import.meta.url));
const receiptPath = fileURLToPath(new URL("./fixtures/legacy-v2-producer/evidence.receipt.json", import.meta.url));
const key = "hmac:public-legacy-v2-fixture-key";
const observedEvidencePath = fileURLToPath(new URL("./fixtures/legacy-v2-observed-producer/observed-evidence.json", import.meta.url));
const observedReceiptPath = fileURLToPath(new URL("./fixtures/legacy-v2-observed-producer/observed-receipt.json", import.meta.url));
const observedKey = "hmac:public-legacy-v2-observed-fixture-key";

it("preserves an earlier producer's signed observed results while withholding a new completion guarantee", async () => {
  const original = readFileSync(observedEvidencePath, "utf8");
  const evidence = readEvidenceFile(observedEvidencePath);
  expect(evidence).toEqual(JSON.parse(original));
  expect(evidence.verification!.status).toBe("passed");
  expect(evidence.executionRecords!.some(record => record.testExecution?.counts.executed === 1)).toBe(true);
  expect(evidence.environment!.plugins).toBeUndefined();
  expect(verifyReceipt(evidence, readReceiptFile(observedReceiptPath), observedKey, { requireSignature: true })).toMatchObject({ ok: true, signature: "verified", payloadMatches: true });
  expect(evaluateVerification(evidence).status).toBe("incomplete");
  expect((await listGaps({ evidencePath: observedEvidencePath })).claimDone).toBe(false);
  expect(readFileSync(observedEvidencePath, "utf8")).toBe(original);
});

it("reads a genuine earlier 2.0 producer pack without rewriting signed data, while requiring explicit legacy receipt policy", () => {
  const evidence = readEvidenceFile(evidencePath), receipt = readReceiptFile(receiptPath);
  expect(evidence).toEqual(JSON.parse(readFileSync(evidencePath, "utf8")));
  expect(verifyReceipt(evidence, receipt, key)).toMatchObject({ ok: false, hashMatches: true, payloadMatches: true, signature: "verified", legacy: true });
  expect(verifyReceipt(evidence, receipt, key, { allowLegacy: true })).toMatchObject({ ok: true, signature: "verified", legacy: true });
  const explanation = verifyReceipt(evidence, receipt, key, { allowLegacy: true }).message;
  expect(explanation).toContain("authenticated payload matches");
  expect(explanation).toContain("legacy test scope has no observed result facts");
  expect(explanation).not.toContain("metadata is not authenticated");
  expect(evaluateVerification(evidence).status).toBe("incomplete");
});

it("does not let an earlier stored passed decision produce a new MCP completion signal", async () => {
  expect((await listGaps({ evidencePath })).claimDone).toBe(false);
});

it("rejects missing result facts when the pack identifies itself as a new producer", () => {
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  evidence.environment = { platform: "linux", arch: "x64", nodeVersion: "v24.19.0", gitVersion: "git 2", tools: [], dependencyLocks: [], inputLimits: DEFAULT_INPUT_LIMITS, hermetic: false };
  expect(() => validateEvidence(evidence)).toThrow(/verification\/status.*incomplete/);
});
