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
  isTestFile,
  languageOf,
} from "./mapping.js";
import { normalizeRel } from "./paths.js";
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
import { emptyContractResult, COMPAT_SCHEMA_VERSION, TOOL_VERSION } from "./types.js";

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
  vias: Iterable<MappingStrategy>,
): { mappingStrategy: MappingStrategy; mappingFallbacks?: MappingStrategy[] } {
  const used = new Set<MappingStrategy>(vias);
  let mappingStrategy: MappingStrategy = "naming";
  if (used.has("coverage")) mappingStrategy = "coverage";
  else if (used.has("graph")) mappingStrategy = "graph";
  const mappingFallbacks = [...used].filter((s) => s !== mappingStrategy);
  return mappingFallbacks.length > 0 ? { mappingStrategy, mappingFallbacks } : { mappingStrategy };
}

/** Files with executable or dependency effects still need an explicit verification scope. */
export function unsupportedMappingReason(filePath: string): string | null {
  const rel = normalizeRel(filePath);
  if (/(^|\/)(fixtures?|resources?|templates?|assets?)(\/|$)/i.test(rel)) {
    return "Changed test fixture or resource has no dependency mapping";
  }
  if (/\.(md|rst|adoc)$/i.test(rel) || /(^|\/)(LICENSE|NOTICE|COPYING)(\.[^/]*)?$/i.test(rel) || (/\.txt$/i.test(rel) && /(^|\/)(docs?|README|CHANGELOG|NEWS)(\/|\.|$)/i.test(rel))) return null;
  if (/\.(c|cc|cpp|cxx|h|hh|hpp|m|mm|rb|php|cs|kt|kts|swift|scala|ex|exs|erl|hs|lua|r|sh|bash|zsh|ps1|bat|cmd)$/i.test(rel)) {
    return "Changed source language has no configured dependency mapper";
  }
  if (/(^|\/)(package\.json|[^/]*lock[^/]*|go\.mod|Cargo\.toml|pom\.xml|Makefile|Dockerfile[^/]*|[^/]*config[^/]*|\.[^/]*rc[^/]*)$/i.test(rel) || /\.(json|ya?ml|toml|xml|gradle|properties|ini|cfg)$/i.test(rel)) {
    return "Changed configuration or dependency manifest has no dependency mapping";
  }
  return "Changed resource has no configured dependency mapping";
}

export function buildImpact(
  files: DiffFile[],
  existingFiles: ReadonlySet<string>,
  options?: {
    ignorePaths?: readonly string[];
    coverage?: CoverageIndex | null;
    graph?: ImportGraph | null;
    baseGraph?: ImportGraph | null;
    basePluginContext?: PluginContext;
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
  const unmappedReasons: Record<string, string> = {};
  const mappingEvidence: NonNullable<Evidence["impact"]["mappingEvidence"]> = [];
  const coverage = options?.coverage ?? null;
  const graph = options?.graph ?? null;
  const vias: MappingStrategy[] = [];
  const deleted = new Set(visible.filter((file) => file.status === "deleted").map((file) => normalizeRel(file.path)));
  const existing = new Set([...existingFiles].map(normalizeRel).filter((file) => !deleted.has(file)));
  const context = options?.pluginContext ? { ...options.pluginContext, existing } : undefined;
  const unmapped = (file: string, reason: string): void => {
    if (!unmappedSources.includes(file)) unmappedSources.push(file);
    unmappedReasons[file] = reason;
  };

  for (const file of visible) {
    const test = isTestFile(file.path, plugins, file.status === "deleted" ? options?.basePluginContext : context);
    const inlineSourceTest = test && !isTestFile(file.path, plugins);
    if (test && !inlineSourceTest) {
      if (file.status === "deleted") {
        unmapped(file.path, "Deleted test removes verification coverage; surviving coverage cannot be inferred");
      } else if (existing.has(normalizeRel(file.path))) {
        mappedTests.push({ source: file.path, tests: [file.path], via: "naming" });
        mappingEvidence.push({ source: file.path, test: file.path, via: "naming", precision: "structural", origin: "changed-test", freshness: "current" });
        vias.push("naming");
      } else {
        unmapped(file.path, "Changed test is absent from the execution snapshot");
      }
      continue;
    }
    if (!isMappableSource(file.path, plugins)) {
      const reason = unsupportedMappingReason(file.path);
      if (reason) unmapped(file.path, reason);
      continue;
    }
    const sourceGraph = file.status === "deleted" ? options?.baseGraph : graph;
    const { tests, via, origins, evidence } = mapTestsForSource(
      file.path,
      existing,
      file.status === "deleted" ? null : coverage,
      sourceGraph,
      plugins,
      file.status === "deleted" ? options?.basePluginContext ?? context : context,
    );
    if (inlineSourceTest && file.status !== "deleted" && existing.has(normalizeRel(file.path))) {
      if (!tests.includes(file.path)) tests.push(file.path);
      evidence.push({ source: file.path, test: file.path, via: "naming", precision: "structural", origin: "changed-test", freshness: "current" });
      if (!origins.includes("naming")) origins.push("naming");
      tests.sort();
    }
    if (file.status === "deleted" && !options?.baseGraph) {
      unmapped(file.path, "Deleted source requires a base revision dependency graph to establish affected tests");
    }
    if (tests.length > 0) {
      mappedTests.push({ source: file.path, tests, via, ...(origins.length > 1 ? { origins } : {}) });
      mappingEvidence.push(...evidence.map((edge) => file.status === "deleted" ? { ...edge, origin: `base:${edge.origin}`, freshness: "unknown" as const } : edge));
      vias.push(...origins);
    } else {
      if (!unmappedReasons[file.path]) unmapped(file.path, file.status === "deleted" ? "No surviving tests mapped from the base revision for deleted source" : "No nearby test or dependency graph test mapped for changed source");
    }
  }

  const availableGraphs = [graph, options?.baseGraph].filter((candidate): candidate is ImportGraph => candidate != null);
  const dynamicGraph = availableGraphs.find((candidate) => candidate.diagnostics?.some((diagnostic) => diagnostic.code === "mapping-dynamic-dependency"));
  if (dynamicGraph) {
    const fallbackTests = [...new Set(availableGraphs.flatMap((candidate) =>
      [...(candidate.tests ?? new Set([...candidate.importers.values()].flat()))],
    ))].filter((test) => existing.has(test)).sort();
    for (const file of visible) {
      // Test-only edits already select the changed test. Production, fixtures,
      // and configuration can affect a dependency expression anywhere in the suite.
      if (isTestFile(file.path, plugins)) continue;
      if (!isSourceFile(file.path, plugins) && unsupportedMappingReason(file.path) === null) continue;
      if (fallbackTests.length === 0) continue;
      const mapped = mappedTests.find((entry) => entry.source === file.path);
      if (mapped) {
        mapped.tests = [...new Set([...mapped.tests, ...fallbackTests])].sort();
        const origins = [...new Set([...(mapped.origins ?? (mapped.via ? [mapped.via] : [])), "graph" as const])];
        if (origins.length > 1) mapped.origins = origins;
      } else {
        mappedTests.push({ source: file.path, tests: fallbackTests, via: "graph" });
      }
      for (const test of fallbackTests) {
        mappingEvidence.push({ source: file.path, test, via: "graph", precision: "heuristic", origin: "dynamic-fallback", freshness: "unknown", inputHash: dynamicGraph.inputHash });
      }
      vias.push("graph");
      if (file.status !== "deleted" && isSourceFile(file.path, plugins)) {
        const index = unmappedSources.indexOf(file.path);
        if (index >= 0) unmappedSources.splice(index, 1);
        delete unmappedReasons[file.path];
      }
    }
  }

  const { mappingStrategy, mappingFallbacks } = pickMappingStrategy(vias);

  return {
    changedFiles,
    mappedTests,
    unmappedSources,
    languages: collectLanguages(visible.map((f) => f.path), plugins),
    mappingStrategy,
    ...(mappingFallbacks ? { mappingFallbacks } : {}),
    ...(mappingEvidence.length ? { mappingEvidence } : {}),
    ...(Object.keys(unmappedReasons).length ? { unmappedReasons } : {}),
    ...((graph?.diagnostics?.length || options?.baseGraph?.diagnostics?.length) ? { mappingDiagnostics: [...(graph?.diagnostics ?? []), ...(options?.baseGraph?.diagnostics ?? [])] } : {}),
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
      kind: isSourceFile(source, plugins) ? "unmapped-test" : "unsupported-language",
      message: `${impact.unmappedReasons?.[source] ?? "No nearby test mapped"}: ${source}`,
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
    .filter((f) => !impact.unmappedSources.includes(f.path))
    .filter((f) => isSourceFile(f.path, plugins) === false)
    .filter((f) => {
      const lang = languageOf(f.path, plugins);
      return lang === "other" && unsupportedMappingReason(f.path) !== null;
    })
    .map((f) => f.path);

  if (unsupported.length > 0) {
    gaps.push({
      id: "gap-unsupported-language",
      kind: "unsupported-language",
      message: "Changed sources, resources or configuration are outside configured dependency mapping; affected tests cannot be established",
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
    schemaVersion: COMPAT_SCHEMA_VERSION,
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
    ...(input.impact.mappingEvidence ? { mappingEvidence: input.impact.mappingEvidence } : {}),
    ...(input.impact.mappingDiagnostics ? { diagnostics: input.impact.mappingDiagnostics } : {}),
  };
}
