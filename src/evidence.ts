import { applyAcceptedGaps, isOpenGap } from "./accept.js";
import { matchAnyGlob } from "./glob.js";
import type { CoverageIndex } from "./coverage.js";
import { mapTestsForSource } from "./coverage.js";
import type { ImportGraph } from "./graph.js";
import { classifyPath, maxRisk, riskForPathKind } from "./risk.js";
import {
  collectLanguages,
  isMappableSource,
  isSourceFile,
  languageOf,
} from "./mapping.js";
import { builtinPlugins, type LanguagePlugin } from "./plugins/index.js";
import type { PluginContext } from "./plugins/types.js";
import type { DiffFile } from "./git.js";
import type {
  AcceptGapRule,
  BaselineComparison,
  ChangedFile,
  CheckResult,
  ContractResult,
  DetectedTools,
  Evidence,
  Finding,
  Gap,
  MappedTest,
  MappingStrategy,
} from "./types.js";
import { emptyContractResult, SCHEMA_VERSION, TOOL_VERSION } from "./types.js";

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

export function filterIgnored<T extends { path: string }>(
  items: T[],
  ignorePaths: readonly string[],
): T[] {
  if (ignorePaths.length === 0) return items;
  return items.filter((item) => !matchAnyGlob(item.path, ignorePaths));
}

function pickMappingStrategy(
  coverage: CoverageIndex | null,
  graph: ImportGraph | null | undefined,
  vias: Iterable<MappingStrategy>,
): { mappingStrategy: MappingStrategy; mappingFallbacks?: MappingStrategy[] } {
  const used = new Set<MappingStrategy>(vias);
  let mappingStrategy: MappingStrategy = "naming";
  if (coverage) mappingStrategy = "coverage";
  else if (graph && (graph.edgeCount > 0 || used.has("graph"))) mappingStrategy = "graph";
  else if (used.has("graph")) mappingStrategy = "graph";
  const mappingFallbacks = [...used].filter((s) => s !== mappingStrategy);
  return mappingFallbacks.length > 0 ? { mappingStrategy, mappingFallbacks } : { mappingStrategy };
}

export function buildImpact(
  files: DiffFile[],
  existingFiles: ReadonlySet<string>,
  options?: {
    ignorePaths?: readonly string[];
    coverage?: CoverageIndex | null;
    graph?: ImportGraph | null;
    plugins?: readonly LanguagePlugin[];
    pluginContext?: PluginContext;
  },
): Evidence["impact"] {
  const ignorePaths = options?.ignorePaths ?? [];
  const plugins = options?.plugins ?? builtinPlugins;
  const visible = filterIgnored(files, ignorePaths);
  const changedFiles = visible.map(toChangedFile);
  const mappedTests: MappedTest[] = [];
  const unmappedSources: string[] = [];
  const coverage = options?.coverage ?? null;
  const graph = options?.graph ?? null;
  const vias: MappingStrategy[] = [];

  for (const file of visible) {
    if (file.status === "deleted") continue;
    if (!isMappableSource(file.path, plugins)) continue;
    const { tests, via } = mapTestsForSource(
      file.path,
      existingFiles,
      coverage,
      graph,
      plugins,
      options?.pluginContext,
    );
    if (tests.length > 0) {
      mappedTests.push({ source: file.path, tests, via });
      if (via) vias.push(via);
    } else {
      unmappedSources.push(file.path);
    }
  }

  const { mappingStrategy, mappingFallbacks } = pickMappingStrategy(coverage, graph, vias);

  return {
    changedFiles,
    mappedTests,
    unmappedSources,
    languages: collectLanguages(visible.map((f) => f.path), plugins),
    mappingStrategy,
    ...(mappingFallbacks ? { mappingFallbacks } : {}),
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
  plugins: readonly LanguagePlugin[] = builtinPlugins,
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
    if (check.reason?.startsWith("Disabled by config")) continue;
    if (check.id === "tests" && impact.mappedTests.length === 0) continue;
    const missing =
      (check.id === "typecheck" && (tools.typescript || tools.pyright || tools.mypy)) ||
      (check.id === "lint" && (tools.eslint || tools.ruff)) ||
      (check.id === "tests" &&
        (tools.vitest || tools.jest || tools.pytest || tools.go || tools.cargo || tools.maven || tools.gradle));
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
    .filter((f) => isSourceFile(f.path, plugins) === false)
    .filter((f) => !f.highRisk)
    .filter((f) => {
      const lang = languageOf(f.path, plugins);
      return lang === "other" && /\.(rb|php|cs|kt|swift)$/i.test(f.path);
    })
    .map((f) => f.path);

  if (unsupported.length > 0) {
    gaps.push({
      id: "gap-unsupported-language",
      kind: "unsupported-language",
      message: "Changed sources are outside built-in language plugins (js/ts, python, go, rust, java)",
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
  acceptGaps?: readonly AcceptGapRule[];
  generatedAt?: string;
  contract?: ContractResult;
  baselineComparison?: BaselineComparison | null;
}): Evidence {
  const gaps = applyAcceptedGaps(input.gaps, input.acceptGaps ?? []);
  const openGaps = gaps.filter(isOpenGap);
  const acceptedGaps = gaps.filter((g) => !isOpenGap(g));
  const checksPassed = input.checks.filter((c) => c.status === "passed").length;
  const checksFailed = input.checks.filter((c) => c.status === "failed").length;
  const checksSkipped = input.checks.filter((c) => c.status === "skipped").length;
  const summaryRisk = maxRisk([
    ...input.findings.map((f) => f.risk),
    ...openGaps.map((g) => g.risk),
  ]);

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    toolVersion: TOOL_VERSION,
    repo: { cwd: input.cwd, root: input.root },
    range: input.range,
    impact: input.impact,
    checks: input.checks,
    gaps,
    findings: input.findings,
    summary: {
      risk: summaryRisk,
      checksPassed,
      checksFailed,
      checksSkipped,
      gapCount: openGaps.length,
      acceptedGapCount: acceptedGaps.length,
      findingCount: input.findings.length,
    },
    contract: input.contract ?? emptyContractResult(),
    baselineComparison: input.baselineComparison ?? null,
  };
}
