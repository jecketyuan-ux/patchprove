/* This file is generated. Do not edit directly.
 * Source: schema/receipt.schema.json
 * Schema SHA-256: 29e3894ae3d2d3472cea497d8f28dfdd649922a7358be029e49eca69c6bd6583
 * Compiler: json-schema-to-typescript 16.0.0
 * Regenerate with: npm run generate:protocol
 */

/**
 * Hashable, optionally signable receipt for an evidence pack. The content hash covers a canonicalized evidence subset (no wall-clock fields).
 */
export type ReceiptWire = {
  schemaVersion: "1.2.0" | "2.0.0";
  algorithm: "sha256";
  contentHash: string;
  toolVersion: string;
  evidenceSchemaVersion: string;
  argv: string[];
  options: {
    failOn?: "none" | "high" | "critical" | null;
    failOnNewGaps?: "none" | "high" | "critical" | null;
    base?: string | null;
    head?: string | null;
    out?: string | null;
    sarif?: string | null;
    spec?: string | null;
    baseline?: string | null;
    format?: "human" | "markdown" | "json" | null;
    sign?: boolean;
  };
  exitCode: number;
  failOnOutcome: {
    failed: boolean;
    reason: "ok" | "fail-on" | "contract" | "new-gaps";
  };
  checks: {
    id: "typecheck" | "lint" | "tests" | "secrets";
    command: string | null;
    exitCode: number | null;
    status: "passed" | "failed" | "skipped";
  }[];
  generatedAt: string;
  signature?: {
    alg: "ed25519" | "hmac-sha256";
    value: string;
    /**
     * SPKI DER (base64) for ed25519, so verify does not need the private key.
     */
    publicKey?: string;
  };
  canonicalizationVersion?: "2";
  payloadHash?: string;
  evidenceHash?: string;
  executionHash?: string;
  snapshotHash?: string;
  policyHash?: string;
  verification?: Verification;
  effectivePolicy?: EffectivePolicy;
};
export type ProjectGatePolicy = {
  mode: "required" | "optional" | "not-applicable";
  reason?: string;
  expiresAt?: string;
};

export interface Verification {
  status: "passed" | "failed" | "incomplete";
  strict: boolean;
  reasons: {
    code: string;
    message: string;
    checkId?: "typecheck" | "lint" | "tests" | "secrets";
    scope?: string[];
  }[];
  legacy?: boolean;
}
export interface EffectivePolicy {
  protocol: 1 | 2;
  strict: boolean;
  failOn: "high" | "critical" | null;
  failOnNewGaps: "high" | "critical" | null;
  gates: {
    typecheck: boolean;
    lint: boolean;
    tests: boolean;
    secrets: boolean;
  };
  ignorePaths: string[];
  acceptGaps: {
    id?: string;
    path?: string;
    reason?: string;
    ruleId?: string;
    owner?: string;
    expiresAt?: string;
    ticket?: string;
  }[];
  plugins: string[];
  config: null | {
    path: string;
    hash: string;
  };
  spec: null | {
    path: string;
    hash: string;
    /**
     * @minItems 1
     */
    inputs?: {
      path: string;
      hash: string;
    }[];
  };
  baseline: null | {
    path: string;
    hash: string;
  };
  hash: string;
  projects?: {
    path: string;
    gates: {
      typecheck?: ProjectGatePolicy;
      lint?: ProjectGatePolicy;
      tests?: ProjectGatePolicy;
      secrets?: ProjectGatePolicy;
    };
  }[];
}

/** Required fields derived from the protocol-2 conditional in the JSON schema. */
export type ReceiptV2RequiredFields = "canonicalizationVersion" | "payloadHash" | "evidenceHash" | "executionHash" | "snapshotHash" | "policyHash" | "verification" | "effectivePolicy";

/** Protocol-2 wire shape; conditional required fields are enforced without compiler if/then support. */
export type ReceiptV2Wire = Omit<ReceiptWire, "schemaVersion" | "evidenceSchemaVersion"> &
  Required<Pick<ReceiptWire, ReceiptV2RequiredFields>> & {
    schemaVersion: "2.0.0";
    evidenceSchemaVersion: `2.${number}.${number}`;
  };
