import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isOpenGap } from "./accept.js";
import { riskRank } from "./risk.js";
import type {
  BaselineComparison,
  BaselineItemRef,
  Evidence,
  FailOnLevel,
  Finding,
  Gap,
} from "./types.js";

export const DEFAULT_BASELINE_REL = ".patchprove/baseline.json";

function gapRef(gap: Pick<Gap, "id" | "kind" | "message" | "risk" | "files">): BaselineItemRef {
  return {
    id: gap.id,
    kind: gap.kind,
    message: gap.message,
    risk: gap.risk,
    ...(gap.files ? { files: gap.files } : {}),
  };
}

function findingRef(finding: Finding): BaselineItemRef {
  return {
    id: finding.id,
    kind: finding.kind,
    message: finding.message,
    risk: finding.risk,
    ...(finding.path ? { path: finding.path } : {}),
  };
}

function keyOf(item: { id: string; kind: string; path?: string; files?: string[] }): string {
  if (item.id) return item.id;
  return `${item.kind}:${item.path ?? (item.files ?? []).join(",")}`;
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
  const currentGaps = current.gaps.filter(isOpenGap);
  const baselineGaps = baseline.gaps.filter(isOpenGap);
  const currentGapKeys = new Set(currentGaps.map(keyOf));
  const baselineGapKeys = new Set(baselineGaps.map(keyOf));

  const newGaps = currentGaps.filter((g) => !baselineGapKeys.has(keyOf(g))).map(gapRef);
  const resolvedGaps = baselineGaps.filter((g) => !currentGapKeys.has(keyOf(g))).map(gapRef);

  const currentFindingKeys = new Set(current.findings.map(keyOf));
  const baselineFindingKeys = new Set(baseline.findings.map(keyOf));
  const newFindings = current.findings.filter((f) => !baselineFindingKeys.has(keyOf(f))).map(findingRef);
  const resolvedFindings = baseline.findings.filter((f) => !currentFindingKeys.has(keyOf(f))).map(findingRef);

  return {
    baselinePath,
    newGaps,
    resolvedGaps,
    newFindings,
    resolvedFindings,
    regression: newGaps.length > 0,
    ...(failOnNewGaps ? { failOnNewGaps } : {}),
  };
}

export function loadBaselineEvidence(filePath: string): Evidence {
  const resolved = path.resolve(filePath);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read baseline evidence JSON at ${resolved}: ${message}`);
  }
  if (!raw || typeof raw !== "object") {
    throw new Error(`Not a patchprove evidence JSON: ${resolved}`);
  }
  const rec = raw as Record<string, unknown>;
  if (!Array.isArray(rec.gaps) || rec.summary === undefined || rec.impact === undefined) {
    throw new Error(`Not a patchprove evidence JSON: ${resolved}`);
  }
  return raw as Evidence;
}

export function writeBaseline(filePath: string, evidence: Evidence): string {
  const resolved = path.resolve(filePath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return resolved;
}

export function newGapsMeetFailOn(
  comparison: BaselineComparison | null,
  failOnNewGaps?: FailOnLevel,
): boolean {
  if (!comparison || !failOnNewGaps) return false;
  return comparison.newGaps.some((gap) => riskRank(gap.risk) >= riskRank(failOnNewGaps));
}
