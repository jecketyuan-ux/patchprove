import { readFileSync } from "node:fs";
import path from "node:path";
import { isOpenGap } from "./accept.js";
import { resolveConfig } from "./config.js";
import { formatShortSummary } from "./report.js";
import { meetsFailOn } from "./risk.js";
import { analyze, writeEvidence } from "./run.js";
import type { CheckId, Evidence, FailOnLevel, Gap, RunOptions, SummaryRisk } from "./types.js";

export interface ProvePatchInput {
  cwd?: string;
  base?: string;
  head?: string;
  failOn?: FailOnLevel | "none";
  accept?: string[];
  config?: string;
  out?: string;
  ignore?: string[];
  disableGate?: CheckId[];
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
  reminder: string;
  summary: string;
}

export const PROVE_PATCH_DESCRIPTION =
  "Run the patchprove evidence pipeline (same as `patchprove run`): impact → checks → gaps → risk. Returns structured evidence plus a short human summary. Model-free; not a CI replacement.";

export const LIST_GAPS_DESCRIPTION =
  "Return open (non-accepted) gaps from a fresh patchprove run or from a provided evidence JSON path. Agents must not claim done while this list is non-empty.";

export function runOptionsFromInput(input: ProvePatchInput): RunOptions {
  const cwd = path.resolve(input.cwd ?? process.cwd());
  return {
    cwd,
    json: true,
    format: "json",
    out: input.out ?? path.join(cwd, "evidence.json"),
    failOn: input.failOn,
    base: input.base,
    head: input.head,
    accept: input.accept,
    config: input.config,
    ignore: input.ignore,
    disableGate: input.disableGate,
  };
}

export function readEvidenceFile(filePath: string): Evidence {
  const resolved = path.resolve(filePath);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read evidence JSON at ${resolved}: ${message}`);
  }
  if (!isEvidenceShape(raw)) {
    throw new Error(`Not a patchprove evidence JSON: ${resolved}`);
  }
  return raw;
}

function isEvidenceShape(value: unknown): value is Evidence {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return Array.isArray(rec.gaps) && rec.summary !== undefined && rec.impact !== undefined;
}

export async function provePatch(input: ProvePatchInput = {}): Promise<ProvePatchResult> {
  const options = runOptionsFromInput(input);
  const evidence = await analyze(options);
  if (input.out) {
    writeEvidence(input.out, evidence);
  }
  const config = resolveConfig(evidence.repo.root, options);
  const failOnMet = meetsFailOn(evidence.summary.risk, config.failOn);
  return {
    failOnMet,
    failOn: config.failOn,
    summary: formatShortSummary(evidence, { failOnMet, failOn: config.failOn }),
    evidence,
  };
}

export async function listGaps(input: ListGapsInput = {}): Promise<ListGapsResult> {
  let evidence: Evidence;
  let source: "run" | "file";
  if (input.evidencePath) {
    evidence = readEvidenceFile(input.evidencePath);
    source = "file";
  } else {
    const ran = await provePatch(input);
    evidence = ran.evidence;
    source = "run";
  }
  const gaps = evidence.gaps.filter(isOpenGap);
  const claimDone = gaps.length === 0;
  const reminder = claimDone
    ? "No open gaps."
    : "Do not claim done while open gaps remain.";
  return {
    source,
    risk: evidence.summary.risk,
    gapCount: gaps.length,
    acceptedGapCount: evidence.summary.acceptedGapCount ?? evidence.gaps.filter((g) => g.accepted).length,
    gaps,
    claimDone,
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
