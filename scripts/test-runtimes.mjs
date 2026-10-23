#!/usr/bin/env node
import { validationIdentity } from "./validation-identity.mjs";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand, whichSync } from "../dist/exec.js";
import { collectedTestCount, runAffectedTests } from "../dist/gates.js";
import { builtinPlugins } from "../dist/plugins/index.js";
import { emptyDetectedTools } from "../dist/types.js";
import { detectTools } from "../dist/detect.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(root, "test/fixtures/runtimes");
const manifest = JSON.parse(await readFile(path.join(fixtures, "manifest.json"), "utf8"));
const requested = process.argv.find((arg) => arg.startsWith("--engine="))?.slice(9);
const required = process.argv.includes("--require");
const engines = requested ? requested.split(",") : ["node", "python", "go", "cargo", "maven", "gradle"];
for (const engine of engines) assert(manifest.cases.some((item) => item.engine === engine), `Unknown engine ${engine}`);
const probes = {
  node: { command: process.execPath, args: [path.join(root, "node_modules/vitest/vitest.mjs"), "--version"], pattern: /vitest\/\d/ },
  python: { command: whichSync("python") ?? whichSync("python3"), args: ["-m", "pytest", "--version"], pattern: /pytest \d/ },
  go: { command: whichSync("go"), args: ["version"], pattern: /^go version go\d/m },
  cargo: { command: whichSync("cargo"), args: ["--version"], pattern: /^cargo \d/m },
  maven: { command: whichSync("mvn"), args: ["--version"], pattern: /Apache Maven \d/ },
  gradle: { command: whichSync("gradle"), args: ["--version"], pattern: /^Gradle \d/m },
};
const report = { identity: validationIdentity(import.meta.url), schemaVersion: 1, generatedAt: new Date().toISOString(), node: process.version, platform: process.platform, toolchains: {}, cases: [], limitations: ["Minimal local fixtures exercise execution and collection behavior; they do not measure real-world mapping accuracy.", "Durations include local build/tool caches and are not speedup measurements."] };
let failures = 0;
async function filesIn(dir, prefix = "") {
  const files = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (["node_modules", "target", "build", ".gradle", "__pycache__", ".pytest_cache"].includes(item.name)) continue;
    const rel = prefix + item.name;
    if (item.isDirectory()) files.push(...await filesIn(path.join(dir, item.name), rel + "/")); else files.push(rel);
  }
  return files;
}
async function javaTestCount(dir) {
  let count = 0;
  async function walk(current) {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, item.name);
      if (item.isDirectory() && ![".git", ".gradle", "node_modules"].includes(item.name)) await walk(file);
      if (item.isFile() && /^TEST-.*\.xml$/.test(item.name)) {
        const xml = await readFile(file, "utf8");
        const match = /<testsuite\b[^>]*\btests="(\d+)"/.exec(xml);
        if (match) count += Number(match[1]);
      }
    }
  }
  await walk(dir); return count;
}
for (const engine of engines) {
  const probe = probes[engine];
  const version = probe.command ? await runCommand(probe.command, probe.args, { cwd: root, timeoutMs: 15000 }) : null;
  const versionOutput = `${version?.stdout ?? ""}\n${version?.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "");
  const available = version?.exitCode === 0 && probe.pattern.test(versionOutput);
  const versionLine = versionOutput.split("\n").find((line) => probe.pattern.test(line))?.trim();
  report.toolchains[engine] = { available, command: probe.command, version: available ? versionLine : null, reason: available ? null : "Missing toolchain or version identity did not match",
    probe: { args: probe.args, exitCode: version?.exitCode ?? null, stdout: version?.stdout.slice(0, 8192) ?? "", stderr: version?.stderr.slice(0, 8192) ?? "", timedOut: version?.timedOut ?? false, outputHash: version?.outputHash ?? null } };
  if (!available) {
    console.log(`SKIP ${engine}: missing toolchain or version identity did not match${required ? " (required: failure)" : ""}`);
    console.log(`PROBE ${engine}: ${JSON.stringify(report.toolchains[engine].probe)}`);
    if (required) failures++;
  }
  for (const item of manifest.cases.filter((entry) => entry.engine === engine)) {
    if (!available && item.scenario !== "missing") { report.cases.push({ id: item.id, outcome: "skipped", reason: report.toolchains[engine].reason }); continue; }
    // Maven compares selected project paths against canonical reactor basedirs.
    // Windows temp directories may use 8.3 aliases such as RUNNER~1.
    const requestedCwd = await mkdtemp(path.join(os.tmpdir(), "patchprove-runtime-"));
    const dir = realpathSync.native(requestedCwd);
    try {
      await cp(path.join(fixtures, item.path), dir, { recursive: true });
      if (engine === "node" && item.scenario !== "missing") await symlink(path.join(root, "node_modules"), path.join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      let tools = emptyDetectedTools();
      if (item.scenario === "missing") {
        const savedPath = process.env.PATH;
        try { process.env.PATH = ""; tools = detectTools(dir); }
        finally { if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath; }
      }
      let plugins = builtinPlugins;
      if (item.scenario !== "missing") {
        const field = { node: "vitest", python: "pytest", go: "go", cargo: "cargo", maven: "maven", gradle: "gradle" }[engine];
        tools[field] = true; tools[field + "Bin"] = probe.command;
        const versionName = { node: "vitest", python: "pytest", go: "go", cargo: "cargo", maven: "mvn", gradle: "gradle" }[engine];
        tools.versions = { [versionName]: versionOutput.trim().split("\n").find((line) => probe.pattern.test(line)) ?? versionOutput.trim() };
        // Run the installed JS entry with Node directly on every OS; no shell/.cmd inference.
        if (engine === "node") plugins = builtinPlugins.map((plugin) => plugin.id !== "javascript" ? plugin : { ...plugin, testCommand: (_cwd, tests) => ({ name: "affected tests (vitest)", command: process.execPath, args: [path.join(root, "node_modules/vitest/vitest.mjs"), "run", ...tests] }) });
      }
      const files = await filesIn(dir);
      const context = { cwd: dir, existing: new Set(files) };
      const selected = await runAffectedTests(dir, tools, item.tests, true, plugins, context, { timeoutMs: 180000, maxOutputBytes: 2 * 1024 * 1024 });
      assert.equal(selected.status, item.expected, `${item.id}: ${selected.reason}\n${selected.detail ?? ""}`);
      const selectedCount = ["maven", "gradle"].includes(engine) ? await javaTestCount(dir) : selected.records?.reduce((sum, record) => sum + (record.collectedTests ?? 0), 0);
      if (["success", "failure", "multimodule"].includes(item.scenario)) {
        assert(selected.records?.some((record) => record.command), `${item.id}: expected a real executed command`);
        assert(selectedCount > 0, `${item.id}: no executed test was established; infrastructure failures do not prove a failing test\n${selected.detail ?? ""}`);
      }
      if (item.scenario === "zero") assert(selected.records?.some((record) => record.collectedTests === 0) || /no tests?|no test suite|zero tests|0 (?:items?|tests?)/i.test(`${selected.reason}\n${selected.detail ?? ""}`), `${item.id}: expected explicit zero-collection evidence\n${selected.detail ?? ""}`);
      let full = null;
      if (item.scenario !== "missing") {
        const fullArgs = {
          node: [path.join(root, "node_modules/vitest/vitest.mjs"), "run"], python: ["-m", "pytest"],
          go: ["test", "-json", "./..."], cargo: ["test", "--workspace"], maven: ["test", "--batch-mode"],
          gradle: ["cleanTest", "test", "--console=plain", "--no-daemon"],
        }[engine];
        const raw = await runCommand(probe.command, fullArgs, { cwd: dir, timeoutMs: 180000, maxOutputBytes: 2 * 1024 * 1024 });
        const count = ["maven", "gradle"].includes(engine) ? await javaTestCount(dir) : collectedTestCount(`${raw.stdout}\n${raw.stderr}`);
        const status = raw.exitCode !== 0 || raw.timedOut ? "failed" : count === 0 ? "skipped" : "passed";
        assert.equal(status, item.fullExpected ?? item.expected, `${item.id}: full-suite result differs\n${raw.stdout}\n${raw.stderr}`);
        if (["success", "failure", "multimodule"].includes(item.scenario)) assert(count > 0, `${item.id}: full suite did not establish executed tests\n${raw.stdout}\n${raw.stderr}`);
        full = { status, command: raw.command, args: fullArgs, cwd: dir, exitCode: raw.exitCode, collectedTests: count ?? null, durationMs: raw.durationMs, outputHash: raw.outputHash };
      }
      report.cases.push({ id: item.id, requestedCwd, executionCwd: dir, outcome: "passed", expected: item.expected, selected: { status: selected.status, collectedTests: selectedCount ?? null, durationMs: selected.durationMs, records: selected.records }, full });
      console.log(`PASS ${item.id}: ${selected.status}`);
    } catch (error) {
      failures++; report.cases.push({ id: item.id, requestedCwd, executionCwd: dir, outcome: "failed", reason: String(error) }); console.error(`FAIL ${item.id}: ${error}`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
}
if (engines.some((engine) => ["maven", "gradle"].includes(engine))) {
  const java = whichSync("java");
  if (java) {
    const version = await runCommand(java, ["-version"], { cwd: root, timeoutMs: 15000 });
    report.toolchains.java = { available: version.exitCode === 0, command: java, version: `${version.stdout}\n${version.stderr}`.split("\n").find((line) => /\bversion "[\d.]+"/.test(line))?.trim() ?? null };
  }
}
const reportPath = process.env.PATCHPROVE_RUNTIME_REPORT ?? path.join(os.tmpdir(), "patchprove-runtime-report.json");
await mkdir(path.dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(`Runtime report: ${reportPath}`);
process.exitCode = failures ? 1 : 0;
