import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyArtifactSet, writeArtifactSet } from "../src/artifacts.js";
import { readTestReport } from "../src/test-results.js";
import { relativizeReportArtifacts, reportArtifactEntries, verifyReportArchive, withReportArchive } from "../src/report-archive.js";
import { validateEvidence } from "../src/validation.js";
import type { Evidence, ExecutionRecord } from "../src/types.js";

const roots: string[] = [];
const temporary = () => { const root = mkdtempSync(path.join(tmpdir(), "patchprove-report-archive-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
const fixture = (): Evidence => JSON.parse(readFileSync(new URL("./fixtures/evidence-open-gaps.json", import.meta.url), "utf8"));
function rawReport(cwd: string): Buffer {
  return Buffer.from(JSON.stringify({ testResults: [{ name: path.join(cwd, "value.test.js"), assertionResults: [{ status: "passed" }, { status: "failed" }] }] }));
}
async function archived(root: string, raw = rawReport(root)): Promise<Evidence> {
  const original = path.join(root, "temporary.json");
  writeFileSync(path.join(root, "value.test.js"), "export {};\n");
  writeFileSync(original, raw);
  return withReportArchive(path.join(root, "reports"), async () => {
    const proof = readTestReport("vitest-json", original, root, ["value.test.js"]);
    const evidence = fixture();
    const record: ExecutionRecord = { id: "tests:fixture", checkId: "tests", scope: proof.executedScope, status: "failed", exitCode: 1,
      command: "fixture", args: [], cwd: root, durationMs: 1, testExecution: proof };
    evidence.executionRecords = [record];
    evidence.checks = [{ id: "tests", name: "fixture", status: "failed", durationMs: 1, exitCode: 1, command: "fixture", records: [record] }];
    Object.assign(evidence.summary, { checksPassed: 0, checksFailed: 1, checksSkipped: 0 });
    return evidence;
  });
}

describe("machine report archives", () => {
  it("keeps only facts and digest when retention was not requested", () => {
    const root = temporary(), report = path.join(root, "temporary.json");
    writeFileSync(path.join(root, "value.test.js"), "export {};\n");
    writeFileSync(report, rawReport(root));
    const proof = readTestReport("vitest-json", report, root, ["value.test.js"]);
    expect(proof).toMatchObject({ reportRetention: "not-retained", counts: { passed: 1, failed: 1, executed: 2 } });
    expect(proof.reportPath).toBeUndefined();
    expect(proof.reports).toBeUndefined();
  });

  it("replays retained originals after the runner's temporary report is removed", async () => {
    const root = temporary(), evidence = await archived(root);
    rmSync(path.join(root, "temporary.json"));
    expect(evidence.executionRecords?.[0]?.testExecution).toMatchObject({ reportRetention: "retained" });
    expect(verifyReportArchive(evidence)).toEqual({ ok: true, reports: 1, errors: [] });
    expect(verifyArtifactSet(evidence.reportArchive!.manifestPath).ok).toBe(true);
  });

  it("retains invalid UTF-8 bytes exactly for failed report diagnosis", async () => {
    const root = temporary(), raw = Buffer.from([0xff, 0xfe, 0x7b]);
    const evidence = await archived(root, raw);
    const reference = evidence.executionRecords![0]!.testExecution!.reports![0]!;
    expect(readFileSync(reference.path)).toEqual(raw);
    expect(verifyReportArchive(evidence)).toEqual({ ok: true, reports: 1, errors: [] });
  });

  it.each(["changed", "missing"])("rejects a %s original", async (kind) => {
    const evidence = await archived(temporary());
    const reference = evidence.executionRecords![0]!.testExecution!.reports![0]!;
    if (kind === "changed") writeFileSync(reference.path, "{}"); else rmSync(reference.path);
    expect(verifyReportArchive(evidence).ok).toBe(false);
    expect(() => reportArtifactEntries(evidence)).toThrow(/verification|hash/i);
  });

  it("preserves signed relative references when an entire pack moves", async () => {
    const root = temporary(), evidence = relativizeReportArtifacts(await archived(root), root);
    expect(path.isAbsolute(evidence.reportArchive!.manifestPath)).toBe(false);
    const encoded = JSON.stringify(evidence);
    const relocated = temporary();
    cpSync(path.join(root, "reports"), path.join(relocated, "reports"), { recursive: true });
    rmSync(root, { recursive: true, force: true });
    expect(verifyReportArchive(evidence, { artifactRoot: relocated })).toEqual({ ok: true, reports: 1, errors: [] });
    expect(JSON.stringify(evidence)).toBe(encoded);
  });

  it("publishes a verifiable empty archive when no reports were produced", async () => {
    const root = temporary();
    const evidence = await withReportArchive(path.join(root, "reports"), async () => fixture());
    expect(verifyReportArchive(evidence)).toEqual({ ok: true, reports: 0, errors: [] });
  });

  it("fails requested archival without reporting a saved artifact", async () => {
    const root = temporary();
    mkdirSync(path.join(root, "destination"));
    writeFileSync(path.join(root, "destination", "file"), "not a directory");
    await expect(withReportArchive(path.join(root, "destination", "file", "reports"), async () => fixture())).rejects.toThrow(/not published/);
    expect(readFileSync(path.join(root, "destination", "file"), "utf8")).toBe("not a directory");
  });

  it("binds exact report bytes and context into the final artifact manifest", async () => {
    const root = temporary(), evidence = await archived(root);
    const manifest = path.join(root, "evidence.manifest.json");
    writeArtifactSet([{ path: path.join(root, "evidence.json"), content: JSON.stringify(evidence) }, ...reportArtifactEntries(evidence)], manifest);
    expect(verifyArtifactSet(manifest).ok).toBe(true);
    writeFileSync(evidence.executionRecords![0]!.testExecution!.reports![0]!.contextPath, "{}");
    expect(verifyArtifactSet(manifest).ok).toBe(false);
  });

  it("replays recorded logical and physical path aliases after both source paths disappear", async () => {
    const root = temporary(), physical = path.join(root, "physical"), logical = path.join(root, "logical");
    mkdirSync(physical);
    writeFileSync(path.join(physical, "value.test.js"), "export {};\n");
    symlinkSync(physical, logical, process.platform === "win32" ? "junction" : "dir");
    const report = path.join(root, "temporary.json");
    writeFileSync(report, rawReport(physical));
    const evidence = await withReportArchive(path.join(root, "reports"), async () => {
      const proof = readTestReport("vitest-json", report, logical, ["value.test.js"]);
      expect(proof.counts.executed).toBe(2);
      const value = fixture();
      const record: ExecutionRecord = { id: "tests:alias", checkId: "tests", scope: proof.executedScope, status: "failed", exitCode: 1,
        command: "fixture", args: [], cwd: logical, durationMs: 1, testExecution: proof };
      value.executionRecords = [record];
      value.checks = [{ id: "tests", name: "fixture", status: "failed", durationMs: 1, exitCode: 1, command: "fixture", records: [record] }];
      Object.assign(value.summary, { checksPassed: 0, checksFailed: 1, checksSkipped: 0 });
      return value;
    });
    rmSync(logical, { recursive: true, force: true });
    rmSync(physical, { recursive: true, force: true });
    expect(verifyReportArchive(evidence)).toEqual({ ok: true, reports: 1, errors: [] });
  });

  it("parses Windows report path identities during offline replay on any host", () => {
    const root = temporary(), report = path.join(root, "windows.json");
    writeFileSync(report, JSON.stringify({ testResults: [{ name: "C:\\physical\\value.test.js", assertionResults: [{ status: "passed" }] }] }));
    const proof = readTestReport("vitest-json", report, "C:\\logical", ["value.test.js"], undefined, "C:\\logical", false,
      { platform: "win32", aliases: [{ from: "C:\\logical", to: "C:\\physical" }] });
    expect(proof).toMatchObject({ reportStatus: "validated", executedScope: ["value.test.js"], counts: { passed: 1, failed: 0 } });
  });

  it.each(["requested", "unrequested"])("preserves a missing %s reporter path below a directory alias", async kind => {
    const root = temporary(), physical = path.join(root, "physical"), logical = path.join(root, "logical");
    mkdirSync(physical);
    writeFileSync(path.join(physical, "present.test.js"), "export {};\n");
    symlinkSync(physical, logical, process.platform === "win32" ? "junction" : "dir");
    const selected = kind === "requested" ? ["missing.test.js"] : ["present.test.js"];
    const report = path.join(root, "temporary.json");
    const suites = [...(kind === "unrequested" ? [{ name: path.join(logical, "present.test.js"), assertionResults: [{ status: "passed" }] }] : []),
      { name: path.join(logical, "missing.test.js"), assertionResults: [{ status: "passed" }] }];
    writeFileSync(report, JSON.stringify({ testResults: suites }));
    const evidence = await withReportArchive(path.join(root, "reports"), async () => {
      const proof = readTestReport("vitest-json", report, logical, selected);
      expect(proof.reportStatus).toBe("invalid");
      const value = fixture();
      const record: ExecutionRecord = { id: "tests:missing", checkId: "tests", scope: [], status: "failed", exitCode: 1,
        command: "fixture", args: [], cwd: logical, durationMs: 1, testExecution: proof };
      value.executionRecords = [record];
      value.checks = [{ id: "tests", name: "fixture", status: "failed", durationMs: 1, exitCode: 1, command: "fixture", records: [record] }];
      Object.assign(value.summary, { checksPassed: 0, checksFailed: 1, checksSkipped: 0 });
      return value;
    });
    const context = JSON.parse(readFileSync(evidence.executionRecords![0]!.testExecution!.reports![0]!.contextPath, "utf8"));
    expect(context.pathAliasMode).toBe("exact");
    expect(context.pathAliases).toContainEqual({ from: path.join(logical, "missing.test.js"), to: path.join(logical, "missing.test.js") });
    rmSync(logical, { recursive: true, force: true });
    rmSync(physical, { recursive: true, force: true });
    expect(verifyReportArchive(evidence)).toEqual({ ok: true, reports: 1, errors: [] });
  });

  it("rejects exact replay when a required canonical decision was not retained", () => {
    const root = temporary(), report = path.join(root, "temporary.json");
    writeFileSync(path.join(root, "value.test.js"), "export {};\n");
    writeFileSync(report, rawReport(root));
    expect(() => readTestReport("vitest-json", report, root, ["value.test.js"], undefined, root, false,
      { platform: process.platform === "win32" ? "win32" : "posix", aliases: [], exact: true })).toThrow(/Missing original canonical path observation/);
  });

  it("rejects evidence counts that disagree with independently replayed originals", async () => {
    const evidence = await archived(temporary());
    Object.assign(evidence.executionRecords![0]!.testExecution!.counts, { passed: 0, failed: 2 });
    expect(verifyReportArchive(evidence)).toMatchObject({ ok: false, errors: [expect.stringContaining("Evidence execution facts differ")] });
  });
  it("rejects an omitted execution original even when the archive bytes remain valid", async () => {
    const evidence = await archived(temporary());
    evidence.executionRecords![0]!.testExecution!.reports = [];
    expect(verifyReportArchive(evidence)).toMatchObject({ ok: false, errors: [expect.stringContaining("index disagrees")] });
  });

  it.each(["before", "after"])("rejects conflicting references %s the valid original without hiding either record", async order => {
    const evidence = await archived(temporary());
    const original = evidence.executionRecords![0]!;
    const forged = structuredClone(original);
    forged.id = "tests:forged";
    const reference = forged.testExecution!.reports![0]!;
    reference.path = `${path.dirname(reference.path)}/./${path.basename(reference.path)}`;
    reference.hash = `sha256:${"0".repeat(64)}`;
    evidence.executionRecords = order === "before" ? [forged, original] : [original, forged];
    evidence.checks[0]!.records = evidence.executionRecords;
    expect(verifyReportArchive(evidence)).toMatchObject({ ok: false, errors: [expect.stringContaining("Conflicting retained report references")] });
    expect(() => reportArtifactEntries(evidence)).toThrow(/Conflicting retained report references/);
    expect(() => validateEvidence(evidence)).toThrow(/Conflicting retained report references/);
  });

  it.each(["bytes", "format", "contextPath", "contextHash"] as const)("rejects conflicting %s identity for the same retained original", async field => {
    const evidence = await archived(temporary());
    const forged = structuredClone(evidence.executionRecords![0]!);
    forged.id = "tests:forged";
    const reference = forged.testExecution!.reports![0]!;
    if (field === "bytes") reference.bytes++;
    if (field === "format") reference.format = "jest-json";
    if (field === "contextPath") reference.contextPath += ".different";
    if (field === "contextHash") reference.contextHash = `sha256:${"0".repeat(64)}`;
    evidence.executionRecords!.unshift(forged);
    evidence.checks[0]!.records = evidence.executionRecords;
    expect(verifyReportArchive(evidence).ok).toBe(false);
    expect(() => reportArtifactEntries(evidence)).toThrow(/Conflicting retained report references/);
    expect(() => validateEvidence(evidence)).toThrow(/Conflicting retained report references/);
  });

  it("replays every public execution copy rather than ignoring inconsistent nested facts", async () => {
    const evidence = await archived(temporary());
    evidence.checks[0]!.records = structuredClone(evidence.executionRecords!);
    Object.assign(evidence.checks[0]!.records![0]!.testExecution!.counts, { passed: 0, failed: 2 });
    expect(verifyReportArchive(evidence)).toMatchObject({ ok: false, errors: [expect.stringContaining("Evidence execution facts differ")] });
  });

  it("allows identical Java originals shared by distinct execution records", async () => {
    const root = temporary(), report = path.join(root, "temporary.xml"), selected = ["src/test/java/fixture/ValueTest.java"];
    writeFileSync(report, '<testsuite name="fixture.ValueTest" tests="1"><testcase name="value"><failure/></testcase></testsuite>');
    const evidence = await withReportArchive(path.join(root, "reports"), async () => {
      const proof = readTestReport("java-junit", report, root, selected, selected);
      const original: ExecutionRecord = { id: "tests:java", checkId: "tests", scope: selected, status: "failed", exitCode: 1,
        command: "mvn", args: [], cwd: root, durationMs: 1, testExecution: proof };
      const shared = structuredClone(original);
      shared.id = "tests:java-shared";
      const reference = shared.testExecution!.reports![0]!;
      reference.path = `${path.dirname(reference.path)}/./${path.basename(reference.path)}`;
      const value = fixture();
      value.executionRecords = [original, shared];
      value.checks = [{ id: "tests", name: "fixture", status: "failed", durationMs: 1, exitCode: 1, command: "mvn", records: value.executionRecords }];
      Object.assign(value.summary, { checksPassed: 0, checksFailed: 1, checksSkipped: 0 });
      return value;
    });
    expect(verifyReportArchive(evidence)).toEqual({ ok: true, reports: 1, errors: [] });
    expect(() => reportArtifactEntries(evidence)).not.toThrow();
    expect(() => validateEvidence(evidence)).not.toThrow();
  });

});
