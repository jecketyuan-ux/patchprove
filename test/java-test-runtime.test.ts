import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTestReport } from "../src/test-results.js";
import { runAffectedTests } from "../src/gates.js";
import { withInputBudget } from "../src/input-budget.js";
import { writeArtifactSet } from "../src/artifacts.js";
import { relativizeReportArtifacts, verifyReportArchive, withReportArchive } from "../src/report-archive.js";
import { validateEvidence } from "../src/validation.js";
import { emptyDetectedTools, type Evidence, type ExecutionRecord } from "../src/types.js";

const roots: string[] = [];
const scope = ["src/test/java/fixture/ValueTest.java"];
const values = { "java.version": "21.0.7", "java.home": "/actual/test/jdk", "java.vendor": "Eclipse Adoptium", "file.encoding": "ISO-8859-1", "native.encoding": "UTF-8" };
const properties = (input: Record<string, string> = values) => `<properties>${Object.entries(input).map(([name, value]) => `<property name="${name}" value="${value}"/>`).join("")}</properties>`;
const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><testsuite name="fixture.ValueTest" tests="1">${body}<testcase name="value"/></testsuite>`;
function fixture(raw: string) {
  const cwd = mkdtempSync(path.join(tmpdir(), "patchprove-test-jvm-")); roots.push(cwd);
  const file = path.join(cwd, "report.xml"); writeFileSync(file, raw);
  return { cwd, file, raw, parse: () => readTestReport("java-junit", file, cwd, scope, scope) };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("actual Java test-runtime observations", () => {
  it("binds only five suite-reported properties to original bytes and selected scope", () => {
    const input = fixture(xml(properties({ ...values, "sensitive.option": "must-not-escape" })));
    const proof = input.parse();
    expect(proof.reportStatus).toBe("validated");
    expect(proof.javaRuntimeObservations).toEqual([{ role: "test", source: "junit-properties", status: "observed", suite: "fixture.ValueTest", scope,
      reportHash: createHash("sha256").update(input.raw).digest("hex"), javaVersion: "21.0.7", javaHome: "/actual/test/jdk", vendor: "Eclipse Adoptium", fileEncoding: "ISO-8859-1", nativeEncoding: "UTF-8" }]);
    expect(JSON.stringify(proof)).not.toContain("must-not-escape");
  });

  it("keeps Gradle's absent test JVM unknown without inferring XML encoding", () => {
    const proof = fixture(xml("")).parse();
    expect(proof.javaRuntimeObservations).toEqual([expect.objectContaining({ status: "unknown", reason: "missing-properties", javaVersion: null, javaHome: null, vendor: null, fileEncoding: null, nativeEncoding: null })]);
  });

  it("retains partial values as unknown and rejects conflicting duplicate facts", () => {
    const partial = fixture(xml(properties({ "java.version": "17", "file.encoding": "UTF-8" }))).parse();
    expect(partial.javaRuntimeObservations?.[0]).toMatchObject({ status: "unknown", reason: "missing-properties", javaVersion: "17", javaHome: null, fileEncoding: "UTF-8" });
    const conflict = fixture(xml(properties() + '<properties><property name="file.encoding" value="UTF-8"/></properties>')).parse();
    expect(conflict.javaRuntimeObservations?.[0]).toMatchObject({ status: "unknown", reason: "conflicting-properties", fileEncoding: null });
  });

  it.each([
    `<!-- ${properties()} -->`,
    `<system-out><![CDATA[${properties()}<testcase name="forged"/>]]></system-out>`,
    `<system-out>${properties()}</system-out>`,
    `<testcase name="nested-properties">${properties()}</testcase>`,
  ])("does not read properties or test cases fabricated inside output or comments", (extra) => {
    const actualXml = extra.startsWith("<testcase") ? xml(extra).replace('tests="1"', 'tests="2"') : xml(extra);
    const proof = fixture(actualXml).parse();
    expect(proof.reportStatus).toBe("validated");
    expect(proof.counts.executed).toBe(extra.startsWith("<testcase") ? 2 : 1);
    expect(proof.javaRuntimeObservations?.[0]).toMatchObject({ status: "unknown", reason: "missing-properties", fileEncoding: null });
  });

  it.each([
    '<testsuite name="fixture.ValueTest" tests="1"><testcase name="value"/></wrong>',
    '<testsuite name="fixture.ValueTest" tests="1" tests="0"><testcase name="value"/></testsuite>',
    '<testsuite name="fixture.ValueTest" tests="1"><testcase name="value"/></testsuite><testsuite tests="0"/>',
    '<!DOCTYPE testsuite [<!ENTITY secret SYSTEM "file:///etc/passwd">]><testsuite tests="0"/>',
    '<testsuite tests="1"><testcase name="value"/>',
    '<testsuites><testsuite name="same" tests="0"/><testsuite name="same" tests="0"/></testsuites>',
  ])("does not attach JVM observations to malformed or unsupported XML", (raw) => {
    const proof = fixture(raw).parse();
    expect(proof.reportStatus).toBe("invalid");
    expect(proof.javaRuntimeObservations).toBeUndefined();
  });

  it("keeps different suites separate instead of combining their JVM values", () => {
    const raw = `<testsuites>${xml(properties()).replace(/^<\?xml[^>]+>/, "")}${xml(properties({ ...values, "file.encoding": "UTF-16" })).replace(/^<\?xml[^>]+>/, "").replace('name="fixture.ValueTest"', 'name="fixture.ValueTest$Nested"')}</testsuites>`;
    const proof = fixture(raw).parse();
    expect(proof.javaRuntimeObservations?.map(item => [item.suite, item.fileEncoding])).toEqual([["fixture.ValueTest", "ISO-8859-1"], ["fixture.ValueTest$Nested", "UTF-16"]]);
  });

  it("bounds XML structure and gives absent suite identity explicit unknown facts", () => {
    const deep = fixture(xml(`<system-out>${"<node>".repeat(65)}${"</node>".repeat(65)}</system-out>`));
    expect(deep.parse().reportStatus).toBe("invalid");
    const small = fixture(xml(properties()));
    expect(withInputBudget({ limits: { maxJsonNodes: 3 } }, small.parse).reportStatus).toBe("invalid");
    const absent = fixture(xml(properties()).replace(' name="fixture.ValueTest"', "")).parse();
    expect(absent.javaRuntimeObservations?.[0]).toMatchObject({ status: "unknown", reason: "missing-suite-identity", suite: null, scope: [] });
  });

  it("attributes each observation to its suite even when the report has several selected files", () => {
    const input = fixture(`<testsuites>${xml(properties()).replace(/^<\?xml[^>]+>/, "")}${xml(properties()).replace(/^<\?xml[^>]+>/, "").replace('name="fixture.ValueTest"', 'name="fixture.OtherTest"')}</testsuites>`);
    const selected = [...scope, "src/test/java/fixture/OtherTest.java"];
    const proof = readTestReport("java-junit", input.file, input.cwd, selected, selected);
    expect(proof.javaRuntimeObservations?.map(item => [item.suite, item.scope])).toEqual([["fixture.ValueTest", scope], ["fixture.OtherTest", [selected[1]]]]);
  });

  it.skipIf(process.platform === "win32")("preserves separate test-JVM observations in the Java gate aggregate", async () => {
    const input = fixture(xml(properties()));
    const other = xml(properties({ ...values, "java.version": "17.0.13" })).replace('name="fixture.ValueTest"', 'name="fixture.OtherTest"');
    const runner = path.join(input.cwd, "mvn");
    writeFileSync(runner, `#!${process.execPath}\nconst fs=require('node:fs');fs.mkdirSync('target/surefire-reports',{recursive:true});fs.writeFileSync('target/surefire-reports/TEST-fixture.ValueTest.xml',${JSON.stringify(input.raw)});fs.writeFileSync('target/surefire-reports/TEST-fixture.OtherTest.xml',${JSON.stringify(other)});`, { mode: 0o755 });
    const proof = (await runAffectedTests(input.cwd, { ...emptyDetectedTools(), maven: true, mavenBin: runner }, [...scope, "src/test/java/fixture/OtherTest.java"])).records![0]!.testExecution!;
    expect(proof.counts.executed).toBe(2);
    expect(proof.javaRuntimeObservations).toHaveLength(2);
    expect(proof.javaRuntimeObservations?.map(item => item.javaVersion).sort()).toEqual(["17.0.13", "21.0.7"]);
    expect(proof.javaRuntimeObservations?.map(item => item.scope).sort()).toEqual([["src/test/java/fixture/OtherTest.java"], scope]);
  });

  it("reads historical archive facts without rewriting their payload or inventing observations", async () => {
    const input = fixture(xml(properties()));
    const evidence = await withReportArchive(path.join(input.cwd, "reports"), async () => {
      const proof = input.parse();
      const record: ExecutionRecord = { id: "tests:legacy-jvm", checkId: "tests", scope, status: "passed", exitCode: 0, command: "mvn", args: [], cwd: input.cwd, durationMs: 1, testExecution: proof };
      const result: Evidence = JSON.parse(readFileSync(new URL("./fixtures/evidence-open-gaps.json", import.meta.url), "utf8"));
      result.executionRecords = [record]; result.checks = [{ id: "tests", name: "tests", status: "passed", records: [record] }];
      Object.assign(result.summary, { checksPassed: 1, checksFailed: 0, checksSkipped: 0 });
      return result;
    });
    const proof = evidence.executionRecords![0]!.testExecution!;
    const reference = proof.reports![0]!;
    const context = JSON.parse(readFileSync(reference.contextPath, "utf8"));
    delete context.expected.javaRuntimeObservations;
    const original = Buffer.from(JSON.stringify(context));
    reference.contextHash = `sha256:${createHash("sha256").update(original).digest("hex")}`;
    writeArtifactSet([{ path: reference.path, content: readFileSync(reference.path) }, { path: reference.contextPath, content: original },
      { path: path.join(path.dirname(reference.path), "index.json"), content: JSON.stringify({ schemaVersion: "1.0.0", kind: "patchprove-machine-report-archive", reportCount: 1 }) }], evidence.reportArchive!.manifestPath);
    evidence.reportArchive!.manifestHash = `sha256:${createHash("sha256").update(readFileSync(evidence.reportArchive!.manifestPath)).digest("hex")}`;
    delete proof.javaRuntimeObservations;
    const encoded = JSON.stringify(evidence);
    expect(verifyReportArchive(evidence)).toEqual({ ok: true, reports: 1, errors: [] });
    expect(JSON.stringify(evidence)).toBe(encoded);
    expect(readFileSync(reference.contextPath)).toEqual(original);
  });

  it("replays and validates JVM observations, rejecting tampering and misplaced identities", async () => {
    const input = fixture(xml(properties()));
    const evidence = await withReportArchive(path.join(input.cwd, "reports"), async () => {
      const proof = input.parse();
      const record: ExecutionRecord = { id: "tests:jvm", checkId: "tests", scope, status: "passed", exitCode: 0, command: "mvn", args: [], cwd: input.cwd, durationMs: 1, testExecution: proof };
      const result: Evidence = JSON.parse(readFileSync(new URL("./fixtures/evidence-open-gaps.json", import.meta.url), "utf8"));
      result.executionRecords = [record]; result.checks = [{ id: "tests", name: "tests", status: "passed", records: [record] }];
      Object.assign(result.summary, { checksPassed: 1, checksFailed: 0, checksSkipped: 0 });
      return result;
    });
    rmSync(input.file);
    expect(verifyReportArchive(evidence)).toEqual({ ok: true, reports: 1, errors: [] });
    const changed = structuredClone(evidence);
    changed.executionRecords![0]!.testExecution!.javaRuntimeObservations![0]!.fileEncoding = "UTF-8";
    expect(verifyReportArchive(changed).ok).toBe(false);
    const omitted = structuredClone(evidence);
    delete omitted.executionRecords![0]!.testExecution!.javaRuntimeObservations;
    expect(verifyReportArchive(omitted)).toMatchObject({ ok: false, errors: [expect.stringContaining("omits test-JVM")] });
    const invalid = structuredClone(evidence);
    invalid.executionRecords![0]!.testExecution!.javaRuntimeObservations![0]!.scope = ["unrequested.java"];
    expect(() => validateEvidence(invalid)).toThrow(/javaRuntimeObservations/);
    const unscoped = structuredClone(evidence);
    unscoped.executionRecords![0]!.testExecution!.javaRuntimeObservations![0]!.scope = [];
    expect(() => validateEvidence(unscoped)).toThrow(/javaRuntimeObservations/);
    const malformed = structuredClone(evidence);
    Object.assign(malformed.executionRecords![0]!.testExecution!.javaRuntimeObservations![0]!, { fileEncoding: null });
    expect(() => validateEvidence(malformed)).toThrow(/javaRuntimeObservations/);
    const wrongHash = structuredClone(evidence);
    wrongHash.executionRecords![0]!.testExecution!.javaRuntimeObservations![0]!.reportHash = "0".repeat(64);
    expect(() => validateEvidence(wrongHash)).toThrow(/javaRuntimeObservations.*reportHash/);
    const moved = relativizeReportArtifacts(evidence, input.cwd);
    expect(verifyReportArchive(moved, { artifactRoot: input.cwd }).ok).toBe(true);
  });
});
