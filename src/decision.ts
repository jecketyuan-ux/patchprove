import { isOpenGap } from "./accept.js";
import { isDeepStrictEqual } from "node:util";
import { newGapsMeetFailOn } from "./baseline.js";
import { meetsFailOn } from "./risk.js";
import type { CheckId, Evidence, ExecutionRecord, ResolvedConfig, VerificationDecision } from "./types.js";

/** The common completion decision consumed by every entry point. */
export function evaluateVerification(
  evidence: Evidence,
  config?: ResolvedConfig,
  strict = config?.strict ?? evidence.effectivePolicy?.strict ?? true,
): VerificationDecision {
  return evaluate(evidence, config, strict, true);
}

/** Reader-only compatibility calculation; never use it for a new completion signal. */
export function evaluateHistoricalVerification(evidence: Evidence): VerificationDecision {
  return evaluate(evidence, undefined, evidence.effectivePolicy?.strict ?? true, false);
}

function successfulTestWithoutReport(record: ExecutionRecord): boolean {
  return record.checkId === "tests" && record.required !== false && ["passed", "cached", "imported"].includes(record.status) && !record.testExecution;
}

export function hasUnprovenTestSuccess(evidence: Evidence): boolean {
  const required = evidence.effectivePolicy?.gates.tests !== false ||
    evidence.contract.clauses.some((clause) => clause.kind === "required-gate" && clause.id === "required-gate-tests") ||
    evidence.verificationPlan?.some((item) => item.checkId === "tests" && item.required && item.policy?.mode === "required");
  return Boolean(required && (evidence.executionRecords ?? evidence.checks.flatMap((check) => check.records ?? [])).some((record) => successfulTestWithoutReport(record) &&
    (record.status === "passed" || evidence.verificationPlan?.some((item) => item.required && item.checkId === "tests" && (!item.unitId || item.unitId === record.id) &&
      (item.scope.length === 0 || item.scope.some((scope) => record.scope.includes(scope)))))));
}

function evaluate(evidence: Evidence, config: ResolvedConfig | undefined, strict: boolean, requireReports: boolean): VerificationDecision {
  const reasons: VerificationDecision["reasons"] = [];
  let failed = false;
  const add = (code: string, message: string, detail: { checkId?: CheckId; scope?: string[] } = {}) => {
    reasons.push({ code, message, ...detail });
  };
  const gates = config?.gates ?? evidence.effectivePolicy?.gates;
  const requiredGates = new Set<CheckId>(evidence.contract.clauses
    .filter((clause) => clause.kind === "required-gate")
    .map((clause) => clause.id.replace(/^required-gate-/, "") as CheckId));
  const projectRequired = new Set(evidence.verificationPlan?.filter((item) => item.required && item.policy?.mode === "required").map((item) => item.checkId));
  const disabled = (id: CheckId) => gates?.[id] === false && !requiredGates.has(id) && !projectRequired.has(id);

  for (const check of evidence.checks) {
    if (check.status === "failed" || check.timedOut) {
      failed = true;
      add(check.timedOut ? "check-timed-out" : "check-failed", `${check.name} ${check.timedOut ? "timed out" : "failed"}`, { checkId: check.id });
    }
  }
  const records = evidence.executionRecords ?? evidence.checks.flatMap((check) => check.records ?? []);
  const identities = new Map<string, ExecutionRecord>();
  for (const record of records) {
    if (requireReports && !disabled("tests") && record.status === "passed" && successfulTestWithoutReport(record)) {
      add("test-execution-unproven", `Execution ${record.id} has no observed test-result facts; requested argv cannot establish execution`, { checkId: "tests", scope: record.scope });
    }
    if (identities.has(record.id)) add("execution-identity-duplicate", `Execution identity ${record.id} is repeated`, { checkId: record.checkId });
    identities.set(record.id, record);
  }
  if (evidence.executionRecords) for (const check of evidence.checks) for (const record of check.records ?? []) {
    if (record.checkId !== check.id || !isDeepStrictEqual(identities.get(record.id), record)) add("execution-facts-conflict", `Execution ${record.id} has inconsistent copies`, { checkId: check.id });
  }
  for (const record of records) {
    if (record.status === "failed" || record.status === "timed-out" || (record.exitCode !== null && record.exitCode !== 0)) {
      failed = true;
      add("execution-failed", `Execution ${record.id} did not succeed`, { checkId: record.checkId, scope: record.scope });
    }
    if (record.checkId === "tests" && record.collectedTests === 0 && !disabled("tests")) {
      add("zero-tests-collected", `Execution ${record.id} collected no tests`, { checkId: record.checkId, scope: record.scope });
    }
    if (record.status === "passed" && record.exitCode !== 0) {
      add("execution-exit-unproven", `Execution ${record.id} has no successful exit code`, { checkId: record.checkId, scope: record.scope });
    }
    if (record.testExecution && !disabled("tests")) {
      const proof = record.testExecution;
      if (proof.unknownScope.length) add("test-scope-unknown", proof.reason ?? `Execution ${record.id} could not establish every selected scope`, { checkId: "tests", scope: proof.unknownScope });
      if (proof.counts.skipped > 0) add("tests-skipped", `Execution ${record.id} skipped ${proof.counts.skipped} selected tests`, { checkId: "tests", scope: proof.skippedScope });
    }
  }
  if (!evidence.contract.passed || evidence.contract.clauses.some((clause) => !clause.passed)) {
    failed = true;
    add("contract-failed", "The verification contract did not pass");
  }
  const failOn = config?.failOn ?? evidence.effectivePolicy?.failOn ?? undefined;
  if (meetsFailOn(evidence.summary.risk, failOn)) {
    failed = true;
    add("risk-threshold", `Residual risk ${evidence.summary.risk} meets failOn ${failOn}`);
  }
  const failOnNewGaps = config?.failOnNewGaps ?? evidence.effectivePolicy?.failOnNewGaps ?? evidence.baselineComparison?.failOnNewGaps;
  if (newGapsMeetFailOn(evidence.baselineComparison, failOnNewGaps)) {
    failed = true;
    add("new-gap-threshold", `New open gaps meet failOnNewGaps ${failOnNewGaps}`);
  }
  const legacy = !evidence.snapshot || !evidence.effectivePolicy || !evidence.verificationPlan || !evidence.executionRecords;
  if (legacy) add("legacy-provenance-missing", "Evidence lacks snapshot, policy, plan, or execution provenance");
  if (evidence.snapshot && !evidence.snapshot.consistent) {
    add("snapshot-mismatch", evidence.snapshot.reason ?? "The execution snapshot differs from the analyzed patch");
  }
  if (evidence.baselineComparison?.compatibility?.compatible === false) {
    add("baseline-incompatible", evidence.baselineComparison.compatibility.reasons.join("; "));
  }
  for (const diagnostic of evidence.diagnostics ?? []) {
    if (diagnostic.severity === "error") add(diagnostic.code, diagnostic.message, diagnostic.files ? { scope: diagnostic.files } : {});
  }
  for (const gate of requiredGates) {
    if (evidence.checks.find((check) => check.id === gate)?.status !== "passed") {
      failed = true;
      add("required-gate-failed", `Required gate ${gate} did not pass`, { checkId: gate });
    }
  }
  const completed = (record: ExecutionRecord): boolean => {
    if (record.checkId === "tests" && record.collectedTests === 0) return false;
    if (record.checkId === "tests" && requireReports && (!record.testExecution || record.testExecution.reportStatus !== "validated" || record.testExecution.counts.executed <= 0 ||
      record.scope.some((item) => !record.testExecution!.executedScope.includes(item) || record.testExecution!.unknownScope.includes(item)))) return false;
    if (record.status === "passed") return record.exitCode === 0;
    if (record.status !== "cached" && record.status !== "imported") return false;
    if (record.status === "imported" && record.exitCode !== 0) return false;
    return Boolean(record.provenance?.inputHash && record.provenance.snapshotHash === evidence.snapshot?.contentHash);
  };
  for (const item of evidence.verificationPlan ?? []) {
    if (!item.required || disabled(item.checkId)) continue;
    const candidates = records.filter((record) => record.checkId === item.checkId &&
      (!item.unitId || record.id === item.unitId) && completed(record));
    const scope = item.scope.filter((file) => !candidates.some((record) => record.scope.includes(file)));
    if (scope.length > 0 || (item.scope.length === 0 && candidates.length === 0)) {
      add("planned-scope-unverified", `Planned ${item.checkId} scope has no successful execution`, { checkId: item.checkId, scope });
    }
  }
  if (strict) {
    for (const gap of evidence.gaps.filter(isOpenGap)) {
      // Disabling a gate is an explicit policy choice, not a missing-tool error.
      const gate = (["typecheck", "lint", "tests", "secrets"] as CheckId[])
        .find((id) => gap.id === `gap-tool-${id}`);
      if (gate && disabled(gate)) continue;
      add("open-verification-gap", gap.message, { ...(gap.files ? { scope: gap.files } : {}) });
    }
  }
  return {
    status: failed ? "failed" : reasons.length > 0 ? "incomplete" : "passed",
    strict,
    reasons,
    ...(legacy ? { legacy: true } : {}),
  };
}
