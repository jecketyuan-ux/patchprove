import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { retainRuntimeFailure, runtimeReportState } from "../scripts/runtime-failure-retention.mjs";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-retention-")); roots.push(root);
  const project = path.join(root, "fixture"), destination = path.join(root, "diagnostics");
  await mkdir(project);
  const write = async (name: string, bytes: string | Buffer) => { const target = path.join(project, name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes); };
  return { root, project, destination, write };
}

it("preserves unmatched infrastructure XML and generated test bytes after a failed fixture is removed", async () => {
  const f = await fixture();
  await f.write("build.gradle", "plugins { id 'java' }\n");
  await f.write("credentials.txt", "must-not-retain");
  const before = await runtimeReportState(f.project);
  const xml = '<testsuite tests="1"><testcase name="failed to execute"><error type="java.lang.ClassNotFoundException"/></testcase></testsuite>\r\n';
  await f.write("build/test-results/test/TEST-Gradle Test Executor 1.xml", xml);
  const classBytes = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 65]);
  await f.write("build/classes/java/test/fixture/ValueTest.class", classBytes);
  const selectedRun = { result: { status: "failed", detail: "class loading failed", records: [{ exitCode: 1 }] }, archive: { manifestPath: "selected/manifest.json" } };
  const indexRef = await retainRuntimeFailure({ fixtureRoot: f.project, destination: f.destination, phase: "selected", selectedRun, fullResult: null, priorReports: before });
  await rm(f.project, { recursive: true });
  const index = JSON.parse(await readFile(path.join(f.destination, indexRef.path), "utf8"));
  expect(index.files.map((file: { path: string }) => file.path)).toEqual(expect.arrayContaining([
    "fixture/build.gradle", "fixture/build/test-results/test/TEST-Gradle Test Executor 1.xml", "fixture/build/classes/java/test/fixture/ValueTest.class", "command-result.reconstructed.json",
  ]));
  expect(index.files.some((file: { path: string }) => file.path.includes("credentials"))).toBe(false);
  expect(await readFile(path.join(f.destination, "fixture/build/test-results/test/TEST-Gradle Test Executor 1.xml"), "utf8")).toBe(xml);
  expect(await readFile(path.join(f.destination, "fixture/build/classes/java/test/fixture/ValueTest.class"))).toEqual(classBytes);
  const reconstructed = JSON.parse(await readFile(path.join(f.destination, "command-result.reconstructed.json"), "utf8"));
  expect(reconstructed.kind).toBe("reconstructed-command-result");
  expect(reconstructed.notice).toContain("not original process byte streams");
  expect(reconstructed.selectedRun).toEqual(selectedRun);
  expect(index.files.every((file: { bytes: number; sha256: string; path: string }) => file.bytes > 0 && /^[a-f0-9]{64}$/.test(file.sha256) && !path.isAbsolute(file.path))).toBe(true);
});

it("omits stale XML, oversized files and fixture links rather than copying external input", async () => {
  const f = await fixture();
  await f.write("build/test-results/test/TEST-stale.xml", "unchanged old report");
  const before = await runtimeReportState(f.project);
  await f.write("build/test-results/test/TEST-oversized.xml", Buffer.alloc(1024 * 1024 + 1));
  const outside = path.join(f.root, "outside"); await mkdir(outside); await writeFile(path.join(outside, "TEST-private.xml"), "external");
  await symlink(outside, path.join(f.project, "external"), process.platform === "win32" ? "junction" : "dir");
  const ref = await retainRuntimeFailure({ fixtureRoot: f.project, destination: f.destination, phase: "selected", selectedRun: null, fullResult: null, priorReports: before });
  const index = JSON.parse(await readFile(path.join(f.destination, ref.path), "utf8"));
  expect(index.files.map((file: { path: string }) => file.path)).toEqual(["command-result.reconstructed.json"]);
  expect(index.omitted).toEqual([{ path: "build/test-results/test/TEST-oversized.xml", reason: "not a bounded regular file" }]);
});

it("retains real full-process byte buffers without reconstructing non-UTF8 or CRLF data", async () => {
  const f = await fixture();
  const stdoutBytes = Buffer.from([0xff, 0xfe, 0x61, 0x0d, 0x0a]);
  const stderrBytes = Buffer.from([0x80, 0x62, 0x0d, 0x0a]);
  const fullResult = { command: "fixture-runner", exitCode: 1, stdoutBytes, stderrBytes, stdout: "decoded-output", stderr: "decoded-error" };
  const ref = await retainRuntimeFailure({ fixtureRoot: f.project, destination: f.destination, phase: "full", selectedRun: null, fullResult });
  const index = JSON.parse(await readFile(path.join(f.destination, ref.path), "utf8"));
  expect(await readFile(path.join(f.destination, "full/stdout.raw"))).toEqual(stdoutBytes);
  expect(await readFile(path.join(f.destination, "full/stderr.raw"))).toEqual(stderrBytes);
  expect(index.files.filter((file: { kind: string }) => file.kind === "original-process-stream")).toHaveLength(2);
  for (const file of index.files) {
    const bytes = await readFile(path.join(f.destination, file.path));
    expect(file.bytes).toBe(bytes.length);
    expect(file.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  }
});
