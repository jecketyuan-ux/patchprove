import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { detectTools } from "./detect.js";
import {
  buildEvidence,
  buildImpact,
  collectGaps,
  failedCheckFindings,
  pathFindings,
} from "./evidence.js";
import { runAffectedTests, runLint, runSecretScan, runTypecheck } from "./gates.js";
import { collectGitSnapshot, type DiffFile } from "./git.js";
import { formatHumanReport, formatMarkdownReport } from "./report.js";
import { meetsFailOn } from "./risk.js";
import type { Evidence, RunOptions } from "./types.js";

export function hydrateUntrackedPatches(root: string, files: DiffFile[]): DiffFile[] {
  return files.map((file) => {
    if (file.patch || file.status === "deleted") return file;
    if (file.status !== "untracked" && file.status !== "added") return file;
    try {
      const content = readFileSync(path.join(root, file.path), "utf8");
      const lines = content.split("\n");
      const patch = [
        `diff --git a/${file.path} b/${file.path}`,
        "--- /dev/null",
        `+++ b/${file.path}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((l) => `+${l}`),
      ].join("\n");
      return { ...file, patch, additions: file.additions || lines.length };
    } catch {
      return file;
    }
  });
}

export async function analyze(options: RunOptions): Promise<Evidence> {
  const cwd = path.resolve(options.cwd);
  const snapshot = await collectGitSnapshot(cwd, {
    base: options.base,
    head: options.head,
  });
  const files = hydrateUntrackedPatches(snapshot.root, snapshot.files);
  const existing = new Set(snapshot.trackedFiles);
  const impact = buildImpact(files, existing);
  const tools = detectTools(snapshot.root);

  const mappedTestFiles = [...new Set(impact.mappedTests.flatMap((m) => m.tests))];

  const [typecheck, lint, tests, secretScan] = await Promise.all([
    runTypecheck(snapshot.root, tools),
    runLint(snapshot.root, tools),
    runAffectedTests(snapshot.root, tools, mappedTestFiles),
    runSecretScan(snapshot.root, tools, files, snapshot.range),
  ]);

  const checks = [typecheck, lint, tests, secretScan.check];
  const gaps = collectGaps(impact, checks, tools);
  const findings = [
    ...pathFindings(impact.changedFiles),
    ...secretScan.findings,
    ...failedCheckFindings(checks),
  ];

  return buildEvidence({
    cwd,
    root: snapshot.root,
    range: snapshot.range,
    impact,
    checks,
    gaps,
    findings,
  });
}

export function writeEvidence(outPath: string, evidence: Evidence): string {
  const resolved = path.resolve(outPath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return resolved;
}

export function render(evidence: Evidence, format: RunOptions["format"]): string {
  if (format === "json") return `${JSON.stringify(evidence, null, 2)}\n`;
  if (format === "markdown") return formatMarkdownReport(evidence);
  return formatHumanReport(evidence);
}

export async function executeRun(options: RunOptions): Promise<number> {
  try {
    const evidence = await analyze(options);
    const outFile = writeEvidence(options.out, evidence);
    const format = options.json ? "json" : options.format;
    const output = render(evidence, format);
    process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
    if (format !== "json") {
      process.stderr.write(`wrote ${outFile}\n`);
    }
    return meetsFailOn(evidence.summary.risk, options.failOn) ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`patchprove: ${message}\n`);
    return 2;
  }
}
