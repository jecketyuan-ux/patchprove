import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { analyzeAndWrite } from "../src/run.js";
import { readReceiptFile, verifyReceipt } from "../src/receipt.js";
import { readEvidenceFile } from "../src/mcp-tools.js";
import { verifyReportArchive } from "../src/report-archive.js";

const roots: string[] = [];
const temporary = () => { const root = mkdtempSync(path.join(tmpdir(), "patchprove-report-integration-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
function write(root: string, file: string, value: string): void {
  const destination = path.join(root, file); mkdirSync(path.dirname(destination), { recursive: true }); writeFileSync(destination, value);
}

it("signs, moves and independently replays a real Vitest report, then rejects tampering", async () => {
  const root = temporary();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  write(root, ".gitignore", "node_modules\npack/\n");
  write(root, "package.json", JSON.stringify({ private: true, type: "module", devDependencies: { vitest: "4.1.12" } }));
  write(root, "vitest.config.mjs", "export default {test:{maxWorkers:1,fileParallelism:false}};\n");
  write(root, "src/value.js", "export const value=1;\n");
  write(root, "test/value.test.js", "import {test,expect} from 'vitest';import {value} from '../src/value.js';test('value',()=>expect(value).toBe(1));\n");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "healthy baseline");
  symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  write(root, "src/value.js", "export const value=1; // reviewed change\n");
  const pack = path.join(root, "pack");
  const key = "hmac:public-report-archive-fixture-key";
  process.env.PATCHPROVE_SIGNING_KEY = key;
  const { evidence, exitCode } = await analyzeAndWrite({ cwd: root, json: true, format: "json", out: path.join(pack, "evidence.json"),
    reportsDir: path.join(pack, "machine-reports"), receipt: path.join(pack, "evidence.receipt.json"), sign: true,
    timeoutMs: 20_000, disableGate: ["typecheck", "lint", "secrets"] });
  expect(exitCode, JSON.stringify({ verification: evidence.verification, gaps: evidence.gaps, checks: evidence.checks }, null, 2)).toBe(0);
  expect(evidence.verification?.status).toBe("passed");
  expect(path.isAbsolute(evidence.reportArchive!.manifestPath)).toBe(false);
  expect(verifyReportArchive(evidence, { artifactRoot: pack })).toEqual({ ok: true, reports: 1, errors: [] });
  const receipt = readReceiptFile(path.join(pack, "evidence.receipt.json"));
  expect(verifyReceipt(evidence, receipt, key, { requireSignature: true, allowLegacy: false }).ok).toBe(true);
  const moved = temporary();
  cpSync(pack, moved, { recursive: true });
  rmSync(root, { recursive: true, force: true });
  const movedEvidence = readEvidenceFile(path.join(moved, "evidence.json"));
  const originalBytes = readFileSync(path.join(moved, "evidence.json"));
  expect(verifyReportArchive(movedEvidence, { artifactRoot: moved })).toEqual({ ok: true, reports: 1, errors: [] });
  expect(verifyReceipt(movedEvidence, receipt, key, { requireSignature: true, allowLegacy: false }).ok).toBe(true);
  const cli = path.resolve("dist/cli.js");
  const good = spawnSync(process.execPath, [cli, "reports", "verify", path.join(moved, "evidence.json")], { encoding: "utf8" });
  expect(good.status, good.stderr || good.stdout).toBe(0);
  const raw = movedEvidence.executionRecords!.find(record => record.testExecution?.reports?.length)!.testExecution!.reports![0]!;
  expect(raw.path).toMatch(/^machine-reports\/run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/1\.raw$/);
  const eventPath = path.join(temporary(), "event.json");
  writeFileSync(eventPath, JSON.stringify({ repository: { full_name: "fixture/repo" }, workflow_run: {
    id: 1, event: "pull_request", head_sha: movedEvidence.range.head, pull_requests: [{ number: 1 }],
  } }));
  const published = spawnSync(process.execPath, [path.resolve("scripts/verify-publish.mjs"), moved], {
    encoding: "utf8", env: { ...process.env, GITHUB_EVENT_PATH: eventPath },
  });
  expect(published.status, published.stderr || published.stdout).toBe(0);
  expect(readFileSync(path.join(moved, "verified-comment.md"), "utf8")).toContain("<!-- patchprove-sticky -->");
  writeFileSync(path.resolve(moved, raw.path), "{}");
  const bad = spawnSync(process.execPath, [cli, "reports", "verify", path.join(moved, "evidence.json")], { encoding: "utf8" });
  expect(bad.status).toBe(1);
  expect(readFileSync(path.join(moved, "evidence.json"))).toEqual(originalBytes);
}, 30_000);
