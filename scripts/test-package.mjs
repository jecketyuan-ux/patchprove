#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const report = { schemaVersion: 1, node: process.version, platform: process.platform, install: "Local project tarball in a fresh consumer; declared dependencies downloaded with install scripts disabled", runtimeNetwork: "No application network calls are required for CLI and stdio MCP checks" };
async function command(program, args, cwd = root, expected = 0, env) {
  const result = await runCommand(program, args, { cwd, timeoutMs: 180000, maxOutputBytes: 4 * 1024 * 1024, env });
  assert.equal(result.exitCode, expected, `${result.command}\n${result.stdout}\n${result.stderr}`); return result;
}
try {
  const packed = await command(process.execPath, [npmCli, "pack", "--json", "--ignore-scripts", "--cache", path.join(temp, "npm-cache"), "--pack-destination", temp]);
  const pack = JSON.parse(packed.stdout)[0];
  assert(pack.files.some((item) => item.path === "dist/cli.js"));
  assert(pack.files.some((item) => item.path === "dist/mcp.js"));
  assert(!pack.files.some((item) => item.path.startsWith("docs/reviews/")), "Historical audit materials must not ship as product docs");
  const { mkdir } = await import("node:fs/promises");
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
  assert.equal(json.schemaVersion, "2.0.0");
  await command(process.execPath, [cli, "receipt", "verify", evidence, receipt], consumer);
  const exports = await import(pathToFileURL(path.join(installed, "dist/index.js")).href);
  assert.equal(typeof exports.analyze, "function");
  const client = new Client({ name: "patchprove-package-smoke", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(installed, "dist/mcp.js")], cwd: consumer, env: childEnvironment(), stderr: "pipe" });
  let serverError = ""; transport.stderr?.on("data", (chunk) => { serverError += String(chunk); });
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
  report.publisher = "trusted rendering accepts matching receipt/head and rejects wrong head or tampered evidence; no publication performed";
  report.package = { filename: pack.filename, integrity: pack.integrity, shasum: pack.shasum, version: metadata.version };
  report.cli = "version, help, strict protocol-2 evidence, receipt verification, public module import";
  if (process.env.PATCHPROVE_PACKAGE_REPORT) {
    const out = path.resolve(process.env.PATCHPROVE_PACKAGE_REPORT);
    await mkdir(path.dirname(out), { recursive: true }); await writeFile(out, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(temp, { recursive: true, force: true }); }
