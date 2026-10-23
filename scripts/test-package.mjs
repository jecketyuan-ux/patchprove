#!/usr/bin/env node
import { validationIdentity } from "./validation-identity.mjs";
import { verifyPackagedRuntime } from "./check-acceptance.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runCommand, childEnvironment } from "../dist/exec.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await mkdtemp(path.join(os.tmpdir(), "patchprove-package-"));
const npmCli = process.env.npm_execpath;
assert(npmCli, "Run this check with npm run test:package so npm's JS entry is known on all platforms");
const reportOutput = process.env.PATCHPROVE_PACKAGE_REPORT ? path.resolve(process.env.PATCHPROVE_PACKAGE_REPORT) : null;
const retained = reportOutput ? `${reportOutput}.data` : null;
if (retained) await mkdir(retained, { recursive: true, mode: 0o700 });
const report = { identity: validationIdentity(import.meta.url), schemaVersion: 1, status: "running", node: process.version, platform: process.platform, install: "Local project tarball in a fresh consumer; declared dependencies downloaded with install scripts disabled", runtimeNetwork: "No application network calls are required for CLI and stdio MCP checks", commands: [] };
async function command(program, args, cwd = root, expected = 0, env) {
  const result = await runCommand(program, args, { cwd, timeoutMs: 180000, maxOutputBytes: 4 * 1024 * 1024, env });
  if (retained) {
    const stdout = result.stdoutBytes ?? Buffer.from(result.stdout), stderr = result.stderrBytes ?? Buffer.from(result.stderr);
    const bytes = Buffer.concat([stdout, Buffer.from("\n"), stderr]);
    const log = path.join(retained, `command-${report.commands.length + 1}.log`);
    await writeFile(log, bytes, { mode: 0o600 });
    report.commands.push({ command: program, args, cwd, exitCode: result.exitCode, expectedExitCode: expected,
      timedOut: result.timedOut, aborted: result.aborted, truncated: result.truncated,
      stdoutByteLength: stdout.length, stderrByteLength: stderr.length,
      log: { path: log, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } });
  }
  assert.equal(result.exitCode, expected, `${result.command}\n${result.stdout}\n${result.stderr}`); return result;
}
try {
  const packed = await command(process.execPath, [npmCli, "pack", "--json", "--ignore-scripts", "--cache", path.join(temp, "npm-cache"), "--pack-destination", temp]);
  const pack = JSON.parse(packed.stdout)[0];
  assert(pack.files.some((item) => item.path === "dist/cli.js"));
  assert(pack.files.some((item) => item.path === "dist/mcp.js"));
  assert(!pack.files.some((item) => item.path.startsWith("docs/reviews/")), "Historical audit materials must not ship as product docs");
  assert(!pack.files.some((item) => item.path.startsWith("docs/validation/")), "Raw candidate ledgers must remain in the repository, outside the ordinary installation package");
  assert(pack.files.some((item) => item.path === "docs/host-acceptance.md"), "Current support and acceptance instructions must ship");
  report.package = { filename: pack.filename, integrity: pack.integrity, shasum: pack.shasum, version: pack.version, compressedBytes: pack.size, unpackedBytes: pack.unpackedSize, files: pack.entryCount };
  const archive = await readFile(path.join(temp, pack.filename));
  report.package.runtimeInputsMatched = verifyPackagedRuntime(archive, report.identity.inputs).inputsMatched;
  if (retained) {
    const destination = path.join(retained, "patchprove.tgz");
    await writeFile(destination, archive, { mode: 0o600 });
    report.package.archive = { path: destination, bytes: archive.length, sha256: createHash("sha256").update(archive).digest("hex") };
  }
  const consumer = path.join(temp, "consumer"); await mkdir(consumer);
  await writeFile(path.join(consumer, "package.json"), JSON.stringify({ name: "patchprove-empty-consumer", private: true, type: "module" }));
  await command(process.execPath, [npmCli, "install", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", path.join(temp, "npm-cache"), path.join(temp, pack.filename)], consumer);
  const installed = path.join(consumer, "node_modules/patchprove");
  const metadata = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
  assert.equal(metadata.version, "2.0.0"); assert.equal(metadata.engines.node, ">=22");
  for (const name of ["cli", "mcp"]) assert((await readFile(path.join(installed, "dist", `${name}.js`), "utf8")).startsWith("#!/usr/bin/env node\n"));
  const cli = path.join(installed, "dist/cli.js");
  assert.equal((await command(process.execPath, [cli, "--version"], consumer)).stdout.trim(), metadata.version);
  await command(process.execPath, [cli, "run", "--help"], consumer);
  const repo = path.join(temp, "repo"); await mkdir(repo);
  await writeFile(path.join(repo, "README.md"), "Package smoke fixture\n");
  for (const args of [["init"], ["add", "."], ["-c", "user.name=package-smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture"]]) await command("git", args, repo);
  await writeFile(path.join(repo, "README.md"), "Package smoke fixture updated\n");
  const evidence = path.join(temp, "evidence.json"), receipt = path.join(temp, "evidence.receipt.json");
  await command(process.execPath, [cli, "run", "--cwd", repo, "--disable-gate", "typecheck", "--disable-gate", "lint", "--disable-gate", "tests", "--out", evidence, "--receipt", receipt], consumer);
  const json = JSON.parse(await readFile(evidence, "utf8"));
  assert.equal(json.schemaVersion, "2.1.0");
  await command(process.execPath, [cli, "receipt", "verify", evidence, receipt], consumer);
  const exports = await import(pathToFileURL(path.join(installed, "dist/index.js")).href);
  assert.equal(typeof exports.analyze, "function");
  const client = new Client({ name: "patchprove-package-smoke", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(installed, "dist/mcp.js")], cwd: consumer, env: childEnvironment(), stderr: "pipe" });
  let serverError = ""; transport.stderr?.on("data", (chunk) => { serverError = (serverError + String(chunk)).slice(-65536); });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["list_gaps", "prove_patch"]);
    const gaps = await client.callTool({ name: "list_gaps", arguments: { evidencePath: evidence } });
    assert(!gaps.isError, `Installed MCP list_gaps failed: ${JSON.stringify(gaps)} ${serverError}`);
    const text = gaps.content.find((item) => item.type === "text");
    assert.equal(typeof JSON.parse(text.text).claimDone, "boolean");
    const proof = await client.callTool({ name: "prove_patch", arguments: { cwd: repo, disableGate: ["typecheck", "lint", "tests"] } });
    assert(!proof.isError, `Installed MCP prove_patch failed: ${JSON.stringify(proof)} ${serverError}`);
    report.mcp = "stdio initialization, tools/list, list_gaps, prove_patch";
  } catch (cause) {
    throw new Error(`Installed MCP smoke failed: ${cause instanceof Error ? cause.message : String(cause)}\nServer stderr:\n${serverError || "(empty)"}`, { cause });
  } finally { await client.close(); }
  const base = (await command("git", ["rev-parse", "HEAD"], repo)).stdout.trim();
  await command("git", ["add", "README.md"], repo);
  await command("git", ["-c", "user.name=package-smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "documented change"], repo);
  const head = (await command("git", ["rev-parse", "HEAD"], repo)).stdout.trim();
  const incoming = path.join(temp, "incoming"); await mkdir(incoming);
  await command(process.execPath, [cli, "run", "--cwd", repo, "--base", base, "--head", head, "--disable-gate", "typecheck", "--disable-gate", "lint", "--disable-gate", "tests", "--out", path.join(incoming, "evidence.json"), "--receipt", path.join(incoming, "evidence.receipt.json")], consumer);
  const eventPath = path.join(temp, "workflow-event.json");
  const event = { repository: { full_name: "fixture/repo" }, workflow_run: { id: 1, event: "pull_request", head_sha: head, pull_requests: [{ number: 1 }] } };
  await writeFile(eventPath, JSON.stringify(event));
  const publisherArgs = [path.join(root, "scripts/verify-publish.mjs"), incoming];
  await command(process.execPath, publisherArgs, consumer, 0, { GITHUB_EVENT_PATH: eventPath });
  assert((await readFile(path.join(incoming, "verified-comment.md"), "utf8")).startsWith("<!-- patchprove-sticky -->"));
  event.workflow_run.head_sha = "f".repeat(40); await writeFile(eventPath, JSON.stringify(event));
  await command(process.execPath, publisherArgs, consumer, 1, { GITHUB_EVENT_PATH: eventPath });
  event.workflow_run.head_sha = head; await writeFile(eventPath, JSON.stringify(event));
  const artifact = JSON.parse(await readFile(path.join(incoming, "evidence.json"), "utf8"));
  artifact.summary.risk = "critical"; await writeFile(path.join(incoming, "evidence.json"), JSON.stringify(artifact));
  await command(process.execPath, publisherArgs, consumer, 1, { GITHUB_EVENT_PATH: eventPath });
  // A genuine installed runner creates a portable archive; verify a moved pack
  // after deleting the original location, then reject a modified raw report.
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ private: true, type: "module", devDependencies: { vitest: "4.1.12" } }));
  await writeFile(path.join(repo, ".gitignore"), "node_modules/\n");
  await mkdir(path.join(repo, "test"));
  await writeFile(path.join(repo, "test/smoke.test.js"), "import { test, expect } from 'vitest';\ntest('installed archive', () => expect(2 + 2).toBe(4));\n");
  await symlink(path.join(root, "node_modules"), path.join(repo, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await command("git", ["add", "."], repo);
  await command("git", ["-c", "user.name=package-smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "archive baseline"], repo);
  const archiveBase = (await command("git", ["rev-parse", "HEAD"], repo)).stdout.trim();
  await writeFile(path.join(repo, "test/smoke.test.js"), (await readFile(path.join(repo, "test/smoke.test.js"), "utf8")) + "// archive verification change\n");
  await command("git", ["add", "."], repo);
  await command("git", ["-c", "user.name=package-smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "archive change"], repo);
  const archiveHead = (await command("git", ["rev-parse", "HEAD"], repo)).stdout.trim();
  const archived = path.join(temp, "archived"); await mkdir(archived);
  await command(process.execPath, [cli, "run", "--cwd", repo, "--base", archiveBase, "--head", archiveHead, "--disable-gate", "typecheck", "--disable-gate", "lint", "--out", path.join(archived, "evidence.json"), "--reports-dir", path.join(archived, "machine-reports")], consumer);
  const archivedEvidence = JSON.parse(await readFile(path.join(archived, "evidence.json"), "utf8"));
  const rawReport = archivedEvidence.executionRecords.flatMap((record) => record.testExecution?.reports ?? [])[0];
  assert(rawReport && !path.isAbsolute(rawReport.path), "Persisted raw-report references must be portable");
  const relocated = path.join(temp, "relocated"); await cp(archived, relocated, { recursive: true }); await rm(archived, { recursive: true, force: true });
  event.workflow_run.head_sha = archiveHead; await writeFile(eventPath, JSON.stringify(event));
  await command(process.execPath, [path.join(root, "scripts/verify-publish.mjs"), relocated], consumer, 0, { GITHUB_EVENT_PATH: eventPath });
  if (retained) {
    const destination = path.join(retained, "publisher-valid");
    await cp(relocated, destination, { recursive: true });
    report.publisherArtifacts = destination;
  }
  await writeFile(path.join(relocated, rawReport.path), "{}\n");
  await command(process.execPath, [path.join(root, "scripts/verify-publish.mjs"), relocated], consumer, 1, { GITHUB_EVENT_PATH: eventPath });
  report.publisher = "trusted rendering validates matching head/receipt, portable raw-report replay after relocation, and rejects wrong head or tampered evidence/report; no publication performed";
  if (process.env.PATCHPROVE_PRODUCTION_ENGINES) {
    const { verifyProductionChain } = await import("./test-production.mjs");
    const production = await verifyProductionChain(installed, process.env.PATCHPROVE_PRODUCTION_ENGINES.split(","));
    report.productionCases = production.cases.length;
  }
  report.package.version = metadata.version;
  report.cli = "version, help, strict protocol-2 evidence, receipt verification, public module import";
  report.status = "passed";
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.status = "failed"; report.error = String(error); throw error;
} finally {
  if (reportOutput) { await mkdir(path.dirname(reportOutput), { recursive: true }); await writeFile(reportOutput, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }); }
  await rm(temp, { recursive: true, force: true });
}
