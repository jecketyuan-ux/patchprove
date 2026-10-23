#!/usr/bin/env node
import { validationIdentity } from "./validation-identity.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportTurboEvidence, loadAdapterEvidence } from "../dist/adapters.js";
import { captureSnapshotIdentity } from "../dist/snapshot.js";
import { runCommand } from "../dist/exec.js";

const binary = process.env.TURBO_BIN;
assert(binary && path.isAbsolute(binary), "Supply an explicit local TURBO_BIN (2.5.0); no tool is downloaded by this check");
const cwd = await mkdtemp(path.join(os.tmpdir(), "patchprove-turbo-contract-"));
const report = { identity: validationIdentity(import.meta.url), schemaVersion: 1, generatedAt: new Date().toISOString(), node: process.version, platform: process.platform, cases: [],
  limitations: ["Task completion and cache evidence are imported, never relabeled local test execution.", "Snapshot/input hashes are caller bindings; they do not authenticate the external producer.", "Native contract is tested only for Turbo 2.5.0; Nx and testmon normalized inputs remain experimental."] };
async function invoke(args, expected = 0) {
  const result = await runCommand(binary, args, { cwd, env: { TURBO_TELEMETRY_DISABLED: "1" }, timeoutMs: 30_000 });
  assert.equal(result.exitCode, expected, `${result.stdout}\n${result.stderr}`); return result;
}
async function git(args) {
  const result = await runCommand("git", args, { cwd }); assert.equal(result.exitCode, 0, result.stderr);
}
try {
  report.toolVersion = (await invoke(["--version"])).stdout.trim(); assert.equal(report.toolVersion, "2.5.0");
  await mkdir(path.join(cwd, "packages/api"), { recursive: true });
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "contract", private: true, packageManager: "npm@11.9.0", workspaces: ["packages/*"] }));
  await writeFile(path.join(cwd, "package-lock.json"), JSON.stringify({ name: "contract", lockfileVersion: 3, packages: { "": { name: "contract", workspaces: ["packages/*"] }, "packages/api": { name: "api", version: "1.0.0" }, "node_modules/api": { resolved: "packages/api", link: true } } }));
  await writeFile(path.join(cwd, "turbo.json"), JSON.stringify({ tasks: { test: { cache: true } } }));
  await writeFile(path.join(cwd, "packages/api/package.json"), JSON.stringify({ name: "api", version: "1.0.0", scripts: { test: "node test.cjs" } }));
  await writeFile(path.join(cwd, "packages/api/test.cjs"), 'require("node:assert/strict").equal(1+1, 2);\n');
  await writeFile(path.join(cwd, ".gitignore"), "node_modules/\n.turbo/\n*.adapter.json\n");
  await git(["init", "-q"]); await git(["add", "."]);
  await git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
  for (const scenario of ["plan", "execution", "cache", "failure"]) {
    if (scenario === "failure") await writeFile(path.join(cwd, "packages/api/test.cjs"), 'require("node:assert/strict").equal(1+1, 3);\n');
    const snapshotHash = (await captureSnapshotIdentity(cwd)).contentHash;
    const rawPlan = await invoke(["run", "test", "--dry=json"]), plan = JSON.parse(rawPlan.stdout);
    let summary;
    if (scenario !== "plan") {
      const prior = new Set(await readdir(path.join(cwd, ".turbo/runs")).catch(() => []));
      await invoke(["run", "test", "--summarize"], scenario === "failure" ? 1 : 0);
      const names = (await readdir(path.join(cwd, ".turbo/runs"))).filter((name) => !prior.has(name));
      assert.equal(names.length, 1, "Exactly one fresh upstream summary required");
      summary = JSON.parse(await readFile(path.join(cwd, ".turbo/runs", names[0]), "utf8"));
    }
    const envelope = exportTurboEvidence({ plan, summary, snapshotHash });
    await writeFile(path.join(cwd, "result.adapter.json"), JSON.stringify(envelope));
    const imported = loadAdapterEvidence([{ adapter: "turbo", path: "result.adapter.json" }], { cwd, snapshotHash });
    assert.deepEqual(imported.diagnostics, []);
    const expected = { plan: "imported", execution: "executed", cache: "cached", failure: "failed" }[scenario];
    assert.equal(imported.tasks[0]?.state, expected, JSON.stringify(imported));
    assert(!imported.records.some((record) => record.status === "passed"));
    report.cases.push({ id: scenario, status: "passed", envelope, imported }); console.log(`PASS Turbo ${scenario}`);
  }
} finally { await rm(cwd, { recursive: true, force: true }); }
const output = process.env.PATCHPROVE_UPSTREAM_REPORT ?? path.join(os.tmpdir(), "patchprove-upstream-report.json");
await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Upstream contract report: ${output}`);
