import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
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
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Recursively sort object keys so JSON.stringify is stable. Arrays keep their order. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
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
  const receipt: EvidenceReceipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    algorithm: "sha256",
    contentHash,
    toolVersion: input.evidence.toolVersion || TOOL_VERSION,
    evidenceSchemaVersion: input.evidence.schemaVersion,
    argv: input.argv ?? [],
    options: optionsSummary(input.options),
    exitCode: input.exitCode,
    failOnOutcome: input.failOnOutcome,
    checks: checkDigests(input.evidence),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };

  if (input.sign) {
    const material = parseSigningKey(input.signingKey ?? process.env.PATCHPROVE_SIGNING_KEY);
    if (material) {
      receipt.signature = signContentHash(contentHash, material);
    }
  }

  return receipt;
}

export function writeReceipt(outPath: string, receipt: EvidenceReceipt): string {
  const resolved = path.resolve(outPath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return resolved;
}

export function readReceiptFile(filePath: string): EvidenceReceipt {
  const resolved = path.resolve(filePath);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read receipt JSON at ${resolved}: ${message}`);
  }
  if (!isReceiptShape(raw)) {
    throw new Error(`Not a patchprove receipt JSON: ${resolved}`);
  }
  return raw;
}

export function isReceiptShape(value: unknown): value is EvidenceReceipt {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.contentHash === "string" &&
    value.algorithm === "sha256" &&
    Array.isArray(value.checks) &&
    isPlainObject(value.failOnOutcome)
  );
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
): VerifyReceiptResult {
  const computedHash = hashEvidence(evidence);
  const hashMatches = computedHash === receipt.contentHash;
  let signature: VerifyReceiptResult["signature"] = "absent";
  if (receipt.signature) {
    signature = verifySignature(receipt.contentHash, receipt.signature, signingKey);
  }
  const ok = hashMatches && signature !== "mismatch";
  const parts = [
    hashMatches ? "hash matches" : `hash mismatch (receipt ${receipt.contentHash}, computed ${computedHash})`,
  ];
  if (signature === "verified") parts.push(`${receipt.signature?.alg} signature verified`);
  else if (signature === "mismatch") parts.push(`${receipt.signature?.alg} signature mismatch`);
  else if (signature === "skipped") parts.push(`${receipt.signature?.alg} signature not verified (no key)`);
  return {
    ok,
    contentHash: receipt.contentHash,
    computedHash,
    hashMatches,
    signature,
    signatureAlg: receipt.signature?.alg,
    message: parts.join("; "),
  };
}
