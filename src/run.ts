import { existsSync, readFileSync, readdirSync, opendirSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { analyzeInFreshProcess } from "./analysis-session.js";
import { loadAdapterEvidence } from "./adapters.js";
import { writeArtifactSet, writeJsonAtomic } from "./artifacts.js";
import { compareToBaseline, findBaselinePath, loadBaselineInput, newGapsMeetFailOn } from "./baseline.js";
import { resolveConfig } from "./config.js";
import { loadCoverageMap } from "./coverage.js";
import { evaluateVerification } from "./decision.js";
import { detectTools } from "./detect.js";
import { accountInput, assertInputActive, inputLimits, readBoundedFile, readJsonInput, resolveInputLimits, stringifyBoundedJson, withInputBudget } from "./input-budget.js";
import { configuredToolUnits, testExecutionUnits, type TestUnit, type ToolUnit } from "./execution-units.js";
import { buildEvidence, buildImpact, collectGaps, failedCheckFindings, filterIgnored, pathFindings } from "./evidence.js";
import { gapFingerprint, findingFingerprint } from "./fingerprint.js";
import { runAffectedTests, runLint, runSecretScan, runTypecheck } from "./gates.js";
import { collectGitSnapshot, type DiffFile } from "./git.js";
import { buildImportGraph } from "./graph.js";
import { canonicalPathParent } from "./paths.js";
import { createPluginContext } from "./plugins/index.js";
import { resolveLanguagePluginSession, resolvePluginSpec } from "./plugins/load.js";
import { JS_PARSER_IDENTITY } from "./plugins/js-parser.js";
import { relativizeReportArtifacts, reportArtifactEntries, withReportArchive } from "./report-archive.js";
import { attachReceiptRef, buildReceipt, defaultReceiptPath, findPreviousReceiptHash, hashCanonical, parseSigningKey } from "./receipt.js";
import { formatHumanReport, formatMarkdownReport } from "./report.js";
import { meetsFailOn } from "./risk.js";
import { toSarif } from "./sarif.js";
import { captureSnapshotIdentity, checkedGit, createExecutionSnapshot, listVersionedFiles, readVersionedFile, repositoryRoot, withGitExecutionBudget } from "./snapshot.js";
import { evaluateContract, loadContract } from "./spec.js";
import { COMPAT_SCHEMA_VERSION, SCHEMA_VERSION, TOOL_VERSION } from "./types.js";
import type { DetectedTools, EffectivePolicy, Evidence, ExecutionRecord, FailOnOutcomeReason, PatchproveContract, PluginProvenance, ProjectGatePolicy, ResolvedConfig, RunOptions, VerificationPlanItem } from "./types.js";

let retainedSigningKey: string | undefined;
function retainSigningKey(): string | undefined {
  if (process.env.PATCHPROVE_SIGNING_KEY) retainedSigningKey = process.env.PATCHPROVE_SIGNING_KEY;
  delete process.env.PATCHPROVE_SIGNING_KEY;
  return retainedSigningKey;
}

/** Validate the caller's artifact intent before any target-controlled work. */
export function validateArtifactOptions(options: Pick<RunOptions, "sign" | "receipt" | "protocol">, signingKey?: string | null): void {
  if (!options.sign) return;
  if (options.receipt === false) throw new Error("Signing requires a receipt; sign:true conflicts with receipt:false");
  if ((options.protocol ?? 2) === 2 && !parseSigningKey(signingKey ?? process.env.PATCHPROVE_SIGNING_KEY ?? retainedSigningKey)) {
    throw new Error("Signing was required but no signing key was provided");
  }
}

export function hydrateUntrackedPatches(root: string, files: DiffFile[]): DiffFile[] {
  return files.map((file) => {
    if (file.patch || file.status === "deleted" || !["untracked", "added"].includes(file.status)) return file;
    const content = readBoundedFile(path.join(root, file.path)).toString("utf8");
    const lines = content.split("\n");
    return { ...file, patch: [`diff --git a/${file.path} b/${file.path}`, "--- /dev/null", `+++ b/${file.path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n"), additions: lines.length };
  });
}

export function failOnOutcomeOf(evidence: Evidence, config?: ResolvedConfig): { failed: boolean; reason: FailOnOutcomeReason } {
  const decision = evaluateVerification(evidence, config);
  if (evidence.contract.loaded && !evidence.contract.passed) return { failed: true, reason: "contract" };
  if (newGapsMeetFailOn(evidence.baselineComparison, config?.failOnNewGaps ?? evidence.effectivePolicy?.failOnNewGaps ?? undefined)) return { failed: true, reason: "new-gaps" };
  if (decision.status === "failed" || decision.strict && decision.status === "incomplete") return { failed: true, reason: "fail-on" };
  if (meetsFailOn(evidence.summary.risk, config?.failOn ?? evidence.effectivePolicy?.failOn ?? undefined)) return { failed: true, reason: "fail-on" };
  return { failed: false, reason: "ok" };
}

export function shouldFailRun(evidence: Evidence, config?: ResolvedConfig): boolean { return failOnOutcomeOf(evidence, config).failed; }
function outputPath(options: RunOptions, file: string): string { return path.resolve(options.cwd, file); }
export function resolveReceiptPath(options: RunOptions): string | null {
  if (options.receipt === false) return null;
  return outputPath(options, typeof options.receipt === "string" && options.receipt.trim() ? options.receipt : defaultReceiptPath(options.out));
}
function artifactPaths(options: RunOptions): string[] {
  const out = outputPath(options, options.out);
  return [out, resolveReceiptPath(options), options.sarif ? outputPath(options, options.sarif) : null, `${out}.manifest.json`]
    .filter((file): file is string => Boolean(file)).flatMap((file) => [file, `${file}.patchprove-lock`]);
}
function portablePath(file: string, root: string, source: string): string {
  const rel = path.relative(root, file);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? path.join(source, rel) : file;
}
function assertArtifactInputs(outputs: string[], inputs: string[]): void {
  const canonical = (file: string): string => {
    let ancestor = path.resolve(file);
    const missing: string[] = [];
    while (!existsSync(ancestor)) {
      missing.unshift(path.basename(ancestor));
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    return path.join(realpathSync.native(ancestor), ...missing);
  };
  const identities = inputs.map(canonical);
  for (const output of outputs) {
    const resolved = canonical(output);
    if (identities.some((input) => input === resolved || input.startsWith(`${resolved}${path.sep}`))) throw new Error(`Artifact destination would overwrite a verification input: ${output}`);
  }
}
function assertArtifactDestinations(outputs: string[]): void {
  for (const output of outputs) {
    if (/\.(?:[cm]?[jt]sx?|py|go|rs|java|sh|bash|yml|yaml|toml)$/i.test(output) || /^(?:package(?:-lock)?\.json|tsconfig(?:\..+)?\.json|Cargo\.lock|go\.(?:mod|sum)|pom\.xml)$/i.test(path.basename(output))) {
      throw new Error(`Artifact destination may not be executable source or project configuration: ${output}`);
    }
    if (!existsSync(output)) continue;
    let value: Record<string, unknown> | undefined;
    try { value = readJsonInput(output) as Record<string, unknown>; } catch { /* An existing unrelated file is an input. */ }
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        !(Array.isArray(value.checks) && (Array.isArray(value.gaps) || typeof value.contentHash === "string") || Array.isArray(value.runs) && value.version === "2.1.0" || Array.isArray(value.artifacts) && typeof value.runId === "string")) {
      throw new Error(`Artifact destination already contains an unrelated input: ${output}`);
    }
  }
}
function fileIdentity(file: string | null): { path: string; hash: string } | null {
  return file ? { path: file, hash: hashCanonical(readBoundedFile(file).toString("utf8")) } : null;
}
function declaredJavaFileEncoding() {
  const value = /(?:^|\s)-Dfile\.encoding=(UTF-8|UTF8|UTF-16|US-ASCII|ISO-8859-1|windows-1252)(?=\s|$)/i.exec(process.env.JAVA_TOOL_OPTIONS ?? "")?.[1]?.toUpperCase();
  return (["UTF-8", "UTF8", "UTF-16", "US-ASCII", "ISO-8859-1", "windows-1252"] as const).find((encoding) => encoding.toUpperCase() === value);
}
function policyFor(config: ResolvedConfig, protocol: 1 | 2, contract: PatchproveContract | null, baseline: { path: string; hash: string } | null): EffectivePolicy {
  const spec = contract?.inputIdentities?.[0] ?? fileIdentity(contract?.sourcePath ?? null);
  const specInputs = contract?.inputIdentities ?? contract?.inputPaths?.map((file) => fileIdentity(file)!);
  const policy: EffectivePolicy = { protocol, strict: config.strict ?? protocol === 2,
    failOn: config.failOn ?? null, failOnNewGaps: config.failOnNewGaps ?? null,
    gates: config.gates, ignorePaths: config.ignorePaths, acceptGaps: config.acceptGaps, plugins: config.plugins,
    config: config.sourcePath ? { path: config.sourcePath, hash: config.sourceHash ?? fileIdentity(config.sourcePath)!.hash } : null,
    spec: spec && specInputs ? { ...spec, inputs: specInputs } : spec, baseline, hash: "", ...(config.projects ? { projects: config.projects } : {}) };
  const { baseline: _baseline, hash: _hash, ...effective } = policy;
  policy.hash = hashCanonical(effective);
  return policy;
}
function portablePolicy(policy: EffectivePolicy, executionRoot: string, sourceRoot: string): EffectivePolicy {
  const portableInputPath = (file: string) => {
    const relative = path.relative(executionRoot, file);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? relative.split(path.sep).join("/") || "." : file;
  };
  const normalize = (item: { path: string; hash: string } | null) => item ? { ...item, path: portableInputPath(item.path) } : null;
  const spec = normalize(policy.spec);
  const result: EffectivePolicy = { ...policy, plugins: policy.plugins.map((file) => portableInputPath(resolvePluginSpec(executionRoot, file))), config: normalize(policy.config), spec: spec && policy.spec?.inputs ? { ...spec, inputs: policy.spec.inputs.map((item) => normalize(item)!) } : spec, baseline: normalize(policy.baseline) };
  const { baseline: _baseline, hash: _hash, ...effective } = result;
  result.hash = hashCanonical(effective);
  return result;
}

/** Installation paths do not change plugin semantics; repository/external roles do. */
export function pluginSetHash(plugins: PluginProvenance[], root: string): string {
  return hashCanonical(plugins.map((plugin) => {
    const toolRoot = plugin.source === "builtin" && plugin.entry ? path.resolve(path.dirname(plugin.entry), "../..") : undefined;
    const identity = (file: string): string => {
      const base = toolRoot ?? root;
      const relative = path.relative(base, file);
      if (toolRoot && (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative.split(path.sep)[0] === "node_modules")) {
        const segments = path.resolve(file).split(path.sep);
        const dependency = segments.lastIndexOf("node_modules");
        if (dependency !== -1 && dependency + 1 < segments.length) return `dependency:${segments.slice(dependency + 1).join("/")}`;
      }
      return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        ? `${toolRoot ? "tool" : "repository"}:${relative.split(path.sep).join("/")}` : `external:${file}`;
    };
    const observedPaths = [...new Set([...plugin.inputs.map(input => input.path), ...(plugin.entry ? [plugin.entry] : [])])].sort((a, b) => b.length - a.length);
    return { ...plugin, entry: plugin.entry ? identity(plugin.entry) : null,
      inputs: plugin.inputs.map((input) => ({ ...input, path: identity(input.path) })).sort((a, b) => a.path.localeCompare(b.path)),
      unknownDependencies: plugin.unknownDependencies.map((message) => observedPaths.reduce((text, file) => text.replaceAll(file, identity(file)), message)
        .replaceAll(toolRoot ?? root, toolRoot ? "<tool>" : "<repository>")) };
  }));
}
function planFor(config: ResolvedConfig, tools: ToolUnit[], units: TestUnit[], tests: string[], changed: string[]): VerificationPlanItem[] {
  const plan: VerificationPlanItem[] = tools.map((unit) => ({ id: `plan:${unit.id}`, unitId: unit.id, checkId: unit.checkId, scope: unit.scope, required: unit.required, reason: unit.reason, granularity: "repository", ...(unit.policy ? { policy: unit.policy } : {}) }));
  {
    for (const unit of units) plan.push({ id: `plan:${unit.id}`, unitId: unit.id, checkId: "tests", scope: unit.scope, sourceFiles: unit.sourceFiles, granularity: unit.granularity, required: unit.required,
      reason: unit.inactiveReason ?? `Selected ${unit.plugin.id} ${unit.granularity} unit`, ...(unit.policy ? { policy: unit.policy } : {}) });
    const unsupported = tests.filter((file) => !units.some((unit) => unit.sourceFiles.includes(file)));
    if (unsupported.length && config.gates.tests) plan.push({ id: "plan:tests:unsupported", checkId: "tests", scope: unsupported, required: true, reason: "Selected tests have no supported execution unit" });
  }
  if (changed.length && config.gates.secrets) plan.push({ id: "plan:secrets", checkId: "secrets", scope: changed, required: true, reason: "All selected added lines must be scanned" });
  return plan;
}

/** Only reuse explicitly local dependencies whose versioned dependency manifests match the target. */
async function provisionMatchingNodeDependencies(source: string, target: string, head: string): Promise<boolean> {
  if (!existsSync(path.join(source, "node_modules")) || existsSync(path.join(target, "node_modules"))) return false;
  const names = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock", "bun.lock", "bun.lockb", ".pnp.cjs", ".yarnrc.yml"];
  const tracked = await listVersionedFiles(source, head);
  const sourceFiles = (await checkedGit(source, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  const manifests = [...new Set([...tracked, ...sourceFiles])].filter((file) => !file.split("/").includes("node_modules") && names.includes(path.posix.basename(file)));
  if (!manifests.length) return false;
  const directories = new Set([".", ...manifests.map((file) => path.posix.dirname(file))]);
  for (const directory of directories) for (const name of names) {
    const file = path.posix.join(directory, name);
    const targetFile = path.join(target, file);
    const sourceFile = path.join(source, file);
    if (existsSync(sourceFile) !== existsSync(targetFile)) return false;
    if (existsSync(sourceFile) && !readBoundedFile(sourceFile).equals(readBoundedFile(targetFile))) return false;
  }
  // npm/pnpm workspace links can resolve into the live checkout even when the
  // package manifests match. Such links would escape the isolated code tree.
  const dependencyRoot = realpathSync.native(path.join(source, "node_modules"));
  const pending = [dependencyRoot];
  const visited = new Set<string>();
  let entries = 0;
  while (pending.length) {
    assertInputActive();
    const directory = pending.pop()!;
    const canonical = realpathSync.native(directory);
    if (visited.has(canonical)) continue;
    visited.add(canonical);
    const handle = opendirSync(directory);
    try {
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        assertInputActive();
        if (++entries > inputLimits().maxFiles) throw new Error("Dependency traversal exceeded maxFiles budget");
        const candidate = path.join(directory, entry.name);
        accountInput(candidate, 0);
        if (entry.isSymbolicLink()) {
          let resolved: string;
          try { resolved = realpathSync.native(candidate); } catch { return false; }
          const relative = path.relative(dependencyRoot, resolved);
          if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
        } else if (entry.isDirectory()) pending.push(candidate);
      }
    } finally { handle.closeSync(); }
  }
  symlinkSync(path.join(source, "node_modules"), path.join(target, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  return true;
}
function remapOptions(options: RunOptions, source: string, target: string): RunOptions {
  const remap = (value: string | undefined): string | undefined => {
    if (!value || !path.isAbsolute(value)) return value;
    const rel = path.relative(source, canonicalPathParent(value));
    return !rel.startsWith(`..${path.sep}`) && rel !== ".." ? path.join(target, rel) : value;
  };
  return { ...options, cwd: target, config: remap(options.config), spec: remap(options.spec), baseline: remap(options.baseline) };
}

export async function analyze(options: RunOptions): Promise<Evidence> {
  retainSigningKey();
  return analyzeInFreshProcess(options);
}

/** Internal worker entry. Public callers use analyze so module state never crosses runs. */
export async function analyzeInCurrentProcess(options: RunOptions, temporaryRoot?: string): Promise<Evidence> {
  const protocol = options.protocol ?? 2;
  const timeout = options.timeoutMs ?? 180_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error("timeoutMs must be a positive integer");
  const limitsInput = resolveInputLimits(options.inputLimits);
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const deadlineAt = Date.now() + timeout;
  const deadline = setTimeout(() => controller.abort(), timeout);
  let execution: Awaited<ReturnType<typeof createExecutionSnapshot>> | undefined;
  let reusedDependencies = false;
  return withReportArchive(options.reportsDir, () => withInputBudget({ limits: limitsInput, signal: controller.signal, deadline: deadlineAt }, () => withGitExecutionBudget({ signal: controller.signal, deadline: deadlineAt }, async () => {
  try {
    const sourceRoot = await repositoryRoot(path.resolve(options.cwd));
    if ((options.base !== undefined || options.head !== undefined) && options.isolate !== false) {
      execution = await createExecutionSnapshot(sourceRoot, options.head ?? "HEAD");
      reusedDependencies = await provisionMatchingNodeDependencies(sourceRoot, execution.root, options.head ?? "HEAD");
    }
    const root = execution?.root ?? sourceRoot;
    const input = remapOptions(options, sourceRoot, root);
    const destinations = artifactPaths({ ...options, cwd: sourceRoot }).map(canonicalPathParent);
    const reportDestination = options.reportsDir ? canonicalPathParent(path.resolve(options.cwd, options.reportsDir)) : null;
    if (reportDestination && existsSync(reportDestination)) {
      const relative = path.relative(sourceRoot, reportDestination);
      if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        if (!statSync(reportDestination).isDirectory()) throw new Error("Report destination must be a directory");
        for (const entry of readdirSync(reportDestination, { withFileTypes: true })) {
          if (!entry.isDirectory() || !/^run-[a-f0-9-]{36}$/.test(entry.name)) throw new Error("Report destination contains unrelated repository input");
          const index = readJsonInput(path.join(reportDestination, entry.name, "index.json")) as Record<string, unknown>;
          if (!index || index.kind !== "patchprove-machine-report-archive") throw new Error("Report destination contains unrelated repository input");
        }
      }
    }
    const excluded = [...destinations, ...(reportDestination ? [reportDestination] : []),
      ...(temporaryRoot ? [canonicalPathParent(temporaryRoot)] : [])];
    if (protocol === 2) assertArtifactDestinations(destinations);
    const relativeExclusions = excluded.map((file) => path.relative(sourceRoot, file)).filter((file) => file !== ".." && !file.startsWith(`..${path.sep}`) && !path.isAbsolute(file));
    const trackedInputs = [...new Set((await checkedGit(sourceRoot, ["ls-files", "--cached", "-z"])).split("\0").filter(Boolean)
      .concat(execution ? (await checkedGit(root, ["ls-files", "--cached", "-z"])).split("\0").filter(Boolean) : []))];
    if (protocol === 2) assertArtifactInputs(excluded, trackedInputs.map((file) => path.join(sourceRoot, file)));
    for (const relative of relativeExclusions) if (relative === ".git" || relative.startsWith(`.git${path.sep}`)) throw new Error("Artifact destinations must stay outside Git metadata");
    if (reusedDependencies) relativeExclusions.push("node_modules");
    const snapshotOptions = { base: options.base, head: options.head, excludePaths: relativeExclusions };
    const gitSnapshot = await collectGitSnapshot(root, snapshotOptions);
    const before = gitSnapshot.identity ?? await captureSnapshotIdentity(root, snapshotOptions);
    const config = resolveConfig(root, input);
    const contract = loadContract(root, input.spec ?? config.spec ?? undefined);
    const baselinePath = findBaselinePath(root, { explicit: input.baseline, fromConfig: config.baseline });
    const baselineInput = baselinePath ? loadBaselineInput(baselinePath) : null;
    const baseline = baselineInput?.evidence ?? null;
    const originalPolicy = policyFor(config, protocol, contract, baselineInput?.identity ?? null);
    const policy = portablePolicy(originalPolicy, root, sourceRoot);
    assertArtifactInputs(excluded, [config.sourcePath, contract?.sourcePath, ...(contract?.inputPaths ?? []), baselinePath].filter((file): file is string => Boolean(file)).map((file) => portablePath(file, root, sourceRoot)));
    const outputs = new Set(relativeExclusions.map((file) => file.split(path.sep).join("/")));
    if (baselinePath) outputs.add(path.relative(root, baselinePath).split(path.sep).join("/"));
    const files = filterIgnored(hydrateUntrackedPatches(root, gitSnapshot.files).filter((file) => !outputs.has(file.path)), config.ignorePaths);
    const existing = new Set(gitSnapshot.trackedFiles.filter((file) => !outputs.has(file)));
    const allowPlugins = protocol === 1 || options.allowPlugins === true;
    const autoDirectory = path.join(root, ".patchprove", "plugins");
    const hasPlugins = config.plugins.length > 0 || Boolean(process.env.PATCHPROVE_PLUGINS) || existsSync(autoDirectory) && readdirSync(autoDirectory).some((file) => /\.(?:mjs|cjs|js)$/i.test(file));
    const pluginSession = await resolveLanguagePluginSession(root, { configPlugins: allowPlugins ? config.plugins : [], allowAuto: allowPlugins,
      env: allowPlugins ? process.env : { ...process.env, PATCHPROVE_PLUGINS: "" } });
    const plugins = pluginSession.plugins;
    policy.pluginSetHash = pluginSetHash(pluginSession.provenance, root);
    const { baseline: _baselinePolicy, hash: _policyHash, ...effectivePolicy } = policy;
    policy.hash = hashCanonical(effectivePolicy);
    const context = createPluginContext(root, existing);
    const graph = buildImportGraph(root, existing, plugins, undefined, context);
    let baseGraph;
    let baseContext;
    if (files.some((file) => file.status === "deleted") && before.base) {
      const ref = before.mergeBase ?? before.base;
      const oldFiles = await listVersionedFiles(root, ref);
      const contents = new Map<string, string | null>();
      for (const file of oldFiles.filter((file) => /\.(?:[cm]?[jt]sx?|py|go|rs|java|json|toml|gradle|kts)$/.test(file) || /(^|\/)go\.mod$/.test(file))) contents.set(file, await readVersionedFile(root, ref, file));
      baseContext = { cwd: root, existing: new Set(oldFiles), readFile: (file: string) => contents.get(file) ?? null };
      baseGraph = buildImportGraph(root, new Set(oldFiles), plugins, baseContext.readFile, baseContext);
    }
    const adapters = loadAdapterEvidence(options.adapterInputs ?? [], { cwd: sourceRoot, snapshotHash: before.contentHash });
    let coverage = loadCoverageMap(root);
    if (adapters.mappingEvidence.length) {
      const sourceToTests = new Map(coverage?.sourceToTests ?? []);
      for (const edge of adapters.mappingEvidence) sourceToTests.set(edge.source, [...new Set([...(sourceToTests.get(edge.source) ?? []), edge.test])]);
      coverage = { origin: "map", file: "adapter:testmon", sources: new Set([...(coverage?.sources ?? []), ...sourceToTests.keys()]),
        tests: new Set([...(coverage?.tests ?? []), ...[...sourceToTests.values()].flat()]), sourceToTests,
        inputHash: hashCanonical([coverage?.inputHash, adapters.mappingEvidence]), freshness: coverage ? "unknown" : "current" };
    }
    const impact = buildImpact(files, existing, { ignorePaths: config.ignorePaths, coverage, graph, plugins, pluginContext: context, baseGraph, basePluginContext: baseContext });
    const tools = detectTools(root, { deadlineAt, signal: controller.signal });
    const javaFileEncoding = declaredJavaFileEncoding();
    const environment = {
      platform: process.platform, arch: process.arch, nodeVersion: process.version,
      gitVersion: (await checkedGit(root, ["--version"])).trim(),
      tools: Object.entries(tools).filter(([name, value]) => name.endsWith("Bin") && typeof value === "string").map(([field, value]) => {
        const name = field.slice(0, -3);
        return { name, version: tools.versions?.[name === "maven" ? "mvn" : name] ?? null, path: realpathSync.native(value as string) };
      }).sort((a, b) => a.name.localeCompare(b.name)),
      dependencyLocks: [...existing].filter((file) => /(^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Pipfile\.lock)$/.test(file))
        .sort().map((file) => ({ path: file, hash: createHash("sha256").update(readBoundedFile(path.join(root, file))).digest("hex") })),
      inputLimits: limitsInput, hermetic: false as const,
      parser: JS_PARSER_IDENTITY,
      javaRuntimes: [...(tools.javaRuntimes ?? [])],
      plugins: pluginSession.provenance.map((plugin) => ({ ...plugin,
        entry: plugin.entry ? portablePath(plugin.entry, root, sourceRoot) : null,
        inputs: plugin.inputs.map((input) => ({ ...input, path: portablePath(input.path, root, sourceRoot) })),
        unknownDependencies: plugin.unknownDependencies.map((message) => message.replaceAll(root, sourceRoot)) })),
      ...(javaFileEncoding ? { javaToolOptionsFileEncoding: javaFileEncoding } : {}),
      configurations: [...existing].filter((file) => /(^|\/)(?:[tj]sconfig[^/]*\.json|package\.json|(?:vitest|vite|jest|eslint)\.config\.[^/]+|\.eslintrc[^/]*|pytest\.ini|pyproject\.toml|conftest\.py|setup\.cfg|tox\.ini|\.gitleaks(?:\.toml|ignore)|gitleaks\.toml|Cargo\.toml|go\.(?:mod|work)|pom\.xml|(?:build|settings)\.gradle(?:\.kts)?|gradle\.properties)$/.test(file))
        .sort().map((file) => ({ path: file, hash: createHash("sha256").update(readBoundedFile(path.join(root, file))).digest("hex") })),
    };
    const selected = [...new Set(impact.mappedTests.flatMap((mapped) => mapped.tests))].sort();
    const toolUnits: ToolUnit[] = [];
    const projectContexts: Array<{ path: string; cwd: string; tools: DetectedTools; context: ReturnType<typeof createPluginContext>; gates: Partial<Record<"typecheck" | "lint" | "tests" | "secrets", ProjectGatePolicy>> }> = [];
    const projectScopes: NonNullable<Evidence["projectScopes"]> = [];
    if (!config.projects?.some((project) => project.path === ".")) {
      toolUnits.push(...configuredToolUnits(root, "typecheck", tools, config.gates.typecheck), ...configuredToolUnits(root, "lint", tools, config.gates.lint));
    }
    const inside = (file: string, directory: string) => directory === "." || file === directory || file.startsWith(`${directory}/`);
    for (const project of config.projects ?? []) {
      const requestedDirectory = path.resolve(root, project.path);
      const directory = realpathSync.native(requestedDirectory);
      const relative = path.relative(realpathSync.native(root), directory);
      if (!statSync(directory).isDirectory() || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Project directory must stay inside the repository: ${project.path}`);
      const policyPath = config.sourcePath ? path.relative(root, config.sourcePath).split(path.sep).join("/") : null;
      const applicable = [...files.map((file) => file.path), ...selected].some((file) => inside(file, project.path)) || files.some((file) => file.path === policyPath);
      projectScopes.push({ path: project.path, applicable, reason: applicable ? "Changed paths, selected tests, or repository policy affect this project" : "No changed paths or selected tests in this project" });
      if (!applicable) continue;
      const detected = detectTools(directory, { deadlineAt, signal: controller.signal });
      detected.versions = { ...detected.versions };
      for (const [flag, binary, version] of [["typescript", "tscBin", "tsc"], ["eslint", "eslintBin", "eslint"], ["pyright", "pyrightBin", "pyright"], ["mypy", "mypyBin", "mypy"], ["ruff", "ruffBin", "ruff"], ["vitest", "vitestBin", "vitest"], ["jest", "jestBin", "jest"]] as const) {
        if (detected[flag] && !detected[binary] && tools[binary]) { detected[binary] = tools[binary]; if (tools.versions?.[version]) detected.versions[version] = tools.versions[version]; }
      }
      if (!detected.vitest && !detected.jest) {
        if (tools.vitestBin) { detected.vitest = true; detected.vitestBin = tools.vitestBin; if (tools.versions?.vitest) detected.versions.vitest = tools.versions.vitest; }
        else if (tools.jestBin) { detected.jest = true; detected.jestBin = tools.jestBin; if (tools.versions?.jest) detected.versions.jest = tools.versions.jest; }
      }
      const gates = Object.fromEntries(Object.entries(project.gates).map(([gate, declared]) => {
        const expiresAt = declared.expiresAt === undefined ? Infinity : Date.parse(declared.expiresAt) + (declared.expiresAt.includes("T") ? 0 : 86_400_000);
        return [gate, expiresAt <= Date.now() ? { ...declared, mode: "required", reason: `Previous ${gate} policy expired: ${declared.expiresAt}` } : declared];
      })) as typeof project.gates;
      const localFiles = new Set([...existing].filter((file) => inside(file, project.path)).map((file) => project.path === "." ? file : file.slice(project.path.length + 1)));
      projectContexts.push({ path: project.path, cwd: directory, tools: detected, context: createPluginContext(directory, localFiles), gates });
      for (const gate of ["typecheck", "lint"] as const) {
        const projectPolicy = gates[gate] ?? { mode: "optional" as const };
        toolUnits.push(...configuredToolUnits(directory, gate, detected, config.gates[gate], { path: project.path, policy: projectPolicy }));
      }
      environment.tools.push(...Object.entries(detected).filter(([name, value]) => name.endsWith("Bin") && typeof value === "string").map(([name, value]) => ({ name: `${project.path}:${name.slice(0, -3)}`, version: detected.versions?.[name.slice(0, -3) === "maven" ? "mvn" : name.slice(0, -3)] ?? null, path: realpathSync.native(value as string) })));
      environment.javaRuntimes.push(...(detected.javaRuntimes ?? []).map((runtime) => ({ ...runtime, project: project.path })));
    }
    const testUnits: TestUnit[] = [];
    const owner = (file: string) => projectContexts.filter((project) => inside(file, project.path)).sort((a, b) => b.path.length - a.path.length)[0];
    const rootFiles = selected.filter((file) => !owner(file));
    testUnits.push(...testExecutionUnits(rootFiles, plugins, context).map((unit) => config.gates.tests ? unit : { ...unit, required: false, inactiveReason: "Disabled by config (gates.tests: false)" }));
    for (const project of projectContexts) {
      const declared = project.gates.tests ?? { mode: "optional" as const };
      let projectTests = selected.filter((file) => owner(file) === project);
      if (!projectTests.length && declared.mode === "required") {
        projectTests = [...existing].filter((file) => owner(file) === project && plugins.some((plugin) => plugin.isTestFile(file, context)));
      }
      const prefix = project.path === "." ? "" : `${project.path}/`;
      const scoped = testExecutionUnits(projectTests.map((file) => prefix ? file.slice(prefix.length) : file), plugins, project.context, { project: project.path });
      const required = declared.mode === "required" || config.gates.tests && declared.mode !== "not-applicable";
      const inactiveReason = declared.mode === "not-applicable" ? `Not applicable: ${declared.reason}` : !required ? "Disabled by config (gates.tests: false)" : undefined;
      for (const unit of scoped) {
        testUnits.push({ ...unit, sourceFiles: unit.sourceFiles.map((file) => `${prefix}${file}`),
          scope: unit.granularity === "file" ? unit.scope.map((file) => `${prefix}${file}`) : unit.scope.map((item) => `${item.slice(0, item.indexOf(":") + 1)}${path.posix.join(project.path, item.slice(item.indexOf(":") + 1))}`),
          tools: project.tools, required, inactiveReason, policy: { ...declared, project: project.path } });
      }
      if (!scoped.length && project.gates.tests) {
        testUnits.push({ id: `tests:unconfigured:project:${project.path}`, plugin: { id: "unconfigured", languages: [], extensions: [], isTestFile: () => false, testCandidates: () => [] },
          sourceFiles: [], commandFiles: [], scope: [project.path], granularity: "file", cwd: project.cwd, required, policy: { ...declared, project: project.path },
          inactiveReason: inactiveReason ?? "Required tests have no known execution scopes" });
      }
    }
    const secretProjects = projectContexts.filter((project) => project.gates.secrets?.mode === "required");
    const secretFiles = (config.gates.secrets ? files : files.filter((file) => secretProjects.some((project) => inside(file.path, project.path))))
      .filter((file) => owner(file.path)?.gates.secrets?.mode !== "not-applicable");
    const plan = planFor(config, toolUnits, testUnits, selected, secretFiles.map((file) => file.path));
    if (!config.gates.secrets) for (const project of secretProjects) {
      const scope = secretFiles.filter((file) => inside(file.path, project.path)).map((file) => file.path);
      if (scope.length) plan.push({ id: `plan:secrets:project:${project.path}`, checkId: "secrets", scope, required: true, reason: "Project requires scanning selected added lines", policy: { ...project.gates.secrets!, project: project.path } });
    }
    const limits = { timeoutMs: timeout, maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024, signal: controller.signal };
    const [typecheck, lint, tests, secretScan] = await Promise.all([
      runTypecheck(root, tools, config.gates.typecheck, limits, toolUnits.filter((unit) => unit.checkId === "typecheck")), runLint(root, tools, config.gates.lint, limits, toolUnits.filter((unit) => unit.checkId === "lint")),
      runAffectedTests(root, tools, selected, config.gates.tests, plugins, context, limits, testUnits),
      runSecretScan(root, tools, secretFiles, gitSnapshot.range, config.gates.secrets || secretProjects.length > 0, limits),
    ]);
    for (const project of projectContexts.filter((project) => project.gates.secrets?.mode === "not-applicable")) {
      const id = `secrets:project:${project.path}:not-applicable`, reason = `Not applicable: ${project.gates.secrets!.reason}`;
      const record: ExecutionRecord = { id, checkId: "secrets", scope: [project.path], cwd: project.cwd, status: "not-applicable", required: false, reason, command: null, args: [], exitCode: null, durationMs: 0 };
      secretScan.check.records = [...(secretScan.check.records ?? []), record];
      plan.push({ id: `plan:${id}`, unitId: id, checkId: "secrets", scope: record.scope, required: false, reason, policy: { ...project.gates.secrets!, project: project.path } });
    }
    const changedPluginInputs = pluginSession.changedInputs();
    const after = await (async () => {
      try { return await captureSnapshotIdentity(root, snapshotOptions); }
      catch (error) {
        if (!controller.signal.aborted && Date.now() < deadlineAt) throw error;
        controller.abort();
        return { ...before, consistent: false, reason: "Verification deadline prevented the final snapshot check" };
      }
    })();
    const checks = [typecheck, lint, tests, secretScan.check];
    const records: ExecutionRecord[] = checks.flatMap((check) => check.records ?? []);
    records.push(...adapters.records);
    let evidence = buildEvidence({ cwd: path.resolve(options.cwd), root: sourceRoot, range: gitSnapshot.range, impact, checks,
      gaps: collectGaps(impact, checks, tools, plugins), findings: [...pathFindings(impact.changedFiles), ...secretScan.findings, ...failedCheckFindings(checks)], acceptGaps: config.acceptGaps });
    evidence = { ...evidence, repo: { ...evidence.repo, ...(config.repositoryId ? { repositoryId: config.repositoryId } : {}) }, schemaVersion: protocol === 1 ? COMPAT_SCHEMA_VERSION : SCHEMA_VERSION, toolVersion: TOOL_VERSION,
      snapshot: { ...before, consistent: before.consistent && after.consistent && before.contentHash === after.contentHash,
        ...((before.contentHash !== after.contentHash || !after.consistent) ? { reason: "Verification inputs changed during execution" } : {}) },
      executionRecords: records, verificationPlan: plan, effectivePolicy: policy, environment, resolutionProvenance: graph.provenance, ...(config.projects ? { projectScopes } : {}),
      diagnostics: [...(evidence.diagnostics ?? []), ...(config.diagnostics ?? []), ...adapters.diagnostics,
        ...(changedPluginInputs.length ? [{ code: "plugin-input-drift", message: "Plugin inputs changed during execution", severity: "error" as const, files: changedPluginInputs.map((file) => portablePath(file, root, sourceRoot)) }] : []),
        ...(!allowPlugins && hasPlugins ? [{ code: "plugins-not-authorized", message: "Local plugins were not executed; use --allow-plugins only for trusted repository code", severity: "error" as const }] : []),
        ...(reusedDependencies ? [{ code: "dependencies-reused", message: "Reused local node_modules after matching all discovered dependency manifests; installed dependency bytes are not a hermetic environment", severity: "warning" as const }] : []),
        ...(controller.signal.aborted ? [{ code: "run-deadline", message: "The total verification deadline was exceeded", severity: "error" as const }] : [])],
      mappingEvidence: [...(impact.mappingEvidence ?? []), ...adapters.mappingEvidence] };
    if ([originalPolicy.config, originalPolicy.spec, ...(originalPolicy.spec?.inputs ?? []), originalPolicy.baseline].some((item) => item && fileIdentity(item.path)?.hash !== item.hash)) {
      evidence.snapshot!.consistent = false; evidence.snapshot!.reason = "Policy input changed during execution";
    }
    if (changedPluginInputs.length) {
      evidence.snapshot!.consistent = false; evidence.snapshot!.reason = "Plugin inputs changed during execution";
    }
    evidence.gaps = evidence.gaps.map((gap) => ({ ...gap, fingerprint: gapFingerprint(gap) }));
    evidence.findings = evidence.findings.map((finding) => ({ ...finding, fingerprint: findingFingerprint(finding) }));
    evidence.contract = evaluateContract(contract, evidence);
    if (evidence.contract.source) evidence.contract.source = portablePath(evidence.contract.source, root, sourceRoot);
    if (baseline && baselinePath) evidence.baselineComparison = compareToBaseline(evidence, baseline, portablePath(baselinePath, root, sourceRoot), config.failOnNewGaps);
    evidence.verification = evaluateVerification(evidence, config);
    return evidence;
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", cancel);
    if (execution) await execution.cleanup();
  }
  })), evidence => { evidence.verification = evaluateVerification(evidence); });
}

export function writeEvidence(outPath: string, evidence: Evidence): string { return writeJsonAtomic(outPath, evidence); }
export function render(evidence: Evidence, format: RunOptions["format"]): string {
  if (format === "json") return `${JSON.stringify(evidence, null, 2)}\n`;
  return format === "markdown" ? formatMarkdownReport(evidence) : formatHumanReport(evidence);
}

export function produceArtifacts(evidence: Evidence, options: RunOptions, signingKey?: string | null): Evidence {
  const material = signingKey ?? retainSigningKey();
  validateArtifactOptions(options, material);
  const output = outputPath(options, options.out);
  const receiptPath = resolveReceiptPath(options);
  evidence = relativizeReportArtifacts(evidence, path.dirname(output));
  let result = evidence;
  const entries: import("./artifacts.js").ArtifactEntry[] = [];
  const serialize = (value: unknown) => withInputBudget({ limits: options.inputLimits }, () => stringifyBoundedJson(value));
  if (receiptPath) {
    const outcome = failOnOutcomeOf(evidence);
    const receipt = buildReceipt({ evidence, argv: options.argv ?? process.argv.slice(2), options, exitCode: outcome.failed ? 1 : 0, failOnOutcome: outcome, sign: options.sign, signingKey: material });
    result = attachReceiptRef(evidence, receipt, { path: path.relative(evidence.repo.root, canonicalPathParent(receiptPath)), previousContentHash: findPreviousReceiptHash(evidence.baselineComparison?.baselinePath) });
    entries.push({ path: receiptPath, content: serialize(receipt) });
  }
  entries.push({ path: output, content: serialize(result) });
  if (options.sarif) entries.push({ path: outputPath(options, options.sarif), content: serialize(toSarif(result)) });
  entries.push(...reportArtifactEntries(result, path.dirname(output)));
  writeArtifactSet(entries, `${output}.manifest.json`);
  return result;
}

/** Separate the signing secret from any target-controlled plugin or check environment. */
export async function analyzeAndWrite(options: RunOptions): Promise<{ evidence: Evidence; exitCode: number }> {
  const signingKey = retainSigningKey();
  validateArtifactOptions(options, signingKey);
  const evidence = produceArtifacts(await analyze(options), options, signingKey);
  return { evidence, exitCode: shouldFailRun(evidence) ? 1 : 0 };
}
export async function executeRun(options: RunOptions): Promise<number> {
  try {
    const { evidence, exitCode } = await analyzeAndWrite(options);
    const output = render(evidence, options.json ? "json" : options.format);
    process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
    if (!options.json && options.format !== "json") process.stderr.write(`wrote ${outputPath(options, options.out)}\n`);
    return exitCode;
  } catch (error) {
    process.stderr.write(`patchprove: ${error instanceof Error ? error.message : String(error)}\n`); return 2;
  }
}
