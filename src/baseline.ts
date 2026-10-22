import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isOpenGap } from "./accept.js";
import { riskRank } from "./risk.js";
import { gapFingerprint, findingFingerprint } from "./fingerprint.js";
import { validateEvidence } from "./validation.js";
import { createHash } from "node:crypto";
import { writeJsonAtomic } from "./artifacts.js";
import type {
  BaselineComparison,
  BaselineItemRef,
  Evidence,
  FailOnLevel,
  Finding,
  Gap,
} from "./types.js";

export const DEFAULT_BASELINE_REL = ".patchprove/baseline.json";

function gapRef(gap: Gap): BaselineItemRef {
  return {
    id: gap.id,
    kind: gap.kind,
    message: gap.message,
    risk: gap.risk,
    ...(gap.files ? { files: gap.files } : {}),
    fingerprint: gap.fingerprint ?? gapFingerprint(gap),
  };
}

function findingRef(finding: Finding): BaselineItemRef {
  return {
    id: finding.id,
    kind: finding.kind,
    message: finding.message,
    risk: finding.risk,
    ...(finding.path ? { path: finding.path } : {}),
    fingerprint: finding.fingerprint ?? findingFingerprint(finding),
  };
}

function changed(a: BaselineItemRef, b: BaselineItemRef): boolean {
  return a.risk !== b.risk || a.path !== b.path ||
    JSON.stringify([...(a.files ?? [])].sort()) !== JSON.stringify([...(b.files ?? [])].sort());
}

function compareItems(current: BaselineItemRef[], baseline: BaselineItemRef[], aggregate = false) {
  const consumed = new Set<number>();
  const added: BaselineItemRef[] = [];
  const updated: BaselineItemRef[] = [];
  for (const item of current) {
    let index = baseline.findIndex((prior, i) => !consumed.has(i) && prior.kind === item.kind && prior.fingerprint === item.fingerprint);
    // A stable aggregate gap may change scope; ordinal finding IDs never pair.
    if (index === -1 && aggregate && item.kind !== "unmapped-test") {
      index = baseline.findIndex((prior, i) => !consumed.has(i) && prior.kind === item.kind && prior.id === item.id);
    }
    if (index === -1) added.push(item);
    else {
      consumed.add(index);
      if (changed(item, baseline[index]!)) updated.push(item);
    }
  }
  return { added, updated, resolved: baseline.filter((_, i) => !consumed.has(i)) };
}

function compatibility(current: Evidence, baseline: Evidence) {
  const reasons: string[] = [];
  if (current.repo.root !== baseline.repo.root) reasons.push("Repository roots differ");
  if (!current.snapshot) reasons.push("Current evidence lacks snapshot provenance");
  if (!baseline.snapshot) reasons.push("Baseline lacks snapshot provenance");
  else if (!baseline.snapshot.consistent) reasons.push("Baseline snapshot was inconsistent");
  else if (current.snapshot && (current.snapshot.algorithm !== baseline.snapshot.algorithm ||
    current.snapshot.version !== baseline.snapshot.version || current.snapshot.mode !== baseline.snapshot.mode)) {
    reasons.push("Snapshot algorithms, versions, or modes differ");
  }
  if (!current.effectivePolicy) reasons.push("Current evidence lacks effective policy provenance");
  if (!baseline.effectivePolicy) reasons.push("Baseline lacks effective policy provenance");
  else if (current.effectivePolicy && current.effectivePolicy.hash !== baseline.effectivePolicy.hash) reasons.push("Effective policies differ");
  return {
    compatible: reasons.length === 0,
    reasons,
    contentHash: `sha256:${createHash("sha256").update(JSON.stringify(baseline)).digest("hex")}`,
  };
}

export function findBaselinePath(
  root: string,
  options?: { explicit?: string; fromConfig?: string | null },
): string | null {
  if (options?.explicit) {
    const resolved = path.isAbsolute(options.explicit)
      ? options.explicit
      : path.resolve(root, options.explicit);
    if (!existsSync(resolved)) {
      throw new Error(`Baseline evidence not found: ${resolved}`);
    }
    return resolved;
  }
  if (options?.fromConfig) {
    const resolved = path.isAbsolute(options.fromConfig)
      ? options.fromConfig
      : path.resolve(root, options.fromConfig);
    if (existsSync(resolved)) return resolved;
    throw new Error(`Configured baseline evidence not found: ${resolved}`);
  }
  const fallback = path.join(root, DEFAULT_BASELINE_REL);
  return existsSync(fallback) ? fallback : null;
}

export function compareToBaseline(
  current: Evidence,
  baseline: Evidence,
  baselinePath: string,
  failOnNewGaps?: FailOnLevel,
): BaselineComparison {
  const gaps = compareItems(current.gaps.filter(isOpenGap).map(gapRef), baseline.gaps.filter(isOpenGap).map(gapRef), true);
  const findings = compareItems(current.findings.map(findingRef), baseline.findings.map(findingRef));

  return {
    baselinePath,
    newGaps: gaps.added,
    resolvedGaps: gaps.resolved,
    newFindings: findings.added,
    resolvedFindings: findings.resolved,
    changedGaps: gaps.updated,
    changedFindings: findings.updated,
    compatibility: compatibility(current, baseline),
    regression: gaps.added.length > 0 || gaps.updated.length > 0,
    ...(failOnNewGaps ? { failOnNewGaps } : {}),
  };
}

export function loadBaselineInput(filePath: string): { evidence: Evidence; identity: { path: string; hash: string } } {
  const resolved = path.resolve(filePath);
  let raw: unknown;
  let text: string;
  try {
    text = readFileSync(resolved, "utf8");
    raw = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read baseline evidence JSON at ${resolved}: ${message}`);
  }
  return {
    evidence: validateEvidence(raw, resolved),
    identity: { path: resolved, hash: `sha256:${createHash("sha256").update(JSON.stringify(text)).digest("hex")}` },
  };
}

export function loadBaselineEvidence(filePath: string): Evidence {
  return loadBaselineInput(filePath).evidence;
}

export function writeBaseline(filePath: string, evidence: Evidence): string {
  return writeJsonAtomic(filePath, evidence);
}

export function newGapsMeetFailOn(
  comparison: BaselineComparison | null,
  failOnNewGaps?: FailOnLevel,
): boolean {
  if (!comparison || !failOnNewGaps) return false;
  return comparison.newGaps.some((gap) => riskRank(gap.risk) >= riskRank(failOnNewGaps));
}
