import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { writeArtifactSet } from "../src/artifacts.js";
import { decodeCommandOutput } from "../src/exec.js";
import { archiveMachineReport, reportArtifactEntries, verifyReportArchive, withReportArchive } from "../src/report-archive.js";
import { goTestExecution } from "../src/test-results.js";
import type { Evidence, ExecutionRecord } from "../src/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function fixture(): Promise<{ evidence: Evidence; original: Buffer }> {
  const root = mkdtempSync(path.join(tmpdir(), "patchprove-go-list-context-"));
  roots.push(root);
  // The parser can use valid metadata even when an unrelated field contains invalid UTF-8.
  const original = Buffer.concat([Buffer.from(`{"ImportPath":"example/fixture","Dir":${JSON.stringify(root)},"TestGoFiles":["value_test.go"],"Doc":"`),
    Buffer.from([0xff]), Buffer.from('"}    ')]);
  const output = [
    { Action: "run", Package: "example/fixture", Test: "TestValue" },
    { Action: "fail", Package: "example/fixture", Test: "TestValue" },
    { Action: "fail", Package: "example/fixture" },
  ].map(event => JSON.stringify(event)).join("\n");
  const evidence = await withReportArchive(path.join(root, "reports"), async () => {
    const proof = goTestExecution(output, ["."], "example/fixture");
    proof.eligibleSourceFiles = ["value_test.go"];
    archiveMachineReport({ format: "go-json", raw: Buffer.from(output), cwd: root, requestedScope: ["."], sourceFiles: ["value_test.go"],
      goListRaw: original, goListOutput: decodeCommandOutput(original), goListExitCode: 0, goListTruncated: false }, proof);
    const value = JSON.parse(readFileSync(new URL("./fixtures/evidence-open-gaps.json", import.meta.url), "utf8")) as Evidence;
    const record: ExecutionRecord = { id: "tests:go", checkId: "tests", scope: ["."], status: "failed", exitCode: 1,
      command: "go", args: ["test", "-json", "."], cwd: root, durationMs: 1, testExecution: proof };
    value.executionRecords = [record];
    value.checks = [{ id: "tests", name: "go", status: "failed", durationMs: 1, exitCode: 1, command: "go test -json .", records: [record] }];
    Object.assign(value.summary, { checksPassed: 0, checksFailed: 1, checksSkipped: 0 });
    return value;
  });
  return { evidence, original };
}

/** Rebind the outer checksums so each test reaches the independent context reader. */
function rewriteContext(evidence: Evidence, edit: (context: Record<string, unknown>) => void): void {
  const reference = evidence.executionRecords![0]!.testExecution!.reports![0]!;
  const entries = reportArtifactEntries(evidence).filter(entry => entry.path !== evidence.reportArchive!.manifestPath);
  const context = JSON.parse(readFileSync(reference.contextPath, "utf8")) as Record<string, unknown>;
  edit(context);
  const bytes = JSON.stringify(context) + "\n";
  const entry = entries.find(item => item.path === reference.contextPath)!;
  entry.content = bytes;
  reference.contextHash = hash(bytes);
  writeArtifactSet(entries, evidence.reportArchive!.manifestPath);
  evidence.reportArchive!.manifestHash = hash(readFileSync(evidence.reportArchive!.manifestPath));
}

it("retains original go-list bytes without serializing a Buffer object and replays the bounded decoder", async () => {
  const { evidence, original } = await fixture();
  const context = JSON.parse(readFileSync(evidence.executionRecords![0]!.testExecution!.reports![0]!.contextPath, "utf8"));
  expect(context.goListRaw).toBeUndefined();
  expect(Buffer.from(context.goListRawBase64, "base64")).toEqual(original);
  expect(context.goListRawHash).toBe(hash(original));
  expect(context.goListOutput).toBe(decodeCommandOutput(original));
  expect(verifyReportArchive(evidence)).toEqual({ ok: true, reports: 1, errors: [] });
});

it("reads historical contexts without original go-list byte metadata", async () => {
  const { evidence } = await fixture();
  rewriteContext(evidence, context => { delete context.goListRawBase64; delete context.goListRawHash; });
  expect(verifyReportArchive(evidence)).toEqual({ ok: true, reports: 1, errors: [] });
});

it.each([
  ["hash", "Go list original-byte hash mismatch"],
  ["base64", "Invalid canonical base64"],
  ["decoded", "conflict with the participating decoded output"],
  ["missing", "Incomplete go list original-byte metadata"],
] as const)("rejects %s inconsistency even when outer archive checksums were rebound", async (kind, message) => {
  const { evidence } = await fixture();
  rewriteContext(evidence, context => {
    if (kind === "hash") context.goListRawHash = `sha256:${"0".repeat(64)}`;
    if (kind === "base64") context.goListRawBase64 = "Zh=="; // Noncanonical unused padding bits.
    if (kind === "decoded") context.goListOutput = "{}";
    if (kind === "missing") delete context.goListRawHash;
  });
  expect(verifyReportArchive(evidence)).toMatchObject({ ok: false, errors: [expect.stringContaining(message)] });
});
