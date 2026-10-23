import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { closeSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { archiveMachineReport, ReportArchiveError } from "./report-archive.js";
import { createHash } from "node:crypto";
import { clip, runCommand, type CommandResult } from "./exec.js";
import type { DiffFile } from "./git.js";
import { builtinPlugins, type LanguagePlugin } from "./plugins/index.js";
import type { PluginContext } from "./plugins/types.js";
import { javaClassFromPath } from "./plugins/java.js";
import { scanSecrets } from "./secrets.js";
import { parseAddedLines } from "./added-lines.js";
import { cargoTestExecution, goTestExecution, readTestReport, unknownTestExecution } from "./test-results.js";
import { configuredToolUnits, testExecutionUnits, type TestUnit, type ToolUnit } from "./execution-units.js";
import type { CheckId, CheckResult, DetectedTools, ExecutionLimits, ExecutionRecord, Finding, TestExecution } from "./types.js";

const GATE_TIMEOUT_MS = 180_000;

function skipped(cwd: string, id: CheckId, unit: string, reason: string, scope: string[] = ["."]): CheckResult {
  return {
    id, name: id === "tests" ? "affected tests" : id, status: "skipped", reason,
    command: null, exitCode: null, durationMs: 0,
    records: [{ id: `${id}:${unit}`, checkId: id, scope, status: "skipped", command: null, args: [], cwd,
      exitCode: null, durationMs: 0, reason }],
  };
}

function fromProcess(cwd: string, id: CheckId, unit: string, name: string, command: string, args: string[],
  scope: string[], result: CommandResult, toolVersion?: string, collectedTests?: number): CheckResult {
  const empty = collectedTests === 0;
  const failed = result.exitCode !== 0 || Boolean(result.timedOut || result.aborted);
  const reason = result.timedOut ? "Execution timed out" : result.aborted ? "Execution aborted" :
    empty ? "Test runner collected zero tests" : failed ? `exit ${result.exitCode}` : "ok";
  return {
    id, name, status: failed ? "failed" : empty ? "skipped" : "passed", reason,
    command: result.command, exitCode: result.exitCode, durationMs: result.durationMs,
    detail: clip(`${result.stdout}\n${result.stderr}`), timedOut: result.timedOut, truncated: result.truncated,
    records: [{ id: `${id}:${unit}`, checkId: id, scope, status: result.timedOut ? "timed-out" : failed ? "failed" : empty ? "skipped" : "passed",
      command, args, cwd, exitCode: result.exitCode, durationMs: result.durationMs, reason,
      toolVersion, collectedTests, signal: result.signal, truncated: result.truncated, outputHash: result.outputHash }],
  };
}

function aggregate(id: CheckId, name: string, parts: CheckResult[]): CheckResult {
  if (parts.length === 1) return parts[0]!;
  const failed = parts.filter((p) => p.status === "failed");
  const skipped = parts.filter((p) => p.status === "skipped" && p.records?.some((record) => record.required !== false && record.status !== "not-applicable"));
  const executed = parts.some((part) => part.status === "passed");
  return {
    id, name, status: failed.length ? "failed" : skipped.length || !executed ? "skipped" : "passed",
    reason: failed.length || skipped.length ? [...failed, ...skipped].map((p) => p.reason).join("; ") : executed ? "ok" : parts.map((part) => part.reason).join("; "),
    command: parts.map((p) => p.command).filter(Boolean).join(" && ") || null,
    exitCode: failed[0]?.exitCode ?? (skipped.length || !executed ? null : 0),
    durationMs: parts.reduce((sum, p) => sum + (p.durationMs ?? 0), 0),
    detail: clip(parts.map((p) => p.detail).filter(Boolean).join("\n")),
    records: parts.flatMap((p) => p.records ?? []),
    timedOut: parts.some((p) => p.timedOut), truncated: parts.some((p) => p.truncated),
  };
}

async function runUnits(cwd: string, id: "typecheck" | "lint",
  units: ToolUnit[], limits?: ExecutionLimits): Promise<CheckResult> {
  const parts: CheckResult[] = [];
  for (const unit of units) {
    if (!unit.command) {
      const part = skipped(unit.cwd, id, unit.id.slice(id.length + 1), unit.reason, unit.scope);
      part.records![0]!.required = unit.required;
      if (unit.policy?.mode === "not-applicable") part.records![0]!.status = "not-applicable";
      parts.push(part);
      continue;
    }
    const result = await runCommand(unit.command, unit.args, { cwd: unit.cwd, timeoutMs: GATE_TIMEOUT_MS, ...limits });
    const part = fromProcess(unit.cwd, id, unit.id.slice(id.length + 1), `${id} (${unit.name})`, unit.command, unit.args, unit.scope, result, unit.toolVersion);
    part.records![0]!.required = unit.required;
    parts.push(part);
  }
  if (parts.length) return aggregate(id, id, parts);
  const empty = skipped(cwd, id, "unconfigured", `No applicable ${id} unit`); empty.records![0]!.required = false; return empty;
}

export async function runTypecheck(cwd: string, tools: DetectedTools, enabled = true, limits?: ExecutionLimits, units?: ToolUnit[]): Promise<CheckResult> {
  return runUnits(cwd, "typecheck", units ?? configuredToolUnits(cwd, "typecheck", tools, enabled), limits);
}

export async function runLint(cwd: string, tools: DetectedTools, enabled = true, limits?: ExecutionLimits, units?: ToolUnit[]): Promise<CheckResult> {
  return runUnits(cwd, "lint", units ?? configuredToolUnits(cwd, "lint", tools, enabled), limits);
}

/** Summaries are advisory when a runner has no count; explicit zero is never a passing execution. */
export function collectedTestCount(output: string): number | undefined {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  const events = text.split("\n").filter((line) => /^\s*\{/.test(line)).flatMap((line) => {
    try { return [JSON.parse(line) as { Action?: string; Test?: string; Output?: string }]; } catch { return []; }
  });
  const goRuns = events.filter((event) => event.Action === "run" && event.Test);
  if (goRuns.length) return goRuns.length;
  if (events.some((event) => event.Action === "pass") && !events.some((event) => event.Test)) return 0;
  const rust = [...text.matchAll(/\brunning (\d+) tests?\b/g)];
  if (rust.length) return rust.reduce((sum, m) => sum + Number(m[1]), 0);
  const total = /\bTests:\s*[^\n]*?\b(\d+) total\b/i.exec(text) ?? /\bTests\s+[^\n]*?\((\d+)\)/i.exec(text);
  if (total) return Number(total[1]);
  const collected = /\bcollected (\d+) items?\b/i.exec(text);
  if (collected) return Number(collected[1]);
  const pytest = [...text.matchAll(/\b(\d+) (?:passed|failed|skipped|xfailed|xpassed|deselected)\b/g)];
  if (pytest.length && /={2,}.*\b(?:passed|failed|skipped)\b.*={2,}/.test(text)) {
    return pytest.reduce((sum, m) => sum + Number(m[1]), 0);
  }
  const java = [...text.matchAll(/Tests run:\s*(\d+)/g)];
  if (java.length) return Math.max(...java.map((m) => Number(m[1])));
  const nodeCount = /^# tests (\d+)$/m.exec(text);
  if (nodeCount) return Number(nodeCount[1]);
  if (/no test (?:files|suites|cases|functions)?\s*(?:were )?found|no tests (?:found|collected|ran)|collected 0 items|\b0 tests?\b|:test\s+NO-SOURCE/i.test(text)) return 0;
  const goLines = text.split("\n").filter((line) => /^(?:ok|\?)\s+/.test(line));
  if (goLines.length && goLines.every((line) => /\[(?:no test files|no tests to run)\]/.test(line))) return 0;
  return undefined;
}

interface JavaReport { stamp: string; proof: TestExecution }

/** Read only bounded report headers; suite counts come from this invocation's changed files. */
function javaReports(cwd: string, scope: string[], gradle: boolean, retainReports = false, prior?: Map<string, JavaReport>): Map<string, JavaReport> {
  const result = new Map<string, JavaReport>();
  const directories = new Map<string, Array<{ file: string; className: string }>>();
  for (const file of scope) {
    const info = javaClassFromPath(file);
    const directory = path.resolve(cwd, info.moduleDir ?? ".", gradle ? "build/test-results/test" : "target/surefire-reports");
    const classes = directories.get(directory) ?? [];
    classes.push({ file, className: info.fqcn });
    directories.set(directory, classes);
  }
  for (const [directory, classes] of directories) {
    let names: string[];
    try { names = readdirSync(directory); } catch { continue; }
    for (const name of names) {
      if (!/^TEST-.+\.xml$/.test(name)) continue;
      const file = path.join(directory, name);
      let fd: number | undefined;
      try {
        const stat = lstatSync(file, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        fd = openSync(file, "r");
        const header = Buffer.alloc(64 * 1024);
        const text = header.subarray(0, readSync(fd, header, 0, header.length, 0)).toString("utf8");
        const suite = /<testsuite\s+([^>]+)>/.exec(text)?.[1];
        const suiteName = suite?.match(/\bname\s*=\s*["']([^"']*)["']/)?.[1];
        const count = suite?.match(/\btests\s*=\s*["'](\d+)["']/)?.[1];
        if (!suiteName || count === undefined) continue;
        const matched = classes.filter(({ className }) => suiteName === className || suiteName.startsWith(`${className}$`) ||
          (!className.includes(".") && (suiteName.endsWith(`.${className}`) || suiteName.includes(`.${className}$`))));
        if (!matched.length) continue;
        const selected = matched.map((entry) => entry.file);
        result.set(file, { stamp: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
          proof: readTestReport("java-junit", file, cwd, selected, selected, cwd, retainReports && prior?.get(file)?.stamp !== `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`) });
      } catch (error) { if (error instanceof ReportArchiveError) throw error; /* Unreadable reports supply no execution proof. */ }
      finally { if (fd !== undefined) closeSync(fd); }
    }
  }
  return result;
}

export async function runAffectedTests(cwd: string, tools: DetectedTools, mappedTests: string[], enabled = true,
  plugins: readonly LanguagePlugin[] = builtinPlugins, ctx?: PluginContext, limits?: ExecutionLimits, preparedUnits?: TestUnit[]): Promise<CheckResult> {
  if (!enabled && !preparedUnits) return skipped(cwd, "tests", "disabled", "Disabled by config (gates.tests: false)", mappedTests);
  if (!mappedTests.length && !preparedUnits?.length) return skipped(cwd, "tests", enabled ? "unmapped" : "disabled", enabled ? "No mapped tests for this diff" : "Disabled by config (gates.tests: false)", []);
  const parts: CheckResult[] = [];
  const covered = new Set<string>();
  const context = ctx ?? { cwd, existing: new Set(mappedTests) };
  for (const unit of preparedUnits ?? testExecutionUnits(mappedTests, plugins, context)) {
    const { plugin, sourceFiles, scope } = unit;
    for (const test of sourceFiles) covered.add(test);
    const unitTools = unit.tools ?? tools;
    const cmd = unit.inactiveReason ? null : plugin.testCommand?.(unit.cwd, unit.commandFiles, unitTools, unit.context ?? context);
    if (!cmd) {
      const part = skipped(unit.cwd, "tests", unit.id.slice(6), unit.inactiveReason ?? plugin.missingTestRunnerReason?.(unitTools) ?? `No test runner available for ${plugin.id}`, scope);
      part.records![0]!.required = unit.required;
      if (unit.policy?.mode === "not-applicable") part.records![0]!.status = "not-applicable";
      parts.push(part);
      continue;
    }
    const args = cmd.args.filter((arg) => arg !== "--passWithNoTests");
    // Go's structured stream distinguishes a successful package build from executed tests.
    if (plugin.id === "go" && args[0] === "test" && !args.includes("-json")) args.splice(1, 0, "-json");
    const gradle = unitTools.gradleBin === cmd.command;
    const previousReports = plugin.id === "java" ? javaReports(cwd, sourceFiles, gradle) : undefined;
    const fileFormat = cmd.reportFormat ?? (plugin.id === "python" ? "pytest-junit" : plugin.id === "javascript" ? unitTools.jestBin === cmd.command ? "jest-json" : "vitest-json" : undefined);
    const reportDir = fileFormat ? await mkdtemp(path.join(tmpdir(), "patchprove-test-report-")) : undefined;
    const reportPath = reportDir ? path.join(reportDir, fileFormat === "pytest-junit" ? "results.xml" : "results.json") : undefined;
    if (reportPath) args.push(...(fileFormat === "pytest-junit" ? [`--junitxml=${reportPath}`, "-o", "junit_family=xunit1"] : fileFormat === "jest-json" ? ["--json", "--outputFile", reportPath] : ["--reporter=json", "--outputFile", reportPath]));
    let result: CommandResult;
    let proof: TestExecution | undefined;
    try {
      result = await runCommand(cmd.command, args, { cwd: unit.cwd, timeoutMs: GATE_TIMEOUT_MS, ...limits });
      if (reportPath && fileFormat) proof = readTestReport(fileFormat, reportPath, cwd, scope, undefined, unit.cwd);
      if (plugin.id === "rust") proof = archiveMachineReport({ format: "cargo-harness", raw: result.stdoutBytes ?? Buffer.from(result.stdout), cwd, requestedScope: scope, truncated: result.truncated }, cargoTestExecution(result.stdout, scope, result.truncated));
      if (plugin.id === "go") {
        const target = args.find((arg) => arg === "." || arg.startsWith("./"));
        const listed = await runCommand(cmd.command, ["list", "-json", target ?? "."], { cwd: unit.cwd, timeoutMs: GATE_TIMEOUT_MS, ...limits });
        try {
          const pkg = JSON.parse(listed.stdout) as { ImportPath?: string; Dir?: string; TestGoFiles?: string[]; XTestGoFiles?: string[] };
          const eligible = [...(pkg.TestGoFiles ?? []), ...(pkg.XTestGoFiles ?? [])].map((file) => path.relative(cwd, path.join(pkg.Dir ?? cwd, file)).split(path.sep).join("/"));
          proof = listed.exitCode === 0 && !listed.truncated && typeof pkg.ImportPath === "string" ? goTestExecution(result.stdout, scope, pkg.ImportPath, result.truncated) : unknownTestExecution("go-json", scope, "go list could not establish package identity");
          proof.eligibleSourceFiles = eligible.filter((file) => sourceFiles.includes(file));
          if (sourceFiles.some((file) => !eligible.includes(file))) {
            proof.unknownScope = scope; proof.reason = "Selected Go test files are excluded by this build configuration";
          }
        } catch { proof = unknownTestExecution("go-json", scope, "No usable go list package metadata"); }
        proof.granularity = "package";
        proof = archiveMachineReport({ format: "go-json", raw: result.stdoutBytes ?? Buffer.from(result.stdout), cwd, requestedScope: scope, sourceFiles,
          truncated: result.truncated, goListOutput: listed.stdout, goListRaw: listed.stdoutBytes ?? Buffer.from(listed.stdout), goListExitCode: listed.exitCode, goListTruncated: listed.truncated }, proof);
      }
    } finally {
      if (reportDir) await rm(reportDir, { recursive: true, force: true });
    }
    const freshReports = previousReports ? [...javaReports(cwd, sourceFiles, gradle, true, previousReports)].filter(([file, report]) =>
      previousReports.get(file)?.stamp !== report.stamp).map(([, report]) => report) : undefined;
    if (freshReports) {
      const sum = (field: keyof TestExecution["counts"]) => freshReports.reduce((total, report) => total + report.proof.counts[field], 0);
      const observed = (field: "collectedScope" | "executedScope" | "skippedScope") => scope.filter((file) => freshReports.some((report) => report.proof[field].includes(file)));
      const allValid = freshReports.length > 0 && freshReports.every((report) => report.proof.reportStatus === "validated");
      proof = { parserVersion: "1", format: "java-junit", reportStatus: allValid ? "validated" : freshReports.length ? "partial" : "missing", granularity: "file", requestedScope: scope,
        collectedScope: observed("collectedScope"), executedScope: observed("executedScope"), skippedScope: observed("skippedScope"),
        unknownScope: scope.filter((file) => !observed("collectedScope").includes(file)),
        counts: { collected: sum("collected"), executed: sum("executed"), passed: sum("passed"), failed: sum("failed"), skipped: sum("skipped") },
        reportRetention: freshReports.some(report => report.proof.reports?.length) ? "retained" : "not-retained",
        ...(freshReports.some(report => report.proof.reports?.length) ? { reports: freshReports.flatMap(report => report.proof.reports ?? []) } : {}),
        ...(freshReports.length ? { reportHash: createHash("sha256").update(JSON.stringify(freshReports.map((report) => report.proof.reportHash ?? null).sort())).digest("hex") } : { reason: "No tests execution report was produced for the selected Java scope" }) };
    }
    proof ??= unknownTestExecution("unavailable", scope, `No supported result adapter for plugin ${plugin.id}`);
    proof.sourceFiles = sourceFiles;
    const count = proof.reportStatus === "validated" || proof.reportStatus === "partial" ? proof.counts.collected : undefined;
    const persistedArgs = reportPath ? args.map(arg => arg.replace(reportPath, "<test-report>")) : args;
    const part = fromProcess(unit.cwd, "tests", unit.id.slice(6), cmd.name, cmd.command, persistedArgs, scope, result,
      unitTools.versions?.[plugin.id === "javascript" ? unitTools.vitestBin === cmd.command ? "vitest" : "jest" :
        plugin.id === "python" ? "pytest" : plugin.id === "rust" ? "cargo" : plugin.id === "java" ? unitTools.gradleBin === cmd.command ? "gradle" : "mvn" : plugin.id], count);
    if (reportPath) part.command = [cmd.command, ...persistedArgs].join(" ");
    part.records![0]!.required = unit.required;
    if (proof) {
      const execution = part.records![0]!;
      execution.testExecution = proof;
      execution.scope = proof.executedScope.filter((file) => !proof!.unknownScope.includes(file));
      if (part.status !== "failed" && execution.scope.length === 0) execution.status = "skipped";
      const missing = scope.filter((file) => !proof!.executedScope.includes(file) || proof!.unknownScope.includes(file));
      if (part.status !== "failed" && (missing.length > 0 || proof.counts.skipped > 0)) {
        const unverified = [...new Set([...missing, ...proof.skippedScope])];
        const uncollected = skipped(cwd, "tests", `${unit.id.slice(6)}:unverified`, proof.reason ?? (proof.counts.collected === 0 ? "Test runner collected zero tests" : "Selected tests were excluded, skipped, or have no execution report"), unverified);
        part.records!.push(...uncollected.records!);
        part.status = "skipped"; part.reason = uncollected.reason;
      }
      if (proof.counts.failed > 0 && part.status !== "failed") {
        part.status = "failed"; part.reason = "Machine report contains failed tests";
        execution.status = "failed";
      }
    }
    // A truncated summary cannot establish whether test collection succeeded.
    if (result.truncated && count === undefined && part.status === "passed") {
      part.status = "failed";
      part.reason = "Test output truncated before collection could be established";
      part.exitCode = 1;
      Object.assign(part.records![0]!, { status: "failed", reason: part.reason, exitCode: 1 });
    }
    parts.push(part);
  }
  const uncovered = mappedTests.filter((test) => !covered.has(test));
  if (uncovered.length) parts.push(skipped(cwd, "tests", "unsupported", "No language plugin can execute these mapped tests", uncovered));
  return aggregate("tests", "affected tests", parts);
}

function selectedAddedText(file: DiffFile): string {
  return parseAddedLines(file).map((line) => line.text).join("\n");
}

export async function runSecretScan(cwd: string, tools: DetectedTools, files: DiffFile[],
  range: { mode: string; base: string | null; head: string | null }, enabled = true,
  limits?: ExecutionLimits): Promise<{ check: CheckResult; findings: Finding[] }> {
  if (!enabled) return { check: skipped(cwd, "secrets", "disabled", "Disabled by config (gates.secrets: false)"), findings: [] };
  const started = Date.now();
  const scope = files.map((file) => file.path);
  // Validate every selected patch even when a detector intentionally ignores
  // that file type. Missing input must not become a successful empty scan.
  for (const file of files) parseAddedLines(file);
  const findings = scanSecrets(files);
  const status = findings.length ? "failed" : "passed";
  const reason = findings.length ? `${findings.length} potential secret(s)` : "no known key patterns or high-entropy tokens in added lines";
  const records: ExecutionRecord[] = [{ id: "secrets:regex", checkId: "secrets", scope, status, command: null,
    args: [], cwd, exitCode: findings.length ? 1 : 0, durationMs: Date.now() - started, reason,
    toolVersion: "builtin-regex-v1", outputHash: createHash("sha256").update(JSON.stringify(findings)).digest("hex") }];
  const parts: CheckResult[] = [{ id: "secrets", name: "secret scan (regex)", status, reason,
    command: null, exitCode: findings.length ? 1 : 0, durationMs: records[0]!.durationMs, records }];
  if (tools.gitleaksBin) {
    let temp: string | undefined;
    try {
      temp = await mkdtemp(path.join(tmpdir(), "patchprove-secrets-"));
      const selected = path.join(temp, "selected");
      await mkdir(selected, { mode: 0o700 });
      for (const [index, file] of files.entries()) {
        if (file.status === "deleted") continue;
        const content = selectedAddedText(file);
        if (!content) continue;
        const name = `${index}-${path.basename(file.path).replace(/[^A-Za-z0-9_.-]/g, "_")}`;
        await writeFile(path.join(selected, name), content, { mode: 0o600 });
      }
      // Directory mode scans exactly the selected added content, independent of Git staging state.
      const version = tools.versions?.gitleaks?.match(/(\d+)\.(\d+)/);
      const modern = !version || Number(version[1]) > 8 || Number(version[1]) === 8 && Number(version[2]) >= 19;
      const args = modern ? ["dir", selected, "--no-banner", "--redact", "--exit-code=1"] :
        ["detect", "--no-git", `--source=${selected}`, "--no-banner", "--redact", "--exit-code=1"];
      const result = await runCommand(tools.gitleaksBin, args, { cwd, timeoutMs: 60_000, ...limits });
      const part = fromProcess(cwd, "secrets", "gitleaks", "secret scan (gitleaks)", tools.gitleaksBin,
        args, scope, result, tools.versions?.gitleaks);
      // Scanner output is never persisted: older/custom scanners may ignore --redact.
      delete part.detail;
      if (part.status === "failed") {
        part.reason = result.timedOut ? "Secret scanner timed out" : result.aborted ? "Secret scanner aborted" :
          result.exitCode === 1 ? "gitleaks reported potential secrets in selected added lines" : "gitleaks failed to scan selected added lines";
        part.records![0]!.reason = part.reason;
        if (result.exitCode === 1 && !result.timedOut && !result.aborted) findings.push({ id: "secret-gitleaks", kind: "secret", risk: "critical", message: "gitleaks reported potential secrets in selected added lines" });
      }
      // Temporary paths vary between runs and carry no evidentiary identity.
      const stableArgs = args.map((arg) => arg.replace(selected, "<selected-added-lines>"));
      part.records![0]!.args = stableArgs;
      part.command = [tools.gitleaksBin, ...stableArgs].join(" ");
      parts.push(part);
    } catch {
      const part = skipped(cwd, "secrets", "gitleaks", "Unable to prepare selected content for gitleaks", scope);
      part.status = "failed";
      part.exitCode = 1;
      Object.assign(part.records![0]!, { status: "failed", exitCode: 1 });
      parts.push(part);
    } finally {
      if (temp) await rm(temp, { recursive: true, force: true });
    }
  }
  return { check: aggregate("secrets", "secret scan", parts), findings };
}
