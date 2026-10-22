#!/usr/bin/env node
/**
 * Reproduce audit observations against the reviewed 188e07e baseline.
 * Run npm run build, then run this script from any working directory.
 * Successful reproduction of a defect is not successful product validation.
 * All repository fixtures and synthetic keys live in a temporary directory.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const load = (name) => import(pathToFileURL(path.join(root, "dist", `${name}.js`)).href);
const [gitModule, secretsModule, runModule, receipts, evidenceModule, mcp, gates, types, coverageModule, baselineModule] = await Promise.all(
  ["git", "secrets", "run", "receipt", "evidence", "mcp-tools", "gates", "types", "coverage", "baseline"].map(load),
);
const temp = mkdtempSync(path.join(tmpdir(), "patchprove-audit-"));
const observations = [];
const synthetic = "AKIA" + "IOSFODNN7EXAMPLE";
const record = (id, scenario, expected, observed, reproduced) => observations.push({ id, scenario, expected, observed, reproduced });
function seed(name, files) {
  const cwd = path.join(temp, name);
  mkdirSync(cwd, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init");
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    writeFileSync(path.join(cwd, rel), content);
  }
  git("add", ".");
  git("-c", "user.email=audit@example.invalid", "-c", "user.name=Audit fixture", "commit", "-m", "seed");
  return { cwd, git };
}
const opts = (cwd) => ({ cwd, json: true, format: "json", out: path.join(temp, "unused.json"), disableGate: ["typecheck", "lint", "tests", "secrets"] });
const emptyImpact = { changedFiles: [], mappedTests: [], unmappedSources: [], languages: [], mappingStrategy: "naming" };
try {
  {
    const { cwd, git } = seed("mixed", { "src/foo.ts": "export const value = 1;\n" });
    writeFileSync(path.join(cwd, "src/foo.ts"), "export const value = 2;\n");
    git("add", "src/foo.ts");
    writeFileSync(path.join(cwd, "src/foo.ts"), `export const value = 2;\nexport const key = "${synthetic}";\n`);
    const snapshot = await gitModule.collectGitSnapshot(cwd, {});
    const observed = { fullDiffContainsSyntheticKey: git("diff", "HEAD").includes(synthetic), snapshotContainsSyntheticKey: snapshot.files.some((f) => f.patch.includes(synthetic)), secretFindings: secretsModule.scanSecrets(snapshot.files).length };
    record("F01", "staged snapshot overwrites working-tree additions", "the analyzed patch includes the unstaged synthetic key", observed, observed.fullDiffContainsSyntheticKey && !observed.snapshotContainsSyntheticKey && observed.secretFindings === 0);
  }
  {
    const tools = { ...types.emptyDetectedTools(), vitest: true, vitestBin: "/bin/true", pytest: true };
    const result = await gates.runAffectedTests(temp, tools, ["src/foo.test.ts", "test_foo.py"]);
    const observed = { status: result.status, command: result.command, missingPythonRunner: tools.pytestBin === null, runnerKind: "Linux /bin/true stub; tests aggregation only" };
    record("F02", "partial language execution is aggregated as passed", "missing Python execution is visible and prevents an overall passed result", observed, result.status === "passed" && !result.command.includes("pytest"));
  }
  let sample;
  {
    sample = evidenceModule.buildEvidence({ cwd: temp, root: temp, range: { mode: "working-tree", base: "HEAD", head: null }, impact: emptyImpact, checks: [{ id: "tests", name: "tests", status: "failed", exitCode: 1 }], gaps: [], findings: [{ id: "failure", kind: "check-failed", risk: "high", message: "tests failed" }], contract: { loaded: true, passed: false, source: null, format: "yaml", clauses: [] } });
    const evidencePath = path.join(temp, "failed-evidence.json");
    writeFileSync(evidencePath, JSON.stringify(sample));
    const result = await mcp.listGaps({ evidencePath });
    const observed = { claimDone: result.claimDone, checksFailed: sample.summary.checksFailed, contractPassed: sample.contract.passed, gapCount: result.gapCount };
    record("F03", "MCP completion ignores failed checks and contract", "claimDone is false", observed, result.claimDone && !sample.contract.passed && sample.summary.checksFailed === 1);
  }
  {
    const { cwd, git } = seed("identity", { "src/foo.ts": "export const value = 1;\n" });
    writeFileSync(path.join(cwd, "src/foo.ts"), "export const value = 2;\n");
    const first = await runModule.analyze(opts(cwd));
    writeFileSync(path.join(cwd, "src/foo.ts"), "export const value = 3;\n");
    const second = await runModule.analyze(opts(cwd));
    record("F04a", "distinct code contents share the same evidence hash", "patch identity distinguishes value=2 from value=3", { equalHash: receipts.hashEvidence(first) === receipts.hashEvidence(second), changedFiles: first.impact.changedFiles }, receipts.hashEvidence(first) === receipts.hashEvidence(second));
    git("add", ".");
    git("-c", "user.email=audit@example.invalid", "-c", "user.name=Audit fixture", "commit", "-m", "head-code");
    const head = git("rev-parse", "HEAD").trim();
    const base = git("rev-parse", "HEAD~1").trim();
    writeFileSync(path.join(cwd, "src/foo.ts"), "export const value = 9;\n");
    const result = await runModule.analyze({ ...opts(cwd), base, head });
    const observed = { claimedHead: result.range.head === head, actualWorkingTreeIsDirty: git("status", "--porcelain").trim().length > 0, analysisReturned: true };
    record("F04b", "range analysis accepts a dirty checkout distinct from requested head", "the mismatch is rejected or represented explicitly in evidence", observed, observed.claimedHead && observed.actualWorkingTreeIsDirty);
  }
  {
    const files = new Set(["src/foo.ts", "src/foo.test.ts", "test/integration.test.ts"]);
    const graph = { importers: new Map([["src/foo.ts", ["src/foo.test.ts", "test/integration.test.ts"]]]), imports: new Map(), edgeCount: 2 };
    const coverage = coverageModule.parseCoverageText(JSON.stringify({ "src/foo.ts": { path: "src/foo.ts", s: { "0": 1 } } }), temp, "json");
    const withoutCoverage = coverageModule.mapTestsForSource("src/foo.ts", files, null, graph);
    const withCoverage = coverageModule.mapTestsForSource("src/foo.ts", files, coverage, graph);
    record("F05", "coverage naming fallback suppresses graph-selected integration test", "a non-attributing coverage file does not remove a known graph dependency", { withoutCoverage, withCoverage }, withoutCoverage.tests.includes("test/integration.test.ts") && !withCoverage.tests.includes("test/integration.test.ts"));
  }
  for (const [id, scenario, file] of [["F06a", "test-only change", { path: "src/foo.test.ts", status: "modified" }], ["F06b", "source deletion", { path: "src/foo.ts", status: "deleted" }]]) {
    const impact = evidenceModule.buildImpact([{ ...file, additions: 0, deletions: 1, patch: "" }], new Set(["src/foo.ts", "src/foo.test.ts"]));
    const checks = [{ id: "tests", name: "tests", status: "skipped", reason: "No mapped tests for this diff" }];
    const gaps = evidenceModule.collectGaps(impact, checks, types.emptyDetectedTools());
    record(id, scenario, "select affected tests or explain the unsupported verification scope as a gap", { mappedTests: impact.mappedTests, unmappedSources: impact.unmappedSources, gaps }, impact.mappedTests.length === 0 && gaps.length === 0);
  }
  {
    const file = (p) => ({ path: p, status: "modified", additions: 1, deletions: 1, highRisk: true, riskKind: "auth-crypto" });
    const oldEvidence = { ...sample, findings: evidenceModule.pathFindings([file("src/auth/old.ts")]) };
    const newEvidence = { ...sample, findings: evidenceModule.pathFindings([file("src/auth/new.ts")]) };
    const result = baselineModule.compareToBaseline(newEvidence, oldEvidence, "baseline.json");
    record("F07", "baseline conflates different paths with the same sequential id", "one new finding and one resolved finding", { newFindings: result.newFindings.length, resolvedFindings: result.resolvedFindings.length }, result.newFindings.length === 0 && result.resolvedFindings.length === 0);
  }
  {
    const { cwd } = seed("unicode", { "src/中文.ts": "export const value = 1;\n" });
    writeFileSync(path.join(cwd, "src/中文.ts"), `export const key = "${synthetic}";\n`);
    const snapshot = await gitModule.collectGitSnapshot(cwd, {});
    const impact = evidenceModule.buildImpact(snapshot.files, new Set(snapshot.trackedFiles));
    const observed = { paths: snapshot.files.map((f) => f.path), languages: impact.languages, patchLengths: snapshot.files.map((f) => f.patch.length), secretFindings: secretsModule.scanSecrets(snapshot.files).length };
    record("F08", "Git C-quoted Unicode filename is not decoded", "src/中文.ts remains a valid TypeScript path with a scanned patch", observed, !observed.paths.includes("src/中文.ts") && observed.secretFindings === 0);
  }
  {
    const receipt = receipts.buildReceipt({ evidence: sample, exitCode: 1, failOnOutcome: { failed: true, reason: "contract" }, sign: true, signingKey: "hmac:audit-synthetic-key" });
    receipt.exitCode = 0;
    receipt.failOnOutcome = { failed: false, reason: "ok" };
    receipt.checks = [];
    const verified = receipts.verifyReceipt(sample, receipt, "hmac:audit-synthetic-key");
    record("F09", "receipt signature does not authenticate envelope metadata", "a future authenticated envelope rejects metadata tampering; current evidence-only hash limitation is explicit", { ok: verified.ok, signature: verified.signature, alteredFields: ["exitCode", "failOnOutcome", "checks"] }, verified.ok && verified.signature === "verified");
  }
  {
    const evidencePath = path.join(temp, "unknown-major.json");
    writeFileSync(evidencePath, JSON.stringify({ ...sample, schemaVersion: "99.0.0" }));
    let accepted = false;
    try { mcp.readEvidenceFile(evidencePath); accepted = true; } catch { /* Record rejection if code changed. */ }
    record("F10", "runtime evidence reader accepts an unsupported schema major", "unknown schema major is rejected", { accepted, schemaVersion: "99.0.0" }, accepted);
  }
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  console.log(JSON.stringify({ baselineCommit: commit, platform: process.platform, node: process.version, purpose: "Known-defect reproduction; not a passing product regression suite", observations, allReproduced: observations.every((x) => x.reproduced) }, null, 2));
  if (observations.some((x) => !x.reproduced)) process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
