import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { writeArtifactSet, verifyArtifactSet, type ArtifactEntry } from "./artifacts.js";
import { accountInput, parseBoundedJson, readBoundedFile } from "./input-budget.js";
import { decodeCommandOutput } from "./exec.js";
import { cargoTestExecution, goTestExecution, readTestReport, unknownTestExecution } from "./test-results.js";
import { validateEvidence } from "./validation.js";
import { executionRecordCopies, reportReferences } from "./report-references.js";
import type { Evidence, ReportArtifactReference, TestExecution } from "./types.js";

interface ArchiveSession { destination: string; directory?: string; entries: ArtifactEntry[]; count: number }
const sessions = new AsyncLocalStorage<ArchiveSession>();
const hash = (content: string | Buffer) => `sha256:${createHash("sha256").update(content).digest("hex")}`;
export class ReportArchiveError extends Error { override name = "ReportArchiveError"; }

export interface MachineReportContext {
  format: TestExecution["format"];
  raw: Buffer;
  cwd: string;
  requestedScope: string[];
  suiteFiles?: string[];
  reportBase?: string;
  packagePath?: string;
  truncated?: boolean;
  sourceFiles?: string[];
  goListOutput?: string;
  /** Original bounded go-list stdout; serialized as canonical base64 and digest. */
  goListRaw?: Buffer;
  goListExitCode?: number;
  goListTruncated?: boolean;
  platform?: "win32" | "posix";
  pathAliases?: Array<{ from: string; to: string }>;
}

function facts(proof: TestExecution): unknown {
  const { reports: _reports, reportPath: _path, reportRetention: _retention, reportHash: _hash, reason: _reason, sourceFiles: _files, ...result } = proof;
  return result;
}

function directory(session: ArchiveSession): string {
  session.directory ??= path.join(session.destination, `run-${randomUUID()}`);
  return session.directory;
}

/** Capture bytes while the runner's unique temporary report still exists. */
export function archiveMachineReport(context: MachineReportContext, proof: TestExecution): TestExecution {
  const originalPath = proof.reportPath;
  if (originalPath && proof.reason) proof.reason = proof.reason.replaceAll(originalPath, "<test-report>");
  delete proof.reportPath;
  const session = sessions.getStore();
  if (!session) { proof.reportRetention = "not-retained"; return proof; }
  try {
    const root = directory(session);
    const number = ++session.count;
    const reportPath = path.join(root, `${number}.raw`);
    const contextPath = path.join(root, `${number}.context.json`);
    accountInput(reportPath, context.raw.length);
    const { raw, goListRaw, ...metadata } = context;
    if (goListRaw !== undefined && (!Buffer.isBuffer(goListRaw) || context.format !== "go-json" || decodeCommandOutput(goListRaw) !== context.goListOutput)) {
      throw new ReportArchiveError("Original go list bytes do not match the participating decoded output");
    }
    const aliasInputs = [context.cwd, context.reportBase ?? context.cwd,
      ...[...(context.sourceFiles ?? []), ...context.requestedScope, ...(context.suiteFiles ?? [])].map(file => path.resolve(context.cwd, file))];
    const aliases = new Map<string, string>();
    for (const file of aliasInputs) { try { aliases.set(path.resolve(file), realpathSync.native(file)); } catch { /* Missing or coarse scope has no alias. */ } }
    metadata.platform = process.platform === "win32" ? "win32" : "posix";
    metadata.pathAliases = [...aliases].map(([from, to]) => ({ from, to }));
    const contextBytes = Buffer.from(JSON.stringify({ schemaVersion: "1.0.0", ...metadata,
      ...(goListRaw !== undefined ? { goListRawBase64: goListRaw.toString("base64"), goListRawHash: hash(goListRaw) } : {}),
      expected: facts(proof) }, null, 2) + "\n");
    accountInput(contextPath, contextBytes.length);
    const reference: ReportArtifactReference = { path: reportPath, hash: hash(raw), bytes: raw.length, format: context.format,
      contextPath, contextHash: hash(contextBytes) };
    session.entries.push({ path: reportPath, content: Buffer.from(raw) }, { path: contextPath, content: contextBytes });
    proof.reportRetention = "retained";
    proof.reports = [...(proof.reports ?? []), reference];
    return proof;
  } catch (error) { throw new ReportArchiveError(`Cannot archive machine report: ${error instanceof Error ? error.message : String(error)}`); }
}

/** Use the same archive session from native-runner acceptance harnesses. */
export async function withMachineReportArchive<T>(destination: string | undefined, action: () => Promise<T>): Promise<{
  result: T; archive?: { manifestPath: string; manifestHash: string };
}> {
  if (!destination) return { result: await action() };
  const session: ArchiveSession = { destination: path.resolve(destination), entries: [], count: 0 };
  try {
    const result = await sessions.run(session, action);
    const manifestPath = path.join(directory(session), "manifest.json");
    session.entries.push({ path: path.join(directory(session), "index.json"),
      content: JSON.stringify({ schemaVersion: "1.0.0", kind: "patchprove-machine-report-archive", reportCount: session.count }) + "\n" });
    mkdirSync(session.destination, { recursive: true, mode: 0o700 });
    mkdirSync(directory(session), { mode: 0o700 });
    chmodSync(directory(session), 0o700);
    writeArtifactSet(session.entries, manifestPath);
    return { result, archive: { manifestPath, manifestHash: hash(readBoundedFile(manifestPath)) } };
  } catch (error) {
    if (session.directory) rmSync(session.directory, { recursive: true, force: true });
    throw new ReportArchiveError(`Report archive was not published: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Publish a private per-run set only after analysis has completed successfully. */
export async function withReportArchive(destination: string | undefined, action: () => Promise<Evidence>, finalize?: (evidence: Evidence) => void): Promise<Evidence> {
  const { result: evidence, archive } = await withMachineReportArchive(destination, action);
  if (archive) evidence.reportArchive = archive;
  if (evidence.environment) evidence.environment.reportRetention = destination ? "requested" : "not-requested";
  try {
    finalize?.(evidence);
    return validateEvidence(evidence, "completed analysis");
  }
  catch (error) {
    if (archive) rmSync(path.dirname(archive.manifestPath), { recursive: true, force: true });
    throw error;
  }
}

type ReplayContext = Omit<MachineReportContext, "raw" | "goListRaw"> & {
  schemaVersion: "1.0.0"; expected: unknown; goListRawBase64?: string; goListRawHash?: string;
};
function replayContext(value: unknown, format: TestExecution["format"]): ReplayContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReportArchiveError("Machine-report context must be an object");
  const input = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "format", "cwd", "requestedScope", "suiteFiles", "reportBase", "packagePath", "truncated", "sourceFiles", "goListOutput", "goListRawBase64", "goListRawHash", "goListExitCode", "goListTruncated", "platform", "pathAliases", "expected"]);
  const strings = (items: unknown): items is string[] => Array.isArray(items) && items.every(item => typeof item === "string");
  if (Object.keys(input).some(key => !allowed.has(key)) || input.schemaVersion !== "1.0.0" || input.format !== format ||
    typeof input.cwd !== "string" || !input.cwd || !strings(input.requestedScope) || !Object.hasOwn(input, "expected")) {
    throw new ReportArchiveError("Unsupported machine-report replay context");
  }
  for (const key of ["suiteFiles", "sourceFiles"] as const) if (input[key] !== undefined && !strings(input[key])) throw new ReportArchiveError(`Invalid report context ${key}`);
  for (const key of ["reportBase", "packagePath", "goListOutput"] as const) if (input[key] !== undefined && typeof input[key] !== "string") throw new ReportArchiveError(`Invalid report context ${key}`);
  for (const key of ["truncated", "goListTruncated"] as const) if (input[key] !== undefined && typeof input[key] !== "boolean") throw new ReportArchiveError(`Invalid report context ${key}`);
  if (input.goListExitCode !== undefined && !Number.isSafeInteger(input.goListExitCode)) throw new ReportArchiveError("Invalid go list exit code");
  if (Object.hasOwn(input, "goListRawBase64") || Object.hasOwn(input, "goListRawHash")) {
    if (format !== "go-json" || typeof input.goListRawBase64 !== "string" || typeof input.goListRawHash !== "string") throw new ReportArchiveError("Incomplete go list original-byte metadata");
    const original = Buffer.from(input.goListRawBase64, "base64");
    if (original.toString("base64") !== input.goListRawBase64) throw new ReportArchiveError("Invalid canonical base64 for go list original bytes");
    if (hash(original) !== input.goListRawHash) throw new ReportArchiveError("Go list original-byte hash mismatch");
    if (decodeCommandOutput(original) !== input.goListOutput) throw new ReportArchiveError("Go list original bytes conflict with the participating decoded output");
  }
  if (input.platform !== "win32" && input.platform !== "posix") throw new ReportArchiveError("Missing report source platform");
  if (!Array.isArray(input.pathAliases) || input.pathAliases.some(alias => !alias || typeof alias !== "object" || Array.isArray(alias) ||
    typeof alias.from !== "string" || typeof alias.to !== "string" || Object.keys(alias).some(key => key !== "from" && key !== "to"))) throw new ReportArchiveError("Invalid report path aliases");
  return input as unknown as ReplayContext;
}

/** Persist portable references before hashing/signing, leaving originals intact. */
export function relativizeReportArtifacts(evidence: Evidence, artifactRoot: string): Evidence {
  if (!evidence.reportArchive) return evidence;
  const result = structuredClone(evidence);
  const relative = (file: string) => path.relative(artifactRoot, path.resolve(artifactRoot, file)).split(path.sep).join("/");
  result.reportArchive!.manifestPath = relative(result.reportArchive!.manifestPath);
  for (const record of [...(result.executionRecords ?? []), ...result.checks.flatMap(check => check.records ?? [])]) {
    for (const report of record.testExecution?.reports ?? []) {
      // Structured clones preserve shared references, so normalize only once.
      if (path.isAbsolute(report.path)) report.path = relative(report.path);
      if (path.isAbsolute(report.contextPath)) report.contextPath = relative(report.contextPath);
    }
  }
  return result;
}

/** Verify report bytes and the containing manifest before binding a final pack. */
export function reportArtifactEntries(evidence: Evidence, artifactRoot = process.cwd()): ArtifactEntry[] {
  const archive = evidence.reportArchive;
  if (!archive) {
    if (reportReferences(evidence, artifactRoot).length) throw new ReportArchiveError("Retained reports have no archive manifest");
    return [];
  }
  const manifestPath = path.resolve(artifactRoot, archive.manifestPath);
  const manifestBytes = readBoundedFile(manifestPath);
  if (hash(manifestBytes) !== archive.manifestHash) throw new ReportArchiveError("Report archive manifest hash mismatch");
  const verified = verifyArtifactSet(manifestPath);
  if (!verified.ok) throw new ReportArchiveError(`Report archive verification failed: ${verified.errors.join("; ")}`);
  const manifest = parseBoundedJson(manifestBytes.toString("utf8"), manifestPath) as { artifacts: Array<{ path: string; hash: string }> };
  const archiveDirectory = path.dirname(manifestPath);
  const members = new Map(manifest.artifacts.map(item => {
    const file = path.resolve(archiveDirectory, item.path);
    const relative = path.relative(archiveDirectory, file);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new ReportArchiveError("Report archive member is outside its private directory");
    return [file, item.hash] as const;
  }));
  const reports = reportReferences(evidence, artifactRoot);
  const indexPath = path.join(archiveDirectory, "index.json");
  if (!members.has(indexPath)) throw new ReportArchiveError("Report archive index is missing");
  const index = parseBoundedJson(readBoundedFile(indexPath).toString("utf8"), indexPath) as Record<string, unknown>;
  if (!index || typeof index !== "object" || Array.isArray(index) || index.schemaVersion !== "1.0.0" ||
    index.kind !== "patchprove-machine-report-archive" || !Number.isSafeInteger(index.reportCount) || index.reportCount !== reports.length) {
    throw new ReportArchiveError("Report archive index disagrees with referenced execution originals");
  }
  const expectedMembers = new Set([indexPath, ...reports.flatMap(report => [path.resolve(artifactRoot, report.path), path.resolve(artifactRoot, report.contextPath)])]);
  if (members.size !== expectedMembers.size || [...members.keys()].some(file => !expectedMembers.has(file))) {
    throw new ReportArchiveError("Report archive contains unreferenced execution originals");
  }
  const entries: ArtifactEntry[] = [];
  for (const report of reports) {
    for (const [file, expected, bytes] of [[report.path, report.hash, report.bytes], [report.contextPath, report.contextHash, undefined]] as const) {
      if (members.get(path.resolve(artifactRoot, file)) !== expected) throw new ReportArchiveError("Report reference is not bound by its archive manifest");
      const raw = readBoundedFile(path.resolve(artifactRoot, file));
      if (hash(raw) !== expected || bytes !== undefined && raw.length !== bytes) throw new ReportArchiveError("Report artifact hash or byte count mismatch");
    }
  }
  for (const [file, expected] of members) {
    const raw = readBoundedFile(file);
    if (hash(raw) !== expected) throw new ReportArchiveError("Report artifact changed during verification");
    entries.push({ path: file, content: raw });
  }
  entries.push({ path: manifestPath, content: manifestBytes });
  return entries;
}

/** Re-run the same parser against retained originals without executing project code. */
export function verifyReportArchive(evidence: Evidence, options: { artifactRoot?: string } = {}): { ok: boolean; reports: number; errors: string[] } {
  try {
    if (!evidence.reportArchive) throw new ReportArchiveError("Evidence has no retained machine-report archive");
    const artifactRoot = options.artifactRoot ?? process.cwd();
    reportArtifactEntries(evidence, artifactRoot);
    const reports = reportReferences(evidence, artifactRoot);
    const replayed = new Map<string, TestExecution>();
    for (const report of reports) {
      const context = replayContext(parseBoundedJson(readBoundedFile(path.resolve(artifactRoot, report.contextPath)).toString("utf8"), report.contextPath), report.format);
      const rawBytes = readBoundedFile(path.resolve(artifactRoot, report.path));
      const raw = context.format === "cargo-harness" || context.format === "go-json" ? decodeCommandOutput(rawBytes) : rawBytes.toString("utf8");
      let proof: TestExecution;
      if (context.format === "cargo-harness") proof = cargoTestExecution(raw, context.requestedScope, context.truncated);
      else if (context.format === "go-json") {
        try {
          const pkg = JSON.parse(context.goListOutput ?? "{}") as { ImportPath?: string; Dir?: string; TestGoFiles?: string[]; XTestGoFiles?: string[] };
          const sourcePaths = context.platform === "win32" ? path.win32 : path.posix;
          const eligible = [...(pkg.TestGoFiles ?? []), ...(pkg.XTestGoFiles ?? [])].map(file => sourcePaths.relative(context.cwd, sourcePaths.join(pkg.Dir ?? context.cwd, file)).split(sourcePaths.sep).join("/"));
          proof = context.goListExitCode === 0 && !context.goListTruncated && typeof pkg.ImportPath === "string"
            ? goTestExecution(raw, context.requestedScope, pkg.ImportPath, context.truncated)
            : unknownTestExecution("go-json", context.requestedScope, "go list could not establish package identity");
          proof.eligibleSourceFiles = eligible.filter(file => context.sourceFiles?.includes(file));
          if (context.sourceFiles?.some(file => !eligible.includes(file))) proof.unknownScope = context.requestedScope;
        } catch { proof = unknownTestExecution("go-json", context.requestedScope, "No usable go list package metadata"); }
        proof.granularity = "package";
      } else if (["vitest-json", "jest-json", "pytest-junit", "java-junit"].includes(context.format)) {
        proof = readTestReport(context.format as "vitest-json" | "jest-json" | "pytest-junit" | "java-junit", path.resolve(artifactRoot, report.path),
          context.cwd, context.requestedScope, context.suiteFiles, context.reportBase, false, { platform: context.platform ?? "posix", aliases: context.pathAliases ?? [] });
      } else throw new ReportArchiveError("No supported replay parser for the retained format");
      if (!isDeepStrictEqual(facts(proof), context.expected)) throw new ReportArchiveError("Replayed machine-report facts differ from the archived context");
      replayed.set(report.path, proof);
    }
    for (const record of executionRecordCopies(evidence)) {
      const proof = record.testExecution;
      if (!proof?.reports?.length) continue;
      const originals = proof.reports.map(report => replayed.get(path.resolve(artifactRoot, report.path))!);
      let derived = originals[0]!;
      if (proof.format === "java-junit") {
        const sum = (field: keyof TestExecution["counts"]) => originals.reduce((total, item) => total + item.counts[field], 0);
        const observed = (field: "collectedScope" | "executedScope" | "skippedScope") => proof.requestedScope.filter(file => originals.some(item => item[field].includes(file)));
        derived = { parserVersion: "1", format: "java-junit", granularity: "file", requestedScope: proof.requestedScope,
          reportStatus: originals.every(item => item.reportStatus === "validated") ? "validated" : "partial",
          collectedScope: observed("collectedScope"), executedScope: observed("executedScope"), skippedScope: observed("skippedScope"),
          unknownScope: proof.requestedScope.filter(file => !observed("collectedScope").includes(file)),
          counts: { collected: sum("collected"), executed: sum("executed"), passed: sum("passed"), failed: sum("failed"), skipped: sum("skipped") } };
      } else if (originals.length !== 1) throw new ReportArchiveError("Unexpected multiple originals for this report format");
      if (!isDeepStrictEqual(facts(derived), facts(proof))) throw new ReportArchiveError("Evidence execution facts differ from replayed originals");
    }
    return { ok: true, reports: reports.length, errors: [] };
  } catch (error) { return { ok: false, reports: 0, errors: [error instanceof Error ? error.message : String(error)] }; }
}
