import { classifyPath, maxRisk, riskForPathKind } from "./risk.js";
import {
  collectLanguages,
  isMappableSource,
  isSourceFile,
  languageOf,
  mapTestsForFile,
} from "./mapping.js";
import type { DiffFile } from "./git.js";
import type {
  ChangedFile,
  CheckResult,
  DetectedTools,
  Evidence,
  Finding,
  Gap,
  MappedTest,
} from "./types.js";
import { SCHEMA_VERSION, TOOL_VERSION } from "./types.js";

export function toChangedFile(file: DiffFile): ChangedFile {
  const riskKind = classifyPath(file.path);
  return {
    path: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    highRisk: riskKind !== null,
    riskKind,
  };
}

export function buildImpact(
  files: DiffFile[],
  existingFiles: ReadonlySet<string>,
): Evidence["impact"] {
  const changedFiles = files.map(toChangedFile);
  const mappedTests: MappedTest[] = [];
  const unmappedSources: string[] = [];

  for (const file of files) {
    if (file.status === "deleted") continue;
    if (!isMappableSource(file.path)) continue;
    const tests = mapTestsForFile(file.path, existingFiles);
    if (tests.length > 0) {
      mappedTests.push({ source: file.path, tests });
    } else {
      unmappedSources.push(file.path);
    }
  }

  return {
    changedFiles,
    mappedTests,
    unmappedSources,
    languages: collectLanguages(files.map((f) => f.path)),
  };
}

export function pathFindings(changed: ChangedFile[]): Finding[] {
  const findings: Finding[] = [];
  let i = 0;
  for (const file of changed) {
    if (!file.riskKind) continue;
    i += 1;
    const kind = file.riskKind === "auth-crypto" ? "auth-crypto" : file.riskKind;
    findings.push({
      id: `path-${i}`,
      kind,
      risk: riskForPathKind(file.riskKind),
      message: `High-risk path (${file.riskKind}): ${file.path}`,
      path: file.path,
    });
  }
  return findings;
}

export function collectGaps(
  impact: Evidence["impact"],
  checks: CheckResult[],
  tools: DetectedTools,
): Gap[] {
  const gaps: Gap[] = [];

  for (const source of impact.unmappedSources) {
    const auth = classifyPath(source) === "auth-crypto";
    gaps.push({
      id: `gap-unmapped-${source}`,
      kind: "unmapped-test",
      message: `No nearby test mapped for ${source}`,
      risk: auth ? "high" : "medium",
      files: [source],
    });
  }

  const testCheck = checks.find((c) => c.id === "tests");
  if (testCheck?.status === "skipped" && impact.unmappedSources.length > 0 && impact.mappedTests.length === 0) {
    gaps.push({
      id: "gap-no-tests-mapped",
      kind: "no-tests-mapped",
      message: "Affected-test gate not run: no mapped tests for this diff",
      risk: impact.changedFiles.some((f) => f.riskKind === "auth-crypto") ? "high" : "medium",
      files: impact.unmappedSources,
    });
  }

  for (const check of checks) {
    if (check.status !== "skipped") continue;
    if (check.id === "tests" && impact.mappedTests.length === 0) continue;
    const missing =
      (check.id === "typecheck" && (tools.typescript || tools.pyright || tools.mypy)) ||
      (check.id === "lint" && (tools.eslint || tools.ruff)) ||
      (check.id === "tests" && (tools.vitest || tools.jest || tools.pytest));
    if (missing || /not found|configured but/i.test(check.reason ?? "")) {
      gaps.push({
        id: `gap-tool-${check.id}`,
        kind: "tool-missing",
        message: check.reason ?? `${check.name} skipped`,
        risk: "low",
      });
    }
  }

  const unsupported = impact.changedFiles
    .filter((f) => f.status !== "deleted")
    .filter((f) => isSourceFile(f.path) === false)
    .filter((f) => !f.highRisk)
    .filter((f) => {
      const lang = languageOf(f.path);
      return lang === "other" && /\.(go|rs|java|rb|php|cs|kt|swift)$/i.test(f.path);
    })
    .map((f) => f.path);

  if (unsupported.length > 0) {
    gaps.push({
      id: "gap-unsupported-language",
      kind: "unsupported-language",
      message: "Changed sources are outside JS/TS/Python mapping heuristics",
      risk: "low",
      files: unsupported,
    });
  }

  return gaps;
}

export function failedCheckFindings(checks: CheckResult[]): Finding[] {
  return checks
    .filter((c) => c.status === "failed")
    .map((c, i) => ({
      id: `check-failed-${i + 1}`,
      kind: "check-failed" as const,
      risk: c.id === "secrets" ? "critical" : "high",
      message: `${c.name} failed${c.reason ? `: ${c.reason}` : ""}`,
    }));
}

export function buildEvidence(input: {
  cwd: string;
  root: string;
  range: Evidence["range"];
  impact: Evidence["impact"];
  checks: CheckResult[];
  gaps: Gap[];
  findings: Finding[];
  generatedAt?: string;
}): Evidence {
  const checksPassed = input.checks.filter((c) => c.status === "passed").length;
  const checksFailed = input.checks.filter((c) => c.status === "failed").length;
  const checksSkipped = input.checks.filter((c) => c.status === "skipped").length;
  const summaryRisk = maxRisk([
    ...input.findings.map((f) => f.risk),
    ...input.gaps.map((g) => g.risk),
  ]);

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    toolVersion: TOOL_VERSION,
    repo: { cwd: input.cwd, root: input.root },
    range: input.range,
    impact: input.impact,
    checks: input.checks,
    gaps: input.gaps,
    findings: input.findings,
    summary: {
      risk: summaryRisk,
      checksPassed,
      checksFailed,
      checksSkipped,
      gapCount: input.gaps.length,
      findingCount: input.findings.length,
    },
  };
}
