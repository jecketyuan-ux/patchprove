import { existsSync, readFileSync, readdirSync, realpathSync, symlinkSync } from "node:fs";
import path from "node:path";
import { loadAdapterEvidence } from "./adapters.js";
import { writeArtifactSet, writeJsonAtomic } from "./artifacts.js";
import { compareToBaseline, findBaselinePath, loadBaselineInput, newGapsMeetFailOn } from "./baseline.js";
import { resolveConfig } from "./config.js";
import { loadCoverageMap } from "./coverage.js";
import { evaluateVerification } from "./decision.js";
import { detectTools } from "./detect.js";
import { buildEvidence, buildImpact, collectGaps, failedCheckFindings, filterIgnored, pathFindings } from "./evidence.js";
import { gapFingerprint, findingFingerprint } from "./fingerprint.js";
import { runAffectedTests, runLint, runSecretScan, runTypecheck } from "./gates.js";
import { collectGitSnapshot, type DiffFile } from "./git.js";
import { buildImportGraph } from "./graph.js";
import { canonicalPathParent } from "./paths.js";
import { createPluginContext, resolveLanguagePlugins } from "./plugins/index.js";
import { attachReceiptRef, buildReceipt, defaultReceiptPath, findPreviousReceiptHash, hashCanonical } from "./receipt.js";
import { formatHumanReport, formatMarkdownReport } from "./report.js";
import { meetsFailOn } from "./risk.js";
import { toSarif } from "./sarif.js";
import { captureSnapshotIdentity, checkedGit, createExecutionSnapshot, listVersionedFiles, readVersionedFile, repositoryRoot, withGitExecutionBudget } from "./snapshot.js";
import { evaluateContract, loadContract } from "./spec.js";
import { COMPAT_SCHEMA_VERSION, SCHEMA_VERSION, TOOL_VERSION } from "./types.js";
import type { DetectedTools, EffectivePolicy, Evidence, ExecutionRecord, FailOnOutcomeReason, PatchproveContract, ResolvedConfig, RunOptions, VerificationPlanItem } from "./types.js";
import { validateEvidence } from "./validation.js";

let retainedSigningKey: string | undefined;
function retainSigningKey(): string | undefined {
  if (process.env.PATCHPROVE_SIGNING_KEY) retainedSigningKey = process.env.PATCHPROVE_SIGNING_KEY;
  delete process.env.PATCHPROVE_SIGNING_KEY;
  return retainedSigningKey;
}

export function hydrateUntrackedPatches(root: string, files: DiffFile[]): DiffFile[] {
  return files.map((file) => {
    if (file.patch || file.status === "deleted" || !["untracked", "added"].includes(file.status)) return file;
    const content = readFileSync(path.join(root, file.path), "utf8");
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
    return path.join(realpathSync(ancestor), ...missing);
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
    try { value = JSON.parse(readFileSync(output, "utf8")) as Record<string, unknown>; } catch { /* An existing unrelated file is an input. */ }
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        !(Array.isArray(value.checks) && (Array.isArray(value.gaps) || typeof value.contentHash === "string") || Array.isArray(value.runs) && value.version === "2.1.0" || Array.isArray(value.artifacts) && typeof value.runId === "string")) {
      throw new Error(`Artifact destination already contains an unrelated input: ${output}`);
    }
  }
}
function fileIdentity(file: string | null): { path: string; hash: string } | null {
  return file ? { path: file, hash: hashCanonical(readFileSync(file, "utf8")) } : null;
}
function policyFor(config: ResolvedConfig, protocol: 1 | 2, contract: PatchproveContract | null, baseline: { path: string; hash: string } | null): EffectivePolicy {
  const spec = contract?.inputIdentities?.[0] ?? fileIdentity(contract?.sourcePath ?? null);
  const specInputs = contract?.inputIdentities ?? contract?.inputPaths?.map((file) => fileIdentity(file)!);
  const policy: EffectivePolicy = { protocol, strict: config.strict ?? protocol === 2,
    failOn: config.failOn ?? null, failOnNewGaps: config.failOnNewGaps ?? null,
    gates: config.gates, ignorePaths: config.ignorePaths, acceptGaps: config.acceptGaps, plugins: config.plugins,
    config: config.sourcePath ? { path: config.sourcePath, hash: config.sourceHash ?? fileIdentity(config.sourcePath)!.hash } : null,
    spec: spec && specInputs ? { ...spec, inputs: specInputs } : spec, baseline, hash: "" };
  const { baseline: _baseline, hash: _hash, ...effective } = policy;
  policy.hash = hashCanonical(effective);
  return policy;
}
function portablePolicy(policy: EffectivePolicy, executionRoot: string, sourceRoot: string): EffectivePolicy {
  const normalize = (item: { path: string; hash: string } | null) => item ? { ...item, path: item.path.startsWith(`${executionRoot}${path.sep}`) ? path.join(sourceRoot, path.relative(executionRoot, item.path)) : item.path } : null;
  const spec = normalize(policy.spec);
  const result: EffectivePolicy = { ...policy, config: normalize(policy.config), spec: spec && policy.spec?.inputs ? { ...spec, inputs: policy.spec.inputs.map((item) => normalize(item)!) } : spec, baseline: normalize(policy.baseline) };
  const { baseline: _baseline, hash: _hash, ...effective } = result;
  result.hash = hashCanonical(effective);
  return result;
}
function planFor(tools: DetectedTools, config: ResolvedConfig, tests: string[], changed: string[]): VerificationPlanItem[] {
  const plan: VerificationPlanItem[] = [];
  for (const [tool, configured] of [["tsc", tools.typescript || Boolean(tools.tscBin)], ["pyright", tools.pyright || Boolean(tools.pyrightBin)], ["mypy", tools.mypy || Boolean(tools.mypyBin)]] as const) {
    if (configured && config.gates.typecheck) plan.push({ id: `plan:typecheck:${tool}`, unitId: `typecheck:${tool}`, checkId: "typecheck", scope: ["."], required: true, reason: `${tool} is configured` });
  }
  for (const [tool, configured] of [["eslint", tools.eslint || Boolean(tools.eslintBin)], ["ruff", tools.ruff || Boolean(tools.ruffBin)]] as const) {
    if (configured && config.gates.lint) plan.push({ id: `plan:lint:${tool}`, unitId: `lint:${tool}`, checkId: "lint", scope: ["."], required: true, reason: `${tool} is configured` });
  }
  if (tests.length && config.gates.tests) plan.push({ id: "plan:tests", checkId: "tests", scope: tests, required: true, reason: "Changed tests and conservative dependency selection" });
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
    if (existsSync(sourceFile) && !readFileSync(sourceFile).equals(readFileSync(targetFile))) return false;
  }
  // npm/pnpm workspace links can resolve into the live checkout even when the
  // package manifests match. Such links would escape the isolated code tree.
  const dependencyRoot = realpathSync(path.join(source, "node_modules"));
  const pending = [dependencyRoot];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let resolved: string;
        try { resolved = realpathSync(candidate); } catch { return false; }
        const relative = path.relative(dependencyRoot, resolved);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
      } else if (entry.isDirectory()) pending.push(candidate);
    }
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
  const protocol = options.protocol ?? 2;
  const timeout = options.timeoutMs ?? 180_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error("timeoutMs must be a positive integer");
  const controller = new AbortController();
  const deadlineAt = Date.now() + timeout;
  const deadline = setTimeout(() => controller.abort(), timeout);
  let execution: Awaited<ReturnType<typeof createExecutionSnapshot>> | undefined;
  let reusedDependencies = false;
  return withGitExecutionBudget({ signal: controller.signal, deadline: deadlineAt }, async () => {
  try {
    const sourceRoot = await repositoryRoot(path.resolve(options.cwd));
    if ((options.base !== undefined || options.head !== undefined) && options.isolate !== false) {
      execution = await createExecutionSnapshot(sourceRoot, options.head ?? "HEAD");
      reusedDependencies = await provisionMatchingNodeDependencies(sourceRoot, execution.root, options.head ?? "HEAD");
    }
    const root = execution?.root ?? sourceRoot;
    const input = remapOptions(options, sourceRoot, root);
    const excluded = artifactPaths({ ...options, cwd: sourceRoot }).map(canonicalPathParent);
    if (protocol === 2) assertArtifactDestinations(excluded);
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
    const plugins = await resolveLanguagePlugins(root, { configPlugins: allowPlugins ? config.plugins : [], allowAuto: allowPlugins,
      env: allowPlugins ? process.env : { ...process.env, PATCHPROVE_PLUGINS: "" } });
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
    const selected = [...new Set(impact.mappedTests.flatMap((mapped) => mapped.tests))].sort();
    const plan = planFor(tools, config, selected, files.map((file) => file.path));
    const limits = { timeoutMs: timeout, maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024, signal: controller.signal };
    const [typecheck, lint, tests, secretScan] = await Promise.all([
      runTypecheck(root, tools, config.gates.typecheck, limits), runLint(root, tools, config.gates.lint, limits),
      runAffectedTests(root, tools, selected, config.gates.tests, plugins, context, limits),
      runSecretScan(root, tools, files, gitSnapshot.range, config.gates.secrets, limits),
    ]);
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
    evidence = { ...evidence, schemaVersion: protocol === 1 ? COMPAT_SCHEMA_VERSION : SCHEMA_VERSION, toolVersion: TOOL_VERSION,
      snapshot: { ...before, consistent: before.consistent && after.consistent && before.contentHash === after.contentHash,
        ...((before.contentHash !== after.contentHash || !after.consistent) ? { reason: "Verification inputs changed during execution" } : {}) },
      executionRecords: records, verificationPlan: plan, effectivePolicy: policy,
      diagnostics: [...(evidence.diagnostics ?? []), ...(config.diagnostics ?? []), ...adapters.diagnostics,
        ...(!allowPlugins && hasPlugins ? [{ code: "plugins-not-authorized", message: "Local plugins were not executed; use --allow-plugins only for trusted repository code", severity: "error" as const }] : []),
        ...(reusedDependencies ? [{ code: "dependencies-reused", message: "Reused local node_modules after matching all discovered dependency manifests; installed dependency bytes are not a hermetic environment", severity: "warning" as const }] : []),
        ...(controller.signal.aborted ? [{ code: "run-deadline", message: "The total verification deadline was exceeded", severity: "error" as const }] : [])],
      mappingEvidence: [...(impact.mappingEvidence ?? []), ...adapters.mappingEvidence] };
    if ([originalPolicy.config, originalPolicy.spec, ...(originalPolicy.spec?.inputs ?? []), originalPolicy.baseline].some((item) => item && fileIdentity(item.path)?.hash !== item.hash)) {
      evidence.snapshot!.consistent = false; evidence.snapshot!.reason = "Policy input changed during execution";
    }
    evidence.gaps = evidence.gaps.map((gap) => ({ ...gap, fingerprint: gapFingerprint(gap) }));
    evidence.findings = evidence.findings.map((finding) => ({ ...finding, fingerprint: findingFingerprint(finding) }));
    evidence.contract = evaluateContract(contract, evidence);
    if (evidence.contract.source) evidence.contract.source = portablePath(evidence.contract.source, root, sourceRoot);
    if (baseline && baselinePath) evidence.baselineComparison = compareToBaseline(evidence, baseline, portablePath(baselinePath, root, sourceRoot), config.failOnNewGaps);
    evidence.verification = evaluateVerification(evidence, config);
    return validateEvidence(evidence, "generated evidence");
  } finally {
    clearTimeout(deadline);
    if (execution) await execution.cleanup();
  }
  });
}

export function writeEvidence(outPath: string, evidence: Evidence): string { return writeJsonAtomic(outPath, evidence); }
export function render(evidence: Evidence, format: RunOptions["format"]): string {
  if (format === "json") return `${JSON.stringify(evidence, null, 2)}\n`;
  return format === "markdown" ? formatMarkdownReport(evidence) : formatHumanReport(evidence);
}

export function produceArtifacts(evidence: Evidence, options: RunOptions, signingKey?: string | null): Evidence {
  const output = outputPath(options, options.out);
  const receiptPath = resolveReceiptPath(options);
  let result = evidence;
  const entries: Array<{ path: string; content: string }> = [];
  if (receiptPath) {
    const outcome = failOnOutcomeOf(evidence);
    const receipt = buildReceipt({ evidence, argv: options.argv ?? process.argv.slice(2), options, exitCode: outcome.failed ? 1 : 0, failOnOutcome: outcome, sign: options.sign, signingKey });
    result = attachReceiptRef(evidence, receipt, { path: path.relative(evidence.repo.root, canonicalPathParent(receiptPath)), previousContentHash: findPreviousReceiptHash(evidence.baselineComparison?.baselinePath) });
    entries.push({ path: receiptPath, content: `${JSON.stringify(receipt, null, 2)}\n` });
  }
  entries.push({ path: output, content: `${JSON.stringify(result, null, 2)}\n` });
  if (options.sarif) entries.push({ path: outputPath(options, options.sarif), content: `${JSON.stringify(toSarif(result), null, 2)}\n` });
  writeArtifactSet(entries, `${output}.manifest.json`);
  return result;
}

/** Separate the signing secret from any target-controlled plugin or check environment. */
export async function analyzeAndWrite(options: RunOptions): Promise<{ evidence: Evidence; exitCode: number }> {
  const signingKey = retainSigningKey();
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
