#!/usr/bin/env node
import { validationIdentity } from "./validation-identity.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { runCommand } from "../dist/exec.js";
import { detectTools } from "../dist/detect.js";
import { collectGitSnapshot } from "../dist/git.js";
import { buildImportGraph } from "../dist/graph.js";
import { buildImpact } from "../dist/evidence.js";
import { runAffectedTests } from "../dist/gates.js";
import { builtinPlugins } from "../dist/plugins/index.js";
import { testExecutionUnits } from "../dist/execution-units.js";
import { withInputBudget } from "../dist/input-budget.js";
import { withMachineReportArchive } from "../dist/report-archive.js";

const manifestPath = process.argv.find((arg) => arg.startsWith("--manifest="))?.slice(11);
assert(manifestPath, "Supply --manifest=<local fixed-project manifest>; this command never clones projects or installs dependencies");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert.equal(manifest.schemaVersion, 1);
const output = path.resolve(process.env.PATCHPROVE_PROJECT_REPORT ?? "project-corpus-report.json");
const artifacts = `${output}.data`; await mkdir(artifacts, { recursive: true });
const digest = (value) => createHash("sha256").update(value).digest("hex");
const report = { identity: validationIdentity(import.meta.url), schemaVersion: 1, generatedAt: new Date().toISOString(), node: process.version, platform: process.platform,
  manifestHash: digest(await readFile(manifestPath)), projects: [],
  limitations: ["Controlled source mutations and neutral controls in pinned real projects; not historical production patches.", "Native full-suite discovery is independent of patchprove's selected files. Infrastructure failures or missing attribution are unknown, never successful detection.", "Go package and Rust crate granularity cannot establish file-level recall. Counts of selected passing units are an execution-cost proxy, not proof those units were unnecessary.", "Single-host timings include warm tool/dependency caches. No speedup, zero-miss, or population accuracy claim is justified."] };
async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && ![".git", "node_modules", ".gradle"].includes(entry.name)) files.push(...await walk(file));
    else if (entry.isFile() && /^TEST-.*\.xml$/.test(entry.name)) files.push(file);
  }
  return files;
}
function attr(text, name) { return new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`).exec(text)?.slice(1).find((value) => value !== undefined); }
async function truth(project, result, machine) {
  const passed = new Set(), failed = new Set(); let cases = 0, skipped = 0, unknown = null;
  if (result.timedOut || result.aborted || result.truncated) unknown = "Incomplete native command/output";
  else if (project.engine === "node") {
    const data = JSON.parse(await readFile(machine, "utf8"));
    for (const suite of data.testResults ?? []) for (const test of suite.assertionResults ?? []) {
      const unit = path.relative(project.cwd, suite.name).split(path.sep).join("/"); cases++;
      if (test.status === "failed") failed.add(unit); else if (test.status === "passed") passed.add(unit); else skipped++;
    }
  } else if (project.engine === "go") {
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      const event = JSON.parse(line), unit = `package:${event.Package === project.module ? "." : event.Package?.slice(project.module.length + 1)}`;
      if (event.Test && ["pass", "fail", "skip"].includes(event.Action)) { cases++; if (event.Action === "fail") failed.add(unit); else if (event.Action === "pass") passed.add(unit); else skipped++; }
    }
  } else if (project.engine === "cargo") {
    const summaries = [...`${result.stdout}\n${result.stderr}`.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
    for (const match of summaries) { const [p, f, s] = match.slice(1).map(Number); cases += p + f + s; skipped += s; if (p) passed.add("crate:."); if (f) failed.add("crate:."); }
  } else {
    const files = project.engine === "python" ? [machine] : await walk(path.join(project.cwd, "target/surefire-reports"));
    for (const file of files) {
      const xml = await readFile(file, "utf8");
      for (const entry of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase\s*>)/g)) {
        let unit = project.engine === "python" ? attr(entry[1], "file") : `src/test/java/${attr(entry[1], "classname")?.split("$")[0]?.replaceAll(".", "/")}.java`;
        if (project.engine === "python") {
          const parts = (attr(entry[1], "classname") ?? "").split(".");
          while (parts.length) { const candidate = `${parts.join("/")}.py`; if (existsSync(path.join(project.cwd, candidate))) { unit = candidate; break; } parts.pop(); }
        }
        if (!unit || unit.includes("undefined")) { unknown = "Full report lacks test-file attribution"; continue; }
        cases++; if (/<(?:failure|error)\b/.test(entry[2] ?? "")) failed.add(unit); else if (/<skipped\b/.test(entry[2] ?? "")) skipped++; else passed.add(unit);
      }
    }
  }
  if (!cases) unknown ??= "Native full suite established no test cases";
  if (result.exitCode !== 0 && !failed.size) unknown ??= "Native command failed without attributed test failures";
  return { cases, skipped, passedUnits: [...passed].sort(), failedUnits: [...failed].sort(), unknown };
}
for (const project of manifest.projects) {
  assert(/^[a-f0-9]{40,64}$/.test(project.commit) && project.url.startsWith("https://") && project.license && project.patches.length);
  const cwd = path.resolve(project.cwd);
  const command = (program, args) => runCommand(program, args, { cwd, env: project.env, timeoutMs: 240_000, maxOutputBytes: 16 * 1024 * 1024 });
  const head = await command("git", ["rev-parse", "HEAD"]); assert.equal(head.stdout.trim(), project.commit, `Wrong commit for ${project.id}`);
  const dirty = await command("git", ["diff", "--name-only", "HEAD", "--"]); assert.equal(dirty.stdout.trim(), "", "Tracked project inputs must be clean before measurement");
  const entry = { id: project.id, url: project.url, commit: project.commit, license: project.license,
    licenseHashes: await Promise.all(project.licenseFiles.map(async (file) => ({ path: file, sha256: digest(await readFile(path.join(cwd, file))) }))), setup: project.setup, cases: [] };
  report.projects.push(entry);
  const full = async (id) => {
    const machine = path.join(artifacts, `${project.id}-${id}.${project.engine === "node" ? "json" : "xml"}`);
    // Java must not reuse a previous invocation's XML.
    if (project.engine === "maven") { const { rm } = await import("node:fs/promises"); await rm(path.join(cwd, "target/surefire-reports"), { recursive: true, force: true }); }
    const args = project.full.args.map((arg) => arg.replaceAll("{report}", machine));
    const result = await command(project.full.command, args);
    const stdout = result.stdoutBytes ?? Buffer.from(result.stdout), stderr = result.stderrBytes ?? Buffer.from(result.stderr);
    await writeFile(path.join(artifacts, `${project.id}-${id}.log`), Buffer.concat([stdout, Buffer.from("\n"), stderr]), { mode: 0o600 });
    let observed;
    try { observed = await truth(project, result, machine); } catch (error) { observed = { failedUnits: [], passedUnits: [], cases: 0, skipped: 0, unknown: String(error) }; }
    const machineReports = [];
    for (const [stream, bytes] of [["stdout", stdout], ["stderr", stderr]]) {
      const relative = `${project.id}-${id}.${stream}.raw`;
      await writeFile(path.join(artifacts, relative), bytes, { mode: 0o600 });
      machineReports.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
    }
    if (project.engine === "maven") {
      const reports = await walk(path.join(cwd, "target/surefire-reports"));
      for (const file of reports) {
        const relative = `${project.id}-${id}-junit/${path.basename(file)}`;
        await mkdir(path.join(artifacts, `${project.id}-${id}-junit`), { recursive: true });
        await cp(file, path.join(artifacts, relative));
        machineReports.push({ path: relative, sha256: digest(await readFile(file)) });
      }
    } else if (["node", "python"].includes(project.engine) && existsSync(machine)) machineReports.push({ path: path.basename(machine), sha256: digest(await readFile(machine)) });
    return { command: project.full.command, args, exitCode: result.exitCode, durationMs: result.durationMs, outputHash: result.outputHash, machineReports, ...observed };
  };
  entry.baseline = await full("baseline");
  if (entry.baseline.exitCode !== 0 || entry.baseline.unknown) { entry.status = "unknown"; continue; }
  for (const patch of project.patches) {
    const file = path.resolve(cwd, patch.file); assert(file.startsWith(`${cwd}${path.sep}`));
    const original = await readFile(file, "utf8");
    const modified = patch.kind === "neutral" ? `${original}\n${project.engine === "python" ? "#" : "//"} corpus neutral source change\n` : original.replace(patch.before, patch.after);
    assert.notEqual(modified, original, `Mutation did not apply: ${project.id}/${patch.id}`);
    try {
      await writeFile(file, modified);
      const diff = await command("git", ["diff", "--", patch.file]);
      const patchArtifact = `${project.id}-${patch.id}.patch`; await writeFile(path.join(artifacts, patchArtifact), diff.stdout);
      const snapshot = await withInputBudget({ limits: project.inputLimits }, () => collectGitSnapshot(cwd, {}));
      const context = { cwd, existing: new Set(snapshot.trackedFiles) };
      const graph = buildImportGraph(cwd, context.existing, builtinPlugins, undefined, context);
      const impact = buildImpact(snapshot.files.filter((file) => file.path === patch.file), context.existing, { graph, pluginContext: context });
      const selected = [...new Set(impact.mappedTests.flatMap((item) => item.tests))].sort();
      const units = testExecutionUnits(selected, builtinPlugins, context).flatMap((unit) => unit.scope);
      // Environment is scoped to the child commands. detectTools/runAffectedTests need the same explicitly supplied tool PATH/PYTHONPATH.
      const previous = { ...process.env }; let result, selectedArchive;
      try {
        Object.assign(process.env, project.env);
        const selectedRun = await withMachineReportArchive(path.join(artifacts, `${project.id}-${patch.id}-selected`),
          () => runAffectedTests(cwd, detectTools(cwd), selected, true, builtinPlugins, context, { timeoutMs: 240_000, maxOutputBytes: 16 * 1024 * 1024 }));
        result = selectedRun.result; selectedArchive = selectedRun.archive;
      }
      finally { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); }
      const native = await full(patch.id);
      const unknown = native.unknown ?? (result.records?.some((record) => record.testExecution?.reportStatus === "missing" || record.testExecution?.reportStatus === "invalid") ? "Selected execution report unusable" : null);
      const missed = unknown ? null : native.failedUnits.filter((unit) => !units.includes(unit));
      const detected = unknown ? null : native.failedUnits.filter((unit) => units.includes(unit));
      const executedUnits = [...new Set(result.records?.flatMap((record) => record.testExecution?.executedScope ?? []) ?? [])];
      entry.cases.push({ id: patch.id, kind: patch.kind, attribution: patch.attribution, snapshot: snapshot.identity, inputLimits: project.inputLimits, patchArtifact, patchSha256: digest(diff.stdout),
        selection: { files: selected, units, diagnostics: impact.mappingDiagnostics, execution: result, reportArchive: selectedArchive }, full: native, unknown,
        metrics: { missedFailingUnits: missed, selectedFailingUnits: detected, unverifiedFailingUnits: unknown ? null : native.failedUnits.filter((unit) => !executedUnits.includes(unit)),
          neutralBlockedDespiteNativeSuccess: patch.kind === "neutral" && native.exitCode === 0 && result.status !== "passed",
          unknownRequestedScopes: [...new Set(result.records?.flatMap((record) => record.testExecution?.unknownScope ?? []) ?? [])],
          skippedCases: result.records?.reduce((sum, record) => sum + (record.testExecution?.counts.skipped ?? 0), 0) ?? 0,
          selectedPassingUnits: unknown ? null : native.passedUnits.filter((unit) => units.includes(unit)) } });
      console.log(`${project.id}/${patch.id}: ${unknown ? "unknown" : `${native.failedUnits.length} failing native units; ${missed.length} missed`} · selected ${result.status}`);
      await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    } finally { await writeFile(file, original); }
  }
  entry.status = entry.cases.every((item) => !item.unknown) ? "measured" : "partial";
}
const cases = report.projects.flatMap((project) => project.cases);
report.denominators = { projects: report.projects.length, baselineUnknown: report.projects.filter((project) => project.status === "unknown").length,
  patches: cases.length, unknownPatches: cases.filter((item) => item.unknown).length, patchesWithAttributedFailures: cases.filter((item) => !item.unknown && item.full.failedUnits.length).length,
  observedFailingUnits: cases.filter((item) => !item.unknown).reduce((count, item) => count + item.full.failedUnits.length, 0),
  missedFailingUnits: cases.filter((item) => !item.unknown).reduce((count, item) => count + item.metrics.missedFailingUnits.length, 0) };
report.denominators.neutralBlockedDespiteNativeSuccess = cases.filter((item) => item.metrics.neutralBlockedDespiteNativeSuccess).length;
report.denominators.unverifiedFailingUnits = cases.filter((item) => !item.unknown).reduce((count, item) => count + item.metrics.unverifiedFailingUnits.length, 0);
report.denominators.requestedUnits = cases.reduce((count, item) => count + item.selection.units.length, 0);
report.denominators.unknownRequestedUnits = cases.reduce((count, item) => count + item.metrics.unknownRequestedScopes.length, 0);
await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Real-project corpus: ${output}`);
process.exitCode = report.denominators.baselineUnknown || report.denominators.unknownPatches || report.denominators.missedFailingUnits ? 1 : 0;
