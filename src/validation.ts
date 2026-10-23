import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { Ajv, type AnySchema, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import { maxRisk } from "./risk.js";
import { evaluateHistoricalVerification, evaluateStoredVerification, evaluateVerification, hasUnprovenTestSuccess } from "./decision.js";
import { emptyContractResult } from "./types.js";
import { reportReferences } from "./report-references.js";
import type { Evidence, EvidenceReceipt } from "./types.js";

type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Producers reject unexpected fields. Readers retain additive fields from a
// known major while still validating every known field against that schema.
function consumerSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(consumerSchema);
  if (!record(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, key === "additionalProperties" && item === false ? true : consumerSchema(item)],
  ));
}

const validators = new Map<string, ValidateFunction>();

function validator(kind: "evidence" | "receipt"): ValidateFunction {
  const cached = validators.get(kind);
  if (cached) return cached;
  const schema = JSON.parse(readFileSync(new URL(`../schema/${kind}.schema.json`, import.meta.url), "utf8")) as unknown;
  const ajv = new Ajv({ allErrors: true, strict: false });
  const addFormats = addFormatsModule as unknown as FormatsPlugin;
  addFormats(ajv);
  const readable = consumerSchema(schema) as RecordValue;
  if (kind === "receipt") {
    // Producer schema pins the emitted version; readers accept additive 2.x
    // envelopes only when the known canonicalization and required fields hold.
    const properties = readable.properties as RecordValue;
    properties.schemaVersion = { type: "string", pattern: "^(?:1\\.2\\.0|2\\.\\d+\\.\\d+)$" };
  }
  const validate = ajv.compile(readable as AnySchema);
  validators.set(kind, validate);
  return validate;
}

function version(value: unknown, source: string): number {
  if (!record(value)) throw new Error(`${source}: / must be an object`);
  if (typeof value.schemaVersion !== "string" || !/^(1|2)\.\d+\.\d+$/.test(value.schemaVersion)) {
    throw new Error(`${source}: /schemaVersion unsupported evidence schema version ${String(value.schemaVersion)}`);
  }
  return Number(value.schemaVersion.split(".")[0]);
}

function assertSchema(value: unknown, kind: "evidence" | "receipt", source: string): void {
  const validate = validator(kind);
  if (!validate(value)) {
    const detail = validate.errors?.map((error) => {
      const suffix = error.keyword === "required" ? `/${String(error.params.missingProperty)}` : "";
      const pointer = `${error.instancePath}${suffix}` || "/";
      return `${pointer} ${error.message}`;
    }).join("; ");
    throw new Error(`${source}: invalid ${kind}: ${detail}`);
  }
}

function unique(values: Array<{ id: string }>, source: string, pointer: string): void {
  const ids = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (ids.has(value.id)) throw new Error(`${source}: ${pointer}/${index}/id duplicate identity "${value.id}"`);
    ids.add(value.id);
  }
}

/** Explicitly normalize optional fields absent in historical 1.0/1.1 packs. */
function normalizeHistorical(value: RecordValue): RecordValue {
  const minor = Number(String(value.schemaVersion).split(".")[1]);
  if (minor >= 2) return value;
  const normalized = { ...value };
  if (normalized.contract === undefined) normalized.contract = emptyContractResult();
  if (normalized.baselineComparison === undefined) normalized.baselineComparison = null;
  if (record(normalized.impact)) {
    normalized.impact = {
      ...normalized.impact,
      ...(normalized.impact.mappingStrategy === undefined ? { mappingStrategy: "naming" } : {}),
    };
  }
  if (record(normalized.summary) && normalized.summary.acceptedGapCount === undefined && Array.isArray(normalized.gaps)) {
    normalized.summary = {
      ...normalized.summary,
      acceptedGapCount: normalized.gaps.filter((gap) => record(gap) && gap.accepted === true).length,
    };
  }
  return normalized;
}

export function validateEvidence(value: unknown, source = "evidence"): Evidence {
  const major = version(value, source);
  const normalized = major === 1 ? normalizeHistorical(value as RecordValue) : value;
  assertSchema(normalized, "evidence", source);
  const evidence = normalized as Evidence;
  const modernProvenance = major === 2 && Number(evidence.schemaVersion.split(".")[1]) >= 1;
  if (modernProvenance && (!evidence.environment?.plugins || evidence.environment.reportRetention === undefined)) {
    throw new Error(`${source}: /environment requires actual plugin provenance and report retention for schema 2.1+`);
  }
  if (evidence.environment?.reportRetention === "requested" && !evidence.reportArchive) {
    throw new Error(`${source}: /reportArchive is required when report retention was requested`);
  }
  if (evidence.reportArchive && evidence.environment && evidence.environment.reportRetention !== "requested") {
    throw new Error(`${source}: /environment/reportRetention contradicts the report archive`);
  }
  const activePlugins = new Set<string>();
  const pluginOrders = new Set<number>();
  for (const [index, plugin] of (evidence.environment?.plugins ?? []).entries()) {
    const pointer = `/environment/plugins/${index}`;
    if (pluginOrders.has(plugin.order)) throw new Error(`${source}: ${pointer}/order duplicate plugin precedence`);
    pluginOrders.add(plugin.order);
    if (plugin.effective) {
      if (activePlugins.has(plugin.id)) throw new Error(`${source}: ${pointer}/id duplicate effective plugin`);
      activePlugins.add(plugin.id);
    }
    if (modernProvenance && (plugin.effective === undefined || !plugin.entry || !plugin.entryHash ||
      !plugin.inputs.some(input => input.path === plugin.entry && input.hash === plugin.entryHash))) {
      throw new Error(`${source}: ${pointer} lacks a bound loaded entry identity`);
    }
    if (plugin.dependencyCoverage === "static" && plugin.unknownDependencies.length) {
      throw new Error(`${source}: ${pointer}/dependencyCoverage contradicts unknown dependencies`);
    }
    if (new Set(plugin.inputs.map(input => input.path)).size !== plugin.inputs.length) throw new Error(`${source}: ${pointer}/inputs duplicate plugin input`);
  }
  unique(evidence.checks, source, "/checks");
  unique(evidence.gaps, source, "/gaps");
  unique(evidence.findings, source, "/findings");
  if (evidence.executionRecords) unique(evidence.executionRecords, source, "/executionRecords");
  if (evidence.verificationPlan) unique(evidence.verificationPlan, source, "/verificationPlan");
  const nestedIds = new Set<string>();
  const authoritativeRecords = new Map(evidence.executionRecords?.map((item) => [item.id, item]));
  try { reportReferences(evidence); }
  catch (error) { throw new Error(`${source}: /executionRecords reports ${error instanceof Error ? error.message : String(error)}`); }
  for (const [checkIndex, check] of evidence.checks.entries()) {
    for (const [recordIndex, execution] of (check.records ?? []).entries()) {
      const pointer = `/checks/${checkIndex}/records/${recordIndex}`;
      if (nestedIds.has(execution.id)) throw new Error(`${source}: ${pointer}/id duplicate identity "${execution.id}"`);
      nestedIds.add(execution.id);
      if (execution.checkId !== check.id) throw new Error(`${source}: ${pointer}/checkId does not match its check`);
      if (evidence.executionRecords) {
        const authoritative = authoritativeRecords.get(execution.id);
        if (!authoritative || !isDeepStrictEqual(authoritative, execution)) {
          throw new Error(`${source}: ${pointer} conflicts with /executionRecords for identity "${execution.id}"`);
        }
      }
      if (check.status === "passed" && (execution.status === "failed" || execution.status === "timed-out" || execution.status === "skipped" && execution.required !== false)) {
        throw new Error(`${source}: ${pointer}/status contradicts the passed check`);
      }
    }
  }
  for (const [index, execution] of (evidence.executionRecords ?? evidence.checks.flatMap((check) => check.records ?? [])).entries()) {
    if (execution.status === "passed" && execution.exitCode !== 0) {
      throw new Error(`${source}: /executionRecords/${index}/exitCode must be zero for a passed execution`);
    }
    const proof = execution.testExecution;
    if (proof) {
      const pointer = `/executionRecords/${index}/testExecution`;
      if (proof.reportRetention === "retained" && (!proof.reports?.length || !evidence.reportArchive)) {
        throw new Error(`${source}: ${pointer}/reports lacks its retained archive`);
      }
      if (proof.reports?.length && proof.reportRetention !== "retained" || proof.reportRetention === "not-retained" && proof.reportPath !== undefined) {
        throw new Error(`${source}: ${pointer}/reportRetention contradicts retained report references`);
      }
      if (proof.reports?.some(report => report.format !== proof.format) || new Set(proof.reports?.map(report => report.path)).size !== (proof.reports?.length ?? 0)) {
        throw new Error(`${source}: ${pointer}/reports contains a conflicting format or duplicate original`);
      }
      const counts = proof.counts;
      if (counts.executed !== counts.passed + counts.failed || counts.collected !== counts.executed + counts.skipped) throw new Error(`${source}: ${pointer}/counts contradicts the observed outcomes`);
      for (const field of ["requestedScope", "collectedScope", "executedScope", "skippedScope", "unknownScope"] as const) {
        if (new Set(proof[field]).size !== proof[field].length || field !== "requestedScope" && proof[field].some((item) => !proof.requestedScope.includes(item))) {
          throw new Error(`${source}: ${pointer}/${field} contains duplicate or unrequested scope`);
        }
      }
      if (execution.scope.some((item) => !proof.executedScope.includes(item) || proof.unknownScope.includes(item))) throw new Error(`${source}: ${pointer}/executedScope does not establish the execution's scope`);
      if (execution.status === "passed" && counts.executed === 0) throw new Error(`${source}: ${pointer}/counts/executed cannot establish a passed execution`);
      if (counts.failed > 0 && execution.status !== "failed" && execution.status !== "timed-out") throw new Error(`${source}: ${pointer}/counts/failed contradicts the execution status`);
    }
  }
  const counts = {
    checksPassed: evidence.checks.filter((check) => check.status === "passed").length,
    checksFailed: evidence.checks.filter((check) => check.status === "failed").length,
    checksSkipped: evidence.checks.filter((check) => check.status === "skipped").length,
    gapCount: evidence.gaps.filter((gap) => gap.accepted !== true).length,
    acceptedGapCount: evidence.gaps.filter((gap) => gap.accepted === true).length,
    findingCount: evidence.findings.length,
  };
  for (const [key, count] of Object.entries(counts)) {
    if (evidence.summary[key as keyof typeof counts] !== count) {
      throw new Error(`${source}: /summary/${key} does not match detail count ${count}`);
    }
  }
  const risk = maxRisk([...evidence.gaps.filter((gap) => gap.accepted !== true).map((gap) => gap.risk), ...evidence.findings.map((finding) => finding.risk)]);
  if (evidence.summary.risk !== risk) throw new Error(`${source}: /summary/risk does not match detail risk ${risk}`);
  if (major === 2) {
    const historicalScope = !evidence.environment && !evidence.resolutionProvenance && hasUnprovenTestSuccess(evidence);
    const decision = historicalScope ? evaluateHistoricalVerification(evidence)
      : modernProvenance ? evaluateVerification(evidence) : evaluateStoredVerification(evidence);
    if (evidence.verification!.status !== decision.status) throw new Error(`${source}: /verification/status contradicts policy, plan, or execution facts (${decision.status})`);
    if (evidence.verification!.strict !== decision.strict) throw new Error(`${source}: /verification/strict contradicts the effective policy`);
  }
  return evidence;
}

export function validateReceipt(value: unknown, source = "receipt"): EvidenceReceipt {
  version(value, source);
  assertSchema(value, "receipt", source);
  const receipt = value as EvidenceReceipt;
  unique(receipt.checks, source, "/checks");
  return receipt;
}
