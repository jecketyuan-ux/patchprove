#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readEvidenceFile } from "../dist/mcp-tools.js";
import { readReceiptFile, verifyReceipt } from "../dist/receipt.js";
import { formatMarkdownReport } from "../dist/report.js";
import { verifyArtifactSet } from "../dist/artifacts.js";
import { withInputBudget } from "../dist/input-budget.js";

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
assert(Array.isArray(manifest.artifacts) && manifest.artifacts.every((item) => allowedFiles.has(item.path)), "Publisher manifest may reference only the expected artifact files");
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
assert.equal(evidence.snapshot?.head, event.workflow_run.head_sha, "Evidence does not belong to the workflow's PR head");
assert.equal(evidence.range.head, event.workflow_run.head_sha, "Evidence range does not match the workflow's PR head");
const markdown = formatMarkdownReport(evidence);
const maximum = 54_000;
const rendered = Buffer.byteLength(markdown) <= maximum ? markdown
  : `${Buffer.from(markdown).subarray(0, maximum).toString("utf8").replace(/\n[^\n]*$/, "")}\n\n</details>\n\n_Report abbreviated to fit the PR comment. Full evidence and receipt remain in workflow run ${event.workflow_run.id} artifacts._\n`;
writeFileSync(path.join(dir, "verified-comment.md"), rendered, { mode: 0o600 });
console.log(`Verified artifact for workflow run ${event.workflow_run.id}; receipt ${receipt.contentHash}; unsigned receipts establish integrity, not producer identity.`);
