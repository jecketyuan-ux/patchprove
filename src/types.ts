export const SCHEMA_VERSION = "0.2.0" as const;
export const TOOL_VERSION = "0.2.0";

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type SummaryRisk = "none" | RiskLevel;
export type FailOnLevel = "high" | "critical";
export type MappingStrategy = "naming" | "coverage";

export type FileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked";

export type Language = "javascript" | "typescript" | "python" | "other";

export type HighRiskKind = "lockfile" | "workflow" | "auth-crypto";

export type CheckId = "typecheck" | "lint" | "tests" | "secrets";
export type CheckStatus = "passed" | "failed" | "skipped";

export type GapKind =
  | "unmapped-test"
  | "no-tests-mapped"
  | "tool-missing"
  | "unsupported-language";

export type FindingKind =
  | "high-risk-path"
  | "lockfile"
  | "workflow"
  | "auth-crypto"
  | "secret"
  | "check-failed";

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

export interface ResolvedConfig {
  failOn: FailOnLevel | undefined;
  ignorePaths: string[];
  gates: PatchproveGates;
  acceptGaps: AcceptGapRule[];
  sourcePath: string | null;
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
}
