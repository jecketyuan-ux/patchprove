import path from "node:path";
import { readJsonInput, withInputBudget } from "./input-budget.js";
import { isOpenGap } from "./accept.js";
import { evaluateVerification } from "./decision.js";
import { validateEvidence } from "./validation.js";
import { formatShortSummary } from "./report.js";
import { analyze, analyzeAndWrite, shouldFailRun } from "./run.js";
import type { Evidence, FailOnLevel, Gap, RunOptions, SummaryRisk } from "./types.js";

export interface ProvePatchInput extends Partial<Omit<RunOptions, "cwd" | "json" | "format" | "out">> {
  cwd?: string;
  out?: string;
}

export interface ProvePatchResult {
  failOnMet: boolean;
  failOn?: FailOnLevel;
  summary: string;
  evidence: Evidence;
}

export interface ListGapsInput extends ProvePatchInput {
  /** Read gaps from an existing evidence JSON instead of running the pipeline. */
  evidencePath?: string;
}

export interface ListGapsResult {
  source: "run" | "file";
  risk: SummaryRisk;
  gapCount: number;
  acceptedGapCount: number;
  gaps: Gap[];
  claimDone: boolean;
  verification: NonNullable<Evidence["verification"]>;
  reminder: string;
  summary: string;
}

export const PROVE_PATCH_DESCRIPTION =
  "Run the patchprove evidence pipeline (same as `patchprove run`): impact → checks → gaps → risk. Returns structured evidence plus a short human summary. Model-free; not a CI replacement.";

export const LIST_GAPS_DESCRIPTION =
  "Return open (non-accepted) gaps from a fresh patchprove run or from a provided evidence JSON path. Completion requires verification.status passed, including successful checks, contracts, policy, and provenance.";

export function runOptionsFromInput(input: ProvePatchInput): RunOptions {
  const cwd = path.resolve(input.cwd ?? process.cwd());
  return {
    ...input,
    cwd,
    json: true,
    format: "json",
    out: input.out ?? path.join(cwd, "evidence.json"),
  };
}

export function readEvidenceFile(filePath: string): Evidence {
  const resolved = path.resolve(filePath);
  let raw: unknown;
  try {
    raw = readJsonInput(resolved);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read evidence JSON at ${resolved}: ${message}`);
  }
  return validateEvidence(raw, resolved);
}

export async function provePatch(input: ProvePatchInput = {}): Promise<ProvePatchResult> {
  const options = runOptionsFromInput(input);
  const writesRequested = input.sign === true || input.out !== undefined || input.sarif !== undefined || input.receipt === true || typeof input.receipt === "string";
  const evidence = writesRequested ? (await analyzeAndWrite(options)).evidence : await analyze(options);
  evidence.verification = evaluateVerification(evidence);
  const failOn = evidence.effectivePolicy?.failOn ?? undefined;
  const failOnMet = shouldFailRun(evidence);
  return {
    failOnMet,
    failOn,
    summary: formatShortSummary(evidence, { failOnMet, failOn }),
    evidence,
  };
}

export async function listGaps(input: ListGapsInput = {}): Promise<ListGapsResult> {
  let evidence: Evidence;
  let source: "run" | "file";
  if (input.evidencePath) {
    evidence = withInputBudget({ limits: input.inputLimits }, () => readEvidenceFile(input.evidencePath!));
    source = "file";
  } else {
    const ran = await provePatch(input);
    evidence = ran.evidence;
    source = "run";
  }
  const gaps = evidence.gaps.filter(isOpenGap);
  const verification = evaluateVerification(evidence);
  evidence.verification = verification;
  const claimDone = verification.status === "passed";
  const reminder = claimDone
    ? "Verification passed."
    : `Do not claim done: verification ${verification.status}. ${verification.reasons.map((reason) => reason.message).join("; ")}`;
  return {
    source,
    risk: evidence.summary.risk,
    gapCount: gaps.length,
    acceptedGapCount: evidence.summary.acceptedGapCount ?? evidence.gaps.filter((g) => g.accepted).length,
    gaps,
    claimDone,
    verification,
    reminder,
    summary: formatShortSummary(evidence),
  };
}

export function provePatchToMcpContent(result: ProvePatchResult): string {
  return JSON.stringify(
    {
      summary: result.summary,
      failOnMet: result.failOnMet,
      failOn: result.failOn ?? null,
      evidence: result.evidence,
    },
    null,
    2,
  );
}

export function listGapsToMcpContent(result: ListGapsResult): string {
  return JSON.stringify(result, null, 2);
}
