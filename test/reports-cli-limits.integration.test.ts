import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { withReportArchive } from "../src/report-archive.js";
import { readTestReport } from "../src/test-results.js";
import type { Evidence, ExecutionRecord } from "../src/types.js";

it("replays a valid large report pack using the producer's explicit JSON budgets", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "patchprove-reports-cli-limits-"));
  try {
    writeFileSync(path.join(root, "value.test.js"), "export {};\n");
    const report = path.join(root, "report.json");
    writeFileSync(report, JSON.stringify({ testResults: [{ name: path.join(root, "value.test.js"), assertionResults: [{ status: "passed" }] }] }));
    const evidence = await withReportArchive(path.join(root, "reports"), async () => {
      const proof = readTestReport("vitest-json", report, root, ["value.test.js"]);
      const record: ExecutionRecord = { id: "tests:json-budget", checkId: "tests", scope: proof.executedScope, status: "passed", exitCode: 0,
        command: "fixture", args: [], cwd: root, durationMs: 1, testExecution: proof };
      const result: Evidence = JSON.parse(readFileSync(new URL("./fixtures/evidence-open-gaps.json", import.meta.url), "utf8"));
      result.executionRecords = [record];
      result.checks = [{ id: "tests", name: "tests", status: "passed", records: [record] }];
      Object.assign(result.summary, { checksPassed: 1, checksFailed: 0, checksSkipped: 0 });
      // Valid diagnostic data can exceed the default byte and structural budgets
      // without changing the single real archived report being independently replayed.
      result.diagnostics = Array.from({ length: 30_000 }, () => ({ code: "fixture-large-input", message: "bounded producer diagnostic ".repeat(12), severity: "warning" as const }));
      return result;
    });
    const file = path.join(root, "evidence.json");
    writeFileSync(file, JSON.stringify(evidence));
    rmSync(report);
    const verify = (args: string[]) => spawnSync(process.execPath, [path.resolve("dist/cli.js"), "reports", "verify", file, ...args], { encoding: "utf8", timeout: 30_000 });
    const defaultNodes = verify(["--max-json-bytes", "16777216"]);
    expect(defaultNodes.status).toBe(2);
    expect(defaultNodes.stderr).toMatch(/maxJsonNodes budget/);
    const explicit = verify(["--max-json-bytes", "16777216", "--max-json-nodes", "2000000", "--max-json-depth", "64"]);
    expect(explicit.status, explicit.stderr || explicit.stdout).toBe(0);
    expect(JSON.parse(explicit.stdout)).toEqual({ ok: true, reports: 1, errors: [] });
    const shallow = verify(["--max-json-bytes", "16777216", "--max-json-nodes", "2000000", "--max-json-depth", "3"]);
    expect(shallow.status).toBe(2);
    expect(shallow.stderr).toMatch(/maxJsonDepth budget/);
    const invalid = verify(["--max-json-depth", "0"]);
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toMatch(/maxJsonDepth must be a positive safe integer/);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
