#!/usr/bin/env node
import { validationIdentity } from "./validation-identity.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../dist/exec.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Exercise the installed CLI and unmodified detector/plugins. Tool installation is caller-owned. */
export async function verifyProductionChain(installed, engines) {
  const manifest = JSON.parse(await readFile(path.join(root, "test/fixtures/runtimes/manifest.json"), "utf8"));
  for (const engine of engines) assert(manifest.cases.some((item) => item.engine === engine), `Unknown engine ${engine}`);
  const cli = path.join(installed, "dist/cli.js");
  const report = { identity: validationIdentity(import.meta.url), schemaVersion: 1, generatedAt: new Date().toISOString(), node: process.version, platform: process.platform,
    cliSha256: createHash("sha256").update(await readFile(cli)).digest("hex"), cases: [],
    limitations: ["Real engines in minimal fixtures, not mapping accuracy on real projects.", "Node runner dependency is explicitly linked from the build workspace; no plugin or tool detection is replaced.", "Missing-tool cases remain in the executor harness; this suite uses the caller's real installed tools."] };
  for (const item of manifest.cases.filter((item) => engines.includes(item.engine) && item.scenario !== "missing")) {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "patchprove-installed-测试 space-"));
    const artifacts = await mkdtemp(path.join(os.tmpdir(), "patchprove-installed-result-"));
    const command = async (program, args) => {
      const result = await runCommand(program, args, { cwd, timeoutMs: 180_000, maxOutputBytes: 2 * 1024 * 1024 });
      assert(!result.timedOut && !result.aborted && !result.truncated, `Unusable command result: ${result.command}`); return result;
    };
    try {
      await cp(path.join(root, "test/fixtures/runtimes", item.path), cwd, { recursive: true });
      await writeFile(path.join(cwd, ".gitignore"), "node_modules/\ntarget/\nbuild/\n.gradle/\n__pycache__/\n.pytest_cache/\nCargo.lock\n");
      if (item.engine === "node") await symlink(path.join(root, "node_modules"), path.join(cwd, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "baseline"]]) {
        const result = await command("git", args); assert.equal(result.exitCode, 0, result.stderr);
      }
      for (const test of item.tests) await writeFile(path.join(cwd, test), (await readFile(path.join(cwd, test), "utf8")) + (test.endsWith(".py") ? "\n# " : "\n// ") + "installed CLI verification\n");
      const output = path.join(artifacts, "evidence.json");
      const args = [cli, "run", "--cwd", cwd, "--out", output, "--disable-gate", "typecheck", "--disable-gate", "lint", "--disable-gate", "secrets", "--timeout-ms", "180000"];
      const result = await command(process.execPath, args);
      assert([0, 1].includes(result.exitCode), `${result.stdout}\n${result.stderr}`);
      const evidence = JSON.parse(await readFile(output, "utf8"));
      const check = evidence.checks.find((check) => check.id === "tests");
      assert.equal(check.status, item.expected, `${item.id}: ${check.reason}\n${JSON.stringify(check.records)}`);
      if (item.expected === "passed") assert(check.records.some((record) => record.status === "passed" && record.toolVersion && record.testExecution?.counts.executed > 0), "Actual execution and detected tool version required");
      report.cases.push({ id: item.id, status: "passed", cli: { exitCode: result.exitCode, args, outputHash: result.outputHash, durationMs: result.durationMs },
        verification: evidence.verification, environment: evidence.environment, tests: check });
      console.log(`PASS installed ${item.id}`);
    } catch (error) { report.cases.push({ id: item.id, status: "failed", error: String(error) }); console.error(`FAIL installed ${item.id}: ${error}`); }
    finally { await rm(cwd, { recursive: true, force: true }); await rm(artifacts, { recursive: true, force: true }); }
  }
  const output = process.env.PATCHPROVE_PRODUCTION_REPORT ?? path.join(os.tmpdir(), "patchprove-production-report.json");
  await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  assert(report.cases.length && report.cases.every((item) => item.status === "passed"), `Installed production chain failed; see ${output}`);
  return report;
}
