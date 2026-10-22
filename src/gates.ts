import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { closeSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { clip, runCommand, type CommandResult } from "./exec.js";
import type { DiffFile } from "./git.js";
import { builtinPlugins, type LanguagePlugin } from "./plugins/index.js";
import type { PluginContext } from "./plugins/types.js";
import { javaClassFromPath } from "./plugins/java.js";
import { scanSecrets } from "./secrets.js";
import type { CheckId, CheckResult, DetectedTools, ExecutionLimits, ExecutionRecord, Finding } from "./types.js";

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
  const skipped = parts.filter((p) => p.status === "skipped");
  return {
    id, name, status: failed.length ? "failed" : skipped.length ? "skipped" : "passed",
    reason: failed.length || skipped.length ? [...failed, ...skipped].map((p) => p.reason).join("; ") : "ok",
    command: parts.map((p) => p.command).filter(Boolean).join(" && ") || null,
    exitCode: failed[0]?.exitCode ?? (skipped.length ? null : 0),
    durationMs: parts.reduce((sum, p) => sum + (p.durationMs ?? 0), 0),
    detail: clip(parts.map((p) => p.detail).filter(Boolean).join("\n")),
    records: parts.flatMap((p) => p.records ?? []),
    timedOut: parts.some((p) => p.timedOut), truncated: parts.some((p) => p.truncated),
  };
}

interface ToolUnit { id: string; configured: boolean; command: string | null; args: string[] }

async function runUnits(cwd: string, id: "typecheck" | "lint", tools: DetectedTools, enabled: boolean,
  units: ToolUnit[], limits?: ExecutionLimits): Promise<CheckResult> {
  if (!enabled) return skipped(cwd, id, "disabled", `Disabled by config (gates.${id}: false)`);
  const parts: CheckResult[] = [];
  for (const unit of units) {
    if (!unit.configured && !unit.command) continue;
    if (!unit.command) {
      parts.push(skipped(cwd, id, unit.id, `${unit.id} configured but binary not found`));
      continue;
    }
    const result = await runCommand(unit.command, unit.args, { cwd, timeoutMs: GATE_TIMEOUT_MS, ...limits });
    parts.push(fromProcess(cwd, id, unit.id, `${id} (${unit.id})`, unit.command, unit.args, ["."], result, tools.versions?.[unit.id]));
  }
  return parts.length ? aggregate(id, id, parts) : skipped(cwd, id, "unconfigured", `No ${id === "lint" ? "linter" : "typechecker"} configured`);
}

export async function runTypecheck(cwd: string, tools: DetectedTools, enabled = true, limits?: ExecutionLimits): Promise<CheckResult> {
  return runUnits(cwd, "typecheck", tools, enabled, [
    { id: "tsc", configured: tools.typescript, command: tools.tscBin, args: ["--noEmit"] },
    { id: "pyright", configured: tools.pyright, command: tools.pyrightBin, args: [] },
    { id: "mypy", configured: tools.mypy, command: tools.mypyBin,
      args: tools.mypyBin && /^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(path.basename(tools.mypyBin)) ? ["-m", "mypy", "."] : ["."] },
  ], limits);
}

export async function runLint(cwd: string, tools: DetectedTools, enabled = true, limits?: ExecutionLimits): Promise<CheckResult> {
  return runUnits(cwd, "lint", tools, enabled, [
    { id: "eslint", configured: tools.eslint, command: tools.eslintBin, args: ["."] },
    { id: "ruff", configured: tools.ruff, command: tools.ruffBin, args: ["check", "."] },
  ], limits);
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

interface JavaReport { stamp: string; count: number; scope: string[] }

/** Read only bounded report headers; suite counts come from this invocation's changed files. */
function javaReports(cwd: string, scope: string[], gradle: boolean): Map<string, JavaReport> {
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
        result.set(file, { stamp: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
          count: Number(count), scope: matched.map((entry) => entry.file) });
      } catch { /* An absent, malformed, symbolic, or unreadable report supplies no execution proof. */ }
      finally { if (fd !== undefined) closeSync(fd); }
    }
  }
  return result;
}

export async function runAffectedTests(cwd: string, tools: DetectedTools, mappedTests: string[], enabled = true,
  plugins: readonly LanguagePlugin[] = builtinPlugins, ctx?: PluginContext, limits?: ExecutionLimits): Promise<CheckResult> {
  if (!enabled) return skipped(cwd, "tests", "disabled", "Disabled by config (gates.tests: false)", mappedTests);
  if (!mappedTests.length) return skipped(cwd, "tests", "unmapped", "No mapped tests for this diff", []);
  const parts: CheckResult[] = [];
  const covered = new Set<string>();
  const context = ctx ?? { cwd, existing: new Set(mappedTests) };
  for (const plugin of plugins) {
    const scope = mappedTests.filter((test) => plugin.extensions.includes(path.extname(test)));
    if (!scope.length) continue;
    for (const test of scope) covered.add(test);
    const cmd = plugin.testCommand?.(cwd, scope, tools, context);
    if (!cmd) {
      parts.push(skipped(cwd, "tests", plugin.id,
        plugin.missingTestRunnerReason?.(tools) ?? `No test runner available for ${plugin.id}`, scope));
      continue;
    }
    const args = cmd.args.filter((arg) => arg !== "--passWithNoTests");
    // Go's structured stream distinguishes a successful package build from executed tests.
    if (plugin.id === "go" && args[0] === "test" && !args.includes("-json")) args.splice(1, 0, "-json");
    const gradle = tools.gradleBin === cmd.command;
    const previousReports = plugin.id === "java" ? javaReports(cwd, scope, gradle) : undefined;
    const result = await runCommand(cmd.command, args, { cwd, timeoutMs: GATE_TIMEOUT_MS, ...limits });
    const freshReports = previousReports ? [...javaReports(cwd, scope, gradle)].filter(([file, report]) =>
      previousReports.get(file)?.stamp !== report.stamp).map(([, report]) => report) : undefined;
    const count = freshReports ? freshReports.reduce((sum, report) => sum + report.count, 0) :
      collectedTestCount(`${result.stdout}\n${result.stderr}`);
    const part = fromProcess(cwd, "tests", plugin.id, cmd.name, cmd.command, args, scope, result,
      tools.versions?.[plugin.id === "javascript" ? tools.vitestBin === cmd.command ? "vitest" : "jest" :
        plugin.id === "python" ? "pytest" : plugin.id === "rust" ? "cargo" : plugin.id === "java" ? tools.gradleBin === cmd.command ? "gradle" : "mvn" : plugin.id], count);
    if (freshReports && part.status === "passed") {
      const executed = new Set(freshReports.filter((report) => report.count > 0).flatMap((report) => report.scope));
      const missing = scope.filter((file) => !executed.has(file));
      if (missing.length) {
        part.records![0]!.scope = scope.filter((file) => executed.has(file));
        const uncollected = skipped(cwd, "tests", "java:uncollected", "Selected Java tests have no fresh execution report", missing);
        part.records!.push(...uncollected.records!);
        part.status = "skipped";
        part.reason = uncollected.reason;
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
  return file.patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1)).join("\n");
}

export async function runSecretScan(cwd: string, tools: DetectedTools, files: DiffFile[],
  range: { mode: string; base: string | null; head: string | null }, enabled = true,
  limits?: ExecutionLimits): Promise<{ check: CheckResult; findings: Finding[] }> {
  if (!enabled) return { check: skipped(cwd, "secrets", "disabled", "Disabled by config (gates.secrets: false)"), findings: [] };
  const started = Date.now();
  const scope = files.map((file) => file.path);
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
