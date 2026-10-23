#!/usr/bin/env node
import { validationIdentity } from "./validation-identity.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../dist/exec.js";
import { readBoundedFile, readJsonInput, withInputBudget } from "../dist/input-budget.js";
import { captureSnapshotIdentity, withGitExecutionBudget } from "../dist/snapshot.js";

const script = fileURLToPath(import.meta.url);
const scenario = process.argv.find((arg) => arg.startsWith("--case="))?.slice(7);
if (!scenario) {
  const report = { identity: validationIdentity(import.meta.url), schemaVersion: 1, generatedAt: new Date().toISOString(), hardware: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem() },
    node: process.version, heapLimitMiB: 256, cases: [], limitations: ["One local host, fixed synthetic inputs; results are not a throughput comparison or cross-platform guarantee.", "JSON and graph parsing are bounded synchronous sections with deadline polling; event-loop-delivered cancellation takes effect at the next asynchronous boundary."] };
  for (const id of ["oversize-file", "json-depth", "streamed-snapshot", "cancelled-snapshot"]) {
    const result = await runCommand(process.execPath, ["--max-old-space-size=256", script, `--case=${id}`], { cwd: process.cwd(), timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    report.cases.push(JSON.parse(result.stdout.trim()));
  }
  const output = process.env.PATCHPROVE_RESOURCE_REPORT ?? path.join(os.tmpdir(), "patchprove-resource-report.json");
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report, null, 2));
} else {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "patchprove-budget-benchmark-"));
  const startCpu = process.cpuUsage(), startRss = process.memoryUsage().rss;
  let started, outcome, cancellationLatencyMs, inputBytes;
  async function file(bytes) {
    const handle = await open(path.join(cwd, "payload.bin"), "w");
    try { const chunk = Buffer.alloc(64 * 1024, 65); for (let offset = 0; offset < bytes; offset += chunk.length) await handle.write(chunk); } finally { await handle.close(); }
  }
  try {
    if (scenario === "oversize-file") {
      inputBytes = 64 * 1024 * 1024; await file(inputBytes); started = performance.now();
      assert.throws(() => withInputBudget({}, () => readBoundedFile(path.join(cwd, "payload.bin"))), /size budget/); outcome = "rejected-before-allocation";
    } else if (scenario === "json-depth") {
      const text = "[".repeat(1000) + "0" + "]".repeat(1000); inputBytes = Buffer.byteLength(text);
      await writeFile(path.join(cwd, "deep.json"), text); started = performance.now();
      assert.throws(() => withInputBudget({}, () => readJsonInput(path.join(cwd, "deep.json"))), /maxJsonDepth/); outcome = "rejected-before-JSON.parse";
    } else {
      inputBytes = scenario === "streamed-snapshot" ? 16 * 1024 * 1024 : 32 * 1024 * 1024;
      await file(inputBytes);
      const git = await runCommand("git", ["init", "-q"], { cwd }); assert.equal(git.exitCode, 0);
      started = performance.now();
      if (scenario === "streamed-snapshot") {
        const snapshot = await withInputBudget({}, () => captureSnapshotIdentity(cwd)); assert(snapshot.contentHash); outcome = "captured";
      } else {
        const controller = new AbortController(); let cancelledAt;
        const timer = setTimeout(() => { cancelledAt = performance.now(); controller.abort(); }, 25);
        try {
          await assert.rejects(withInputBudget({ signal: controller.signal }, () => withGitExecutionBudget({ signal: controller.signal }, () => captureSnapshotIdentity(cwd))));
          cancellationLatencyMs = performance.now() - cancelledAt; assert(cancellationLatencyMs < 2000); outcome = "cancelled";
        } finally { clearTimeout(timer); }
      }
    }
    const cpu = process.cpuUsage(startCpu);
    console.log(JSON.stringify({ id: scenario, status: "passed", inputBytes, outcome, durationMs: performance.now() - started, cancellationLatencyMs,
      maxRssKiB: process.resourceUsage().maxRSS, initialRssBytes: startRss, finalRssBytes: process.memoryUsage().rss, cpuMsIncludingSetup: (cpu.user + cpu.system) / 1000 }));
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
