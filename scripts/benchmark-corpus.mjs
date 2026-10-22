#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../dist/exec.js";
import { buildImpact } from "../dist/evidence.js";
import { collectGitSnapshot } from "../dist/git.js";
import { buildImportGraph } from "../dist/graph.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.resolve(process.argv.find((arg) => arg.startsWith("--manifest="))?.slice(11) ?? path.join(root, "test/fixtures/corpus/manifest.json"));
const manifestDir = path.dirname(manifestPath);
const manifestText = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(manifestText);
assert.equal(manifest.schemaVersion, 1);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), corpusKind: manifest.corpusKind, manifestHash: sha(manifestText), environment: { node: process.version, platform: process.platform, architecture: process.arch, network: false }, cases: [], limitations: ["The bundled corpus contains three seeded local patches; it is not a real-world 50-patch benchmark.", "Misses are full-suite failing test files absent from selection. Extra selections are selected test files that passed, not evidence that selection was unnecessary.", "Dynamic imports and resource dependencies can remain unmapped. Missing outcomes are unknown; no accuracy percentage is reported.", "Durations include local process and tool caches and are not speedup measurements. A fixture's network:false declaration is not enforced as a network sandbox for external code."] };
let failures = 0;
const commit = manifest.commit;
const commitEnv = commit ? { GIT_AUTHOR_NAME: commit.authorName, GIT_AUTHOR_EMAIL: commit.authorEmail, GIT_COMMITTER_NAME: commit.authorName, GIT_COMMITTER_EMAIL: commit.authorEmail, GIT_AUTHOR_DATE: commit.date, GIT_COMMITTER_DATE: commit.date } : {};
async function git(cwd, args, env = {}) {
  const result = await runCommand("git", ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], { cwd, timeoutMs: 30000, env });
  assert.equal(result.exitCode, 0, `git ${args.join(" ")}: ${result.stderr}`); return result.stdout.trim();
}
async function tests(cwd, paths) {
  const outcomes = [];
  for (const test of paths) {
    const result = await runCommand(process.execPath, ["--test", "--test-reporter=tap", test], { cwd, timeoutMs: 30000 });
    const count = /^# tests (\d+)$/m.exec(result.stdout);
    outcomes.push({ test, status: result.timedOut || result.aborted || !count || Number(count[1]) === 0 ? "unknown" : result.exitCode === 0 ? "passed" : "failed", exitCode: result.exitCode, durationMs: result.durationMs, outputHash: result.outputHash });
  }
  return { status: !outcomes.length ? "not-applicable" : outcomes.some((item) => item.status === "failed") ? "failed" : outcomes.some((item) => item.status === "unknown") ? "unknown" : "passed", durationMs: outcomes.reduce((sum, item) => sum + item.durationMs, 0), outcomes };
}
for (const item of manifest.cases) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "patchprove-corpus-"));
  try {
    assert.match(item.repository.baseCommit, /^(?:[a-f\d]{40}|[a-f\d]{64})$/, "Corpus requires an immutable repository commit");
    assert(item.license?.spdx && item.license?.path, "Corpus requires license metadata");
    await readFile(path.resolve(manifestDir, item.license.path));
    assert.equal(item.environment.runtime, "node", "This harness supports Node test exports; add a runner implementation before other runtimes");
    assert(Number(process.versions.node.split(".")[0]) >= item.environment.minimumMajor);
    assert.equal(item.environment.network, false, "Corpus runs must not request network access");
    if (item.repository.kind === "seed") {
      assert(commit, "Seed corpus requires fixed commit author/date metadata");
      await cp(path.resolve(manifestDir, item.repository.path), dir, { recursive: true });
      await git(dir, ["init", "--initial-branch=main"]);
      await git(dir, ["add", "."]);
      await git(dir, ["-c", `user.name=${commit.authorName}`, "-c", `user.email=${commit.authorEmail}`, "commit", "--no-verify", "--author", `${commit.authorName} <${commit.authorEmail}>`, "--date", commit.date, "-m", commit.message], commitEnv);
    } else {
      assert.equal(item.repository.kind, "local-checkout", "External repositories must be prepared locally; automatic clone/download is disabled");
      await git(root, ["clone", "--no-hardlinks", "--no-checkout", "--", path.resolve(manifestDir, item.repository.path), dir]);
      await git(dir, ["checkout", "--detach", item.repository.baseCommit]);
    }
    assert.equal(await git(dir, ["rev-parse", "HEAD"]), item.repository.baseCommit, "Repository commit differs from the manifest");
    const baseline = await tests(dir, item.tests);
    assert.equal(baseline.status, "passed", "Baseline suite must pass before applying the patch");
    const patchPath = path.resolve(manifestDir, item.patch);
    assert.equal(sha(await readFile(patchPath)), item.patchHash, "Patch digest differs from the manifest");
    await git(dir, ["apply", "--check", patchPath]); await git(dir, ["apply", patchPath]);
    const snapshot = await collectGitSnapshot(dir, {});
    const existing = new Set(snapshot.trackedFiles);
    const impact = buildImpact(snapshot.files, existing, { graph: buildImportGraph(dir, existing) });
    const selectedPaths = [...new Set(impact.mappedTests.flatMap((mapping) => mapping.tests))].sort();
    const selected = await tests(dir, selectedPaths);
    const full = await tests(dir, item.tests);
    const fullFailed = full.outcomes.filter((outcome) => outcome.status === "failed").map((outcome) => outcome.test);
    const misses = fullFailed.filter((test) => !selectedPaths.includes(test));
    const extra = selectedPaths.filter((test) => full.outcomes.some((outcome) => outcome.test === test && outcome.status === "passed"));
    const unknown = [...new Set([...full.outcomes, ...selected.outcomes].filter((outcome) => outcome.status === "unknown").map((outcome) => outcome.test))];
    report.cases.push({ id: item.id, repositoryCommit: item.repository.baseCommit, patchHash: item.patchHash, license: item.license, environment: item.environment, baseline, selected, full, selectedTests: selectedPaths, misses, extra, unknown, unmappedSources: impact.unmappedSources, mappingEvidence: impact.mappingEvidence ?? [], diagnostics: impact.mappingDiagnostics ?? [] });
    console.log(`${item.id}: selected=${selected.status} full=${full.status} misses=${misses.length} extra=${extra.length} unknown=${unknown.length}`);
    // Measured misses belong in the report. Infrastructure failures fail the harness.
    if (unknown.length) failures++;
  } catch (error) { failures++; report.cases.push({ id: item.id, error: String(error) }); console.error(`${item.id}: ${error}`); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
const out = process.env.PATCHPROVE_CORPUS_REPORT ?? path.join(os.tmpdir(), "patchprove-corpus-report.json");
await mkdir(path.dirname(out), { recursive: true }); await writeFile(out, JSON.stringify(report, null, 2) + "\n");
console.log(`Corpus report: ${out}`); process.exitCode = failures ? 1 : 0;
