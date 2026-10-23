#!/usr/bin/env node
import { validationIdentity } from "./validation-identity.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../dist/exec.js";
import { collectGitSnapshot } from "../dist/git.js";
import { filterIgnored } from "../dist/evidence.js";
import { runSecretScan } from "../dist/gates.js";
import { analyze } from "../dist/run.js";
import { emptyDetectedTools } from "../dist/types.js";

const binary = process.env.GITLEAKS_BIN;
assert(binary && path.isAbsolute(binary), "Supply an explicit local GITLEAKS_BIN; this harness never downloads tools");
const version = await runCommand(binary, ["version"], { cwd: process.cwd(), timeoutMs: 10_000 });
assert.equal(version.exitCode, 0); assert.equal(version.stdout.trim(), "8.24.3", "This contract is pinned to Gitleaks 8.24.3");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const token = "ghp_0123456789abcdefghijklmnopqrstuvwxyz"; // Public synthetic fixture, never a credential.
const report = { identity: validationIdentity(import.meta.url), schemaVersion: 1, generatedAt: new Date().toISOString(), node: process.version, platform: process.platform,
  tool: { version: version.stdout.trim(), path: binary, binarySha256: sha(await readFile(binary)) }, cases: [],
  limitations: ["Synthetic public test values and fixed engine version; not a secret-detector recall benchmark.", "Ignore cases cover Git ignore and patchprove path policy, not arbitrary upstream gitleaksignore fingerprint semantics."] };
const tools = { ...emptyDetectedTools(), gitleaks: true, gitleaksBin: binary, versions: { gitleaks: "8.24.3" } };
let failures = 0;
for (const scenario of ["staged", "unstaged", "mixed", "untracked", "git-ignore", "policy-ignore", "range", "backend-failure", "no-backend", "production-discovery"]) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "patchprove-gitleaks-accept-"));
  const git = async (...args) => {
    const result = await runCommand("git", ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], { cwd });
    assert.equal(result.exitCode, 0, result.stderr); return result.stdout.trim();
  };
  try {
    await writeFile(path.join(cwd, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(cwd, "tracked.txt"), "ordinary baseline\n");
    await git("init", "-q"); await git("add", ".");
    await git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    const base = await git("rev-parse", "HEAD");
    const contents = scenario === "backend-failure" || scenario === "no-backend" ? "ordinary changed text\n" : `fixture credential = "${token}"\n`;
    const name = scenario === "untracked" ? "new.txt" : scenario === "git-ignore" ? "ignored.txt" : "tracked.txt";
    if (scenario === "mixed") { await writeFile(path.join(cwd, name), "staged safe line\n"); await git("add", name); }
    await writeFile(path.join(cwd, name), contents);
    if (scenario === "staged" || scenario === "range") await git("add", name);
    let options = {};
    if (scenario === "range") { await git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "changed"); options = { base, head: "HEAD" }; }
    const snapshot = await collectGitSnapshot(cwd, options);
    const selected = scenario === "policy-ignore" ? filterIgnored(snapshot.files, ["tracked.txt"]) : snapshot.files;
    const selectedTools = scenario === "backend-failure" ? { ...tools, gitleaksBin: path.join(cwd, "missing-binary") } : scenario === "no-backend" ? emptyDetectedTools() : tools;
    const result = await runSecretScan(cwd, selectedTools, selected, snapshot.range);
    const expected = ["git-ignore", "policy-ignore", "no-backend"].includes(scenario) ? "passed" : "failed";
    assert.equal(result.check.status, expected, `${scenario}: ${result.check.reason}`);
    const external = result.check.records?.find((record) => record.id === "secrets:gitleaks");
    if (!["backend-failure", "no-backend"].includes(scenario)) assert(external?.command, "A real scanner must execute");
    assert(!JSON.stringify(result).includes(token), "Raw fixture credentials must not persist in output");
    let discovery;
    if (scenario === "production-discovery") {
      const previous = process.env.PATH;
      try {
        process.env.PATH = `${path.dirname(binary)}${path.delimiter}${previous ?? ""}`;
        const evidence = await analyze({ cwd, out: path.join(os.tmpdir(), "gitleaks-unwritten.json"), json: true, format: "json", disableGate: ["typecheck", "lint", "tests"] });
        assert.equal(evidence.verification.status, "failed");
        assert(evidence.executionRecords.some((record) => record.id === "secrets:gitleaks" && record.toolVersion?.includes("8.24.3")));
        discovery = { verification: evidence.verification, tools: evidence.environment.tools.filter((tool) => tool.name === "gitleaks") };
      } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
    }
    report.cases.push({ id: scenario, expected, status: "passed", changedFiles: snapshot.files.map((file) => file.path), selectedFiles: selected.map((file) => file.path), result, ...(discovery ? { discovery } : {}) });
    console.log(`PASS ${scenario}`);
  } catch (error) { failures++; report.cases.push({ id: scenario, status: "failed", error: String(error) }); console.error(`FAIL ${scenario}: ${error}`); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}
const out = process.env.PATCHPROVE_GITLEAKS_REPORT ?? path.join(os.tmpdir(), "patchprove-gitleaks-report.json");
await mkdir(path.dirname(out), { recursive: true }); await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Gitleaks report: ${out}`); process.exitCode = failures ? 1 : 0;
