import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Evidence, ExecutionRecord, ReportArtifactReference } from "./types.js";

export function executionRecordCopies(evidence: Evidence): ExecutionRecord[] {
  return [...(evidence.executionRecords ?? []), ...evidence.checks.flatMap(check => check.records ?? [])];
}

/** A shared original may be referenced repeatedly, but its identity cannot vary. */
export function reportReferences(evidence: Evidence, artifactRoot = process.cwd()): ReportArtifactReference[] {
  const originals = new Map<string, ReportArtifactReference>();
  for (const report of executionRecordCopies(evidence).flatMap(record => record.testExecution?.reports ?? [])) {
    const reference: ReportArtifactReference = { path: path.resolve(artifactRoot, report.path), hash: report.hash,
      bytes: report.bytes, format: report.format, contextPath: path.resolve(artifactRoot, report.contextPath), contextHash: report.contextHash };
    const prior = originals.get(reference.path);
    if (prior && !isDeepStrictEqual(prior, reference)) throw new Error(`Conflicting retained report references for ${reference.path}`);
    originals.set(reference.path, reference);
  }
  return [...originals.values()];
}
