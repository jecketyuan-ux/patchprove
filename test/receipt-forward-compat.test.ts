import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { analyze } from "../src/run.js";
import { buildReceipt, hashReceiptPayload, verifyReceipt } from "../src/receipt.js";
import { validateReceipt } from "../src/validation.js";

it("reads additive 2.x receipts while preserving required canonicalization and provenance", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "patchprove-receipt-future-"));
  try {
    for (const args of [["init"], ["config", "user.email", "fixture@example.com"], ["config", "user.name", "fixture"]]) execFileSync("git", args, { cwd, stdio: "pipe" });
    writeFileSync(path.join(cwd, "README.md"), "fixture\n");
    execFileSync("git", ["add", "."], { cwd }); execFileSync("git", ["commit", "-m", "seed"], { cwd, stdio: "pipe" });
    const evidence = await analyze({ cwd, out: "evidence.json", format: "json", json: true });
    const receipt = { ...buildReceipt({ evidence, exitCode: 0, failOnOutcome: { failed: false, reason: "ok" } }), schemaVersion: "2.1.0", futureOptional: { description: "additive field" } };
    receipt.payloadHash = hashReceiptPayload(receipt as unknown as Parameters<typeof hashReceiptPayload>[0]);
    const parsed = validateReceipt(receipt);
    expect(verifyReceipt(evidence, parsed).ok).toBe(true);
    expect(() => validateReceipt({ ...receipt, canonicalizationVersion: "3" })).toThrow(/canonicalizationVersion/);
    expect(() => validateReceipt({ ...receipt, snapshotHash: undefined })).toThrow(/snapshotHash/);
    expect(() => validateReceipt({ ...receipt, schemaVersion: "3.0.0" })).toThrow(/schemaVersion/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
