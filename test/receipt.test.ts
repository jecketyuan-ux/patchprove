import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { buildEvidence } from "../src/evidence.js";
import {
  attachReceiptRef,
  buildReceipt,
  defaultReceiptPath,
  hashEvidence,
  parseSigningKey,
  readReceiptFile,
  verifyReceipt,
} from "../src/receipt.js";
import { readEvidenceFile } from "../src/mcp-tools.js";
import { formatMarkdownReport } from "../src/report.js";
import { executeRun } from "../src/run.js";
import type { CheckResult, Evidence } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const receiptSchema = JSON.parse(
  readFileSync(path.join(here, "../schema/receipt.schema.json"), "utf8"),
) as object;
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateReceipt = ajv.compile(receiptSchema);

function sampleEvidence(overrides?: {
  generatedAt?: string;
  durationMs?: number;
  detail?: string;
}): Evidence {
  const checks: CheckResult[] = [
    {
      id: "typecheck",
      name: "typecheck (tsc)",
      status: "passed",
      reason: "ok",
      command: "tsc --noEmit",
      exitCode: 0,
      durationMs: overrides?.durationMs ?? 12,
      detail: overrides?.detail ?? "ok",
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
  return buildEvidence({
    cwd: "/tmp/demo",
    root: "/tmp/demo",
    range: { mode: "working-tree", base: "HEAD", head: null },
    impact: {
      changedFiles: [],
      mappedTests: [],
      unmappedSources: ["src/utils/hash.ts"],
      languages: ["typescript"],
      mappingStrategy: "naming",
    },
    checks,
    gaps: [
      {
        id: "gap-unmapped-src/utils/hash.ts",
        kind: "unmapped-test",
        message: "No nearby test mapped for src/utils/hash.ts",
        risk: "medium",
        files: ["src/utils/hash.ts"],
      },
    ],
    findings: [],
    generatedAt: overrides?.generatedAt ?? "2026-09-02T00:00:00.000Z",
  });
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function seedRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "patchprove-receipt-"));
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "dev@example.com"]);
  git(dir, ["config", "user.name", "patchprove fixture"]);
  mkdirSync(path.join(dir, "src", "utils"), { recursive: true });
  writeFileSync(path.join(dir, "src", "utils", "hash.ts"), "export const hash = (s: string) => s;\n");
  writeFileSync(path.join(dir, "README.md"), "fixture\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "seed"]);
  return dir;
}

describe("receipt hashing", () => {
  it("is stable across wall-clock fields (same diff → same content hash)", () => {
    const a = sampleEvidence({
      generatedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 10,
      detail: "ran at 10:00",
    });
    const b = sampleEvidence({
      generatedAt: "2026-12-31T23:59:59.000Z",
      durationMs: 9999,
      detail: "ran at 11:00",
    });
    expect(hashEvidence(a)).toBe(hashEvidence(b));
    expect(hashEvidence(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes when a stable field changes", () => {
    const a = sampleEvidence();
    const b = {
      ...a,
      summary: { ...a.summary, gapCount: a.summary.gapCount + 1 },
    };
    expect(hashEvidence(a)).not.toBe(hashEvidence(b));
  });

  it("ignores an attached receipt pointer", () => {
    const evidence = sampleEvidence();
    const receipt = buildReceipt({
      evidence,
      argv: ["run"],
      exitCode: 0,
      failOnOutcome: { failed: false, reason: "ok" },
    });
    const withRef = attachReceiptRef(evidence, receipt, { path: "evidence.receipt.json" });
    expect(hashEvidence(withRef)).toBe(hashEvidence(evidence));
    expect(withRef.receipt?.contentHash).toBe(receipt.contentHash);
  });
});

describe("buildReceipt + verify", () => {
  it("writes a schema-valid receipt and verifies the hash", () => {
    const evidence = sampleEvidence();
    const receipt = buildReceipt({
      evidence,
      argv: ["run", "--fail-on", "high"],
      options: { failOn: "high", format: "json", out: "evidence.json" },
      exitCode: 0,
      failOnOutcome: { failed: false, reason: "ok" },
      generatedAt: "2026-09-03T00:00:00.000Z",
    });
    expect(validateReceipt(receipt)).toBe(true);
    expect(validateReceipt.errors).toBeNull();
    expect(receipt.checks).toEqual([
      { id: "typecheck", command: "tsc --noEmit", exitCode: 0, status: "passed" },
      { id: "lint", command: null, exitCode: null, status: "skipped" },
      { id: "tests", command: null, exitCode: null, status: "skipped" },
      { id: "secrets", command: null, exitCode: 0, status: "passed" },
    ]);
    const result = verifyReceipt(evidence, receipt);
    expect(result.ok).toBe(true);
    expect(result.hashMatches).toBe(true);
    expect(result.signature).toBe("absent");
  });

  it("detects a tampered receipt hash", () => {
    const evidence = sampleEvidence();
    const receipt = buildReceipt({
      evidence,
      exitCode: 0,
      failOnOutcome: { failed: false, reason: "ok" },
    });
    const result = verifyReceipt(evidence, { ...receipt, contentHash: "sha256:" + "0".repeat(64) });
    expect(result.ok).toBe(false);
    expect(result.hashMatches).toBe(false);
  });

  it("skips signing when --sign is set but no key is present", () => {
    const evidence = sampleEvidence();
    const receipt = buildReceipt({
      evidence,
      exitCode: 0,
      failOnOutcome: { failed: false, reason: "ok" },
      sign: true,
      signingKey: "",
    });
    expect(receipt.signature).toBeUndefined();
  });

  it("signs and verifies with an HMAC secret", () => {
    const evidence = sampleEvidence();
    const key = "hmac:test-secret-not-for-prod";
    const receipt = buildReceipt({
      evidence,
      exitCode: 0,
      failOnOutcome: { failed: false, reason: "ok" },
      sign: true,
      signingKey: key,
    });
    expect(receipt.signature?.alg).toBe("hmac-sha256");
    expect(verifyReceipt(evidence, receipt, key).signature).toBe("verified");
    expect(verifyReceipt(evidence, receipt, "hmac:wrong").signature).toBe("mismatch");
    expect(verifyReceipt(evidence, receipt).signature).toBe("skipped");
  });

  it("signs and verifies with an ed25519 key", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const der = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
    const key = `ed25519:${der.toString("base64")}`;
    expect(parseSigningKey(key)?.alg).toBe("ed25519");
    const evidence = sampleEvidence();
    const receipt = buildReceipt({
      evidence,
      exitCode: 0,
      failOnOutcome: { failed: false, reason: "ok" },
      sign: true,
      signingKey: key,
    });
    expect(receipt.signature?.alg).toBe("ed25519");
    expect(receipt.signature?.publicKey).toBeTruthy();
    const result = verifyReceipt(evidence, receipt);
    expect(result.ok).toBe(true);
    expect(result.signature).toBe("verified");
  });
});

describe("receipt path + two-run hash", () => {
  it("defaults to <out>.receipt.json", () => {
    expect(defaultReceiptPath("evidence.json")).toBe("evidence.receipt.json");
    expect(defaultReceiptPath("/tmp/pack.json")).toBe("/tmp/pack.receipt.json");
    expect(defaultReceiptPath("out")).toBe("out.receipt.json");
  });

  it("two analyze-equivalent runs of the same diff share a content hash", async () => {
    const dir = seedRepo();
    writeFileSync(
      path.join(dir, "src", "utils", "hash.ts"),
      "export const hash = (s: string) => s + s;\n",
    );
    const outDir = mkdtempSync(path.join(tmpdir(), "patchprove-receipt-out-"));
    const firstOut = path.join(outDir, "evidence.json");
    const secondOut = path.join(outDir, "evidence-2.json");
    const code1 = await executeRun({
      cwd: dir,
      json: false,
      format: "markdown",
      out: firstOut,
      receipt: true,
      argv: ["run"],
    });
    const code2 = await executeRun({
      cwd: dir,
      json: false,
      format: "markdown",
      out: secondOut,
      receipt: true,
      argv: ["run"],
    });
    expect(code1).toBe(0);
    expect(code2).toBe(0);
    const first = JSON.parse(readFileSync(firstOut, "utf8")) as Evidence;
    const second = JSON.parse(readFileSync(secondOut, "utf8")) as Evidence;
    expect(first.receipt?.contentHash).toBe(second.receipt?.contentHash);
    const md = formatMarkdownReport(first);
    expect(md).toContain(`<!-- patchprove-receipt ${first.receipt?.contentHash} -->`);
    expect(md).toContain("### Receipt");
    const receiptPath = defaultReceiptPath(firstOut);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    expect(receipt.contentHash).toBe(first.receipt?.contentHash);
    expect(validateReceipt(receipt)).toBe(true);
    const verified = verifyReceipt(readEvidenceFile(firstOut), readReceiptFile(receiptPath));
    expect(verified.ok).toBe(true);
    expect(verified.hashMatches).toBe(true);
    const cli = path.join(process.cwd(), "dist", "cli.js");
    const verifyOut = execFileSync(process.execPath, [cli, "receipt", "verify", firstOut, receiptPath], {
      encoding: "utf8",
    });
    expect(verifyOut).toMatch(/^ok /);
  });

  it("skips the receipt file when receipt is false", async () => {
    const dir = seedRepo();
    writeFileSync(path.join(dir, "src", "utils", "hash.ts"), "export const hash = (s: string) => s + 'x';\n");
    const out = path.join(mkdtempSync(path.join(tmpdir(), "patchprove-receipt-skip-")), "evidence.json");
    await executeRun({
      cwd: dir,
      json: false,
      format: "markdown",
      out,
      receipt: false,
    });
    expect(readFileSync(out, "utf8")).toBeTruthy();
    expect(() => readFileSync(defaultReceiptPath(out), "utf8")).toThrow();
  });
});
