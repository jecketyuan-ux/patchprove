import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseBoundedJson, readBoundedFile } from "./input-budget.js";
import type { TestExecution } from "./types.js";

const MAX_REPORT_BYTES = 16 * 1024 * 1024;
interface FileResult { collected: number; passed: number; failed: number; skipped: number }
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected machine-report object");
  return value as JsonObject;
}
function relativeFile(cwd: string, value: unknown, reportBase = cwd): string {
  if (typeof value !== "string" || !value) throw new Error("Machine report has no test file");
  const canonical = (file: string) => { try { return realpathSync.native(file); } catch { return path.resolve(file); } };
  const rel = path.relative(canonical(cwd), canonical(path.resolve(reportBase, value))).split(path.sep).join("/");
  if (!rel || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) throw new Error("Machine report test file is outside the project");
  return rel;
}

export function unknownTestExecution(format: TestExecution["format"], requested: string[], reason: string, reportStatus: TestExecution["reportStatus"] = "missing"): TestExecution {
  return { parserVersion: "1", format, reportStatus, granularity: "file", requestedScope: [...requested], collectedScope: [], executedScope: [], skippedScope: [], unknownScope: [...requested],
    counts: { collected: 0, executed: 0, passed: 0, failed: 0, skipped: 0 }, reason };
}

function summarize(format: TestExecution["format"], requested: string[], files: Map<string, FileResult>, raw: Buffer, reportPath?: string): TestExecution {
  const counts = { collected: 0, executed: 0, passed: 0, failed: 0, skipped: 0 };
  for (const [file, facts] of files) {
    if (!requested.includes(file)) continue;
    counts.collected += facts.collected; counts.passed += facts.passed; counts.failed += facts.failed; counts.skipped += facts.skipped;
  }
  counts.executed = counts.passed + counts.failed;
  return { parserVersion: "1", format, reportStatus: "validated", granularity: "file", requestedScope: [...requested],
    collectedScope: requested.filter((file) => (files.get(file)?.collected ?? 0) > 0),
    executedScope: requested.filter((file) => { const facts = files.get(file); return facts !== undefined && facts.passed + facts.failed > 0; }),
    skippedScope: requested.filter((file) => (files.get(file)?.skipped ?? 0) > 0),
    unknownScope: requested.filter((file) => !files.has(file) || files.get(file)!.collected === 0),
    counts, reportHash: createHash("sha256").update(raw).digest("hex"), ...(reportPath ? { reportPath } : {}) };
}

/** Only accept this invocation's unique, regular, bounded report file. */
export function readTestReport(format: "vitest-json" | "jest-json" | "pytest-junit" | "java-junit", reportPath: string, cwd: string, requested: string[], suiteFiles?: string[], reportBase = cwd): TestExecution {
  try {
    const stat = lstatSync(reportPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_REPORT_BYTES) throw new Error("Test report is not a bounded regular file");
    const raw = readBoundedFile(reportPath, MAX_REPORT_BYTES);
    if (raw.length > MAX_REPORT_BYTES) throw new Error("Test report exceeded the size budget");
    if (format === "pytest-junit" || format === "java-junit") return parseJunit(format, raw, cwd, requested, reportPath, suiteFiles, reportBase);
    const data = object(parseBoundedJson(raw.toString("utf8"), reportPath));
    if (!Array.isArray(data.testResults)) throw new Error("Machine report lacks testResults");
    const files = new Map<string, FileResult>();
    for (const value of data.testResults) {
      const suite = object(value);
      const file = relativeFile(cwd, suite.name ?? suite.testFilePath, reportBase);
      if (!requested.includes(file)) continue;
      if (files.has(file)) throw new Error(`Duplicate test file in report: ${file}`);
      if (!Array.isArray(suite.assertionResults)) throw new Error("Machine report lacks assertionResults");
      const facts = { collected: suite.assertionResults.length, passed: 0, failed: 0, skipped: 0 };
      for (const value of suite.assertionResults) {
        const status = object(value).status;
        if (status === "passed") facts.passed++;
        else if (status === "failed") facts.failed++;
        else if (["pending", "skipped", "todo", "disabled"].includes(String(status))) facts.skipped++;
        else throw new Error(`Unknown test case status: ${String(status)}`);
      }
      files.set(file, facts);
    }
    return summarize(format, requested, files, raw, reportPath);
  } catch (error) {
    return { ...unknownTestExecution(format, requested, `No usable fresh machine report: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error && "code" in error && error.code === "ENOENT" ? "missing" : "invalid"), reportPath };
  }
}

function attributes(text: string): Record<string, string> {
  return Object.fromEntries([...text.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((match) =>
    [match[1]!, (match[2] ?? match[3] ?? "").replace(/&(?:quot|apos|lt|gt|amp);|&#(?:x[0-9a-f]+|\d+);/gi, (entity) => {
      const fixed: Record<string, string> = { "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&amp;": "&" };
      if (fixed[entity]) return fixed[entity]!;
      const code = entity.startsWith("&#x") ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) throw new Error("Invalid XML character reference");
      return String.fromCodePoint(code);
    })]));
}

/** Deliberately bounded JUnit subset; never interprets DTDs or external entities. */
function parseJunit(format: "pytest-junit" | "java-junit", raw: Buffer, cwd: string, requested: string[], reportPath: string, suiteFiles?: string[], reportBase = cwd): TestExecution {
  const text = raw.toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || !/<testsuites?\b/.test(text)) throw new Error("Unsupported JUnit document");
  const files = new Map<string, FileResult>();
  const cases = [...text.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase\s*>)/g)];
  if (cases.length !== [...text.matchAll(/<testcase\b/g)].length) throw new Error("Malformed JUnit test cases");
  const suites = [...text.matchAll(/<testsuite\b([^>]*)>/g)];
  if (!suites.length || suites.some((suite) => !/^\d+$/.test(attributes(suite[1]!).tests ?? "")) ||
      suites.reduce((count, suite) => count + Number(attributes(suite[1]!).tests), 0) !== cases.length) {
    throw new Error("JUnit suite counts do not match its test cases");
  }
  for (const entry of cases) {
    const attrs = attributes(entry[1]!);
    const body = entry[2] ?? "";
    // pytest's xunit1 `file` is the definition location. For inherited tests,
    // classname identifies the collected module, which is the requested scope.
    const collectedModules = format === "pytest-junit" && attrs.classname ? requested.filter((file) => {
      const module = path.relative(reportBase, path.resolve(cwd, file)).split(path.sep).join(".").replace(/\.py$/, "");
      return attrs.classname === module || attrs.classname!.startsWith(`${module}.`);
    }).sort((a, b) => b.length - a.length) : [];
    const targets = suiteFiles ?? (collectedModules.length ? [collectedModules[0]!] : [relativeFile(cwd, attrs.file, reportBase)]);
    const skipped = /<skipped\b/.test(body);
    const failed = /<(?:failure|error)\b/.test(body);
    for (const file of targets) {
      if (!requested.includes(file)) continue;
      const facts = files.get(file) ?? { collected: 0, passed: 0, failed: 0, skipped: 0 };
      facts.collected++;
      if (failed) facts.failed++; else if (skipped) facts.skipped++; else facts.passed++;
      files.set(file, facts);
    }
  }
  return summarize(format, requested, files, raw, reportPath);
}

/** Cargo's stable libtest summary is used only for an explicitly coarse crate unit. */
export function cargoTestExecution(output: string, scope: string[], truncated = false): TestExecution {
  const proof = unknownTestExecution("cargo-harness", scope, "No complete Cargo/libtest result for this crate");
  proof.granularity = "crate";
  if (truncated) return { ...proof, reportStatus: "truncated" };
  const summaries = [...output.matchAll(/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;/gm)];
  const starts = [...output.matchAll(/^running (\d+) tests?\s*$/gm)];
  if (!summaries.length || summaries.length !== starts.length) return proof;
  const counts = { collected: 0, executed: 0, passed: 0, failed: 0, skipped: 0 };
  for (const [index, summary] of summaries.entries()) {
    const passed = Number(summary[1]), failed = Number(summary[2]), skipped = Number(summary[3]) + Number(summary[4]) + Number(summary[5]);
    if (Number(starts[index]![1]) !== passed + failed + Number(summary[3]) + Number(summary[4])) return proof;
    counts.passed += passed; counts.failed += failed; counts.skipped += skipped;
    counts.collected += passed + failed + skipped;
  }
  counts.executed = counts.passed + counts.failed;
  return { parserVersion: "1", format: "cargo-harness", reportStatus: "validated", granularity: "crate", requestedScope: scope,
    collectedScope: counts.collected ? scope : [], executedScope: counts.executed ? scope : [], skippedScope: counts.skipped ? scope : [],
    unknownScope: [], counts, reportHash: createHash("sha256").update(output).digest("hex") };
}

export function goTestExecution(output: string, scope: string[], packagePath: string, truncated = false): TestExecution {
  const proof = unknownTestExecution("go-json", scope, "No complete go test JSON events for this package");
  proof.granularity = "package";
  if (truncated) return { ...proof, reportStatus: "truncated" };
  try {
    const events = output.split(/\r?\n/).filter((line) => line.trim()).map((line) => object(JSON.parse(line) as unknown));
    if (events.some((event) => event.Package !== packagePath)) return proof;
    const cases = new Map<string, string>();
    let packageEnded = false;
    for (const event of events) {
      if (typeof event.Test === "string") {
        if (event.Action === "run") cases.set(event.Test, "running");
        if (["pass", "fail", "skip"].includes(String(event.Action))) {
          if (!cases.has(event.Test)) return proof;
          cases.set(event.Test, String(event.Action));
        }
      } else if (["pass", "fail", "skip"].includes(String(event.Action))) packageEnded = true;
    }
    if (!packageEnded || [...cases.values()].includes("running")) return proof;
    const counts = { collected: cases.size, executed: 0, passed: 0, failed: 0, skipped: 0 };
    for (const status of cases.values()) { if (status === "pass") counts.passed++; else if (status === "fail") counts.failed++; else counts.skipped++; }
    counts.executed = counts.passed + counts.failed;
    return { parserVersion: "1", format: "go-json", reportStatus: "validated", granularity: "package", requestedScope: scope,
      collectedScope: counts.collected ? scope : [], executedScope: counts.executed ? scope : [], skippedScope: counts.skipped ? scope : [], unknownScope: [], counts,
      reportHash: createHash("sha256").update(output).digest("hex") };
  } catch { return proof; }
}
