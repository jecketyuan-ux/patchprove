import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isOpenGap } from "./accept.js";
import type { ContractClauseResult, Evidence, Finding, Gap, RiskLevel, SummaryRisk } from "./types.js";

type SarifLevel = "error" | "warning" | "note";

function sarifLevel(risk: RiskLevel | SummaryRisk): SarifLevel {
  if (risk === "critical" || risk === "high") return "error";
  if (risk === "medium") return "warning";
  return "note";
}

function uri(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  return filePath.replaceAll("\\", "/").replace(/^\.?\//, "");
}

interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  kind?: string;
  message: { text: string };
  locations?: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region?: { startLine: number };
    };
  }>;
  suppressions?: Array<{
    kind: string;
    status: string;
    justification?: string;
  }>;
  properties?: Record<string, unknown>;
}

function location(filePath?: string, line?: number): SarifResult["locations"] {
  const file = uri(filePath);
  if (!file) return undefined;
  return [
    {
      physicalLocation: {
        artifactLocation: { uri: file },
        ...(line && line > 0 ? { region: { startLine: line } } : {}),
      },
    },
  ];
}

function gapResult(gap: Gap): SarifResult {
  const firstFile = gap.files?.[0];
  const accepted = !isOpenGap(gap);
  const result: SarifResult = {
    ruleId: gap.kind,
    level: accepted ? "note" : sarifLevel(gap.risk),
    kind: accepted ? "review" : "fail",
    message: { text: gap.message },
    locations: location(firstFile),
    properties: {
      gapId: gap.id,
      risk: gap.risk,
      accepted,
      ...(gap.acceptedReason ? { acceptedReason: gap.acceptedReason } : {}),
    },
  };
  if (accepted) {
    result.suppressions = [
      {
        kind: "external",
        status: "accepted",
        justification: gap.acceptedReason || "accepted",
      },
    ];
  }
  return result;
}

function findingResult(finding: Finding): SarifResult {
  return {
    ruleId: finding.kind,
    level: sarifLevel(finding.risk),
    kind: "fail",
    message: { text: finding.message },
    locations: location(finding.path, finding.line),
    properties: {
      findingId: finding.id,
      risk: finding.risk,
    },
  };
}

function failedContractResult(clause: ContractClauseResult): SarifResult {
  return {
    ruleId: clause.kind,
    level: "error",
    kind: "fail",
    message: { text: clause.message },
    locations: location(clause.files?.[0]),
    properties: {
      clauseId: clause.id,
      contractKind: clause.kind,
      passed: false,
    },
  };
}

export function toSarif(evidence: Evidence): Record<string, unknown> {
  const rules = [
    { id: "unmapped-test", name: "Unmapped test", shortDescription: { text: "Changed source has no mapped test" } },
    { id: "no-tests-mapped", name: "No tests mapped", shortDescription: { text: "Affected-test gate had no mapped tests" } },
    { id: "tool-missing", name: "Tool missing", shortDescription: { text: "A configured gate could not run" } },
    { id: "unsupported-language", name: "Unsupported language", shortDescription: { text: "Changed sources are outside JS/TS/Python mapping" } },
    { id: "high-risk-path", name: "High-risk path", shortDescription: { text: "Diff touches a high-risk path" } },
    { id: "lockfile", name: "Lockfile change", shortDescription: { text: "Lockfile changed" } },
    { id: "workflow", name: "Workflow change", shortDescription: { text: "CI workflow changed" } },
    { id: "auth-crypto", name: "Auth/crypto path", shortDescription: { text: "Auth or crypto-related path changed" } },
    { id: "secret", name: "Potential secret", shortDescription: { text: "Potential secret in added lines" } },
    { id: "check-failed", name: "Check failed", shortDescription: { text: "A patchprove gate failed" } },
    { id: "required-gate", name: "Contract: required gate", shortDescription: { text: "A required contract gate did not pass" } },
    { id: "max-residual-risk", name: "Contract: max residual risk", shortDescription: { text: "Summary risk exceeds the contract maximum" } },
    { id: "required-mapped-tests", name: "Contract: required mapped tests", shortDescription: { text: "A required path has no mapped test" } },
    { id: "forbidden-unproven", name: "Contract: forbidden unproven", shortDescription: { text: "A forbidden path shipped unmapped" } },
    { id: "accepted-residual-risk", name: "Contract: accepted residual risk", shortDescription: { text: "Residual risk violates the contract policy" } },
  ];

  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "patchprove",
            version: evidence.toolVersion,
            informationUri: "https://github.com/jecketyuan-ux/patchprove",
            rules,
          },
        },
        results: [
          ...evidence.gaps.map(gapResult),
          ...evidence.findings.map(findingResult),
          ...(evidence.contract?.clauses ?? [])
            .filter((clause) => !clause.passed)
            .map(failedContractResult),
        ],
      },
    ],
  };
}

export function writeSarif(outPath: string, evidence: Evidence): string {
  const resolved = path.resolve(outPath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(toSarif(evidence), null, 2)}\n`, "utf8");
  return resolved;
}
