import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readJsonInput } from "./input-budget.js";
import { writeJsonAtomic } from "./artifacts.js";
import { evaluateVerification, hasUnprovenTestSuccess } from "./decision.js";
import { validateEvidence, validateReceipt } from "./validation.js";
import type {
  CheckDigest,
  Evidence,
  EvidenceReceipt,
  EvidenceReceiptRef,
  ReceiptOptionsSummary,
  ReceiptSignature,
  RunOptions,
} from "./types.js";
import { RECEIPT_SCHEMA_VERSION, TOOL_VERSION } from "./types.js";

const HASH_PREFIX = "sha256:";

export type SigningMaterial =
  | { alg: "hmac-sha256"; secret: Buffer }
  | { alg: "ed25519"; privateKey: ReturnType<typeof createPrivateKey> };

export interface BuildReceiptInput {
  evidence: Evidence;
  argv?: string[];
  options?: Pick<
    RunOptions,
    "failOn" | "failOnNewGaps" | "base" | "head" | "out" | "sarif" | "spec" | "baseline" | "format" | "sign"
  >;
  exitCode: number;
  failOnOutcome: EvidenceReceipt["failOnOutcome"];
  sign?: boolean;
  signingKey?: string | null;
  generatedAt?: string;
}

export interface VerifyReceiptResult {
  ok: boolean;
  contentHash: string;
  computedHash: string;
  hashMatches: boolean;
  signature: "verified" | "mismatch" | "skipped" | "absent";
  signatureAlg?: ReceiptSignature["alg"];
  message: string;
  payloadMatches?: boolean;
  trust?: "trusted" | "untrusted" | "unconfigured";
  legacy?: boolean;
}

export interface ReceiptVerificationPolicy {
  requireSignature?: boolean;
  trustedKeyFingerprints?: string[];
  allowLegacy?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Recursively sort object keys so JSON.stringify is stable. Arrays keep their order. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined) continue;
    out[key] = sortKeys(item);
  }
  return out;
}

/**
 * Stable evidence subset for hashing.
 * Drops wall-clock fields (`generatedAt`, `checks[].durationMs`, `checks[].detail`)
 * and the post-hash `receipt` pointer.
 */
export function canonicalEvidence(evidence: Evidence): unknown {
  const { generatedAt: _generatedAt, receipt: _receipt, ...rest } = evidence;
  if (evidence.schemaVersion.startsWith("2.")) {
    const locations = evidence.executionRecords?.map((record) => record.cwd).filter(Boolean) ?? [];
    const reports = evidence.executionRecords?.flatMap((record) => record.testExecution?.reportPath ? [record.testExecution.reportPath] : []) ?? [];
    const portable = (value: string): string => locations.reduce((text, cwd) => text.replaceAll(cwd, "<snapshot>"), reports.reduce((text, report) => text.replaceAll(report, "<test-report>"), value));
    const stableRecord = (record: NonNullable<Evidence["executionRecords"]>[number]) => {
      const { durationMs: _duration, outputHash: _output, cwd: _cwd, ...stable } = record;
      const facts = stable.testExecution ? { ...stable.testExecution } : undefined;
      if (facts) {
        delete facts.reportHash;
        if (facts.reportPath) facts.reportPath = "<test-report>";
        if (facts.reason) facts.reason = portable(facts.reason);
      }
      return { ...stable, command: stable.command ? portable(stable.command) : null, args: stable.args.map(portable),
        ...(stable.reason ? { reason: portable(stable.reason) } : {}),
        ...(facts ? { testExecution: facts } : {}) };
    };
    const { excludedPaths: _outputs, ...snapshot } = evidence.snapshot ?? {};
    return sortKeys({
      ...rest,
      snapshot,
      checks: rest.checks.map((check) => {
        const { durationMs: _duration, detail: _detail, records: _records, ...stable } = check;
        return { ...stable, command: stable.command ? portable(stable.command) : stable.command };
      }),
      executionRecords: rest.executionRecords?.map(stableRecord),
    });
  }
  return sortKeys({
    ...rest,
    checks: rest.checks.map((check) => {
      const { durationMs: _durationMs, detail: _detail, ...stable } = check;
      return stable;
    }),
  });
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function hashCanonical(value: unknown): string {
  const digest = createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
  return `${HASH_PREFIX}${digest}`;
}

export function hashEvidence(evidence: Evidence): string {
  return hashCanonical(canonicalEvidence(evidence));
}

export function defaultReceiptPath(evidencePath: string): string {
  return evidencePath.toLowerCase().endsWith(".json")
    ? evidencePath.replace(/\.json$/i, ".receipt.json")
    : `${evidencePath}.receipt.json`;
}

export function checkDigests(evidence: Evidence): CheckDigest[] {
  return evidence.checks.map((check) => ({
    id: check.id,
    command: check.command ?? null,
    exitCode: check.exitCode ?? null,
    status: check.status,
  }));
}

export function optionsSummary(
  options: BuildReceiptInput["options"] | undefined,
): ReceiptOptionsSummary {
  return {
    failOn: options?.failOn ?? null,
    failOnNewGaps: options?.failOnNewGaps ?? null,
    base: options?.base ?? null,
    head: options?.head ?? null,
    out: options?.out ?? null,
    sarif: options?.sarif ?? null,
    spec: options?.spec ?? null,
    baseline: options?.baseline ?? null,
    format: options?.format ?? null,
    sign: Boolean(options?.sign),
  };
}

export function parseSigningKey(raw: string | undefined | null): SigningMaterial | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("hmac:")) {
    const secret = trimmed.slice("hmac:".length);
    if (!secret) return null;
    return { alg: "hmac-sha256", secret: Buffer.from(secret, "utf8") };
  }
  if (trimmed.startsWith("ed25519:")) {
    const body = trimmed.slice("ed25519:".length).trim();
    if (!body) return null;
    const der = Buffer.from(body, "base64");
    return {
      alg: "ed25519",
      privateKey: createPrivateKey({ key: der, format: "der", type: "pkcs8" }),
    };
  }
  if (trimmed.includes("BEGIN PRIVATE KEY") || trimmed.includes("BEGIN ED25519")) {
    return { alg: "ed25519", privateKey: createPrivateKey(trimmed) };
  }
  return { alg: "hmac-sha256", secret: Buffer.from(trimmed, "utf8") };
}

function signContentHash(contentHash: string, material: SigningMaterial): ReceiptSignature {
  if (material.alg === "hmac-sha256") {
    const value = createHmac("sha256", material.secret).update(contentHash, "utf8").digest("base64");
    return { alg: "hmac-sha256", value };
  }
  const value = sign(null, Buffer.from(contentHash, "utf8"), material.privateKey).toString("base64");
  const publicKey = createPublicKey(material.privateKey)
    .export({ type: "spki", format: "der" })
    .toString("base64");
  return { alg: "ed25519", value, publicKey };
}

function buffersEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifySignature(
  contentHash: string,
  signature: ReceiptSignature,
  signingKey?: string | null,
): "verified" | "mismatch" | "skipped" {
  if (signature.alg === "hmac-sha256") {
    const material = parseSigningKey(signingKey ?? process.env.PATCHPROVE_SIGNING_KEY);
    if (!material || material.alg !== "hmac-sha256") return "skipped";
    const expected = createHmac("sha256", material.secret).update(contentHash, "utf8").digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature.value, "base64");
    } catch {
      return "mismatch";
    }
    return buffersEqual(expected, actual) ? "verified" : "mismatch";
  }

  if (!signature.publicKey) return "skipped";
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(signature.publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    const ok = verify(
      null,
      Buffer.from(contentHash, "utf8"),
      publicKey,
      Buffer.from(signature.value, "base64"),
    );
    return ok ? "verified" : "mismatch";
  } catch {
    return "mismatch";
  }
}

export function buildReceipt(input: BuildReceiptInput): EvidenceReceipt {
  const contentHash = hashEvidence(input.evidence);
  const modern = input.evidence.schemaVersion.startsWith("2.");
  if (modern && (!input.evidence.snapshot || !input.evidence.effectivePolicy || !input.evidence.verification)) {
    throw new Error("Protocol 2 receipts require snapshot, effective policy, and verification evidence");
  }
  if (modern) {
    validateEvidence(input.evidence, "receipt evidence");
    const decision = evaluateVerification(input.evidence);
    if (canonicalize(decision) !== canonicalize(input.evidence.verification)) throw new Error("Receipt evidence decision does not match the verification policy and execution records");
    const failed = decision.status === "failed" || decision.strict && decision.status === "incomplete";
    if (input.exitCode !== (failed ? 1 : 0) || input.failOnOutcome.failed !== failed || (input.failOnOutcome.reason === "ok") === failed) {
      throw new Error("Receipt exit code and fail-on outcome do not match the verification decision");
    }
  }
  const receipt: EvidenceReceipt = {
    schemaVersion: modern ? RECEIPT_SCHEMA_VERSION : "1.2.0",
    algorithm: "sha256",
    contentHash,
    toolVersion: input.evidence.toolVersion || TOOL_VERSION,
    evidenceSchemaVersion: input.evidence.schemaVersion,
    argv: input.argv ?? [],
    options: { ...optionsSummary(input.options), sign: Boolean(input.sign) },
    exitCode: input.exitCode,
    failOnOutcome: input.failOnOutcome,
    checks: checkDigests(input.evidence),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };

  const policy = input.evidence.effectivePolicy;
  if (policy) {
    receipt.options.failOn = policy.failOn;
    receipt.options.failOnNewGaps = policy.failOnNewGaps;
    receipt.options.spec = policy.spec?.path ?? null;
    receipt.options.baseline = policy.baseline?.path ?? null;
  }
  if (modern) {
    const { receipt: _ref, ...fullEvidence } = input.evidence;
    receipt.canonicalizationVersion = "2";
    receipt.evidenceHash = hashCanonical(fullEvidence);
    receipt.executionHash = hashCanonical(input.evidence.executionRecords ?? []);
    receipt.snapshotHash = input.evidence.snapshot!.contentHash;
    receipt.policyHash = policy!.hash;
    receipt.verification = input.evidence.verification;
    receipt.effectivePolicy = policy;
    receipt.payloadHash = hashReceiptPayload(receipt);
  }

  if (input.sign) {
    const material = parseSigningKey(input.signingKey ?? process.env.PATCHPROVE_SIGNING_KEY);
    if (modern && !material) throw new Error("Signing was required but no signing key was provided");
    if (material) {
      receipt.signature = signContentHash(modern ? receipt.payloadHash! : contentHash, material);
    }
  }

  return modern ? validateReceipt(receipt, "generated receipt") : receipt;
}

export function writeReceipt(outPath: string, receipt: EvidenceReceipt): string {
  return writeJsonAtomic(outPath, receipt);
}

export function readReceiptFile(filePath: string): EvidenceReceipt {
  const resolved = path.resolve(filePath);
  let raw: unknown;
  try {
    raw = readJsonInput(resolved);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read receipt JSON at ${resolved}: ${message}`);
  }
  return validateReceipt(raw, resolved);
}

export function isReceiptShape(value: unknown): value is EvidenceReceipt {
  try { validateReceipt(value, "receipt"); return true; } catch { return false; }
}

export function readReceiptHash(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    const receipt = readReceiptFile(filePath);
    return receipt.contentHash;
  } catch {
    return null;
  }
}

export function findPreviousReceiptHash(baselinePath?: string | null): string | null {
  if (!baselinePath) return null;
  return readReceiptHash(defaultReceiptPath(baselinePath));
}

export function attachReceiptRef(
  evidence: Evidence,
  receipt: EvidenceReceipt,
  extras?: { path?: string; previousContentHash?: string | null },
): Evidence {
  const previous = extras?.previousContentHash ?? undefined;
  const ref: EvidenceReceiptRef = {
    algorithm: "sha256",
    contentHash: receipt.contentHash,
    ...(extras?.path ? { path: extras.path } : {}),
    ...(previous
      ? { previousContentHash: previous, unchanged: previous === receipt.contentHash }
      : {}),
  };
  return { ...evidence, receipt: ref };
}

export function verifyReceipt(
  evidence: Evidence,
  receipt: EvidenceReceipt,
  signingKey?: string | null,
  policy: ReceiptVerificationPolicy = {},
): VerifyReceiptResult {
  const computedHash = hashEvidence(evidence);
  const hashMatches = computedHash === receipt.contentHash;
  const modern = receipt.schemaVersion.startsWith("2.");
  const protocolMatches = modern === evidence.schemaVersion.startsWith("2.") &&
    (modern ? receipt.canonicalizationVersion === "2" : receipt.schemaVersion === "1.2.0") &&
    receipt.evidenceSchemaVersion === evidence.schemaVersion;
  const { receipt: _ref, ...fullEvidence } = evidence;
  const payloadMatches = !modern || (
    receipt.payloadHash === hashReceiptPayload(receipt) &&
    receipt.evidenceHash === hashCanonical(fullEvidence) &&
    receipt.executionHash === hashCanonical(evidence.executionRecords ?? []) &&
    receipt.snapshotHash === evidence.snapshot?.contentHash &&
    receipt.policyHash === evidence.effectivePolicy?.hash &&
    receipt.evidenceSchemaVersion === evidence.schemaVersion &&
    canonicalize(receipt.verification) === canonicalize(evidence.verification) &&
    canonicalize(receipt.effectivePolicy) === canonicalize(evidence.effectivePolicy)
  );
  let signature: VerifyReceiptResult["signature"] = "absent";
  if (receipt.signature) {
    signature = verifySignature(modern ? receipt.payloadHash ?? "" : receipt.contentHash, receipt.signature, signingKey);
  }
  const trustedKeys = policy.trustedKeyFingerprints ?? [];
  const fingerprint = receipt.signature?.publicKey ? publicKeyFingerprint(receipt.signature.publicKey) : null;
  const trust: NonNullable<VerifyReceiptResult["trust"]> = trustedKeys.length === 0 ? "unconfigured" : signature === "verified" && fingerprint && trustedKeys.includes(fingerprint) ? "trusted" : "untrusted";
  const signatureRequired = policy.requireSignature || trustedKeys.length > 0;
  const legacyScope = modern && hasUnprovenTestSuccess(evidence);
  const legacyAllowed = modern ? !legacyScope || policy.allowLegacy === true : policy.allowLegacy !== false;
  const ok = protocolMatches && hashMatches && payloadMatches && signature !== "mismatch" && (!signatureRequired || signature === "verified") && trust !== "untrusted" && legacyAllowed;
  const parts = [
    hashMatches ? "hash matches" : `hash mismatch (receipt ${receipt.contentHash}, computed ${computedHash})`,
  ];
  if (!protocolMatches) parts.push("evidence and receipt protocol versions do not match");
  if (modern) {
    parts.push(payloadMatches ? "authenticated payload matches" : "receipt payload mismatch");
    if (legacyScope) parts.push("legacy test scope has no observed result facts; completion remains unproven");
  } else {
    parts.push("legacy evidence-only receipt; metadata is not authenticated");
  }
  if (signature === "verified") parts.push(`${receipt.signature?.alg} signature verified`);
  else if (signature === "mismatch") parts.push(`${receipt.signature?.alg} signature mismatch`);
  else if (signature === "skipped") parts.push(`${receipt.signature?.alg} signature not verified (no key)`);
  if (signature === "absent") parts.push("unsigned");
  parts.push(`signer trust ${trust}`);
  if (!legacyAllowed) parts.push("legacy receipt rejected by policy");
  return {
    ok,
    contentHash: receipt.contentHash,
    computedHash,
    hashMatches,
    signature,
    signatureAlg: receipt.signature?.alg,
    message: parts.join("; "),
    payloadMatches,
    trust,
    legacy: !modern || legacyScope,
  };
}

/** The full v2 receipt envelope, excluding only its self-reference and signature. */
export function hashReceiptPayload(receipt: EvidenceReceipt): string {
  const { payloadHash: _payloadHash, signature: _signature, ...payload } = receipt;
  return hashCanonical(payload);
}

export function publicKeyFingerprint(publicKey: string): string {
  return `${HASH_PREFIX}${createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex")}`;
}
