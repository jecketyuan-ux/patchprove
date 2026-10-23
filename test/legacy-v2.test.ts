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

it("reads a genuine earlier 2.0 producer pack without rewriting signed data, while requiring explicit legacy receipt policy", () => {
  const evidence = readEvidenceFile(evidencePath), receipt = readReceiptFile(receiptPath);
  expect(evidence).toEqual(JSON.parse(readFileSync(evidencePath, "utf8")));
  expect(verifyReceipt(evidence, receipt, key)).toMatchObject({ ok: false, hashMatches: true, payloadMatches: true, signature: "verified", legacy: true });
  expect(verifyReceipt(evidence, receipt, key, { allowLegacy: true })).toMatchObject({ ok: true, signature: "verified", legacy: true });
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
