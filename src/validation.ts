import { readFileSync } from "node:fs";
import { Ajv, type AnySchema, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import { maxRisk } from "./risk.js";
import { emptyContractResult } from "./types.js";
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
  unique(evidence.checks, source, "/checks");
  unique(evidence.gaps, source, "/gaps");
  unique(evidence.findings, source, "/findings");
  if (evidence.executionRecords) unique(evidence.executionRecords, source, "/executionRecords");
  if (evidence.verificationPlan) unique(evidence.verificationPlan, source, "/verificationPlan");
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
  return evidence;
}

export function validateReceipt(value: unknown, source = "receipt"): EvidenceReceipt {
  version(value, source);
  assertSchema(value, "receipt", source);
  const receipt = value as EvidenceReceipt;
  unique(receipt.checks, source, "/checks");
  return receipt;
}
