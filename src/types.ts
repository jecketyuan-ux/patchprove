import type { InputLimits } from "./input-budget.js";

export const SCHEMA_VERSION = "2.1.0" as const;
export const TOOL_VERSION = "2.0.0";
export const RECEIPT_SCHEMA_VERSION = "2.0.0" as const;
export const COMPAT_SCHEMA_VERSION = "1.3.0" as const;

export interface SnapshotIdentity {
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

export interface ExecutionLimits {
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface ExecutionRecord {
  id: string;
  checkId: CheckId;
  scope: string[];
  status: CheckStatus | "cached" | "imported" | "timed-out" | "not-applicable";
  command: string | null;
  args: string[];
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  reason?: string;
  required?: boolean;
  toolVersion?: string;
  collectedTests?: number;
  testExecution?: TestExecution;
  signal?: string | null;
  truncated?: boolean;
  outputHash?: string;
  provenance?: { adapter: string; version: string; inputHash: string; snapshotHash?: string };
}

/** Observed machine-report facts. A requested path alone never proves execution. */
export interface TestExecution {
  parserVersion: "1";
  format: "vitest-json" | "jest-json" | "pytest-junit" | "java-junit" | "go-json" | "cargo-harness" | "unavailable";
  reportStatus: "validated" | "partial" | "missing" | "invalid" | "truncated";
  granularity: "file" | "package" | "crate";
  sourceFiles?: string[];
  eligibleSourceFiles?: string[];
  requestedScope: string[];
  collectedScope: string[];
  executedScope: string[];
  skippedScope: string[];
  unknownScope: string[];
  counts: { collected: number; executed: number; passed: number; failed: number; skipped: number };
  reportHash?: string;
  reportPath?: string;
  reportRetention?: "retained" | "not-retained";
  reports?: ReportArtifactReference[];
  reason?: string;
}

export interface ReportArtifactReference {
  path: string;
  hash: string;
  bytes: number;
  format: TestExecution["format"];
  contextPath: string;
  contextHash: string;
}

export interface PluginProvenance {
  id: string;
  source: "builtin" | "auto" | "environment" | "configuration";
  entry: string | null;
  entryHash: string | null;
  order: number;
  effective?: boolean;
  capabilities?: import("./plugins/types.js").PluginCapabilities;
  inputs: Array<{ path: string; hash: string }>;
  dependencyCoverage: "static" | "unknown";
  unknownDependencies: string[];
}

export interface VerificationPlanItem {
  id: string;
  unitId?: string;
  checkId: CheckId;
  scope: string[];
  required: boolean;
  reason: string;
  sourceFiles?: string[];
  granularity?: "file" | "package" | "crate" | "repository";
  policy?: ProjectGatePolicy & { project: string };
}

export interface ProjectGatePolicy {
  mode: "required" | "optional" | "not-applicable";
  reason?: string;
  expiresAt?: string;
}
export interface ProjectPolicy {
  path: string;
  gates: Partial<Record<CheckId, ProjectGatePolicy>>;
}

export interface VerificationDecision {
  status: "passed" | "failed" | "incomplete";
  strict: boolean;
  reasons: Array<{ code: string; message: string; checkId?: CheckId; scope?: string[] }>;
  legacy?: boolean;
}

export interface Diagnostic {
  code: string;
  message: string;
  severity: "warning" | "error";
  files?: string[];
}

export interface EffectivePolicy {
  protocol: 1 | 2;
  strict: boolean;
  failOn: FailOnLevel | null;
  failOnNewGaps: FailOnLevel | null;
  gates: PatchproveGates;
  ignorePaths: string[];
  acceptGaps: AcceptGapRule[];
  plugins: string[];
  /** Actual imported plugin identities, including shadowed modules that executed. */
  pluginSetHash?: string;
  config: { path: string; hash: string } | null;
  spec: { path: string; hash: string; inputs?: Array<{ path: string; hash: string }> } | null;
  baseline: { path: string; hash: string } | null;
  hash: string;
  projects?: ProjectPolicy[];
}

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type SummaryRisk = "none" | RiskLevel;
export type FailOnLevel = "high" | "critical";
export type MappingStrategy = "naming" | "coverage" | "graph";

export type FileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked";

export type Language =
  | "javascript"
  | "typescript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "other";

export type HighRiskKind = "lockfile" | "workflow" | "auth-crypto";

export type CheckId = "typecheck" | "lint" | "tests" | "secrets";
export type CheckStatus = "passed" | "failed" | "skipped";

export type GapKind =
  | "unmapped-test"
  | "no-tests-mapped"
  | "tool-missing"
  | "unsupported-language"
  | "contract"
  | "regression";

export type FindingKind =
  | "high-risk-path"
  | "lockfile"
  | "workflow"
  | "auth-crypto"
  | "secret"
  | "check-failed"
  | "regression";

export type ContractClauseKind =
  | "required-gate"
  | "max-residual-risk"
  | "required-mapped-tests"
  | "forbidden-unproven"
  | "accepted-residual-risk";

export type AcceptedResidualRiskPolicy = "none" | "listed-only" | "allow";

export interface ChangedFile {
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  highRisk: boolean;
  riskKind: HighRiskKind | null;
}

export interface MappedTest {
  source: string;
  tests: string[];
  via?: MappingStrategy;
  origins?: MappingStrategy[];
}

export interface CheckResult {
  id: CheckId;
  name: string;
  status: CheckStatus;
  reason?: string;
  command?: string | null;
  exitCode?: number | null;
  durationMs?: number;
  detail?: string;
  records?: ExecutionRecord[];
  timedOut?: boolean;
  truncated?: boolean;
}

export interface Gap {
  id: string;
  kind: GapKind;
  message: string;
  risk: RiskLevel;
  files?: string[];
  accepted?: boolean;
  acceptedReason?: string;
  fingerprint?: string;
  acceptedBy?: string[];
}

export interface Finding {
  id: string;
  kind: FindingKind;
  risk: RiskLevel;
  message: string;
  path?: string;
  line?: number;
  fingerprint?: string;
}

export interface ContractClauseResult {
  id: string;
  kind: ContractClauseKind;
  passed: boolean;
  message: string;
  files?: string[];
}

export interface ContractResult {
  loaded: boolean;
  passed: boolean;
  source: string | null;
  format: "yaml" | "markdown" | null;
  clauses: ContractClauseResult[];
}

export interface BaselineItemRef {
  id: string;
  kind: string;
  message: string;
  risk: RiskLevel;
  files?: string[];
  path?: string;
  fingerprint?: string;
}

export interface BaselineComparison {
  baselinePath: string;
  newGaps: BaselineItemRef[];
  resolvedGaps: BaselineItemRef[];
  newFindings: BaselineItemRef[];
  resolvedFindings: BaselineItemRef[];
  regression: boolean;
  failOnNewGaps?: FailOnLevel;
  changedGaps?: BaselineItemRef[];
  changedFindings?: BaselineItemRef[];
  compatibility?: { compatible: boolean; reasons: string[]; contentHash?: string };
}

export type ReceiptAlgorithm = "sha256";
export type ReceiptSignatureAlg = "ed25519" | "hmac-sha256";
export type FailOnOutcomeReason = "ok" | "fail-on" | "contract" | "new-gaps";

export interface CheckDigest {
  id: CheckId;
  command: string | null;
  exitCode: number | null;
  status: CheckStatus;
}

export interface ReceiptSignature {
  alg: ReceiptSignatureAlg;
  value: string;
  publicKey?: string;
}

export interface ReceiptOptionsSummary {
  failOn?: FailOnLevel | "none" | null;
  failOnNewGaps?: FailOnLevel | "none" | null;
  base?: string | null;
  head?: string | null;
  out?: string | null;
  sarif?: string | null;
  spec?: string | null;
  baseline?: string | null;
  format?: "human" | "json" | "markdown" | null;
  sign?: boolean;
}

export interface EvidenceReceipt {
  schemaVersion: "1.2.0" | typeof RECEIPT_SCHEMA_VERSION;
  algorithm: ReceiptAlgorithm;
  contentHash: string;
  toolVersion: string;
  evidenceSchemaVersion: string;
  argv: string[];
  options: ReceiptOptionsSummary;
  exitCode: number;
  failOnOutcome: {
    failed: boolean;
    reason: FailOnOutcomeReason;
  };
  checks: CheckDigest[];
  generatedAt: string;
  signature?: ReceiptSignature;
  canonicalizationVersion?: "2";
  payloadHash?: string;
  evidenceHash?: string;
  executionHash?: string;
  snapshotHash?: string;
  policyHash?: string;
  verification?: VerificationDecision;
  effectivePolicy?: EffectivePolicy;
}

/** Pointer written onto evidence after the content hash is computed (excluded from the hash). */
export interface EvidenceReceiptRef {
  algorithm: ReceiptAlgorithm;
  contentHash: string;
  path?: string;
  previousContentHash?: string;
  unchanged?: boolean;
}

export interface Evidence {
  schemaVersion: string;
  generatedAt: string;
  toolVersion: string;
  repo: {
    cwd: string;
    root: string;
    repositoryId?: string;
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
    languages: Language[];
    mappingStrategy: MappingStrategy;
    mappingFallbacks?: MappingStrategy[];
    mappingDiagnostics?: Diagnostic[];
    unmappedReasons?: Record<string, string>;
    mappingEvidence?: Array<{ source: string; test: string; via: MappingStrategy; precision: "heuristic" | "structural" | "historical"; origin?: string; freshness?: "current" | "unknown" | "stale"; inputHash?: string }>;
  };
  checks: CheckResult[];
  gaps: Gap[];
  findings: Finding[];
  summary: {
    risk: SummaryRisk;
    checksPassed: number;
    checksFailed: number;
    checksSkipped: number;
    gapCount: number;
    acceptedGapCount: number;
    findingCount: number;
  };
  contract: ContractResult;
  baselineComparison: BaselineComparison | null;
  receipt?: EvidenceReceiptRef;
  snapshot?: SnapshotIdentity;
  executionRecords?: ExecutionRecord[];
  verificationPlan?: VerificationPlanItem[];
  verification?: VerificationDecision;
  effectivePolicy?: EffectivePolicy;
  environment?: EnvironmentProvenance;
  reportArchive?: { manifestPath: string; manifestHash: string };
  resolutionProvenance?: import("./graph.js").ImportGraph["provenance"];
  projectScopes?: Array<{ path: string; applicable: boolean; reason: string }>;
  diagnostics?: Diagnostic[];
  mappingEvidence?: Array<{ source: string; test: string; via: MappingStrategy; precision: "heuristic" | "structural" | "historical"; origin?: string; freshness?: "current" | "unknown" | "stale"; inputHash?: string }>;
}

export interface EnvironmentProvenance {
  platform: string;
  arch: string;
  nodeVersion: string;
  gitVersion: string;
  tools: Array<{ name: string; version: string | null; path: string }>;
  dependencyLocks: Array<{ path: string; hash: string }>;
  configurations?: Array<{ path: string; hash: string }>;
  inputLimits: Required<InputLimits>;
  hermetic: false;
  javaToolOptionsFileEncoding?: "UTF-8" | "UTF8" | "UTF-16" | "US-ASCII" | "ISO-8859-1" | "windows-1252";
  plugins?: PluginProvenance[];
  reportRetention?: "requested" | "not-requested";
  parser?: { engine: "typescript"; version: string };
  javaRuntimes?: JavaRuntimeProvenance[];
}

export interface JavaRuntimeProvenance {
  runner: "maven" | "gradle";
  role?: "launcher" | "daemon" | "test";
  project?: string;
  runnerPath: string;
  javaVersion: string | null;
  javaHome: string | null;
  vendor: string | null;
  fileEncoding: string | null;
  nativeEncoding: string | null;
  source: "runner-version" | "runner-settings";
}

export interface DetectedTools {
  versions?: Record<string, string>;
  javaRuntimes?: JavaRuntimeProvenance[];
  typescript: boolean;
  tscBin: string | null;
  eslint: boolean;
  eslintBin: string | null;
  vitest: boolean;
  vitestBin: string | null;
  jest: boolean;
  jestBin: string | null;
  python: boolean;
  pyright: boolean;
  pyrightBin: string | null;
  mypy: boolean;
  mypyBin: string | null;
  ruff: boolean;
  ruffBin: string | null;
  pytest: boolean;
  pytestBin: string | null;
  gitleaks: boolean;
  gitleaksBin: string | null;
  go: boolean;
  goBin: string | null;
  cargo: boolean;
  cargoBin: string | null;
  maven: boolean;
  mavenBin: string | null;
  gradle: boolean;
  gradleBin: string | null;
}

export interface AcceptGapRule {
  id?: string;
  path?: string;
  reason?: string;
  ruleId?: string;
  owner?: string;
  expiresAt?: string;
  ticket?: string;
}

export interface PatchproveGates {
  typecheck: boolean;
  lint: boolean;
  tests: boolean;
  secrets: boolean;
}

export interface GlobClause {
  glob: string;
  reason?: string;
}

export interface PatchproveContract {
  schemaVersion: string;
  requiredGates: CheckId[];
  maxResidualRisk?: SummaryRisk;
  requiredMappedTests: GlobClause[];
  forbiddenUnproven: GlobClause[];
  acceptedResidualRisk: {
    policy: AcceptedResidualRiskPolicy;
  };
  sourcePath: string | null;
  format: "yaml" | "markdown";
  /** Every file read to establish the contract, including linked YAML. */
  inputPaths?: string[];
  inputIdentities?: Array<{ path: string; hash: string }>;
}

export interface ResolvedConfig {
  repositoryId?: string;
  strict?: boolean;
  protocol?: 1 | 2;
  diagnostics?: Diagnostic[];
  failOn: FailOnLevel | undefined;
  ignorePaths: string[];
  gates: PatchproveGates;
  acceptGaps: AcceptGapRule[];
  sourcePath: string | null;
  sourceHash?: string;
  baseline: string | null;
  failOnNewGaps: FailOnLevel | undefined;
  spec: string | null;
  /** Local JS plugin module paths (config `plugins:`). */
  plugins: string[];
  projects?: ProjectPolicy[];
}

export interface RunOptions {
  cwd: string;
  json: boolean;
  format: "human" | "json" | "markdown";
  out: string;
  /** Explicitly retain raw machine reports and their verification manifest. */
  reportsDir?: string;
  failOn?: FailOnLevel | "none";
  base?: string;
  head?: string;
  accept?: string[];
  ignore?: string[];
  disableGate?: CheckId[];
  sarif?: string;
  config?: string;
  baseline?: string;
  failOnNewGaps?: FailOnLevel | "none";
  spec?: string;
  /** `false` skips the receipt; a string is an explicit path; omit/`true` writes `<out>.receipt.json`. */
  receipt?: boolean | string;
  sign?: boolean;
  argv?: string[];
  protocol?: 1 | 2;
  strict?: boolean;
  isolate?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  inputLimits?: InputLimits;
  /** SDK cancellation; wire/CLI callers use their own transport/process cancellation. */
  signal?: AbortSignal;
  allowPlugins?: boolean;
  strictConfig?: boolean;
  adapterInputs?: Array<{ adapter: "nx" | "turbo" | "testmon"; path: string }>;
}

export function emptyContractResult(): ContractResult {
  return {
    loaded: false,
    passed: true,
    source: null,
    format: null,
    clauses: [],
  };
}

export function emptyDetectedTools(): DetectedTools {
  return {
    typescript: false,
    tscBin: null,
    eslint: false,
    eslintBin: null,
    vitest: false,
    vitestBin: null,
    jest: false,
    jestBin: null,
    python: false,
    pyright: false,
    pyrightBin: null,
    mypy: false,
    mypyBin: null,
    ruff: false,
    ruffBin: null,
    pytest: false,
    pytestBin: null,
    gitleaks: false,
    gitleaksBin: null,
    go: false,
    goBin: null,
    cargo: false,
    cargoBin: null,
    maven: false,
    mavenBin: null,
    gradle: false,
    gradleBin: null,
  };
}
