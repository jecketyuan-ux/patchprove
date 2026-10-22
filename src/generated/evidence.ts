/* This file is generated. Do not edit directly.
 * Source: schema/evidence.schema.json
 * Schema SHA-256: 642bfb95f23165b4bf1352e531f1a7f7a0cb72cd8c9993be3e4a8935d6b23b98
 * Compiler: json-schema-to-typescript 16.0.0
 * Regenerate with: npm run generate:protocol
 */

/**
 * Versioned evidence pack produced by patchprove run. Model-free: impact, checks, gaps, and risk.
 */
export type EvidenceWire = {
  /**
   * Evidence semver: protocol 2 emits 2.0.0; explicit protocol 1 compatibility emits 1.3.0. Readers accept known-major additive fields.
   */
  schemaVersion: string;
  generatedAt: string;
  toolVersion: string;
  repo: {
    cwd: string;
    root: string;
  };
  range: {
    mode: "working-tree" | "range";
    base: string | null;
    head: string | null;
  };
  impact: {
    changedFiles: ChangedFile[];
    mappedTests: MappedTest[];
    unmappedSources: string[];
    languages: ("javascript" | "typescript" | "python" | "go" | "rust" | "java" | "other")[];
    /**
     * Primary mapping strategy that produced mappings (coverage if a coverage map was loaded; else graph if import reverse-map produced hits; else naming).
     */
    mappingStrategy: "naming" | "coverage" | "graph";
    /**
     * Other strategies that also produced at least one source→test mapping on this run.
     */
    mappingFallbacks?: ("naming" | "coverage" | "graph")[];
    mappingEvidence?: MappingEvidence[];
    mappingDiagnostics?: Diagnostic[];
    unmappedReasons?: {
      [k: string]: string;
    };
  };
  checks: Check[];
  gaps: Gap[];
  findings: Finding[];
  summary: {
    risk: SummaryRisk;
    checksPassed: number;
    checksFailed: number;
    checksSkipped: number;
    /**
     * Open (non-accepted) gaps. Accepted gaps are counted separately and do not raise risk.
     */
    gapCount: number;
    acceptedGapCount: number;
    findingCount: number;
  };
  contract: Contract;
  baselineComparison: null | BaselineComparison;
  receipt?: ReceiptRef;
  snapshot?: Snapshot;
  effectivePolicy?: EffectivePolicy;
  verification?: Verification;
  executionRecords?: ExecutionRecord[];
  verificationPlan?: PlanItem[];
  diagnostics?: Diagnostic[];
  mappingEvidence?: MappingEvidence[];
};
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type SummaryRisk = "none" | "low" | "medium" | "high" | "critical";

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  additions: number;
  deletions: number;
  highRisk: boolean;
  riskKind?: "lockfile" | "workflow" | "auth-crypto" | null;
}
export interface MappedTest {
  source: string;
  tests: string[];
  /**
   * How this source was mapped. Present when a coverage map or naming heuristic produced the list.
   */
  via?: "naming" | "coverage" | "graph";
  origins?: ("naming" | "graph" | "coverage")[];
}
export interface MappingEvidence {
  source: string;
  test: string;
  via: "coverage" | "graph" | "naming";
  precision: "heuristic" | "structural" | "historical";
  origin?: string;
  freshness?: "current" | "unknown" | "stale";
  inputHash?: string;
}
export interface Diagnostic {
  code: string;
  message: string;
  severity: "warning" | "error";
  files?: string[];
}
export interface Check {
  id: "typecheck" | "lint" | "tests" | "secrets";
  name: string;
  status: "passed" | "failed" | "skipped";
  reason?: string;
  command?: string | null;
  exitCode?: number | null;
  durationMs?: number;
  detail?: string;
  records?: ExecutionRecord[];
  timedOut?: boolean;
  truncated?: boolean;
}
export interface ExecutionRecord {
  id: string;
  checkId: "typecheck" | "lint" | "tests" | "secrets";
  scope: string[];
  status: "passed" | "failed" | "skipped" | "cached" | "imported" | "timed-out" | "not-applicable";
  command: string | null;
  args: string[];
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  reason?: string;
  toolVersion?: string;
  collectedTests?: number;
  signal?: string | null;
  truncated?: boolean;
  outputHash?: string;
  provenance?: {
    adapter: string;
    version: string;
    inputHash: string;
    snapshotHash?: string;
  };
}
export interface Gap {
  id: string;
  kind:
    "unmapped-test" | "no-tests-mapped" | "tool-missing" | "unsupported-language" | "contract" | "regression";
  message: string;
  risk: RiskLevel;
  files?: string[];
  /**
   * True when this gap matches acceptGaps or --accept. Visible for audit; excluded from summary risk / fail-on.
   */
  accepted?: boolean;
  acceptedReason?: string;
  fingerprint?: string;
  acceptedBy?: string[];
}
export interface Finding {
  id: string;
  kind: "high-risk-path" | "lockfile" | "workflow" | "auth-crypto" | "secret" | "check-failed" | "regression";
  risk: RiskLevel;
  message: string;
  path?: string;
  line?: number;
  fingerprint?: string;
}
export interface Contract {
  loaded: boolean;
  passed: boolean;
  source: string | null;
  format: "yaml" | "markdown" | null;
  clauses: ContractClause[];
}
export interface ContractClause {
  id: string;
  kind:
    | "required-gate"
    | "max-residual-risk"
    | "required-mapped-tests"
    | "forbidden-unproven"
    | "accepted-residual-risk";
  passed: boolean;
  message: string;
  files?: string[];
}
export interface BaselineComparison {
  baselinePath: string;
  newGaps: BaselineItem[];
  resolvedGaps: BaselineItem[];
  newFindings: BaselineItem[];
  resolvedFindings: BaselineItem[];
  regression: boolean;
  failOnNewGaps?: "high" | "critical";
  changedGaps?: BaselineItem[];
  changedFindings?: BaselineItem[];
  compatibility?: {
    compatible: boolean;
    reasons: string[];
    contentHash?: string;
  };
}
export interface BaselineItem {
  id: string;
  kind: string;
  message: string;
  risk: RiskLevel;
  files?: string[];
  path?: string;
  fingerprint?: string;
}
/**
 * Optional pointer written after the content hash is computed. Excluded from the hash input.
 */
export interface ReceiptRef {
  algorithm: "sha256";
  /**
   * Canonical SHA-256 of the evidence (timestamps and receipt pointer excluded).
   */
  contentHash: string;
  path?: string;
  previousContentHash?: string;
  unchanged?: boolean;
}
export interface Snapshot {
  algorithm: "sha256";
  version: 1;
  mode: "working-tree" | "range";
  base: string | null;
  head: string | null;
  mergeBase: string | null;
  currentHead: string | null;
  tree: string | null;
  contentHash: string;
  patchHash: string;
  dirty: boolean;
  consistent: boolean;
  reason?: string;
  excludedPaths?: string[];
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
}
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
export interface PlanItem {
  id: string;
  checkId: "typecheck" | "lint" | "tests" | "secrets";
  scope: string[];
  required: boolean;
  reason: string;
  unitId?: string;
}

/** Required fields derived from the protocol-2 conditional in the JSON schema. */
export type EvidenceV2RequiredFields = "snapshot" | "executionRecords" | "verificationPlan" | "effectivePolicy" | "verification";

/** Protocol-2 wire shape; conditional required fields are enforced without compiler if/then support. */
export type EvidenceV2Wire = Omit<EvidenceWire, "schemaVersion"> &
  Required<Pick<EvidenceWire, EvidenceV2RequiredFields>> & {
    schemaVersion: `2.${number}.${number}`;
  };
