import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { assertInputActive, parseBoundedJson, readBoundedFile } from "./input-budget.js";
import { parseJunitXml, type JunitXmlElement } from "./junit-xml.js";
import { javaClassFromPath } from "./plugins/java.js";
import { archiveMachineReport, ReportArchiveError } from "./report-archive.js";
import type { JavaTestRuntimeObservation, TestExecution } from "./types.js";

const MAX_REPORT_BYTES = 16 * 1024 * 1024;
interface FileResult { collected: number; passed: number; failed: number; skipped: number }
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected machine-report object");
  return value as JsonObject;
}
export interface ReportReplayPaths { platform: "win32" | "posix"; aliases: Array<{ from: string; to: string }>; exact?: boolean }
type ObservePath = (from: string, to: string) => void;
function relativeFile(cwd: string, value: unknown, reportBase = cwd, replay?: ReportReplayPaths, observe?: ObservePath): string {
  if (typeof value !== "string" || !value) throw new Error("Machine report has no test file");
  const paths = replay ? replay.platform === "win32" ? path.win32 : path.posix : path;
  const canonical = (file: string): string => {
    const resolved = paths.resolve(file);
    if (replay) {
      const comparable = replay.platform === "win32" ? resolved.toLowerCase() : resolved;
      for (const alias of [...replay.aliases].sort((a, b) => b.from.length - a.from.length)) {
        const from = replay.platform === "win32" ? alias.from.toLowerCase() : alias.from;
        if (comparable === from || !replay.exact && comparable.startsWith(`${from}${paths.sep}`)) return alias.to + resolved.slice(alias.from.length);
      }
      if (replay.exact) throw new ReportArchiveError("Missing original canonical path observation for report replay");
      return resolved;
    }
    let observed: string;
    try { observed = realpathSync.native(file); } catch { observed = resolved; }
    observe?.(resolved, observed);
    return observed;
  };
  const rel = paths.relative(canonical(cwd), canonical(paths.resolve(reportBase, value))).split(paths.sep).join("/");
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
export function readTestReport(format: "vitest-json" | "jest-json" | "pytest-junit" | "java-junit", reportPath: string, cwd: string, requested: string[], suiteFiles?: string[], reportBase = cwd, retainReport = true, replay?: ReportReplayPaths): TestExecution {
  let raw: Buffer | undefined;
  const observations = new Map<string, string>();
  const observe: ObservePath | undefined = replay ? undefined : (from, to) => {
    if (observations.has(from) && observations.get(from) !== to) throw new ReportArchiveError("Report path identity changed while parsing machine report");
    observations.set(from, to);
  };
  const retain = (proof: TestExecution): TestExecution => {
    if (!raw || !retainReport) { delete proof.reportPath; proof.reportRetention = "not-retained"; return proof; }
    return archiveMachineReport({ format, raw, cwd, requestedScope: requested, suiteFiles, reportBase, pathAliasMode: "exact",
      pathAliases: [...observations].map(([from, to]) => ({ from, to })) }, proof);
  };
  try {
    const stat = lstatSync(reportPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_REPORT_BYTES) throw new Error("Test report is not a bounded regular file");
    raw = readBoundedFile(reportPath, MAX_REPORT_BYTES);
    if (raw.length > MAX_REPORT_BYTES) throw new Error("Test report exceeded the size budget");
    if (format === "pytest-junit" || format === "java-junit") return retain(parseJunit(format, raw, cwd, requested, reportPath, suiteFiles, reportBase, replay, observe));
    const data = object(parseBoundedJson(raw.toString("utf8"), reportPath));
    if (!Array.isArray(data.testResults)) throw new Error("Machine report lacks testResults");
    const files = new Map<string, FileResult>();
    for (const value of data.testResults) {
      const suite = object(value);
      const file = relativeFile(cwd, suite.name ?? suite.testFilePath, reportBase, replay, observe);
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
    return retain(summarize(format, requested, files, raw, reportPath));
  } catch (error) {
    if (error instanceof ReportArchiveError) throw error;
    return retain({ ...unknownTestExecution(format, requested, `No usable fresh machine report: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error && "code" in error && error.code === "ENOENT" ? "missing" : "invalid"), reportPath });
  }
}

function javaRuntimeObservation(suite: JunitXmlElement, raw: Buffer, scope: string[]): JavaTestRuntimeObservation {
  const keys = { "java.version": ["javaVersion", 120], "java.home": ["javaHome", 4096], "java.vendor": ["vendor", 256],
    "file.encoding": ["fileEncoding", 64], "native.encoding": ["nativeEncoding", 64] } as const;
  const values = new Map<string, Set<string>>();
  let invalid = false, conflicting = false;
  for (const block of suite.children.filter(child => child.name === "properties")) {
    for (const property of block.children) {
      assertInputActive();
      const name = property.attributes.name;
      if (property.name !== "property" || !name || !Object.hasOwn(keys, name)) continue;
      if (property.children.length || property.attributes.value === undefined) { invalid = true; continue; }
      const entries = values.get(name) ?? new Set<string>();
      entries.add(property.attributes.value); values.set(name, entries);
    }
  }
  const facts = { javaVersion: null, javaHome: null, vendor: null, fileEncoding: null, nativeEncoding: null } as Pick<JavaTestRuntimeObservation, "javaVersion" | "javaHome" | "vendor" | "fileEncoding" | "nativeEncoding">;
  for (const [key, [field, max]] of Object.entries(keys)) {
    const entries = values.get(key);
    if (entries && entries.size !== 1) { conflicting = true; continue; }
    const value = entries && [...entries][0]?.trim();
    if (value && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)) facts[field] = value;
    else if (entries) invalid = true;
  }
  const name = suite.attributes.name;
  const identity = name && name.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(name) ? name : null;
  const attributedScope = identity ? scope.filter(file => {
    const name = javaClassFromPath(file).fqcn;
    return identity === name || identity.startsWith(`${name}$`) || !name.includes(".") && (identity.endsWith(`.${name}`) || identity.includes(`.${name}$`));
  }) : [];
  const reason = conflicting ? "conflicting-properties" : invalid ? "invalid-properties" : !identity ? "missing-suite-identity" :
    !attributedScope.length ? "unattributed-scope" : Object.values(facts).some(value => value === null) ? "missing-properties" : undefined;
  return { role: "test", source: "junit-properties", status: reason ? "unknown" : "observed", suite: identity, scope: attributedScope,
    reportHash: createHash("sha256").update(raw).digest("hex"), ...facts, ...(reason ? { reason } : {}) };
}

/** Structural JUnit subset: only direct suite cases/properties supply execution facts. */
function parseJunit(format: "pytest-junit" | "java-junit", raw: Buffer, cwd: string, requested: string[], reportPath: string, suiteFiles?: string[], reportBase = cwd, replay?: ReportReplayPaths, observe?: ObservePath): TestExecution {
  const paths = replay ? replay.platform === "win32" ? path.win32 : path.posix : path;
  const root = parseJunitXml(raw);
  const suites: JunitXmlElement[] = [];
  const collect = (node: JunitXmlElement): void => {
    if (node.name === "testsuite") suites.push(node);
    else for (const child of node.children) {
      if (!["testsuite", "testsuites"].includes(child.name)) throw new Error("Unsupported JUnit suite container");
      collect(child);
    }
  };
  collect(root);
  if (!suites.length) throw new Error("JUnit document contains no test suite");
  if (format === "java-junit") {
    const names = suites.map(suite => suite.attributes.name).filter((name): name is string => !!name);
    if (new Set(names).size !== names.length) throw new Error("Duplicate JUnit suite identity");
  }
  const files = new Map<string, FileResult>();
  const javaRuntimeObservations: JavaTestRuntimeObservation[] = [];
  for (const suite of suites) {
    assertInputActive();
    const cases = suite.children.filter(child => child.name === "testcase");
    const declared = suite.attributes.tests;
    if (!/^\d+$/.test(declared ?? "") || !Number.isSafeInteger(Number(declared)) || Number(declared) !== cases.length) {
      throw new Error("JUnit suite counts do not match its test cases");
    }
    const suiteScope = new Set<string>(suiteFiles?.filter(file => requested.includes(file)));
    for (const entry of cases) {
      assertInputActive();
      const attrs = entry.attributes;
      // pytest's xunit1 file is the definition; classname identifies an inherited collected module.
      const collectedModules = format === "pytest-junit" && attrs.classname ? requested.filter((file) => {
        const module = paths.relative(reportBase, paths.resolve(cwd, file)).split(paths.sep).join(".").replace(/\.py$/, "");
        return attrs.classname === module || attrs.classname!.startsWith(`${module}.`);
      }).sort((a, b) => b.length - a.length) : [];
      const targets = suiteFiles ?? (collectedModules.length ? [collectedModules[0]!] : [relativeFile(cwd, attrs.file, reportBase, replay, observe)]);
      const skipped = entry.children.some(child => child.name === "skipped");
      const failed = entry.children.some(child => child.name === "failure" || child.name === "error");
      for (const file of targets) {
        if (!requested.includes(file)) continue;
        suiteScope.add(file);
        const facts = files.get(file) ?? { collected: 0, passed: 0, failed: 0, skipped: 0 };
        facts.collected++;
        if (failed) facts.failed++; else if (skipped) facts.skipped++; else facts.passed++;
        files.set(file, facts);
      }
    }
    if (format === "java-junit") javaRuntimeObservations.push(javaRuntimeObservation(suite, raw, [...suiteScope]));
  }
  return { ...summarize(format, requested, files, raw, reportPath), ...(format === "java-junit" ? { javaRuntimeObservations } : {}) };
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
