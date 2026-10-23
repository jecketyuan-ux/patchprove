#!/usr/bin/env node
import assert from "node:assert/strict";
import { lstatSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readEvidenceFile } from "../dist/mcp-tools.js";
import { readReceiptFile, verifyReceipt } from "../dist/receipt.js";
import { formatMarkdownReport } from "../dist/report.js";
import { verifyArtifactSet } from "../dist/artifacts.js";
import { withInputBudget } from "../dist/input-budget.js";
import { verifyReportArchive } from "../dist/report-archive.js";

// Called only by trusted default-branch code. Artifact content is data, never executable input.
const dir = path.resolve(process.argv[2] ?? "incoming");
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
assert.equal(event.workflow_run?.event, "pull_request");
assert.equal(event.workflow_run?.repository?.full_name ?? event.repository.full_name, event.repository.full_name);
assert(Number.isSafeInteger(event.workflow_run.pull_requests?.[0]?.number), "Workflow has no associated PR");
for (const file of ["evidence.json", "evidence.receipt.json", "evidence.json.manifest.json"]) {
  const stat = statSync(path.join(dir, file));
  assert(stat.isFile() && stat.size < 16 * 1024 * 1024, "Artifact file is absent or exceeds the allowed size");
}
const manifestPath = path.join(dir, "evidence.json.manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const allowedFiles = new Set(["evidence.json", "evidence.receipt.json", "patchprove.sarif"]);
// archiveMachineReport uses crypto.randomUUID(): constrain data to that exact
// producer layout rather than accepting arbitrary directory or member names.
const reportPath = /^machine-reports\/run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:[1-9]\d*\.(?:raw|json|xml|txt)|[1-9]\d*\.context\.json|manifest\.json|index\.json)$/;
assert(Array.isArray(manifest.artifacts) && manifest.artifacts.length <= 1024 && manifest.artifacts.every((item) => allowedFiles.has(item.path) || reportPath.test(item.path)), "Publisher manifest may reference only expected artifacts and bounded machine-report data");
let totalBytes = 0;
for (const item of manifest.artifacts) {
  const stat = lstatSync(path.join(dir, item.path));
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16 * 1024 * 1024, "Publisher artifact must be a bounded regular file");
  totalBytes += stat.size;
}
assert(totalBytes <= 64 * 1024 * 1024, "Publisher artifact set exceeds the trusted total-byte budget");
assert(manifest.artifacts.some((item) => item.path === "evidence.json") && manifest.artifacts.some((item) => item.path === "evidence.receipt.json"), "Publisher manifest must bind evidence and receipt");
const committed = verifyArtifactSet(manifestPath);
assert(committed.ok, committed.errors.join("; "));
// Trusted ceilings match the explicit self-review workflow; never accept a
// resource allowance declared by the downloaded artifact itself.
const [evidence, receipt] = withInputBudget({ limits: { maxJsonBytes: 16 * 1024 * 1024, maxJsonNodes: 2_000_000 } }, () => [
  readEvidenceFile(path.join(dir, "evidence.json")), readReceiptFile(path.join(dir, "evidence.receipt.json")),
]);
const verification = verifyReceipt(evidence, receipt, undefined, { allowLegacy: false });
assert(verification.ok, verification.message);
const reports = evidence.executionRecords?.flatMap((record) => record.testExecution?.reports ?? []) ?? [];
const referenced = new Map();
for (const report of reports) {
  assert(reportPath.test(report.path) && reportPath.test(report.contextPath), "Publisher requires portable report references under machine-reports");
  referenced.set(report.path, report.hash); referenced.set(report.contextPath, report.contextHash);
}
if (evidence.reportArchive) {
  assert(reportPath.test(evidence.reportArchive.manifestPath), "Publisher requires a portable archive manifest reference");
  referenced.set(evidence.reportArchive.manifestPath, evidence.reportArchive.manifestHash);
  const archiveDirectory = path.posix.dirname(evidence.reportArchive.manifestPath);
  const archiveManifest = JSON.parse(readFileSync(path.join(dir, evidence.reportArchive.manifestPath), "utf8"));
  const indexPath = `${archiveDirectory}/index.json`;
  const indexMember = archiveManifest.artifacts?.find((item) => item.path === "index.json");
  assert(indexMember, "Machine archive must bind its index");
  const index = JSON.parse(readFileSync(path.join(dir, indexPath), "utf8"));
  assert(index.schemaVersion === "1.0.0" && index.kind === "patchprove-machine-report-archive" && index.reportCount === new Set(reports.map((report) => report.path)).size, "Machine archive index does not match referenced reports");
  referenced.set(indexPath, indexMember.hash);
}
const members = new Map(manifest.artifacts.map((item) => [item.path, item.hash]));
for (const [file, hash] of referenced) assert.equal(members.get(file), hash, "Report reference is not bound by the verified outer manifest");
for (const item of manifest.artifacts.filter((item) => reportPath.test(item.path))) assert(referenced.has(item.path), "Publisher refuses unreferenced raw report data");
if (evidence.reportArchive || reports.length) {
  const replay = withInputBudget({ limits: { maxJsonBytes: 16 * 1024 * 1024, maxJsonNodes: 2_000_000 } }, () => verifyReportArchive(evidence, { artifactRoot: dir }));
  assert(replay.ok, replay.errors.join("; "));
}
assert.equal(evidence.snapshot?.head, event.workflow_run.head_sha, "Evidence does not belong to the workflow's PR head");
assert.equal(evidence.range.head, event.workflow_run.head_sha, "Evidence range does not match the workflow's PR head");
const markdown = formatMarkdownReport(evidence);
const maximum = 54_000;
const rendered = Buffer.byteLength(markdown) <= maximum ? markdown
  : `${Buffer.from(markdown).subarray(0, maximum).toString("utf8").replace(/\n[^\n]*$/, "")}\n\n</details>\n\n_Report abbreviated to fit the PR comment. Full evidence and receipt remain in workflow run ${event.workflow_run.id} artifacts._\n`;
writeFileSync(path.join(dir, "verified-comment.md"), rendered, { mode: 0o600 });
console.log(`Verified artifact for workflow run ${event.workflow_run.id}; receipt ${receipt.contentHash}; unsigned receipts establish integrity, not producer identity.`);
