export const SCHEMA_VERSION = "1.0.0" as const;
export const TOOL_VERSION = "1.0.0";

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
}

export interface Gap {
  id: string;
  kind: GapKind;
  message: string;
  risk: RiskLevel;
  files?: string[];
  accepted?: boolean;
  acceptedReason?: string;
}

export interface Finding {
  id: string;
  kind: FindingKind;
  risk: RiskLevel;
  message: string;
  path?: string;
  line?: number;
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
}

export interface BaselineComparison {
  baselinePath: string;
  newGaps: BaselineItemRef[];
  resolvedGaps: BaselineItemRef[];
  newFindings: BaselineItemRef[];
  resolvedFindings: BaselineItemRef[];
  regression: boolean;
  failOnNewGaps?: FailOnLevel;
}

export interface Evidence {
  schemaVersion: typeof SCHEMA_VERSION;
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
    languages: Language[];
    mappingStrategy: MappingStrategy;
    mappingFallbacks?: MappingStrategy[];
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
}

export interface DetectedTools {
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
}

export interface ResolvedConfig {
  failOn: FailOnLevel | undefined;
  ignorePaths: string[];
  gates: PatchproveGates;
  acceptGaps: AcceptGapRule[];
  sourcePath: string | null;
  baseline: string | null;
  failOnNewGaps: FailOnLevel | undefined;
  spec: string | null;
}

export interface RunOptions {
  cwd: string;
  json: boolean;
  format: "human" | "json" | "markdown";
  out: string;
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
