#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

export const HOST_SCENARIOS = ["success", "failure", "incomplete", "cancel", "reentry", "workspaces", "special-paths", "existing-config", "mcp"];
export const GITHUB_SCENARIOS = ["passed", "failed", "incomplete", "missing-artifact", "wrong-digest", "wrong-head", "cancelled-run", "old-success-new-failure", "rerun-attempt", "pagination-spoofed-author", "denied-permissions"];
export const WINDOWS_SCENARIOS = ["native-matrix", "installed-success", "installed-assertion-failure", "installed-multimodule"];
export const CI_JOBS = [
  ...["ubuntu-latest", "macos-latest", "windows-latest"].flatMap((os) => [22, 24].map((node) => `${os} / Node ${node}`)),
  ...["ubuntu-latest", "macos-latest", "windows-latest"].map((os) => `Real runtime fixtures / ${os}`),
  "Resource budgets and pinned upstream contracts", "Go thin launcher", "Read-only PR evidence",
];
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const candidateKeys = ["commit", "tree", "runtimeDigest", "tarballSha256"];
function archiveDigest(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 64 * 1024 * 1024) throw new Error("candidate archive must be a regular file at most 64 MiB");
  const bytes = readFileSync(file);
  if (bytes.length !== stat.size) throw new Error("candidate archive changed while reading");
  return sha256(bytes);
}

/** Compare the package's executable inputs to the measured local build without extracting files. */
export function verifyPackagedRuntime(archive, inputs) {
  if (!Buffer.isBuffer(archive) || archive.length > 64 * 1024 * 1024) throw new Error("candidate archive exceeds the compressed input budget");
  const tar = gunzipSync(archive, { maxOutputLength: 64 * 1024 * 1024 });
  const expected = new Map(inputs.filter((input) => input.path !== "package-lock.json").map((input) => [`package/${input.path}`, input.sha256]));
  if (expected.size < 1) throw new Error("measured runtime inputs required");
  const found = new Set();
  const seen = new Set();
  const string = (bytes) => bytes.toString("utf8").split("\0", 1)[0];
  const octal = (bytes) => { const value = string(bytes).trim(); if (!/^[0-7]+$/.test(value)) throw new Error("invalid archive numeric header"); return Number.parseInt(value, 8); };
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const checksum = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (octal(header.subarray(148, 156)) !== checksum) throw new Error("archive header checksum differs");
    const size = octal(header.subarray(124, 136));
    const prefix = string(header.subarray(345, 500));
    const name = `${prefix ? `${prefix}/` : ""}${string(header.subarray(0, 100))}`;
    if (!name.startsWith("package/") || name.split("/").some((part) => part === "..") || name.includes("\\") || seen.has(name)) throw new Error("unsafe or duplicate archive member");
    seen.add(name);
    if (seen.size > 4096) throw new Error("archive member budget exceeded");
    const type = header[156];
    if (![0, 48, 53].includes(type)) throw new Error("only regular files and directories are accepted in candidate package");
    const start = offset + 512;
    const end = start + size;
    if (!Number.isSafeInteger(size) || end > tar.length) throw new Error("truncated archive member");
    if (expected.has(name)) {
      if (type === 53 || sha256(tar.subarray(start, end)) !== expected.get(name)) throw new Error(`packaged runtime differs: ${name}`);
      found.add(name);
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  for (const name of expected.keys()) if (!found.has(name)) throw new Error(`packaged runtime input missing: ${name}`);
  return { inputsMatched: found.size };
}

export function requiredAcceptanceCases() {
  return [
    ...["claude-code", "cursor"].flatMap((host) => HOST_SCENARIOS.map((scenario) => ({ id: `host:${host}:${scenario}`, kind: "host", host, scenario }))),
    ...["same-repository", "fork"].flatMap((repository) => GITHUB_SCENARIOS.map((scenario) => ({ id: `github:${repository}:${scenario}`, kind: "github", repository, scenario }))),
    ...WINDOWS_SCENARIOS.map((scenario) => ({ id: `windows:${scenario}`, kind: "windows", scenario })),
  ];
}

/** Check local acceptance records, not the honesty of their producer. Never execute evidence. */
export function verifyAcceptance(ledger, { directory, expected, tarballPath } = {}) {
  const errors = [];
  const cases = [];
  const fail = (location, reason) => errors.push(`${location}: ${reason}`);
  if (!object(ledger) || ledger.schemaVersion !== 1) return { passed: false, errors: ["ledger: unsupported acceptance schema"], cases };
  if (!object(expected) || !candidateKeys.every((key) => text(expected[key]))) return { passed: false, errors: ["expected candidate must be independently supplied"], cases };
  if (!COMMIT.test(expected.commit) || !COMMIT.test(expected.tree) || !SHA256.test(expected.runtimeDigest) || !SHA256.test(expected.tarballSha256)) fail("expected", "invalid candidate digest");
  const candidateMatches = (candidate) => object(candidate) && candidateKeys.every((key) => candidate[key] === expected[key]);
  if (!candidateMatches(ledger.candidate)) fail("candidate", "commit/tree/runtime/tarball does not match the current candidate");
  if (ledger.candidate?.workingTreeDirty !== false) fail("candidate", "dirty or unspecified source cannot establish release acceptance");
  if (!text(ledger.generatedAt) || !Number.isFinite(Date.parse(ledger.generatedAt))) fail("generatedAt", "valid timestamp required");
  if (!object(ledger.ci) || ledger.ci.head !== expected.commit || ledger.ci.conclusion !== "success" || !Number.isSafeInteger(ledger.ci.runId) || ledger.ci.runId < 1 || !Number.isSafeInteger(ledger.ci.attempt) || ledger.ci.attempt < 1) fail("ci", "successful current-head run and attempt required");
  const runUrl = (value) => typeof value === "string" && /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+(?:\/[\w/-]+)?$/.test(value);
  if (!runUrl(ledger.ci?.url) || !ledger.ci.url.includes(`/runs/${ledger.ci.runId}`)) fail("ci.url", "run URL must identify the recorded run");
  const jobs = Array.isArray(ledger.ci?.jobs) ? ledger.ci.jobs : [];
  if (jobs.length > 128) return { passed: false, errors: ["ci.jobs: at most 128 jobs may be recorded"], cases };
  for (const job of jobs) if (!object(job) || job.status !== "completed" || job.conclusion !== "success") fail("ci.jobs", "every recorded current-head job must complete successfully");
  for (const name of CI_JOBS) {
    const matches = jobs.filter((job) => object(job) && job.name === name);
    if (matches.length !== 1 || matches[0].status !== "completed" || matches[0].conclusion !== "success") fail(`ci.jobs/${name}`, "one completed successful job required; skipped/cancelled/pending are not success");
  }
  const root = directory ? path.resolve(directory) : null;
  const checkedFiles = new Set();
  const checkedLogs = new Map();
  let logBytes = 0;
  function verifyLog(ref, location) {
    if (!object(ref) || !text(ref.path) || !SHA256.test(ref.sha256 ?? "") || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > 16 * 1024 * 1024) { fail(location, "bounded log path, byte count and SHA-256 required"); return; }
    if (!root) { fail(location, "evidence directory required"); return; }
    const previous = checkedLogs.get(ref.path);
    if (previous) { if (previous.sha256 !== ref.sha256 || previous.bytes !== ref.bytes) fail(location, "conflicting log references"); return; }
    logBytes += ref.bytes;
    if (logBytes > 64 * 1024 * 1024) { fail(location, "raw logs exceed the 64 MiB aggregate budget"); return; }
    const parts = ref.path.split(/[\\/]/);
    if (path.isAbsolute(ref.path) || /^[a-z]:/i.test(ref.path) || parts.some((part) => part === ".." || !part)) { fail(location, "log must stay in the evidence directory"); return; }
    try {
      let file = root;
      for (const part of parts) { file = path.join(file, part); if (lstatSync(file).isSymbolicLink()) throw new Error("symbolic links are not accepted"); }
      const actualRoot = realpathSync(root);
      const relative = path.relative(actualRoot, realpathSync(file));
      if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("log escapes evidence directory");
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size !== ref.bytes || stat.size > 16 * 1024 * 1024) throw new Error("log size/type differs");
      const bytes = readFileSync(file);
      if (bytes.length !== ref.bytes || sha256(bytes) !== ref.sha256) throw new Error("log digest differs");
      checkedFiles.add(ref.path);
      checkedLogs.set(ref.path, { sha256: ref.sha256, bytes: ref.bytes });
    } catch (error) { fail(location, error instanceof Error ? error.message : String(error)); }
  }
  verifyLog(ledger.ci?.log, "ci.log");
  if (tarballPath) {
    try { if (archiveDigest(tarballPath) !== expected.tarballSha256) fail("tarball", "archive digest differs"); }
    catch (error) { fail("tarball", error instanceof Error ? error.message : String(error)); }
  } else fail("tarball", "the actual candidate archive is required");
  const records = Array.isArray(ledger.records) ? ledger.records : [];
  if (records.length > requiredAcceptanceCases().length) return { passed: false, errors: ["records: more than 44 live scenarios supplied"], cases };
  const allowed = new Set(requiredAcceptanceCases().map((item) => item.id));
  for (const record of records) if (!object(record) || !allowed.has(record.id)) fail("records", "unknown or invalid scenario identity");
  for (const required of requiredAcceptanceCases()) {
    const matches = records.filter((record) => object(record) && record.id === required.id);
    const before = errors.length;
    if (matches.length !== 1) fail(required.id, "exactly one acceptance record required");
    else {
      const record = matches[0];
      if (record.status !== "passed") fail(required.id, `acceptance status is ${String(record.status)}; all scenarios must pass`);
      if (!candidateMatches(record.candidate)) fail(required.id, "record belongs to a different candidate");
      if (!text(record.expected) || !text(record.observed)) fail(required.id, "specific expected and observed behavior required");
      if (record.method !== "live") fail(required.id, "fixtures/stdio substitutes do not establish live acceptance");
      verifyLog(record.log, `${required.id}.log`);
      if (required.kind === "host") {
        if (!object(record.host) || record.host.name !== required.host || !text(record.host.version) || !text(record.platform) || !text(record.nodeVersion)) fail(required.id, "actual host, OS and Node versions required");
        if (required.scenario === "failure" && (record.verification !== "failed" || record.hostAction !== (required.host === "claude-code" ? "blocked" : "advised"))) fail(required.id, "failure must retain failed verification and the host-specific action");
        if (required.scenario === "incomplete" && (record.verification !== "incomplete" || record.hostAction !== (required.host === "claude-code" ? "blocked" : "advised"))) fail(required.id, "missing execution must remain incomplete with the host-specific action");
        if (required.scenario === "success" && record.verification !== "passed") fail(required.id, "successful host case must retain passed verification");
        if (required.scenario === "cancel" && record.orphanProcesses !== 0) fail(required.id, "cancellation must establish zero orphan processes");
      } else if (required.kind === "github") {
        if (!runUrl(record.runUrl) || !Number.isSafeInteger(record.attempt) || record.attempt < 1 || !text(record.repository)) fail(required.id, "actual workflow run URL, attempt and repository required");
        if (!text(record.headRepository) || (required.repository === "fork" ? record.headRepository === record.repository : record.headRepository !== record.repository)) fail(required.id, "head/base repository relationship does not establish the required same-repository or fork case");
        if (!Number.isInteger(record.originalExitCode) || ![0, 1, 2].includes(record.originalExitCode) || record.preservedExitCode !== record.originalExitCode) fail(required.id, "publisher must preserve the original verification exit");
        if (["passed", "failed", "incomplete"].includes(required.scenario) && record.verification !== required.scenario) fail(required.id, "publication must preserve the verification decision");
        if (["passed", "failed", "incomplete"].includes(required.scenario) && record.originalExitCode !== (required.scenario === "passed" ? 0 : 1)) fail(required.id, "strict verification exit must match the recorded decision");
        if (["passed", "failed", "incomplete", "old-success-new-failure", "rerun-attempt"].includes(required.scenario) && !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+#issuecomment-\d+$/.test(record.commentUrl ?? "")) fail(required.id, "the actual resulting PR comment URL is required");
        if (["missing-artifact", "wrong-digest", "wrong-head", "cancelled-run", "denied-permissions"].includes(required.scenario) && record.staleOrUnverifiedCommentPublished !== false) fail(required.id, "rejected publication must establish no stale or unverified comment");
      } else {
        if (record.platform !== "win32" || !object(record.tools) || !text(record.tools.java) || !text(record.tools.gradle)) fail(required.id, "actual Windows Gradle/JVM versions required");
        if (record.nonAsciiPath !== true || record.spaceInPath !== true) fail(required.id, "original space/non-ASCII path conditions must remain exercised");
        if (!Number.isInteger(record.executedAssertions) || record.executedAssertions < 1 || record.infrastructureErrors !== 0) fail(required.id, "real assertions must execute without infrastructure errors");
        if (required.scenario === "native-matrix") {
          if (record.casesPassed !== 30 || record.casesFailed !== 0 || record.casesSkipped !== 0) fail(required.id, "all 30 native fixture scenarios must pass without skips");
        } else if (required.scenario === "installed-assertion-failure") {
          if (!Number.isInteger(record.failedAssertions) || record.failedAssertions < 1 || record.verification !== "failed") fail(required.id, "negative case must fail an actual assertion");
        } else if (record.failedAssertions !== 0 || record.verification !== "passed") fail(required.id, "normal/multi-module cases must complete passed without failed assertions");
      }
    }
    cases.push({ id: required.id, status: errors.length === before ? "passed" : matches[0]?.status === "passed" ? "invalid" : matches[0]?.status ?? "not-run" });
  }
  return { passed: errors.length === 0, errors, cases, checkedFiles: [...checkedFiles].sort() };
}

export function acceptanceTemplate(candidate) {
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), candidate,
    ci: { head: candidate.commit, runId: null, attempt: null, url: null, conclusion: "not-run", jobs: [], log: null },
    records: requiredAcceptanceCases().map(({ id }) => ({ id, candidate, status: "not-run", method: "not-run", expected: "", observed: "No live run retained for this candidate", log: null })) };
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  if (args.includes("--help")) {
    console.log("node scripts/check-acceptance.mjs --ledger FILE --tarball FILE [--matrix]\nnode scripts/check-acceptance.mjs --template --tarball FILE\nAll live scenarios and current-head CI must pass. Records are data and are never executed."); return;
  }
  const { validationIdentity } = await import("./validation-identity.mjs");
  const identity = validationIdentity(import.meta.url);
  const tarballPath = value("--tarball") ?? process.env.PATCHPROVE_ACCEPTANCE_TARBALL;
  if (!tarballPath) throw new Error("--tarball requires the actual candidate archive");
  const expected = { commit: identity.sourceCommit, tree: identity.sourceTree, runtimeDigest: identity.runtimeDigest, tarballSha256: archiveDigest(tarballPath) };
  verifyPackagedRuntime(readFileSync(tarballPath), identity.inputs);
  if (args.includes("--template")) { console.log(JSON.stringify(acceptanceTemplate({ ...expected, workingTreeDirty: identity.workingTreeDirty }), null, 2)); return; }
  const ledgerPath = value("--ledger") ?? process.env.PATCHPROVE_ACCEPTANCE_LEDGER;
  if (!ledgerPath) throw new Error("--ledger is required");
  const stat = lstatSync(ledgerPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error("ledger must be a regular JSON file at most 4 MiB");
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const result = verifyAcceptance(ledger, { directory: path.dirname(path.resolve(ledgerPath)), expected, tarballPath });
  if (identity.workingTreeDirty) { result.passed = false; result.errors.unshift("checkout: release acceptance requires a clean source checkout"); }
  if (args.includes("--matrix")) {
    console.log("| Scenario | Recorded status |\n| --- | --- |");
    for (const record of result.cases) console.log(`| ${record.id} | ${record.status} |`);
  } else console.log(JSON.stringify({ candidate: expected, ...result }, null, 2));
  if (!result.passed) { for (const error of result.errors) console.error(error); process.exitCode = 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; });
}
