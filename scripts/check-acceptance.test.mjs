import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { acceptanceTemplate, CI_JOBS, requiredAcceptanceCases, verifyAcceptance, verifyPackagedRuntime } from "./check-acceptance.mjs";
import { javaFixtureAssertions } from "./runtime-assertions.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "patchprove-acceptance-contract-"));
  const tarballPath = path.join(directory, "candidate.tgz");
  const archive = Buffer.from("Contract fixture only, not a published package");
  const raw = Buffer.from("Synthetic validator contract fixture, not live-host acceptance.\n");
  writeFileSync(tarballPath, archive); writeFileSync(path.join(directory, "run.log"), raw);
  const expected = { commit: "a".repeat(40), tree: "b".repeat(40), runtimeDigest: "c".repeat(64), tarballSha256: sha(archive) };
  const log = { path: "run.log", bytes: raw.length, sha256: sha(raw) };
  const ledger = acceptanceTemplate({ ...expected, workingTreeDirty: false });
  ledger.ci = { head: expected.commit, runId: 12, attempt: 2, url: "https://github.com/fixture/repo/actions/runs/12", conclusion: "success", log,
    jobs: CI_JOBS.map((name) => ({ name, status: "completed", conclusion: "success" })) };
  ledger.records = requiredAcceptanceCases().map((item) => {
    const record = { id: item.id, status: "passed", method: "live", candidate: expected, expected: "Specified behavior", observed: "Specified behavior observed", log };
    if (item.kind === "host") Object.assign(record, { host: { name: item.host, version: "contract-fixture" }, platform: "linux", nodeVersion: "v22.contract", verification: item.scenario === "failure" ? "failed" : item.scenario === "incomplete" ? "incomplete" : "passed", hostAction: item.host === "claude-code" ? "blocked" : "advised", orphanProcesses: 0 });
    if (item.kind === "github") Object.assign(record, { repository: "fixture/repo", headRepository: item.repository === "fork" ? "fixture-fork/repo" : "fixture/repo", runUrl: "https://github.com/fixture/repo/actions/runs/12", attempt: 2, originalExitCode: item.scenario === "passed" ? 0 : 1, preservedExitCode: item.scenario === "passed" ? 0 : 1, verification: item.scenario, commentUrl: "https://github.com/fixture/repo/pull/1#issuecomment-1", staleOrUnverifiedCommentPublished: false });
    if (item.kind === "windows") Object.assign(record, { platform: "win32", tools: { java: "21.contract", gradle: "contract" }, nonAsciiPath: true, spaceInPath: true, executedAssertions: 2, infrastructureErrors: 0, failedAssertions: item.scenario === "installed-assertion-failure" ? 1 : 0, verification: item.scenario === "installed-assertion-failure" ? "failed" : "passed", casesPassed: 30, casesFailed: 0, casesSkipped: 0 });
    return record;
  });
  return { ledger, expected, directory, tarballPath, check: () => verifyAcceptance(ledger, { directory, expected, tarballPath }), close: () => rmSync(directory, { recursive: true, force: true }) };
}
function scenario(name, mutate, expectedError) {
  test(name, () => { const f = fixture(); try { mutate(f); const result = f.check(); assert.equal(result.passed, false); assert(result.errors.some((error) => error.includes(expectedError)), JSON.stringify(result.errors)); } finally { f.close(); } });
}

test("complete internally consistent contract fixture is accepted without executing its contents", () => {
  const f = fixture(); try { const result = f.check(); assert.equal(result.passed, true, JSON.stringify(result.errors)); assert.equal(result.cases.length, 44); assert.equal(result.checkedFiles.length, 1); } finally { f.close(); }
});
scenario("not-run host is a release blocker", (f) => { f.ledger.records[0].status = "not-run"; }, "acceptance status is not-run");
scenario("stdio substitute cannot establish real host acceptance", (f) => { f.ledger.records[0].method = "stdio-fixture"; }, "fixtures/stdio");
scenario("old candidate cannot lend its acceptance to new code", (f) => { f.ledger.records[0].candidate = { ...f.expected, commit: "d".repeat(40) }; }, "different candidate");
scenario("successful old-head CI cannot establish current-head acceptance", (f) => { f.ledger.ci.head = "d".repeat(40); }, "current-head");
scenario("cancelled required job does not count as success", (f) => { f.ledger.ci.jobs[0].conclusion = "cancelled"; }, "skipped/cancelled/pending");
scenario("duplicate successful jobs cannot hide an ambiguous CI result", (f) => { f.ledger.ci.jobs.push({ ...f.ledger.ci.jobs[0] }); }, "one completed");
scenario("an additional failing CI job cannot be ignored", (f) => { f.ledger.ci.jobs.push({ name: "Additional check", status: "completed", conclusion: "failure" }); }, "every recorded");
scenario("tampered log invalidates the acceptance record", (f) => { writeFileSync(path.join(f.directory, "run.log"), "changed"); }, "size/type differs");
scenario("missing candidate archive invalidates a complete ledger", (f) => { rmSync(f.tarballPath); }, "tarball");
scenario("changed candidate archive cannot reuse the recorded digest", (f) => { writeFileSync(f.tarballPath, "changed"); }, "archive digest differs");
scenario("traversing log paths are rejected", (f) => { f.ledger.records[0].log = { ...f.ledger.records[0].log, path: "../outside.log" }; }, "stay in the evidence");
scenario("Cursor advice must not be mislabeled as enforcement", (f) => { f.ledger.records.find((r) => r.id === "host:cursor:failure").hostAction = "blocked"; }, "host-specific action");
scenario("Gradle class loading errors cannot satisfy a failing-assertion case", (f) => { const r = f.ledger.records.find((r) => r.id === "windows:installed-assertion-failure"); r.infrastructureErrors = 1; r.failedAssertions = 0; }, "real assertions");
scenario("removing original non-ASCII path conditions cannot turn Windows green", (f) => { f.ledger.records.find((r) => r.id === "windows:installed-success").nonAsciiPath = false; }, "path conditions");
scenario("publisher cannot erase original verification failure", (f) => { f.ledger.records.find((r) => r.id === "github:fork:failed").preservedExitCode = 0; }, "preserve the original");
scenario("same-repository runs cannot be relabeled as fork acceptance", (f) => { f.ledger.records.find((r) => r.id === "github:fork:passed").headRepository = "fixture/repo"; }, "relationship");
scenario("incomplete Windows execution cannot satisfy a normal case", (f) => { f.ledger.records.find((r) => r.id === "windows:installed-success").verification = "incomplete"; }, "complete passed");
scenario("a skipped native fixture cannot lend its green summary to release", (f) => { f.ledger.records.find((r) => r.id === "windows:native-matrix").casesSkipped = 1; }, "30 native");
scenario("a missing required live case cannot be replaced by another duplicate", (f) => { f.ledger.records[0] = { ...f.ledger.records[1] }; }, "exactly one");
test("generated template stays blocked and does not invent live results", () => {
  const f = fixture(); try { const ledger = acceptanceTemplate(f.ledger.candidate); const result = verifyAcceptance(ledger, f); assert.equal(result.passed, false); assert(ledger.records.every((r) => r.status === "not-run" && r.method === "not-run")); } finally { f.close(); }
});

function archiveFixture(members) {
  const parts = [];
  for (const { name, content = "fixture", type = 48 } of members) {
    const bytes = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write(bytes.length.toString(8).padStart(11, "0"), 124, 11, "ascii");
    header.fill(32, 148, 156); header[156] = type;
    header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0"), 148, 6, "ascii");
    header[154] = 0; header[155] = 32;
    parts.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}
const measuredInputs = [{ path: "dist/index.js", sha256: sha("fixture") }, { path: "package-lock.json", sha256: sha("unpackaged lock") }];
test("packaged executable bytes must match the measured runtime without extracting code", () => {
  assert.deepEqual(verifyPackagedRuntime(archiveFixture([{ name: "package/dist/index.js" }]), measuredInputs), { inputsMatched: 1 });
});
test("a different package cannot be paired with the current runtime digest", () => {
  assert.throws(() => verifyPackagedRuntime(archiveFixture([{ name: "package/dist/index.js", content: "different code" }]), measuredInputs), /runtime differs/);
  assert.throws(() => verifyPackagedRuntime(archiveFixture([{ name: "package/other.js" }]), measuredInputs), /input missing/);
});
test("package duplicate, traversal and link members cannot replace executable bytes", () => {
  for (const members of [
    [{ name: "package/dist/index.js" }, { name: "package/dist/index.js" }],
    [{ name: "package/../dist/index.js" }],
    [{ name: "package/dist/index.js", type: 50 }],
  ]) assert.throws(() => verifyPackagedRuntime(archiveFixture(members), measuredInputs), /unsafe|duplicate|regular/);
});
test("corrupt and expansion-heavy packages fail within the archive budget", () => {
  assert.throws(() => verifyPackagedRuntime(Buffer.from("not gzip"), measuredInputs));
  assert.throws(() => verifyPackagedRuntime(gzipSync(Buffer.alloc(65 * 1024 * 1024)), measuredInputs), /larger than|buffer|size|length/i);
});
test("actual JUnit assertion failures remain distinguishable from fixture infrastructure errors", () => {
  const facts = javaFixtureAssertions([Buffer.from('<testsuite tests="2"><testcase name="healthy"/><testcase name="negative"><failure type="org.opentest4j.AssertionFailedError">expected 2 but was 3</failure></testcase></testsuite>')]);
  assert.deepEqual(facts, { collectedCases: 2, executedCases: 2, assertionFailures: 1, infrastructureErrors: 0 });
});
test("Gradle class-loading failures cannot satisfy expected fixture assertion failures", () => {
  for (const report of [
    '<testcase name="failed to execute tests"><failure type="org.gradle.api.internal.tasks.testing.TestSuiteExecutionException">ClassNotFoundException</failure></testcase>',
    '<testcase name="loading"><error type="java.lang.ClassNotFoundException"/></testcase>',
  ]) assert.deepEqual(javaFixtureAssertions([report]), { collectedCases: 1, executedCases: 1, assertionFailures: 0, infrastructureErrors: 1 });
});
test("empty and skipped fixture reports do not establish execution or assertions", () => {
  assert.deepEqual(javaFixtureAssertions(['<testsuite tests="1"><testcase><skipped/></testcase></testsuite>']), { collectedCases: 1, executedCases: 0, assertionFailures: 0, infrastructureErrors: 0 });
});
