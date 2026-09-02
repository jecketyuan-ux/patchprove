import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveConfig } from "./config.js";
import { loadCoverageMap } from "./coverage.js";
import { detectTools } from "./detect.js";
import {
  buildEvidence,
  buildImpact,
  collectGaps,
  failedCheckFindings,
  filterIgnored,
  pathFindings,
} from "./evidence.js";
import { runAffectedTests, runLint, runSecretScan, runTypecheck } from "./gates.js";
import { collectGitSnapshot, type DiffFile } from "./git.js";
import { formatHumanReport, formatMarkdownReport } from "./report.js";
import { meetsFailOn } from "./risk.js";
import { writeSarif } from "./sarif.js";
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
  const config = resolveConfig(snapshot.root, options);
  const files = filterIgnored(
    hydrateUntrackedPatches(snapshot.root, snapshot.files),
    config.ignorePaths,
  );
  const existing = new Set(snapshot.trackedFiles);
  const coverage = loadCoverageMap(snapshot.root);
  const impact = buildImpact(files, existing, {
    ignorePaths: config.ignorePaths,
    coverage,
  });
  const tools = detectTools(snapshot.root);

  const mappedTestFiles = [...new Set(impact.mappedTests.flatMap((m) => m.tests))];

  const [typecheck, lint, tests, secretScan] = await Promise.all([
    runTypecheck(snapshot.root, tools, config.gates.typecheck),
    runLint(snapshot.root, tools, config.gates.lint),
    runAffectedTests(snapshot.root, tools, mappedTestFiles, config.gates.tests),
    runSecretScan(snapshot.root, tools, files, snapshot.range, config.gates.secrets),
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
    acceptGaps: config.acceptGaps,
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
    const config = resolveConfig(evidence.repo.root, options);
    const outFile = writeEvidence(options.out, evidence);
    if (options.sarif) {
      const sarifFile = writeSarif(options.sarif, evidence);
      if (options.format !== "json") {
        process.stderr.write(`wrote ${sarifFile}\n`);
      }
    }
    const format = options.json ? "json" : options.format;
    const output = render(evidence, format);
    process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
    if (format !== "json") {
      process.stderr.write(`wrote ${outFile}\n`);
    }
    return meetsFailOn(evidence.summary.risk, config.failOn) ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`patchprove: ${message}\n`);
    return 2;
  }
}
