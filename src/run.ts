import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compareToBaseline, findBaselinePath, loadBaselineEvidence, newGapsMeetFailOn } from "./baseline.js";
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
import { buildImportGraph } from "./graph.js";
import { createPluginContext, resolveLanguagePlugins } from "./plugins/index.js";
import {
  attachReceiptRef,
  buildReceipt,
  defaultReceiptPath,
  findPreviousReceiptHash,
  writeReceipt,
} from "./receipt.js";
import { formatHumanReport, formatMarkdownReport } from "./report.js";
import { meetsFailOn } from "./risk.js";
import { writeSarif } from "./sarif.js";
import { evaluateContract, loadContract } from "./spec.js";
import type { Evidence, FailOnOutcomeReason, ResolvedConfig, RunOptions } from "./types.js";

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

export function failOnOutcomeOf(
  evidence: Evidence,
  config: ResolvedConfig,
): { failed: boolean; reason: FailOnOutcomeReason } {
  if (evidence.contract.loaded && !evidence.contract.passed) {
    return { failed: true, reason: "contract" };
  }
  if (newGapsMeetFailOn(evidence.baselineComparison, config.failOnNewGaps)) {
    return { failed: true, reason: "new-gaps" };
  }
  if (meetsFailOn(evidence.summary.risk, config.failOn)) {
    return { failed: true, reason: "fail-on" };
  }
  return { failed: false, reason: "ok" };
}

export function shouldFailRun(evidence: Evidence, config: ResolvedConfig): boolean {
  return failOnOutcomeOf(evidence, config).failed;
}

export function resolveReceiptPath(options: RunOptions): string | null {
  if (options.receipt === false) return null;
  if (typeof options.receipt === "string" && options.receipt.trim()) {
    return path.resolve(options.receipt);
  }
  return path.resolve(defaultReceiptPath(options.out));
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
  const plugins = await resolveLanguagePlugins(snapshot.root, {
    configPlugins: config.plugins,
  });
  const pluginContext = createPluginContext(snapshot.root, existing);
  const coverage = loadCoverageMap(snapshot.root);
  const graph = buildImportGraph(snapshot.root, existing, plugins, undefined, pluginContext);
  const impact = buildImpact(files, existing, {
    ignorePaths: config.ignorePaths,
    coverage,
    graph,
    plugins,
    pluginContext,
  });
  const tools = detectTools(snapshot.root);

  const mappedTestFiles = [...new Set(impact.mappedTests.flatMap((m) => m.tests))];

  const [typecheck, lint, tests, secretScan] = await Promise.all([
    runTypecheck(snapshot.root, tools, config.gates.typecheck),
    runLint(snapshot.root, tools, config.gates.lint),
    runAffectedTests(snapshot.root, tools, mappedTestFiles, config.gates.tests, plugins, pluginContext),
    runSecretScan(snapshot.root, tools, files, snapshot.range, config.gates.secrets),
  ]);

  const checks = [typecheck, lint, tests, secretScan.check];
  const gaps = collectGaps(impact, checks, tools, plugins);
  const findings = [
    ...pathFindings(impact.changedFiles),
    ...secretScan.findings,
    ...failedCheckFindings(checks),
  ];

  let evidence = buildEvidence({
    cwd,
    root: snapshot.root,
    range: snapshot.range,
    impact,
    checks,
    gaps,
    findings,
    acceptGaps: config.acceptGaps,
  });

  const contract = loadContract(snapshot.root, options.spec ?? config.spec ?? undefined);
  evidence = {
    ...evidence,
    contract: evaluateContract(contract, evidence),
  };

  const baselinePath = findBaselinePath(snapshot.root, {
    explicit: options.baseline,
    fromConfig: config.baseline,
  });
  if (baselinePath) {
    const baseline = loadBaselineEvidence(baselinePath);
    evidence = {
      ...evidence,
      baselineComparison: compareToBaseline(evidence, baseline, baselinePath, config.failOnNewGaps),
    };
  }

  return evidence;
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
    let evidence = await analyze(options);
    const config = resolveConfig(evidence.repo.root, options);
    const outcome = failOnOutcomeOf(evidence, config);
    const exitCode = outcome.failed ? 1 : 0;
    const receiptPath = resolveReceiptPath(options);
    if (receiptPath) {
      if (options.sign && !process.env.PATCHPROVE_SIGNING_KEY?.trim()) {
        process.stderr.write(
          "patchprove: --sign set but PATCHPROVE_SIGNING_KEY is empty; writing unsigned receipt\n",
        );
      }
      const receipt = buildReceipt({
        evidence,
        argv: options.argv ?? process.argv.slice(2),
        options,
        exitCode,
        failOnOutcome: outcome,
        sign: options.sign,
      });
      const writtenReceipt = writeReceipt(receiptPath, receipt);
      const previousContentHash = findPreviousReceiptHash(
        evidence.baselineComparison?.baselinePath,
      );
      const displayPath = path.relative(evidence.repo.root, writtenReceipt) || writtenReceipt;
      evidence = attachReceiptRef(evidence, receipt, {
        path: displayPath,
        previousContentHash,
      });
      if (options.format !== "json") {
        process.stderr.write(`wrote ${writtenReceipt}\n`);
      }
    }
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
    return exitCode;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`patchprove: ${message}\n`);
    return 2;
  }
}
